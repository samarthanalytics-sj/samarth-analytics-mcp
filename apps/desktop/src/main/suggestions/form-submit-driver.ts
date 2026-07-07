// REAL-SUBMIT form driver (Phase 2). Fills a form with the operator-reviewed values and submits it
// FOR REAL, then reports the analytics events the tag fires.
//
// SAFETY MODEL — deliberately different from the abort-first verify driver:
//  - The form's OWN submission (the POST to the site / CRM) is ALLOWED THROUGH. This creates a real
//    submission (a real lead / email). It is operator-initiated per submit, behind an explicit warning.
//  - ANALYTICS collectors (GA4 / first-party sGTM / Meta / …) are CAPTURED then aborted, so the tag
//    firing is PROVEN without polluting GA4 / the ad platform with a test conversion.
//  - Only recognised collectors are aborted (NOT every cross-site beacon), so the form POST — even to a
//    third-party form host — is not blocked. An unrecognised pixel MAY deliver (documented limitation).
//
// Playwright is loaded lazily; absent → a clear error.

import { requestAllowed } from './ssrf';
import { classifyCollector, parseGa4CollectHit, beaconHost, beaconPlatform, type Collector } from '../../shared/runtime-capture';
import { PlaywrightUnavailableError } from './playwright-driver';
import { buildLoaderSrc, isPreviewLoader } from './verify-driver';

interface PwRoute {
  request(): { url(): string; postData(): string | null; resourceType(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<T = unknown>(fn: unknown, arg?: unknown): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; timeout?: number }): Promise<Buffer>;
}
interface PwContext {
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  newPage(): Promise<PwPage>;
}
interface PwBrowser { newContext(opts?: Record<string, unknown>): Promise<PwContext>; close(): Promise<void> }
interface Playwright { chromium: { launch(opts?: { headless?: boolean }): Promise<PwBrowser> } }

async function loadPlaywright(): Promise<Playwright | null> {
  try {
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as Playwright;
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}
const safePostData = (req: { postData(): string | null }): string | null => {
  try { return req.postData(); } catch { return null; }
};

/** An analytics hit to capture+abort (never deliver). classifyCollector catches direct GA4/Meta/TikTok,
 *  but the verify driver only catches FIRST-PARTY sGTM via its "abort every cross-site beacon" mode —
 *  which we can't use here (it would kill the form's own POST). So we ALSO match any GA4 Measurement
 *  Protocol endpoint (`/g/collect`, or `/collect` carrying GA4 markers) on ANY host, so a first-party
 *  sGTM conversion isn't delivered to real GA4. A normal form POST never hits these paths. */
export function isAnalyticsHit(url: string): boolean {
  if (classifyCollector(url)) return true;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith('/g/collect')) return true;
    if (path.endsWith('/collect') && (u.searchParams.get('v') === '2' || u.searchParams.has('tid') || u.searchParams.has('en'))) return true;
  } catch { /* not a parseable URL */ }
  return false;
}

export interface FormSubmitFieldInput {
  selector: string;
  /** input type / 'select' / 'textarea' / 'checkbox' / 'radio' — drives how the value is applied. */
  type: string;
  value: string;
}
/** The ONE reviewed form to submit — its identity (so we target it, not a same-named field on another
 *  form) plus the fields to fill. */
export interface FormSubmitInput {
  formId: string;
  formClasses: string;
  /** 'js' = a div/JS widget (no <form>) → click its submit control; anything else = native <form>. */
  method: string;
  fields: FormSubmitFieldInput[];
}
export interface FormSubmitDriverOptions {
  /** GTM Preview snippet so DRAFT tags load; omit to test whatever's published on the live page. */
  containerSnippet?: string;
  navTimeoutMs?: number;
  settleMs?: number;
}
export interface FormSubmitDriverResult {
  ok: boolean;
  injected: boolean;
  previewAuth: boolean;
  filled: number;
  submitted: boolean;
  note?: string;
  error?: string;
  /** GA4 event names observed after the submit (the proof the form fired the tag). */
  events: string[];
  /** Distinct analytics beacon hosts observed (GA4/sGTM/pixels). */
  beacons: string[];
  /** Distinct beacon VENDORS observed (meta/linkedin/pinterest/…) — pairs pixel/ad tags. */
  beaconPlatforms?: string[];
  /** JPEG data-URI screenshot of the form after the real submit (the form ringed) — visual proof of
   *  what was submitted. Best-effort. */
  screenshot?: string;
}

