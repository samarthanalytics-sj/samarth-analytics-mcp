// Redirect hops in the desktop's headless Playwright drivers (no browser needed).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/redirect-hops.test.ts
//
// Playwright calls a context.route handler only for the FIRST URL of a redirect chain and follows every
// later hop itself. Every headless driver here guarded each routed request, so a public URL that 302s to
// a private, loopback or metadata address was still loaded, and the drivers read it (DOM inventory,
// containers, screenshots), drove it (clicks) and, in the real-submit driver, filled and SUBMITTED a form
// on it. The fakes below behave like Playwright on exactly that point: only the first URL reaches the
// route handler, and a server redirect lands the page elsewhere and emits a 'request' event whose
// redirectedFrom is set.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchRedirectHops } from '../ssrf';
import { createPlaywrightDriver } from '../playwright-driver';
import { runFormSubmitDriver } from '../form-submit-driver';
import { runSyntheticTest } from '../synthetic-driver';
import { detectLiveContainers, runVerifyDriver, runSuggestionScreenshots } from '../verify-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// IP literals throughout, so the real (default) DNS-resolving guard never needs the network.
const PUBLIC_START = 'http://203.0.113.10/contact';
const PUBLIC_OTHER = 'http://203.0.113.10/contact-us';
const INTERNAL = 'http://10.0.0.5:8080/admin';
const REFUSED = /^blocked: redirected to 10\.0\.0\.5:8080/;

interface FakeReq {
  url(): string;
  method(): string;
  resourceType(): string;
  postData(): string | null;
  redirectedFrom(): FakeReq | null;
}
const fakeReq = (url: string, from: FakeReq | null = null): FakeReq => ({
  url: () => url,
  method: () => 'GET',
  resourceType: () => 'document',
  postData: () => null,
  redirectedFrom: () => from,
});

type RouteHandler = (route: { request(): FakeReq; continue(o?: unknown): Promise<void>; abort(): Promise<void> }) => unknown;

/** What the route handler decided for `url`: 'continue' or 'abort'. */
function decide(handler: RouteHandler, url: string): Promise<'continue' | 'abort'> {
  return new Promise((resolve) => {
    void handler({ request: () => fakeReq(url), continue: async () => resolve('continue'), abort: async () => resolve('abort') });
  });
}

/** In-page results by the evaluated function's name: the landed page "has" a scan, a form, a container
 *  and a clickable control, so a test can see whether any of it was read or driven. */
function evaluateResult(name: string): unknown {
  switch (name) {
    case 'collectPageInBrowser': return { title: 'PAGE', links: [], ctas: [] };
    case 'extractFormsInPage': return [];
    case 'fillAndSubmitInPage': return { filled: 2, submitted: true };
    case 'readGtmDebugInPage': return { containerIds: ['GTM-TEST1'], dataLayerEvents: [], dataLayer: [] };
    case 'driveInPage': return { targetFound: true, performed: true };
    case 'locateFormInPage': return { found: true };
    case 'ringedClipInPage': return null;
    default: return undefined;
  }
}

/**
 * A fake Playwright module. `redirects` maps a navigated URL to where the server redirects it.
 * `lateRedirectOn` names an in-page function: when it is evaluated, a subresource/iframe redirect to
 * INTERNAL is emitted (a hop during the drive, after the landing check). Records every evaluate (by
 * function name, with the page it ran on) and every screenshot.
 */
