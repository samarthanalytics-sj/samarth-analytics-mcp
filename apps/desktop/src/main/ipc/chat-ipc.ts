import { ipcMain } from 'electron';
import type { ChatService } from '../services/chat-service';
import type { ChatTurn, GoogleProduct } from '../../shared/ipc';
import type { WriteProposal } from '../tools/registry';

// Pending write-confirmations keyed by confirmId. A write tool registers a
// resolver here and waits; the renderer answers via 'llm:confirm:respond' with
// the (possibly user-edited) args, or null to decline.
const pendingConfirms = new Map<string, (result: Record<string, unknown> | null) => void>();
let confirmSeq = 0;

export function registerChatIpc(service: ChatService): void {
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
          });
        });
      return service.chatStream(
        Array.isArray(history) ? history : [],
        message,
        scopedProduct,
        (ev) => send({ requestId, ...ev }),
        confirm
      );
    }
  );

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
