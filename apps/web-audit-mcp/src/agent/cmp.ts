/**
 * Consent banner (CMP) detection and interaction.
 *
 * A vendor registry covers the major CMPs with stable selectors; a generic
 * DOM heuristic (multi-language accept/reject text inside a cookie-ish
 * container) catches custom banners. Interaction is limited strictly to
 * consent UI: the only elements this module ever clicks are the detected
 * banner's accept/reject buttons — never forms, links, or anything else.
 *
 * The generic heuristic only guesses, so it is held to more than the vendor
 * registry is:
 *  - WHAT counts: the page only reports facts (gatherCmpFactsInPage); Node
 *    judges them (cmpControlEligible / cmpContainerEligible / pickGenericCmp).
 *    A control that can submit a form or follow a link is never a candidate,
 *    nor is any control in a container holding a text-entry field (a
 *    newsletter or lead form). "privacy" wording alone does not make a
 *    generically named notice/banner a consent banner. The first, most
 *    consent-like container wins, never simply the last match.
 *  - WHERE it clicks: selectors are anchored (a unique id or <html>) and
 *    checked to match exactly that one element. Right before the click the
 *    page is re-scanned and must still pick the same container and control;
 *    the click goes to that element in the main frame only (never the iframe
 *    fallback the vendor path uses).
 *  - DURING the click (heuristic only; vendor CMPs legitimately POST consent
 *    receipts): form.submit()/requestSubmit() are no-ops and submit events are
 *    cancelled in the page, link activation other than #hash / javascript: is
 *    cancelled, and at the network every non-GET/HEAD request and every
 *    main-frame navigation except a plain reload is aborted. If a guard cannot
 *    be installed, nothing is clicked.
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

/** Container names that say "consent banner" outright. The generic notice|banner|privacy names rank below. */
const STRONG_CONTAINER_RE = /cookie|consent|gdpr|cmp/i;

/** Banner wording that makes a cookie-ish container a consent banner. "privacy" alone does not
 *  ("We respect your privacy" sits on every newsletter box), except in a container named for consent. */
export const CONSENT_TEXT_RE = /cookie|consent|gdpr|tracking/i;

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

export interface GenericDetectResult {
  detected: boolean;
  presenceSelector?: string;
  accept?: CmpButton;
  reject?: CmpButton;
}

/** What the page reports about one visible accept/reject-looking control in a candidate banner. */
export interface CmpControlFacts {
  /** Upper-case tag name. */
  tag: string;
  /** Lower-cased type: the normalised `.type` of a BUTTON/INPUT (a bare <button> is "submit"), else the attribute. */
  type: string;
  /** The `href` of the control or of the link it sits in, or null when it is in no link. */
  href: string | null;
  /** Owned by a <form>: inside one, a `.form` owner, or a `form` / `formaction` attribute. */
  inForm: boolean;
  /** Text content, else the input's value. */
  label: string;
  /** An anchored selector that matched exactly this control at scan time; null when none could be built. */
  selector: string | null;
}

/** What the page reports about one visible, cookie-ish-named container (see gatherCmpFactsInPage). */
export interface CmpContainerFacts {
  /** An anchored selector that matched exactly this container at scan time; null when none could be built. */
  selector: string | null;
  /** id + class, lower-cased. */
  idClass: string;
  /** aria-label, lower-cased. */
  aria: string;
  /** Text matches CONSENT_TEXT_RE (cookie / consent / gdpr / tracking). */
  consentText: boolean;
  /** Text mentions "privacy". */
  privacyText: boolean;
  /** Holds a text-entry field (text / email / tel / ... input, or a textarea): a lead or newsletter form. */
  hasTextEntry: boolean;
  /** Visible controls whose label looked like accept or reject, in document order. */
  controls: CmpControlFacts[];
}

/**
 * Whether the heuristic may click this control as a consent button. A control that can submit a form
 * (a submit / image / reset input, a form-owned <button> that is not type=button) or follow a link (any
 * href but '', '#…' or 'javascript:') belongs to a form or a link, never to a consent banner. PURE.
 */
export function cmpControlEligible(c: CmpControlFacts): boolean {
  if (!c || typeof c.selector !== 'string' || !c.selector) return false;
  const tag = String(c.tag || '').toUpperCase();
  const type = String(c.type || '').trim().toLowerCase();
  if (tag === 'INPUT' && type !== 'button') return false;
  if (tag === 'BUTTON' && c.inForm && type !== 'button') return false;
  if (c.href !== null && c.href !== undefined) {
    const h = String(c.href).trim();
    if (h && !h.startsWith('#') && !/^javascript:/i.test(h)) return false;
  }
  return true;
}

