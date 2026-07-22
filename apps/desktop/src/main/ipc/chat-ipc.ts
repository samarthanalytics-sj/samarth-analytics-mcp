import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { ChatService } from '../services/chat-service';
import type { ChatMediaPart, ChatTurn, GoogleProduct } from '../../shared/ipc';
import type { WriteProposal } from '../tools/registry';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// Pending write-confirmations keyed by confirmId. A write tool registers a
// resolver here and waits; the renderer answers via 'llm:confirm:respond' with
// the (possibly user-edited) args, or null to decline.
const pendingConfirms = new Map<string, (result: Record<string, unknown> | null) => void>();
let confirmSeq = 0;

// In-flight streaming chats, keyed by requestId, so 'llm:chat:stop' can abort one.
const activeChats = new Map<string, AbortController>();

/** Coerce the renderer's product to one we actually serve. An unrecognised value must fall back to a
 *  REAL product rather than being trusted: this is an IPC boundary, and the product picks the tool set
 *  and the system prompt. GTM is the safe default (it is the app's home tab). */
const PRODUCTS: readonly GoogleProduct[] = ['gtm', 'ga4', 'ads'];
const asProduct = (v: unknown): GoogleProduct => (PRODUCTS.includes(v as GoogleProduct) ? (v as GoogleProduct) : 'gtm');

