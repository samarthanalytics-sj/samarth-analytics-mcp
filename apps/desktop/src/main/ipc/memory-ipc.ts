import { ipcMain } from 'electron';
import type { MemoryStore } from '../storage/memory-store';
import type { RegistryService } from '../services/registry-service';
import type { ChatService } from '../services/chat-service';
import type { GoogleDataService } from '../google/data-service';
import { memoryDedupeKey, memoryApplies, type Memory, type MemoryInput, type MemoryPatch, type AddMemoryResult } from '../../shared/chat-memory';
import type { MemoryCandidate } from '../../shared/memory-extract';
import type { SeedCandidate } from '../../shared/memory-seed';
import type { ChatTurn } from '../../shared/ipc';
import { withQuotaRetry } from '../google/quota-retry';

// IPC for the chat-memory panel — CRUD over the ACTIVE account's memories (the store keys by account, so
// the renderer never passes an id; it always manages "this account's" notes, matching how chat injects them).
// Read/write of local config metadata only; text is secret-redacted inside the store before it persists.
// memory:suggest (Phase 2b) runs the LLM extraction pass via ChatService and returns PROPOSALS only — the
// user reviews + approves each via memory:add, so nothing is auto-saved.

export function registerMemoryIpc(memory: MemoryStore, registry: RegistryService, chatService: ChatService, data: GoogleDataService): void {
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

  // Phase 3 AUTO-SEED: derive durable facts from the ACTIVE container's own configuration (read-only GTM
  // snapshot → a pure, deterministic engine). Returns PROPOSALS, already de-duplicated against what's saved;
  // the user reviews and adds them via memory:add. No LLM involved, so no extraction/injection risk.
  ipcMain.handle('memory:seed', async (): Promise<SeedCandidate[]> => {
    const a = registry.getActiveView();
    if (!a) throw new Error('No active account. Connect and activate a Google account first.');
    const ctx = a.gtmContext;
    if (!ctx?.accountId || !ctx?.containerId || !ctx?.workspaceId) {
      throw new Error('Pick a GTM account, container and workspace first — seeding reads that container\'s configuration.');
    }
    const snap = await withQuotaRetry(() => data.getGtmContainerSnapshot(ctx.accountId!, ctx.containerId!, ctx.workspaceId!));
    const { seedMemoriesFromContainer, attachSupersessions } = await import('../../shared/memory-seed');
    // De-dupe ONLY against memories that APPLY to this container (account-wide + this container's). A note
    // saved scoped to a DIFFERENT container must not suppress the same fact here — it would never be
    // injected into this client's chats, so skipping it would silently lose the fact for this client.
    const applicable = memory.list(a.id).filter((m) => memoryApplies(m, { containerId: ctx.containerId }));
    const seen = new Set(applicable.map((m) => memoryDedupeKey({ kind: m.kind, text: m.text })));
    const fresh = seedMemoriesFromContainer(snap).filter((c) => !seen.has(memoryDedupeKey(c)));
    // A list fact whose tail changed since the last seed (IDs/platforms/events grew) SUPERSEDES the stale
    // auto-seeded note — approving it replaces that note instead of piling a near-duplicate next to it.
    const priorAuto = applicable.filter((m) => m.source === 'auto').map((m) => ({ id: m.id, text: m.text }));
    return attachSupersessions(fresh, priorAuto);
  });
}
