/**
 * Consent banner (CMP) detection and interaction.
 *
 * A vendor registry covers the major CMPs with stable selectors; a generic
 * DOM heuristic (multi-language accept/reject text inside a cookie-ish
 * container) catches custom banners. Interaction is limited strictly to
 * consent UI: the only elements this module ever clicks are the detected
 * banner's accept/reject buttons — never forms, links, or anything else.
 */

import type { PwPage, PwElement } from './browser.js';

export interface CmpVendor {
  id: string;
  name: string;
  /** Any selector matching means the CMP is present on the page. */
  presence: string[];
  accept: string[];
  reject: string[];
  settings?: string[];
}

// Selectors are checked in order; Playwright CSS pierces open shadow DOM,
// which several CMPs (Usercentrics, CookieYes) rely on.
export const CMP_VENDORS: CmpVendor[] = [
  {
    id: 'onetrust',
    name: 'OneTrust',
    presence: ['#onetrust-banner-sdk', '#onetrust-consent-sdk'],
    accept: ['#onetrust-accept-btn-handler'],
    reject: ['#onetrust-reject-all-handler'],
    settings: ['#onetrust-pc-btn-handler'],
  },
  {
    id: 'cookiebot',
    name: 'Cookiebot (Usercentrics)',
    presence: ['#CybotCookiebotDialog'],
    accept: [
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
    ],
    reject: ['#CybotCookiebotDialogBodyButtonDecline'],
    settings: ['#CybotCookiebotDialogBodyLevelButtonCustomize'],
  },
  {
    id: 'usercentrics',
    name: 'Usercentrics',
    presence: ['#usercentrics-root', '#usercentrics-cmp-ui'],
    accept: ['[data-testid="uc-accept-all-button"]', '#uc-btn-accept-banner'],
    reject: ['[data-testid="uc-deny-all-button"]', '#uc-btn-deny-banner'],
    settings: ['[data-testid="uc-more-button"]'],
  },
  {
    id: 'didomi',
    name: 'Didomi',
    presence: ['#didomi-host', '#didomi-notice'],
    accept: ['#didomi-notice-agree-button'],
    reject: ['#didomi-notice-disagree-button', '.didomi-continue-without-agreeing'],
    settings: ['#didomi-notice-learn-more-button'],
  },
  {
    id: 'quantcast',
    name: 'Quantcast Choice (TCF)',
    presence: ['#qc-cmp2-container', '#qc-cmp2-ui'],
    accept: ['#qc-cmp2-ui button[mode="primary"]'],
    reject: ['#qc-cmp2-ui button[mode="secondary"]'],
  },
  {
    id: 'trustarc',
    name: 'TrustArc',
    presence: ['#truste-consent-track', '#consent_blackbar'],
    accept: ['#truste-consent-button'],
    reject: ['#truste-consent-required'],
    settings: ['#truste-show-consent'],
  },
  {
    id: 'complianz',
    name: 'Complianz',
    presence: ['#cmplz-cookiebanner-container', '.cmplz-cookiebanner'],
    accept: ['.cmplz-accept'],
    reject: ['.cmplz-deny'],
    settings: ['.cmplz-view-preferences'],
  },
  {
    id: 'cookieyes',
    name: 'CookieYes',
    presence: ['.cky-consent-container'],
    accept: ['[data-cky-tag="accept-button"]', '.cky-btn-accept'],
    reject: ['[data-cky-tag="reject-button"]', '.cky-btn-reject'],
    settings: ['[data-cky-tag="settings-button"]'],
  },
  {
    id: 'iubenda',
    name: 'Iubenda',
    presence: ['#iubenda-cs-banner'],
    accept: ['.iubenda-cs-accept-btn'],
    reject: ['.iubenda-cs-reject-btn'],
    settings: ['.iubenda-cs-customize-btn'],
  },
  {
    id: 'osano',
    name: 'Osano',
    presence: ['.osano-cm-window', '.osano-cm-dialog'],
    accept: ['.osano-cm-accept-all', '.osano-cm-accept'],
    reject: ['.osano-cm-denyAll', '.osano-cm-deny'],
    settings: ['.osano-cm-manage'],
  },
  {
    id: 'termly',
    name: 'Termly',
    presence: ['#termly-code-snippet-support', '.t-consentPrompt'],
    accept: ['[data-tid="banner-accept"]'],
    reject: ['[data-tid="banner-decline"]'],
  },
  {
    id: 'consentmanager',
    name: 'consentmanager.net',
    presence: ['#cmpbox', '#cmpwrapper'],
    accept: ['.cmpboxbtnyes'],
    reject: ['.cmpboxbtnno'],
    settings: ['.cmpboxbtncustom'],
  },
  {
    id: 'borlabs',
    name: 'Borlabs Cookie',
    presence: ['#BorlabsCookieBox', '#BorlabsCookieBoxWidget'],
    accept: ['a[data-cookie-accept-all]', '#CookieBoxSaveButton'],
    reject: ['a[data-cookie-refuse]'],
    settings: ['a[data-cookie-individual]'],
  },
  {
    id: 'klaro',
    name: 'Klaro',
    presence: ['.klaro .cookie-notice', '.klaro .cookie-modal'],
    accept: ['.klaro .cm-btn-success', '.klaro .cm-btn-accept-all'],
    reject: ['.klaro .cn-decline', '.klaro .cm-btn-danger'],
    settings: ['.klaro .cm-btn-lern-more', '.klaro .cn-learn-more'],
  },
  {
    id: 'tarteaucitron',
    name: 'tarteaucitron.js',
    presence: ['#tarteaucitronRoot #tarteaucitronAlertBig'],
    accept: ['#tarteaucitronAllAllowed', '#tarteaucitronPersonalize2'],
    reject: ['#tarteaucitronAllDenied2', '#tarteaucitronAllDenied'],
    settings: ['#tarteaucitronCloseAlert'],
  },
];

