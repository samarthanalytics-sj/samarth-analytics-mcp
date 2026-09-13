import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile, readFile } from 'node:fs/promises';
import type { MemoryStore } from '../storage/memory-store';
import type { RegistryService } from '../services/registry-service';
import type { ChatService } from '../services/chat-service';
import type { GoogleDataService } from '../google/data-service';
import { memoryDedupeKey, memoryApplies, type Memory, type MemoryInput, type MemoryPatch, type AddMemoryResult } from '../../shared/chat-memory';
import type { MemoryCandidate } from '../../shared/memory-extract';
import type { SeedCandidate } from '../../shared/memory-seed';
import type { ChatTurn } from '../../shared/ipc';
import { buildMemoryExport, parseMemoryExport, planMemoryImport, memoryExportFilename, type ImportPlan } from '../../shared/memory-transfer';
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

  // ---- Handing a client's notes to a colleague -------------------------------------------------
  // Memory is per person, per machine: a colleague opening the same container starts from zero. This
  // is the step before real shared memory, and needs no backend, identity model or sync.
  //
  // EXPORT is SCOPED TO THE ACTIVE CLIENT (memoryApplies), so a handover file cannot carry another
  // client's notes. IMPORT only PARSES and PLANS; the accepted notes are added by the renderer through
  // memory:add, so redaction, dedupe, capping and eviction all still apply. Import is never a
  // privileged write into the store.
  ipcMain.handle('memory:export', async (e): Promise<{ saved: boolean; path?: string; count: number }> => {
    const account = registry.getActiveView();
    if (!account) throw new Error('No active account. Connect and activate a Google account first.');
    const ctx = account.gtmContext;
    const applicable = memory.list(account.id)
      .filter((m) => memoryApplies(m, { containerId: ctx?.containerId, property: account.ga4Context?.property }));
    const exportedAt = new Date().toISOString().slice(0, 10); // date only: this file gets emailed around
    // Retractions for THIS client (plus account-wide ones), so a re-import can also remove notes the
    // sender has since deleted. Hashes only: the deleted text never leaves this machine.
    const retracted = memory.tombstones(account.id)
      .filter((t) => !t.clientScoped || !t.containerId || t.containerId === ctx?.containerId);
    const file = buildMemoryExport(applicable, {
      exportedAt,
      ...(ctx?.containerId ? { client: { containerId: ctx.containerId, containerName: ctx.containerName, publicId: ctx.containerPublicId } } : {}),
      ...(retracted.length ? { retracted } : {}),
    });
    if (file.notes.length === 0 && !retracted.length) return { saved: false, count: 0 };
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Export memory notes', defaultPath: memoryExportFilename(file.client, exportedAt), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return { saved: false, count: file.notes.length };
    await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');
    return { saved: true, path: filePath, count: file.notes.length };
  });

  ipcMain.handle('memory:importPlan', async (e): Promise<ImportPlan & { cancelled?: boolean; client?: unknown }> => {
    const account = registry.getActiveView();
    if (!account) throw new Error('No active account. Connect and activate a Google account first.');
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Import memory notes', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths?.length) return { add: [], duplicates: [], remove: [], problems: [], cancelled: true };
    const raw = await readFile(filePaths[0], 'utf8').catch(() => '');
    const parsed = parseMemoryExport(raw);
    const ctx = account.gtmContext;
    const plan = planMemoryImport(parsed, memory.list(account.id), ctx?.containerId ? { containerId: ctx.containerId, label: ctx.containerName } : undefined);
    return { ...plan, ...(parsed.client ? { client: parsed.client } : {}) };
  });
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
