// OPT-IN interactive form discovery. The default scan is READ-ONLY and never clicks, so a form whose
// markup is only INJECTED when a CTA is clicked (a "Book a demo" / "Start free trial" button that opens a
// modal wizard) is invisible to it. When enabled (WEB_AUDIT_ENABLE_INTERACTIVE_FORMS=true, or the
// per-scan `interactiveForms` option), this clicks the page's "open-a-form" CTAs — and ONLY those — waits
// for a modal to appear, and re-runs the form scan on the revealed DOM.
//
// SAFETY: before any click, navigation is neutralised IN THE PAGE — window.open is stubbed, and anchor
// navigations + form submits are preventDefault'd at capture phase — so a click can only open an in-page
// modal, never leave the page, open a tab, or submit anything. Only form-intent buttons / modal-declaring
// controls are clicked (never a submit/reset/pay control), the click count is capped, and nothing is ever
// filled or submitted. All interaction runs via page.evaluate() — no Playwright-level navigation or click.
//
// WHICH controls are clicked is decided in Node by the pure ctaRank/selectCtas below, from facts the page
// reports (gatherCtaFacts), so the rule that keeps a submit/cart/nav control from ever being clicked is
// unit-tested rather than living only inside a stringified in-page routine.

import type { PwPage } from '../browser.js';
import { scanForms, type FormAnalysis } from '../forms.js';

/** A stable-ish identity for a detected form, to tell a newly-revealed form from the baseline ones. PURE. */
export function formSignature(f: FormAnalysis): string {
  const fields = f.fields.map((x) => `${x.type}:${x.name || ''}`).sort().join(',');
  return [f.purpose, f.method, f.fieldCount, f.formId, f.providerFormId ?? '', f.title, fields].join('|');
}

/** How many distinct CTAs we will click per page. Bounds the cost + side-effect surface. */
export const MAX_INTERACTIVE_CLICKS = 6;

// ── which controls may be clicked (PURE — judged in Node from what the page reports) ──────────────────

/** What the page reports about one visible control (see gatherCtaFacts). */
export interface CtaFacts {
  /** Upper-case tag name. */
  tag: string;
  /** Lower-cased `role` attribute ('' when absent). */
  role: string;
  /** Lower-cased `type` attribute ('' when absent). */
  type: string;
  /** The raw `href` attribute, or null when there is none. */
  href: string | null;
  /** Text + aria-label + title, whitespace-collapsed. */
  label: string;
  /** The modal/toggle attributes present on the control, with their values. */
  attrs: Record<string, string>;
  /** Inside a <form>, or owned by one (`form` / `formaction` attribute, or a `.form` owner): it can submit. */
  inForm: boolean;
  /** A rendered text-ish field outside any <form> shares a container with it (within 10 ancestors, as
   *  forms.ts climbs to anchor a JS/div form on its submit control) and sits within 300px of it: this
   *  control is that form's own submit, not a modal opener. */
  nearFields: boolean;
  /** Inside site navigation, a menu, or a tab list (forms.ts skips nav for the same reason). */
  inNav: boolean;
  /** Inside a cookie-consent / CMP banner. */
  inCmp: boolean;
}

/** "This opens a form" wording. */
const INTENT =
  /\b(book|schedule|request|start|get\s?started|sign\s?up|register|free\s?trial|try\s+(it\s+)?free|demo|quote|contact|apply|join|subscribe|enrol|enroll|get\s+in\s+touch|talk\s+to|get\s+a\s+quote|reach\s+out)\b/i;

/** Never clicked, whatever else the control says or declares: purchase / cart / payment, destructive,
 *  account and submit controls. A click on one of these is an action on the live site, not a reveal. */
const DENY =
  /\b(cart|bag|basket|buy|checkout|check\s+out|pay|payment|purchase|order|add\s+to|donate|book\s+now|reserve|upgrade|renew|refund|delete|remove|cancel|unsubscribe|log\s?out|sign\s?out|submit|apply\s+(coupon|code|discount|promo|filters?))\b/i;

/** `javascript:` hrefs that do nothing themselves (the onclick handler is the opener). Any other
 *  javascript: URL IS the action, and a click must never run one. */
const NOOP_JS_HREF = /^javascript:\s*(void\s*\(?\s*0\s*\)?\s*;?|;)?\s*$/i;

/** Markup that, on its own, declares "this opens a dialog". Bare aria-controls / data-target / collapse,
 *  dropdown and tab toggles do NOT: they expand an accordion or a menu, never a form. */
function opensModal(attrs: Record<string, string>): boolean {
  if ('data-modal' in attrs || 'data-micromodal-trigger' in attrs || 'data-fancybox' in attrs) return true;
  if ((attrs['aria-haspopup'] ?? '').trim().toLowerCase() === 'dialog') return true;
  return ['data-toggle', 'data-bs-toggle'].some((k) => (attrs[k] ?? '').trim().toLowerCase() === 'modal');
}

