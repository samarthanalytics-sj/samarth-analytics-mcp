/**
 * Interactive form discovery — pure helper tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/interactive-forms.node.test.ts
 */
import {
  formSignature, MAX_INTERACTIVE_CLICKS, ctaRank, selectCtas, armInteractionGuards, blockDuringDiscovery, discoverInteractiveForms,
  type CtaFacts,
} from '../interactive-forms.js';
import type { FormAnalysis, RawForm } from '../../forms.js';
import type { PwPage } from '../../browser.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const form = (over: Partial<FormAnalysis> = {}): FormAnalysis => ({
  index: 0, action: '', method: 'js', formId: '', formClasses: '', title: 'Start your free trial',
  purpose: 'contact', fieldCount: 2,
  fields: [{ type: 'email', name: 'email', label: '', required: true }, { type: 'text', name: 'name', label: '', required: false }],
  piiFields: [], marketingCheckboxes: [], hasConsentCheckbox: false, hasPrivacyLink: false, issues: [],
  ...over,
});

// Same shape → same signature (so a revealed form already in the baseline is deduped, not re-added).
check('formSignature: identical forms share a signature', formSignature(form()) === formSignature(form()));
// Field ORDER must not matter (a re-scan can return fields in a different order).
check('formSignature: field order does not change the signature',
  formSignature(form()) === formSignature(form({ fields: [
    { type: 'text', name: 'name', label: '', required: false }, { type: 'email', name: 'email', label: '', required: true },
  ] })));
// Different purpose / field set → different signature (a genuinely new modal form is kept).
check('formSignature: a different purpose is distinct', formSignature(form()) !== formSignature(form({ purpose: 'newsletter' })));
check('formSignature: a different field set is distinct', formSignature(form()) !== formSignature(form({ fieldCount: 1, fields: [{ type: 'email', name: 'email', label: '', required: true }] })));
check('formSignature: a different title is distinct', formSignature(form()) !== formSignature(form({ title: 'Book a demo' })));
// The click cap is a small, positive bound.
check('MAX_INTERACTIVE_CLICKS is a small positive cap', Number.isInteger(MAX_INTERACTIVE_CLICKS) && MAX_INTERACTIVE_CLICKS > 0 && MAX_INTERACTIVE_CLICKS <= 12, String(MAX_INTERACTIVE_CLICKS));

// ── which controls may be clicked (ctaRank / selectCtas) ─────────────────────────────────────────────
// The page only REPORTS facts; these pure rules decide. A wrong "yes" here is a click on a live site.
const cta = (over: Partial<CtaFacts> = {}): CtaFacts => ({
  tag: 'BUTTON', role: '', type: '', href: null, label: '', attrs: {},
  inForm: false, nearFields: false, inNav: false, inCmp: false, ...over,
});

// A modal opener that should be clicked.
check('ctaRank: a standalone "Book a demo" dialog opener is a candidate',
  ctaRank(cta({ label: 'Book a demo', attrs: { 'aria-haspopup': 'dialog' } })) === 0);
check('ctaRank: an intent label alone is enough on a <button>', ctaRank(cta({ label: 'Start free trial' })) === 0);

// N19: a JS/div form's own submit control (no <form>, no type) must never be clicked.
check('ctaRank: <div><input type=email><button>Subscribe</button></div> is NOT a candidate (div-form submit)',
  ctaRank(cta({ label: 'Subscribe', nearFields: true })) === null);
check('ctaRank: a "Request a callback" control beside formless fields is NOT a candidate',
  ctaRank(cta({ label: 'Request a callback', nearFields: true, attrs: { 'data-toggle': 'modal' } })) === null);
check('ctaRank: a control inside a <form> is NOT a candidate', ctaRank(cta({ label: 'Book a demo', inForm: true })) === null);
check('ctaRank: <button form="f">Request a quote</button> (form-owned, outside it) is NOT a candidate',
  ctaRank(cta({ label: 'Request a quote', inForm: true })) === null);
check('ctaRank: type=submit / reset / image are never candidates',
  ['submit', 'reset', 'image'].every((type) => ctaRank(cta({ label: 'Get started', type })) === null));