function strongContainer(c: CmpContainerFacts): boolean {
  return STRONG_CONTAINER_RE.test(String(c.idClass || '')) || STRONG_CONTAINER_RE.test(String(c.aria || ''));
}

/**
 * Whether a reported container can be a consent banner: named cookie-ish, with cookie / consent / gdpr /
 * tracking wording ("privacy" only counts when the name itself says cookie / consent / gdpr / cmp), and
 * holding no text-entry field. PURE.
 */
export function cmpContainerEligible(c: CmpContainerFacts): boolean {
  if (!c || typeof c.selector !== 'string' || !c.selector) return false;
  if (!COOKIE_CONTAINER_RE.test(String(c.idClass || '')) && !COOKIE_CONTAINER_RE.test(String(c.aria || ''))) return false;
  if (c.hasTextEntry) return false;
  return Boolean(c.consentText) || (Boolean(c.privacyText) && strongContainer(c));
}

/**
 * Pick the consent banner and its accept / reject controls from the reported containers. Ranked: a
 * container with both accept and reject first, then one named cookie / consent / gdpr / cmp ahead of a
 * generic notice / banner / privacy one, then document order (the first wins). PURE.
 */
export function pickGenericCmp(
  containers: CmpContainerFacts[],
  acceptRe: RegExp = ACCEPT_TEXT_RE,
  rejectRe: RegExp = REJECT_TEXT_RE,
): GenericDetectResult {
  let best: { rank: [number, number]; container: string; accept?: CmpButton; reject?: CmpButton } | null = null;
  const list = Array.isArray(containers) ? containers : [];
  for (const c of list) {
    if (!cmpContainerEligible(c)) continue;
    let accept: CmpButton | undefined;
    let reject: CmpButton | undefined;
    for (const b of Array.isArray(c.controls) ? c.controls : []) {
      if (!cmpControlEligible(b)) continue;
      const t = String(b.label || '').trim().slice(0, 80);
      if (!accept && acceptRe.test(t)) accept = { selector: b.selector as string, text: t };
      if (!reject && rejectRe.test(t)) reject = { selector: b.selector as string, text: t };
    }
    if (!accept && !reject) continue;
    const rank: [number, number] = [accept && reject ? 0 : 1, strongContainer(c) ? 0 : 1];
    // Strictly better only: on a tie the earlier container (document order) keeps its place.
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) {
      best = { rank, container: c.selector as string, accept, reject };
    }
  }
  if (!best) return { detected: false };
  return { detected: true, presenceSelector: best.container, accept: best.accept, reject: best.reject };
}

/** Arguments for gatherCmpFactsInPage (regex sources: the function runs in the page). */
const GATHER_ARGS = {
  container: COOKIE_CONTAINER_RE.source,
  consent: CONSENT_TEXT_RE.source,
  accept: ACCEPT_TEXT_RE.source,
  reject: REJECT_TEXT_RE.source,
};

/**
 * Report every visible cookie-ish-named container and its accept/reject-looking controls. Runs IN the
 * page (serialized by Playwright, so it is self-contained); it only measures, the pure functions above
 * judge. Selectors are anchored at a unique id or <html> and kept only when they match exactly that one
 * element, so a selector can never land on some other control elsewhere in the document.
 */
