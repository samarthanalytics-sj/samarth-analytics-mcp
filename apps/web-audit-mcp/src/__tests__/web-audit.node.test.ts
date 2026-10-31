/**
 * Web Audit MCP — pure-logic test suite (no browser required).
 * Run: tsx apps/web-audit-mcp/src/__tests__/web-audit.node.test.ts
 *
 * Covers the SSRF guard, CMP registry shape + text heuristics, the generic CMP
 * heuristic's pick rules and click guards, form PII
 * analysis, the banner compliance rules over fixture captures, the RuntimeInput
 * bridge into the shared Consent Mode v2 engine, and the GTM container bridge
 * (parseGtmContainer + reconciled-coverage escalation in runConsentEngine).
 * A few in-page form-extraction and CMP click checks run in Chromium when Playwright is installed and
 * self-skip otherwise.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlAllowed } from '../utils/urlGuard.js';
import { createRequestGuard, safeFetch } from '../utils/safeFetch.js';
import {
  classifyUrl,
  parseQuery,
  MEASUREMENT_GROUPS,
  openInstrumentedPage,
  watchLanding,
  loadPlaywright,
  type PwBrowser,
  type PwContext,
  type PwPage,
  type PwRoute,
} from '../agent/browser.js';
import { runCapture } from '../verify/capture/capture.js';
import {
  CMP_VENDORS,
  ACCEPT_TEXT_RE,
  REJECT_TEXT_RE,
  cmpControlEligible,
  cmpContainerEligible,
  pickGenericCmp,
  blockDuringCmpClick,
  detectCmp,
  interactWithCmp,
  type CmpControlFacts,
  type CmpContainerFacts,
  type CmpDetection,
} from '../agent/cmp.js';
import { analyzeForms, classifyFieldPii, extractFormsInPage, type RawForm, type RawFormField } from '../agent/forms.js';
import { gatherCtaFacts, selectCtas, type CtaFacts } from '../agent/tag-suggest/interactive-forms.js';
import { el, miniPage, inPage, type Box, type ElOpts, type MiniDocument, type MiniElement } from '../agent/__tests__/_mini-dom.js';
import { buildFillPlan, classifyFieldRole, selectorFor, localeById, US_LOCALE } from '../agent/form-fill.js';
import { sameSite, normalizeUrl, urlPriority, crawlSite } from '../agent/crawler.js';
import { buildExclude, attachRects, resolvePageList } from '../agent/tag-suggest/scan.js';
import {
  parseSitemapLocs,
  extractLinks,
  sitemapsInRobots,
  prioritize,
  pathOf,
  discoverSitePages,
} from '../agent/tag-suggest/discover.js';
import { isBlogLike } from '../agent/tag-suggest/blog-paths.js';
import type { PageScan } from '../agent/tag-suggest/collect.js';
import { extractConsentEvents, extractEventNames, captureScenario, type ScenarioCapture } from '../agent/capture.js';
import {
  evaluateBannerRules,
  evaluateFormFindings,
  buildRuntimeInput,
  runConsentEngine,
  scoreFindings,
  sortFindings,
  isFiringHit,
  gcsIndicatesDenied,
} from '../agent/compliance.js';
import { parseGtmContainer, GtmContainerError } from '../agent/gtmConfig.js';
import {
  extractConfiguredDestinations,
  extractObservedDestinations,
  reconcile,
} from '../agent/reconcile.js';
import { readFileSync } from 'node:fs';
import {
  isAuthorized,
  buildHealthBody,
  isInitializeRequest,
  decidePostRoute,
  resolveHttpBinding,
  bindingBanner,
  startHttpServer,
  resolveSessionTtlMs,
  DEFAULT_SESSION_TTL_MS,
  rebindingRejection,
} from '../http.js';
import { request as httpRequest } from 'node:http';
import { createWebAuditMcpServer } from '../server.js';
import { loadConfig } from '../utils/config.js';
import { runConsentRuntimeRules } from '../../../portal/shared/consent-audit.js';
import { detectEmbeddedForm } from '../agent/tag-suggest/providers.js';
import { buildSuggestInput } from '../agent/tag-suggest/collect.js';
import type { PageScan, PageSignals } from '../agent/tag-suggest/collect.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── urlGuard ────────────────────────────────────────────────────────────────

check('guard: public https ok', urlAllowed('https://example.com/x').ok);
check('guard: plain http ok', urlAllowed('http://example.com').ok);
check('guard: ftp blocked', !urlAllowed('ftp://example.com').ok);
check('guard: file blocked', !urlAllowed('file:///etc/passwd').ok);
check('guard: localhost blocked', !urlAllowed('http://localhost:3000').ok);
check('guard: .localhost blocked', !urlAllowed('http://foo.localhost').ok);
check('guard: 127.0.0.1 blocked', !urlAllowed('http://127.0.0.1').ok);
check('guard: 10.x blocked', !urlAllowed('http://10.1.2.3').ok);
check('guard: 192.168 blocked', !urlAllowed('http://192.168.1.1').ok);
check('guard: 172.16 blocked', !urlAllowed('http://172.16.0.1').ok);
check('guard: 172.32 allowed', urlAllowed('http://172.32.0.1').ok);
check('guard: metadata blocked', !urlAllowed('http://169.254.169.254/latest/meta-data/').ok);
check('guard: CGNAT blocked', !urlAllowed('http://100.64.0.1').ok);
check('guard: decimal ip blocked', !urlAllowed('http://2130706433/').ok);
check('guard: hex ip blocked', !urlAllowed('http://0x7f000001/').ok);
check('guard: octal ip blocked', !urlAllowed('http://0177.0.0.1/').ok);
check('guard: ipv6 loopback blocked', !urlAllowed('http://[::1]/').ok);
check('guard: ipv6 mapped loopback blocked', !urlAllowed('http://[::ffff:127.0.0.1]/').ok);
check('guard: ipv6 mapped hex metadata blocked', !urlAllowed('http://[::ffff:a9fe:a9fe]/').ok);
check('guard: ULA blocked', !urlAllowed('http://[fc00::1]/').ok);
check('guard: allowlist match', urlAllowed('https://shop.example.com', ['example.com']).ok);
check('guard: allowlist exact', urlAllowed('https://example.com', ['example.com']).ok);
check('guard: allowlist miss', !urlAllowed('https://notexample.com', ['example.com']).ok);
check('guard: allowlist no suffix-confusion', !urlAllowed('https://evilexample.com', ['example.com']).ok);
// A trailing dot is the absolute (FQDN) spelling of the same host, and resolves the same way.
check('guard: localhost. (trailing dot) blocked', !urlAllowed('http://localhost./').ok);
check('guard: .localhost. (trailing dot) blocked', !urlAllowed('http://foo.localhost./').ok);
check('guard: ip6-localhost. blocked', !urlAllowed('http://ip6-localhost./').ok);
check('guard: LOCALHOST.. (repeated dots) blocked', !urlAllowed('http://LOCALHOST../').ok);
check('guard: allowlist matches the FQDN spelling', urlAllowed('https://client.com./', ['client.com']).ok);
check('guard: FQDN spelling is no suffix-confusion', !urlAllowed('https://evilclient.com./', ['client.com']).ok);

// ── in-browser request guard (DNS-resolving) ─────────────────────────────────
// The Playwright route guards used to run only the string check above, which passes a
// public-looking NAME that resolves inside. These drive the real guard on a fake resolver.

function fakeLookup(table: Record<string, string[]>) {
  const calls: string[] = [];
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    const addrs = table[hostname];
    if (!addrs) throw new Error(`ENOTFOUND ${hostname}`);
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { lookup, calls };
}

const PUBLIC_IP = '93.184.216.34';
const dnsTable: Record<string, string[]> = {
  'metadata.google.internal': ['169.254.169.254'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  db: ['172.18.0.3'],
  'v6-loop.example.com': ['::1'],
  'mixed.example.com': [PUBLIC_IP, '10.0.0.7'],
  'example.com': [PUBLIC_IP],
  // A redirect target: the landing check resolves it, as Chromium did to follow the redirect.
  'www.example.com': [PUBLIC_IP],
  'shop.example.com': [PUBLIC_IP],
  'cdn.example.com': [PUBLIC_IP],
  'evil.test': [PUBLIC_IP],
};

{
  const { lookup, calls } = fakeLookup(dnsTable);
  const allowed = createRequestGuard(lookup);
  for (const u of [
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://127.0.0.1.nip.io/',
    'http://db:5432/',
    'http://v6-loop.example.com/',
    'http://mixed.example.com/',
  ]) {
    check(`request guard: string check alone passes ${u}`, urlAllowed(u, []).ok);
    check(`request guard: blocks ${u} (resolves private)`, (await allowed(u)) === false);
  }
  check('request guard: public name allowed', (await allowed('https://example.com/')) === true);
  check('request guard: unresolvable name fails closed', (await allowed('https://nope.example/')) === false);
  const before = calls.length;
  check('request guard: public IP literal allowed', (await allowed(`http://${PUBLIC_IP}/`)) === true);
  check('request guard: private IP literal blocked', (await allowed('http://10.0.0.1/')) === false);
  check('request guard: IP literals and string-check failures never hit DNS', calls.length === before);
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => allowed(`https://cdn.example.com/a${i}.js`)));
  check('request guard: one lookup per host', many.every(Boolean) && calls.filter((h) => h === 'cdn.example.com').length === 1);
  check('request guard: a private answer is remembered', (await allowed('http://db/x')) === false && calls.filter((h) => h === 'db').length === 1);
}
// A scan worker or crawl reuses one guard for every page; a single transient lookup error used to be
// cached as "blocked" and refuse that host (the site itself, or its CDN) for the rest of the run.
{
  let failures = 1;
  const calls: string[] = [];
  const allowed = createRequestGuard(async (hostname: string) => {
    calls.push(hostname);
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: 'EAI_AGAIN' });
    }
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  check('request guard: fails closed while the lookup errors', (await allowed('https://flaky.example.com/')) === false);
  check('request guard: a failed lookup is retried, not remembered', (await allowed('https://flaky.example.com/next')) === true);
  check('request guard: the real answer is then remembered', (await allowed('https://flaky.example.com/again')) === true && calls.length === 2, calls.join(','));
}

/** Drive a captured Playwright route handler with a fake route; returns what it decided. */
type FakeReq = { url: string; nav?: boolean; iframe?: boolean; popup?: boolean };
async function decide(
  handler: ((route: never) => unknown) | undefined,
  r: FakeReq,
): Promise<'continue' | 'abort' | 'fulfill' | 'none'> {
  let outcome: 'continue' | 'abort' | 'fulfill' | 'none' = 'none';
  const route = {
    request: () => ({
      url: () => r.url,
      method: () => 'GET',
      resourceType: () => (r.nav ? 'document' : 'script'),
      postData: () => null,
      isNavigationRequest: () => Boolean(r.nav),
      frame: () => {
        if (r.popup) throw new Error('Frame for this navigation request is not available');
        return { parentFrame: () => (r.iframe ? {} : null) };
      },
    }),
    continue: async () => {
      outcome = 'continue';
    },
    abort: async () => {
      outcome = 'abort';
    },
    fulfill: async () => {
      outcome = 'fulfill';
    },
  };
  await handler?.(route as never);
  return outcome;
}

/**
 * A fake browser for runCapture: records goto() calls and routes them through the handler.
 * `redirects` maps a URL to where a server redirect lands; like real Playwright, only the first URL
 * reaches the route handler. `elements` makes every selector resolve, and `interactions` records
 * each click and in-page submit/href script that actually ran.
 */
