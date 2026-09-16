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

import type { PwPage } from '../browser.js';
import { scanForms, type FormAnalysis } from '../forms.js';

/** A stable-ish identity for a detected form, to tell a newly-revealed form from the baseline ones. PURE. */
export function formSignature(f: FormAnalysis): string {
  const fields = f.fields.map((x) => `${x.type}:${x.name || ''}`).sort().join(',');
  return [f.purpose, f.method, f.fieldCount, f.formId, f.providerFormId ?? '', f.title, fields].join('|');
}

/** How many distinct CTAs we will click per page. Bounds the cost + side-effect surface. */
export const MAX_INTERACTIVE_CLICKS = 6;

// ── in-browser routines (self-contained: stringified and run inside the page via evaluate) ────────────

/** Neutralise navigation, then find + tag the "open-a-form" CTAs. Returns how many were tagged. */
function armAndMarkCtas(): number {
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
  const INTENT =
    /\b(book|schedule|request|start|get\s?started|sign\s?up|register|free\s?trial|try\s+(it\s+)?free|demo|quote|contact|apply|join|subscribe|enrol|enroll|get\s+in\s+touch|talk\s+to|get\s+a\s+quote|reach\s+out)\b/i;
  const MODAL_ATTRS = ['aria-haspopup', 'aria-controls', 'data-modal', 'data-toggle', 'data-target', 'data-bs-toggle', 'data-micromodal-trigger', 'data-fancybox'];
  const declaresModal = (el: Element): boolean => MODAL_ATTRS.some((a) => el.hasAttribute(a));
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const isCandidate = (el: Element): boolean => {
    if (el.closest('form')) return false; // a control inside a real form is a submit, not a modal-opener
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'submit' || type === 'reset') return false;
    const tag = el.tagName;
    const isBtn = tag === 'BUTTON' || el.getAttribute('role') === 'button';
    const isJsAnchor =
      tag === 'A' &&
      (() => {
        const h = el.getAttribute('href') || '';
        return !h || h === '#' || h.startsWith('#') || h.startsWith('javascript:');
      })();
    if (!isBtn && !isJsAnchor && !declaresModal(el)) return false;
    if (!visible(el)) return false;
    const label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim();
    return INTENT.test(label) || declaresModal(el);
  };
  const all = Array.from(
    document.querySelectorAll('button, [role="button"], a, [aria-haspopup], [data-modal], [data-toggle], [data-target], [data-bs-toggle], [data-micromodal-trigger], [data-fancybox]'),
  );
  const seenLabels = new Set<string>();
  let n = 0;
  for (const el of all) {
    if (n >= 6) break;
    if (!isCandidate(el)) continue;
    const key = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
    if (key && seenLabels.has(key)) continue; // one click per distinct label
    seenLabels.add(key);
    el.setAttribute('data-sx-fdisc', String(n));
    n += 1;
  }
  return n;
}

/** Click the i-th tagged CTA (the guards armed by armAndMarkCtas are already in place). */
function clickCta(i: number): boolean {
  const el = document.querySelector('[data-sx-fdisc="' + String(i) + '"]') as HTMLElement | null;
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
  let count = 0;
  try {
    count = await page.evaluate<number>(armAndMarkCtas);
  } catch {
    return { forms, clicked };
  }
  for (let i = 0; i < Math.min(count, MAX_INTERACTIVE_CLICKS); i++) {
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
