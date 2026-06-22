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
import type { CreateTagOutcome, SuggestedTagView, TagScanOptions } from '../../shared/ipc';
import { crawlAndSuggest, scanUrls, type PageDriver } from './scan-core';
import { discoverSite } from './discover';
// Electron is the always-on, zero-install engine. Cheerio is added when present
// (lazy-imported so a missing optional package never crashes startup). The two
// run together per page and their results are MERGED — Electron renders JS +
// same-origin iframes; Cheerio adds anything in the raw server HTML.
import { createElectronDriver } from './electron-driver';
import { createMultiDriver } from './multi-driver';
import { parseSuggestions, createSuggestedTags } from './suggestion-service';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';

const clampSettle = (ms: number | undefined): number | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms <= 0 ? undefined : Math.min(Math.floor(ms), 10_000);

async function makeDriver(opts: TagScanOptions): Promise<PageDriver> {
  const settleMs = clampSettle(opts.settleMs);
  const drivers: PageDriver[] = [createElectronDriver(settleMs !== undefined ? { settleMs } : {})];
  // Add the complementary static (Cheerio) engine if installed — purely additive.
  try {
    const { createCheerioDriver } = await import('./cheerio-driver');
    drivers.push(createCheerioDriver());
  } catch {
    /* cheerio not installed — fine */
  }
  // Add Playwright if the user installed it — it waits for network-idle, so it
  // renders JS/embedded forms more thoroughly than the default settle; merged in.
  try {
    const { createPlaywrightDriver } = await import('./playwright-driver');
    drivers.push(await createPlaywrightDriver({ settleMs }));
  } catch {
    /* playwright not installed — fine, Electron+Cheerio still run */
  }
  return drivers.length === 1 ? drivers[0] : createMultiDriver(drivers);
}

export function registerSuggestionsIpc(data: GoogleDataService): void {
  ipcMain.handle('suggestions:fromJson', (_e, json: unknown) => parseSuggestions(String(json ?? '')));

  ipcMain.handle('suggestions:scan', async (_e, url: unknown, opts?: TagScanOptions) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const o = opts ?? {};
    const driver = await makeDriver(o);
    return crawlAndSuggest(driver, target, { maxPages: o.maxPages, maxDepth: o.maxDepth });
  });

  // Enumerate same-site pages (sitemap/crawl) so the user can pick which to scan.
  ipcMain.handle('suggestions:discover', async (_e, url: unknown) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    return discoverSite(target);
  });

  // Deep-scan a SPECIFIC list of pages the user selected after discovery.
  ipcMain.handle('suggestions:scanUrls', async (_e, urls: unknown, opts?: TagScanOptions) => {
    const list = Array.isArray(urls) ? urls.map((u) => String(u)).filter(Boolean) : [];
    if (list.length === 0) throw new Error('No pages selected to scan.');
    const driver = await makeDriver(opts ?? {});
    let siteHost: string | undefined;
    try {
      siteHost = new URL(list[0]).hostname;
    } catch {
      /* per-URL admission still applies in scanUrls */
    }
    return scanUrls(driver, list, siteHost);
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