// Multi-language button-text heuristics for custom banners.
export const ACCEPT_TEXT_RE =
  /\b(accept( all)?|agree|allow( all)?|got it|i understand|ok(ay)?|akzeptieren|alle akzeptieren|zustimmen|einverstanden|accepter|tout accepter|j'accepte|aceptar( todo)?|aceitar|accetta( tutto)?|accetto|akkoord|alles accepteren|godkend|acceptera|hyväksy|zaakceptuj|zgadzam się|souhlasím|prijať|elfogad|приемам|принять|同意|すべて同意|모두 동의|स्वीकार)\b/i;

export const REJECT_TEXT_RE =
  /\b(reject( all)?|decline|deny|refuse|disagree|no,? thanks|only (necessary|essential|required)|necessary only|essential only|continue without|ablehnen|alle ablehnen|nur (notwendige|erforderliche)|refuser|tout refuser|continuer sans accepter|rechazar|solo (necesarias|esenciales)|rifiuta|recusar|weigeren|alleen noodzakelijk|afvis|avvisa|neka|hylkää|odrzuć|odmítnout|elutasít|отказ|отклонить|拒否|거부|拒绝|अस्वीकार)\b/i;

const COOKIE_CONTAINER_RE = /cookie|consent|gdpr|privacy|cmp|notice|banner/i;

export interface CmpButton {
  selector: string;
  text?: string;
}

export interface CmpDetection {
  detected: boolean;
  vendorId?: string;
  vendorName?: string;
  presenceSelector?: string;
  accept?: CmpButton;
  reject?: CmpButton;
  settings?: CmpButton;
  /** True when a reject control exists on the first banner layer. */
  rejectOnFirstLayer: boolean;
  /** "vendor" (registry match) or "heuristic" (generic DOM scan). */
  method?: 'vendor' | 'heuristic';
}

async function firstVisible(page: PwPage, selectors: string[]): Promise<CmpButton | null> {
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el && (await el.isVisible())) return { selector };
    } catch {
      // invalid selector on this page / detached node — try the next one
    }
  }
  return null;
}

interface GenericDetectResult {
  detected: boolean;
  presenceSelector?: string;
  accept?: CmpButton;
  reject?: CmpButton;
}

