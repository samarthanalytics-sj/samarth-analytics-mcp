// The real PageDriver: drives a hidden Electron BrowserWindow (Electron already
// IS Chromium — no Playwright dependency) to load a page and READ its DOM. It
// only ever navigates + runs read-only DOM extractors (collectPageInBrowser,
// extractFormsInPage) — it never clicks, fills, or submits anything.
//
// SSRF: mirrors (and hardens) the web-audit guard. The start URL is admitted by
// the IPC layer; here every request the page makes (incl. redirects + sub-
// resources) is blocked if it targets a private/loopback/metadata host, via a
// dedicated, ephemeral, cookie-isolated session. Beyond the hostname-STRING
// check, we also RESOLVE named hosts and block when the resolved IP is private —
// closing the common DNS-rebind / internal-name vector that a string check
// misses (e.g. a public-looking host whose A record points at 127.0.0.1).
//
// NOTE: we deliberately do NOT impose a restrictive CSP on the scan page — the
// whole point is to let the page's own scripts run so JS-rendered forms/embeds
// (HubSpot, Typeform, …) appear for detection. Page→app isolation is provided by
// sandbox + contextIsolation + nodeIntegration:false + no preload, not CSP.

import { BrowserWindow, session } from 'electron';
import { collectPageInBrowser, type PageScanRaw } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import { extractFormsInPage, type RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import { requestAllowed } from './ssrf';
import type { PageDriver, DrivenPage } from './scan-core';
import type { ScanDebug, ScanDebugPage } from '../../shared/ipc';

export interface ElectronDriverOptions {
  navTimeoutMs?: number;
  /** Hard cap on each in-page DOM read, so a page that wedges its main thread
   *  cannot hang the crawl. */
  evalTimeoutMs?: number;
  /** Post-load settle so JS-rendered forms/embeds (HubSpot, etc.) appear.
   *  undefined = AUTO: wait until the page's network goes quiet (adaptive),
   *  instead of a fixed wait. A number forces that exact fixed wait. */
  settleMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// Race a promise against a timeout; runs onTimeout (e.g. stop the load) on expiry.
async function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Serialize a self-contained in-page function for webContents.executeJavaScript
// (Electron's equivalent of Playwright's page.evaluate). The functions reference
// only DOM globals, so `(fn)()` runs standalone in the page's main world.
function inPage(fn: () => unknown): string {
  return `(${fn.toString()})()`;
}

// Scroll the page top→bottom in steps so below-the-fold sections that only MOUNT on scroll
// (IntersectionObserver / "animate-in-view" — very common for contact/newsletter forms + FAQ on
// React/marketing landing pages) actually render before we read the DOM, then return to the top.
// Self-contained for executeJavaScript serialization (DOM globals only); resolves when done.
// Diagnostic probe: count the form-relevant DOM the scan can see, so a "0 forms" result is
// localizable — inputs=0 means the form fields aren't standard <input>/<textarea> (custom widgets)
// or didn't render; inputs>0 with rawForms=0 means the extractor structure-missed them.
function probeFormsDom(): { forms: number; inputs: number; textareas: number; selects: number; submitish: number } {
  const n = (sel: string): number => document.querySelectorAll(sel).length;
  let submitish = 0;
  for (const b of Array.from(document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]'))) {
    const t = ((b.textContent || '') + ' ' + ((b as HTMLInputElement).value || '')).toLowerCase();
    if (/\b(submit|send|subscribe|sign\s*up|get\s+started|register|join|contact|book|request|message|get\s+in\s+touch)\b/.test(t)) submitish += 1;
  }
  return { forms: n('form'), inputs: n('input'), textareas: n('textarea'), selects: n('select'), submitish };
}

// Scroll top→bottom and UNION the forms found at EVERY scroll position (plus a final read back at the
// top). Reads window.__sxForms — the injected extractFormsInPage. Two lazy-mount failure modes both
// evade a single end-of-scroll read, and this beats both:
//   1) RE-MEASURE the height each step: a lazy page GROWS its scrollHeight as IntersectionObserver
//      sections mount, so a height captured ONCE stops short of the true bottom and never reveals the
//      footer forms. Re-reading follows the growing page to its real bottom.
//   2) GRAB AT EACH POSITION: some sections UNMOUNT once scrolled out of view, so a form only exists in
//      the DOM while it is near the viewport. Reading only at the end would miss it; unioning per-step
//      reads captures each form while it is mounted, regardless of when it mounts/unmounts.
// Capped at 40000px so an infinite-scroll page still terminates. Self-contained for serialization.
function scrollAndCollectForms(): Promise<RawForm[]> {
  return new Promise<RawForm[]>((resolve) => {
    const collected = new Map<string, RawForm>();
    const keyOf = (f: RawForm): string =>
      `${f.action || ''}|${f.method || ''}|${(f.fields || []).map((x) => x.name || x.id || x.type).join(',')}`.toLowerCase();
    const grab = (): void => {
      try {
        const ex = (window as unknown as { __sxForms?: () => RawForm[] }).__sxForms;
        const forms = typeof ex === 'function' ? ex() : [];
        for (const f of forms) {
          const k = keyOf(f);
          if (!collected.has(k)) collected.set(k, f);
        }
      } catch {
        /* a mid-scroll extractor error on one frame must not abort the whole pass */
      }
    };
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    let y = 0;
    const tick = (): void => {
      window.scrollTo(0, y);
      // Dwell BEFORE grabbing so the IntersectionObserver + render for the just-revealed section fires.
      setTimeout(() => {
        grab();
        y += step;
        const maxY = Math.min(document.documentElement.scrollHeight, 40000);
        if (y <= maxY) {
          tick();
        } else {
          window.scrollTo(0, 0);
          setTimeout(() => {
            grab();
            resolve([...collected.values()].map((f, i) => ({ ...f, index: i })));
          }, 400);
        }
      }, 150);
    };
    tick();
  });
}

export function createElectronDriver(opts: ElectronDriverOptions = {}): PageDriver {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const evalTimeoutMs = opts.evalTimeoutMs ?? 5_000;
  // undefined → AUTO (network-idle); a number → that fixed wait.
  const autoSettle = opts.settleMs === undefined;
  const fixedSettleMs = opts.settleMs ?? 0;
  // Ephemeral, in-memory session (no 'persist:' prefix) — cleared on close.
  const partition = `tagsuggest-scan-${process.pid}-${Date.now()}`;
  const ses = session.fromPartition(partition, { cache: false });
  // Analytics / ad / service-worker noise we don't need for DOM scanning —
  // blocking it cuts the console spam (e.g. a server-side-GTM sw_iframe retry
  // storm) and speeds the crawl. NOTE: form-provider CDNs (HubSpot, Typeform,
  // Marketo, Pardot, Mailchimp) are deliberately NOT blocked — their scripts
  // render the very forms we want to detect.
  const NOISE_RE =
    /(?:\/sw_iframe|\/service_worker\/)|googletagmanager\.com|google-analytics\.com|analytics\.google\.com|\.doubleclick\.net|googleadservices\.com|connect\.facebook\.net|facebook\.com\/tr|\.hotjar\.com|\.clarity\.ms|static\.ads-twitter\.com|snap\.licdn\.com|analytics\.tiktok\.com/i;
  // Track in-flight requests so AUTO settle can wait for the network to go quiet.
  let inFlight = 0;
  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };
  // Block private/loopback/metadata hosts (incl. via redirect / DNS-rebind) and
  // the analytics noise above.
  ses.webRequest.onBeforeRequest((details, cb) => {
    inFlight += 1;
    touch();
    if (NOISE_RE.test(details.url)) {
      cb({ cancel: true });
      return;
    }
    void requestAllowed(details.url).then(
      (ok) => cb({ cancel: !ok }),
      () => cb({ cancel: true }),
    );
  });
  ses.webRequest.onCompleted(() => {
    inFlight = Math.max(0, inFlight - 1);
    touch();
  });
  ses.webRequest.onErrorOccurred(() => {
    inFlight = Math.max(0, inFlight - 1);
    touch();
  });

  // AUTO settle: resolve once no request has been in flight for `quietMs`, with a
  // floor (let initial JS kick off) and a hard cap (never hang a slow/polling page).
  async function waitNetworkIdle(minMs: number, quietMs: number, maxMs: number): Promise<void> {
    const start = Date.now();
    await delay(minMs);
    for (;;) {
      if (Date.now() - start >= maxMs) return;
      if (inFlight <= 0 && Date.now() - lastActivity >= quietMs) return;
      await delay(150);
    }
  }

  let win: BrowserWindow | null = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  // Never let a scanned page spawn windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let lastStatus: number | null = null;
  win.webContents.on('did-navigate', (_e, _url, httpResponseCode) => {
    lastStatus = typeof httpResponseCode === 'number' ? httpResponseCode : null;
  });

  // ── Debug diagnostics (surfaced via diagnostics() for the UI "Show debug" toggle) ──
  const diagPages: ScanDebugPage[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  // The console-message / did-fail-load signatures vary across Electron versions;
  // register through a permissive cast and parse defensively.
  const onWc = win.webContents.on.bind(win.webContents) as unknown as (ev: string, cb: (...a: unknown[]) => void) => void;
  onWc('console-message', (...args: unknown[]) => {
    const a1 = args[1];
    let level: string | number = 0;
    let message = '';
    if (a1 && typeof a1 === 'object') {
      const d = a1 as { level?: string | number; message?: string };
      level = d.level ?? 0;
      message = String(d.message ?? '');
    } else {
      level = typeof a1 === 'number' ? a1 : 0;
      message = String(args[2] ?? '');
    }
    const isErr = level === 'error' || level === 'warning' || (typeof level === 'number' && level >= 2);
    if (isErr && message && consoleErrors.length < 100) consoleErrors.push(message.slice(0, 300));
  });
  onWc('did-fail-load', (...args: unknown[]) => {
    // (event, errorCode, errorDescription, validatedURL, isMainFrame)
    const code = Number(args[1]);
    const isMainFrame = args[4] === true;
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED (noise: cancelled sub-resources)
    if (pageErrors.length < 50) pageErrors.push(`did-fail-load: ${String(args[2] ?? '')} (${String(args[3] ?? '')})`.slice(0, 300));
  });
  onWc('render-process-gone', (...args: unknown[]) => {
    const d = args[1] as { reason?: string } | undefined;
    if (pageErrors.length < 50) pageErrors.push(`render-process-gone: ${d?.reason ?? 'unknown'}`);
  });

  return {
    async open(url: string): Promise<DrivenPage> {
      if (!win || win.isDestroyed()) return { ok: false, httpStatus: null, finalUrl: null, error: 'driver closed' };
      lastStatus = null;
      const wc = win.webContents;
      try {
        await withTimeout(wc.loadURL(url), navTimeoutMs, 'navigation', () => {
          try {
            wc.stop();
          } catch {
            /* ignore */
          }
        });
      } catch (e) {
        diagPages.push({ url, httpStatus: lastStatus, error: errMsg(e) });
        return { ok: false, httpStatus: lastStatus, finalUrl: null, error: errMsg(e) };
      }

      // HTTP error pages: report the status, skip the (pointless) DOM read.
      if (lastStatus !== null && lastStatus >= 400) {
        diagPages.push({ url: wc.getURL() || url, httpStatus: lastStatus, error: `http ${lastStatus}` });
        return { ok: true, httpStatus: lastStatus, finalUrl: wc.getURL() || url };
      }

      if (autoSettle) await waitNetworkIdle(600, 700, Math.min(navTimeoutMs, 9_000));
      else await delay(fixedSettleMs);
      if (!win || win.isDestroyed()) return { ok: false, httpStatus: lastStatus, finalUrl: null, error: 'driver closed' };
      // Scroll top→bottom so scroll-mounted below-fold content (contact/newsletter forms, FAQ)
      // renders — collecting forms at every scroll position and unioning them (handles lazy sections
      // that mount late OR unmount when scrolled away), then briefly re-settle. Best-effort — if it
      // times out, `scrolledForms` stays null and the always-union final read below still recovers
      // whatever is mounted at the settled position.
      let scrolledForms: RawForm[] | null = null;
      try {
        // Inject extractFormsInPage as a page global so the scroll pass can read forms per position.
        // (Same serialization inPage() already relies on, so it is safe in the built app.)
        await wc.executeJavaScript(`window.__sxForms = ${extractFormsInPage.toString()};`, true);
        scrolledForms = (await withTimeout(
          wc.executeJavaScript(inPage(scrollAndCollectForms), true),
          15_000,
          'scroll+forms',
        )) as RawForm[];
        if (autoSettle) await waitNetworkIdle(0, 500, 4_000);
        else await delay(Math.min(fixedSettleMs, 800));
      } catch {
        /* scroll/collect failed or timed out — the form read below does a single fallback pass */
      }
      if (!win || win.isDestroyed()) return { ok: false, httpStatus: lastStatus, finalUrl: null, error: 'driver closed' };
      try {
        const raw = (await withTimeout(
          wc.executeJavaScript(inPage(collectPageInBrowser), true),
          evalTimeoutMs,
          'element scan',
        )) as PageScanRaw;
        // ALWAYS do one final full read at the settled position and UNION it with the scroll-pass union
        // (treat null as []). The per-position scroll grabs can miss a form on a busy frame — producing a
        // NON-NULL but partial union — and the old ternary then skipped the single-read fallback (it only
        // ran when scrolledForms === null), so a genuinely-mounted form was lost with no recovery. Unioning
        // a final full read makes it a superset guarantee. Best-effort: the final read degrades to [] on
        // timeout/error so a wedged frame never aborts the scan.
        const finalForms = (await withTimeout(
          wc.executeJavaScript(inPage(extractFormsInPage), true),
          evalTimeoutMs,
          'form scan',
        ).catch(() => [])) as RawForm[];
        // Union deduped by the SAME form-key the multi-driver uses, then reindexed so the merged list is
        // contiguous.
        const formKey = (f: RawForm): string =>
          `${f.action || ''}|${f.method || ''}|${(f.fields || []).map((x) => x.name || x.id || x.type).join(',')}`.toLowerCase();
        const byForm = new Map<string, RawForm>();
        for (const f of [...(Array.isArray(scrolledForms) ? scrolledForms : []), ...(Array.isArray(finalForms) ? finalForms : [])]) {
          const k = formKey(f);
          if (!byForm.has(k)) byForm.set(k, f);
        }
        const rawForms: RawForm[] = [...byForm.values()].map((f, i) => ({ ...f, index: i }));
        const extracted = Array.isArray(rawForms) ? rawForms.length : 0;
        let probe: { forms: number; inputs: number; textareas: number; selects: number; submitish: number } | undefined;
        try {
          probe = (await withTimeout(wc.executeJavaScript(inPage(probeFormsDom), true), 2_000, 'form probe')) as {
            forms: number;
            inputs: number;
            textareas: number;
            selects: number;
            submitish: number;
          };
          console.error(
            `[form-probe] ${wc.getURL() || url}: <form>=${probe.forms} input=${probe.inputs} textarea=${probe.textareas} select=${probe.selects} submitish=${probe.submitish} → extracted ${extracted} form(s)`,
          );
        } catch {
          /* probe is best-effort diagnostics */
        }
        diagPages.push({
          url: wc.getURL() || url,
          httpStatus: lastStatus,
          ...(probe ? { probe: { ...probe, extracted } } : {}),
        });
        return {
          ok: true,
          httpStatus: lastStatus,
          finalUrl: wc.getURL() || url,
          raw,
          rawForms: Array.isArray(rawForms) ? rawForms : [],
        };
      } catch (e) {
        diagPages.push({ url: wc.getURL() || url, httpStatus: lastStatus, error: errMsg(e) });
        return { ok: false, httpStatus: lastStatus, finalUrl: wc.getURL() || null, error: errMsg(e) };
      }
    },

    // Capture a PNG of the CURRENTLY loaded page (call right after open()). Best
    // effort full-page: grow the hidden window to the content height (capped) then
    // capturePage; falls back to the viewport. Returns null if capture fails.
    async screenshot(): Promise<Buffer | null> {
      if (!win || win.isDestroyed()) return null;
      const wc = win.webContents;
      const [w] = win.getSize();
      let grew = false;
      try {
        let height = 900;
        try {
          const h = Number(await wc.executeJavaScript('document.documentElement.scrollHeight'));
          if (Number.isFinite(h) && h > 900) height = Math.min(Math.round(h), 3000);
        } catch {
          /* keep the viewport height */
        }
        if (height > 900) {
          win.setSize(w, height);
          grew = true;
          await delay(350);
        }
        const img = await wc.capturePage();
        const png = img.toPNG();
        return png.length ? png : null;
      } catch {
        return null;
      } finally {
        if (grew && win && !win.isDestroyed()) {
          try {
            win.setSize(w, 900);
          } catch {
            /* ignore */
          }
        }
      }
    },

    // Retained buffers — safe to read after close() for the debug toggle.
    diagnostics(): ScanDebug {
      return {
        driver: 'electron',
        settleMode: autoSettle ? 'auto' : `${fixedSettleMs}ms`,
        pages: diagPages.slice(0, 100),
        consoleErrors,
        pageErrors,
      };
    },

    async close(): Promise<void> {
      try {
        if (win && !win.isDestroyed()) win.destroy();
      } finally {
        win = null;
      }
      try {
        await ses.clearStorageData();
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}
