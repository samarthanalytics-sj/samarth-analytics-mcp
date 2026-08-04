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

import { ipcMain, dialog, BrowserWindow, app, clipboard, nativeImage } from 'electron';
import { log } from '../logger';
import { writeFile } from 'node:fs/promises';
import type { GoogleDataService } from '../google/data-service';
import { findGa4BaseTag, plainDashes } from '../google/gtm-builders';
import { reportHtmlDocument } from '../google/ga4-report-export';
import { buildToolRegistry, type ConfirmFn } from '../tools/registry';
import type { CreateTagOutcome, SuggestedTagView, TagScanOptions, VerifyTagInput, VerifyTagsOptions, VerifyTagsResult, VerifyProgressView, DetectedElementView, FormsForFillOptions, FormsForFillResult, SubmitFormVerifyOptions, SubmitFormVerifyResult, FormTagVerifyPlanOptions, FormTagVerifyPlanResult, SuggestionScreenshotResult, PreflightContainerResult } from '../../shared/ipc';
import { crawlAndSuggest, scanUrls, type ScanProgress } from './scan-core';
import type { MemoryStore } from '../storage/memory-store';
import type { RegistryService } from '../services/registry-service';
import { memoryApplies } from '../../shared/chat-memory';
import { deriveSuggestionRules, applySuggestionRules, describeAppliedRules } from '../../shared/suggestion-rules';
import { runVerifyDriver, runSuggestionScreenshots, detectLiveContainers, type SuggestionShotTag } from './verify-driver';
import { runFormSubmitDriver, type FormSubmitFieldInput } from './form-submit-driver';
import { evaluateVerify, verdictsFromMonitor } from './verify-tags';
import { routeTagsToPages, normalizeVerifyPages, expandTagsOverPages } from './verify-routing';
import { runTaVerify, taProfileDirFor, type TaFormSubmit } from './ta-driver';
import { eventsForContainer, taEventsToMonitorEvents, toTaEventViews, buildTriggerSuggestions, pageScopeToPath } from './ta-stream';
import { toFormFillViews, localeOptions, classifyFiredContainerTags } from './form-fill-plan';
import { matchFormsToTags, dedupeSharedFields, isFormEventName, tagPageSeedUrls, type PagedForm, type FormTagIdentity } from './form-tag-match';
import { snapshotToVerifyInputs } from './container-verify';
import { localeById } from '../../../../web-audit-mcp/src/agent/form-fill.js';
import type { RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import { discoverSite } from './discover';
// The merged page-driver builder (Electron + optional Cheerio/Playwright) lives in scan-url.ts,
// shared with the `suggest_tags_from_url` chat tool so both scan paths render pages identically.
import { makeDriver, makeDrivers, scanConcurrency, clampSettle } from './scan-url';
import { parseSuggestions, createSuggestedTags, planGoogleTagVars, planAdsIdentity, provisionVariables } from './suggestion-service';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';

/** The persistent browser profile that keeps the Tag Assistant Google session across runs — keyed PER
 *  connected Google account, so switching the active Gmail uses that Gmail's own TA session. */
function taProfileDir(accountId?: string | null): string {
  return taProfileDirFor(app.getPath('userData'), accountId);
}

// Process-wide: the click-CTA element inventory captured by the verify SCAN step (formTagVerifyPlan crawls
// the site to find forms AND, in the SAME pass, inventories click CTAs). The Tag Assistant / verify run that
// follows within a few seconds reuses this instead of crawling again — so the site is scanned ONCE, not
// twice. Short TTL, keyed by target URL; a stale/absent entry just falls back to crawling.
const VERIFY_ELS_TTL_MS = 15 * 60_000; // long enough that reviewing/editing forms at the gate won't expire it
const verifyElsCache = new Map<string, { els: DetectedElementView[]; pagesCrawled: number; pagesTotal: number; ts: number }>();
const elsCacheKey = (url: string): string => url.trim().replace(/\/$/, '');
function cacheVerifyEls(url: string, els: DetectedElementView[], pagesCrawled: number, pagesTotal: number): void {
  verifyElsCache.set(elsCacheKey(url), { els, pagesCrawled, pagesTotal, ts: Date.now() });
}
function takeVerifyEls(url: string): { els: DetectedElementView[]; pagesCrawled: number; pagesTotal: number } | null {
  const hit = verifyElsCache.get(elsCacheKey(url));
  if (!hit || Date.now() - hit.ts > VERIFY_ELS_TTL_MS) return null;
  return { els: hit.els, pagesCrawled: hit.pagesCrawled, pagesTotal: hit.pagesTotal };
}

// Cooperative cancel for a verify run (the Stop button). The renderer runs one verify at a time, so a
// single module-level flag is enough: each verify-flow handler RESETS it when a fresh run starts, and the
// crawl / drive loops poll shouldStop() and bail out early with whatever they have.
let verifyCancelled = false;
const shouldStopVerify = (): boolean => verifyCancelled;

// The same cooperative cancel for a tag-suggestion SCAN (its own Stop button). Kept separate from the
// verify flag on purpose: the two run from different tabs, and stopping one must never halt the other.
let scanCancelled = false;
const shouldStopScan = (): boolean => scanCancelled;

export function registerSuggestionsIpc(data: GoogleDataService, memory?: MemoryStore, registry?: RegistryService): void {
  /**
   * Apply the saved notes for the ACTIVE account/container to a finished scan.
   *
   * Cross-feature leverage: a correction the user gave the chat ("we use order_completed, not
   * purchase") used to be honoured in conversation and nowhere else, so every scan proposed the old
   * name again. Only the unambiguous subset is read (see suggestion-rules), and every rule that fires
   * is appended to the scan's own warnings, because a silently reshaped scan is indistinguishable
   * from a broken one.
   *
   * Best-effort in every direction: no stores wired, no active account, or a read that throws all
   * leave the scan exactly as the engine produced it.
   */
  function honourSavedRules<T extends { suggestions: SuggestedTagView[]; warnings: string[] }>(result: T): T {
    try {
      if (!memory || !registry) return result;
      const active = registry.getActiveView();
      if (!active) return result;
      const ctx = { containerId: active.gtmContext?.containerId, property: active.ga4Context?.property };
      const notes = memory.list(active.id).filter((m) => memoryApplies(m, ctx));
      const rules = deriveSuggestionRules(notes);
      if (!rules.renames.length && !rules.suppress.length) return result;
      const applied = applySuggestionRules(result.suggestions ?? [], rules);
      if (!applied.renamed.length && !applied.dropped.length) return result;
      return { ...result, suggestions: applied.suggestions, warnings: [...(result.warnings ?? []), ...describeAppliedRules(applied)] };
    } catch (e) {
      console.error('[suggestions] saved-rule pass skipped:', e instanceof Error ? e.message : e);
      return result;
    }
  }

  // Stop the in-flight verify scan/drive. Sets the flag the crawl + Tag-Assistant drive loops poll; they
  // finish the current page and resolve with a partial result. The renderer also stops the orchestration.
  ipcMain.handle('suggestions:cancelVerify', () => { verifyCancelled = true; });
  // Stop a running scan. The crawl workers poll shouldStopScan() at their loop boundary and resolve
  // with the pages already read, so the user keeps the partial result instead of losing the run.
  ipcMain.handle('suggestions:cancelScan', () => { scanCancelled = true; });
  ipcMain.handle('suggestions:fromJson', (_e, json: unknown) => parseSuggestions(String(json ?? '')));

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

  // Save ONE verification proof screenshot (a JPEG/PNG data-URI captured during the run) to a file the
  // user picks. Read-only export - decodes the base64 data-URI and writes the bytes. Returns the saved
  // path, or null if the user cancelled or the value isn't a usable image data-URI.
  ipcMain.handle('suggestions:exportProofImage', async (e, defaultName: unknown, dataUrl: unknown) => {
    const m = String(dataUrl ?? '').match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return null;
    const ext = /^jpe?g$/i.test(m[1]) ? 'jpg' : m[1].toLowerCase();
    const win = BrowserWindow.fromWebContents(e.sender);
    const base = String(defaultName ?? 'proof')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(png|jpe?g|webp)$/i, '')
      .trim() || 'proof';
    const opts = { title: 'Save proof screenshot', defaultPath: `${base}.${ext}`, filters: [{ name: 'Image', extensions: [ext] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await writeFile(filePath, Buffer.from(m[2], 'base64'));
    return filePath;
  });

  // Copy ONE verification proof screenshot to the OS clipboard as an image (to paste into a doc / chat).
  // Read-only - decodes the data-URI to a nativeImage and writes it to the clipboard. Returns whether the
  // value was a usable image.
  ipcMain.handle('suggestions:copyProofImage', (_e, dataUrl: unknown) => {
    const src = String(dataUrl ?? '');
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)) return false;
    const img = nativeImage.createFromDataURL(src);
    if (img.isEmpty()) return false;
    clipboard.writeImage(img);
    return true;
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
      await writeFile(filePath, plainDashes(String(markdown ?? '')), 'utf8');
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
    // Parallel crawl: a pool of drivers scans pages concurrently (bounded by the page budget).
    const n = Math.min(scanConcurrency(o.scanConcurrency), o.maxPages ?? 25);
    const pool = await makeDrivers(n, o);
    return honourSavedRules(await crawlAndSuggest(pool[0], target, { maxPages: o.maxPages, maxDepth: o.maxDepth, platforms: o.platforms ?? ['ga4'], drivers: pool.slice(1) }));
  });

  // Locate-only PROOF screenshots for suggested (creatable) tags: open each page a tag lives on, ring
  // the element/form it would track, and return a JPEG data-URI per tag. Read-only — reuses the verify
  // driver's ring + capture but NEVER clicks/submits/injects a container (the tag doesn't exist yet).
  ipcMain.handle('suggestions:screenshotTags', async (e, url: unknown, tags: unknown): Promise<SuggestionScreenshotResult> => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    const list = (Array.isArray(tags) ? tags : []) as SuggestionShotTag[];
    if (list.length === 0) return { url: target, shots: [] };
    // Human label per tag for the live progress card (the shot list is a structural subset of the
    // full suggestion rows, which carry name/eventName).
    const labelOf = new Map(
      list.map((t) => {
        const raw = t as unknown as { name?: string; eventName?: string };
        return [t.id, String(raw.name ?? raw.eventName ?? t.id)] as const;
      }),
    );
    const { shots, error } = await runSuggestionScreenshots(target, list, {
      onProgress: (done, total, tagId, page) => {
        try {
          if (!e.sender.isDestroyed()) e.sender.send('suggestions:shotProgress', { done, total, label: labelOf.get(tagId) ?? tagId, page });
        } catch {
          /* window gone mid-capture — progress is a nicety */
        }
      },
    });
    return { url: target, shots, ...(error ? { error } : {}) };
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
    // Parallel deep-scan: never more drivers than selected pages.
    const pool = await makeDrivers(Math.min(scanConcurrency(o.scanConcurrency), list.length), o);
    let siteHost: string | undefined;
    try {
      siteHost = new URL(list[0]).hostname;
    } catch {
      /* per-URL admission still applies in scanUrls */
    }
    return honourSavedRules(await scanUrls(pool[0], list, siteHost, undefined, { platforms: o.platforms ?? ['ga4'], drivers: pool.slice(1) }));
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
  // PREFLIGHT (step 1-2 of the verify flow): headless-load the URL and report the GTM container(s) that
  // are actually live on it, so the renderer can compare against the SELECTED container and gate on a
  // missing/mismatch BEFORE driving Tag Assistant. Read-only: it loads the page and reads which containers
  // booted; it drives nothing and aborts every analytics collector. Streams step lines to the panel.
  ipcMain.handle('suggestions:preflightContainer', async (event, requestId: unknown, url: unknown): Promise<PreflightContainerResult> => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot check that URL: ${verdict.reason}`);
    verifyCancelled = false; // fresh preflight — clear any stale Stop
    const reqId = String(requestId ?? '');
    const step = (message: string): void => {
      try { if (reqId && !event.sender.isDestroyed()) event.sender.send('suggestions:preflight:event', { requestId: reqId, message }); } catch { /* window gone */ }
    };
    step('Loading the page to detect the live GTM container...');
    const res = await detectLiveContainers(target, { shouldStop: shouldStopVerify });
    step(
      res.error
        ? `Could not load the page: ${res.error}`
        : res.detected
          ? `Live on the page: ${res.liveContainers.join(', ')}`
          : 'No GTM container detected live on the page.',
    );
    return res;
  });

  ipcMain.handle(
    'suggestions:verifyTags',
    async (event, requestId: unknown, url: unknown, tags: unknown, elements: unknown, opts?: VerifyTagsOptions): Promise<VerifyTagsResult> => {
      const target = String(url ?? '').trim();
      const verdict = urlAllowed(target, []);
      if (!verdict.ok) throw new Error(`Cannot verify that URL: ${verdict.reason}`);
      const tagList = (Array.isArray(tags) ? tags : []) as VerifyTagInput[];
      let els = (Array.isArray(elements) ? elements : []) as DetectedElementView[];
      if (tagList.length === 0) return { url: target, injected: false, previewAuth: false, pagesOk: false, error: 'No tags selected to verify.', verdicts: [] };
      verifyCancelled = false; // fresh run — clear any stale Stop from a previous run
      const o = opts ?? {};
      // Live progress: stream what the run is doing (crawl → drive, or the monitor mint) so the panel
      // isn't a silent spinner through a 50-page crawl. Best-effort — a closed window never breaks verify.
      const reqId = String(requestId ?? '');
      const emit = (p: VerifyProgressView): void => {
        try { if (reqId && !event.sender.isDestroyed()) event.sender.send('suggestions:verify:event', { requestId: reqId, ...p }); } catch { /* window gone */ }
      };
      emit({ phase: 'prepare', message: 'Preparing verification…' });

      // MULTI-PAGE DRIVE: a container's Click triggers are site-wide, so without knowing which page
      // each CTA lives on the driver would drive them all on the homepage and falsely report
      // "no element matched" for anything on /careers, /blog, a service page, etc. When the caller
      // didn't supply a scan inventory, crawl the site to locate each CTA's page, then route each
      // click tag there. Best-effort — any crawl failure falls back to single-page driving.
      let pagesCrawled = 0;
      let pagesTotal = 0;
      // "Verify ONLY these pages": the user pasted an explicit page list. Normalized to same-origin absolute
      // URLs (off-site / unparseable dropped). When present, we skip the auto-crawl entirely and drive
      // every tag on each of these pages (below) — direct control over coverage for missed forms.
      const explicitPages = normalizeVerifyPages(o.verifyPages, target);
      const hasClickTags = tagList.some((t) => t.trigger.kind === 'link_click' || t.trigger.kind === 'all_clicks');
      // REUSE the scan step's crawl: the Forms scan (formTagVerifyPlan) that runs BEFORE the gate already
      // crawled this URL and cached its click-CTA inventory, so pull that here and skip a SECOND full crawl.
      // The one scan finds forms AND inventories click CTAs together.
      if (els.length === 0 && explicitPages.length === 0) {
        const cached = takeVerifyEls(target);
        if (cached && cached.els.length) {
          els = cached.els;
          pagesCrawled = cached.pagesCrawled;
          pagesTotal = cached.pagesTotal;
          emit({ phase: 'prepare', message: 'Reusing the page scan from the form step' });
        }
      }
      if (explicitPages.length === 0 && els.length === 0 && hasClickTags && o.crawlForPages !== false) {
        try {
          // SITEMAP-DRIVEN coverage: enumerate EVERY page the site lists (its sitemap, else a
          // rendered-link crawl) and scan them so a click CTA on ANY page is inventoried — not just the
          // homepage + its rendered links. discoverSite returns the pages already prioritized (home →
          // form-likely → content hub → the rest); crawlAndSuggest seeds them at top priority and scans
          // up to the budget. A tag whose CTA is on a page beyond the budget stays "untested here" —
          // surfaced via pagesCrawled / pagesTotal so the coverage is honest. No sitemap (an SPA/landing
          // page) → few URLs, so it falls back to the plain rendered-link BFS from the start URL.
          let seedUrls: string[] = [];
          try {
            const disc = await discoverSite(target);
            seedUrls = disc.urls.filter((u) => u !== target);
            pagesTotal = disc.urls.length;
          } catch { /* discovery best-effort — plain BFS below */ }
          // Scan every discovered page, capped by the budget (crawlAndSuggest clamps to 150). Default the
          // budget to the FULL discovered set (up to the 150 cap) so CTAs on deeper pages of a large site
          // are inventoried instead of stranded "untested here". With the prioritized page set seeded
          // (home → form-likely → content), the budget is spent on the pages most likely to carry CTAs.
          const maxPages = o.crawlMaxPages ?? (seedUrls.length ? Math.min(pagesTotal || seedUrls.length + 1, 150) : undefined);
          // cachePages: share rendered pages with the form-plan crawl that auto-runs on the same verify,
          // so each page renders ONCE across both crawls (not twice). The cache dedupes in-flight renders
          // by URL, so it stays correct with a PARALLEL driver pool.
          const crawlPool = await makeDrivers(Math.min(scanConcurrency(), maxPages ?? 25), { maxPages, maxDepth: o.crawlMaxDepth, cachePages: true });
          const crawlTotal = maxPages ?? 10; // honest total for the progress feed (the effective budget)
          const scan = await crawlAndSuggest(
            crawlPool[0],
            target,
            { maxPages, maxDepth: o.crawlMaxDepth, platforms: ['ga4'], drivers: crawlPool.slice(1), shouldStop: shouldStopVerify, ...(seedUrls.length ? { seedUrls } : {}) },
            (p) => emit({ phase: 'crawl', message: 'Scanning site pages to locate each tag’s trigger', ...(p.page ? { page: p.page } : {}), done: p.scanned, total: crawlTotal }),
          );
          els = scan.inventory.elements as DetectedElementView[];
          pagesCrawled = scan.pages.length;
          if (!pagesTotal) pagesTotal = pagesCrawled;
        } catch {
          /* crawl is best-effort — fall back to single-page driving */
        }
      }
      // Explicit-pages mode skips the crawl, but the Forms scan already cached a click-CTA inventory.
      // Reuse it (READ-only - it never changes which pages we drive) to spot GLOBAL header/footer CTAs so
      // each is driven ONCE instead of on every chosen page. No inventory → nothing is deduped (safe).
      if (explicitPages.length && els.length === 0) {
        const cached = takeVerifyEls(target);
        if (cached && cached.els.length) els = cached.els;
      }
      const routed = routeTagsToPages(tagList, els, target);
      // Default: each tag on its routed page. Explicit-pages mode: drive every tag on EACH chosen page so a
      // form/tag on a page the crawl missed is still exercised (the user's direct coverage control) - EXCEPT
      // a global site-wide click CTA (header/footer/nav or a repeated href), which is driven ONCE.
      const nameById = new Map(tagList.map((t) => [t.id, t.tagName] as const));
      const routedTags = explicitPages.length
        ? expandTagsOverPages(tagList, explicitPages, els)
        : routed.map((t) => ({ id: t.id, ...(nameById.get(t.id) ? { name: nameById.get(t.id)! } : {}), ...(t.page ? { page: t.page } : {}), trigger: t.trigger }));
      if (explicitPages.length) { pagesTotal = explicitPages.length; pagesCrawled = explicitPages.length; }

      // AUTHORITATIVE mode: automate the REAL Tag Assistant. ZERO GTM writes — no version, no workspace,
      // no extra container. TA connects to the live site; the debugged popup streams GTM's own per-event
      // per-tag firing; we drive the pages and read that stream. Needs a one-time Google sign-in (the
      // persistent TA browser profile keeps the session).
      if (o.monitor) {
        // Everything happens in ONE visible Tag Assistant window: it opens, does a one-time Google
        // sign-in if needed (login_hint = the active account's email), connects to the site, drives the
        // tags, and shows the real Tag Assistant panel while our stream capture runs. The profile is
        // keyed to the ACTIVE connected Google account, so switching the app's account uses that Gmail's
        // own container-owning session.
        const ident = data.activeAccountIdentity();
        const profileDir = taProfileDir(ident?.id);
        // REAL FORM SUBMITS use the operator-REVIEWED forms from the Forms panel (with any edited values).
        // The renderer runs a scan → gate → fill wizard FIRST (find forms-with-tags, ask skip/proceed, edit
        // the shared data), so this single run drives the click tags AND submits exactly what was reviewed.
        // Empty when the user skipped forms or the site had none → click-tag verification only.
        const taForms: TaFormSubmit[] = (Array.isArray(o.reviewedForms) ? o.reviewedForms : [])
          .map((f) => ({ page: String(f.page ?? ''), formId: String(f.formId ?? ''), formClasses: String(f.formClasses ?? ''), method: String(f.method ?? ''), fields: (f.fields ?? []).map((x) => ({ selector: String(x.selector ?? ''), type: String(x.type ?? ''), value: String(x.value ?? '') })) }))
          .filter((f) => f.page && f.fields.length);
        // Stop pressed during the crawl → don't even open Tag Assistant; return what we have.
        if (shouldStopVerify()) return { url: target, injected: false, previewAuth: false, pagesOk: false, verdicts: [] };
        emit({ phase: 'monitor', message: 'Opening Tag Assistant (your Chrome can stay open)...' });
        const publicId = await data.getContainerPublicId(o.monitor.accountId, o.monitor.containerId);
        const ta = await runTaVerify(profileDir, target, routedTags, publicId, {
          settleMs: clampSettle(o.settleMs),
          navTimeoutMs: o.navTimeoutMs,
          ...(ident?.email ? { loginHint: ident.email } : {}),
          // The GTM Preview snippet (gtm_auth/gtm_preview) makes the published GTM container enter Tag
          // Assistant debug — without it, connect only debugs Google tags. Reuses the existing snippet box.
          ...(o.containerSnippet ? { previewSnippet: o.containerSnippet } : {}),
          // PREFLIGHT PROCEED: inject the selected container into this session so TA sees it (the preflight
          // found it missing / a different container live). Ignored inside runTaVerify when a Preview
          // snippet is present (that path already targets the container).
          ...(o.injectContainerId ? { injectContainerId: o.injectContainerId } : {}),
          ...(taForms.length ? { forms: taForms } : {}),
          onSignInPrompt: () => emit({ phase: 'monitor', message: 'ONE-TIME Tag Assistant sign-in: complete it in the window that just opened (your email is pre-filled). It is saved after this, so verify never asks again.' }),
          onPageProgress: (page, done, total) => emit({ phase: 'drive', message: 'Driving tags in the Tag Assistant window', page, done, total }),
          onFormProgress: (page, done, total) => emit({ phase: 'drive', message: 'Submitting a form for real in Tag Assistant', page, done, total }),
          shouldStop: shouldStopVerify,
        });
        const base = { url: target, injected: false, previewAuth: false, pagesOk: ta.pagesOk, verifiedByMonitor: true as const, ...(ta.pagesDriven.length ? { pagesDriven: ta.pagesDriven } : {}), ...(pagesCrawled ? { pagesCrawled } : {}), ...(pagesTotal ? { pagesTotal } : {}), ...(ta.containersSeen?.length ? { containersSeen: ta.containersSeen } : {}), ...(ta.injectedContainer ? { injectedContainer: true } : {}) };
        if (ta.needSignIn || ta.error) return { ...base, verdicts: [], error: ta.error ?? 'Tag Assistant run failed.', ...(ta.needSignIn ? { needTaSignIn: true } : {}) };
        if (ta.debugProblem) return { ...base, verdicts: [], error: ta.debugProblem };
        const taEvents = eventsForContainer(ta.capture!, publicId);
        // HONESTY GUARD: TA connected but streamed no events for the container → the run proved nothing;
        // never report that as "0 tags fired".
        if (taEvents.length === 0) {
          return { ...base, verdicts: [], error: 'Tag Assistant connected but streamed no events for this container — the debug session may not have attached. Re-run; if it persists, sign in again via “Sign in for Tag Assistant”.' };
        }
        const monitorEvents = taEventsToMonitorEvents(taEvents, tagList.map((t) => ({ id: t.id, tagName: t.tagName })));
        const verdicts = verdictsFromMonitor(tagList, monitorEvents, ta.perTag, { scopedPages: explicitPages.length });
        // DIAGNOSTIC: per-event fired tags (after the not-fired exclusion) + each fired tag's event list.
        // Confirms attribution is correct (a click tag should show gtm.linkClick, not the synthetic
        // form_submission). Concise — one line per non-empty event + one per fired tag.
        for (const me of monitorEvents) {
          if (me.tags.length) console.log(`[ta-attr] event ${me.event}: ${me.tags.map((t) => t.name ?? t.id).join(', ')}`);
        }
        for (const v of verdicts.filter((x) => x.fired)) {
          console.log(`[ta-attr]   tag "${v.tagName}" -> shown event=${v.event ?? '?'} | all events=[${(v.monitorEvents ?? []).join(', ')}]`);
        }
        // Phase 3: the in-app detail views. taEventViews = the TA-style timeline (event → API Call push +
        // tags fired). taSuggestions = DLV-based triggers for tags that didn't fire, built from the tag's
        // expected custom_event name + the REAL pushes we captured.
        const allEventViews = toTaEventViews(taEvents);
        // Proof screenshots were captured DURING the drive; each records the panel's "Tags Fired" text, so
        // attach a capture to whichever FIRED tags it names. shotFor returns the capture whose panel listed
        // any of the given tag names. Fired verdicts get the capture that proves them (or the summary
        // fallback so every fired tag has SOME proof); timeline events get the capture overlapping their tags.
        const shotFor = (names: string[], mode: 'tag' | 'event' = 'tag'): string | undefined => {
          const caps = ta.captures ?? [];
          // Prefer a capture that is THIS tag's OWN Tag-Details view (exact tag match), so an event that
          // fired several tags (e.g. GA4 + Meta) doesn't cross-assign one tag's detail image to another.
          // Only for a TAG though: an event row must never be illustrated with one tag's detail page.
          const exact = mode === 'tag' ? caps.find((c) => c.tag && names.some((n) => n && c.tag === n)) : undefined;
          if (exact) return exact.screenshot;
          // Else an EVENT-PANEL capture whose Tags-Fired list named the tag. A capture that carries `tag` is
          // a picture of THAT tag's detail page, so it must never be served for a different tag - its
          // `fired` text is the whole event's tag list, which names many other tags and would hand them all
          // the same wrong tag's screenshot.
          return caps.find((c) => !c.tag && names.some((n) => n && c.fired.includes(n)))?.screenshot;
        };
        for (const v of allEventViews) {
          const s = shotFor(v.tagsFired.filter((t) => t.status === 'fired' || t.status === 'running').map((t) => t.name), 'event');
          if (s) v.screenshot = s;
        }
        for (const v of verdicts) {
          if (!v.fired) continue;
          const s = shotFor([v.tagName]) ?? ta.summaryShot;
          if (s) v.screenshot = s;
        }
        // Timeline UI: show meaningful events only — those that fired a tag, or carry a real (non-internal)
        // push. Hides the many empty gtm.init/gtm.dom/gtm.load ticks per page nav. (Suggestions still match
        // against the FULL set below so an expected event is never missed.)
        const taEventViews = allEventViews.filter(
          (e) => e.tagsFired.length > 0 ||
            (e.apiCall && Object.keys(e.apiCall).some((k) => k !== 'event' && k !== 'gtm.uniqueEventId' && !/^gtm\./i.test(k))),
        );
        const firedTagNames = new Set(verdicts.filter((v) => v.fired).map((v) => v.tagName));
        // RECLASSIFY submitted-but-unfired form tags: a form tag is "inconclusive/untested" by default
        // (form tags are never synthetically driven). But if its form was ACTUALLY submitted this run (it's
        // in a reviewed form's expectedTags) and it still didn't fire, that is NOT "untested" — it's a real
        // NOT-FIRING (its trigger's form name / id / page filter doesn't match what that form sent). Move it
        // out of Untested so the operator gets an actionable fix instead of a vague "we didn't test it".
        const reviewedForms = Array.isArray(o.reviewedForms) ? o.reviewedForms : [];
        const submittedFormTags = new Set(reviewedForms.flatMap((f) => (Array.isArray(f.expectedTags) ? f.expectedTags : [])));
        // The page each form tag's MATCHED form actually lives on (from the reviewed forms). Every form on
        // this site pushes the SAME form_name / form_type, so the tag's own trigger scope (usually site-wide)
        // can't tell them apart — the FORM's PAGE is the real discriminator. We use it both to explain a
        // not-firing form tag and to suggest a concrete {{Page Path}} trigger (vs a useless "add a field").
        const formPageByTag = new Map<string, string>();
        for (const f of reviewedForms) {
          const page = String((f as { page?: unknown }).page ?? '').trim();
          if (!page) continue;
          for (const tn of (Array.isArray(f.expectedTags) ? f.expectedTags : [])) {
            if (typeof tn === 'string' && !formPageByTag.has(tn)) formPageByTag.set(tn, page);
          }
        }
        for (const v of verdicts) {
          if (v.inconclusive && !v.fired && submittedFormTags.has(v.tagName) && !firedTagNames.has(v.tagName)) {
            v.inconclusive = false;
            const fp = formPageByTag.get(v.tagName);
            const path = fp ? pageScopeToPath(fp) ?? fp : '';
            v.reason = path
              ? `Its form on ${path} WAS submitted for real, but GTM didn’t fire this tag — its trigger condition doesn’t match what that form sent. Every form on this site pushes the SAME form_name / form_type, so scope this tag’s trigger by Page Path = “${path}” (the page is what makes it unique) — see the suggested trigger below.`
              : 'Its form WAS submitted for real in this run, but GTM did not fire this tag — so its trigger condition (the form name / id, or a page-path filter) does not match what that form actually sent. Open the tag’s trigger in GTM and compare it with the dataLayer above.';
          }
        }
        // Suggest DLV triggers only for tags that GENUINELY didn't fire — exclude "couldn't auto-test
        // here" (inconclusive) and server-relayed tags, which aren't real failures.
        const unfired = verdicts
          .filter((v) => !v.fired && !v.inconclusive && !v.serverRelay && !firedTagNames.has(v.tagName))
          .map((v) => {
            const tag = tagList.find((t) => t.tagName === v.tagName);
            const expectedEvent = tag && tag.trigger.kind === 'custom_event' ? tag.trigger.eventName : undefined;
            // Prefer the MATCHED FORM's page (the real discriminator) over the tag's own trigger scope (often
            // site-wide for a form tag), so the suggestion proposes a concrete {{Page Path}} = the form's page.
            const page = formPageByTag.get(v.tagName) ?? tag?.page;
            return { tagName: v.tagName, ...(expectedEvent ? { expectedEvent } : {}), ...(page ? { page } : {}) };
          });
        const taSuggestions = buildTriggerSuggestions(unfired, allEventViews);
        // Clean, human-readable verification RECORD (per fired tag + a final summary) - a report-style log
        // distinct from the low-level [ta-proof] / [ta-attr] diagnostics above, for reading and reports.
        {
          const firedVerdicts = verdicts.filter((v) => v.fired);
          let shots = 0;
          log.section(`Tag Verification - ${target}`);
          if (firedVerdicts.length === 0) log.info('No tags fired for this container on the verified page(s).');
          firedVerdicts.forEach((v, i) => {
            if (v.screenshot) shots += 1;
            log.success(`Tag Fired (#${i + 1})`,
              `Tag Name      : ${v.tagName}`,
              `Page URL      : ${target}`,
              `Event Name    : ${v.tagEventName ?? '(none)'}`,
              `Event Value   : ${v.event ?? v.tagEventName ?? '(none)'}`,
              `Trigger Name  : ${v.triggerName ?? '(none)'}`,
              `Screenshot    : ${v.screenshot ? 'captured' : 'not captured'}`,
              `Record        : saved`,
            );
          });
          log.success('Verification complete',
            `Total Tags Fired    : ${firedVerdicts.length}`,
            `Total Records Saved : ${firedVerdicts.length}`,
            `Total Screenshots   : ${shots}`,
          );
        }
        return { ...base, verdicts, ...(taEventViews.length ? { taEvents: taEventViews } : {}), ...(taSuggestions.length ? { taSuggestions } : {}) };
      }

      const driven = await runVerifyDriver(
        target,
        routedTags,
        {
          ...(o.containerSnippet ? { containerSnippet: o.containerSnippet } : {}),
          settleMs: clampSettle(o.settleMs),
          navTimeoutMs: o.navTimeoutMs,
          ...(o.gtmDebug ? { gtmDebug: true } : {}),
          onPageProgress: (page, done, total) => emit({ phase: 'drive', message: 'Verifying tags on the page', page, done, total }),
        },
      );
      const verdicts = evaluateVerify(tagList, driven.perTag, els);
      return { url: target, injected: driven.injected, previewAuth: driven.previewAuth, pagesOk: driven.pagesOk, ...(driven.error ? { error: driven.error } : {}), verdicts, ...(driven.pagesDriven ? { pagesDriven: driven.pagesDriven } : {}), ...(pagesCrawled ? { pagesCrawled } : {}), ...(pagesTotal ? { pagesTotal } : {}), ...(driven.networkLog ? { networkLog: driven.networkLog } : {}), ...(driven.dataLayer ? { dataLayer: driven.dataLayer } : {}), ...(driven.gtmDebug ? { gtmDebug: driven.gtmDebug } : {}) };
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
    const emailTag = ''; // plain test@gmail.com by default (simple test values); editable in the review
    const forms = toFormFillViews(rawForms, target, locale.id, emailTag);
    return { url: target, localeId: locale.id, locales: localeOptions(), forms, ...(error ? { error } : {}) };
  });

  // CONTAINER-TAG-DRIVEN plan: crawl the site for forms, keep only forms that HAVE a matching container
  // form tag, and collapse their fields into ONE de-duplicated data-entry set. READ-ONLY (reads the DOM
  // + the container snapshot; fills/submits nothing — the operator submits from the review step).
  ipcMain.handle('suggestions:formTagVerifyPlan', async (event, requestId: unknown, url: unknown, opts?: FormTagVerifyPlanOptions): Promise<FormTagVerifyPlanResult> => {
    const target = String(url ?? '').trim();
    const verdict = urlAllowed(target, []);
    if (!verdict.ok) throw new Error(`Cannot scan that URL: ${verdict.reason}`);
    verifyCancelled = false; // fresh forms scan — clear any stale Stop from a previous run
    const o = (opts ?? {}) as FormTagVerifyPlanOptions;
    // Live crawl progress (this scan can now cover the whole site), so the panel shows "Scanning X/Y" not a
    // silent spinner. Best-effort — a closed window never breaks the scan.
    const reqId = String(requestId ?? '');
    const emit = (p: { page?: string; done: number; total: number }): void => {
      try { if (reqId && !event.sender.isDestroyed()) event.sender.send('suggestions:formPlan:event', { requestId: reqId, phase: 'crawl', message: 'Scanning site pages for forms & CTAs', ...p }); } catch { /* window gone */ }
    };
    const locale = localeById(o.localeId);
    const emailTag = ''; // plain test@gmail.com by default (simple test values); editable in the review
    let error: string | undefined;
    const empty = (err: string): FormTagVerifyPlanResult => ({ url: target, localeId: locale.id, locales: localeOptions(), matched: [], sharedFields: [], unmatchedTags: [], pagesCrawled: 0, formTagCount: 0, pageScopedSeeds: 0, error: err });

    // 1. The container's FORM (custom-event) tags → identities.
    let tags: FormTagIdentity[] = [];
    try {
      if (o.accountId && o.containerId && o.workspaceId) {
        const snap = await data.getGtmContainerSnapshot(o.accountId, o.containerId, o.workspaceId);
        tags = snapshotToVerifyInputs(snap).tags
          // FORM tags only: a custom-event tag whose trigger event denotes a form submit. Excludes
          // scroll-depth / CTA-click custom-event tags, which otherwise get matched to a form and
          // wrongly reported as failing to fire on submit.
          .filter((t) => t.trigger.kind === 'custom_event' && isFormEventName(t.trigger.eventName ?? ''))
          .map((t) => {
            const cd = t.trigger.customEventData ?? {};
            // Use the tag's actual form-name / form-id CONDITION as its identity — NOT an arbitrary first
            // customEventData value. A pixel tag can carry non-form fields (value / currency / content_name)
            // or none; Object.values(cd)[0] would then hand every such tag the SAME junk token and pile them
            // all onto one form. With no form-name condition we omit it, so matching falls to the tag name
            // (whose service token pairs with the form's page path).
            const formName = cd.form_name ?? cd.formName ?? cd.form_id ?? cd.formId;
            // t.page is the tag's resolved Page-Path / URL trigger scope (snapshotToVerifyInputs computes
            // it). Feed it to matching so a page-scoped form tag pairs deterministically with that page's
            // form — the strongest signal for generic-named tags (was discarded here before).
            return { tagName: t.tagName, eventName: t.eventName, platform: t.platform, ...(formName ? { formName: String(formName) } : {}), ...(t.page ? { page: t.page } : {}) };
          });
      }
    } catch (e) {
      return empty(`Could not read the container: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}`);
    }
    if (tags.length === 0) {
      return empty(o.accountId ? 'This container has no form (custom-event) tags to verify. Create form-tracking tags first.' : 'Pick a GTM account, container and workspace (the GTM bar) so we know which form tags to verify.');
    }

    // 2. Crawl the site ONCE. This single pass BOTH collects the forms (per page, via the onPageForms
    //    callback) AND inventories the click CTAs — which we cache so the Tag Assistant / verify run that
    //    follows the gate reuses it instead of crawling again. That is what removes the double page scan:
    //    while finding the forms we already capture the click data. cachePages shares renders with any
    //    later crawl; the pool is closed by crawlAndSuggest.
    const pagedForms: PagedForm[] = [];
    let pagesCrawled = 0;
    // "Pages to verify": when the operator gave an explicit list, scan ONLY those pages — no sitemap
    // discovery, no BFS — so a single-page verify doesn't crawl the whole 226-page site. Kept in lockstep
    // with the scoped tag-verification run (same normalizeVerifyPages list).
    const explicitPages = normalizeVerifyPages(o.verifyPages, target);
    try {
      let seedUrls: string[] = [];
      let pagesTotal = 0;
      // The form tags themselves say WHERE their forms live: each tag's Page-Path / URL trigger scope
      // (t.page) is the landing page its form is on. Seed the crawl with those exact pages so a
      // content-download form on a deep page (that generic sitemap/BFS discovery never reaches) gets
      // FOUND and matched, instead of being reported "no matching form". No-op when a tag has no page
      // scope (e.g. it only conditions on form_id) - that stays an honest coverage gap.
      const tagPageSeeds = tagPageSeedUrls(tags, target);
      if (explicitPages.length === 0) {
        try {
          const disc = await discoverSite(target);
          seedUrls = disc.urls.filter((u) => u !== target);
          pagesTotal = disc.urls.length;
        } catch { /* discovery best-effort — crawlAndSuggest still BFS-crawls from the target */ }
        // Tag page scopes go FIRST (top-priority seeds) so the offer landing pages are visited even if
        // the budget can't cover the whole sitemap.
        seedUrls = [...new Set([...tagPageSeeds, ...seedUrls])];
        if (seedUrls.length + 1 > pagesTotal) pagesTotal = seedUrls.length + 1;
      }
      // Explicit list → scan exactly those (start = first page, the rest as top-priority seeds, budget =
      // list length so BFS-discovered links never get a slot). Else: sitemap present → whole site (up to the
      // 300 cap); none → a bounded BFS (60), header/nav/footer pages scanned first so none are stranded.
      const startUrl = explicitPages.length ? explicitPages[0] : target;
      const seeds = explicitPages.length ? explicitPages.slice(1) : seedUrls;
      // Budget must cover the seeds (tag pages + sitemap), so a sitemap smaller than the tag-page set
      // never caps the offer pages out. Bounded at 300.
      const maxPages = explicitPages.length
        ? explicitPages.length
        : o.maxPages ?? (seedUrls.length ? Math.min(Math.max(pagesTotal, seedUrls.length + 1), 300) : 60);
      const crawlTotal = maxPages;
      const pool = await makeDrivers(Math.min(scanConcurrency(), maxPages), { maxPages, cachePages: true });
      const scan = await crawlAndSuggest(
        pool[0],
        startUrl,
        { maxPages, platforms: ['ga4'], drivers: pool.slice(1), shouldStop: shouldStopVerify, ...(seeds.length ? { seedUrls: seeds } : {}) },
        (p) => emit({ ...(p.page ? { page: p.page } : {}), done: p.scanned, total: crawlTotal }),
        (page, raw) => { for (const v of toFormFillViews(raw, page, locale.id, emailTag)) pagedForms.push({ ...v, page }); },
      );
      pagesCrawled = scan.summary.pagesScanned;
      // Cache the click-CTA inventory (+ coverage counts) for the verify run that follows the gate.
      cacheVerifyEls(target, scan.inventory.elements as DetectedElementView[], pagesCrawled, pagesTotal || pagesCrawled);
    } catch (e) {
      error = `Crawl issue: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
    }

    // 3. Match forms ↔ tags, then collapse the matched forms' fields into ONE data-entry set.
    const { matched, unmatchedTags } = matchFormsToTags(pagedForms, tags);
    const sharedFields = dedupeSharedFields(matched);
    // Coverage transparency: how many form tags entered this flow, and how many carry a page scope we
    // could seed - so the UI can say "12 of 65 tags fire on form submits" instead of looking broken.
    const pageScopedSeeds = tagPageSeedUrls(tags, target).length;
    return { url: target, localeId: locale.id, locales: localeOptions(), matched, sharedFields, unmatchedTags, pagesCrawled, formTagCount: tags.length, pageScopedSeeds, ...(error ? { error } : {}) };
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
    // Pair what fired to the container's ACTUAL tags — GA4 by event name, PIXEL/AD (Meta/LinkedIn/
    // Pinterest/…) by the observed beacon vendor. Run when EITHER an event OR a beacon fired (a Meta
    // tag fires a beacon but no GA4 event). Best-effort — needs container context.
    if ((res.events.length > 0 || (res.beaconPlatforms ?? []).length > 0) && o.accountId && o.containerId && o.workspaceId) {
      try {
        const snap = await data.getGtmContainerSnapshot(o.accountId, o.containerId, o.workspaceId);
        const { tags } = snapshotToVerifyInputs(snap);
        const { firedTags, serverRelayTags } = classifyFiredContainerTags(res.events, res.beaconPlatforms ?? [], tags.map((t) => ({ tagName: t.tagName, eventName: t.eventName, platform: t.platform })));
        if (firedTags.length > 0 || serverRelayTags.length > 0) {
          return { ...res, ...(firedTags.length ? { firedTags } : {}), ...(serverRelayTags.length ? { serverRelayTags } : {}) };
        }
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
    const n = Math.min(scanConcurrency(o.scanConcurrency), o.maxPages ?? 25);
    scanCancelled = false; // fresh run - clear any stale Stop from a previous scan
    const pool = await makeDrivers(n, o);
    return honourSavedRules(await crawlAndSuggest(pool[0], target, { maxPages: o.maxPages, maxDepth: o.maxDepth, platforms: o.platforms ?? ['ga4'], drivers: pool.slice(1), shouldStop: shouldStopScan }, streamSink(event, String(requestId ?? ''))));
  });

  ipcMain.handle('suggestions:scanUrlsStream', async (event, requestId: unknown, urls: unknown, opts?: TagScanOptions) => {
    const list = Array.isArray(urls) ? urls.map((u) => String(u)).filter(Boolean) : [];
    if (list.length === 0) throw new Error('No pages selected to scan.');
    const o = opts ?? {};
    scanCancelled = false; // fresh run - clear any stale Stop from a previous scan
    const pool = await makeDrivers(Math.min(scanConcurrency(o.scanConcurrency), list.length), o);
    let siteHost: string | undefined;
    try {
      siteHost = new URL(list[0]).hostname;
    } catch {
      /* per-URL admission still applies */
    }
    return scanUrls(pool[0], list, siteHost, streamSink(event, String(requestId ?? '')), { platforms: o.platforms ?? ['ga4'], drivers: pool.slice(1), shouldStop: shouldStopScan });
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
      // Preflight the TARGET before writing anything. A workspace goes read-only the moment a version is
      // created from it, which this app does itself during "Auto: create preview & verify", so a target
      // chosen earlier in the session is routinely dead by now. Checked once, up front, so the user gets
      // one actionable message instead of the same failure repeated per tag after approving the batch.
      // The check is ADVISORY: it must never be able to fail the batch by itself. A transient
      // listGtmWorkspaces failure (expired auth, a network blip, a quota hiccup) would otherwise reject
      // every approved tag before a single write was attempted, which is strictly worse than the
      // "already submitted" error this preflight exists to pre-empt. On any error, fall through and let
      // the real writes report the real problem.
      let wsCheck: { writable: boolean; fallbackId: string | null; fallbackName: string | null } = {
        writable: true,
        fallbackId: null,
        fallbackName: null,
      };
      try {
        wsCheck = await data.workspaceWritable(acct, cont, ws);
      } catch (e) {
        console.error('[suggestions] workspace preflight skipped:', (e as Error).message);
      }
      if (!wsCheck.writable) {
        // Always name the successor by id as well as label. GTM replaces a submitted workspace with a
        // fresh one that usually carries the SAME name, so "switch to Default Workspace" while sitting on
        // a workspace called Default Workspace reads as nonsense without the id to tell them apart.
        const move = wsCheck.fallbackId
          ? ` Switch to "${wsCheck.fallbackName}" (id ${wsCheck.fallbackId}, GTM created it to replace this one) in the GTM bar and retry.`
          : ' Create a new workspace in the GTM bar and retry.';
        const msg = `That GTM workspace is read-only: a version was already created from it (a Submit in GTM, or this app's "Auto: create preview & verify").${move}`;
        // Hand the successor back so the UI can offer the switch as a button. The old workspace no
        // longer exists, so there is nothing to lose by moving; the user still confirms it.
        const switchTo = wsCheck.fallbackId ? { id: wsCheck.fallbackId, name: wsCheck.fallbackName ?? 'Workspace' } : undefined;
        return list.map((t) => ({ id: t.id, ok: false, error: msg, ...(switchTo ? { switchToWorkspace: switchTo } : {}) }));
      }

      const errors = new Map<string, string>();
      // Google Ads rows need a LITERAL Conversion ID (and Label): the engine seeds them with
      // {{Google Ads Conversion ID}} / {{...Label}} placeholders that nothing provisions, and GTM
      // happily stores the dangling reference, so the tag reports "created" and can never fire.
      // Blocked per-row, so one unfilled Ads row never holds up the rest of the batch.
      for (const [id, msg] of planAdsIdentity(list).errors) errors.set(id, msg);
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
        ) as { declined?: boolean; alreadyExists?: boolean; tag?: { name?: string; tagId?: string }; trigger?: { reused?: boolean } };
        if (out?.declined) return { id: name, ok: false, error: 'declined' };
        if (out?.alreadyExists) return { id: name, ok: false, existing: true, error: 'already exists' };
        return { id: name, ok: true, tagName: out?.tag?.name ?? name, ...(out?.tag?.tagId ? { tagId: String(out.tag.tagId) } : {}), triggerReused: out?.trigger?.reused === true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (DUPLICATE_RE.test(msg)) return { id: name, ok: false, existing: true, error: 'already exists' };
        return { id: name, ok: false, error: msg };
      }
    },
  );
}
