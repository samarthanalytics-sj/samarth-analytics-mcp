import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { ChatService } from '../services/chat-service';
import type { ChatTurn, GoogleProduct } from '../../shared/ipc';
import type { WriteProposal } from '../tools/registry';

// Pending write-confirmations keyed by confirmId. A write tool registers a
// resolver here and waits; the renderer answers via 'llm:confirm:respond' with
// the (possibly user-edited) args, or null to decline.
const pendingConfirms = new Map<string, (result: Record<string, unknown> | null) => void>();
let confirmSeq = 0;

// In-flight streaming chats, keyed by requestId, so 'llm:chat:stop' can abort one.
const activeChats = new Map<string, AbortController>();

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
        { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'log', 'html', 'xml', 'yml', 'yaml'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths[0]) return null;
    const { extractAttachmentText } = await import('../services/attachments');
    return extractAttachmentText(filePaths[0]);
  });

  // Non-streaming, read-only (no confirm → write tools unavailable).
  ipcMain.handle(
    'llm:chat',
    (_event, history: ChatTurn[], message: string, product: GoogleProduct) => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Message cannot be empty.');
      }
      return service.chat(Array.isArray(history) ? history : [], message, product === 'ga4' ? 'ga4' : 'gtm');
    }
  );

  // Streaming: pushes 'llm:chat:event' (text/tool/confirm, tagged by requestId).
  // Write tools pause on a 'confirm' event until the renderer responds.
  ipcMain.handle(
    'llm:chat:start',
    (event, requestId: string, history: ChatTurn[], message: string, product: GoogleProduct) => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Message cannot be empty.');
      }
      const scopedProduct: GoogleProduct = product === 'ga4' ? 'ga4' : 'gtm';
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
          controller.signal
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
}
