/**
 * Capture layer — loads a page in headless Chromium, drives the two-phase
 * consent flow + journey steps, and records what actually fired. It produces a
 * plain-data CaptureResult and knows NOTHING about check verdicts.
 *
 * Reuses web-audit-mcp's Playwright plumbing (loadPlaywright, DATALAYER_HOOK,
 * classifyUrl via trackers.ts, urlAllowed) but adds its own request listener —
 * openInstrumentedPage does not read request.postData(), which the spec requires
 * for batched GA4 POSTs — plus a response-based settle window (no fixed sleep).
 *
 * Offline fixtures are served via context.route fulfillment against a synthetic
 * public host, so no loopback server is needed and the SSRF guard is untouched.
 */

import {
  loadPlaywright,
  PlaywrightMissingError,
  DATALAYER_HOOK,
  type Playwright,
  type PwBrowser,
  type PwPage,
  type PwContext,
} from '../../agent/browser.js';
import { extractConsentEvents, extractEventNames } from '../../agent/capture.js';
import { urlAllowed } from '../../utils/urlGuard.js';
import { parseCollectRequest, isGa4CollectRequest } from '../ga4-hits.js';
import { toTrackerObservation, isTrackerRequest, hasGlParam } from '../trackers.js';
import type { CaptureResult, VerifySpec, Ga4Hit, TrackerObservation, ActionResult, ConsentActionFacts } from '../types.js';
import { waitForSettle, realClock, type SettleOptions, type SettleClock } from './settle.js';
import { clickConsent, clickSelector, submitForm, navigateTo } from './journey.js';

const MAX_HITS = 1000;
const MAX_ERRORS = 100;

// ── Extended Playwright surface (real objects carry these at runtime) ─────────

interface PwRequestEx {
  url(): string;
  method(): string;
  resourceType(): string;
  postData(): string | null;
}
interface PwRouteEx {
  request(): PwRequestEx;
  continue(): Promise<void>;
  abort(): Promise<void>;
  fulfill(opts: { status?: number; contentType?: string; body?: string; headers?: Record<string, string> }): Promise<void>;
}
interface PwContextRouteEx {
  route(pattern: string, handler: (route: PwRouteEx) => unknown): Promise<void>;
}
interface PwPageOnEx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (arg: any) => void): void;
}

export interface FixtureResponse {
  status?: number;
  contentType?: string;
  body?: string;
}
export interface FixtureProvider {
  /** Return a canned response for a URL, or null to let the default (204) apply. */
  resolve(url: string): FixtureResponse | null;
}

export interface VerifyCaptureOptions {
  headless: boolean;
  navTimeoutMs: number;
  settle: SettleOptions;
  allowlist: string[];
  /** Test-only offline fixtures — serves every request in-memory, no network. */
  fixtures?: FixtureProvider | null;
  /** Injectable clock for the settle window (defaults to the real clock). */
  clock?: SettleClock;
}

