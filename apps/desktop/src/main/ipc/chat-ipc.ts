import { ipcMain } from 'electron';
import type { ChatService } from '../services/chat-service';
import type { ChatTurn } from '../../shared/ipc';

export function registerChatIpc(service: ChatService): void {
  // Non-streaming (kept for simple callers).
  ipcMain.handle('llm:chat', (_event, history: ChatTurn[], message: string) => {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('Message cannot be empty.');
    }
    return service.chat(Array.isArray(history) ? history : [], message);
  });

  // Streaming: pushes 'llm:chat:event' messages (tagged with requestId) to the
  // sender as text/tool events; resolves with the final ChatReply.
  ipcMain.handle(
    'llm:chat:start',
    (event, requestId: string, history: ChatTurn[], message: string) => {
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('Message cannot be empty.');
      }
      return service.chatStream(Array.isArray(history) ? history : [], message, (ev) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('llm:chat:event', { requestId, ...ev });
        }
      });
    }
  );
}
