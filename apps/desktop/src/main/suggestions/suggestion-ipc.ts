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
import { reportHtmlDocument } from '../google/ga4-report-export';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import type { CreateTagOutcome, SuggestedTagView, TagScanOptions, VerifyTagInput, VerifyTagsOptions, VerifyTagsResult, DetectedElementView, FormsForFillOptions, FormsForFillResult, SubmitFormVerifyOptions, SubmitFormVerifyResult } from '../../shared/ipc';
import { crawlAndSuggest, scanUrls, type ScanProgress } from './scan-core';
import { runVerifyDriver } from './verify-driver';
import { runFormSubmitDriver, type FormSubmitFieldInput } from './form-submit-driver';
import { evaluateVerify } from './verify-tags';
import { routeTagsToPages } from './verify-routing';
import { toFormFillViews, localeOptions, matchFiredContainerTags } from './form-fill-plan';
import { snapshotToVerifyInputs } from './container-verify';
import { localeById } from '../../../../web-audit-mcp/src/agent/form-fill.js';
import type { RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
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

  // Save the install runbook (already rendered to Markdown in the renderer) to a
  // file the user picks. Read-only export — no GTM access (just a local file save).
  // Returns the saved path, or null if the user cancelled. The 'md' branch writes
  // the Markdown unchanged; the 'pdf' branch reuses the GA4-report Markdown→HTML→PDF
  // pipeline (reportHtmlDocument + a hidden, script-disabled printToPDF window),
  // mirroring ga4:exportReport's PDF path exactly.
  ipcMain.handle('suggestions:exportRunbook', async (e, defaultName: unknown, markdown: unknown, format?: unknown) => {
    const fmt = format === 'pdf' ? 'pdf' : 'md';
    const win = BrowserWindow.fromWebContents(e.sender);
    const base = String(defaultName ?? 'Measurement Install Runbook')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(md|pdf)$/i, '')
      .trim() || 'Measurement Install Runbook';
    const filterName = fmt === 'pdf' ? 'PDF' : 'Markdown';
    const opts = { title: 'Export install runbook', defaultPath: `${base}.${fmt}`, filters: [{ name: filterName, extensions: [fmt] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    if (fmt === 'md') {
      await writeFile(filePath, String(markdown ?? ''), 'utf8');
      return filePath;
    }
    // PDF — render the runbook HTML in a hidden, script-disabled window and print it to PDF.
    const pdfWin = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await pdfWin.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(reportHtmlDocument('Measurement Installation Runbook', String(markdown ?? ''), {})),
      );
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
      await writeFile(filePath, pdf);
      return filePath;
    } finally {
      if (!pdfWin.isDestroyed()) pdfWin.destroy();
    }
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
      let els = (Array.isArray(elements) ? elements : []) as DetectedElementView[];
      if (tagList.length === 0) return { url: target, injected: false, previewAuth: false, pagesOk: false, error: 'No tags selected to verify.', verdicts: [] };
      const o = opts ?? {};

      // MULTI-PAGE DRIVE: a container's Click triggers are site-wide, so without knowing which page
      // each CTA lives on the driver would drive them all on the homepage and falsely report
      // "no element matched" for anything on /careers, /blog, a service page, etc. When the caller
      // didn't supply a scan inventory, crawl the site to locate each CTA's page, then route each
      // click tag there. Best-effort — any crawl failure falls back to single-page driving.
      let pagesCrawled = 0;
      const hasClickTags = tagList.some((t) => t.trigger.kind === 'link_click' || t.trigger.kind === 'all_clicks');
      if (els.length === 0 && hasClickTags && o.crawlForPages !== false) {
        try {
          const crawlDriver = await makeDriver({ maxPages: o.crawlMaxPages, maxDepth: o.crawlMaxDepth });
          const scan = await crawlAndSuggest(crawlDriver, target, { maxPages: o.crawlMaxPages, maxDepth: o.crawlMaxDepth, platforms: ['ga4'] });
          els = scan.inventory.elements as DetectedElementView[];
          pagesCrawled = scan.pages.length;
        } catch {
          /* crawl is best-effort — fall back to single-page driving */
        }
      }
      const routed = routeTagsToPages(tagList, els, target);

      const driven = await runVerifyDriver(
        target,
        routed.map((t) => ({ id: t.id, ...(t.page ? { page: t.page } : {}), trigger: t.trigger })),
        { ...(o.containerSnippet ? { containerSnippet: o.containerSnippet } : {}), settleMs: clampSettle(o.settleMs), navTimeoutMs: o.navTimeoutMs, ...(o.gtmDebug ? { gtmDebug: true } : {}) },
      );
      const verdicts = evaluateVerify(tagList, driven.perTag, els);
      return { url: target, injected: driven.injected, previewAuth: driven.previewAuth, pagesOk: driven.pagesOk, ...(driven.error ? { error: driven.error } : {}), verdicts, ...(driven.pagesDriven ? { pagesDriven: driven.pagesDriven } : {}), ...(pagesCrawled ? { pagesCrawled } : {}), ...(driven.gtmDebug ? { gtmDebug: driven.gtmDebug } : {}) };
    },
  );

  // Real-submit form verification (review step): open one URL, read each form's OWN fields, and
  // return a locale fill plan the operator reviews + edits before Phase 2 actually submits. READ-ONLY:
  // it opens the page and reads the DOM; it fills nothing and submits nothing.
  ipcMain.handle('suggestions:formsForFill', async (_e, url: unknown, opts?: FormsForFillOptions): Promise<FormsForFillResult> => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const o = opts ?? {};
    const locale = localeById(o.localeId);
    let rawForms: RawForm[] = [];
    let error: string | undefined;
    const driver = await makeDriver({});
    try {
      const driven = await driver.open(target);
      rawForms = driven.rawForms ?? [];
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    } finally {
      try { await driver.close(); } catch { /* best-effort */ }
    }
    // A traceable, unique alias so a real submit (Phase 2) is filterable in the operator's CRM.
    const emailTag = `d${Date.now().toString(36)}`;
    const forms = toFormFillViews(rawForms, target, locale.id, emailTag);
    return { url: target, localeId: locale.id, locales: localeOptions(), forms, ...(error ? { error } : {}) };
  });

  // Phase 2 — REAL submit: fill the operator-reviewed values and submit ONE form for real, then report
  // the analytics events it fired. The form's POST is delivered (a real submission / lead); analytics
  // hits are captured+aborted so GA4/ad platforms aren't polluted with a test conversion. Operator-
  // initiated per submit (the renderer shows an explicit real-lead warning + confirm before calling).
  ipcMain.handle('suggestions:submitFormAndVerify', async (_e, url: unknown, input: unknown, opts?: SubmitFormVerifyOptions): Promise<SubmitFormVerifyResult> => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot submit against that URL: ${verdict.reason}`);
    const inp = (input && typeof input === 'object' ? input : {}) as { formId?: unknown; formClasses?: unknown; method?: unknown; fields?: unknown };
    const list = (Array.isArray(inp.fields) ? inp.fields : []) as FormSubmitFieldInput[];
    if (list.length === 0) return { ok: false, injected: false, previewAuth: false, filled: 0, submitted: false, error: 'No fields to submit.', events: [], beacons: [] };
    const o = opts ?? {};
    const res = await runFormSubmitDriver(
      target,
      { formId: String(inp.formId ?? ''), formClasses: String(inp.formClasses ?? ''), method: String(inp.method ?? ''), fields: list },
      { ...(o.containerSnippet ? { containerSnippet: o.containerSnippet } : {}) },
    );
    // Pair the fired GA4 events to the container's ACTUAL tags (best-effort — needs container context).
    if (res.events.length > 0 && o.accountId && o.containerId && o.workspaceId) {
      try {
        const snap = await data.getGtmContainerSnapshot(o.accountId, o.containerId, o.workspaceId);
        const { tags } = snapshotToVerifyInputs(snap);
        const firedTags = matchFiredContainerTags(res.events, tags.map((t) => ({ tagName: t.tagName, eventName: t.eventName })));
        if (firedTags.length > 0) return { ...res, firedTags };
      } catch {
        /* pairing is best-effort — return the raw events without it */
      }
    }
    return res;
  });

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

  // Create ONE Custom HTML listener tag from a suggestion's install plan (the
  // 'listener-tag' requirement) as a DRAFT, on explicit user click. Same posture
  // as createTags: the RENDERER already gated this behind a user click, so the
  // confirm fn auto-approves the single create_gtm_tracking_tag write (draft-only,
  // never published). The HTML is our own vetted install-plan template, not user
  // input. The listener always fires on the built-in "All Pages" pageview trigger
  // — the exact shape form-recipes.ts's listenerTag produces for the same purpose.
  ipcMain.handle(
    'suggestions:createListenerTag',
    async (_e, accountId: unknown, containerId: unknown, workspaceId: unknown, listener: unknown): Promise<CreateTagOutcome> => {
      const acct = String(accountId ?? '');
      const cont = String(containerId ?? '');
      const ws = String(workspaceId ?? '');
      if (!acct || !cont || !ws) throw new Error('Pick a GTM account, container and draft workspace first.');
      const l = (listener ?? {}) as { name?: unknown; html?: unknown };
      const name = String(l.name ?? '').trim();
      const html = String(l.html ?? '');
      if (!name) throw new Error('The listener tag is missing a name.');
      if (!html.trim()) throw new Error('The listener tag is missing its HTML.');

      // Same create path as createTags — echo the args into the existing
      // create_gtm_tracking_tag write tool (draft-only, no publish). The confirm fn
      // auto-approves because the renderer already required an explicit click.
      const approve: ConfirmFn = async (p) => p.details;
      const reg = buildToolRegistry(data, approve, 'gtm');

      // "Found entity with duplicate name" → the listener tag is already there:
      // report it as existing (skipped), not an error. Mirrors createSuggestedTags.
      const DUPLICATE_RE = /duplicate name|already exists|entity with duplicate|duplicate entity/i;
      try {
        const out = JSON.parse(
          await reg.execute('create_gtm_tracking_tag', {
            accountId: acct,
            containerId: cont,
            workspaceId: ws,
            tagName: name,
            platform: 'custom_html',
            html,
            trigger: { name: 'All Pages', kind: 'pageview' },
          }),
        ) as { declined?: boolean; alreadyExists?: boolean; tag?: { name?: string }; trigger?: { reused?: boolean } };
        if (out?.declined) return { id: name, ok: false, error: 'declined' };
        if (out?.alreadyExists) return { id: name, ok: false, existing: true, error: 'already exists' };
        return { id: name, ok: true, tagName: out?.tag?.name ?? name, triggerReused: out?.trigger?.reused === true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (DUPLICATE_RE.test(msg)) return { id: name, ok: false, existing: true, error: 'already exists' };
        return { id: name, ok: false, error: msg };
      }
    },
  );
}