interface CaptureState {
  ga4Hits: Ga4Hit[];
  trackers: TrackerObservation[];
  linkerRequests: { url: string; tMs: number }[];
  navStart: number;
  consoleErrors: string[];
  pageErrors: string[];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(url: string, domains: Set<string>): boolean {
  const host = hostOf(url);
  if (!host) return false;
  for (const d of domains) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

function collectLinkerDomains(spec: VerifySpec): Set<string> {
  const out = new Set<string>();
  for (const check of spec.checks) {
    if (check.type === 'cross_domain_linker') {
      for (const d of check.expectedDomains ?? []) out.add(d.trim().toLowerCase());
    }
  }
  return out;
}

/** Read the hooked dataLayer log (in-page). */
function readDlLogInPage(): { t?: number; entry?: unknown }[] {
  const w = window as unknown as { __wa_dl_log?: { t?: number; entry?: unknown }[] };
  return Array.isArray(w.__wa_dl_log) ? w.__wa_dl_log : [];
}

/** Detect a tag manager / dataLayer in-page. */
function detectGtmInPage(): boolean {
  const w = window as unknown as { google_tag_manager?: unknown; dataLayer?: unknown };
  return Boolean(w.google_tag_manager) || Array.isArray(w.dataLayer);
}

/** Run the capture against an already-launched browser. */
export async function runCapture(
  browser: PwBrowser,
  spec: VerifySpec,
  opts: VerifyCaptureOptions,
): Promise<CaptureResult> {
  const clock = opts.clock ?? realClock();
  const notes: string[] = [];
  const linkerDomains = collectLinkerDomains(spec);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const state: CaptureState = {
    ga4Hits: [],
    trackers: [],
    linkerRequests: [],
    navStart: Date.now(),
    consoleErrors: [],
    pageErrors: [],
  };

  try {
    await (context as unknown as PwContextRouteEx).route('**/*', (route: PwRouteEx) => {
      const req = route.request();
      const url = req.url();
      if (opts.fixtures) {
        const f = opts.fixtures.resolve(url);
        if (f) {
          return route.fulfill({
            status: f.status ?? 200,
            contentType: f.contentType ?? 'text/html; charset=utf-8',
            body: f.body ?? '',
          });
        }
        // Fixture mode: 204 everything else (tracker beacons, favicons) → fully offline.
        return route.fulfill({ status: 204, contentType: 'text/plain', body: '' });
      }
      // Production: SSRF guard on every request (private ranges always blocked).
      const verdict = urlAllowed(url, []);
      if (!verdict.ok) return route.abort();
      // Abort top-level navigations to a cross-domain-linker target so the probe
      // can read the decorated URL without actually leaving the page.
      if (req.resourceType() === 'document' && linkerDomains.size > 0 && hostMatches(url, linkerDomains)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();
    await page.addInitScript({ content: DATALAYER_HOOK });

    const pageOn = page as unknown as PwPageOnEx;
    pageOn.on('request', (req: PwRequestEx) => {
      const url = req.url();
      const tMs = Date.now() - state.navStart;
      if (isGa4CollectRequest(url)) {
        let postData: string | null = null;
        try {
          postData = typeof req.postData === 'function' ? req.postData() : null;
        } catch {
          postData = null;
        }
        for (const hit of parseCollectRequest({ url, method: req.method(), postData, tRelativeMs: tMs })) {
          if (state.ga4Hits.length < MAX_HITS) state.ga4Hits.push(hit);
        }
      }
      if (isTrackerRequest(url) && state.trackers.length < MAX_HITS) {
        state.trackers.push(toTrackerObservation(url, req.method(), tMs));
      }
      if (linkerDomains.size > 0 && hostMatches(url, linkerDomains) && state.linkerRequests.length < MAX_HITS) {
        state.linkerRequests.push({ url, tMs });
      }
    });
    pageOn.on('console', (msg: { type(): string; text(): string }) => {
      if (msg.type() === 'error' && state.consoleErrors.length < MAX_ERRORS) {
        state.consoleErrors.push(msg.text().slice(0, 500));
      }
    });
    pageOn.on('pageerror', (err: Error) => {
      if (state.pageErrors.length < MAX_ERRORS) {
        state.pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500));
      }
    });

    // ── Navigate + phase-1 (pre-consent) settle ───────────────────────────────
    let httpStatus: number | null = null;
    let loaded = false;
    state.navStart = Date.now();
    try {
      const resp = await page.goto(spec.url, { waitUntil: 'load', timeout: opts.navTimeoutMs });
      httpStatus = resp ? resp.status() : null;
      loaded = true;
    } catch (err) {
      notes.push(`navigation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }

    await waitForSettle(() => state.ga4Hits.length, opts.settle, clock);

    // Cookies just before the consent action (or at settle, if no consent flow).
    const cookiesPreConsent = (await context.cookies()).map((c) => c.name);

    // ── Consent action (two-phase) ─────────────────────────────────────────────
    let consentActionTMs: number | null = null;
    let consentAction: ConsentActionFacts | null = null;
    if (loaded && spec.consent) {
      const plannedTMs = Date.now() - state.navStart;
      const outcome = await clickConsent(page, spec.consent);
      consentAction = {
        action: outcome.action,
        clicked: outcome.performed,
        atTMs: outcome.performed ? plannedTMs : null,
        ...(outcome.selector ? { selector: outcome.selector } : {}),
        ...(outcome.note ? { note: outcome.note } : {}),
      };
      if (outcome.performed) {
        consentActionTMs = plannedTMs;
        await waitForSettle(() => state.ga4Hits.length, opts.settle, clock);
      } else {
        notes.push(`consent action not performed: ${outcome.note ?? 'no clickable control'}`);
      }
    }

    // ── Journey steps: event_on_interaction + cross_domain_linker ──────────────
    const actions: ActionResult[] = [];
    for (const check of spec.checks) {
      if (check.type === 'event_on_interaction' && check.action) {
        const atTMs = Date.now() - state.navStart;
        const { kind, outcome } = await runInteraction(page, check.action, opts.navTimeoutMs);
        actions.push({
          checkId: check.id,
          kind,
          selectorFound: outcome.found,
          performed: outcome.performed,
          atTMs: outcome.performed ? atTMs : null,
          ...(outcome.note ? { note: outcome.note } : {}),
        });
        if (outcome.performed) {
          await waitForSettle(
            () => state.ga4Hits.length,
            { quietMs: Math.min(opts.settle.quietMs, 1500), maxMs: Math.min(opts.settle.maxMs, 5000) },
            clock,
          );
        }
      } else if (check.type === 'cross_domain_linker') {
        for (const domain of check.expectedDomains ?? []) {
          const atTMs = Date.now() - state.navStart;
          const probe = await linkerProbe(page, domain, state, clock);
          actions.push({
            checkId: check.id,
            kind: 'linker',
            selectorFound: probe.found,
            performed: probe.clicked,
            atTMs: probe.clicked ? atTMs : null,
            ...(probe.destUrl ? { linkerDestUrl: probe.destUrl } : {}),
            linkerParamPresent: probe.glPresent,
            ...(probe.note ? { note: probe.note } : {}),
          });
        }
      }
    }

    // ── Final reads ────────────────────────────────────────────────────────────
    const cookiesPostConsent = (await context.cookies()).map((c) => c.name);
    const dlLog = await page
      .evaluate<{ t?: number; entry?: unknown }[]>(readDlLogInPage)
      .catch(() => [] as { t?: number; entry?: unknown }[]);
    const gtmEvaluated = await page.evaluate<boolean>(detectGtmInPage).catch(() => false);

    const ga4Hits = [...state.ga4Hits].sort((a, b) => a.tRelativeMs - b.tRelativeMs);

    return {
      requestedUrl: spec.url,
      finalUrl: page.url(),
      httpStatus,
      loaded,
      gtmPresent: gtmEvaluated || state.ga4Hits.length > 0,
      settled: loaded,
      ga4Hits,
      trackers: state.trackers,
      consentActionTMs,
      consentAction,
      cookiesPreConsent,
      cookiesPostConsent,
      dataLayerEvents: extractEventNames(dlLog),
      consentEvents: extractConsentEvents(dlLog),
      actions,
      notes,
      consoleErrors: state.consoleErrors,
      pageErrors: state.pageErrors,
    };
  } finally {
    await context.close();
  }
}

/** Load Playwright, launch Chromium (new headless mode), run the capture, close. */
export async function capture(spec: VerifySpec, opts: VerifyCaptureOptions): Promise<CaptureResult> {
  const pw: Playwright | null = await loadPlaywright();
  if (!pw) throw new PlaywrightMissingError();
  const browser = await pw.chromium.launch({ headless: opts.headless });
  try {
    return await runCapture(browser, spec, opts);
  } finally {
    await browser.close();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function runInteraction(
  page: PwPage,
  action: { click?: string; submit?: string; navigate?: string },
  navTimeoutMs: number,
): Promise<{ kind: ActionResult['kind']; outcome: { found: boolean; performed: boolean; note?: string } }> {
  if (action.click) return { kind: 'click', outcome: await clickSelector(page, action.click) };
  if (action.submit) return { kind: 'submit', outcome: await submitForm(page, action.submit) };
  if (action.navigate) return { kind: 'navigate', outcome: await navigateTo(page, action.navigate, navTimeoutMs) };
  return { kind: 'click', outcome: { found: false, performed: false, note: 'interaction had no click/submit/navigate' } };
}

interface LinkerProbeResult {
  found: boolean;
  clicked: boolean;
  destUrl?: string;
  glPresent: boolean;
  note?: string;
}

/**
 * Probe a cross-domain link: find an anchor to `domain`, read its (possibly
 * linker-decorated) href, click it, and inspect the resulting navigation
 * request (recorded by the listener, aborted by the route guard so we stay on
 * the page). `_gl` on the destination proves the linker fired.
 */
async function linkerProbe(
  page: PwPage,
  domain: string,
  state: CaptureState,
  clock: SettleClock,
): Promise<LinkerProbeResult> {
  const selector = `a[href*="${domain.replace(/"/g, '')}"]`;
  let el;
  try {
    el = await page.$(selector);
  } catch {
    el = null;
  }
  if (!el) return { found: false, clicked: false, glPresent: false, note: `no link to ${domain}` };

  // Href as it stands (some linkers decorate on load).
  let hrefBefore: string | undefined;
  try {
    hrefBefore = await page.evaluate<string | undefined>((sel: string) => {
      const a = document.querySelector(sel) as HTMLAnchorElement | null;
      return a ? a.href : undefined;
    }, selector);
  } catch {
    hrefBefore = undefined;
  }

  const seenBefore = state.linkerRequests.length;
  let clicked = false;
  try {
    await el.click({ timeout: 3000 });
    clicked = true;
  } catch {
    // Navigation was aborted by the route guard — expected; the request is still recorded.
    clicked = true;
  }
  // Let the (aborted) navigation request register.
  await waitForSettle(() => state.linkerRequests.length, { quietMs: 300, maxMs: 2000 }, clock);

  const fresh = state.linkerRequests.slice(seenBefore);
  const destUrl = fresh.length > 0 ? fresh[fresh.length - 1].url : hrefBefore;
  const glPresent = destUrl ? hasGlParam(destUrl) : false;
  return {
    found: true,
    clicked,
    ...(destUrl ? { destUrl } : {}),
    glPresent,
  };
}
