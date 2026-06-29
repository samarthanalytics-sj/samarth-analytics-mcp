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
function autoScrollPage(): Promise<void> {
  return new Promise<void>((resolve) => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.85));
    const maxY = Math.min(document.documentElement.scrollHeight, 40000);
    let y = 0;
    const tick = (): void => {
      window.scrollTo(0, y);
      y += step;
      if (y <= maxY) {
        setTimeout(tick, 120);
      } else {
        window.scrollTo(0, 0);
        setTimeout(resolve, 200);
      }
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
        return { ok: false, httpStatus: lastStatus, finalUrl: null, error: errMsg(e) };
      }

      // HTTP error pages: report the status, skip the (pointless) DOM read.
      if (lastStatus !== null && lastStatus >= 400) {
        return { ok: true, httpStatus: lastStatus, finalUrl: wc.getURL() || url };
      }

      if (autoSettle) await waitNetworkIdle(600, 700, Math.min(navTimeoutMs, 9_000));
      else await delay(fixedSettleMs);
      if (!win || win.isDestroyed()) return { ok: false, httpStatus: lastStatus, finalUrl: null, error: 'driver closed' };
      // Scroll top→bottom so scroll-mounted below-fold content (contact/newsletter forms, FAQ)
      // renders, then briefly re-settle for any lazy fetch/animation. Best-effort — if it times
      // out we read whatever rendered (above-fold content is already there).
      try {
        await withTimeout(wc.executeJavaScript(inPage(autoScrollPage), true), 8_000, 'scroll');
        if (autoSettle) await waitNetworkIdle(0, 500, 4_000);
        else await delay(Math.min(fixedSettleMs, 800));
      } catch {
        /* scrolling failed/timed out — proceed with whatever rendered */
      }
      if (!win || win.isDestroyed()) return { ok: false, httpStatus: lastStatus, finalUrl: null, error: 'driver closed' };
      try {
        const raw = (await withTimeout(
          wc.executeJavaScript(inPage(collectPageInBrowser), true),
          evalTimeoutMs,
          'element scan',
        )) as PageScanRaw;
        const rawForms = (await withTimeout(
          wc.executeJavaScript(inPage(extractFormsInPage), true),
          evalTimeoutMs,
          'form scan',
        )) as RawForm[];
        return {
          ok: true,
          httpStatus: lastStatus,
          finalUrl: wc.getURL() || url,
          raw,
          rawForms: Array.isArray(rawForms) ? rawForms : [],
        };
      } catch (e) {
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
