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
  /** Post-load settle so JS-rendered forms/embeds (HubSpot, etc.) appear. */
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

export function createElectronDriver(opts: ElectronDriverOptions = {}): PageDriver {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const evalTimeoutMs = opts.evalTimeoutMs ?? 5_000;
  const settleMs = opts.settleMs ?? 2_500;
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
  // Block private/loopback/metadata hosts (incl. via redirect / DNS-rebind) and
  // the analytics noise above.
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (NOISE_RE.test(details.url)) {
      cb({ cancel: true });
      return;
    }
    void requestAllowed(details.url).then(
      (ok) => cb({ cancel: !ok }),
      () => cb({ cancel: true }),
    );
  });

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

      await delay(settleMs);
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