/** Grant Consent Mode v2 so consent-gated tags fire (same synthetic override the verify driver uses). */
function grantConsentInPage(): void {
  const w = window as unknown as { dataLayer?: unknown[] };
  const dl = (w.dataLayer = w.dataLayer || []);
  const gtag = function (this: unknown): void {
    // eslint-disable-next-line prefer-rest-params
    dl.push(arguments);
  };
  (gtag as unknown as (...a: unknown[]) => void)('consent', 'update', {
    ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted',
  });
}

/** Fill the reviewed values and submit the ONE reviewed form. Two paths:
 *   - native `<form>` (method != 'js'): scope to the resolved form, validate, requestSubmit().
 *   - div/JS widget (method === 'js', no `<form>`): scope to the host container and CLICK its
 *     Submit/Send control so the widget's own JS handler runs.
 *  Scoping to one element is the safety guarantee: a same-named field on another form is never
 *  touched, so we never fill + submit an unrelated newsletter/search form. Self-contained —
 *  serialized to page.evaluate (DOM globals only, no external refs). */
function fillAndSubmitInPage(spec: { formId: string; formClasses: string; method: string; fields: FormSubmitFieldInput[] }): { filled: number; submitted: boolean; note?: string } {
  // React (and Vue/Angular) CONTROLLED inputs track their value through a framework-installed setter,
  // so a plain `el.value = x` is ignored — on submit the form validates its framework STATE (still
  // empty for our required fields) and BLOCKS the real submission, so only form_start fires, never
  // form_submission. Setting through the NATIVE prototype setter + dispatching input makes the
  // framework's onChange run and update its state, so the real submit proceeds.
  const nativeSet = (node: Element, value: string): void => {
    const proto =
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(node, value);
    else (node as HTMLInputElement).value = value;
  };
  const setValue = (el: Element, f: FormSubmitFieldInput): void => {
    const tag = el.tagName.toLowerCase();
    if (f.type === 'checkbox' || f.type === 'radio') {
      const box = el as HTMLInputElement;
      // click() flips it AND fires the framework's onChange (setting .checked directly does not).
      if (box.checked !== (f.value === 'true')) { try { box.click(); } catch { box.checked = f.value === 'true'; } }
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opt = Array.prototype.slice.call(sel.options).find(
        (o: HTMLOptionElement) => (o.textContent || '').trim() === f.value || o.value === f.value,
      ) as HTMLOptionElement | undefined;
      nativeSet(sel, opt ? opt.value : f.value);
    } else {
      nativeSet(el, f.value);
    }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true })); // many forms validate on blur (touched)
    } catch { /* older engines */ }
  };
  const fillWithin = (root: ParentNode): number => {
    let n = 0;
    for (const f of spec.fields) {
      let el: Element | null = null;
      try { el = root.querySelector(f.selector); } catch { el = null; } // scoped to the resolved widget ONLY
      if (!el) continue;
      setValue(el, f);
      n += 1;
    }
    return n;
  };
  // Ring the form we're submitting + scroll it into view, so the driver's screenshot is visual proof of
  // exactly which form was submitted with what values.
  const ring = (node: Element): void => {
    try {
      const h = node as HTMLElement;
      h.style.setProperty('outline', '3px solid #ff2d55', 'important');
      h.style.setProperty('outline-offset', '2px', 'important');
      h.style.setProperty('box-shadow', '0 0 0 4px rgba(255,45,85,0.30)', 'important');
      h.scrollIntoView({ block: 'center', inline: 'center' });
    } catch { /* best-effort */ }
  };

  // ── div/JS widget: no <form> — fill within the host + click its submit control. ──
  if (spec.method === 'js') {
    let host: Element | null = spec.formId ? document.getElementById(spec.formId) : null;
    if (!host && spec.formClasses) {
      const first = spec.formClasses.split(/\s+/).filter(Boolean)[0];
      if (first) { try { host = document.querySelector('.' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(first) : first)); } catch { host = null; } }
    }
    if (!host) {
      // Resolve by structure: the nearest ancestor of a matched field that contains >=2 reviewed fields.
      for (const f of spec.fields) {
        let el: Element | null = null;
        try { el = document.querySelector(f.selector); } catch { el = null; }
        if (!el) continue;
        let node: Element | null = el.parentElement;
        for (let i = 0; node && i < 12; i++, node = node.parentElement) {
          let c = 0;
          for (const g of spec.fields) { try { if (node.querySelector(g.selector)) c += 1; } catch { /* */ } }
          if (c >= Math.min(2, spec.fields.length)) { host = node; break; }
        }
        if (host) break;
      }
    }
    if (!host) return { filled: 0, submitted: false, note: 'could not locate the JS/div form widget on the page' };
    const filled = fillWithin(host);
    if (filled === 0) return { filled, submitted: false, note: 'the widget was found but none of its reviewed fields matched' };
    const SUBMIT_RE = /\b(submit|send|subscribe|sign\s*up|sign\s*me\s*up|get\s+started|register|join\b|request|contact\s+us|book\b|apply|continue|next)\b/i;
    const ctrls = Array.prototype.slice.call(host.querySelectorAll('button, [role="button"], a, [onclick], input[type="submit"], input[type="button"]')) as HTMLElement[];
    let btn: HTMLElement | null = null;
    for (const c of ctrls) {
      const label = ((c.textContent || '') + ' ' + ((c as HTMLInputElement).value || '')).trim();
      if (SUBMIT_RE.test(label)) { btn = c; break; }
    }
    if (!btn && ctrls.length === 1) btn = ctrls[0]; // a lone button-like control
    if (!btn) return { filled, submitted: false, note: 'filled the widget but could not find its Submit / Send button' };
    ring(host);
    try { btn.click(); return { filled, submitted: true }; } catch (e) { return { filled, submitted: false, note: String(e).slice(0, 150) }; }
  }

  // ── native <form> path ──
  const forms = Array.prototype.slice.call(document.querySelectorAll('form')) as HTMLFormElement[];
  if (forms.length === 0) return { filled: 0, submitted: false, note: 'no <form> element on the page' };
  let form: HTMLFormElement | null = null;
  if (spec.formId) form = forms.find((f) => f.id === spec.formId) || null;
  if (!form && spec.formClasses) form = forms.find((f) => (f.getAttribute('class') || '') === spec.formClasses) || null;
  if (!form) {
    let best = 0;
    for (const fm of forms) {
      let c = 0;
      for (const fld of spec.fields) { try { if (fm.querySelector(fld.selector)) c += 1; } catch { /* bad selector */ } }
      if (c > best) { best = c; form = fm; }
    }
  }
  if (!form) return { filled: 0, submitted: false, note: 'could not locate the reviewed form on the page (its fields matched no <form>)' };
  const filled = fillWithin(form);
  if (filled === 0) return { filled, submitted: false, note: 'none of the reviewed fields were found in the form — nothing submitted' };
  ring(form);
  const fe = form as HTMLFormElement & { requestSubmit?: () => void; checkValidity?: () => boolean };
  // Don't claim "submitted" when the browser will block it: requestSubmit() silently no-ops on an
  // invalid form (a required field we didn't fill), so a green "Submitted" would be a lie.
  if (typeof fe.checkValidity === 'function' && !fe.checkValidity()) {
    return { filled, submitted: false, note: 'the form failed HTML validation (a required field is empty or invalid) — nothing was submitted' };
  }
  try {
    if (typeof fe.requestSubmit === 'function') fe.requestSubmit();
    else fe.submit();
    return { filled, submitted: true };
  } catch (e) {
    return { filled, submitted: false, note: String(e).slice(0, 150) };
  }
}