function fakePlaywright(redirects: Record<string, string>, lateRedirectOn?: string) {
  const evaluated: Array<{ fn: string; at: string }> = [];
  const shots: string[] = [];
  const routes: RouteHandler[] = [];
  const makePage = () => {
    const listeners: Record<string, Array<(arg: unknown) => void>> = {};
    const emit = (event: string, arg: unknown): void => (listeners[event] ?? []).forEach((cb) => cb(arg));
    let current = 'about:blank';
    return {
      goto: async (url: string) => {
        if (url === 'about:blank') { current = url; return null; }
        const route = routes[routes.length - 1];
        if (route && (await decide(route, url)) === 'abort') throw new Error(`net::ERR_FAILED at ${url}`);
        const first = fakeReq(url);
        emit('request', first);
        const landed = redirects[url];
        const last = landed ? fakeReq(landed, first) : first;
        if (landed) emit('request', last); // never routed, exactly like Playwright
        current = landed ?? url;
        return { status: () => 200, request: () => last };
      },
      evaluate: async (fn: unknown) => {
        const name = typeof fn === 'function' ? fn.name : '';
        evaluated.push({ fn: name, at: current });
        if (lateRedirectOn && name === lateRedirectOn) emit('request', fakeReq(INTERNAL, fakeReq('http://203.0.113.10/frame')));
        return evaluateResult(name);
      },
      on: (event: string, cb: (arg: unknown) => void) => { (listeners[event] ??= []).push(cb); },
      frames: () => [{ url: () => current }],
      url: () => current,
      waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
      screenshot: async () => { shots.push(current); return Buffer.from('jpeg'); },
      viewportSize: () => ({ width: 1366, height: 900 }),
      addInitScript: async () => {},
      close: async () => {},
    };
  };
  const context = {
    route: async (_pattern: string, handler: RouteHandler) => { routes.push(handler); },
    newPage: async () => makePage(),
    close: async () => {},
  };
  const browser = { newContext: async () => context, close: async () => {} };
  return { playwright: { chromium: { launch: async () => browser } }, evaluated, shots, routes };
}
const ranOn = (f: ReturnType<typeof fakePlaywright>, where: string, fn?: string): number =>
  f.evaluated.filter((e) => e.at === where && (fn === undefined || e.fn === fn)).length;

