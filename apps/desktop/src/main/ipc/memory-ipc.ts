import { ipcMain } from 'electron';
import type { MemoryStore } from '../storage/memory-store';
import type { RegistryService } from '../services/registry-service';
import type { ChatService } from '../services/chat-service';
import type { Memory, MemoryInput, MemoryPatch, AddMemoryResult } from '../../shared/chat-memory';
import type { MemoryCandidate } from '../../shared/memory-extract';
import type { ChatTurn } from '../../shared/ipc';

// IPC for the chat-memory panel — CRUD over the ACTIVE account's memories (the store keys by account, so
// the renderer never passes an id; it always manages "this account's" notes, matching how chat injects them).
// Read/write of local config metadata only; text is secret-redacted inside the store before it persists.
// memory:suggest (Phase 2b) runs the LLM extraction pass via ChatService and returns PROPOSALS only — the
// user reviews + approves each via memory:add, so nothing is auto-saved.

export function registerMemoryIpc(memory: MemoryStore, registry: RegistryService, chatService: ChatService): void {
  const activeId = (): string => {
    const a = registry.getActiveView();
    if (!a) throw new Error('No active account. Connect and activate a Google account first.');
    return a.id;
  };

  ipcMain.handle('memory:list', (): Memory[] => memory.list(activeId()));
  ipcMain.handle('memory:add', (_e, input: MemoryInput): AddMemoryResult => memory.add(activeId(), input));
  ipcMain.handle('memory:update', (_e, id: unknown, patch: MemoryPatch): Memory | null => memory.update(activeId(), String(id ?? ''), patch ?? {}));
  ipcMain.handle('memory:remove', (_e, id: unknown): boolean => memory.remove(activeId(), String(id ?? '')));
  ipcMain.handle('memory:clear', (): number => memory.clear(activeId()));
  ipcMain.handle('memory:suggest', (_e, history: unknown): Promise<MemoryCandidate[]> =>
    chatService.suggestMemories(Array.isArray(history) ? (history as ChatTurn[]) : []));
}