/**
 * Fill + submit ONE form for real, capturing the analytics beacons the tag fires.
 * The form POST is delivered (real submission); analytics collectors are captured then aborted.
 */
export async function runFormSubmitDriver(
  url: string,
  input: FormSubmitInput,
  opts: FormSubmitDriverOptions = {},
): Promise<FormSubmitDriverResult> {
  const navTimeoutMs = opts.navTimeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 1500;
  const loaderSrc = buildLoaderSrc(opts.containerSnippet);
  const previewAuth = isPreviewLoader(loaderSrc);
  const base: FormSubmitDriverResult = { ok: false, injected: false, previewAuth, filled: 0, submitted: false, events: [], beacons: [] };

  if (!(await requestAllowed(url))) {
    return { ...base, error: `Refusing to load ${url}: blocked by the SSRF guard (private/loopback/invalid host).` };
  }
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightUnavailableError();

  const captured: { url: string; body: string | null; collector: Collector }[] = [];
  let browser: PwBrowser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });

    await context.route('**/*', (route) => {
      const req = route.request();
      const reqUrl = req.url();
      if (isAnalyticsHit(reqUrl)) {
        // Analytics hit (incl. first-party sGTM) → capture it as proof, never deliver it (no GA4/ad
        // pollution). Unknown-host /g/collect hits get 'server' so the GA4 payload parser still runs.
        captured.push({ url: reqUrl, body: safePostData(req), collector: classifyCollector(reqUrl) ?? 'server' });
        void route.abort();
        return;
      }
      // Everything else — INCLUDING the form's own POST — is allowed (subject to SSRF), so the real
      // submission actually happens and the site fires its form_submission event.
      void requestAllowed(reqUrl).then((ok) => (ok ? route.continue() : route.abort()), () => route.abort());
    });

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs });
    } catch (e) {
      return { ...base, error: `could not load ${url}: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}` };
    }

    let injected = false;
    if (loaderSrc) {
      await page.evaluate((src: string) => {
        const w = window as unknown as { dataLayer?: unknown[] };
        w.dataLayer = w.dataLayer || [];
        w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
        const s = document.createElement('script');
        s.async = true;
        s.src = src;
        (document.head || document.documentElement).appendChild(s);
      }, loaderSrc);
      injected = true;
      await page.waitForTimeout(Math.max(settleMs, 1200));
    }
    await page.evaluate(grantConsentInPage);

    const before = captured.length;
    let outcome: { filled: number; submitted: boolean; note?: string };
    try {
      outcome = await page.evaluate<{ filled: number; submitted: boolean; note?: string }>(fillAndSubmitInPage, { formId: input.formId, formClasses: input.formClasses, method: input.method, fields: input.fields });
    } catch (e) {
      outcome = { filled: 0, submitted: false, note: (e instanceof Error ? e.message : String(e)).slice(0, 150) };
    }
    // Give the AJAX round-trip + the success-state dataLayer push (form_submission) + the tag time to
    // fire, then settle. React forms push the event only after the fetch resolves, so wait generously.
    await page.waitForTimeout(Math.max(settleMs, 2500));

    // Visual proof of the real submit — the ringed form (+ any success message it now shows).
    let screenshot: string | undefined;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 4000 });
      screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { /* never fail a submit over a screenshot */ }

    const hits = captured.slice(before);
    const events = [
      ...new Set(
        hits
          .filter((h) => h.collector === 'ga4' || h.collector === 'server')
          .flatMap((h) => parseGa4CollectHit({ url: h.url, body: h.body }).map((ev) => ev.event))
          .filter((e): e is string => Boolean(e)),
      ),
    ];
    const beacons = [...new Set(hits.map((h) => beaconHost(h.url)).filter(Boolean))];
    // The specific vendor per beacon (from the FULL hit url — a bare host loses the /tr path Meta needs),
    // so a pixel/ad form tag (Meta/LinkedIn/Pinterest/…) can be paired by its vendor.
    const beaconPlatforms = [...new Set(hits.map((h) => beaconPlatform(h.url)).filter((p) => p && p !== 'other'))];
    return {
      ...base,
      ok: true,
      injected,
      filled: outcome.filled,
      submitted: outcome.submitted,
      ...(outcome.note ? { note: outcome.note } : {}),
      events,
      beacons,
      beaconPlatforms,
      ...(screenshot ? { screenshot } : {}),
    };
  } catch (e) {
    return { ...base, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best-effort */ }
    }
  }
}