export function registerChatIpc(service: ChatService): void {
  // Attach a document to the chat: OS file picker -> plain-text extraction in the MAIN process
  // (the renderer never touches the filesystem). Returns null when the user cancels; extraction
  // failures throw with a plain-language reason (size cap, unsupported type, no readable text).
  ipcMain.handle('llm:pickAttachment', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      title: 'Attach a file to the chat',
      properties: ['openFile' as const],
      filters: [
        { name: 'Documents & images', extensions: ['pdf', 'docx', 'doc', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'log', 'html', 'xml', 'yml', 'yaml', 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths[0]) return null;
    const { extractAttachmentText } = await import('../services/attachments');
    return extractAttachmentText(filePaths[0]);
  });

  // Paste and drag-drop hand us BYTES, not a path. Rather than growing a second extraction path that
  // could drift from the picker's, the bytes are written to a temp file and run through the SAME
  // extractAttachmentText: one set of caps, one fallback wording, one behaviour however the file
  // arrived. The temp file is always removed, including on failure.
  ipcMain.handle('llm:attachBytes', async (_event, name: unknown, base64: unknown) => {
    const fileName = String(name ?? '').trim();
    const data = String(base64 ?? '');
    if (!fileName || !data) throw new Error('Nothing to attach.');
    // Keep only the basename: a crafted name must not steer the write outside the temp directory.
    const safe = basename(fileName).replace(/[\/:*?"<>|]/g, '_') || 'attachment';
    const tmp = join(tmpdir(), `samarth-attach-${randomUUID()}-${safe}`);
    try {
      await writeFile(tmp, Buffer.from(data, 'base64'));
      const { extractAttachmentText } = await import('../services/attachments');
      const out = await extractAttachmentText(tmp);
      // The temp path must never surface: report the name the user actually dropped or pasted.
      return { ...out, name: safe, ...(out.media ? { media: { ...out.media, name: safe } } : {}) };
    } finally {
      await unlink(tmp).catch(() => { /* best-effort cleanup */ });
    }
  });

  // Non-streaming, read-only (no confirm → write tools unavailable).
  ipcMain.handle(
    'llm:chat',
    (_event, history: ChatTurn[], message: string, product: GoogleProduct, media?: ChatMediaPart[]) => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Message cannot be empty.');
      }
      return service.chat(Array.isArray(history) ? history : [], message, asProduct(product), Array.isArray(media) ? media : undefined);
    }
  );

  // Streaming: pushes 'llm:chat:event' (text/tool/confirm, tagged by requestId).
  // Write tools pause on a 'confirm' event until the renderer responds.
  ipcMain.handle(
    'llm:chat:start',
    (event, requestId: string, history: ChatTurn[], message: string, product: GoogleProduct, media?: ChatMediaPart[]) => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Message cannot be empty.');
      }
      const scopedProduct: GoogleProduct = asProduct(product);
      const send = (payload: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send('llm:chat:event', payload);
      };
      const confirm = (proposal: WriteProposal): Promise<Record<string, unknown> | null> =>
        new Promise<Record<string, unknown> | null>((resolve) => {
          const confirmId = `${requestId}:${confirmSeq++}`;
          pendingConfirms.set(confirmId, resolve);
          send({
            requestId,
            type: 'confirm',
            confirmId,
            tool: proposal.tool,
            summary: proposal.summary,
            details: proposal.details,
            destructive: proposal.destructive,
            requireTextConfirm: proposal.requireTextConfirm,
          });
        });
      const controller = new AbortController();
      activeChats.set(requestId, controller);
      return service
        .chatStream(
          Array.isArray(history) ? history : [],
          message,
          scopedProduct,
          (ev) => send({ requestId, ...ev }),
          confirm,
          controller.signal,
          Array.isArray(media) ? media : undefined
        )
        .finally(() => activeChats.delete(requestId));
    }
  );

  // Stop a streaming chat: abort its provider request AND release any approval prompt
  // it's waiting on (resolve as declined) so the agentic loop unwinds cleanly.
  ipcMain.handle('llm:chat:stop', (_event, requestId: string) => {
    activeChats.get(requestId)?.abort();
    for (const [confirmId, resolve] of pendingConfirms) {
      if (confirmId.startsWith(`${requestId}:`)) {
        pendingConfirms.delete(confirmId);
        resolve(null);
      }
    }
  });

  // Renderer's answer to a write-confirmation prompt: the (possibly edited) args
  // to apply, or null to decline.
  ipcMain.handle(
    'llm:confirm:respond',
    (_event, confirmId: string, result: Record<string, unknown> | null) => {
      const resolve = pendingConfirms.get(confirmId);
      if (resolve) {
        pendingConfirms.delete(confirmId);
        resolve(result && typeof result === 'object' ? result : null);
      }
    }
  );

  // Save an assistant reply to a user-chosen file (the "Export report" bar under long/tabular replies):
  //   md   → the raw Markdown text
  //   csv  → the reply's GFM tables (title + header + rows per table)
  //   xlsx → the same tables as a native workbook, one worksheet per table
  //   pdf  → the reply as a styled document (shared markdown→HTML renderer + hidden-window printToPDF)
  // A save dialog picks the path; returns the path written or null if cancelled. Text goes through
  // writeReportFile (plain-dash boundary + locked-file "(n)" fallback), matching the audit exports.
  ipcMain.handle('llm:exportReply', async (e, format: unknown, defaultName: unknown, markdown: unknown): Promise<string | null> => {
    const fmt = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : format === 'xlsx' ? 'xlsx' : 'md';
    const md = String(markdown ?? '');
    if (!md.trim()) throw new Error('Nothing to export - the reply is empty.');
    const base = String(defaultName ?? 'Chat report')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(md|pdf|csv|xlsx)$/i, '')
      .trim() || 'Chat report';

    const win = BrowserWindow.fromWebContents(e.sender);
    const filterName = fmt === 'pdf' ? 'PDF' : fmt === 'csv' ? 'CSV' : fmt === 'xlsx' ? 'Excel workbook' : 'Markdown';
    const opts = { title: 'Save chat report', defaultPath: `${base}.${fmt}`, filters: [{ name: filterName, extensions: [fmt] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;

    if (fmt === 'md') {
      return writeReportFile(filePath, md);
    } else if (fmt === 'csv') {
      const { replyCsv } = await import('../../shared/chat-export');
      return writeReportFile(filePath, replyCsv(md));
    } else if (fmt === 'xlsx') {
      const { chatReplyXlsx } = await import('../services/chat-export-xlsx');
      return writeReportFile(filePath, await chatReplyXlsx(md));
    } else {
      const { reportHtmlDocument } = await import('../google/ga4-report-export');
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reportHtmlDocument(base, md)));
        const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
        return writeReportFile(filePath, pdf);
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
      }
    }
  });
}

// Same locked-file fallback as the audit exports: a prior download often sits open in a PDF/Excel
// viewer (EBUSY/EPERM/EACCES on overwrite), so retry with "name (1).ext", "name (2).ext", … Text
// exports get the plain-dash house style here; binary buffers pass through untouched.
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function writeReportFile(filePath: string, data: string | Uint8Array): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  const { dedupedReportPath } = await import('../google/ga4-report-export');
  const { plainDashes } = await import('../google/gtm-builders');
  for (let i = 0; i <= 50; i++) {
    const target = dedupedReportPath(filePath, i);
    try {
      await writeFile(target, typeof data === 'string' ? plainDashes(data) : data);
      return target;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!LOCK_CODES.has(code) || i === 50) throw err;
      // locked → try the next suffixed name
    }
  }
  throw new Error('unreachable');
}