async function main(): Promise<void> {
  // ── the shared helper, with the drivers' default guard ─────────────────────────────────────────
  {
    const f = fakePlaywright({});
    const page = await (await (await f.playwright.chromium.launch()).newContext()).newPage();
    const watch = watchRedirectHops(page);
    check('helper: a page that went nowhere is not refused', (await watch.blockedLanding(null)) === null);
    await page.goto(PUBLIC_START);
    check('helper: a page that stayed public is not refused', (await watch.blockedLanding(null)) === null);
    const f2 = fakePlaywright({ [PUBLIC_START]: 'http://169.254.169.254/latest/meta-data/' });
    const page2 = await (await (await f2.playwright.chromium.launch()).newContext()).newPage();
    const watch2 = watchRedirectHops(page2);
    const resp = await page2.goto(PUBLIC_START);
    const note = await watch2.blockedLanding(resp);
    check('helper: a redirect to the metadata address is refused', /^blocked: redirected to 169\.254\.169\.254/.test(note ?? ''), String(note));
    check('helper: the refused page is moved off the internal address', page2.url() === 'about:blank', page2.url());
  }

  // ── playwright-driver (the optional scan engine): nothing read from the redirected page ──────────
  {
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const driver = await createPlaywrightDriver({ playwright: f.playwright, settleMs: 0 });
    const page = await driver.open(PUBLIC_START);
    check('scan: a redirect to a private address is refused', page.ok === false && REFUSED.test(page.error ?? ''), JSON.stringify(page));
    check('scan: no DOM, forms, status or final URL from the internal page', !page.raw && !page.rawForms && page.httpStatus === null && page.finalUrl === null);
    check('scan: no extractor ran on the internal page', ranOn(f, INTERNAL) === 0, JSON.stringify(f.evaluated));
    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okDriver = await createPlaywrightDriver({ playwright: ok.playwright, settleMs: 0 });
    const okPage = await okDriver.open(PUBLIC_START);
    check('scan: a public redirect is still read', okPage.ok === true && Boolean(okPage.raw) && okPage.finalUrl === PUBLIC_OTHER, JSON.stringify(okPage));
  }

  // ── form-submit-driver (REAL submit): never fills or submits a form on the redirected page ───────
  {
    const input = { formId: 'contact', formClasses: '', method: 'post', fields: [] };
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const res = await runFormSubmitDriver(PUBLIC_START, input, { playwright: f.playwright, settleMs: 0 });
    check('submit: a redirect to a private address is refused', res.ok === false && REFUSED.test(res.error ?? ''), JSON.stringify(res));
    check('submit: nothing was filled or submitted on the internal page', ranOn(f, INTERNAL, 'fillAndSubmitInPage') === 0 && res.submitted === false && res.filled === 0, JSON.stringify(f.evaluated));
    check('submit: no screenshot of the internal page', f.shots.length === 0 && !res.screenshot);
    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okRes = await runFormSubmitDriver(PUBLIC_START, input, { playwright: ok.playwright, settleMs: 0 });
    check('submit: a public redirect is still submitted', okRes.ok === true && okRes.submitted === true, JSON.stringify(okRes));
  }

  // ── synthetic-driver: no synthetic events pushed into the redirected page ────────────────────────
  {
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const res = await runSyntheticTest(PUBLIC_START, { playwright: f.playwright, events: ['purchase'], settleMs: 0 });
    check('synthetic: a redirect to a private address is refused', res.pagesOk === false && REFUSED.test(res.error ?? ''), JSON.stringify(res));
    check('synthetic: no event was pushed on the internal page', ranOn(f, INTERNAL) === 0, JSON.stringify(f.evaluated));
    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okRes = await runSyntheticTest(PUBLIC_START, { playwright: ok.playwright, events: ['purchase'], settleMs: 0 });
    check('synthetic: a public redirect is still driven', okRes.pagesOk === true && ranOn(ok, PUBLIC_OTHER) === 1, JSON.stringify(okRes));
  }

  // ── verify preflight: no containers read from the redirected page ────────────────────────────────
  {
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const res = await detectLiveContainers(PUBLIC_START, { playwright: f.playwright, settleMs: 0 });
    check('preflight: a redirect to a private address is refused', res.pageOk === false && REFUSED.test(res.error ?? '') && res.liveContainers.length === 0, JSON.stringify(res));
    check('preflight: nothing was read on the internal page', ranOn(f, INTERNAL) === 0, JSON.stringify(f.evaluated));
    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okRes = await detectLiveContainers(PUBLIC_START, { playwright: ok.playwright, settleMs: 0 });
    check('preflight: a public redirect is still read', okRes.pageOk === true && okRes.liveContainers.includes('GTM-TEST1'), JSON.stringify(okRes));
  }

  // ── verify drive: no click, submit, screenshot or dataLayer read on the redirected page ──────────
  {
    const tags = [
      { id: 't1', trigger: { kind: 'link_click', clickTextValue: 'Book a demo' } },
      { id: 't2', trigger: { kind: 'pageview' } },
    ];
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const res = await runVerifyDriver(PUBLIC_START, tags, { playwright: f.playwright, concurrency: 1, settleMs: 0 });
    check('verify: every tag on the redirected page is reported not driven, with the refusal',
      res.perTag.length === 2 && res.perTag.every((t) => !t.performed && !t.targetFound && REFUSED.test(t.note ?? '')), JSON.stringify(res.perTag));
    check('verify: nothing ran on the internal page (no click, no read)', ranOn(f, INTERNAL) === 0, JSON.stringify(f.evaluated));
    check('verify: no screenshot of the internal page', f.shots.length === 0);
    check('verify: the page is not listed as driven', !res.pagesDriven?.length);

    // A hop during the drive (an iframe redirecting while the control is clicked): the page's results,
    // its proof screenshots included, are dropped.
    const late = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER }, 'driveInPage');
    const lateRes = await runVerifyDriver(PUBLIC_START, tags, { playwright: late.playwright, concurrency: 1, settleMs: 0 });
    check('verify: a refused hop during the drive drops the page results',
      lateRes.perTag.length === 2 && lateRes.perTag.every((t) => !t.performed && REFUSED.test(t.note ?? '') && !t.screenshot), JSON.stringify(lateRes.perTag));
    check('verify: and skips its dataLayer read', !late.evaluated.some((e) => e.fn === 'readGtmDebugInPage'), JSON.stringify(late.evaluated.map((e) => e.fn)));

    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okRes = await runVerifyDriver(PUBLIC_START, tags, { playwright: ok.playwright, concurrency: 1, settleMs: 0 });
    check('verify: a public redirect is still driven', okRes.perTag.length === 2 && okRes.perTag.every((t) => t.performed) && okRes.pagesDriven?.length === 1, JSON.stringify(okRes.perTag));
  }

  // ── suggestion screenshots: no picture of the redirected page; private requests are routed off ───
  {
    const tags = [{ id: 's1', trigger: { kind: 'link_click', clickTextValue: 'Book a demo' } }];
    const f = fakePlaywright({ [PUBLIC_START]: INTERNAL });
    const res = await runSuggestionScreenshots(PUBLIC_START, tags, { playwright: f.playwright, concurrency: 1, settleMs: 0 });
    check('shots: no screenshot of the internal page', f.shots.length === 0 && res.shots.every((s) => !s.screenshot), JSON.stringify(res.shots));
    check('shots: nothing was located on the internal page', ranOn(f, INTERNAL) === 0, JSON.stringify(f.evaluated));
    // The screenshot pass had no request guard at all: a page loaded by it could pull a private subresource.
    check('shots: a request to a private address is aborted', f.routes.length === 1 && (await decide(f.routes[0], INTERNAL)) === 'abort');
    check('shots: a public request continues', f.routes.length === 1 && (await decide(f.routes[0], PUBLIC_OTHER)) === 'continue');

    const late = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER }, 'driveInPage');
    const lateRes = await runSuggestionScreenshots(PUBLIC_START, tags, { playwright: late.playwright, concurrency: 1, settleMs: 0 });
    check('shots: a refused hop after the load drops the page picture', lateRes.shots.length === 1 && !lateRes.shots[0].screenshot, JSON.stringify(lateRes.shots));

    const ok = fakePlaywright({ [PUBLIC_START]: PUBLIC_OTHER });
    const okRes = await runSuggestionScreenshots(PUBLIC_START, tags, { playwright: ok.playwright, concurrency: 1, settleMs: 0 });
    check('shots: a public redirect is still shot', okRes.shots.length === 1 && Boolean(okRes.shots[0].screenshot), JSON.stringify(okRes.shots));
  }

  // ── Tag Assistant driver: a visible Chrome session, so its wiring is pinned by source order ──────
  {
    const src = readFileSync(join(__dirname, '..', 'ta-driver.ts'), 'utf8');
    const watched = src.indexOf('watchRedirectHops(popup)');
    const pageCheck = src.indexOf('const refused = await popupLanding.blockedLanding(null);');
    const driven = src.indexOf('pagesDriven.push(pageUrl);');
    const pageGoto = src.indexOf('await popup.goto(withPreview(pageUrl)');
    const formCheck = src.indexOf('const refusedForm = await popupLanding.blockedLanding(null);');
    const realSubmit = src.indexOf('await popup.evaluate(allowFormSubmitInPage)');
    check('ta: the debug window is watched before any page is driven', watched > 0 && watched < pageGoto);
    check('ta: a page is checked after it loads and before it is driven', pageGoto > 0 && pageCheck > pageGoto && pageCheck < driven);
    check('ta: the page is checked again right before every real form submit', formCheck > 0 && realSubmit > formCheck && realSubmit - formCheck < 600);
  }

  console.log(`\nredirect-hops: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 30) { console.error(`expected >= 30 checks, got ${passed}`); process.exit(1); }
}

void main().catch((e) => { console.error(e); process.exit(1); });