// N24: purchase / cart / destructive / account controls are never clicked, even when they declare a modal.
check('ctaRank: <button aria-controls="cart-drawer">Add to cart</button> is NOT a candidate',
  ctaRank(cta({ label: 'Add to cart', attrs: { 'aria-controls': 'cart-drawer' } })) === null);
check('ctaRank: a data-toggle=modal "Buy now" is NOT a candidate',
  ctaRank(cta({ label: 'Buy now', attrs: { 'data-toggle': 'modal' } })) === null);
check('ctaRank: checkout / pay / delete / log out / apply coupon are never candidates',
  ['Checkout', 'Pay now', 'Delete account', 'Log out', 'Apply coupon', 'Cancel subscription', 'Submit']
    .every((label) => ctaRank(cta({ label, attrs: { 'aria-haspopup': 'dialog' } })) === null));
check('ctaRank: a modal attribute no longer stands in for intent (bare aria-controls, no label)',
  ctaRank(cta({ label: 'FAQ', attrs: { 'aria-controls': 'faq1' } })) === null);

// N22: navigation, tabs, accordions and menu toggles are not form openers.
check('ctaRank: a nav aria-haspopup "Products" toggle is NOT a candidate',
  ctaRank(cta({ label: 'Products', inNav: true, attrs: { 'aria-haspopup': 'true', 'aria-controls': 'm1' } })) === null);
check('ctaRank: a "Products" menu toggle outside nav is NOT a candidate either (aria-haspopup=true is a menu)',
  ctaRank(cta({ label: 'Products', attrs: { 'aria-haspopup': 'true', 'aria-controls': 'm1' } })) === null);
check('ctaRank: a collapse toggle with no intent label is NOT a candidate',
  ctaRank(cta({ label: 'What is included?', attrs: { 'data-bs-toggle': 'collapse', 'aria-controls': 'faq1' } })) === null);
check('ctaRank: a collapse toggle is NOT a candidate even when its text says "request a quote"',
  ctaRank(cta({ label: 'How do I request a quote?', attrs: { 'data-bs-toggle': 'collapse', 'aria-controls': 'faq2' } })) === null);
check('ctaRank: a tab (inside a tablist) is NOT a candidate', ctaRank(cta({ label: 'Contact', role: 'tab', inNav: true, attrs: { 'aria-controls': 'p2' } })) === null);
check('ctaRank: a consent-banner control is NOT a candidate', ctaRank(cta({ label: 'Customize', inCmp: true, attrs: { 'aria-haspopup': 'dialog' } })) === null);

// N20(a): a javascript: href that IS the action is never clicked; a no-op one (onclick opener) may be.
check('ctaRank: <a href="javascript:...submit()">Request a demo</a> is NOT a candidate',
  ctaRank(cta({ tag: 'A', href: "javascript:document.getElementById('demo').submit()", label: 'Request a demo' })) === null);
check('ctaRank: <a href="javascript:void(0)">Book a demo</a> (onclick opener) is a candidate',
  ctaRank(cta({ tag: 'A', href: 'javascript:void(0)', label: 'Book a demo' })) === 0);
check('ctaRank: <a href="#">Get started</a> is a candidate', ctaRank(cta({ tag: 'A', href: '#', label: 'Get started' })) === 0);
check('ctaRank: a real link with an intent label is NOT a candidate (its page is the crawler\'s)',
  ctaRank(cta({ tag: 'A', href: '/contact', label: 'Contact us' })) === null);
