/**
 * Journey runner — executes ordered interaction steps against a live page:
 * click a selector, submit a form, navigate, or perform the consent action.
 *
 * This is the one browser-facing layer that is spec-aware (the spec lists the
 * selectors/actions to drive). It returns plain facts; the capture orchestrator
 * stamps nav-relative timing. The pure assertion engine never touches it.
 *
 * NOTE: unlike the rest of web-audit-mcp (consent-click only), the verify tool
 * drives arbitrary operator-supplied selectors and performs REAL form submits.
 * That capability is intentional and gated at the tool boundary
 * (WEB_AUDIT_ENABLE_VERIFY); the CLI is an explicit local operator invocation.
 */

import type { PwPage } from '../../agent/browser.js';
import { detectCmp, interactWithCmp } from '../../agent/cmp.js';
import type { ConsentSpec } from '../types.js';

export interface StepOutcome {
  found: boolean;
  performed: boolean;
  note?: string;
}

/** Click an operator-supplied selector (any element — a CTA, button, link). */
export async function clickSelector(page: PwPage, selector: string): Promise<StepOutcome> {
  try {
    const el = await page.$(selector);
    if (!el) return { found: false, performed: false, note: `selector not found: ${selector}` };
    await el.click({ timeout: 5000 });
    return { found: true, performed: true };
  } catch (err) {
    return { found: true, performed: false, note: `click failed: ${errMsg(err)}` };
  }
}

/** Submit a form by selector — a REAL submission (native requestSubmit/submit). */
export async function submitForm(page: PwPage, selector: string): Promise<StepOutcome> {
  try {
    const el = await page.$(selector);
    if (!el) return { found: false, performed: false, note: `form not found: ${selector}` };
    await page.evaluate((sel: string) => {
      const node = document.querySelector(sel) as
        | (HTMLFormElement & { requestSubmit?: () => void })
        | null;
      if (!node) return;
      // Prefer requestSubmit() so 'submit' handlers (and GTM form-submit triggers) run.
      const form = node.tagName === 'FORM' ? node : (node.closest('form') as HTMLFormElement | null);
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    }, selector);
    return { found: true, performed: true };
  } catch (err) {
    return { found: true, performed: false, note: `submit failed: ${errMsg(err)}` };
  }
}

/** Navigate to a URL as an interaction step. */
export async function navigateTo(page: PwPage, url: string, navTimeoutMs: number): Promise<StepOutcome> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: navTimeoutMs });
    return { found: true, performed: true };
  } catch (err) {
    return { found: false, performed: false, note: `navigate failed: ${errMsg(err)}` };
  }
}

export interface ConsentClickOutcome extends StepOutcome {
  action: 'accept' | 'reject';
  selector?: string;
}

/**
 * Perform the two-phase consent action. Prefers the spec-supplied selector; if
 * absent, falls back to CMP auto-detection + the appropriate accept/reject
 * control. Returns whether a click actually landed.
 */
export async function clickConsent(page: PwPage, consent: ConsentSpec): Promise<ConsentClickOutcome> {
  const action: 'accept' | 'reject' = consent.mode ?? 'accept';
  const explicit = action === 'accept' ? consent.acceptSelector : consent.rejectSelector;

  if (explicit) {
    const outcome = await clickSelector(page, explicit);
    return { ...outcome, action, selector: explicit };
  }

  // No explicit selector — detect the banner and click its control.
  try {
    const detection = await detectCmp(page);
    if (!detection.detected) {
      return { action, found: false, performed: false, note: 'no consent selector supplied and no CMP detected' };
    }
    const interaction = await interactWithCmp(page, detection, action);
    return {
      action,
      found: Boolean(action === 'accept' ? detection.accept : detection.reject),
      performed: interaction.clicked,
      selector: interaction.selector,
      note: interaction.note,
    };
  } catch (err) {
    return { action, found: false, performed: false, note: `consent click failed: ${errMsg(err)}` };
  }
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
