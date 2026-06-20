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
import { lookup as dnsLookup } from 'node:dns/promises';
import { collectPageInBrowser, type PageScanRaw } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import { extractFormsInPage, type RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
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

const isIpLiteral = (hostname: string): boolean => /^[\d.]+$/.test(hostname) || hostname.includes(':');

/** Reject a request unless its URL is allowed AND (for named hosts) every IP it
 *  resolves to is public. Fails closed on resolution error. */
async function requestAllowed(rawUrl: string): Promise<boolean> {
  // String check first: scheme, allowlist, and IP-LITERAL private ranges.
  if (!urlAllowed(rawUrl, []).ok) return false;
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  if (isIpLiteral(hostname)) return true; // already covered by urlAllowed above
  try {
    const addrs = await dnsLookup(hostname, { all: true });
    for (const { address, family } of addrs) {
      const probe = family === 6 ? `http://[${address}]` : `http://${address}`;
      if (!urlAllowed(probe, []).ok) return false; // resolves to a private IP → block
    }
    return addrs.length > 0;
  } catch {
    return false; // fail closed — never let an unresolvable/erroring host through
  }
}

export function createElectronDriver(opts: ElectronDriverOptions = {}): PageDriver {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const evalTimeoutMs = opts.evalTimeoutMs ?? 5_000;
  const settleMs = opts.settleMs ?? 2_500;
  // Ephemeral, in-memory session (no 'persist:' prefix) — cleared on close.
  const partition = `tagsuggest-scan-${process.pid}-${Date.now()}`;
  const ses = session.fromPartition(partition, { cache: false });
  // Block any request to a private/loopback/metadata host — even via redirect,
  // and even when a public-looking name resolves to a private IP.
  ses.webRequest.onBeforeRequest((details, cb) => {
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