/**
 * Whether a control may be clicked to reveal a popup form, and how early: 0 = form-intent label,
 * 1 = no intent label but its markup declares a dialog, null = never click it. PURE.
 */
export function ctaRank(f: CtaFacts): number | null {
  // A control a form owns, or one sitting next to a JS form's fields, is that form's submit.
  if (f.inForm || f.nearFields) return null;
  const type = f.type.trim().toLowerCase();
  if (type === 'submit' || type === 'reset' || type === 'image') return null;
  if (f.inNav || f.inCmp) return null;
  const label = f.label.replace(/\s+/g, ' ').trim();
  if (DENY.test(label)) return null;
  const toggle = (f.attrs['data-bs-toggle'] ?? f.attrs['data-toggle'] ?? '').trim().toLowerCase();
  if (toggle && toggle !== 'modal') return null; // collapse / dropdown / tab / tooltip toggle
  const modal = opensModal(f.attrs);
  if (f.tag === 'A') {
    const h = (f.href ?? '').trim();
    if (/^javascript:/i.test(h) && !NOOP_JS_HREF.test(h)) return null;
    // A real destination is a link: the crawler opens that page. Only a declared dialog makes it an opener.
    if (h && !h.startsWith('#') && !/^javascript:/i.test(h) && !modal) return null;
  } else if (f.tag !== 'BUTTON' && f.role !== 'button' && !modal) {
    return null;
  }
  if (INTENT.test(label)) return 0;
  return modal ? 1 : null;
}

/** One click per distinct control: by label, else by what it targets. */
function ctaKey(f: CtaFacts): string {
  const label = f.label.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  if (label) return 'label:' + label;
  return 'target:' + (f.attrs['data-bs-target'] ?? f.attrs['data-target'] ?? f.attrs['aria-controls'] ?? f.href ?? '').toLowerCase();
}

/**
 * Pick which reported controls to click, in click order (indices into `facts`). Form-intent labels come
 * before markup-only dialog openers, then document order, so a header full of menu toggles can never use
 * up the budget before the "Book a demo" button is reached. Capped at `max`. PURE.
 */
export function selectCtas(facts: CtaFacts[], max = MAX_INTERACTIVE_CLICKS): number[] {
  const ranked: Array<{ i: number; r: number }> = [];
  facts.forEach((f, i) => {
    const r = ctaRank(f);
    if (r !== null) ranked.push({ i, r });
  });
  ranked.sort((a, b) => a.r - b.r || a.i - b.i);
  const out: number[] = [];
  const seen = new Set<string>();
  for (const { i } of ranked) {
    if (out.length >= max) break;
    const key = ctaKey(facts[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

// ── in-browser routines (self-contained: stringified and run inside the page via evaluate) ────────────

/** Neutralise navigation before any click. Returns true once the guards are in place. */
function armInteractionGuards(): boolean {
  const w = window as unknown as { __sxArmed?: boolean };
  if (!w.__sxArmed) {
    w.__sxArmed = true;
    // A click may open an in-page modal but must never navigate, open a tab, or submit a form.
    window.open = () => null;
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        const a = t && t.closest ? t.closest('a[href]') : null;
        if (a) {
          const h = a.getAttribute('href') || '';
          if (h && !h.startsWith('#') && !h.startsWith('javascript:')) e.preventDefault();
        }
      },
      true,
    );
    document.addEventListener('submit', (e) => e.preventDefault(), true);
  }
  return true;
}

/** Report every visible control that could be a popup opener, tagging each with its index so clickCta
 *  can find it again. Judging happens in Node (selectCtas); this only measures. */
function gatherCtaFacts(): CtaFacts[] {
  const MODAL_ATTRS = ['aria-haspopup', 'aria-controls', 'data-modal', 'data-toggle', 'data-target', 'data-bs-toggle', 'data-bs-target', 'data-micromodal-trigger', 'data-fancybox'];
  const NAV_SEL = 'nav, [role="navigation"], [role="menubar"], [role="menu"], [role="tablist"], [role="tab"]';
  // Same CMP containers forms.ts skips.
  const CMP_SEL =
    '#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #usercentrics-root, #didomi-host, ' +
    '#qc-cmp2-container, #truste-consent-track, .cmplz-cookiebanner, .cky-consent-container, #iubenda-cs-banner, ' +
    '.osano-cm-window, #cmpbox, #BorlabsCookieBox, #fast-cmp-form, ' +
    '[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i]';
  // Same text-ish field set forms.ts uses to find a JS/div form.
  const TEXTISH_SEL =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="image"]):not([type="reset"]), textarea';
  const looseFields = Array.from(document.querySelectorAll(TEXTISH_SEL)).filter((f) => !f.closest('form'));
  const within = (el: Element, sel: string): boolean => {
    try {
      return !!el.closest(sel);
    } catch {
      return false;
    }
  };
  const nearFields = (el: Element): boolean => {
    if (looseFields.length === 0) return false;
    // The widest container it could share with a JS form's fields: up to 10 ancestors, as forms.ts climbs.
    let scope: Element | null = null;
    for (let node = el.parentElement, i = 0; node && i < 10; i++, node = node.parentElement) {
      if (node.tagName === 'FORM' || node === document.body) break;
      scope = node;
    }
    const s = scope;
    if (!s) return false;
    // ...AND laid out next to one of them. A wide enough container always holds some field (the footer
    // newsletter box sits in the same app root as the hero CTA), so the container alone would rule out
    // every CTA on such a page; a form's own submit control is placed beside its fields.
    const r = el.getBoundingClientRect();
    return looseFields.some((f) => {
      if (!s.contains(f)) return false;
      const b = f.getBoundingClientRect();
      if (b.width < 1 && b.height < 1) return false; // not rendered
      return Math.max(b.left - r.right, r.left - b.right, b.top - r.bottom, r.top - b.bottom, 0) <= 300;
    });
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const out: CtaFacts[] = [];
  const all = Array.from(
    document.querySelectorAll('button, [role="button"], a, [aria-haspopup], [data-modal], [data-toggle], [data-target], [data-bs-toggle], [data-micromodal-trigger], [data-fancybox]'),
  );
  for (const el of all) {
    if (out.length >= 800) break;
    const attrs: Record<string, string> = {};
    for (const name of MODAL_ATTRS) {
      const v = el.getAttribute(name);
      if (v !== null) attrs[name] = v;
    }
    // Cheap pre-skip of the bulk of a page: a plain link to another page (no dialog markup) is never
    // eligible (ctaRank rejects it too), so it is not worth measuring.
    const href = el.getAttribute('href');
    if (el.tagName === 'A' && href && !href.startsWith('#') && !href.startsWith('javascript:') && Object.keys(attrs).length === 0) continue;
    if (!visible(el)) continue;
    const owner = (el as HTMLButtonElement).form;
    el.setAttribute('data-sx-cand', String(out.length));
    out.push({
      tag: el.tagName,
      role: (el.getAttribute('role') || '').toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      href,
      label: ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 160),
      attrs,
      inForm: !!el.closest('form') || !!owner || el.hasAttribute('form') || el.hasAttribute('formaction'),
      nearFields: nearFields(el),
      inNav: within(el, NAV_SEL),
      inCmp: within(el, CMP_SEL),
    });
  }
  return out;
}