export function gatherCmpFactsInPage(arg: { container: string; consent: string; accept: string; reject: string }): CmpContainerFacts[] {
  const CONTAINER = new RegExp(arg.container, 'i');
  const CONSENT = new RegExp(arg.consent, 'i');
  const ACCEPT = new RegExp(arg.accept, 'i');
  const REJECT = new RegExp(arg.reject, 'i');
  const TEXT_ENTRY =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="image"]):not([type="reset"]), textarea';
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0.05;
  };
  const memo = new Map<Element, string | null>();
  const uniqueSelector = (el: Element): string | null => {
    if (memo.has(el)) return memo.get(el) as string | null;
    const parts: string[] = [];
    let anchored = false;
    let cur: Element | null = el;
    while (cur) {
      if (cur.id) {
        const idSel = '#' + CSS.escape(cur.id);
        if (document.querySelectorAll(idSel).length === 1) {
          parts.unshift(idSel);
          anchored = true;
          break;
        }
      }
      let part = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const tagName = cur.tagName;
        const same = Array.from(parent.children).filter((c) => c.tagName === tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      // The element's own classes keep the selector readable; ancestors stay structural (stable).
      if (cur === el && typeof cur.className === 'string' && cur.className.trim()) {
        part += cur.className.trim().split(/\s+/).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(part);
      if (!parent) {
        anchored = cur === document.documentElement;
        break;
      }
      cur = parent;
    }
    let sel: string | null = null;
    if (anchored) {
      try {
        const all = document.querySelectorAll(parts.join(' > '));
        if (all.length === 1 && all[0] === el) sel = parts.join(' > ');
      } catch {
        sel = null;
      }
    }
    memo.set(el, sel);
    return sel;
  };
  const out: CmpContainerFacts[] = [];
  const nodes = document.querySelectorAll('div,section,aside,dialog,[role="dialog"],[role="alertdialog"]');
  for (const el of Array.from(nodes)) {
    if (out.length >= 200) break;
    const idClass = (el.id + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if (!CONTAINER.test(idClass) && !CONTAINER.test(aria)) continue;
    if (!visible(el)) continue;
    const text = el.textContent || '';
    const consentText = CONSENT.test(text);
    const privacyText = /privacy/i.test(text);
    if (!consentText && !privacyText) continue;
    const controls: CmpControlFacts[] = [];
    for (const b of Array.from(el.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"]'))) {
      if (controls.length >= 40) break;
      if (!visible(b)) continue;
      const label = ((b.textContent || (b as HTMLInputElement).value || '') as string).trim().slice(0, 80);
      if (!ACCEPT.test(label) && !REJECT.test(label)) continue;
      const tag = b.tagName.toUpperCase();
      const type =
        tag === 'BUTTON' || tag === 'INPUT'
          ? String((b as HTMLButtonElement).type || '').toLowerCase()
          : (b.getAttribute('type') || '').toLowerCase();
      const link = b.closest('a[href]');
      controls.push({
        tag,
        type,
        href: link ? link.getAttribute('href') : null,
        inForm: !!b.closest('form') || !!(b as HTMLButtonElement).form || b.hasAttribute('form') || b.hasAttribute('formaction'),
        label,
        selector: uniqueSelector(b),
      });
    }
    if (controls.length === 0) continue;
    out.push({
      selector: uniqueSelector(el),
      idClass: idClass.slice(0, 200),
      aria: aria.slice(0, 200),
      consentText,
      privacyText,
      hasTextEntry: !!el.querySelector(TEXT_ENTRY),
      controls,
    });
  }
  return out;
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

  // Generic heuristic for custom banners: the page reports, pickGenericCmp judges.
  try {
    const res = pickGenericCmp(await page.evaluate<CmpContainerFacts[]>(gatherCmpFactsInPage, GATHER_ARGS));
    if (res.detected) {
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

// ── guards for a heuristic click ────────────────────────────────────────────────

/**
 * Whether a request made during a heuristic banner click must be refused at the network. PURE.
 * Anything but GET/HEAD is a write (a form POST, a newsletter or lead API call). A main-frame navigation
 * would leave the page (a form GET, a link); a plain reload of this same page is let through, because
 * some custom banners reload to apply the choice and a reload carries nothing out.
 */
export function blockDuringCmpClick(req: { method: string; url: string; mainFrameNavigation: boolean; pageUrl: string }): boolean {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return true;
  if (!req.mainFrameNavigation) return false;
  const doc = (u: string): string => String(u || '').split('#')[0];
  return doc(req.url) !== doc(req.pageUrl);
}

/**
 * In the page, for the click window only: form.submit()/requestSubmit() become no-ops (submit() fires no
 * event a listener could cancel), submit events are cancelled and stopped at window capture (so the
 * site's own AJAX submit handlers never run either), and link activation other than an in-page #hash or
 * a javascript: URL is cancelled. Undone by disarmCmpClickGuards. Returns true once armed.
 */
export function armCmpClickGuards(): boolean {
  const w = window as unknown as { __waCmpGuardRestore?: () => void };
  if (w.__waCmpGuardRestore) return true;
  const proto = HTMLFormElement.prototype;
  const realSubmit = proto.submit;
  const realRequestSubmit = proto.requestSubmit;
  proto.submit = function () {};
  proto.requestSubmit = function () {};
  const onSubmit = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e: Event): void => {
    const t = e.target as Element | null;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    const h = (a.getAttribute('href') || '').trim();
    if (h.startsWith('#') || /^javascript:/i.test(h)) return;
    e.preventDefault();
  };
  window.addEventListener('submit', onSubmit, true);
  window.addEventListener('click', onClick, true);
  w.__waCmpGuardRestore = () => {
    proto.submit = realSubmit;
    proto.requestSubmit = realRequestSubmit;
    window.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('click', onClick, true);
  };
  return true;
}

/** Undo armCmpClickGuards and drop the click mark. Runs in the page. */
export function disarmCmpClickGuards(): boolean {
  const w = window as unknown as { __waCmpGuardRestore?: () => void };
  const restore = w.__waCmpGuardRestore;
  w.__waCmpGuardRestore = undefined;
  if (restore) restore();
  document.querySelectorAll('[data-wa-cmp-target]').forEach((el) => el.removeAttribute('data-wa-cmp-target'));
  return true;
}

/** Mark the one element `selector` matches, so the click lands on exactly it. Runs in the page. */
export function markCmpTarget(arg: { selector: string; mark: string }): boolean {
  let all: NodeListOf<Element>;
  try {
    all = document.querySelectorAll(arg.selector);
  } catch {
    return false;
  }
  if (all.length !== 1) return false;
  all[0].setAttribute('data-wa-cmp-target', arg.mark);
  return true;
}

// The Playwright surface the network guard needs (real pages carry these at runtime).
interface PwRequestEx {
  url(): string;
  method(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
}
interface PwRouteEx {
  request(): PwRequestEx;
  abort(errorCode?: string): Promise<void>;
  fallback(): Promise<void>;
}
interface PwPageRouteEx {
  mainFrame(): unknown;
  route(url: string, handler: (route: PwRouteEx) => unknown): Promise<void>;
  unroute(url: string, handler?: (route: PwRouteEx) => unknown): Promise<void>;
}

/**
 * Click a heuristic detection's control. The heuristic only guesses, so: the page is re-scanned and must
 * still pick the same banner and control; the click goes to exactly that element in the main frame (no
 * iframe fallback: the scan never ran in iframes); and for the click window submits and navigation are
 * disarmed in the page and refused at the network. Fails closed: no guard, no click.
 */
async function clickHeuristicControl(
  page: PwPage,
  detection: CmpDetection,
  action: 'accept' | 'reject',
  button: CmpButton,
): Promise<CmpInteraction> {
  const base = { action, selector: button.selector, vendor: detection.vendorName };
  const notClicked = (note: string): CmpInteraction => ({ ...base, clicked: false, note });
  const routed = page as unknown as PwPageRouteEx;
  const pageUrl = page.url();
  let mainFrame: unknown;
  const isMainNav = (req: PwRequestEx): boolean => {
    try {
      if (!req.isNavigationRequest()) return false;
    } catch {
      return false;
    }
    try {
      return req.frame() === mainFrame;
    } catch {
      return true; // a navigation whose frame cannot be told apart is refused
    }
  };
  const guard = (route: PwRouteEx): Promise<void> => {
    const req = route.request();
    const block = blockDuringCmpClick({ method: req.method(), url: req.url(), mainFrameNavigation: isMainNav(req), pageUrl });
    return (block ? route.abort('aborted') : route.fallback()).catch(() => undefined);
  };
  try {
    mainFrame = routed.mainFrame();
    await routed.route('**/*', guard);
  } catch {
    return notClicked('click guard could not be installed; nothing was clicked');
  }
  try {
    if ((await page.evaluate<boolean>(armCmpClickGuards)) !== true) {
      return notClicked('click guard could not be installed; nothing was clicked');
    }
    const now = pickGenericCmp(await page.evaluate<CmpContainerFacts[]>(gatherCmpFactsInPage, GATHER_ARGS));
    const control = action === 'accept' ? now.accept : now.reject;
    if (!now.detected || now.presenceSelector !== detection.presenceSelector || !control || control.selector !== button.selector) {
      return notClicked('the consent banner changed before the click; nothing was clicked');
    }
    const mark = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    if ((await page.evaluate<boolean>(markCmpTarget, { selector: button.selector, mark })) !== true) {
      return notClicked('control found earlier but could not be clicked');
    }
    const el = await page.$('[data-wa-cmp-target="' + mark + '"]');
    if (!el || !(await el.isVisible())) return notClicked('control found earlier but could not be clicked');
    await el.click({ timeout: 5000 });
    return { ...base, clicked: true };
  } catch (err) {
    return notClicked(`click failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  } finally {
    await page.evaluate(disarmCmpClickGuards).catch(() => undefined);
    await routed.unroute('**/*', guard).catch(() => undefined);
  }
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
  if (detection.method === 'heuristic') return clickHeuristicControl(page, detection, action, button);
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
