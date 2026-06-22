// An OPTIONAL Playwright scraping engine. Playwright is NOT a desktop dependency
// (it would bundle a second Chromium next to Electron's) — it is loaded lazily
// and only works if the user installs it (`npm i playwright && npx playwright
// install chromium` in apps/desktop). Useful for tricky sites and as the basis
// for future form-fill automation; for everyday scans the Electron engine (which
// reuses Electron's own Chromium) is the zero-install default.
//
// Runs the SAME in-page extractors as the other engines via page.evaluate, with
// the SSRF guard applied to every request (incl. redirects/subresources).

import { collectPageInBrowser, type PageScanRaw } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import { extractFormsInPage, type RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import { requestAllowed } from './ssrf';
import type { PageDriver, DrivenPage } from './scan-core';

// Minimal structural typings for the Playwright surface we use, so this file
// type-checks WITHOUT playwright (or its types) installed.
interface PwResponse {
  status(): number;
}
interface PwRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<PwResponse | null>;
  evaluate<T = unknown>(fn: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
}
interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> };
}

export class PlaywrightUnavailableError extends Error {
  constructor() {
    super('Playwright is not installed. Run `npm i playwright && npx playwright install chromium` in apps/desktop to use the Playwright engine (or use the Browser/Static engine).');
    this.name = 'PlaywrightUnavailableError';
  }
}

async function loadPlaywright(): Promise<Playwright | null> {
  try {
    // Non-literal specifier: playwright is optional, so the import must not be
    // statically resolved/bundled.
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

export interface PlaywrightDriverOptions {
  navTimeoutMs?: number;
  settleMs?: number;
}

export async function createPlaywrightDriver(opts: PlaywrightDriverOptions = {}): Promise<PageDriver> {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 2_500;
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  // SSRF: block any request (incl. redirects/subresources) to a private host.
  await context.route('**/*', (route) => {
    void requestAllowed(route.request().url()).then(
      (ok) => (ok ? route.continue() : route.abort()),
      () => route.abort(),
    );
  });
  const page = await context.newPage();

  return {
    async open(url: string): Promise<DrivenPage> {
      try {
        // networkidle waits for lazy/JS-rendered forms + embeds to finish loading.
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs });
        const status = resp ? resp.status() : null;
        if (status !== null && status >= 400) return { ok: true, httpStatus: status, finalUrl: page.url() || url };
        await page.waitForTimeout(settleMs);
        const raw = await page.evaluate<PageScanRaw>(collectPageInBrowser);
        const rawForms = await page.evaluate<RawForm[]>(extractFormsInPage);
        return { ok: true, httpStatus: status, finalUrl: page.url() || url, raw, rawForms: Array.isArray(rawForms) ? rawForms : [] };
      } catch (e) {
        return { ok: false, httpStatus: null, finalUrl: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async close(): Promise<void> {
      try {
        await browser.close();
      } catch {
        /* best-effort */
      }
    },
  };
}
