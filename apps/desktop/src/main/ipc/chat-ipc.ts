import { ipcMain } from 'electron';
import type { ChatService } from '../services/chat-service';
import type { ChatTurn } from '../../shared/ipc';

export function registerChatIpc(service: ChatService): void {
  ipcMain.handle('llm:chat', (_event, history: ChatTurn[], message: string) => {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('Message cannot be empty.');
    }
    return service.chat(Array.isArray(history) ? history : [], message);
  });
}