function fakeVerifyBrowser(fake: { redirects?: Record<string, string>; elements?: boolean } = {}) {
  const box: { handler?: (route: never) => unknown } = {};
  const gotos: string[] = [];
  const interactions: string[] = [];
  let current = 'about:blank';
  const page = {
    goto: async (url: string) => {
      gotos.push(url);
      if ((await decide(box.handler, { url, nav: true })) === 'abort') throw new Error(`net::ERR_FAILED at ${url}`);
      current = fake.redirects?.[url] ?? url;
      return { status: () => 200, headers: () => ({}) };
    },
    evaluate: async (_fn: unknown, arg?: unknown) => {
      if (typeof arg !== 'string') return [];
      interactions.push(`script ${arg}`);
      return undefined;
    },
    addInitScript: async () => {},
    on: () => {},
    frames: () => [],
    $: async (sel: string) =>
      fake.elements
        ? {
            click: async () => {
              interactions.push(`click ${sel}`);
            },
          }
        : null,
    title: async () => '',
    url: () => current,
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.alloc(0),
    close: async () => {},
  };
  const context = {
    route: async (_pattern: string, handler: (route: never) => unknown) => {
      box.handler = handler;
    },
    newPage: async () => page,
    cookies: async () => [],
    close: async () => {},
  };
  const browser = { newContext: async () => context, close: async () => {} } as unknown as PwBrowser;
  return { browser, box, gotos, interactions, decide: (r: FakeReq) => decide(box.handler, r) };
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const verifyOpts = (extra: Record<string, unknown> = {}) => ({
  headless: true,
  navTimeoutMs: 1000,
  settle: { quietMs: 10, maxMs: 20 },
  allowlist: [] as string[],
  clock: fakeClock(),
  ...extra,
});

// openInstrumentedPage (audit agent, crawler, tag-suggest scan).
{
  const box: { handler?: (route: never) => unknown } = {};
  const ctx = {
    route: async (_p: string, h: (route: PwRoute) => unknown) => {
      box.handler = h as (route: never) => unknown;
    },
    newPage: async () => ({ addInitScript: async () => {}, on: () => {} }) as unknown as PwPage,
    cookies: async () => [],
    close: async () => {},
  } as PwContext;
  await openInstrumentedPage(ctx, createRequestGuard(fakeLookup(dnsTable).lookup));
  check(
    'audit route guard: aborts a name that resolves to metadata',
    (await decide(box.handler, { url: 'http://metadata.google.internal/computeMetadata/v1/' })) === 'abort',
  );
  check(
    'audit route guard: aborts a nip.io loopback name',
    (await decide(box.handler, { url: 'http://127.0.0.1.nip.io/', nav: true })) === 'abort',
  );
  check(
    'audit route guard: a public subresource continues',
    (await decide(box.handler, { url: 'https://cdn.example.com/gtm.js' })) === 'continue',
  );
}

// ── redirect hops (F07) ──────────────────────────────────────────────────────
// Playwright routes only the FIRST URL of a redirect chain, so the route guards above never see a
// public URL 302ing to a private/metadata address: the browser loaded it, and the crawler, forms_scan,
// consent capture and tag-scan read it back (title, form labels, a full-page screenshot).

/** A fake Playwright request; `from` is the request that redirected to it. */
function fakeReq(url: string, from: unknown = null) {
  return { url: () => url, method: () => 'GET', resourceType: () => 'document', redirectedFrom: () => from };
}

/**
 * A fake browser for the audit agent. Like real Playwright: only the first URL reaches the route
 * handler, a server redirect (`redirects`) lands the page elsewhere and emits a 'request' event with
 * redirectedFrom set, and about:blank is never routed. The landed page "contains" a title, a link, a
 * form, a consent banner and a cookie, so a test can see whether any of it was read.
 */
function fakeAgentBrowser(redirects: Record<string, string> = {}) {
  const box: { handler?: (route: never) => unknown } = {};
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const clicks: string[] = [];
  let current = 'about:blank';
  let visited = false;
  const page = {
    goto: async (url: string) => {
      if (url === 'about:blank') {
        current = url;
        return null;
      }
      if ((await decide(box.handler, { url, nav: true })) === 'abort') throw new Error(`net::ERR_FAILED at ${url}`);
      const first = fakeReq(url);
      for (const cb of listeners.request ?? []) cb(first);
      const landed = redirects[url];
      const last = landed ? fakeReq(landed, first) : first;
      if (landed) for (const cb of listeners.request ?? []) cb(last);
      current = landed ?? url;
      visited = true;
      return { status: () => 200, headers: () => ({}), allHeaders: async () => ({}), request: () => last };
    },
    evaluate: async (fn: unknown) => {
      const name = typeof fn === 'function' ? fn.name : '';
      const blank = current === 'about:blank';
      if (name === 'scanPageInBrowser') {
        return blank
          ? { title: '', links: [], formsCount: 0, cmpHint: false }
          : { title: `PAGE AT ${current}`, links: ['/next'], formsCount: 1, cmpHint: true };
      }
      if (name === 'extractFormsInPage') {
        return blank ? [] : [form({ title: 'Admin login', fields: [field({ type: 'password', name: 'db_password', label: 'DB password' })] })];
      }
      return [];
    },
    addInitScript: async () => {},
    on: (event: string, cb: (arg: unknown) => void) => {
      (listeners[event] ??= []).push(cb);
    },
    frames: () => [],
    $: async (sel: string) =>
      current === 'about:blank'
        ? null
        : {
            isVisible: async () => true,
            click: async () => {
              clicks.push(`${current} ${sel}`);
            },
          },
    title: async () => '',
    url: () => current,
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.alloc(0),
    close: async () => {},
  };
  const context = {
    route: async (_pattern: string, handler: (route: never) => unknown) => {
      box.handler = handler;
    },
    newPage: async () => page,
    cookies: async () => (visited ? [{ name: 'admin_session' }] : []),
    close: async () => {},
  };
  const browser = { newContext: async () => context, close: async () => {} } as unknown as PwBrowser;
  return { browser, clicks, emit: (event: string, arg: unknown) => (listeners[event] ?? []).forEach((cb) => cb(arg)) };
}

// IP literals throughout, so the real (default) DNS guard never needs the network.
const PUBLIC_START = 'http://203.0.113.10/contact';
const INTERNAL = 'http://10.0.0.5:8080/admin';

// watchLanding itself: hops it sees through 'request' events, the response chain, and where the page is.
{
  const fake = fakeAgentBrowser();
  const page = (await (await fake.browser.newContext()).newPage()) as unknown as PwPage;
  const landing = watchLanding(page, createRequestGuard(fakeLookup(dnsTable).lookup));
  check('landing: a page that never left a public host is not refused', (await landing.blockedLanding(null)) === null);
  // An iframe/subresource redirect: only the 'request' event shows it (the main frame is unchanged).
  fake.emit('request', fakeReq('http://169.254.169.254/latest/meta-data/', fakeReq('https://cdn.example.com/x')));
  const note = await landing.blockedLanding(null);
  check('landing: a redirect hop to metadata seen on the page is refused', /^blocked: redirected to 169\.254\.169\.254/.test(note ?? ''), note ?? 'null');
  check('landing: a refusal holds until reset', (await landing.blockedLanding(null)) === note);
  landing.reset();
  check('landing: reset() starts a clean navigation', (await landing.blockedLanding(null)) === null);
  // A public redirect hop is fine, and so is a non-http frame (an aborted iframe shows chrome-error://).
  fake.emit('request', fakeReq('https://shop.example.com/landing', fakeReq('https://example.com/')));
  check('landing: a public redirect hop is not refused', (await landing.blockedLanding(null)) === null);
  // The response's own chain, without any event: a name that resolves inside is refused too.
  const viaChain = await landing.blockedLanding({
    status: () => 200,
    headers: () => ({}),
    allHeaders: async () => ({}),
    request: () => fakeReq('https://example.com/ok', fakeReq('http://metadata.google.internal/x', fakeReq('https://example.com/'))),
  });
  check('landing: a private hop in the response chain is refused', /metadata\.google\.internal/.test(viaChain ?? ''), viaChain ?? 'null');
}

// openInstrumentedPage: a refused landing drops what was recorded for that navigation.
{
  const fake = fakeAgentBrowser({ [PUBLIC_START]: INTERNAL });
  const inst = await openInstrumentedPage(await fake.browser.newContext() as unknown as PwContext);
  inst.markNavigationStart();
  const resp = await inst.page.goto(PUBLIC_START);
  fake.emit('request', fakeReq('https://region1.google-analytics.com/g/collect?v=2&tid=G-1&dl=http%3A%2F%2F10.0.0.5%2Fadmin'));
  check('instruments: the internal page produced a tracker hit (precondition)', inst.trackerHits.length === 1);
  const note = await inst.blockedLanding(resp);
  check('instruments: a redirect to a private address is refused', /^blocked: redirected to 10\.0\.0\.5:8080/.test(note ?? ''), note ?? 'null');
  check('instruments: its tracker hits are dropped', inst.trackerHits.length === 0);
  check('instruments: the page is moved off the internal address', inst.page.url() === 'about:blank');
}

// crawlSite: the redirected page is reported with nothing read from it.
{
  const fake = fakeAgentBrowser({ [PUBLIC_START]: INTERNAL });
  const crawl = await crawlSite(fake.browser, PUBLIC_START, { maxPages: 3, maxDepth: 2, navTimeoutMs: 1000, allowlist: [] });
  const p = crawl.pages[0];
  check('crawl redirect: the page is noted as blocked', /^blocked: redirected to 10\.0\.0\.5:8080/.test(p?.note ?? ''), JSON.stringify(p));
  check(
    'crawl redirect: no title, final URL, status or links from the internal page',
    p?.title === '' && p?.finalUrl === null && p?.httpStatus === null && p?.linksFound === 0 && p?.formsCount === 0,
    JSON.stringify(p),
  );
  check('crawl redirect: its links are never followed', crawl.pages.length === 1, JSON.stringify(crawl.pages.map((x) => x.url)));

  // Control: a redirect that stays public is crawled as before.
  const ok = fakeAgentBrowser({ [PUBLIC_START]: 'http://203.0.113.10/contact-us' });
  const okCrawl = await crawlSite(ok.browser, PUBLIC_START, { maxPages: 1, maxDepth: 0, navTimeoutMs: 1000, allowlist: [] });
  check(
    'crawl redirect: a public redirect is still read',
    okCrawl.pages[0]?.title === 'PAGE AT http://203.0.113.10/contact-us' && !okCrawl.pages[0]?.note,
    JSON.stringify(okCrawl.pages[0]),
  );
}

// captureScenario (forms_scan, consent_banner_detect, consent_scenario_capture): no forms, cookies or
// banner click on the internal page.
{
  const fake = fakeAgentBrowser({ [PUBLIC_START]: INTERNAL });
  const cap = await captureScenario(fake.browser, PUBLIC_START, 'accept', { navTimeoutMs: 1000, settleMs: 0, scanForms: true });
  check('capture redirect: the capture is noted as blocked', cap.notes.some((n) => /^blocked: redirected to 10\.0\.0\.5:8080/.test(n)), cap.notes.join('; '));
  check(
    'capture redirect: no forms, cookies, status or final URL from the internal page',
    cap.forms === null && cap.cookiesPreInteraction.length === 0 && cap.cookiesFinal.length === 0 && cap.httpStatus === null && cap.finalUrl === null,
    JSON.stringify({ forms: cap.forms, cookies: cap.cookiesFinal, status: cap.httpStatus, finalUrl: cap.finalUrl }),
  );
  check('capture redirect: nothing on the internal page is clicked', fake.clicks.length === 0 && cap.interaction === null, fake.clicks.join(', '));

  const ok = fakeAgentBrowser({ [PUBLIC_START]: 'http://203.0.113.10/contact-us' });
  const okCap = await captureScenario(ok.browser, PUBLIC_START, 'ignore', { navTimeoutMs: 1000, settleMs: 0, scanForms: true });
  check(
    'capture redirect: a public redirect is still read',
    (okCap.forms?.length ?? 0) === 1 && okCap.finalUrl === 'http://203.0.113.10/contact-us' && !okCap.notes.some((n) => /blocked/.test(n)),
    JSON.stringify({ forms: okCap.forms?.length, finalUrl: okCap.finalUrl, notes: okCap.notes }),
  );
}

// verify capture (TagDrishti) — the third copy of the route guard.
{
  const fb = fakeVerifyBrowser();
  const cap = await runCapture(
    fb.browser,
    { url: 'https://shop.example.com/', checks: [] },
    verifyOpts({ requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check('verify route guard: the start page on a public name loads', cap.loaded === true, cap.notes.join('; '));
  check(
    'verify route guard: aborts a name that resolves to metadata',
    (await fb.decide({ url: 'http://metadata.google.internal/computeMetadata/v1/' })) === 'abort',
  );
  check(
    'verify route guard: a public subresource continues',
    (await fb.decide({ url: 'https://cdn.example.com/gtm.js' })) === 'continue',
  );

  // Fixture mode is offline: it never consults the (DNS) guard.
  const fx = fakeVerifyBrowser();
  let guardCalls = 0;
  await runCapture(
    fx.browser,
    { url: 'https://fixtures.example/', checks: [] },
    verifyOpts({
      fixtures: { resolve: () => ({ body: '<html></html>' }) },
      requestGuard: async () => {
        guardCalls += 1;
        return true;
      },
    }),
  );
  check('verify route guard: fixture mode serves from memory', (await fx.decide({ url: 'https://x.example/' })) === 'fulfill');
  check('verify route guard: fixture mode never consults the DNS guard', guardCalls === 0);
}

// verify allowlist — it used to be declared and never read, so a spec could navigate, redirect or
// REAL-submit a form onto any public host whatever the operator allowlisted.
{
  const fb = fakeVerifyBrowser();
  const cap = await runCapture(
    fb.browser,
    {
      url: 'https://shop.example.com/',
      checks: [
        { id: 'nav-off', type: 'event_on_interaction', event: 'x', action: { navigate: 'https://evil.test/landing' } },
        { id: 'nav-on', type: 'event_on_interaction', event: 'y', action: { navigate: 'https://shop.example.com/next' } },
      ],
    },
    verifyOpts({ allowlist: ['example.com'], requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check('verify allowlist: an allowlisted start URL loads', cap.loaded === true, cap.notes.join('; '));
  const off = cap.actions.find((a) => a.checkId === 'nav-off');
  check(
    'verify allowlist: an off-allowlist navigate step is refused',
    off?.performed === false && /refused/.test(off?.note ?? ''),
    JSON.stringify(off),
  );
  check('verify allowlist: the off-allowlist navigate target is never opened', !fb.gotos.includes('https://evil.test/landing'));
  const on = cap.actions.find((a) => a.checkId === 'nav-on');
  check('verify allowlist: an allowlisted navigate step runs', on?.performed === true, JSON.stringify(on));
  // What a link click or a real form submit produces at the route. (A redirect hop never reaches
  // the route handler; see the page-URL re-check below.)
  check(
    'verify allowlist: a top-level navigation off the allowlist is aborted',
    (await fb.decide({ url: 'https://evil.test/thanks', nav: true })) === 'abort',
  );
  check(
    'verify allowlist: a popup navigation off the allowlist is aborted',
    (await fb.decide({ url: 'https://evil.test/thanks', nav: true, popup: true })) === 'abort',
  );
  check(
    'verify allowlist: an allowlisted top-level navigation continues',
    (await fb.decide({ url: 'https://shop.example.com/thanks', nav: true })) === 'continue',
  );
  check(
    'verify allowlist: a third-party iframe (CMP banner, embed) still loads',
    (await fb.decide({ url: 'https://evil.test/cmp-banner', nav: true, iframe: true })) === 'continue',
  );
  check(
    'verify allowlist: a third-party subresource still loads',
    (await fb.decide({ url: 'https://evil.test/pixel.js' })) === 'continue',
  );
}
{
  const fb = fakeVerifyBrowser();
  const cap = await runCapture(
    fb.browser,
    { url: 'https://evil.test/', checks: [] },
    verifyOpts({ allowlist: ['example.com'], requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check('verify allowlist: an off-allowlist start URL does not load', cap.loaded === false, cap.notes.join('; '));
}
{
  const fb = fakeVerifyBrowser();
  await runCapture(
    fb.browser,
    { url: 'https://shop.example.com/', checks: [] },
    verifyOpts({ requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check(
    'verify allowlist: an empty allowlist still means any public host',
    (await fb.decide({ url: 'https://evil.test/thanks', nav: true })) === 'continue',
  );
}

// verify allowlist vs redirects — Playwright never routes a redirect hop, so a start URL that
// 302s off the allowlist used to be driven anyway: the consent click, a REAL submit, clicks and
// linker probes all ran on the off-allowlist host. The page URL is now re-checked before each one.
{
  const redirectSpec = {
    url: 'https://shop.example.com/start',
    consent: { acceptSelector: '#accept' },
    checks: [
      { id: 'sub', type: 'event_on_interaction', event: 'generate_lead', action: { submit: '#lead' } },
      { id: 'clk', type: 'event_on_interaction', event: 'cta', action: { click: '#cta' } },
      { id: 'nav', type: 'event_on_interaction', event: 'pv', action: { navigate: 'https://shop.example.com/next' } },
      { id: 'lnk', type: 'cross_domain_linker', expectedDomains: ['partner.example.org'] },
    ],
  } as never;
  const fb = fakeVerifyBrowser({ redirects: { 'https://shop.example.com/start': 'https://evil.test/form' }, elements: true });
  const cap = await runCapture(
    fb.browser,
    redirectSpec,
    verifyOpts({ allowlist: ['example.com'], requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check('verify redirect: the page is left where the unrouted redirect landed', cap.finalUrl === 'https://evil.test/form', cap.finalUrl);
  check(
    'verify redirect: an off-allowlist final URL is noted',
    cap.notes.some((n) => /start URL ended outside the allowlist/.test(n) && /evil\.test/.test(n)),
    cap.notes.join('; '),
  );
  check(
    'verify redirect: the consent click is refused',
    cap.consentAction?.clicked === false && /refused: page is on evil\.test/.test(cap.consentAction?.note ?? ''),
    JSON.stringify(cap.consentAction),
  );
  for (const id of ['sub', 'clk', 'nav', 'lnk']) {
    const a = cap.actions.find((x) => x.checkId === id);
    check(
      `verify redirect: the ${id} step is not performed on the off-allowlist page`,
      a?.performed === false && /refused: page is on evil\.test, outside the allowlist/.test(a?.note ?? ''),
      JSON.stringify(a),
    );
  }
  check('verify redirect: nothing was clicked or submitted', fb.interactions.length === 0, fb.interactions.join(', '));
  check('verify redirect: the refused navigate step was not opened', !fb.gotos.includes('https://shop.example.com/next'));

  // Control: the same journey on a redirect that stays on the allowlist is driven as before.
  const ok = fakeVerifyBrowser({ redirects: { 'https://shop.example.com/start': 'https://www.example.com/form' }, elements: true });
  const okCap = await runCapture(
    ok.browser,
    redirectSpec,
    verifyOpts({ allowlist: ['example.com'], requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check(
    'verify redirect: an on-allowlist redirect is still driven (consent, submit, click)',
    okCap.consentAction?.clicked === true &&
      ['sub', 'clk', 'nav'].every((id) => okCap.actions.find((x) => x.checkId === id)?.performed === true) &&
      ok.interactions.includes('click #accept') &&
      ok.interactions.includes('script #lead') &&
      ok.interactions.includes('click #cta'),
    JSON.stringify({ actions: okCap.actions, interactions: ok.interactions }),
  );
  check('verify redirect: no off-allowlist note when the redirect stays on the list', !okCap.notes.some((n) => /outside the allowlist/.test(n)));

  // An empty allowlist still means open: the off-site redirect target is driven as before.
  const open = fakeVerifyBrowser({ redirects: { 'https://shop.example.com/start': 'https://evil.test/form' }, elements: true });
  const openCap = await runCapture(
    open.browser,
    redirectSpec,
    verifyOpts({ requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }),
  );
  check(
    'verify redirect: an empty allowlist does not refuse interactions',
    openCap.actions.find((x) => x.checkId === 'sub')?.performed === true && open.interactions.includes('script #lead'),
    JSON.stringify(openCap.actions),
  );
}

// verify vs a redirect to a PRIVATE address (F07). The allowlist re-check above is skipped for an
// empty allowlist, so a start URL that 302'd to an internal host had its consent click, a REAL submit
// and clicks driven on the internal page. The SSRF refusal applies whatever the allowlist.
{
  const spec = {
    url: 'https://shop.example.com/start',
    consent: { acceptSelector: '#accept' },
    checks: [
      { id: 'sub', type: 'event_on_interaction', event: 'generate_lead', action: { submit: '#lead' } },
      { id: 'clk', type: 'event_on_interaction', event: 'cta', action: { click: '#cta' } },
      { id: 'lnk', type: 'cross_domain_linker', expectedDomains: ['partner.example.org'] },
    ],
  } as never;
  const fb = fakeVerifyBrowser({ redirects: { 'https://shop.example.com/start': 'http://10.0.0.5/admin' }, elements: true });
  const cap = await runCapture(fb.browser, spec, verifyOpts({ requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }));
  check(
    'verify ssrf redirect: the start page counts as not loaded, with no status or final URL',
    cap.loaded === false && cap.httpStatus === null && cap.finalUrl === null,
    JSON.stringify({ loaded: cap.loaded, status: cap.httpStatus, finalUrl: cap.finalUrl }),
  );
  check(
    'verify ssrf redirect: the refusal is noted',
    cap.notes.some((n) => /^start URL blocked: redirected to 10\.0\.0\.5/.test(n)),
    cap.notes.join('; '),
  );
  check('verify ssrf redirect: the consent click does not run', cap.consentAction === null || cap.consentAction.clicked === false);
  for (const id of ['sub', 'clk', 'lnk']) {
    const a = cap.actions.find((x) => x.checkId === id);
    check(
      `verify ssrf redirect: the ${id} step is refused, empty allowlist or not`,
      a?.performed === false && /blocked: redirected to 10\.0\.0\.5/.test(a?.note ?? ''),
      JSON.stringify(a),
    );
  }
  check('verify ssrf redirect: nothing was clicked or submitted on the internal page', fb.interactions.length === 0, fb.interactions.join(', '));
}
{
  // Mid-journey: a navigate step that redirects into the metadata address refuses every later step.
  const spec = {
    url: 'https://shop.example.com/',
    checks: [
      { id: 'nav', type: 'event_on_interaction', event: 'pv', action: { navigate: 'https://shop.example.com/next' } },
      { id: 'sub', type: 'event_on_interaction', event: 'generate_lead', action: { submit: '#lead' } },
    ],
  } as never;
  const fb = fakeVerifyBrowser({ redirects: { 'https://shop.example.com/next': 'http://169.254.169.254/latest/meta-data/' }, elements: true });
  const cap = await runCapture(fb.browser, spec, verifyOpts({ requestGuard: createRequestGuard(fakeLookup(dnsTable).lookup) }));
  check('verify ssrf redirect: the public start page still loads', cap.loaded === true, cap.notes.join('; '));
  const sub = cap.actions.find((x) => x.checkId === 'sub');
  check(
    'verify ssrf redirect: a step after a redirect into metadata is refused',
    sub?.performed === false && /blocked: redirected to 169\.254\.169\.254/.test(sub?.note ?? '') && !fb.interactions.includes('script #lead'),
    JSON.stringify({ sub, interactions: fb.interactions }),
  );
  check(
    'verify ssrf redirect: the journey refusal is noted and the final URL withheld',
    cap.finalUrl === null && cap.notes.some((n) => /^journey blocked: redirected to 169\.254\.169\.254/.test(n)),
    JSON.stringify({ finalUrl: cap.finalUrl, notes: cap.notes }),
  );
}

// verify CLI — `--allowlist` was parsed and then ignored, and the start URL was never checked.
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-cli-'));
  const specPath = join(dir, 'spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({ url: 'https://evil.test/', checks: [{ id: 'pv', type: 'event_fired', event: 'page_view' }] }),
  );
  const cli = fileURLToPath(new URL('../verify/cli.ts', import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...process.execArgv, cli, '--spec', specPath, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
  const offList = run('--allowlist', 'Example.com');
  check(
    'verify cli: a start URL off --allowlist is rejected before anything loads',
    offList.status === 2 && /URL rejected/.test(offList.stderr),
    `status=${offList.status} stderr=${String(offList.stderr).slice(0, 200)}`,
  );
  const loopback = run('--url', 'http://localhost./');
  check(
    'verify cli: a private start URL is rejected without --allowlist',
    loopback.status === 2 && /URL rejected/.test(loopback.stderr),
    `status=${loopback.status} stderr=${String(loopback.stderr).slice(0, 200)}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// ── tracker classification ─────────────────────────────────────────────────

const ga4 = classifyUrl('https://region1.google-analytics.com/g/collect?v=2&tid=G-123&gcs=G111&en=page_view');
check('classify: ga4 collect', ga4.ids.includes('ga4_collect') && ga4.groups.includes('ga4'));
const meta = classifyUrl('https://www.facebook.com/tr?id=123&ev=PageView');
check('classify: meta pixel', meta.groups.includes('meta'));
const gtm = classifyUrl('https://www.googletagmanager.com/gtm.js?id=GTM-XXX');
check('classify: gtm loader', gtm.groups.includes('gtm'));
check('classify: gtm not a measurement group', !MEASUREMENT_GROUPS.has('gtm'));
const q = parseQuery('https://x.test/g/collect?gcs=G100&en=page_view&dl=https%3A%2F%2Fa.b');
check('parseQuery decodes', q.gcs === 'G100' && q.dl === 'https://a.b');

// ── CMP registry ────────────────────────────────────────────────────────────

const vendorIds = new Set(CMP_VENDORS.map((v) => v.id));
check('cmp: vendor ids unique', vendorIds.size === CMP_VENDORS.length);
check('cmp: every vendor has presence + accept', CMP_VENDORS.every((v) => v.presence.length > 0 && v.accept.length > 0));
check('cmp: covers major vendors', ['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'quantcast', 'trustarc'].every((id) => vendorIds.has(id)));
check('cmp: accept text en', ACCEPT_TEXT_RE.test('Accept all cookies'));
check('cmp: accept text de', ACCEPT_TEXT_RE.test('Alle akzeptieren'));
check('cmp: accept text fr', ACCEPT_TEXT_RE.test("J'accepte"));
check('cmp: accept text es', ACCEPT_TEXT_RE.test('Aceptar todo'));
check('cmp: reject text en', REJECT_TEXT_RE.test('Reject all'));
check('cmp: reject text only-necessary', REJECT_TEXT_RE.test('Only necessary cookies'));
check('cmp: reject text de', REJECT_TEXT_RE.test('Nur notwendige Cookies'));
check('cmp: reject text fr', REJECT_TEXT_RE.test('Continuer sans accepter'));
check('cmp: accept not matching reject', !REJECT_TEXT_RE.test('Accept all cookies'));
check('cmp: reject not matching accept', !ACCEPT_TEXT_RE.test('Reject all'));
check('cmp: privacy-policy link is neither', !ACCEPT_TEXT_RE.test('Privacy policy') && !REJECT_TEXT_RE.test('Privacy policy'));

// ── CMP generic heuristic: which controls / containers it may pick (pure) ─────────────────────────
// The autonomous audit agent may only click consent-banner controls. The page reports facts; these
// rules decide. A wrong "yes" is a click (or a form submit) on a live site.
const ctl = (over: Partial<CmpControlFacts> = {}): CmpControlFacts => ({
  tag: 'BUTTON', type: 'submit', href: null, inForm: false, label: 'Accept all', selector: 'html > body > div > button', ...over,
});
const box = (over: Partial<CmpContainerFacts> = {}): CmpContainerFacts => ({
  selector: 'html > body > div.cookie-banner', idClass: ' cookie-banner', aria: '', consentText: true, privacyText: false,
  hasTextEntry: false, controls: [ctl()], ...over,
});

check('cmp-pick: a bare <button> outside any form is a consent control', cmpControlEligible(ctl()));
check('cmp-pick: <input type=button> is a consent control', cmpControlEligible(ctl({ tag: 'INPUT', type: 'button' })));
check('cmp-pick: a form-owned <button type=button> does not submit and stays eligible', cmpControlEligible(ctl({ type: 'button', inForm: true })));
check('cmp-pick: a form-owned submit button ("OK") is NOT a consent control', !cmpControlEligible(ctl({ label: 'OK', inForm: true })));
check('cmp-pick: a form-owned button with no/unknown type (submits by default) is NOT one', !cmpControlEligible(ctl({ type: '', inForm: true })));
check('cmp-pick: <input type=submit|image|reset> is never one, in a form or not',
  ['submit', 'image', 'reset'].every((type) => !cmpControlEligible(ctl({ tag: 'INPUT', type })) && !cmpControlEligible(ctl({ tag: 'INPUT', type, inForm: true }))));
check('cmp-pick: a link to another page (a[href="/x"], absolute URL) is NOT one',
  !cmpControlEligible(ctl({ tag: 'A', type: '', href: '/x' })) && !cmpControlEligible(ctl({ tag: 'A', type: '', href: 'https://acme.example/accept' })));
check('cmp-pick: a button inside a real link is NOT one', !cmpControlEligible(ctl({ href: '/subscribe' })));
check('cmp-pick: #hash, javascript: and empty hrefs stay eligible (script-driven banner links)',
  ['#', '#accept', 'javascript:void(0)', 'javascript:acceptCookies()', ''].every((href) => cmpControlEligible(ctl({ tag: 'A', type: '', href }))));
check('cmp-pick: a control with no unique selector is never picked', !cmpControlEligible(ctl({ selector: null })));

check('cmp-pick: a cookie-named container with cookie wording is a banner', cmpContainerEligible(box()));
check('cmp-pick: a newsletter "banner" whose only wording is "privacy" is NOT a consent banner',
  !cmpContainerEligible(box({ selector: 'html > body > section.newsletter-banner', idClass: ' newsletter-banner', consentText: false, privacyText: true })));
check('cmp-pick: "privacy" wording still counts in a container named for cookies/consent',
  cmpContainerEligible(box({ idClass: 'cookie-consent ', consentText: false, privacyText: true })));
check('cmp-pick: a generic notice with cookie wording is still a banner', cmpContainerEligible(box({ idClass: ' site-notice' })));
check('cmp-pick: a container holding a text/email field is a form, not a consent banner', !cmpContainerEligible(box({ hasTextEntry: true })));
check('cmp-pick: a container with no unique selector is never picked', !cmpContainerEligible(box({ selector: null })));
check('cmp-pick: a container not named cookie-ish is never picked', !cmpContainerEligible(box({ idClass: ' hero ' })));

{
  // F10 repro: <section class="newsletter-banner"><p>We respect your privacy.</p><form method=post>
  // <input name=email><input type=submit value=OK></form></section> was picked, and its OK clicked.
  const newsletter = box({
    selector: 'html > body > section.newsletter-banner', idClass: ' newsletter-banner', consentText: false, privacyText: true,
    hasTextEntry: true, controls: [ctl({ tag: 'INPUT', type: 'submit', inForm: true, label: 'OK', selector: 'html > body > section > form > input:nth-of-type(2)' })],
  });
  check('cmp-pick: the newsletter section is not detected as a consent banner', pickGenericCmp([newsletter]).detected === false);

  // F10 repro: a real #cookie-banner (accept only) and, later, a footer "notice" with an "I agree" control.
  const banner = box({ selector: '#cookie-banner', idClass: 'cookie-banner ', controls: [ctl({ label: 'Accept', selector: '#cookie-accept' })] });
  const footerForm = box({
    selector: 'html > body > footer > div.footer-notice', idClass: ' footer-notice',
    controls: [ctl({ label: 'I agree', inForm: true, selector: 'html > body > footer > div > form > button' })],
  });
  const footerBtn = box({
    selector: 'html > body > footer > div.footer-notice', idClass: ' footer-notice',
    controls: [ctl({ type: 'button', label: 'I agree', selector: 'html > body > footer > div > button' })],
  });
  const pickA = pickGenericCmp([banner, footerForm]);
  check('cmp-pick: a later footer notice whose "I agree" submits a form never wins over the real banner',
    pickA.presenceSelector === '#cookie-banner' && pickA.accept?.selector === '#cookie-accept', JSON.stringify(pickA));
  const pickB = pickGenericCmp([banner, footerBtn]);
  check('cmp-pick: an earlier #cookie-banner beats a later generic .footer-notice (no more last-match-wins)',
    pickB.presenceSelector === '#cookie-banner', JSON.stringify(pickB));
  const pickC = pickGenericCmp([footerBtn, banner]);
  check('cmp-pick: a cookie-named container outranks an earlier generic notice',
    pickC.presenceSelector === '#cookie-banner', JSON.stringify(pickC));
  const first = box({ selector: '#a', idClass: 'cookie-a ', controls: [ctl({ selector: '#a-ok' })] });
  const second = box({ selector: '#b', idClass: 'cookie-b ', controls: [ctl({ selector: '#b-ok' })] });
  check('cmp-pick: between equals, the first in document order wins', pickGenericCmp([first, second]).presenceSelector === '#a');
  const both = box({
    selector: '#c', idClass: 'site-notice ',
    controls: [ctl({ selector: '#c-yes' }), ctl({ label: 'Reject all', selector: '#c-no' })],
  });
  const pickD = pickGenericCmp([first, both]);
  check('cmp-pick: a banner offering both accept and reject ranks first',
    pickD.presenceSelector === '#c' && pickD.accept?.selector === '#c-yes' && pickD.reject?.selector === '#c-no', JSON.stringify(pickD));
  const mixed = box({
    selector: '#d', controls: [ctl({ label: 'OK', inForm: true, selector: '#d-form-ok' }), ctl({ label: 'Accept', selector: '#d-accept' })],
  });
  check('cmp-pick: a form-submit control is skipped, the banner\'s real button is used', pickGenericCmp([mixed]).accept?.selector === '#d-accept');
  check('cmp-pick: nothing eligible → not detected', pickGenericCmp([box({ controls: [ctl({ tag: 'A', href: '/x' })] })]).detected === false);
  check('cmp-pick: junk from the page is not detected', pickGenericCmp(null as unknown as CmpContainerFacts[]).detected === false);
}

// ── CMP heuristic click: what the network guard refuses (pure) ───────────────────────────────────
{
  const page = 'https://acme.example/pricing';
  check('cmp-net: a form POST / API write is refused',
    ['POST', 'PUT', 'PATCH', 'DELETE', 'post'].every((method) => blockDuringCmpClick({ method, url: 'https://acme.example/subscribe', mainFrameNavigation: false, pageUrl: page })));
  check('cmp-net: a POST navigation (form submit) is refused', blockDuringCmpClick({ method: 'POST', url: page, mainFrameNavigation: true, pageUrl: page }));
  check('cmp-net: a main-frame navigation to another page is refused',
    blockDuringCmpClick({ method: 'GET', url: 'https://acme.example/subscribe?email=', mainFrameNavigation: true, pageUrl: page }));
  check('cmp-net: a plain reload of the same page is let through (banners that reload to apply consent)',
    !blockDuringCmpClick({ method: 'GET', url: page, mainFrameNavigation: true, pageUrl: page + '#top' }));
  check('cmp-net: subresource GETs (post-consent tags, scripts) are untouched',
    !blockDuringCmpClick({ method: 'GET', url: 'https://region1.google-analytics.com/g/collect?v=2&en=page_view', mainFrameNavigation: false, pageUrl: page }) &&
    !blockDuringCmpClick({ method: 'HEAD', url: 'https://acme.example/x.js', mainFrameNavigation: false, pageUrl: page }));
}

// ── interactWithCmp against a fake page ──────────────────────────────────────────────────────────
{
  type Handler = (route: unknown) => Promise<void>;
  const facts = [box({ selector: '#cookie-banner', idClass: 'cookie-banner ', controls: [ctl({ label: 'Accept', selector: '#cookie-banner > button' })] })];
  const heuristic: CmpDetection = {
    detected: true, vendorName: 'Custom / unknown CMP', presenceSelector: '#cookie-banner',
    accept: { selector: '#cookie-banner > button', text: 'Accept' }, rejectOnFirstLayer: false, method: 'heuristic',
  };
  const fake = (opts: { facts?: CmpContainerFacts[]; mainVisible?: boolean; routeFails?: boolean; armFails?: boolean } = {}) => {
    const state = {
      calls: [] as string[], clicked: [] as string[], routed: [] as Handler[], unrouted: [] as unknown[], framesUsed: 0, queried: [] as string[],
    };
    const mainFrame = { main: true };
    const el = (name: string, visibleEl: boolean) => ({
      isVisible: async () => visibleEl,
      click: async () => { state.clicked.push(name); },
    });
    const page = {
      url: () => 'https://acme.example/',
      mainFrame: () => mainFrame,
      route: async (_p: string, h: Handler) => {
        if (opts.routeFails) throw new Error('route unavailable');
        state.calls.push('route');
        state.routed.push(h);
      },
      unroute: async (_p: string, h: unknown) => { state.calls.push('unroute'); state.unrouted.push(h); },
      evaluate: async (fn: { name: string }) => {
        state.calls.push(fn.name);
        if (fn.name === 'armCmpClickGuards') {
          if (opts.armFails) throw new Error('page closed');
          return true;
        }
        if (fn.name === 'gatherCmpFactsInPage') return opts.facts ?? facts;
        if (fn.name === 'markCmpTarget' || fn.name === 'disarmCmpClickGuards') return true;
        return undefined;
      },
      $: async (selector: string) => {
        state.queried.push(selector);
        state.calls.push('$');
        return el('main:' + selector, opts.mainVisible ?? true);
      },
      // An iframe (ad, embed) whose element matches any selector: the heuristic must never reach it.
      frames: () => {
        state.framesUsed += 1;
        return [{ url: () => 'https://ads.example/', $: async () => el('iframe', true) }];
      },
    };
    return { page: page as unknown as PwPage, state, mainFrame };
  };

  {
    const { page, state, mainFrame } = fake();
    const res = await interactWithCmp(page, heuristic, 'accept');
    check('cmp-click: a heuristic banner button is clicked', res.clicked === true && state.clicked.length === 1, JSON.stringify(res));
    check('cmp-click: the click goes to the marked element in the main frame, never an iframe',
      state.framesUsed === 0 && state.queried.length === 1 && state.queried[0].startsWith('[data-wa-cmp-target='), JSON.stringify(state.queried));
    check('cmp-click: network guard, then in-page guards, then a re-scan, then the click; all undone after',
      state.calls.join(',') === 'route,armCmpClickGuards,gatherCmpFactsInPage,markCmpTarget,$,disarmCmpClickGuards,unroute', state.calls.join(','));
    check('cmp-click: the same network handler is installed and removed', state.routed.length === 1 && state.unrouted[0] === state.routed[0]);

    const handler = state.routed[0];
    const drive = async (req: { url: string; method: string; nav: boolean; frame: unknown }): Promise<string> => {
      let outcome = '';
      await handler({
        request: () => ({ url: () => req.url, method: () => req.method, isNavigationRequest: () => req.nav, frame: () => req.frame }),
        abort: async (code?: string) => { outcome = `abort:${code ?? ''}`; },
        fallback: async () => { outcome = 'fallback'; },
      });
      return outcome;
    };
    check('cmp-click/network: a main-frame navigation off the page is aborted',
      (await drive({ url: 'https://acme.example/subscribe', method: 'GET', nav: true, frame: mainFrame })) === 'abort:aborted');
    check('cmp-click/network: a form POST is aborted',
      (await drive({ url: 'https://acme.example/subscribe', method: 'POST', nav: true, frame: mainFrame })) === 'abort:aborted');
    check('cmp-click/network: a reload of the page falls through to the SSRF guard',
      (await drive({ url: 'https://acme.example/', method: 'GET', nav: true, frame: mainFrame })) === 'fallback');
    check('cmp-click/network: an iframe loading after consent falls through to the SSRF guard',
      (await drive({ url: 'https://www.youtube.com/embed/x', method: 'GET', nav: true, frame: { child: true } })) === 'fallback');
  }
  {
    // F31: the main-frame match is hidden; the old code then clicked the first visible match in ANY frame.
    const { page, state } = fake({ mainVisible: false });
    const res = await interactWithCmp(page, heuristic, 'accept');
    check('cmp-click: a hidden main-frame match is NOT replaced by an iframe element', res.clicked === false && state.clicked.length === 0 && state.framesUsed === 0,
      JSON.stringify({ res, clicked: state.clicked }));
  }
  {
    const moved = [box({ selector: '#cookie-banner', idClass: 'cookie-banner ', controls: [ctl({ label: 'Accept', selector: 'html > body > div:nth-of-type(2) > button' })] })];
    const { page, state } = fake({ facts: moved });
    const res = await interactWithCmp(page, heuristic, 'accept');
    check('cmp-click: if the re-scan no longer picks the same control, nothing is clicked',
      res.clicked === false && state.clicked.length === 0 && /changed/.test(res.note ?? ''), JSON.stringify(res));
    check('cmp-click: ...and the guards are still undone', state.calls.includes('disarmCmpClickGuards') && state.unrouted.length === 1);
  }
  {
    const { page, state } = fake({ routeFails: true });
    const res = await interactWithCmp(page, heuristic, 'accept');
    check('cmp-click: no network guard → nothing armed or clicked (fails closed)', res.clicked === false && state.calls.length === 0 && state.clicked.length === 0);
  }
  {
    const { page, state } = fake({ armFails: true });
    const res = await interactWithCmp(page, heuristic, 'accept');
    check('cmp-click: in-page guards not armed → nothing clicked, network guard removed',
      res.clicked === false && state.clicked.length === 0 && state.unrouted.length === 1);
  }
  {
    // The vendor path is unchanged: registry selectors, iframe fallback kept (TrustArc / TCF render in one).
    const { page, state } = fake({ mainVisible: false });
    const vendor: CmpDetection = {
      detected: true, vendorId: 'trustarc', vendorName: 'TrustArc', presenceSelector: '#truste-consent-track',
      accept: { selector: '#truste-consent-button' }, rejectOnFirstLayer: false, method: 'vendor',
    };
    const res = await interactWithCmp(page, vendor, 'accept');
    check('cmp-click: vendor CMPs keep the registry click (and its iframe fallback), unguarded',
      res.clicked === true && state.clicked.join() === 'iframe' && state.routed.length === 0 && state.queried[0] === '#truste-consent-button',
      JSON.stringify({ res, state }));
  }
}

// ── crawler helpers ─────────────────────────────────────────────────────────

check('crawl: same host', sameSite('https://example.com/a', 'https://example.com'));
check('crawl: www variant', sameSite('https://www.example.com/a', 'https://example.com'));
check('crawl: subdomain ok', sameSite('https://shop.example.com', 'https://example.com'));
check('crawl: other host rejected', !sameSite('https://other.com', 'https://example.com'));
check('crawl: asset skipped', normalizeUrl('/logo.png', 'https://example.com') === null);
check('crawl: mailto skipped', normalizeUrl('mailto:x@y.z', 'https://example.com') === null);
check('crawl: hash stripped', normalizeUrl('https://example.com/a#frag', 'https://example.com') === 'https://example.com/a');
check('crawl: contact prioritised', urlPriority('https://x.com/contact-us') > urlPriority('https://x.com/blog/post'));
// Broadened FORMY_RE tokens (kept in sync with scan-core.ts) are all prioritised.
check('crawl: broadened form tokens prioritised',
  ['https://x.com/free-audit', 'https://x.com/consultation', 'https://x.com/get-started', 'https://x.com/pricing', 'https://x.com/schedule-a-demo', 'https://x.com/services']
    .every((u) => urlPriority(u) === 1) && urlPriority('https://x.com/about') === 0);
// /careers carries the "Apply for … " form — must be prioritised so its form is discovered.
check('crawl: careers page prioritised (has the apply form)', urlPriority('https://x.com/careers') === 1 && urlPriority('https://x.com/jobs') === 1);

// ── form analysis ───────────────────────────────────────────────────────────

function field(over: Partial<RawFormField>): RawFormField {
  return { tag: 'input', type: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '', required: false, ...over };
}
function form(over: Partial<RawForm>): RawForm {
  const fields = over.fields ?? [];
  return { index: 0, action: 'https://example.com/submit', method: 'post', formId: '', formName: '', formClasses: '', title: '', fieldCount: fields.length, fields, hasPrivacyLink: false, text: '', ...over };
}

check('pii: email by type', classifyFieldPii(field({ type: 'email' })) === 'email');
check('pii: phone by name', classifyFieldPii(field({ name: 'phone_number' })) === 'phone');
check('pii: name by label', classifyFieldPii(field({ label: 'First name' })) === 'name');
check('pii: dob by label', classifyFieldPii(field({ label: 'Date of birth' })) === 'date_of_birth');
check('pii: payment by autocomplete', classifyFieldPii(field({ autocomplete: 'cc-number' })) === 'payment');
check('pii: plain text not pii', classifyFieldPii(field({ name: 'company_size' })) === null);

// ── form-fill: role classification (Option 2 — from the form's OWN fields) ───────────────────────
check('role: email by type', classifyFieldRole(field({ type: 'email' })) === 'email');
check('role: phone by autocomplete', classifyFieldRole(field({ autocomplete: 'tel' })) === 'phone');
check('role: first name → given_name', classifyFieldRole(field({ label: 'First Name' })) === 'given_name');
check('role: last name → family_name', classifyFieldRole(field({ name: 'last_name' })) === 'family_name');
check('role: full/your name → full_name', classifyFieldRole(field({ label: 'Your Name' })) === 'full_name');
check('role: company distinct from name', classifyFieldRole(field({ label: 'Company Name' })) === 'company');
check('role: city vs state vs postal vs country', classifyFieldRole(field({ name: 'city' })) === 'city'
  && classifyFieldRole(field({ label: 'State / Province' })) === 'state'
  && classifyFieldRole(field({ name: 'zip' })) === 'postal'
  && classifyFieldRole(field({ autocomplete: 'country-name' })) === 'country');
check('role: textarea → message', classifyFieldRole(field({ tag: 'textarea', type: 'textarea' })) === 'message');
check('role: subject before message', classifyFieldRole(field({ label: 'Subject' })) === 'subject');
check('role: a category select → select', classifyFieldRole(field({ tag: 'select', type: 'select-one', name: 'category', options: ['A', 'B'] })) === 'select');
check('role: privacy checkbox → consent', classifyFieldRole(field({ type: 'checkbox', label: 'I agree to the privacy policy' })) === 'consent');
check('role: marketing checkbox → marketing_opt_in', classifyFieldRole(field({ type: 'checkbox', label: 'Send me the newsletter' })) === 'marketing_opt_in');
// Honeypot (anti-spam) fields — filling them makes the site silently reject the submit (form_start
// fires but form_submission never does). Detect by name AND by a hidden text-style field.
check('role: honeypot by name → honeypot', classifyFieldRole(field({ name: 'honeypot', label: 'Leave this empty' })) === 'honeypot');
check('role: honeypot by hp name → honeypot', classifyFieldRole(field({ name: 'contact_hp' })) === 'honeypot');
check('role: hidden text field (off-screen honeypot, innocuous name) → honeypot', classifyFieldRole(field({ name: 'b_1a2b_3c4d', hidden: true })) === 'honeypot');
check('role: "php" name is NOT a honeypot (hp bounded)', classifyFieldRole(field({ name: 'php_nonce' })) !== 'honeypot');
check('role: a VISIBLE email named honeypot-ish is still classified normally when hidden=false', classifyFieldRole(field({ type: 'email', name: 'work_email' })) === 'email');
// buildFillPlan must DROP honeypots (not shown, not filled).
{
  const plan = buildFillPlan([
    field({ type: 'email', name: 'email', required: true }),
    field({ name: 'honeypot', label: 'honeypot' }),
    field({ name: 'website_url', hidden: true }), // off-screen honeypot with an innocuous name
  ], US_LOCALE, { emailTag: 'r' });
  check('fill: honeypot fields are dropped from the plan', plan.length === 1 && plan[0].name === 'email');
  check('fill: no dropped field is left with a value', !plan.some((p) => p.role === 'honeypot'));
}

// ── form-fill: plan values (US locale) ───────────────────────────────────────────────────────────
{
  const fields: RawFormField[] = [
    field({ type: 'email', name: 'email', required: true }),
    field({ label: 'First Name', name: 'fname', required: true }),
    field({ label: 'Last Name', name: 'lname' }),
    field({ type: 'tel', name: 'phone' }),
    field({ tag: 'select', type: 'select-one', name: 'country', options: ['Please select', 'Canada', 'United States', 'Mexico'] }),
    field({ tag: 'select', type: 'select-one', name: 'category', options: ['-- Choose --', 'Sales', 'Support'] }),
    field({ tag: 'textarea', type: 'textarea', name: 'message' }),
    field({ type: 'checkbox', label: 'I accept the terms', name: 'consent', required: true }),
  ];
  const plan = buildFillPlan(fields, US_LOCALE, { emailTag: 'run1' });
  const byName = (n: string): (typeof plan)[number] | undefined => plan.find((p) => p.name === n);
  check('fill: email is test@gmail.com (+tag only when a tag is supplied)', byName('email')?.value === 'test+run1@gmail.com');
  check('fill: email is plain test@gmail.com by default (no tag)', buildFillPlan(fields).find((p) => p.name === 'email')?.value === 'test@gmail.com');
  check('fill: given/family names are simple Test values', byName('fname')?.value === 'Test' && byName('lname')?.value === 'Test');
  check('fill: phone is the simple test number', byName('phone')?.value === '1234567890');
  check('fill: country select picks the matching real option', byName('country')?.value === 'United States');
  check('fill: category select skips the placeholder, picks first real option', byName('category')?.value === 'Sales');
  check('fill: message gets the simple test text', byName('message')?.value === 'test form please ignore');
  check('fill: required consent checkbox → checked', byName('consent')?.value === 'true');
  check('fill: selector is name-based', byName('email')?.selector === '[name="email"]');
  check('fill: required flag carried through', byName('email')?.required === true && byName('lname')?.required === false);
  check('fill: options carried onto select rows', (byName('country')?.options ?? []).includes('Mexico'));
}
check('fill: unknown locale id falls back to US', localeById('zz').id === 'us');
check('fill: selectorFor prefers name then id', selectorFor(field({ name: 'x' })) === '[name="x"]' && selectorFor(field({ id: 'y' })) === '#y');

const contactForm = form({
  index: 0,
  fields: [
    field({ type: 'email', name: 'email' }),
    field({ name: 'full_name', label: 'Full name' }),
    field({ tag: 'textarea', type: 'textarea', name: 'message' }),
  ],
});
const contactAnalysis = analyzeForms([contactForm], 'https://example.com/contact')[0];
check('forms: contact purpose', contactAnalysis.purpose === 'contact');
check('forms: pii without notice flagged', contactAnalysis.issues.some((i) => i.id.includes('pii_no_notice')));

// A single EMAIL input (newsletter signup) must NOT be misread as a search box, even if named "s"/"q".
const loneEmailMkt = form({ index: 9, fields: [field({ type: 'email', name: 's' })], fieldCount: 1, text: 'subscribe to our newsletter for product updates' });
check('forms: lone email signup → newsletter, not search', analyzeForms([loneEmailMkt], 'https://example.com')[0].purpose === 'newsletter');
// A LONE email input (even named "q", no marketing copy) is the canonical newsletter shape — a box that
// captures nothing but an address. It must be classified 'newsletter' (broadened Fix B rule), and above
// all must NOT be misrouted to 'search' by its name. (Was 'contact' before Fix B; a bare email capture
// is a subscription, not a contact form.)
const loneEmailPlain = form({ index: 10, fields: [field({ type: 'email', name: 'q' })], fieldCount: 1, text: '' });
const loneEmailPlainPurpose = analyzeForms([loneEmailPlain], 'https://example.com')[0].purpose;
check('forms: lone email (no marketing copy) → newsletter, not search', loneEmailPlainPurpose === 'newsletter');

// Fix B: an email+name box whose visible text lacks a MARKETING_RE keyword but carries a sign-up VERB
// ("Sign up") is a newsletter subscription, not a contact form (2 text inputs, no message).
const emailNameSignup = form({ index: 11, fields: [field({ type: 'email', name: 'email' }), field({ name: 'first_name', label: 'First name' })], text: 'sign up for the latest' });
check('forms: email+name with a "Sign up" verb → newsletter (no marketing keyword needed)', analyzeForms([emailNameSignup], 'https://example.com')[0].purpose === 'newsletter');
// A REAL contact form (email+name+message textarea) is NEVER pulled into newsletter — the !hasMessage guard.
const emailNameMessage = form({ index: 12, fields: [field({ type: 'email', name: 'email' }), field({ name: 'name', label: 'Name' }), field({ tag: 'textarea', type: 'textarea', name: 'message' })], text: 'sign up and subscribe to our newsletter' });
check('forms: email+name+message (a message field) → still contact even with marketing/sign-up copy', analyzeForms([emailNameMessage], 'https://example.com')[0].purpose === 'contact');
// >=3 text inputs (a fuller lead form) is not a newsletter box → contact, even with a sign-up verb.
const emailThreeFields = form({ index: 13, fields: [field({ type: 'email', name: 'email' }), field({ name: 'name', label: 'Name' }), field({ type: 'tel', name: 'phone' })], text: 'sign up now' });
check('forms: email + 3 text fields → still contact (too many inputs for a newsletter box)', analyzeForms([emailThreeFields], 'https://example.com')[0].purpose === 'contact');
// The earlier lone-text-search branch is unchanged: a lone text input named "s" is still a search box.
const searchBox = form({ index: 14, fields: [field({ type: 'text', name: 's' })], fieldCount: 1, action: 'https://example.com/?s=', text: '' });
check('forms: a lone text search box (name "s") → still search (unchanged, that branch is earlier)', analyzeForms([searchBox], 'https://example.com')[0].purpose === 'search');

// Fix B refinement (adversarial review): "join" is scoped to a list — a careers/RSVP/waitlist lead
// capture (email+name, "Join our team" / "Join the waitlist") is NOT a newsletter.
const joinTeam = form({ index: 15, fields: [field({ type: 'email', name: 'email' }), field({ name: 'name', label: 'Name' })], text: 'join our team — apply now' });
check('forms: email+name "Join our team" (careers) → contact, not newsletter', analyzeForms([joinTeam], 'https://example.com')[0].purpose === 'contact');
const joinWaitlist = form({ index: 16, fields: [field({ type: 'email', name: 'email' }), field({ name: 'name', label: 'Name' })], text: 'join the waitlist' });
check('forms: email+name "Join the waitlist" (lead) → contact, not newsletter', analyzeForms([joinWaitlist], 'https://example.com')[0].purpose === 'contact');
// A subscription "join" still classifies as newsletter.
const joinNews = form({ index: 17, fields: [field({ type: 'email', name: 'email' }), field({ name: 'name', label: 'Name' })], text: 'join our newsletter for weekly tips' });
check('forms: email+name "Join our newsletter" → newsletter (subscription join still matches)', analyzeForms([joinNews], 'https://example.com')[0].purpose === 'newsletter');
// A passwordless / magic-link login (lone email, "log in" copy, no password) → login, NOT newsletter.
const magicLink = form({ index: 18, fields: [field({ type: 'email', name: 'email' })], fieldCount: 1, text: 'log in — email me a login link' });
check('forms: lone email magic-link login ("log in") → login, not newsletter', analyzeForms([magicLink], 'https://example.com')[0].purpose === 'login');
// A <select> is extracted with its DOM type ('select-one' / 'select-multiple'), never a bare 'select'.
// It is not a text input, so a dropdown must not tip the one-/two-input purpose rules (was: counted).
const searchWithCategory = form({ index: 19, fields: [field({ type: 'text', name: 's' }), field({ tag: 'select', type: 'select-one', name: 'category' })], action: 'https://example.com/?s=', text: '' });
check('forms: a search box with a category dropdown → still search', analyzeForms([searchWithCategory], 'https://example.com')[0].purpose === 'search');
const emailWithCountry = form({ index: 20, fields: [field({ type: 'email', name: 'email' }), field({ tag: 'select', type: 'select-one', name: 'country' })], text: '' });
check('forms: a lone email plus a country dropdown → newsletter, not contact', analyzeForms([emailWithCountry], 'https://example.com')[0].purpose === 'newsletter');
const magicLinkWithSelects = form({ index: 21, fields: [field({ type: 'email', name: 'email' }), field({ tag: 'select', type: 'select-one', name: 'region' }), field({ tag: 'select', type: 'select-multiple', name: 'workspace' })], text: 'log in with a magic link' });
check('forms: a magic-link login with two dropdowns → still login', analyzeForms([magicLinkWithSelects], 'https://example.com')[0].purpose === 'login');

const noticedForm = form({ index: 1, fields: contactForm.fields, hasPrivacyLink: true });
check(
  'forms: privacy link suppresses notice issue',
  analyzeForms([noticedForm], 'https://example.com')[0].issues.every((i) => !i.id.includes('pii_no_notice')),
);

const newsletterForm = form({
  index: 2,
  fields: [
    field({ type: 'email', name: 'email' }),
    field({ type: 'checkbox', name: 'newsletter_optin', label: 'Subscribe to our newsletter', checked: true }),
  ],
  text: 'subscribe to our newsletter for updates',
  hasPrivacyLink: true,
});
const newsletterAnalysis = analyzeForms([newsletterForm], 'https://example.com')[0];
check('forms: prechecked marketing flagged high', newsletterAnalysis.issues.some((i) => i.id.includes('prechecked_marketing') && i.severity === 'high'));
check('forms: marketing checkbox captured', newsletterAnalysis.marketingCheckboxes.length === 1 && newsletterAnalysis.marketingCheckboxes[0].prechecked);

const loginForm = form({
  index: 3,
  fields: [field({ type: 'email', name: 'email' }), field({ type: 'password', name: 'password' })],
});
const loginAnalysis = analyzeForms([loginForm], 'https://example.com/login')[0];
check('forms: login purpose', loginAnalysis.purpose === 'login');
check('forms: login exempt from notice rule', loginAnalysis.issues.every((i) => !i.id.includes('pii_no_notice')));

const thirdPartyForm = form({ index: 4, action: 'https://lists.mailvendor.io/subscribe', fields: [field({ type: 'email', name: 'email' })], hasPrivacyLink: true });
check('forms: third-party action flagged', analyzeForms([thirdPartyForm], 'https://example.com')[0].issues.some((i) => i.id.includes('third_party_action')));

const insecureForm = form({ index: 5, action: 'http://example.com/submit', fields: [field({ type: 'email', name: 'email' })], hasPrivacyLink: true });
check('forms: insecure action flagged', analyzeForms([insecureForm], 'https://example.com')[0].issues.some((i) => i.id.includes('insecure_action') && i.severity === 'high'));

// ── consent event extraction ────────────────────────────────────────────────

const dlLog = [
  { t: 12, entry: ['consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }] },
  { t: 300, entry: { event: 'gtm.js' } },
  { t: 4200, entry: ['consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted' }] },
  { t: 4300, entry: ['event', 'page_view', {}] },
];
const consentEvents = extractConsentEvents(dlLog);
check('dl: consent default extracted', consentEvents[0]?.kind === 'default' && consentEvents[0]?.fields.ad_storage === 'denied' && consentEvents[0]?.tMs === 12);
check('dl: consent update extracted', consentEvents[1]?.kind === 'update' && consentEvents[1]?.fields.analytics_storage === 'granted');
check('dl: event names', extractEventNames(dlLog).join(',') === 'gtm.js,page_view');

// ── banner rules over fixture captures ─────────────────────────────────────

function hit(over: Partial<ScenarioCapture['trackerHits'][number]>): ScenarioCapture['trackerHits'][number] {
  return { url: 'https://region1.google-analytics.com/g/collect?v=2', method: 'POST', ids: ['ga4_collect'], groups: ['ga4'], tMs: 1000, resourceType: 'fetch', ...over };
}
function capture(over: Partial<ScenarioCapture>): ScenarioCapture {
  return {
    scenario: 'ignore',
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    httpStatus: 200,
    cmp: { detected: true, vendorName: 'OneTrust', vendorId: 'onetrust', accept: { selector: '#onetrust-accept-btn-handler' }, rejectOnFirstLayer: false, method: 'vendor' },
    interaction: null,
    interactionTMs: null,
    trackerHits: [],
    networkRequestCount: 10,
    consentEvents: [],
    dataLayerEvents: [],
    dataLayerKeys: [],
    cookiesPreInteraction: [],
    cookiesFinal: [],
    consoleErrors: [],
    pageErrors: [],
    forms: null,
    notes: [],
    ...over,
  };
}

check('rules: firing hit detection', isFiringHit(hit({})));
check('rules: gtm.js not firing', !isFiringHit(hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })));
check('rules: fbevents.js not firing', !isFiringHit(hit({ url: 'https://connect.facebook.net/en_US/fbevents.js', ids: ['meta_pixel'], groups: ['meta'] })));
check('rules: fb /tr firing', isFiringHit(hit({ url: 'https://www.facebook.com/tr?id=1', ids: ['meta_pixel'], groups: ['meta'] })));
check('rules: gcs G100 denied', gcsIndicatesDenied(hit({ query: { gcs: 'G100' } })));
check('rules: gcs G111 not denied', !gcsIndicatesDenied(hit({ query: { gcs: 'G111' } })));

// Pre-consent fire (no gcs) → critical.
const preConsent = evaluateBannerRules([capture({ trackerHits: [hit({})] })]);
check('rules: preconsent fire critical', preConsent.some((f) => f.id.startsWith('banner_preconsent_fire') && f.severity === 'critical'));
check('rules: no reject first layer flagged', preConsent.some((f) => f.id === 'banner_no_reject_first_layer'));

// Pre-consent cookieless ping (gcs=G100) → info, not critical.
const advanced = evaluateBannerRules([capture({ trackerHits: [hit({ query: { gcs: 'G100' } })] })]);
check('rules: advanced pings are info', advanced.some((f) => f.id.startsWith('banner_advanced_pings') && f.severity === 'info'));
check('rules: advanced pings not critical', !advanced.some((f) => f.severity === 'critical'));

// Fires after reject → critical; cookies after reject → high; no update → medium.
const rejectCapture = capture({
  scenario: 'reject',
  cmp: { detected: true, vendorName: 'OneTrust', rejectOnFirstLayer: true, accept: { selector: '#a' }, reject: { selector: '#r' }, method: 'vendor' },
  interaction: { action: 'reject', clicked: true, selector: '#onetrust-reject-all-handler', tMs: 5000 },
  interactionTMs: 5000,
  trackerHits: [hit({ tMs: 6500 })],
  cookiesFinal: ['_ga', '_fbp', 'session_id'],
});
const rejectFindings = evaluateBannerRules([rejectCapture]);
check('rules: fires after reject critical', rejectFindings.some((f) => f.id.startsWith('banner_fires_after_reject') && f.severity === 'critical'));
check('rules: cookies after reject high', rejectFindings.some((f) => f.id.startsWith('banner_cookies_after_reject') && f.severity === 'high'));
check('rules: reject without update flagged', rejectFindings.some((f) => f.id.startsWith('banner_reject_no_update')));
check('rules: session cookie not flagged as tracking', !rejectFindings.some((f) => f.finding.includes('session_id')));

// Compliant site: banner, no pre-consent firing, update on reject, no cookies.
const compliantReject = capture({
  scenario: 'reject',
  cmp: { detected: true, vendorName: 'Cookiebot (Usercentrics)', rejectOnFirstLayer: true, accept: { selector: '#a' }, reject: { selector: '#r' }, method: 'vendor' },
  interaction: { action: 'reject', clicked: true, selector: '#r', tMs: 5000 },
  interactionTMs: 5000,
  consentEvents: [
    { kind: 'default', tMs: 10, fields: { ad_storage: 'denied', analytics_storage: 'denied' } },
    { kind: 'update', tMs: 5100, fields: { ad_storage: 'denied', analytics_storage: 'denied' } },
  ],
  trackerHits: [hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })],
});
const compliantFindings = evaluateBannerRules([
  capture({
    cmp: compliantReject.cmp,
    consentEvents: [{ kind: 'default', tMs: 10, fields: { ad_storage: 'denied', analytics_storage: 'denied' } }],
    trackerHits: [hit({ url: 'https://www.googletagmanager.com/gtm.js', ids: ['gtm_loader'], groups: ['gtm'] })],
  }),
  compliantReject,
]);
check('rules: compliant site has no critical/high', compliantFindings.every((f) => f.severity !== 'critical' && f.severity !== 'high'), JSON.stringify(compliantFindings.map((f) => f.id)));

// No CMP but trackers fire → high.
const noCmp = evaluateBannerRules([capture({ cmp: { detected: false, rejectOnFirstLayer: false }, trackerHits: [hit({})] })]);
check('rules: missing cmp flagged', noCmp.some((f) => f.id === 'banner_missing_cmp' && f.severity === 'high'));

// Form findings flow through.
const formCapture = capture({
  forms: analyzeForms([newsletterForm], 'https://example.com'),
});
check('rules: form findings mapped', evaluateFormFindings([formCapture]).some((f) => f.domain === 'forms' && f.severity === 'high'));

// ── scoring ────────────────────────────────────────────────────────────────

check('score: clean = 100', scoreFindings([]).score === 100 && scoreFindings([]).verdict === 'compliant_looking');
const scored = scoreFindings(sortFindings(preConsent));
check('score: violations reduce score', scored.score < 100);
const sorted = sortFindings([...noCmp, ...advanced]);
check('sort: severity order', sorted[0].severity === 'high' && sorted[sorted.length - 1].severity === 'info');

// ── engine bridge ───────────────────────────────────────────────────────────

const runtime = buildRuntimeInput([capture({ trackerHits: [hit({})] }), rejectCapture]);
check('bridge: states mapped', runtime.states.includes('unknown') && runtime.states.includes('default_denied'));
check('bridge: pages mapped', runtime.pages.length === 2 && runtime.pages[0].trackerHits?.length === 1);
check('bridge: firstMeasurementTMs', runtime.pages[0].firstMeasurementTMs === 1000);
check('bridge: ok flag', runtime.ok === true);

const engineFindings = runConsentRuntimeRules(runtime);
check('bridge: engine accepts runtime input', Array.isArray(engineFindings));
check('bridge: engine emits consent findings', engineFindings.every((f) => f.domain === 'consent'));

// ── GTM container bridge (reconciled coverage) ──────────────────────────────

// A "full" export_container payload: raw GTM API objects with parameters and
// per-tag consentSettings present.
const fullContainer = {
  exportedAt: '2026-06-15T00:00:00Z',
  workspace: { name: 'Default Workspace' },
  tags: [
    {
      tagId: '1',
      name: 'GA4 Configuration',
      type: 'gaawc',
      parameter: [{ key: 'measurementId', value: 'G-ABC123' }],
      consentSettings: { consentStatus: 'NEEDED' },
      firingTriggerId: ['2147479553'],
    },
    {
      tagId: '2',
      name: 'Meta Pixel Base',
      type: 'html',
      parameter: [{ key: 'html', value: '<script>fbq("init","123")</script>' }],
      consentSettings: { consentStatus: 'NOT_SET' },
    },
  ],
  triggers: [{ triggerId: '2147479553', name: 'Consent Initialization All Pages', type: 'consentInit' }],
  variables: [
    { variableId: '1', name: 'Consent — ad_storage', type: 'k', parameter: [{ key: 'name', value: 'ad_storage' }] },
  ],
};

const parsed = parseGtmContainer(fullContainer);
check('gtm: tags parsed', parsed.tags.length === 2);
check('gtm: triggers parsed', parsed.triggers.length === 1);
check('gtm: variables parsed', parsed.variables.length === 1);
check('gtm: textBlob lowercased + includes tag name', parsed.textBlob.includes('ga4 configuration'));
check('gtm: textBlob includes param value', parsed.textBlob.includes('g-abc123'));
check('gtm: textBlob includes variable param', parsed.textBlob.includes('ad_storage'));
check('gtm: textBlob excludes trigger names', !parsed.textBlob.includes('consent initialization all pages'));
check('gtm: usageContexts default empty', parsed.usageContexts.length === 0);

// Nested under a `container` key, with usageContext.
const nested = parseGtmContainer({ container: { usageContext: ['SERVER'], tags: fullContainer.tags, triggers: [], variables: [] } });
check('gtm: nested container tags', nested.tags.length === 2);
check('gtm: usageContexts lowercased', nested.usageContexts.join(',') === 'server');

// Defensive rejections.
let summaryRejected = false;
try {
  parseGtmContainer({ tags: [{ tagId: '1', name: 'GA4', type: 'gaawc', paramCount: 3 }], triggers: [], variables: [] });
} catch (e) {
  summaryRejected = e instanceof GtmContainerError;
}
check('gtm: summary export rejected', summaryRejected);

let emptyRejected = false;
try {
  parseGtmContainer({});
} catch (e) {
  emptyRejected = e instanceof GtmContainerError;
}
check('gtm: empty object rejected', emptyRejected);

let nullRejected = false;
try {
  parseGtmContainer(null);
} catch (e) {
  nullRejected = e instanceof GtmContainerError;
}
check('gtm: null rejected', nullRejected);

// runConsentEngine: coverage escalation.
const baseCaptures = [capture({ trackerHits: [hit({})] }), rejectCapture];

const engNone = await runConsentEngine(baseCaptures, undefined);
check('engine: no container → runtime_only', engNone.coverage === 'runtime_only');
check('engine: runtime-only findings are consent', engNone.findings.every((f) => f.domain === 'consent'));

const engRecon = await runConsentEngine(baseCaptures, fullContainer);
check('engine: full container → reconciled', engRecon.coverage === 'reconciled', engRecon.coverage);
check('engine: reconciled has no note', engRecon.note === undefined);

const engBad = await runConsentEngine(baseCaptures, { tags: [{ name: 'x', paramCount: 2 }], triggers: [], variables: [] });
check('engine: bad container → runtime_only + note', engBad.coverage === 'runtime_only' && typeof engBad.note === 'string');
check('engine: bad-container note mentions full', /full/i.test(engBad.note ?? ''));

// ── HTTP transport helpers ──────────────────────────────────────────────────

check('http: no token → open', isAuthorized(undefined, ''));
check('http: no token ignores header', isAuthorized('Bearer whatever', ''));
check('http: correct bearer accepted', isAuthorized('Bearer s3cret', 's3cret'));
check('http: wrong bearer rejected', !isAuthorized('Bearer nope', 's3cret'));
check('http: missing header with token rejected', !isAuthorized(undefined, 's3cret'));
check('http: bare token without scheme rejected', !isAuthorized('s3cret', 's3cret'));
check('http: length-mismatch rejected', !isAuthorized('Bearer s3cre', 's3cret'));

const health = buildHealthBody({
  activeSessions: 2,
  playwrightAvailable: true,
  authRequired: true,
  config: loadConfig(),
});
check('http: health status ok', health.status === 'ok' && health.transport === 'http');
check('http: health reports sessions', health.activeSessions === 2);
check('http: health reports playwright + auth', health.playwrightAvailable === true && health.authRequired === true);
check('http: health surfaces config', typeof health.config.interactionEnabled === 'boolean' && Array.isArray(health.config.allowlist));

// ── HTTP transport: sessions ────────────────────────────────────────────────
// REGRESSION: one McpServer was shared by every HTTP session, and McpServer.connect() throws
// "Already connected to a transport" the second time. That throw landed in an Express 4 async
// handler with no try/catch and no process-level net, so a second client's initialize took the
// whole process (and the first client's session) down. Any non-initialize POST without a known
// session id also minted a transport, so it hit the same throw.

check('http: initialize detected', isInitializeRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
check('http: initialize detected inside a batch', isInitializeRequest([{ method: 'tools/list' }, { method: 'initialize' }]));
check(
  'http: non-initialize bodies not detected',
  !isInitializeRequest({ method: 'tools/list' }) && !isInitializeRequest(null) && !isInitializeRequest('initialize'),
);
check('http: known session resumes', decidePostRoute('s1', true, { method: 'tools/list' }).kind === 'resume');
check('http: initialize without session creates', decidePostRoute(undefined, false, { method: 'initialize' }).kind === 'create');
check('http: initialize with a stale session creates', decidePostRoute('gone', false, { method: 'initialize' }).kind === 'create');
check('http: non-initialize without session → unknown', decidePostRoute(undefined, false, { method: 'tools/list' }).kind === 'unknown-session');
check('http: non-initialize with a stale session → unknown', decidePostRoute('gone', false, { method: 'tools/list' }).kind === 'unknown-session');

const webAuditIndexSrc = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
check('http: index hands startHttpServer a factory, not a shared server', /startHttpServer\(createWebAuditMcpServer\)/.test(webAuditIndexSrc));
check('http: index registers an unhandledRejection net', webAuditIndexSrc.includes("process.on('unhandledRejection'"));
check('http: index registers an uncaughtException net', webAuditIndexSrc.includes("process.on('uncaughtException'"));

// Live: a real listener on an ephemeral port, driven over loopback. No browser is launched.
const HTTP_ENV_KEYS = [
  'WEB_AUDIT_HTTP_AUTH_TOKEN',
  'WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED',
  'WEB_AUDIT_HTTP_PORT',
  'PORT',
  'WEB_AUDIT_HTTP_SESSION_TTL_MS',
];
const httpLogs: string[] = [];
async function withHttpEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = HTTP_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of HTTP_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const origError = console.error;
  // The server logs every session open/close to stderr; keep it for assertions, not the console.
  console.error = (...args: unknown[]) => { httpLogs.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = origError;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TEST_HTTP_TOKEN = 'web-audit-test-token';
const MCP_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${TEST_HTTP_TOKEN}`,
};
const initBody = (id: number): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'web-audit-test', version: '0.0.0' } },
  });

await withHttpEnv({ WEB_AUDIT_HTTP_AUTH_TOKEN: TEST_HTTP_TOKEN, WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  const handle = await startHttpServer(createWebAuditMcpServer);
  const base = `http://127.0.0.1:${handle.port}`;
  const post = (body: string, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...extra }, body });
  const activeSessions = async (): Promise<number> =>
    ((await (await fetch(`${base}/health`)).json()) as { activeSessions: number }).activeSessions;
  try {
    const a = await post(initBody(1));
    const aText = await a.text();
    const sidA = a.headers.get('mcp-session-id') ?? '';
    check('http live: first initialize → 200 + session id', a.status === 200 && sidA !== '', `${a.status} ${aText.slice(0, 200)}`);

    const b = await post(initBody(1));
    const bText = await b.text();
    const sidB = b.headers.get('mcp-session-id') ?? '';
    check(
      'http live: SECOND initialize → its own session (was: "Already connected", process exit)',
      b.status === 200 && sidB !== '' && sidB !== sidA,
      `${b.status} ${bText.slice(0, 200)}`,
    );

    const sessionHeaders = (sid: string) => ({ 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' });
    const listA = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), sessionHeaders(sidA));
    const listAText = await listA.text();
    check('http live: first session still serves tools/list', listA.status === 200 && listAText.includes('site_crawl'), `${listA.status} ${listAText.slice(0, 200)}`);
    const listB = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), sessionHeaders(sidB));
    const listBText = await listB.text();
    check('http live: second session serves tools/list', listB.status === 200 && listBText.includes('site_crawl'), `${listB.status} ${listBText.slice(0, 200)}`);

    const orphan = await post(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
    const orphanBody = (await orphan.json()) as { jsonrpc?: string; error?: { code?: number } };
    check('http live: non-initialize without a session → 404 JSON-RPC -32001', orphan.status === 404 && orphanBody.jsonrpc === '2.0' && orphanBody.error?.code === -32001);

    const stale = await post(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), sessionHeaders('no-such-session'));
    const staleBody = (await stale.json()) as { error?: { code?: number } };
    check('http live: stale session id → 404 JSON-RPC -32001', stale.status === 404 && staleBody.error?.code === -32001);

    const before = await activeSessions();
    check('http live: only initialize mints sessions', before === 2, String(before));

    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...MCP_HEADERS, ...sessionHeaders(sidA) } });
    await del.text();
    const after = await activeSessions();
    check('http live: DELETE releases that session only', del.status === 200 && after === 1, `${del.status} active=${after}`);

    const listBAfter = await post(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }), sessionHeaders(sidB));
    const listBAfterText = await listBAfter.text();
    check('http live: the other session survives the DELETE', listBAfter.status === 200 && listBAfterText.includes('site_crawl'), `${listBAfter.status}`);
  } finally {
    await handle.close();
  }
});

// ── HTTP transport: binding ─────────────────────────────────────────────────
// REGRESSION: with WEB_AUDIT_HTTP_AUTH_TOKEN unset, isAuthorized() admits every request and the
// listener bound every interface behind one stderr warning, so /mcp was anonymous to the network.
// Now the server refuses to start unless explicitly opted in, and then binds loopback only.
// isAuthorized() itself is unchanged (the "no token → open" checks above still describe it); the
// gate moved to startup.

const bindNone = resolveHttpBinding({});
check('http bind: no token → refuses to start', typeof bindNone.refuse === 'string' && /WEB_AUDIT_HTTP_AUTH_TOKEN/.test(bindNone.refuse ?? ''));
check(
  'http bind: opt-in must be exactly "true"',
  typeof resolveHttpBinding({ WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: '1' }).refuse === 'string' &&
    typeof resolveHttpBinding({ WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: 'TRUE' }).refuse === 'string',
);
const bindOptIn = resolveHttpBinding({ WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: 'true' });
check('http bind: opt-in starts on loopback only', bindOptIn.refuse === undefined && bindOptIn.host === '127.0.0.1' && !bindOptIn.authRequired);
const bindToken = resolveHttpBinding({ WEB_AUDIT_HTTP_AUTH_TOKEN: 's3cret' });
check('http bind: token → starts with the unchanged default listen', bindToken.refuse === undefined && bindToken.host === undefined && bindToken.authRequired);
check(
  'http bind: a token makes the opt-in irrelevant',
  resolveHttpBinding({ WEB_AUDIT_HTTP_AUTH_TOKEN: 's3cret', WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: 'true' }).host === undefined,
);
check('http bind: banner says all interfaces, not localhost', /all interfaces \(::\)/.test(bindingBanner('::', 8080, true)) && !/localhost/.test(bindingBanner('::', 8080, true)));
check('http bind: banner names loopback and no auth', /127\.0\.0\.1/.test(bindingBanner('127.0.0.1', 8080, false)) && /NONE/.test(bindingBanner('127.0.0.1', 8080, false)));
check('http live: token server banner printed the bound address, never localhost', httpLogs.some((l) => /listening on .*bearer token/.test(l)) && !httpLogs.some((l) => /localhost/.test(l)));

await withHttpEnv({ WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  let refused: unknown = null;
  try {
    const h = await startHttpServer(createWebAuditMcpServer);
    await h.close();
  } catch (e) {
    refused = e;
  }
  check('http live: no token → startHttpServer rejects before listening', refused instanceof Error && /refused to start/.test(refused.message));
});

await withHttpEnv({ WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: 'true', WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  const h = await startHttpServer(createWebAuditMcpServer);
  try {
    check('http live: unauthenticated opt-in binds 127.0.0.1', h.host === '127.0.0.1', h.host);
    const body = (await (await fetch(`http://127.0.0.1:${h.port}/health`)).json()) as { authRequired: boolean };
    check('http live: health reports authRequired=false under the opt-in', body.authRequired === false);
  } finally {
    await h.close();
  }
});

// ── HTTP transport: DNS-rebinding guard ─────────────────────────────────────
// REGRESSION: under WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED=true (loopback bind, no token) nothing
// checked Host or Origin, so a web page in the operator's browser that re-pointed its own DNS name
// at 127.0.0.1 could POST same-origin to /mcp, initialize, and drive crawls / consent clicks (and
// real form submits when verify is enabled), reading every result. The root server fixed this in
// its own transport; this mirrors it.

check('http rebind: loopback Host with a port allowed', rebindingRejection('127.0.0.1:8080', undefined) === undefined);
check('http rebind: localhost without a port allowed', rebindingRejection('localhost', undefined) === undefined);
check('http rebind: [::1] allowed', rebindingRejection('[::1]:8080', undefined) === undefined);
check('http rebind: loopback Origin allowed', rebindingRejection('localhost:8080', 'http://localhost:6274') === undefined);
check('http rebind: rebound Host rejected', typeof rebindingRejection('evil.example:8080', undefined) === 'string');
check('http rebind: loopback-prefixed Host rejected', typeof rebindingRejection('127.0.0.1.evil.example', undefined) === 'string');
check('http rebind: foreign Origin rejected', typeof rebindingRejection('127.0.0.1:8080', 'http://evil.example:8080') === 'string');
check('http rebind: non-http Origin rejected', typeof rebindingRejection('127.0.0.1:8080', 'file://localhost') === 'string');
check('http rebind: opaque "null" Origin rejected', typeof rebindingRejection('127.0.0.1:8080', 'null') === 'string');
check('http rebind: missing Host rejected', typeof rebindingRejection(undefined, undefined) === 'string');

/** Raw loopback request so the Host header can be set to anything (fetch derives it from the URL). */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rpcCode = (text: string): number | undefined => {
  try {
    return (JSON.parse(text) as { error?: { code?: number } }).error?.code;
  } catch {
    return undefined;
  }
};
const OPEN_MCP_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

await withHttpEnv({ WEB_AUDIT_HTTP_ALLOW_UNAUTHENTICATED: 'true', WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  const h = await startHttpServer(createWebAuditMcpServer);
  const loopHost = `127.0.0.1:${h.port}`;
  try {
    const rebound = await rawRequest(h.port, 'POST', '/mcp', { ...OPEN_MCP_HEADERS, host: `evil.example:${h.port}`, origin: `http://evil.example:${h.port}` }, initBody(1));
    check(
      'http rebind live: rebound Host → 403 JSON-RPC -32000, no session minted (was: 200 + session)',
      rebound.status === 403 && rpcCode(rebound.body) === -32000 && rebound.headers['mcp-session-id'] === undefined,
      `${rebound.status} ${rebound.body.slice(0, 200)}`,
    );
    const foreignOrigin = await rawRequest(h.port, 'POST', '/mcp', { ...OPEN_MCP_HEADERS, host: loopHost, origin: 'http://evil.example' }, initBody(1));
    check('http rebind live: loopback Host with a foreign Origin → 403 -32000', foreignOrigin.status === 403 && rpcCode(foreignOrigin.body) === -32000, String(foreignOrigin.status));
    const reboundHealth = await rawRequest(h.port, 'GET', '/health', { host: `evil.example:${h.port}` });
    check('http rebind live: /health is guarded too', reboundHealth.status === 403, String(reboundHealth.status));

    const init = await rawRequest(h.port, 'POST', '/mcp', { ...OPEN_MCP_HEADERS, host: loopHost }, initBody(1));
    const sid = String(init.headers['mcp-session-id'] ?? '');
    check('http rebind live: plain loopback initialize still → 200 + session', init.status === 200 && sid !== '', `${init.status} ${init.body.slice(0, 200)}`);
    const list = await rawRequest(
      h.port,
      'POST',
      '/mcp',
      { ...OPEN_MCP_HEADERS, host: loopHost, origin: `http://localhost:${h.port}`, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    check('http rebind live: loopback tools/list (loopback Origin) still → 200', list.status === 200 && list.body.includes('site_crawl'), `${list.status}`);
    const reboundList = await rawRequest(
      h.port,
      'POST',
      '/mcp',
      { ...OPEN_MCP_HEADERS, host: `evil.example:${h.port}`, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' },
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    );
    check('http rebind live: a rebound Host cannot ride an existing session', reboundList.status === 403 && rpcCode(reboundList.body) === -32000, String(reboundList.status));
  } finally {
    await h.close();
  }
});

await withHttpEnv({ WEB_AUDIT_HTTP_AUTH_TOKEN: TEST_HTTP_TOKEN, WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  const h = await startHttpServer(createWebAuditMcpServer);
  try {
    const proxied = await rawRequest(h.port, 'POST', '/mcp', { ...MCP_HEADERS, host: 'audit.example.com', origin: 'https://app.example.com' }, initBody(1));
    check(
      'http rebind live: token-authenticated server ignores Host/Origin (hosted proxies unchanged)',
      proxied.status === 200 && typeof proxied.headers['mcp-session-id'] === 'string',
      `${proxied.status} ${proxied.body.slice(0, 200)}`,
    );
    const noToken = await rawRequest(h.port, 'POST', '/mcp', { ...OPEN_MCP_HEADERS, host: `127.0.0.1:${h.port}` }, initBody(1));
    check('http rebind live: token server still demands the bearer token', noToken.status === 401, String(noToken.status));
  } finally {
    await h.close();
  }
});

// ── HTTP transport: body-parser errors ──────────────────────────────────────
// REGRESSION: express.json({ limit: '8mb' }) had no error middleware, so an oversized or malformed
// body got Express's HTML 413/400 page, which a JSON-RPC client cannot parse.

type RpcErrorBody = { jsonrpc?: string; error?: { code?: number; message?: string } };
const readRpcError = async (r: Response): Promise<RpcErrorBody & { contentType: string }> => {
  const contentType = r.headers.get('content-type') ?? '';
  const text = await r.text();
  try {
    return { ...(JSON.parse(text) as RpcErrorBody), contentType };
  } catch {
    return { contentType };
  }
};

await withHttpEnv({ WEB_AUDIT_HTTP_AUTH_TOKEN: TEST_HTTP_TOKEN, WEB_AUDIT_HTTP_PORT: '0' }, async () => {
  const h = await startHttpServer(createWebAuditMcpServer);
  const url = `http://127.0.0.1:${h.port}/mcp`;
  try {
    const bad = await fetch(url, { method: 'POST', headers: MCP_HEADERS, body: '{"jsonrpc":"2.0",' });
    const badBody = await readRpcError(bad);
    check(
      'http body: malformed JSON → 400 JSON-RPC parse error (-32700), not HTML',
      bad.status === 400 && badBody.contentType.includes('json') && badBody.jsonrpc === '2.0' && badBody.error?.code === -32700,
      `${bad.status} ${badBody.contentType}`,
    );

    const pad = 'a'.repeat(8 * 1024 * 1024);
    const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${pad}"}}`;
    const big = await fetch(url, { method: 'POST', headers: MCP_HEADERS, body: huge });
    const bigBody = await readRpcError(big);
    check(
      'http body: over 8mb → 413 JSON-RPC invalid request (-32600), not HTML',
      big.status === 413 && bigBody.contentType.includes('json') && bigBody.jsonrpc === '2.0' &&
        bigBody.error?.code === -32600 && /8mb/.test(bigBody.error?.message ?? ''),
      `${big.status} ${bigBody.contentType}`,
    );
  } finally {
    await h.close();
  }
});

// ── HTTP transport: idle-session sweep ──────────────────────────────────────
// REGRESSION: each HTTP session owns its own McpServer, but nothing reclaimed a session whose
// client exited, crashed or lost the network without sending DELETE /mcp. Its transport + server
// stayed in the session map for the life of the process and every reconnect's initialize added
// another, so activeSessions and memory only grew on a long-running host. The root server has
// always had an idle sweep (GTM_MCP_HTTP_SESSION_TTL_MS); this mirrors it.

check('http ttl: unset → 30 min default', resolveSessionTtlMs({}) === DEFAULT_SESSION_TTL_MS && DEFAULT_SESSION_TTL_MS === 30 * 60_000);
check('http ttl: explicit value honoured', resolveSessionTtlMs({ WEB_AUDIT_HTTP_SESSION_TTL_MS: '200' }) === 200);
check('http ttl: 0 disables the sweep', resolveSessionTtlMs({ WEB_AUDIT_HTTP_SESSION_TTL_MS: '0' }) === 0);
check(
  'http ttl: negative or non-numeric → default, never a disabled sweep',
  resolveSessionTtlMs({ WEB_AUDIT_HTTP_SESSION_TTL_MS: '-5' }) === DEFAULT_SESSION_TTL_MS &&
    resolveSessionTtlMs({ WEB_AUDIT_HTTP_SESSION_TTL_MS: 'abc' }) === DEFAULT_SESSION_TTL_MS &&
    resolveSessionTtlMs({ WEB_AUDIT_HTTP_SESSION_TTL_MS: '' }) === DEFAULT_SESSION_TTL_MS,
);
const webAuditHttpSrc = readFileSync(new URL('../http.ts', import.meta.url), 'utf8');
check(
  'http ttl: the sweep timer is unref()d and cleared on close, so it never holds the process open',
  /setInterval\(/.test(webAuditHttpSrc) && /sweep\?\.unref\(\)/.test(webAuditHttpSrc) && /clearInterval\(sweep\)/.test(webAuditHttpSrc),
);

/** Poll until `cond` holds or `timeoutMs` passes; returns whether it held. */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const SWEEP_TTL_MS = 200;
await withHttpEnv(
  { WEB_AUDIT_HTTP_AUTH_TOKEN: TEST_HTTP_TOKEN, WEB_AUDIT_HTTP_PORT: '0', WEB_AUDIT_HTTP_SESSION_TTL_MS: String(SWEEP_TTL_MS) },
  async () => {
    const h = await startHttpServer(createWebAuditMcpServer);
    const base = `http://127.0.0.1:${h.port}`;
    const post = (body: string, extra: Record<string, string> = {}): Promise<Response> =>
      fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...extra }, body });
    const activeSessions = async (): Promise<number> =>
      ((await (await fetch(`${base}/health`)).json()) as { activeSessions: number }).activeSessions;
    const sessionHeaders = (sid: string) => ({ 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' });
    try {
      // A client that initializes and then vanishes without DELETE.
      const a = await post(initBody(1));
      await a.text();
      const sidA = a.headers.get('mcp-session-id') ?? '';
      check('http sweep: abandoned session opened', a.status === 200 && sidA !== '' && (await activeSessions()) === 1);
      const swept = await waitUntil(async () => (await activeSessions()) === 0, 3000);
      check('http sweep: an abandoned session is reclaimed after the idle TTL (was: kept forever)', swept);
      const resumed = await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), sessionHeaders(sidA));
      const resumedBody = await readRpcError(resumed);
      check('http sweep: a swept session id → 404 JSON-RPC -32001', resumed.status === 404 && resumedBody.error?.code === -32001, String(resumed.status));
      check('http sweep: the sweep logs the closed session to stderr', httpLogs.some((l) => l.includes(`closing idle HTTP session: ${sidA}`)));

      // A session with a request in flight (a held-open GET event stream) is never swept, however
      // long it outlives the TTL; once the stream closes it becomes idle and is reclaimed.
      const b = await post(initBody(1));
      await b.text();
      const sidB = b.headers.get('mcp-session-id') ?? '';
      const abort = new AbortController();
      const stream = await fetch(`${base}/mcp`, {
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: MCP_HEADERS.authorization, ...sessionHeaders(sidB) },
        signal: abort.signal,
      });
      check('http sweep: event stream opened', stream.status === 200, String(stream.status));
      await new Promise((r) => setTimeout(r, SWEEP_TTL_MS * 4));
      check('http sweep: a session with an open request is NOT swept past the TTL', (await activeSessions()) === 1);
      abort.abort();
      await stream.body?.cancel().catch(() => undefined);
      const sweptAfterStream = await waitUntil(async () => (await activeSessions()) === 0, 3000);
      check('http sweep: once its stream closes, the idle session is reclaimed', sweptAfterStream);
    } finally {
      await h.close();
    }
  },
);

await withHttpEnv(
  { WEB_AUDIT_HTTP_AUTH_TOKEN: TEST_HTTP_TOKEN, WEB_AUDIT_HTTP_PORT: '0', WEB_AUDIT_HTTP_SESSION_TTL_MS: '0' },
  async () => {
    const h = await startHttpServer(createWebAuditMcpServer);
    const base = `http://127.0.0.1:${h.port}`;
    try {
      const a = await fetch(`${base}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: initBody(1) });
      await a.text();
      await new Promise((r) => setTimeout(r, 300));
      const active = ((await (await fetch(`${base}/health`)).json()) as { activeSessions: number }).activeSessions;
      check('http sweep: WEB_AUDIT_HTTP_SESSION_TTL_MS=0 turns the sweep off', a.status === 200 && active === 1, String(active));
    } finally {
      await h.close();
    }
  },
);

// ── tag-presence reconciliation (configured vs fired) ───────────────────────

const reconContainer = {
  tags: [
    { name: 'GA4 Config', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-ABC123' }] },
    { name: 'Ads Conversion', type: 'awct', parameter: [{ key: 'conversionId', value: 'AW-123456789/AbCdEf' }] },
    { name: 'Paused Meta', type: 'html', paused: true, parameter: [{ key: 'html', value: "<script>fbq('init','111222333')</script>" }] },
  ],
  triggers: [],
  variables: [],
};

const cfgDests = extractConfiguredDestinations(reconContainer);
check('reconcile: extracts GA4 measurement id', cfgDests.some((d) => d.vendor === 'ga4' && d.id === 'G-ABC123'));
check('reconcile: normalizes Ads id (drops /label)', cfgDests.some((d) => d.vendor === 'google_ads' && d.id === 'AW-123456789'));
check('reconcile: skips a paused tag', !cfgDests.some((d) => d.vendor === 'meta'));

// Real capture shapes: GA4 carries query.tid; the Meta pixel id is ONLY in the
// /tr url (the pipeline keeps query for GA4 hits only); the gtm.js loader is not
// a firing destination.
const reconCaptures = [
  capture({
    trackerHits: [
      hit({ url: 'https://region1.google-analytics.com/g/collect?v=2&tid=G-XYZ999', query: { tid: 'G-XYZ999' } }),
      hit({ url: 'https://www.facebook.com/tr?id=111222333&ev=PageView', ids: ['meta_pixel'], groups: ['meta'] }),
      hit({ url: 'https://www.googletagmanager.com/gtm.js?id=GTM-XXXX', ids: ['gtm_loader'], groups: ['gtm'] }),
    ],
  }),
];
const obsDests = extractObservedDestinations(reconCaptures);
check('reconcile: observes GA4 tid', obsDests.some((d) => d.vendor === 'ga4' && d.id === 'G-XYZ999'));
check('reconcile: observes Meta pixel id from the /tr url', obsDests.some((d) => d.vendor === 'meta' && d.id === '111222333'));
check('reconcile: gtm.js loader is not an observed destination', !obsDests.some((d) => d.source.includes('gtm.js')));

// Consent was granted (an accept capture ran) → configured-but-never-fired is meaningful.
const rec = reconcile(reconContainer, reconCaptures, { consentGranted: true });
const reconIds = rec.findings.map((f) => f.id);
check('reconcile: GA4 measurement id mismatch flagged', reconIds.includes('ga4_measurement_id_mismatch'));
check('reconcile: Ads configured-but-not-fired flagged', reconIds.includes('configured_not_fired_google_ads'));
check('reconcile: Meta fired-but-not-configured flagged', reconIds.includes('fired_not_configured_meta'));
check('reconcile: configured_not_fired is low severity', rec.findings.find((f) => f.id === 'configured_not_fired_google_ads')?.severity === 'low');
check('reconcile: per-vendor summary records GA4 configured+fired', rec.byVendor.some((v) => v.vendor === 'ga4' && v.configured && v.fired));

// Without a consent-granted capture, a non-firing configured vendor is NOT flagged (it may be consent-gated).
const recNoConsent = reconcile(reconContainer, reconCaptures, { consentGranted: false });
check('reconcile: configured_not_fired suppressed without a consent grant', !recNoConsent.findings.some((f) => f.id.startsWith('configured_not_fired')));

// A googtag carrying an AW- id is Google Ads, not GA4.
const googtagDests = extractConfiguredDestinations({ tags: [{ name: 'GTag', type: 'googtag', parameter: [{ key: 'tagId', value: 'AW-555' }] }], triggers: [], variables: [] });
check('reconcile: googtag with AW- id is google_ads', googtagDests.some((d) => d.vendor === 'google_ads' && d.id === 'AW-555'));
check('reconcile: googtag with AW- id is not GA4', !googtagDests.some((d) => d.vendor === 'ga4'));

// GA4 id is matched only in a real gtag context, not arbitrary "G-FORCE" text.
const noiseHtml = extractConfiguredDestinations({ tags: [{ name: 'Promo', type: 'html', parameter: [{ key: 'html', value: '<div class="G-FORCE">G-WAGON sale</div>' }] }], triggers: [], variables: [] });
check('reconcile: arbitrary G-XXXX text in HTML is not a GA4 destination', !noiseHtml.some((d) => d.vendor === 'ga4'));
const realHtml = extractConfiguredDestinations({ tags: [{ name: 'gtag', type: 'html', parameter: [{ key: 'html', value: "gtag('config','G-REALID1234')" }] }], triggers: [], variables: [] });
check('reconcile: gtag config G- id in HTML is detected', realHtml.some((d) => d.vendor === 'ga4' && d.id === 'G-REALID1234'));

// A GA4 Google-signals / remarketing ping (no conversion id) is not an Ads destination.
const signalsObs = extractObservedDestinations([
  capture({ trackerHits: [hit({ url: 'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?', ids: ['google_ads'], groups: ['google_ads'] })] }),
]);
check('reconcile: google-signals remarketing ping is not an Ads destination', !signalsObs.some((d) => d.vendor === 'google_ads'));

// Malformed captures don't throw (matches the module's tolerant posture).
check('reconcile: tolerates malformed captures', extractObservedDestinations([{}, { trackerHits: null }] as unknown as ScenarioCapture[]).length === 0);

// A matched container (same GA4 id fired, nothing else) produces no reconcile findings.
const cleanRec = reconcile(
  { tags: [{ name: 'GA4', type: 'gaawc', parameter: [{ key: 'measurementId', value: 'G-ABC123' }] }], triggers: [], variables: [] },
  [capture({ trackerHits: [hit({ url: 'https://r.google-analytics.com/g/collect?tid=G-ABC123', query: { tid: 'G-ABC123' } })] })],
);
check('reconcile: matched GA4 yields no reconcile findings', cleanRec.findings.length === 0);

// ── tag-suggest: cross-origin embedded form providers ────────────────────────
const sig = (over: Partial<PageSignals> = {}): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], iframeSrcs: [], ...over });
check('embed: Calendly iframe detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://calendly.com/acme/intro'] }))?.vendor === 'calendly');
check('embed: Jotform iframe detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://form.jotform.com/2412345'] }))?.vendor === 'jotform');
check('embed: Formstack detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://acme.formstack.com/forms/x'] }))?.vendor === 'formstack');
check('embed: Tally detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://tally.so/embed/abc'] }))?.vendor === 'tally');
check('embed: Google Forms detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://docs.google.com/forms/d/e/x/viewform'] }))?.vendor === 'googleforms');
check('embed: Wufoo detected', detectEmbeddedForm(sig({ iframeSrcs: ['https://acme.wufoo.com/forms/x'] }))?.vendor === 'wufoo');
check('embed: plain page → no embedded form', detectEmbeddedForm(sig({ iframeSrcs: ['https://www.youtube.com/embed/x'] })) === null);
// A page with a readable search-y form AND a cross-origin Calendly embed: the embed still surfaces.
const pgEmbed: PageScan = {
  page: '/contact',
  elements: [],
  forms: [{ purpose: 'search', action: '/search', method: 'get', fields: [{ type: 'search', name: 'q', required: false }] }],
  signals: sig({ iframeSrcs: ['https://calendly.com/acme/intro'] }),
};
const embedInput = buildSuggestInput([pgEmbed], 'example.com');
check('embed: co-present Calendly embed is not suppressed by another form', embedInput.forms.some((f) => f.provider.vendor === 'calendly'));
// A readable provider form (its OWN .hs-form class) must NOT be doubled by the synth embed.
const pgHubReadable: PageScan = {
  page: '/contact',
  elements: [],
  forms: [{ purpose: 'contact', action: '/submit', method: 'post', formClasses: 'hs-form', fields: [{ type: 'email', name: 'email', required: true }] }],
  signals: sig({ classNames: ['hs-form'], scriptSrcs: ['https://js.hsforms.net/forms/v2.js'] }),
};
check('embed: readable HubSpot form is not double-counted by the synth embed', buildSuggestInput([pgHubReadable], 'example.com').forms.length === 1);
// But an UNRELATED readable form (a search box) must NOT suppress the HubSpot embed on the same page.
const pgHubBeside: PageScan = {
  page: '/pricing',
  elements: [],
  forms: [{ purpose: 'search', action: '/search', method: 'get', fields: [{ type: 'search', name: 'q', required: false }] }],
  signals: sig({ classNames: ['hs-form'], scriptSrcs: ['https://js.hsforms.net/forms/v2.js'] }),
};
check('embed: HubSpot embed surfaces beside an unrelated search form', buildSuggestInput([pgHubBeside], 'example.com').forms.some((f) => f.provider.vendor === 'hubspot'));

// ── report ──────────────────────────────────────────────────────────────────

/* ── skip filter: which pages a crawl refuses to follow ───────────────────── */
{
  const skip = buildExclude({ skipBlog: true });
  check('skip: asking to skip blogs produces a filter', typeof skip === 'function');
  const on = (p: string): boolean => (skip ? skip(`https://x.com${p}`) : false);
  for (const p of ['/blog', '/blog/post-1', '/news/', '/2026/08/a-post', '/press', '/author/sam']) {
    check(`skip: ${p} is treated as editorial`, on(p));
  }
  // The ones that must survive: a "tag-management" service page is the whole point of the scan, and
  // "blogger-outreach" only contains the word blog.
  for (const p of ['/contact', '/pricing', '/solutions/tag-management', '/blogger-outreach', '/free-audit']) {
    check(`skip: ${p} is kept`, !on(p));
  }
  check('skip: a query string cannot smuggle a skip word past a needed page', !on('/contact?from=/blog'));

  // undefined, not a predicate that always says no, so the crawler keeps its original behaviour
  // rather than calling a filter that cannot exclude anything.
  check('skip: no options means no filter', buildExclude({}) === undefined);
  check('skip: blank patterns mean no filter', buildExclude({ skipPatterns: ['  '] }) === undefined);

  const custom = buildExclude({ skipPatterns: ['/Careers', '/legal'] });
  const onCustom = (p: string): boolean => (custom ? custom(`https://x.com${p}`) : false);
  check('skip: extra patterns match case-insensitively', onCustom('/careers/engineer') && onCustom('/legal/terms'));
  check('skip: extra patterns leave everything else alone', !onCustom('/contact'));
}



/* ── ringing the element a suggestion is about ─────────────────────────────── */
{
  const rect = { x: 10, y: 20, w: 100, h: 40 };
  const other = { x: 500, y: 600, w: 80, h: 30 };
  const page = (over: Partial<PageScan>): PageScan =>
    ({ page: '/contact', elements: [], forms: [], signals: {} as never, ...over }) as PageScan;
  const sug = (over: Record<string, unknown>): SuggestedTag =>
    ({ id: 'x', page: '/contact', platform: 'ga4_event', tagName: 'T', measurementId: 'G-1', ...over }) as SuggestedTag;

  // Exactly one element with that href → ringed.
  const one = attachRects(
    [sug({ trigger: { name: 'Email', kind: 'link_click', clickUrlValue: 'mailto:' } })],
    [page({ elements: [{ page: '/contact', kind: 'email', text: 'hi', href: 'mailto:a@b.com', rect }] as never })],
  );
  check('rect: a single matching element is ringed', JSON.stringify(one[0].rect) === JSON.stringify(rect));

  // Two candidates → nothing, because a ring around the wrong control is worse than no ring.
  const two = attachRects(
    [sug({ trigger: { name: 'Email', kind: 'link_click', clickUrlValue: 'mailto:' } })],
    [page({
      elements: [
        { page: '/contact', kind: 'email', text: 'a', href: 'mailto:a@b.com', rect },
        { page: '/contact', kind: 'email', text: 'b', href: 'mailto:c@d.com', rect: other },
      ] as never,
    })],
  );
  check('rect: an ambiguous match is left unringed', two[0].rect === undefined);

  // A site-wide suggestion is proved on the first page carrying exactly one match.
  const wide = attachRects(
    [sug({ page: 'site-wide', trigger: { name: 'Phone', kind: 'link_click', clickUrlValue: 'tel:' } })],
    [
      page({ page: '/', elements: [] }),
      page({ page: '/contact', elements: [{ page: '/contact', kind: 'phone', text: 'call', href: 'tel:+1', rect }] as never }),
    ],
  );
  check('rect: a site-wide tag is ringed on an example page', JSON.stringify(wide[0].rect) === JSON.stringify(rect));
  check('rect: and it names the page that example came from', wide[0].proofPage === '/contact');

  // A form suggestion rings the form, and only when one form is unambiguous.
  const form = attachRects(
    [sug({ trigger: { name: 'Contact', kind: 'form_submit' } })],
    [page({ forms: [{ purpose: 'contact', action: '/x', rect }] as never })],
  );
  check('rect: a single form on the page is ringed', JSON.stringify(form[0].rect) === JSON.stringify(rect));

  const forms2 = attachRects(
    [sug({ trigger: { name: 'Contact', kind: 'form_submit' } })],
    [page({ forms: [{ purpose: 'contact', action: '/x', rect }, { purpose: 'signup', action: '/y', rect: other }] as never })],
  );
  check('rect: two forms with nothing to tell them apart stay unringed', forms2[0].rect === undefined);

  // A site-wide custom_event (an ecommerce funnel tag fires on a dataLayer push, not on any form) is
  // not ringed around the one form that happens to be alone on a page (was: ringed + proofPage set).
  const ecommerce = attachRects(
    [sug({ page: 'site-wide', trigger: { name: 'Add To Cart (dataLayer) Trigger', kind: 'custom_event', eventName: 'add_to_cart' } })],
    [page({ page: '/contact', forms: [{ purpose: 'contact', action: '/x', rect }] as never })],
  );
  check('rect: a site-wide custom_event is not ringed around an unrelated single form', ecommerce[0].rect === undefined && ecommerce[0].proofPage === undefined);

  // A page-specific custom_event is a form's provider/dataLayer listener: its single form is still ringed.
  const formEvent = attachRects(
    [sug({ trigger: { name: 'Contact Form Trigger', kind: 'custom_event', eventName: 'hubspot-form-success' } })],
    [page({ forms: [{ purpose: 'contact', action: '/x', rect }] as never })],
  );
  check('rect: a page-specific form custom_event still rings its single form', JSON.stringify(formEvent[0].rect) === JSON.stringify(rect));

  // A popup form revealed by an interactive click has no rect on the picture (it was taken before the
  // click). It still counts: the one measured form must not be ringed for a suggestion that could be either.
  const revealed = attachRects(
    [sug({ trigger: { name: 'Demo', kind: 'form_submit' } })],
    [page({ forms: [{ purpose: 'contact', action: '/x', formId: 'contact', rect }, { purpose: 'demo', action: '', formId: '', hidden: true }] as never })],
  );
  check('rect: an unmeasured revealed form keeps the match ambiguous (no ring on the other form)', revealed[0].rect === undefined);
  const byId = attachRects(
    [sug({ trigger: { name: 'Contact', kind: 'form_submit', formIdValue: 'contact' } })],
    [page({ forms: [{ purpose: 'contact', action: '/x', formId: 'contact', rect }, { purpose: 'demo', action: '', formId: '', hidden: true }] as never })],
  );
  check('rect: a form named by id is still ringed next to a revealed one', JSON.stringify(byId[0].rect) === JSON.stringify(rect));

  // An element the collector could not measure (the layout-less path) is not invented.
  const noRect = attachRects(
    [sug({ trigger: { name: 'Email', kind: 'link_click', clickUrlValue: 'mailto:' } })],
    [page({ elements: [{ page: '/contact', kind: 'email', text: 'hi', href: 'mailto:a@b.com' }] as never })],
  );
  check('rect: an unmeasured element yields no rectangle', noRect[0].rect === undefined);
}

// Page discovery: reading a site's own list of pages, and scanning only the chosen ones.
{
  const SITEMAP = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/</loc></url>
    <url><loc>https://example.com/contact</loc></url>
    <url><loc> https://example.com/pricing </loc></url>
  </urlset>`;
  const INDEX = `<?xml version="1.0"?><sitemapindex>
    <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
    <sitemap><loc>https://evil.test/sitemap.xml</loc></sitemap>
  </sitemapindex>`;

  const flat = parseSitemapLocs(SITEMAP);
  check('sitemap: urls are read and trimmed', flat.locs.length === 3 && flat.locs[2] === 'https://example.com/pricing');
  check('sitemap: a urlset is not an index', flat.isIndex === false);

  const index = parseSitemapLocs(INDEX);
  check('sitemap: an index is recognised as one', index.isIndex === true && index.locs.length === 2);
  // The follow is same-site filtered in collectSitemap; the parser reports what it saw.
  check('sitemap: an off-site child is still parsed, to be refused later', index.locs[1].includes('evil.test'));

  check('sitemap: an empty body yields nothing rather than throwing', parseSitemapLocs('').locs.length === 0);

  const robots = sitemapsInRobots(
    'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sm1.xml\n sitemap:https://example.com/sm2.xml\n',
  );
  check('robots: every Sitemap line is read, case and spacing insensitive', robots.length === 2);
  check('robots: a Disallow line is not mistaken for a sitemap', !robots.some((r) => r.includes('admin')));

  // robots.txt Sitemap: entries are held to the same same-site rule as sitemapindex children and
  // caller-named sitemaps. IP-literal hosts keep safeFetch off DNS; fetch is stubbed, so no network.
  {
    const site = 'http://203.0.113.10';
    const offSite = 'http://198.51.100.7/sitemap.xml';
    const served: Record<string, string> = {
      [`${site}/robots.txt`]: `User-agent: *\nSitemap: ${offSite}\nSitemap: ${site}/custom-sitemap.xml\n`,
      [`${site}/custom-sitemap.xml`]:
        `<urlset><url><loc>${site}/contact</loc></url><url><loc>${site}/pricing</loc></url></urlset>`,
    };
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      const body = served[url];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      const found = await discoverSitePages(`${site}/`);
      check('robots: an off-site Sitemap entry is never fetched', !fetched.includes(offSite), fetched.join(', '));
      check('robots: an on-site Sitemap entry is still read', fetched.includes(`${site}/custom-sitemap.xml`));
      check(
        'robots: pages from the on-site sitemap are listed',
        found.pages.some((p) => p.url === `${site}/contact`) && found.pages.some((p) => p.url === `${site}/pricing`),
      );
      const skipped = found.sitemapsRead.find((r) => r.url === offSite);
      check(
        'robots: the skipped off-site sitemap is recorded with its reason',
        skipped?.ok === false && /same site/.test(skipped?.error ?? ''),
        JSON.stringify(skipped),
      );
      check('robots: skipping an off-site sitemap does not mark the site unreachable', found.sitemapStatus === 'found');
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // safeFetch's body cap used to be a Content-Length check plus res.text().slice(): a chunked body
  // (no Content-Length) or a gzip body that inflates was buffered WHOLE before the slice. It must stop
  // reading at the cap, and release bodies it does not read (3xx, >=400). IP literals: no DNS.
  {
    const CAP = 8_000_000;
    const CHUNK = 64 * 1024;
    const streamOf = (totalBytes: number) => {
      const stat = { pulled: 0, cancelled: false };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stat.pulled >= totalBytes) return controller.close();
          const n = Math.min(CHUNK, totalBytes - stat.pulled);
          stat.pulled += n;
          controller.enqueue(new Uint8Array(n).fill(97));
        },
        cancel() {
          stat.cancelled = true;
        },
      });
      return { stream, stat };
    };
    const huge = streamOf(24 * 1024 * 1024); // far past the cap, with no Content-Length
    const errorBody = streamOf(1024);
    const redirectBody = streamOf(1024);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://203.0.113.10/huge.xml') return new Response(huge.stream, { status: 200 });
      if (url === 'http://203.0.113.10/boom') return new Response(errorBody.stream, { status: 500 });
      if (url === 'http://203.0.113.10/moved') {
        return new Response(redirectBody.stream, { status: 302, headers: { location: '/small' } });
      }
      if (url === 'http://203.0.113.10/small') return new Response('ok', { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const big = await safeFetch('http://203.0.113.10/huge.xml', 5_000, 'application/xml');
      check('safeFetch cap: the body kept is at most the cap', big.body.length <= CAP && big.body.length > 0, String(big.body.length));
      check('safeFetch cap: reading stops at the cap instead of buffering the whole body', huge.stat.pulled < CAP + 4 * CHUNK, String(huge.stat.pulled));
      check('safeFetch cap: the rest of the body is cancelled', huge.stat.cancelled === true);
      const err = await safeFetch('http://203.0.113.10/boom', 5_000);
      check('safeFetch cap: a >=400 body is cancelled, not left open', err.status === 500 && err.body === '' && errorBody.stat.cancelled === true);
      const moved = await safeFetch('http://203.0.113.10/moved', 5_000);
      check('safeFetch cap: a redirect body is cancelled before the next hop', moved.body === 'ok' && redirectBody.stat.cancelled === true, JSON.stringify(moved));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const links = extractLinks(
    '<a href="/contact">c</a><a href="https://example.com/pricing">p</a><a href="https://other.test/x">o</a><a href="/logo.png">i</a>',
    'https://example.com/',
    'https://example.com/',
  );
  check('links: same-site hrefs are kept, absolute and relative', links.length === 2);
  check('links: an off-site link is dropped', !links.some((l) => l.includes('other.test')));
  check('links: an asset is dropped', !links.some((l) => l.includes('logo.png')));

  const ordered = prioritize([
    'https://example.com/blog/a',
    'https://example.com/about',
    'https://example.com/contact',
  ]);
  check('order: a form-likely page leads', ordered[0].endsWith('/contact'));
  check('order: everything else keeps its original order', ordered[1].endsWith('/blog/a') && ordered[2].endsWith('/about'));

  // The entry page scores zero on the form heuristic, so without pinning it sinks below every
  // /services page. On a real 226-page site it landed past the 25 that get pre-ticked, which would
  // have dropped the footer email and phone links the homepage is scanned for.
  const withEntry = prioritize(
    ['https://example.com/services', 'https://example.com/', 'https://example.com/contact'],
    'https://example.com/',
  );
  check('order: the entry page is pinned first', withEntry[0] === 'https://example.com/');
  check('order: pinning does not duplicate it', withEntry.length === 3);
  check('order: form-likely pages still lead the rest', withEntry[1].endsWith('/services') || withEntry[1].endsWith('/contact'));
  check(
    'order: an entry not in the list is not invented',
    prioritize(['https://example.com/a'], 'https://example.com/').length === 1,
  );

  check('path: the root reads as "/"', pathOf('https://example.com/') === '/');
  check('path: a trailing slash is dropped', pathOf('https://example.com/contact/') === '/contact');

  // resolvePageList is the check that stops the scanner being a general URL fetcher.
  const START = 'https://example.com/';
  const list = resolvePageList(
    START,
    ['/contact', 'https://example.com/pricing', 'https://other.test/steal', 'mailto:a@b.com', '/contact'],
    25,
  );
  check('pages: a relative and an absolute same-site page are both accepted', list.targets.length === 2);
  check('pages: the order given is kept', list.targets[0].url.endsWith('/contact'));
  check('pages: a duplicate is collapsed silently', !list.rejected.some((r) => r.url.endsWith('/contact')));
  check(
    'pages: an off-site URL is refused and SAID so',
    list.rejected.some((r) => r.url.includes('other.test') && /same site/i.test(r.reason)),
  );
  check('pages: a non-page URL is refused', list.rejected.some((r) => r.url.startsWith('mailto:')));

  const overBudget = resolvePageList(START, ['/a', '/b', '/c'], 2);
  check('pages: the budget is applied', overBudget.targets.length === 2);
  check(
    'pages: what the budget cut is named rather than silently trimmed',
    overBudget.rejected.length === 1 && /budget/i.test(overBudget.rejected[0].reason),
  );

  const privateHost = resolvePageList('http://localhost/', ['http://localhost/admin'], 25);
  check('pages: the URL guard still applies to a chosen page', privateHost.targets.length === 0);

  check('pages: an empty entry is ignored, not reported as an error', resolvePageList(START, ['', '  '], 25).rejected.length === 0);

  // The blog pattern is shared between the crawl's exclude and the page list's marker. One pattern,
  // or the "skip blogs" button hides a different set than the crawl would have.
  check('blog: a post path is editorial', isBlogLike('https://example.com/blog/why-tags'));
  check('blog: a dated path is editorial', isBlogLike('https://example.com/2026/08/launch'));
  check('blog: a category path is editorial', isBlogLike('https://example.com/category/seo'));
  check('blog: a contact page is not', !isBlogLike('https://example.com/contact'));
  check(
    'blog: a query string cannot smuggle the word in',
    !isBlogLike('https://example.com/pricing?ref=blog'),
  );
  const exclude = buildExclude({ skipBlog: true });
  check(
    'blog: the crawl filter and the list marker agree',
    ['https://example.com/blog/a', 'https://example.com/contact', 'https://example.com/2026/01/x'].every(
      (u) => Boolean(exclude?.(u)) === isBlogLike(u),
    ),
  );
}

// A chosen list is not a crawl budget.
{
  // The bug: scanPages fell back to maxPages, whose default is 10, so ticking 25 pages in the
  // picker scanned 10 and reported the other 15 as over a budget the user never set.
  const chosen = Array.from({ length: 40 }, (_, i) => `https://example.com/p${i}`);
  const wide = resolvePageList('https://example.com/', chosen, 300);
  check('chosen: a list of 40 is not clamped to a crawl budget', wide.targets.length === 40);
  check('chosen: nothing is reported over budget', wide.rejected.length === 0);

  const capped = resolvePageList('https://example.com/', chosen, 25);
  check('chosen: a real ceiling still applies', capped.targets.length === 25);
  check('chosen: and the pages it cut are named', capped.rejected.length === 15);
}

// ── form extraction without a browser: the generic cookie/consent CMP filter ─────────────────────────
// The Chromium block below self-skips when no browser is installed, and CI installs none, so on its own
// a regression there passes CI unseen. The same extractFormsInPage runs here on a minimal DOM, in Node.
{
  const formIds = (doc: MiniDocument): string => inPage(doc, () => extractFormsInPage()).map((f) => f.formId || '(anon)').join();
  const contact = (): MiniElement =>
    el('form', { id: 'contact', action: '/c' }, [el('label', {}, ['Email ', el('input', { type: 'email', name: 'email' })]), el('button', {}, ['Send'])]);
  const banner = (): MiniElement => el('form', { id: 'cmp' }, [el('input', { type: 'text', name: 'x' }), el('button', {}, ['Submit'])]);
  check('cmp-filter (no browser): a plain contact form is found', formIds(miniPage([contact()])) === 'contact');
  check('cmp-filter (no browser): <body class="cookies-not-set"> keeps the page\'s forms',
    formIds(miniPage([contact()], { body: { class: 'home cookies-not-set' } })) === 'contact');
  check('cmp-filter (no browser): <html class="show--consent"> keeps the page\'s forms',
    formIds(miniPage([contact()], { html: { class: 'show--consent' } })) === 'contact');
  check('cmp-filter (no browser): <html class="js cookies"> keeps the page\'s forms',
    formIds(miniPage([contact()], { html: { class: 'js cookies' } })) === 'contact');
  check('cmp-filter (no browser): <html id="consent-root"> keeps the page\'s forms',
    formIds(miniPage([contact()], { html: { id: 'consent-root' } })) === 'contact');
  check('cmp-filter (no browser): a form inside #onetrust-banner-sdk is still excluded',
    formIds(miniPage([contact(), el('div', { id: 'onetrust-banner-sdk' }, [banner()])])) === 'contact');
  check('cmp-filter (no browser): a form inside a generic .cookie-banner is still excluded, even under a flagged <body>',
    formIds(miniPage([contact(), el('div', { class: 'cookie-banner' }, [banner()])], { body: { class: 'cookies-not-set' } })) === 'contact');
}

// ── form rects inside a same-origin iframe are in TOP-page coordinates ──────────────────────────────
// A HubSpot v2 form renders into a same-origin iframe. It was measured in the iframe's own viewport, so
// a form at y=2400 on the page was ringed near (0, 0) on the full-page screenshot.
{
  const framedForm = (rect: Box, view: { scrollY?: number; innerHeight?: number } = {}): MiniDocument =>
    miniPage([el('form', { id: 'hs' }, [el('input', { type: 'email', name: 'email' })], { rect })], { view: { innerWidth: 500, innerHeight: view.innerHeight ?? 700, scrollY: view.scrollY ?? 0 } });
  const top = (inner: MiniDocument, frame: Partial<ElOpts> = {}): MiniDocument =>
    miniPage([el('iframe', { class: 'hs-form-iframe' }, [], { rect: { x: 20, y: 2350, w: 504, h: 704 }, clientLeft: 2, clientTop: 2, contentDocument: inner, ...frame })], { view: { scrollY: 50 } });
  const rectsOn = (doc: MiniDocument) => inPage(doc, () => extractFormsInPage()).map((f) => f.rect);

  const [r] = rectsOn(top(framedForm({ x: 10, y: 30, w: 480, h: 600 })));
  // page = frame box (20, 2350) + border (2) + the form in the frame (10, 30) + the top document's scroll (0, 50)
  check('rect: a form in a same-origin iframe is offset by the iframe\'s place on the page',
    r?.x === 32 && r?.y === 2432 && r?.w === 480 && r?.h === 600, JSON.stringify(r));
  const [scrolled] = rectsOn(top(framedForm({ x: 10, y: -170, w: 480, h: 600 }, { scrollY: 200 })));
  check('rect: the iframe\'s own scroll is not added twice (its rects already reflect it)',
    scrolled?.y === 2232, JSON.stringify(scrolled));
  const [padded] = rectsOn(top(framedForm({ x: 10, y: 30, w: 480, h: 600 }), { style: { paddingLeft: '5px', paddingTop: '7px' } }));
  check('rect: the iframe\'s padding is counted (its content starts inside it)', padded?.x === 37 && padded?.y === 2439, JSON.stringify(padded));
  const [clipped] = rectsOn(top(framedForm({ x: 10, y: 900, w: 480, h: 200 }, { innerHeight: 700 })));
  check('rect: a form scrolled or clipped out of its iframe\'s viewport gets no rect (not one below the frame)',
    clipped === undefined, JSON.stringify(clipped));
  const [plain] = rectsOn(miniPage([el('form', { id: 'c' }, [el('input', { type: 'email', name: 'email' })], { rect: { x: 40, y: 100, w: 300, h: 200 } })], { view: { scrollY: 900 } }));
  check('rect: a top-document form is unchanged (viewport + scroll)', plain?.x === 40 && plain?.y === 1000, JSON.stringify(plain));
}

// ── form extraction in a real page: the generic cookie/consent CMP filter ──────────────────────────
// extractFormsInPage runs IN the page, so these checks need Chromium. They self-skip when Playwright or
// its browser is not installed (CI installs neither), so the suite still needs no browser; the
// browser-free mirror above is what CI runs. WEB_AUDIT_REQUIRE_BROWSER=1 turns the skip into a failure,
// for a run that has installed Chromium and must not pass without these checks.
{
  const pw = await loadPlaywright();
  const launchOpts = { headless: true, timeout: 15_000 };
  const browser = pw ? await pw.chromium.launch(launchOpts).catch(() => null) : null;
  if (!browser) {
    if (process.env.WEB_AUDIT_REQUIRE_BROWSER === '1') {
      check('in-page checks: chromium launches when WEB_AUDIT_REQUIRE_BROWSER=1', false, 'playwright or its chromium is not installed');
    } else {
      console.log('web-audit: in-page form extraction checks SKIPPED (playwright/chromium not installed)');
    }
  } else {
    try {
      const page = (await (await browser.newContext()).newPage()) as PwPage & { setContent(html: string): Promise<void> };
      const formIdsOn = async (html: string): Promise<string[]> => {
        await page.setContent(html);
        // tsx (esbuild keepNames) wraps the function's inner helpers in __name(); the tsc build does not.
        await page.evaluate('window.__name = (f) => f');
        const raw = await page.evaluate<RawForm[]>(extractFormsInPage);
        return raw.map((f) => f.formId || '(anon)');
      };
      const FORM = '<form id="contact" action="/c"><label>Email <input type="email" name="email"></label><button>Send</button></form>';
      check('cmp-filter: a plain contact form is found', (await formIdsOn(`<html><body>${FORM}</body></html>`)).join() === 'contact');
      // Consent tooling flags the page ROOT; the generic substring arm used to match it and drop every form.
      check('cmp-filter: <body class="cookies-not-set"> (WordPress Cookie Notice) keeps the page\'s forms',
        (await formIdsOn(`<html><body class="home cookies-not-set">${FORM}</body></html>`)).join() === 'contact');
      check('cmp-filter: <html class="show--consent"> (cookieconsent) keeps the page\'s forms',
        (await formIdsOn(`<html class="show--consent"><body>${FORM}</body></html>`)).join() === 'contact');
      check('cmp-filter: <html class="js cookies"> (Modernizr) keeps the page\'s forms',
        (await formIdsOn(`<html class="js cookies"><body>${FORM}</body></html>`)).join() === 'contact');
      // A real banner is still excluded: by vendor id, and by the generic arm on a non-root container.
      const bannerForm = '<form id="cmp"><input type="text" name="x"><button>Submit</button></form>';
      check('cmp-filter: a form inside #onetrust-banner-sdk is still excluded',
        (await formIdsOn(`<html><body>${FORM}<div id="onetrust-banner-sdk">${bannerForm}</div></body></html>`)).join() === 'contact');
      check('cmp-filter: a form inside a generic .cookie-banner is still excluded, even under a flagged <body>',
        (await formIdsOn(`<html><body class="cookies-not-set">${FORM}<div class="cookie-banner">${bannerForm}</div></body></html>`)).join() === 'contact');

      // ── CMP heuristic end to end (F10 / F31 repros) on a fake host: every request is answered locally ──
      // `writes` is what actually reached the "server" past the click guards: any non-GET, or any path but /.
      const cmpCtx = await browser.newContext();
      const site: { html: string; writes: string[] } = { html: '', writes: [] };
      type FulfillRoute = PwRoute & { fulfill(o: { status: number; contentType: string; body: string }): Promise<void> };
      await cmpCtx.route('**/*', (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.hostname !== 'site.example.test') return route.abort();
        if (req.method() !== 'GET' || u.pathname !== '/') site.writes.push(`${req.method()} ${u.pathname}`);
        return (route as FulfillRoute).fulfill({ status: 200, contentType: 'text/html', body: u.pathname === '/' ? site.html : '<p>left the page</p>' });
      });
      const onBanner = async (html: string, action: 'accept' | 'reject') => {
        site.html = html;
        site.writes = [];
        const p = await cmpCtx.newPage();
        try {
          await p.addInitScript({ content: 'window.__name = (f) => f' }); // tsx keepNames, as above
          await p.goto('https://site.example.test/', { waitUntil: 'load' });
          const det = await detectCmp(p);
          const res = await interactWithCmp(p, det, action);
          await p.waitForTimeout(400);
          const clicked = await p.evaluate<string | null>('window.__clicked || null').catch(() => 'page gone');
          const restored = await p
            .evaluate<boolean>('String(HTMLFormElement.prototype.submit).includes("[native code]") && !document.querySelector("[data-wa-cmp-target]")')
            .catch(() => false);
          return { det, res, clicked, url: p.url(), writes: site.writes.slice(), restored };
        } finally {
          await p.close();
        }
      };

      const newsletter = await onBanner(
        '<html><body><h1>Shop</h1><section class="newsletter-banner"><p>We respect your privacy.</p>' +
          '<form action="/subscribe" method="post"><input name="email"><input type="submit" value="OK"></form></section></body></html>',
        'accept',
      );
      check('cmp-e2e: a newsletter "banner" is not taken for a consent banner, and its form is never submitted',
        !newsletter.det.detected && !newsletter.res.clicked && newsletter.writes.length === 0, JSON.stringify(newsletter));

      const footer = await onBanner(
        '<html><body><div id="cookie-banner"><p>We use cookies to improve your experience.</p>' +
          '<button id="cookie-accept" onclick="window.__clicked=\'banner\'">Accept</button></div><main><p>Content</p></main>' +
          '<footer><div class="footer-notice"><p>Read our privacy and cookie policy.</p><form action="/agree" method="post">' +
          '<button onclick="window.__clicked=\'footer\'">I agree</button></form></div></footer></body></html>',
        'accept',
      );
      check('cmp-e2e: the real #cookie-banner wins over a later footer notice, and no form is posted',
        footer.det.presenceSelector === '#cookie-banner' && footer.res.clicked && footer.clicked === 'banner' && footer.writes.length === 0,
        JSON.stringify(footer));

      const nested = await onBanner(
        '<html><body><div class="products"><div><div><div><div><button onclick="window.__clicked=\'cart\'">Add to cart</button>' +
          '</div></div></div></div></div><div class="cookie-bar"><p>This site uses cookies.</p><div><div><div><div>' +
          '<button onclick="window.__clicked=\'accept\'">Accept</button></div></div></div></div></div></body></html>',
        'accept',
      );
      check('cmp-e2e: a banner button nested 4 divs deep is clicked, not the earlier "Add to cart" its old selector matched',
        nested.res.clicked && nested.clicked === 'accept', JSON.stringify(nested));

      const privacyForm = await onBanner(
        '<html><body><div class="privacy-notice"><p>We value your privacy and use cookies.</p><form action="/signup" method="post">' +
          '<input type="email" name="email"><input type="submit" value="I agree"></form></div></body></html>',
        'accept',
      );
      check('cmp-e2e: an "I agree" submit in a privacy-notice form is never clicked or submitted',
        !privacyForm.res.clicked && privacyForm.writes.length === 0, JSON.stringify(privacyForm));

      // Defence in depth: an eligible banner button whose own handler submits a form or navigates away.
      const sneaky =
        '<html><body><div id="cookie-banner"><p>We use cookies.</p>' +
        '<button id="yes" type="button" onclick="window.__clicked=\'accept\'; document.getElementById(\'f\').submit()">Accept</button>' +
        '<button id="no" type="button" onclick="window.__clicked=\'reject\'; location.href=\'/elsewhere\'">Reject</button></div>' +
        '<form id="f" method="post" action="/subscribe"><input type="hidden" name="x" value="1"></form></body></html>';
      const sneakyAccept = await onBanner(sneaky, 'accept');
      check('cmp-e2e: a banner button that calls form.submit() is clicked but submits nothing',
        sneakyAccept.res.clicked && sneakyAccept.clicked === 'accept' && sneakyAccept.writes.length === 0 &&
          sneakyAccept.url === 'https://site.example.test/',
        JSON.stringify(sneakyAccept));
      check('cmp-e2e: the in-page guards are undone after the click', sneakyAccept.restored, JSON.stringify(sneakyAccept));
      const sneakyReject = await onBanner(sneaky, 'reject');
      check('cmp-e2e: a banner button that sets location.href is clicked but the page never leaves',
        sneakyReject.res.clicked && sneakyReject.clicked === 'reject' && sneakyReject.writes.length === 0 &&
          sneakyReject.url === 'https://site.example.test/',
        JSON.stringify(sneakyReject));

      const plain = await onBanner(
        '<html><body><div class="cookie-notice"><p>We use cookies.</p><button onclick="window.__clicked=\'a\'">Accept all</button>' +
          '<button onclick="window.__clicked=\'r\'">Reject all</button></div></body></html>',
        'reject',
      );
      check('cmp-e2e: a plain custom banner is still detected and its reject clicked',
        plain.det.detected && plain.det.method === 'heuristic' && plain.res.clicked && plain.clicked === 'r', JSON.stringify(plain));
      await cmpCtx.close();

      // A form in a same-origin iframe is ringed where the iframe sits on the page, not near (0, 0).
      // The frame: 2000px down, a 3px border; the form: 8px in (the frame body's default margin).
      await page.setContent(
        '<html><body style="margin:0"><div style="height:2000px"></div>' +
          '<iframe style="border:3px solid #000;width:600px;height:400px;display:block" ' +
          'srcdoc="<form id=hs><input type=email name=email></form>"></iframe></body></html>',
      );
      await page.evaluate('window.__name = (f) => f');
      const framed = (await page.evaluate<RawForm[]>(extractFormsInPage)).find((f) => f.formId === 'hs');
      check('rect: a form in a same-origin iframe is measured in top-page coordinates (chromium)',
        framed?.rect?.x === 11 && framed?.rect?.y === 2011, JSON.stringify(framed?.rect));

      // Interactive discovery's own CMP filter (gatherCtaFacts) must not read a flagged ROOT as a banner.
      const ctaFactsOn = async (html: string): Promise<CtaFacts[]> => {
        await page.setContent(html);
        await page.evaluate('window.__name = (f) => f');
        return page.evaluate<CtaFacts[]>(gatherCtaFacts);
      };
      const demo = await ctaFactsOn('<html class="show--consent"><body class="cookies-not-set"><button>Book a demo</button></body></html>');
      check('cta-cmp: "Book a demo" under a flagged <html>/<body> is not a consent control (chromium)',
        demo.length === 1 && demo[0].inCmp === false && selectCtas(demo).length === 1, JSON.stringify(demo));
      const inBanner = await ctaFactsOn('<html><body class="cookies-not-set"><div class="cookie-banner"><button>Request a demo</button></div></body></html>');
      check('cta-cmp: a control inside a generic .cookie-banner is still a consent control (chromium)',
        inBanner.length === 1 && inBanner[0].inCmp === true, JSON.stringify(inBanner));
    } finally {
      await browser.close();
    }
  }
}

console.log(`web-audit tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (passed < 60) {
  console.error(`expected at least 60 checks to run, got ${passed}`);
  process.exit(1);
}