/** Click the control gatherCtaFacts reported at index i (the guards are already armed). */
function clickCta(i: number): boolean {
  const el = document.querySelector('[data-sx-cand="' + String(i) + '"]') as HTMLElement | null;
  if (!el) return false;
  el.click();
  return true;
}

/** Close an opened native <dialog>/modal so the next candidate starts from a clean state. */
function closeModals(): void {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    try {
      (d as HTMLDialogElement).close();
    } catch {
      /* not a real <dialog> */
    }
  });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export interface InteractiveFormsResult {
  /** Newly-revealed forms not already in the read-only baseline (flagged hidden → "opens in a modal"). */
  forms: FormAnalysis[];
  /** How many CTAs were actually clicked (for debug/telemetry). */
  clicked: number;
}

/**
 * Reveal and scan forms that only appear after clicking an "open-a-form" CTA. `baseline` is what the
 * read-only pass already found, so only NEW forms are returned. Bounded and best-effort: a click or
 * re-scan that fails just yields no extra form — it never throws out to the scan.
 */
export async function discoverInteractiveForms(page: PwPage, pageUrl: string, baseline: FormAnalysis[]): Promise<InteractiveFormsResult> {
  const seen = new Set(baseline.map(formSignature));
  const forms: FormAnalysis[] = [];
  let clicked = 0;
  let order: number[] = [];
  try {
    if ((await page.evaluate<boolean>(armInteractionGuards)) !== true) return { forms, clicked };
    const facts = await page.evaluate<CtaFacts[]>(gatherCtaFacts);
    order = selectCtas(Array.isArray(facts) ? facts : []);
  } catch {
    return { forms, clicked };
  }
  for (const i of order) {
    try {
      const ok = await page.evaluate<boolean>(clickCta, i);
      if (!ok) continue;
      clicked += 1;
      await page.waitForTimeout(600);
      for (const f of await scanForms(page, pageUrl)) {
        const sig = formSignature(f);
        if (seen.has(sig)) continue;
        seen.add(sig);
        forms.push({ ...f, hidden: true }); // only appears on click → hidden at load; feeds the modal/popup note
      }
      await page.evaluate(closeModals).catch(() => undefined);
    } catch {
      /* one CTA failing must never fail the scan */
    }
  }
  return { forms, clicked };
}
