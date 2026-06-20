// IPC for the tag-suggestion review/approve panel. Three channels:
//   suggestions:scan      (read-only) crawl a URL → ranked suggestions
//   suggestions:fromJson  (read-only) parse a pasted gtm_tag_suggestions report
//   suggestions:createTags (write)    create the user-approved tags as DRAFTS
//
// The create path reuses the EXISTING create_gtm_tracking_tag tool (the single
// create code path — same builders, same draft-only/no-publish guarantee). The
// confirm fn here auto-approves because the RENDERER already performed an
// explicit batch approval ("Create N tags?") before invoking this channel; this
// is not a way to bypass approval — write tools still only exist because a
// confirm fn is supplied, and nothing is ever published.

import { ipcMain } from 'electron';
import type { GoogleDataService } from '../google/data-service';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import type { CreateTagOutcome, SuggestedTagView } from '../../shared/ipc';
import { crawlAndSuggest } from './scan-core';
import { createElectronDriver } from './electron-driver';
import { parseSuggestions, createSuggestedTags } from './suggestion-service';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';

export function registerSuggestionsIpc(data: GoogleDataService): void {
  ipcMain.handle('suggestions:fromJson', (_e, json: unknown) => parseSuggestions(String(json ?? '')));

  ipcMain.handle('suggestions:scan', async (_e, url: unknown, maxPages?: number, maxDepth?: number) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const driver = createElectronDriver();
    return crawlAndSuggest(driver, target, { maxPages, maxDepth });
  });

  ipcMain.handle(
    'suggestions:createTags',
    async (
      _e,
      accountId: unknown,
      containerId: unknown,
      workspaceId: unknown,
      tags: unknown,
    ): Promise<CreateTagOutcome[]> => {
      const acct = String(accountId ?? '');
      const cont = String(containerId ?? '');
      const ws = String(workspaceId ?? '');
      if (!acct || !cont || !ws) throw new Error('Pick a GTM account, container and draft workspace first.');
      const list = Array.isArray(tags) ? (tags as SuggestedTagView[]) : [];

      // Renderer already approved this batch; echo args unchanged so the existing
      // create_gtm_tracking_tag write path runs (draft-only, no publish).
      const approve: ConfirmFn = async (p) => p.details;
      const reg = buildToolRegistry(data, approve, 'gtm');
      return createSuggestedTags((name, args) => reg.execute(name, args), { accountId: acct, containerId: cont, workspaceId: ws }, list);
    },
  );
}