check('ctaRank: a real link that declares a modal is a candidate',
  ctaRank(cta({ tag: 'A', href: '/demo', label: 'Book a demo', attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': '#demo' } })) === 0);
check('ctaRank: an unlabelled data-bs-toggle=modal control ranks after intent labels',
  ctaRank(cta({ attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': '#m' } })) === 1);
check('ctaRank: a plain <div> without dialog markup is never a candidate', ctaRank(cta({ tag: 'DIV', label: 'Book a demo' })) === null);

// N22: ranking before the cap — six header toggles and icon buttons must not crowd out the CTA.
{
  const header: CtaFacts[] = ['Products', 'Solutions', 'Resources', 'Company', 'Pricing', 'Language'].map((label, i) =>
    cta({ label, inNav: true, attrs: { 'aria-haspopup': 'true', 'aria-controls': `m${i}` } }));
  const demo = cta({ label: 'Book a demo' });
  const picked = selectCtas([...header, demo]);
  check('selectCtas: nav toggles first in the document do not use up the budget before "Book a demo"',
    picked.length === 1 && picked[0] === header.length, JSON.stringify(picked));

  const iconOpeners: CtaFacts[] = Array.from({ length: 8 }, (_, i) => cta({ attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': `#m${i}` } }));
  const order = selectCtas([...iconOpeners, demo]);
  check('selectCtas: "Book a demo" outranks unlabelled modal openers that come before it',
    order[0] === iconOpeners.length && order.length === MAX_INTERACTIVE_CLICKS, JSON.stringify(order));

  const sameTarget = selectCtas([cta({ attrs: { 'data-toggle': 'modal', 'data-target': '#x' } }), cta({ attrs: { 'data-toggle': 'modal', 'data-target': '#x' } })]);
  check('selectCtas: two unlabelled openers of the same dialog are clicked once (empty labels are deduped)', sameTarget.length === 1);
  const twice = selectCtas([cta({ label: 'Book a demo' }), cta({ label: '  Book  a demo ' })]);
  check('selectCtas: one click per distinct label', twice.length === 1);
  const many = selectCtas(Array.from({ length: 10 }, (_, i) => cta({ label: `Request quote ${i}` })));
  check('selectCtas: never more than MAX_INTERACTIVE_CLICKS', many.length === MAX_INTERACTIVE_CLICKS);
  const unsafe = selectCtas([cta({ label: 'Subscribe', nearFields: true }), cta({ label: 'Add to cart', attrs: { 'aria-controls': 'cart' } })]);
  check('selectCtas: a page with only unsafe controls clicks nothing', unsafe.length === 0);
}

// ── N20: the in-page guards, run against stubbed browser globals ─────────────────────────────────────
await (async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    HTMLFormElement: Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement'),
    XMLHttpRequest: Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  type Listener = { type: string; fn: (e: unknown) => void; capture: unknown };
  const listeners: Listener[] = [];
  const fetched: string[] = [];
  const fakeWindow: Record<string, unknown> = {
    open: () => null, // the browser's answer when a popup is blocked
    fetch: (_input: unknown, init?: { method?: string }) => {
      fetched.push(String(init?.method ?? 'GET'));
      return Promise.resolve('ok');
    },
    addEventListener: (type: string, fn: (e: unknown) => void, capture: unknown) => listeners.push({ type, fn, capture }),
  };
  let realSubmits = 0;
  class FakeForm {
    submit(): void { realSubmits += 1; }
    requestSubmit(): void { realSubmits += 1; }
  }
  const xhrSent: string[] = [];
  class FakeXhr {
    m = '';
    open(method: string): void { this.m = method; }
    send(): void { xhrSent.push(this.m); }
  }
  let beaconsSent = 0;
  const define = (k: string, value: unknown): void => { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); };
  define('window', fakeWindow);
  define('HTMLFormElement', FakeForm);
  define('XMLHttpRequest', FakeXhr);
  define('navigator', { sendBeacon: () => { beaconsSent += 1; return true; } });
  try {
    check('guards: arming reports success', armInteractionGuards() === true);
    const listenerCount = listeners.length;
    check('guards: arming twice installs nothing twice', armInteractionGuards() === true && listeners.length === listenerCount);

    const popup = (fakeWindow.open as (u: string) => { closed?: boolean } | null)('https://calendly.com/x');
    check('guards: window.open returns a non-null stand-in (no "popup blocked → location.href" fallback)', !!popup && popup.closed === false);

    const form = new FakeForm();
    form.submit();
    form.requestSubmit();
    check('guards: form.submit() and requestSubmit() are no-ops', realSubmits === 0);

    const submit = listeners.find((l) => l.type === 'submit');
    const ev = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    submit?.fn(ev);
    check('guards: a submit event is cancelled AND stopped at window capture (site AJAX handlers never run)',
      !!submit && submit.capture === true && ev.prevented && ev.stopped);

    const click = listeners.find((l) => l.type === 'click');
    const clickOn = (href: string | null): boolean => {
      const anchor = href === null ? null : { getAttribute: () => href };
      const e = { prevented: false, target: { closest: () => anchor }, preventDefault() { this.prevented = true; } };
      click?.fn(e);
      return e.prevented;
    };
    check('guards: a javascript: href is cancelled (never run)', clickOn("javascript:document.forms[0].submit()"));
    check('guards: a real link is cancelled', clickOn('/contact') && clickOn('https://calendly.com/x'));
    check('guards: an empty href (reload) is cancelled', clickOn(''));
    check('guards: an in-page #hash is left alone (modal openers use it)', !clickOn('#demo'));
    check('guards: a click outside any anchor is left alone', !clickOn(null));

    const w = fakeWindow as { fetch: (i: unknown, init?: { method?: string }) => Promise<unknown> };
    const post = await w.fetch('/api/subscribe', { method: 'POST' }).then(() => 'sent', () => 'refused');
    const get = await w.fetch('/modal/demo.html').then(() => 'sent', () => 'refused');
    check('guards: a fetch write (POST) is refused before it reaches the network', post === 'refused' && !fetched.includes('POST'));
    check('guards: a fetch read (GET) still works (modal content can load)', get === 'sent' && fetched.includes('GET'));

    const x1 = new FakeXhr();
    x1.open('POST');
    x1.send();
    const x2 = new FakeXhr();
    x2.open('get');
    x2.send();
    check('guards: an XHR write is never sent, an XHR read is', !xhrSent.includes('POST') && xhrSent.includes('get'));

    const beacon = (g.navigator as { sendBeacon: (u: string) => boolean }).sendBeacon('/g/collect');
    check('guards: sendBeacon is refused', beacon === false && beaconsSent === 0);
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  }
})();

// ── N20/N24: what the network guard refuses while discovery clicks ───────────────────────────────────
check('network: a main-frame navigation is refused', blockDuringDiscovery({ method: 'GET', url: 'https://acme.example/contact', mainFrameNavigation: true }));
check('network: a form POST / API write is refused',
  ['POST', 'PUT', 'PATCH', 'DELETE'].every((method) => blockDuringDiscovery({ method, url: 'https://acme.example/api/lead', mainFrameNavigation: false })));
check('network: a GA4 hit fired by a synthetic click is refused',
  blockDuringDiscovery({ method: 'GET', url: 'https://region1.google-analytics.com/g/collect?v=2&en=generate_lead', mainFrameNavigation: false }));
check('network: a Meta Pixel / Ads conversion is refused',
  blockDuringDiscovery({ method: 'GET', url: 'https://www.facebook.com/tr?id=1&ev=Lead', mainFrameNavigation: false }) &&
  blockDuringDiscovery({ method: 'GET', url: 'https://www.googleadservices.com/pagead/conversion/123/', mainFrameNavigation: false }));
check('network: a GET for modal content (script, iframe, html) is allowed',
  !blockDuringDiscovery({ method: 'GET', url: 'https://js.hsforms.net/forms/embed/v2.js', mainFrameNavigation: false }) &&
  !blockDuringDiscovery({ method: 'get', url: 'https://acme.example/modal/demo', mainFrameNavigation: false }));

// ── discoverInteractiveForms end to end, against a fake page ─────────────────────────────────────────
const rawForm = (title: string): RawForm => ({
  index: 0, action: '', method: 'js', formId: '', formName: '', formClasses: '', title, fieldCount: 1,
  fields: [{ tag: 'input', type: 'email', name: `${title}-email`, id: '', label: 'Email', placeholder: '', autocomplete: '', required: true }],
  hasPrivacyLink: false, text: title.toLowerCase(),
});
type RouteHandler = (route: unknown) => Promise<void>;
function fakePage(opts: { facts: CtaFacts[]; navigateOnClick?: number; routeFails?: boolean; armFails?: boolean }) {
  let url = 'https://acme.example/pricing#plans';
  const state = { clicks: [] as number[], routed: [] as RouteHandler[], unrouted: [] as unknown[], calls: [] as string[] };
  const mainFrame = { main: true };
  const page = {
    url: () => url,
    mainFrame: () => mainFrame,
    route: async (_p: string, h: RouteHandler) => {
      if (opts.routeFails) throw new Error('route unavailable');
      state.routed.push(h);
    },
    unroute: async (_p: string, h: unknown) => { state.unrouted.push(h); },
    waitForTimeout: async () => undefined,
    evaluate: async (fn: { name: string }, arg?: unknown) => {
      state.calls.push(fn.name);
      if (fn.name === 'armInteractionGuards') {
        if (opts.armFails) throw new Error('page closed');
        return true;
      }
      if (fn.name === 'gatherCtaFacts') return opts.facts;
      if (fn.name === 'clickCta') {
        state.clicks.push(arg as number);
        if (arg === opts.navigateOnClick) url = 'https://acme.example/contact'; // an SPA router push
        return true;
      }
      if (fn.name === 'extractFormsInPage') {
        if (url.includes('/contact')) return [rawForm('Contact page form')];
        return state.clicks.length ? [rawForm('Demo modal')] : [];
      }
      return undefined;
    },
  };
  return { page: page as unknown as PwPage, state, mainFrame };
}

{
  // Click 0 opens a modal form; click 1 is a router push to /contact. The pass must stop there and never
  // report the /contact page's form as a popup on /pricing.
  const facts = [cta({ label: 'Book a demo' }), cta({ label: 'Contact sales' }), cta({ label: 'Get started' })];
  const { page, state, mainFrame } = fakePage({ facts, navigateOnClick: 1 });
  const res = await discoverInteractiveForms(page, 'https://acme.example/pricing', []);
  check('discover: a click that changes the page URL stops the pass', res.navigated === true && JSON.stringify(state.clicks) === '[0,1]', JSON.stringify(state.clicks));
  check('discover: the navigated page\'s form is NOT attributed to this page',
    res.forms.length === 1 && res.forms[0].title === 'Demo modal' && res.forms[0].hidden === true, JSON.stringify(res.forms.map((f) => f.title)));
  check('discover: a #hash on the start URL is not mistaken for a navigation', res.clicked === 2);
  check('discover: guards are armed before anything is gathered or clicked',
    state.calls.indexOf('armInteractionGuards') === 0 && state.calls.indexOf('gatherCtaFacts') === 1);
  check('discover: the network guard is installed for the pass and removed after it',
    state.routed.length === 1 && state.unrouted.length === 1 && state.unrouted[0] === state.routed[0]);

  // The installed handler, driven with fake routes.
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
  check('discover/network: a main-frame navigation is aborted (without an error page)',
    (await drive({ url: 'https://acme.example/contact', method: 'GET', nav: true, frame: mainFrame })) === 'abort:aborted');
  check('discover/network: an iframe loading a form embed falls through to the SSRF guard',
    (await drive({ url: 'https://forms.example/embed', method: 'GET', nav: true, frame: { child: true } })) === 'fallback');
  check('discover/network: an XHR POST is aborted',
    (await drive({ url: 'https://acme.example/api/subscribe', method: 'POST', nav: false, frame: mainFrame })) === 'abort:aborted');
}
{
  const { page, state } = fakePage({ facts: [cta({ label: 'Book a demo' })], routeFails: true });
  const res = await discoverInteractiveForms(page, 'https://acme.example/pricing', []);
  check('discover: no network guard → nothing is armed or clicked (fails closed)', res.clicked === 0 && state.calls.length === 0);
}
{
  const { page, state } = fakePage({ facts: [cta({ label: 'Book a demo' })], armFails: true });
  const res = await discoverInteractiveForms(page, 'https://acme.example/pricing', []);
  check('discover: in-page guards not armed → nothing is clicked, network guard still removed',
    res.clicked === 0 && !state.calls.includes('clickCta') && state.unrouted.length === 1);
}
{
  const unsafe = [cta({ label: 'Subscribe', nearFields: true }), cta({ label: 'Add to cart', attrs: { 'aria-controls': 'cart' } })];
  const { page, state } = fakePage({ facts: unsafe });
  await discoverInteractiveForms(page, 'https://acme.example/pricing', []);
  check('discover: unsafe controls reported by the page are never clicked', state.clicks.length === 0);
}

console.log(`\nInteractive-forms: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