/** Generic banner heuristic — serialized by Playwright and run in the page. */
function genericDetectInPage(res: { accept: string; reject: string; container: string }): GenericDetectResult {
  const ACCEPT = new RegExp(res.accept, 'i');
  const REJECT = new RegExp(res.reject, 'i');
  const CONTAINER = new RegExp(res.container, 'i');
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0.05;
  };
  const cssPath = (el: Element): string => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls =
        cur.className && typeof cur.className === 'string'
          ? cur.className.trim().split(/\s+/).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('')
          : '';
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part + cls);
      cur = parent;
    }
    return parts.join(' > ');
  };
  interface Candidate { el: Element; buttons: Element[] }
  const candidates: Candidate[] = [];
  const nodes = document.querySelectorAll('div,section,aside,dialog,[role="dialog"],[role="alertdialog"]');
  for (const el of Array.from(nodes)) {
    const idClass = (el.id + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (!CONTAINER.test(idClass) && !CONTAINER.test(aria)) continue;
    if (!visible(el)) continue;
    const text = (el.textContent || '').toLowerCase();
    if (!/cookie|consent|privacy|gdpr|tracking/.test(text)) continue;
    const buttons = el.querySelectorAll(
      'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]',
    );
    if (buttons.length === 0) continue;
    candidates.push({ el, buttons: Array.from(buttons) });
  }
  if (candidates.length === 0) return { detected: false };
  let best: { container: string; accept?: CmpButton; reject?: CmpButton } | null = null;
  for (const c of candidates) {
    let accept: CmpButton | undefined;
    let reject: CmpButton | undefined;
    for (const b of c.buttons) {
      if (!visible(b)) continue;
      const t = ((b.textContent || (b as HTMLInputElement).value || '') as string).trim().slice(0, 80);
      if (!accept && ACCEPT.test(t)) accept = { selector: cssPath(b), text: t };
      if (!reject && REJECT.test(t)) reject = { selector: cssPath(b), text: t };
    }
    if (accept || reject) {
      best = { container: cssPath(c.el), accept, reject };
      if (accept && reject) break;
    }
  }
  if (!best) return { detected: false };
  return {
    detected: true,
    presenceSelector: best.container,
    accept: best.accept,
    reject: best.reject,
  };
}

/**
 * Detect the consent banner on a settled page. Vendor registry first (exact
 * selectors, reliable interaction), generic heuristic as fallback.
 */
export async function detectCmp(page: PwPage): Promise<CmpDetection> {
  for (const vendor of CMP_VENDORS) {
    const presence = await firstVisible(page, vendor.presence);
    if (!presence) continue;
    const accept = await firstVisible(page, vendor.accept);
    const reject = await firstVisible(page, vendor.reject);
    const settings = vendor.settings ? await firstVisible(page, vendor.settings) : null;
    return {
      detected: true,
      vendorId: vendor.id,
      vendorName: vendor.name,
      presenceSelector: presence.selector,
      accept: accept ?? undefined,
      reject: reject ?? undefined,
      settings: settings ?? undefined,
      rejectOnFirstLayer: Boolean(reject),
      method: 'vendor',
    };
  }

  // Generic heuristic for custom banners.
  try {
    const res = await page.evaluate<GenericDetectResult>(genericDetectInPage, {
      accept: ACCEPT_TEXT_RE.source,
      reject: REJECT_TEXT_RE.source,
      container: COOKIE_CONTAINER_RE.source,
    });
    if (res && res.detected) {
      return {
        detected: true,
        vendorName: 'Custom / unknown CMP',
        presenceSelector: res.presenceSelector,
        accept: res.accept,
        reject: res.reject,
        rejectOnFirstLayer: Boolean(res.reject),
        method: 'heuristic',
      };
    }
  } catch {
    // evaluation can fail on hostile pages; treat as not detected
  }
  return { detected: false, rejectOnFirstLayer: false };
}

export interface CmpInteraction {
  action: 'accept' | 'reject';
  clicked: boolean;
  selector?: string;
  vendor?: string;
  /** ms since navigation start at click time (caller supplies the clock). */
  tMs?: number;
  note?: string;
}

async function clickInAnyFrame(page: PwPage, selector: string): Promise<boolean> {
  const el = await page.$(selector);
  if (el && (await el.isVisible())) {
    await el.click({ timeout: 5000 });
    return true;
  }
  // Some CMPs (TrustArc, TCF vendors) render inside an iframe.
  for (const frame of page.frames()) {
    try {
      const fel = await frame.$(selector);
      if (fel && (await fel.isVisible())) {
        await fel.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // cross-origin or detached frame — keep looking
    }
  }
  return false;
}

/**
 * Click the detected banner's accept or reject control. Only consent-banner
 * buttons are ever clicked; if the requested control was not found the
 * interaction reports clicked:false instead of guessing at other elements.
 */
export async function interactWithCmp(
  page: PwPage,
  detection: CmpDetection,
  action: 'accept' | 'reject',
): Promise<CmpInteraction> {
  const button = action === 'accept' ? detection.accept : detection.reject;
  if (!detection.detected || !button) {
    return {
      action,
      clicked: false,
      vendor: detection.vendorName,
      note: detection.detected
        ? `no ${action} control found on the first banner layer`
        : 'no consent banner detected',
    };
  }
  try {
    const clicked = await clickInAnyFrame(page, button.selector);
    return {
      action,
      clicked,
      selector: button.selector,
      vendor: detection.vendorName,
      note: clicked ? undefined : 'control found earlier but could not be clicked',
    };
  } catch (err) {
    return {
      action,
      clicked: false,
      selector: button.selector,
      vendor: detection.vendorName,
      note: `click failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
}
