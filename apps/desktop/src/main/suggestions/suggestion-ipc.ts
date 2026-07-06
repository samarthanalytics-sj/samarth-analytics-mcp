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

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { GoogleDataService } from '../google/data-service';
import type { ProviderKeyStore } from '../storage/provider-keys';
import { findGa4BaseTag } from '../google/gtm-builders';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import type { CreateTagOutcome, SuggestedTagView, TagScanOptions, VerifyTagInput, VerifyTagsOptions, VerifyTagsResult, DetectedElementView } from '../../shared/ipc';
import { crawlAndSuggest, scanUrls, type ScanProgress } from './scan-core';
import { runVerifyDriver } from './verify-driver';
import { evaluateVerify } from './verify-tags';
import { discoverSite } from './discover';
import { createElectronDriver } from './electron-driver';
// The merged page-driver builder (Electron + optional Cheerio/Playwright) lives in scan-url.ts,
// shared with the `suggest_tags_from_url` chat tool so both scan paths render pages identically.
import { makeDriver, clampSettle } from './scan-url';
import { parseSuggestions, createSuggestedTags, planGoogleTagVars, provisionVariables } from './suggestion-service';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';

export function registerSuggestionsIpc(data: GoogleDataService, providerKeys: ProviderKeyStore): void {
  ipcMain.handle('suggestions:fromJson', (_e, json: unknown) => parseSuggestions(String(json ?? '')));

  // EXPERIMENTAL: single-page AI scan — screenshot the page + let OpenAI vision pick
  // the GA4 tags, wired to the real scraped elements. Uses the stored OpenAI key.
  // Sends the page screenshot to OpenAI (opt-in, the user picked this mode).
  ipcMain.handle('suggestions:aiScan', async (_e, url: unknown, opts?: TagScanOptions) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const apiKey = providerKeys.getKey('openai');
    if (!apiKey) throw new Error('No OpenAI API key found — add one in Settings → Providers to use the AI scan.');
    const settleMs = clampSettle((opts ?? {}).settleMs);
    const driver = createElectronDriver(settleMs !== undefined ? { settleMs } : {});
    const { aiScanPage } = await import('./ai-scan');
    return aiScanPage({ url: target, apiKey, model: 'gpt-4o', driver, platforms: (opts ?? {}).platforms ?? ['ga4'] });
  });

  // Read-only: the container's existing tag names + whether a GA4 base/config tag is
  // present, so the review panel can mark suggestions that ALREADY EXIST (don't
  // re-create them — that just fails with "duplicate name" and wastes API quota).
  ipcMain.handle('suggestions:existing', async (_e, accountId: unknown, containerId: unknown, workspaceId: unknown) => {
    const a = String(accountId ?? ''), c = String(containerId ?? ''), w = String(workspaceId ?? '');
    if (!a || !c || !w) return { names: [], hasGa4Base: false };
    const snap = await data.getGtmContainerSnapshot(a, c, w);
    return { names: snap.tags.map((t) => t.name), hasGa4Base: findGa4BaseTag(snap) !== null };
  });

  // Save the suggestion structure (already rendered to CSV in the renderer) to a
  // file the user picks. Read-only export — no GTM access. Returns the saved path,
  // or null if the user cancelled.
  ipcMain.handle('suggestions:exportCsv', async (e, defaultName: unknown, csv: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = String(defaultName ?? 'GTM Structure - GA4 Events.csv').replace(/[\\/:*?"<>|]/g, '_');
    const opts = { title: 'Export tag structure', defaultPath: name, filters: [{ name: 'CSV', extensions: ['csv'] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await writeFile(filePath, String(csv ?? ''), 'utf8');
    return filePath;
  });

  ipcMain.handle('suggestions:scan', async (_e, url: unknown, opts?: TagScanOptions) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const o = opts ?? {};
    const driver = await makeDriver(o);
    return crawlAndSuggest(driver, target, { maxPages: o.maxPages, maxDepth: o.maxDepth, platforms: o.platforms ?? ['ga4'] });
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
    const o = opts ?? {};
    const driver = await makeDriver(o);
    let siteHost: string | undefined;
    try {
      siteHost = new URL(list[0]).hostname;
    } catch {
      /* per-URL admission still applies in scanUrls */
    }
    return scanUrls(driver, list, siteHost, undefined, { platforms: o.platforms ?? ['ga4'] });
  });

  // Auto-mint a workspace-PREVIEW snippet so Verify firing can load DRAFT tags with
  // no manual paste: snapshots the workspace into a version + binds a reusable preview
  // environment, returns its snippet. Draft-level writes; never published.
  ipcMain.handle('suggestions:mintPreview', async (_e, accountId: unknown, containerId: unknown, workspaceId: unknown) => {
    const a = String(accountId ?? ''), c = String(containerId ?? ''), w = String(workspaceId ?? '');
    if (!a || !c || !w) throw new Error('Pick a GTM account, container and draft workspace first.');
    return data.mintWorkspacePreview(a, c, w);
  });

  // Verify FIRING: inject the pasted (preview) container onto the page, drive each
  // tag's trigger (click/submit), and report whether it fired — with a corrected
  // trigger when it didn't. Never delivers a real hit (abort-first capture).
  ipcMain.handle(
    'suggestions:verifyTags',
    async (_e, url: unknown, tags: unknown, elements: unknown, opts?: VerifyTagsOptions): Promise<VerifyTagsResult> => {
      const target = String(url ?? '').trim();
      const verdict = urlAllowed(target, []);
      if (!verdict.ok) throw new Error(`Cannot verify that URL: ${verdict.reason}`);
      const tagList = (Array.isArray(tags) ? tags : []) as VerifyTagInput[];
      const els = (Array.isArray(elements) ? elements : []) as DetectedElementView[];
      if (tagList.length === 0) return { url: target, injected: false, previewAuth: false, pagesOk: false, error: 'No tags selected to verify.', verdicts: [] };
      const o = opts ?? {};
      const driven = await runVerifyDriver(
        target,
        tagList.map((t) => ({ id: t.id, ...(t.page ? { page: t.page } : {}), trigger: t.trigger })),
        { ...(o.containerSnippet ? { containerSnippet: o.containerSnippet } : {}), settleMs: clampSettle(o.settleMs), navTimeoutMs: o.navTimeoutMs, ...(o.gtmDebug ? { gtmDebug: true } : {}) },
      );
      const verdicts = evaluateVerify(tagList, driven.perTag, els);
      return { url: target, injected: driven.injected, previewAuth: driven.previewAuth, pagesOk: driven.pagesOk, ...(driven.error ? { error: driven.error } : {}), verdicts, ...(driven.gtmDebug ? { gtmDebug: driven.gtmDebug } : {}) };
    },
  );

  // Streaming variants — push 'suggestions:scan:event' (the RUNNING suggestion list +
  // crawl progress, tagged by requestId) after every page, so the review panel fills
  // in one-by-one instead of waiting for the whole crawl. Resolve with the final result.
  const streamSink = (event: { sender: Electron.WebContents }, requestId: string) =>
    (p: ScanProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send('suggestions:scan:event', { requestId, ...p });
    };

  ipcMain.handle('suggestions:scanStream', async (event, requestId: unknown, url: unknown, opts?: TagScanOptions) => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const o = opts ?? {};
    const driver = await makeDriver(o);
    return crawlAndSuggest(driver, target, { maxPages: o.maxPages, maxDepth: o.maxDepth, platforms: o.platforms ?? ['ga4'] }, streamSink(event, String(requestId ?? '')));
  });

  ipcMain.handle('suggestions:scanUrlsStream', async (event, requestId: unknown, urls: unknown, opts?: TagScanOptions) => {
    const list = Array.isArray(urls) ? urls.map((u) => String(u)).filter(Boolean) : [];
    if (list.length === 0) throw new Error('No pages selected to scan.');
    const o = opts ?? {};
    const driver = await makeDriver(o);
    let siteHost: string | undefined;
    try {
      siteHost = new URL(list[0]).hostname;
    } catch {
      /* per-URL admission still applies */
    }
    return scanUrls(driver, list, siteHost, streamSink(event, String(requestId ?? '')), { platforms: o.platforms ?? ['ga4'] });
  });

  ipcMain.handle(
    'suggestions:createTags',
    async (
      event,
      requestId: unknown,
      accountId: unknown,
      containerId: unknown,
      workspaceId: unknown,
      tags: unknown,
    ): Promise<CreateTagOutcome[]> => {
      const acct = String(accountId ?? '');
      const cont = String(containerId ?? '');
      const ws = String(workspaceId ?? '');
      const reqId = String(requestId ?? '');
      if (!acct || !cont || !ws) throw new Error('Pick a GTM account, container and draft workspace first.');
      const list = Array.isArray(tags) ? (tags as SuggestedTagView[]) : [];

      // Renderer already approved this batch; echo args unchanged so the existing
      // create_gtm_tracking_tag write path runs (draft-only, no publish).
      const approve: ConfirmFn = async (p) => p.details;
      const reg = buildToolRegistry(data, approve, 'gtm');
      const ids = { accountId: acct, containerId: cont, workspaceId: ws };

      // A google_tag (GA4 Configuration) whose tagId is a {{variable}} needs that
      // variable to EXIST, or the base tag points at nothing and GA4 never loads
      // (mirrors ensureGa4Config). Provision a Constant from the row's real
      // Measurement ID first; block the row if the ID is still the placeholder.
      const errors = new Map<string, string>();
      const hasGoogleTagVar = list.some((t) => t.platform === 'google_tag' && /^\s*\{\{.+\}\}\s*$/.test(t.tagId ?? ''));
      if (hasGoogleTagVar) {
        const snap = await data.getGtmContainerSnapshot(acct, cont, ws);
        const plan = planGoogleTagVars(snap, list);
        for (const [id, msg] of plan.errors) errors.set(id, msg);
        // Resilient variable creation — a duplicate/quota hiccup on a variable fails
        // ONLY the google_tag rows that need it, never the whole approved batch.
        const failedVars = await provisionVariables((name, args) => reg.execute(name, args), ids, plan.creates);
        if (failedVars.size) {
          for (const t of list) {
            if (t.platform !== 'google_tag') continue;
            const vn = /^\s*\{\{(.+?)\}\}\s*$/.exec(t.tagId ?? '')?.[1]?.toLowerCase();
            if (vn && failedVars.has(vn)) errors.set(t.id, `Couldn't create the variable it needs: ${failedVars.get(vn)}`);
          }
        }
      }
      const creatable = list.filter((t) => !errors.has(t.id));
      const outcomes = await createSuggestedTags((name, args) => reg.execute(name, args), ids, creatable, {
        onProgress: (doneCount, total) => {
          if (reqId && !event.sender.isDestroyed()) event.sender.send('suggestions:createTags:event', { requestId: reqId, done: doneCount, total });
        },
      });
      for (const [id, error] of errors) outcomes.push({ id, ok: false, error });
      return outcomes;
    },
  );
}
