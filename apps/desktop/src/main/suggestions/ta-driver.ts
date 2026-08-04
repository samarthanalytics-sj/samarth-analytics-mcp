// TAG ASSISTANT SESSION DRIVER — automates the user's manual flow, with ZERO GTM writes:
// open tagassistant.google.com → "Add domain" → Connect → the debugged popup opens with the REAL debug
// connection → drive each tag's trigger in that popup (clicks, dataLayer pushes, guarded submits) →
// capture the authoritative debug stream (plain postMessage frames in the TA page; see ta-stream.ts) →
// per-event Tags Fired / API-Call data.
//
// No container version, no workspace, no extra container — nothing is created anywhere. The one
// requirement (probe-proven): debugging a GTM WEB container needs a signed-in Google session with access
// to it (signed out, TA debugs Google tags only and reports DETAILS_NOT_FOUND). The session lives in a
// PERSISTENT browser profile under the app's data dir: sign in once (headed window), reuse forever.
//
// SAFETY: same in-page guards as the verify driver (navigation + real submits blocked); analytics
// collector requests are captured+aborted so driving tags never sends real hits. The popup keeps its
// window.opener link to the TA page (the debug channel), so all driving happens by NAVIGATING THE SAME
// POPUP sequentially — never a fresh context.

import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { requestAllowed } from './ssrf';
import { classifyCollector } from '../../shared/runtime-capture';
import { PlaywrightUnavailableError } from './playwright-driver';
import {
  installGuardsInPage, allowFormSubmitInPage, grantConsentInPage, hideCookieOverlaysInPage, pushDataLayerInPage,
  driveInPage, specFor, buildCustomEventPayload, withPreviewParams,
  type VerifyDriverTag, type DriveOutcome,
} from './verify-driver';
import { fillAndSubmitInPage, type FormSubmitFieldInput } from './form-submit-driver';
import { isFormEventName } from './form-tag-match';
import { parseTaFrames, type TaCapture } from './ta-stream';
import type { PerTagCapture } from './verify-tags';

/** One reviewed form to REALLY submit through the Tag Assistant session (page + identity + filled fields). */
export interface TaFormSubmit {
  page: string;
  formId: string;
  formClasses: string;
  /** 'js' = a div/JS widget → click its submit control; anything else = native <form>.submit(). */
  method: string;
  fields: FormSubmitFieldInput[];
}

const TA_URL = 'https://tagassistant.google.com/';

/** Extract GTM preview creds (gtm_auth / gtm_preview / gtm_cookies_win) from ANYTHING the user pastes:
 *  the GTM Preview JS snippet (where they sit inside the container-id string, e.g.
 *  `'GTM-XXX&gtm_auth=..&gtm_preview=env-5&gtm_cookies_win=x'`), a Preview/Tag-Assistant URL, or a bare
 *  gtm.js loader URL. Regex-based (not URL parsing) so all three formats work. null if not a preview.
 *  PURE. Exported for tests. */
export function previewParamsFromAny(text?: string | null): { gtm_auth: string; gtm_preview: string; gtm_cookies_win: string } | null {
  if (!text) return null;
  const auth = text.match(/gtm_auth=([^&'"\s]+)/i);
  const preview = text.match(/gtm_preview=([^&'"\s]+)/i);
  if (!auth || !preview) return null;
  const cw = text.match(/gtm_cookies_win=([^&'"\s]+)/i);
  return { gtm_auth: auth[1], gtm_preview: preview[1], gtm_cookies_win: cw ? cw[1] : 'x' };
}

/** Per-account Tag Assistant profile directory. Each connected Google account gets its OWN persistent
 *  browser profile under <userData>/ta-profiles/<accountId>, so switching the app's active Gmail uses
 *  that Gmail's own TA session instead of one shared (wrong-account) session. accountId is sanitized to
 *  a safe path segment; a missing id falls back to a shared 'default' bucket. PURE (path join only). */
export function taProfileDirFor(userDataDir: string, accountId?: string | null): string {
  const safe = (accountId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  return `${userDataDir.replace(/[\\/]+$/, '')}/ta-profiles/${safe}`;
}

// Minimal Playwright surface (mirrors verify-driver's local typing so we don't depend on @types).
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<R = unknown>(fn: unknown, arg?: unknown): Promise<R>;
  // Per-PAGE init script (runs on every future navigation of THIS page) - used to keep an injected
  // container present across the multi-page drive when the context-level init script does not reach
  // the Tag Assistant popup.
  addInitScript(fn: unknown, arg?: unknown): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<void>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  locator(sel: string): { first(): { count(): Promise<number>; click(o?: Record<string, unknown>): Promise<void>; fill(v: string, o?: Record<string, unknown>): Promise<void>; isVisible(): Promise<boolean>; press(key: string, o?: Record<string, unknown>): Promise<void> } };
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; timeout?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
  isClosed(): boolean;
  url(): string;
}
interface PwContext {
  addInitScript(fn: unknown, arg?: unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: { request(): { url(): string }; continue(overrides?: { url?: string }): Promise<void>; abort(): Promise<void> }) => unknown): Promise<void>;
  waitForEvent(event: 'page', opts?: { timeout?: number }): Promise<PwPage>;
  close(): Promise<void>;
  pages(): PwPage[];
  cookies(urls?: string | string[]): Promise<Array<{ name: string }>>;
  addCookies(cookies: Array<{ name: string; value: string; domain: string; path: string }>): Promise<void>;
}

async function loadPw(): Promise<{ chromium: { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext> } } | null> {
  try {
    // Non-literal specifier (same pattern as playwright-driver.ts): playwright is an optional install,
    // so this must not be statically resolvable — the app typechecks without playwright present.
    const specifier = 'playwright';
    const mod = (await import(specifier)) as unknown as { chromium: { launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext> } };
    return mod;
  } catch {
    return null;
  }
}

/** Launch the persistent TA profile. Prefer the real Chrome channel (Google sign-in trusts it far more
 *  than bundled Chromium); fall back to bundled Chromium. Headed for the one-time sign-in, headless for
 *  verify runs.
 *
 *  The two args are what make Google sign-in actually succeed (verified by probe): ignoreDefaultArgs
 *  drops "--enable-automation" (the "controlled by automated software" infobar), and
 *  "--disable-blink-features=AutomationControlled" flips navigator.webdriver from true→false — Google's
 *  sign-in refuses browsers that report webdriver=true ("this browser or app may not be secure"). */
async function launchProfile(profileDir: string, headless: boolean): Promise<PwContext> {
  const pw = await loadPw();
  if (!pw) throw new PlaywrightUnavailableError();
  const base = {
    headless,
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await pw.chromium.launchPersistentContext(profileDir, { ...base, channel: 'chrome' });
  } catch {
    return await pw.chromium.launchPersistentContext(profileDir, base);
  }
}

// A Chromium persistent profile takes an EXCLUSIVE lock on its user-data-dir: two launchPersistentContext
// calls on the same dir at once → the second crashes. The sign-in (fired at account-connect AND inline in
// verify) and the verify run itself all touch the ONE ta-profile, so serialize every profile access
// through this gate — callers queue instead of colliding. (Verify is one-at-a-time anyway.)
let profileGate: Promise<unknown> = Promise.resolve();
/** Exported for tests. Runs `fn` after every previously-queued task settles (success OR failure), so
 *  profile launches never overlap; a rejecting task doesn't wedge the queue. */
export function serializeProfile<T>(fn: () => Promise<T>): Promise<T> {
  const next = profileGate.then(fn, fn);
  profileGate = next.then(() => undefined, () => undefined);
  return next;
}

// After a successful run we LEAVE the Tag Assistant window open so the user can inspect the live TA panel
// (they asked for this). But an open window keeps the profile's exclusive lock, so the NEXT run must close
// it first. We hold the context here and close it at the start of the next run (or on app quit).
let openTaContext: { close(): Promise<void> } | null = null;
/** Close a left-open Tag Assistant inspection window (releases the profile lock). Best-effort. Called at
 *  the start of each run and wired to app quit so we don't leave an orphan Chrome behind. Returns whether
 *  it actually closed a window (the caller waits out the Windows lock-release lag before relaunching). */
export async function closeOpenTaWindow(): Promise<boolean> {
  const c = openTaContext;
  openTaContext = null;
  if (!c) return false;
  await c.close().catch(() => undefined);
  return true;
}

/** Signed-in check that can't be fooled by page copy: a Google web session leaves its account cookies
 *  (SAPISID / __Secure-1PSID / SID) on accounts.google.com in the persistent profile. */
async function hasGoogleSession(ctx: PwContext): Promise<boolean> {
  try {
    const cookies = await ctx.cookies('https://accounts.google.com');
    return cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-1PSID' || c.name === 'SID');
  } catch {
    return false;
  }
}

/** Runs in every page of the TA profile: capture the debug frames the TA page receives. Only attaches on
 *  the tagassistant origin, so site pages carry no listener. */
function captureFramesInit(): void {
  if (location.origin !== 'https://tagassistant.google.com') return;
  const w = window as unknown as { __taFrames?: string[] };
  const frames = (w.__taFrames = w.__taFrames || []);
  window.addEventListener('message', (e: MessageEvent) => {
    try { frames.push(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)); } catch { /* skip */ }
  }, true);
}


export interface TaVerifyResult {
  pagesOk: boolean;
  /** The user must sign in (one-time) before TA can debug a GTM container. */
  needSignIn?: boolean;
  /** TA connected but the GTM container didn't enter debug — operator-readable reason. */
  debugProblem?: string;
  /** Every GTM container Tag Assistant actually saw on the page — so a selected-vs-live container
   *  mismatch is visible (the "it's using a different container id" case). */
  containersSeen?: string[];
  /** The selected container was INJECTED into this driven session (it was not live on the page) so Tag
   *  Assistant could see it. Results confirm the tags fire when the container is present; they do NOT
   *  prove the container is currently deployed on the public site. Drives an honesty note in the UI. */
  injectedContainer?: boolean;
  error?: string;
  perTag: PerTagCapture[];
  pagesDriven: string[];
  /** The parsed authoritative debug capture (per-event tags fired + API-Call pushes). */
  capture?: TaCapture;
  /** Proof screenshots captured DURING the drive: each is the Tag Assistant panel right after an
   *  interaction, with `fired` = the "Tags Fired" text shown, so the IPC attaches it to whichever tags it
   *  proves. Best-effort. */
  captures?: Array<{ screenshot: string; fired: string; tag?: string }>;
  /** One full Tag Assistant panel screenshot taken at the end — a guaranteed fallback so a genuinely-fired
   *  tag always has SOME proof. */
  summaryShot?: string;
}

// ── Phase 3 rail navigation (runs IN the Tag Assistant page) ─────────────────────────────────────────
// Tag Assistant numbers its left-rail events with its OWN continuous global counter (…131, 178, 186…),
// which is NOT the gtm.uniqueEventId in our debug frames — so we can't address a row by number. Instead we
// index the rows, click a candidate, and READ BACK what the panel shows (the API Call's dataLayer event +
// the Tags-Fired names) to confirm we landed on the right event before screenshotting.

/** In the TA page: dismiss the blue "Connected!" modal / any dialog "Continue" button that overlays the
 *  debug panel (it reappears on each navigation), so a screenshot shows the event detail, not the modal. */
function dismissTaOverlays(): void {
  try {
    const btns = Array.prototype.slice.call(document.querySelectorAll('button')) as HTMLElement[];
    for (const b of btns) {
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === 'continue') b.click();
    }
  } catch { /* best-effort */ }
}

/** In the TA page: tag the NEWEST rail event rows with data-ta-snap="i" (i=0 is newest) and return their
 *  selectors, newest first. The driver then REAL-clicks each via Playwright (an in-page synthetic .click()
 *  does NOT switch Tag Assistant's Angular panel — that was why every proof came out as the Summary). */
function tagNewestTaRows(limit?: number): Array<{ sel: string; num: number }> {
  const byNum: Record<number, { el: HTMLElement; depth: number }> = {};
  try {
    document.querySelectorAll('[data-ta-snap]').forEach((e) => e.removeAttribute('data-ta-snap')); // clear last call's tags so an index never matches two rows
    // A tag-detail view lists "Messages Where This Tag Fired" chips ("22 form_submission") that look EXACTLY
    // like rail rows and are shallower, so they used to win the tie-break. Clicking one jumped to an OLD
    // event, which is how a later page kept re-proving the PREVIOUS page's tags. Exclude that whole region.
    let msgHead: Element | null = null;
    let msgLen = Infinity;
    for (const el of Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,div,span,p')) as HTMLElement[]) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^messages where this tag fired$/i.test(t) || t.length >= msgLen) continue;
      msgLen = t.length; msgHead = el;
    }
    const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    const all = Array.prototype.slice.call(document.querySelectorAll('a,li,button,[role="button"],div,span')) as HTMLElement[];
    for (const el of all) {
      if (msgHead && (msgHead.compareDocumentPosition(el) & FOLLOWS)) continue; // a message chip, not a rail row
      if (el.getClientRects && el.getClientRects().length === 0) continue; // not rendered - cannot be clicked
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = /^(\d+)\s*(\D.*)$/.exec(t);
      if (!m || t.length > 44) continue;
      // The panel's own counters have the same shape as a rail row: "80 tags did not fire" parsed as row
      // #80, sorted FIRST (highest number), and clicking it switches nothing - the observed phantom rows
      // #73 and #71 that wasted the first pick every time. A real rail row is an event name, never a count.
      if (/\btags?\b/i.test(m[2]) || /\bfire/i.test(m[2])) continue;
      const num = parseInt(m[1], 10);
      const depth = el.querySelectorAll('*').length;
      if (!byNum[num] || depth < byNum[num].depth) byNum[num] = { el, depth };
    }
  } catch { /* best-effort */ }
  // The tightest text match is often an inner <span> that has no click handler, so clicking it did nothing
  // and TA never switched to the per-event panel (the "LOW switch ratio" symptom, which then left every
  // drill on the Summary and its names-only detail). Climb to the row's real interactive element, stopping
  // before any ancestor that swallows other rows (text must still start with THIS row's number).
  const clickable = (el: HTMLElement, num: number): HTMLElement => {
    let p: HTMLElement | null = el;
    for (let i = 0; p && i < 5; i += 1, p = p.parentElement) {
      const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (!new RegExp('^' + num + '\\b').test(t) || t.length > 60) break; // climbed into a multi-row container
      const tag = (p.tagName || '').toLowerCase();
      const role = ((p.getAttribute && p.getAttribute('role')) || '').toLowerCase();
      if (tag === 'a' || tag === 'li' || tag === 'button' || role === 'button' || role === 'listitem' || role === 'tab' || role === 'option' || (p.hasAttribute && p.hasAttribute('tabindex'))) return p;
    }
    return el;
  };
  const nums = Object.keys(byNum).map(Number).sort((a, b) => b - a).slice(0, limit ?? 14); // newest first
  return nums.map((num, i) => { clickable(byNum[num].el, num).setAttribute('data-ta-snap', String(i)); return { sel: `[data-ta-snap="${i}"]`, num }; });
}

/** In the TA page: the NUMBER of the rail row currently selected, or 0 when it cannot be determined.
 *  Event names repeat across pages - two real form submits both produce "form_submission" - so the name
 *  alone cannot tell page 2's event from page 1's. When a rail click fails to switch the panel, the stale
 *  panel still reads "form_submission" and the driver proves the WRONG page's tags. The row number is the
 *  only identity, so the caller confirms the selection actually moved before trusting the panel. */
function readTaSelectedRow(): number {
  try {
    const cands = Array.prototype.slice.call(
      document.querySelectorAll('[aria-selected="true"],[aria-current],[class*="select"],[class*="Select"],[class*="active"],[class*="Active"]'),
    ) as HTMLElement[];
    let best = 0;
    let bestLen = Infinity;
    for (const el of cands) {
      if (el.getClientRects && el.getClientRects().length === 0) continue; // not rendered
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 44) continue;
      const m = /^(\d+)\s*(\D.*)$/.exec(t);
      if (!m || /\btags?\b/i.test(m[2]) || /\bfire/i.test(m[2])) continue; // skip the "N tags did not fire" counter
      if (t.length < bestLen) { bestLen = t.length; best = parseInt(m[1], 10); }
    }
    return best;
  } catch { return 0; }
}

/** In the TA page: read the panel now showing — the raw dataLayer event from the API Call block + the
 *  "Tags Fired" text region (to confirm the target tag is listed and the event isn't empty). */
function readTaPanel(): { event: string; fired: string } {
  try {
    // innerText, NOT textContent: Angular keeps a closed view's markup in the DOM, and textContent reads
    // it anyway. That is how page 2's form_submission came back carrying page 1's Tags-Fired names, so the
    // driver thought both tags were "already proven" and drilled nothing. innerText is layout-aware, so a
    // hidden leftover panel contributes nothing and this only ever reads what is on screen.
    const all = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ');
    const m = /dataLayer\.push\(\{\s*event:\s*["']([^"']+)["']/.exec(all);
    const fi = all.indexOf('Tags Fired');
    const nfi = fi >= 0 ? all.indexOf('Tags Not Fired', fi) : -1;
    const fired = fi >= 0 ? all.slice(fi, nfi > fi ? nfi : fi + 1500) : '';
    return { event: m ? m[1] : '', fired };
  } catch { return { event: '', fired: '' }; }
}

/** In the TA page: the bounding rect of the CONTENT column (the panel that renders "API Call" / "Tags
 *  Fired" / a tag's detail), to the RIGHT of the event rail. Clipping a proof screenshot to this rect keeps
 *  the left rail (where "Summary" lives) OUT of the frame, so a per-event/per-tag proof can never look like
 *  the Summary. Heuristic + DOM-shape guarded: anchor on a content-only heading, climb to the widest
 *  sensible ancestor that is NOT the full viewport width (that would re-include the rail). null when it
 *  can't find a plausible panel, so the caller falls back to a full-page shot. */
function taContentRect(): { x: number; y: number; width: number; height: number } | null {
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    const anchors = ['api call', 'tags fired', 'output of', 'container loaded', 'data layer'];
    const els = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p')) as HTMLElement[];
    let head: HTMLElement | null = null;
    for (const el of els) {
      if (el.getClientRects && el.getClientRects().length === 0) continue; // on-screen only
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t.length < 40 && anchors.some((a) => t.startsWith(a))) { head = el; break; }
    }
    if (!head) return null;
    let node: HTMLElement | null = head;
    let best: DOMRect | null = null;
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect();
      // The content column: wide but not the whole window, tall, and starting right of the rail.
      if (r.width >= vw * 0.4 && r.width <= vw * 0.85 && r.height >= vh * 0.3 && r.left >= vw * 0.1) best = r;
      node = node.parentElement;
    }
    if (!best) return null;
    const x = Math.max(0, best.left), y = Math.max(0, best.top);
    return { x, y, width: Math.min(best.width, vw - x), height: Math.min(best.height, vh - y) };
  } catch { return null; }
}

/** In the TA page: open the FIRED TAG named `name` from the current event's "Tags Fired" list, so a
 *  screenshot shows that tag's FULL detail (properties, firing triggers, hits sent) rather than just the
 *  event's tags-fired summary. Tags the tightest clickable card whose text carries the tag name with
 *  data-ta-tag="1" and returns its selector for a REAL Playwright click (a synthetic click won't switch
 *  Tag Assistant's Angular view). Returns '' when no matching fired-tag card is found. */
function openFiredTagInPage(name: string): string {
  try {
    document.querySelectorAll('[data-ta-tag]').forEach((e) => e.removeAttribute('data-ta-tag'));
    const want = (name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return '';
    // SCOPE the search to the CURRENT panel's "Tags Fired" region (between that heading and "Tags Not
    // Fired"). Searching the whole document could match the same tag name in the left rail or another
    // panel and open the tag from the wrong place - a detail opened outside an event has no
    // "Display Variables as" toggle, so its proof can never show resolved values.
    const tightHeading = (re: RegExp): Element | null => {
      let best: Element | null = null;
      let bestLen = Infinity;
      const all = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p')) as HTMLElement[];
      for (const el of all) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 40 || !re.test(t)) continue;
        if (t.length < bestLen) { bestLen = t.length; best = el; }
      }
      return best;
    };
    // Prefix-matched, not exact: a heading rendered as "Tags Fired (5)" must still anchor the region, else
    // inFiredRegion silently falls back to searching the WHOLE document again. "Tags Not Fired" cannot match.
    const firedHead = tightHeading(/^tags fired\b/i);
    const notFiredHead = tightHeading(/^tags not fired/i);
    const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    const inFiredRegion = (el: Element): boolean => {
      if (!firedHead) return true; // heading not found - fall back to the whole document (old behaviour)
      if (!(firedHead.compareDocumentPosition(el) & FOLLOWING)) return false; // before the Tags Fired heading
      if (notFiredHead && (notFiredHead.compareDocumentPosition(el) & FOLLOWING)) return false; // in Tags NOT Fired
      return true;
    };
    const nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],div,span,td,li')) as HTMLElement[];
    let bestEl: HTMLElement | null = null;
    let bestLen = Infinity;
    for (const el of nodes) {
      // Skip anything not actually rendered: a hidden leftover view can hold the same tag name, and
      // clicking it does nothing (Playwright would just time out on an invisible element).
      if (el.getClientRects && el.getClientRects().length === 0) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t || t.indexOf(want) < 0) continue;
      // Prefer the TIGHTEST element still holding the whole name (the card title/row, not a wrapper that
      // holds the entire Tags-Fired list). Cap the extra chars so a big wrapper is skipped.
      if (t.length > want.length + 48) continue;
      if (!inFiredRegion(el)) continue;
      if (t.length < bestLen) { bestLen = t.length; bestEl = el; }
    }
    if (!bestEl) return '';
    bestEl.setAttribute('data-ta-tag', '1');
    return '[data-ta-tag="1"]';
  } catch { return ''; }
}

/** In the TA page: a compact structural readout of the view now on screen, logged ONCE per run when a
 *  drill-down is rejected. Without it a failure only says "opened from the Summary" and the next fix is a
 *  guess at Tag Assistant's DOM; this reports what is actually there - the breadcrumb, which marker
 *  sections exist, the radios found, and whether the message chip is locatable. */
function readTaDiagnostics(): string {
  try {
    const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
    const flat = norm(document.body.innerText || document.body.textContent); // visible text only
    const has = (re: RegExp): string => (re.test(flat) ? 'yes' : 'no');
    // The breadcrumb head: the tightest element ending in ">" near the top, else the first heading text.
    let crumb = '';
    for (const el of Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,a,span,div')) as HTMLElement[]) {
      const t = norm(el.textContent);
      if (t.length > 40 || !/>$/.test(t)) continue;
      if (!crumb || t.length < crumb.length) crumb = t;
    }
    const radios: string[] = [];
    for (const r of Array.prototype.slice.call(document.querySelectorAll('input[type="radio"],[role="radio"]')) as Element[]) {
      const wrap = r.closest ? r.closest('label') : null;
      const lbl = norm(wrap ? wrap.textContent : (r.nextElementSibling ? r.nextElementSibling.textContent : ''));
      const on = (r as HTMLInputElement).checked === true || r.getAttribute('aria-checked') === 'true';
      radios.push(`${lbl || '?'}${on ? '(on)' : ''}`);
    }
    let chips = 0;
    for (const el of Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],div,span,li')) as HTMLElement[]) {
      if (/^\d+\s+\S/.test(norm(el.textContent)) && norm(el.textContent).length <= 44) chips += 1;
    }
    return `crumb="${crumb}" tagDetails=${has(/Tag Details/i)} toggle=${has(/Display Variables as/i)} messages=${has(/Messages Where This Tag Fired/i)} firingStatus=${has(/Firing Status/i)} tagsFired=${has(/Tags Fired/i)} radios=[${radios.join(', ')}] numberedEls=${chips}`;
  } catch (e) { return 'diagnostics failed: ' + String(e).slice(0, 80); }
}

/** In the TA tag-detail page: mark the BREADCRUMB link (e.g. "22 form_submission >") and return its
 *  selector. Clicking it goes back to exactly the event whose detail we opened, which is how the driver
 *  returns between tags when one event fired several. More reliable than re-clicking the rail row, whose
 *  data-ta-snap attribute Angular may have dropped when it rendered the detail - that stale selector is
 *  why only the FIRST tag of each event was getting its own proof. */
function tagTaCrumbLink(): string {
  try {
    document.querySelectorAll('[data-ta-crumb]').forEach((e) => e.removeAttribute('data-ta-crumb'));
    const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
    let best: HTMLElement | null = null;
    let bestLen = Infinity;
    for (const el of Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],span,div')) as HTMLElement[]) {
      const t = norm(el.textContent);
      if (t.length > 40 || !/>$/.test(t) || t.length <= 1) continue;
      if (t.length < bestLen) { bestLen = t.length; best = el; }
    }
    if (!best) return '';
    // Prefer a clickable ancestor: the crumb text often sits in a plain span with no handler.
    let target: HTMLElement = best;
    let p: HTMLElement | null = best;
    for (let i = 0; p && i < 4; i += 1, p = p.parentElement) {
      const tag = (p.tagName || '').toLowerCase();
      const role = ((p.getAttribute && p.getAttribute('role')) || '').toLowerCase();
      if (norm(p.textContent).length > 60) break;
      if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link' || (p.hasAttribute && p.hasAttribute('tabindex'))) { target = p; break; }
    }
    target.setAttribute('data-ta-crumb', '1');
    return '[data-ta-crumb="1"]';
  } catch { return ''; }
}

/** In the TA SUMMARY-context tag detail: mark the first "Messages Where This Tag Fired" chip (e.g.
 *  "22 form_submission") and return its selector. That chip is the route from the tag's GLOBAL detail
 *  (breadcrumb "Summary >", variable NAMES only, no toggle) into the per-message EVENT-context detail
 *  (breadcrumb "22 form_submission >", Firing Status + the "Display Variables as" toggle), which is the
 *  only view that can show resolved values. Returns '' when the section is not present. */
function tagTaMessageChip(): string {
  try {
    document.querySelectorAll('[data-ta-msg]').forEach((e) => e.removeAttribute('data-ta-msg'));
    const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
    let head: Element | null = null;
    let headLen = Infinity;
    for (const el of Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,div,span,p')) as HTMLElement[]) {
      const t = norm(el.textContent);
      if (!/^messages where this tag fired$/i.test(t) || t.length >= headLen) continue;
      headLen = t.length; head = el;
    }
    if (!head) return '';
    const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    let best: Element | null = null;
    let bestLen = Infinity;
    for (const el of Array.prototype.slice.call(document.querySelectorAll('a,button,[role="button"],div,span,li')) as HTMLElement[]) {
      if (!(head.compareDocumentPosition(el) & FOLLOWS)) continue;
      const t = norm(el.textContent);
      if (!/^\d+\s+\S/.test(t) || t.length > 44) continue; // "22 form_submission"; long trigger blobs excluded
      if (t.length < bestLen) { bestLen = t.length; best = el; }
    }
    if (!best) return '';
    best.setAttribute('data-ta-msg', '1');
    return '[data-ta-msg="1"]';
  } catch { return ''; }
}

/** In the TA page: the state of the tag-detail view we may have just opened.
 *   - isDetail: a "Tag Details" panel is showing.
 *   - eventContext: it was opened from an EVENT row, so it carries the "Display Variables as" toggle (and a
 *     Firing Status row). A detail opened from the SUMMARY view has NEITHER, shows only {{variable}} names,
 *     and can never be switched to values - so the driver must reject it and re-open from the event.
 *   - valuesActive: the "Values" radio of that toggle is currently selected (resolved values are shown).
 *   - nameOk: the detail's own TITLE (the heading above "Tag Details", after the breadcrumb) is the tag we
 *     asked for. Without this a click that landed on the wrong card still gets stored under the requested
 *     tag's name, which is the "tag name and screenshot do not match" the operator saw. Pass the wanted
 *     name to check it; omit it (state-only probes) and nameOk is reported true. */
function readTaTagDetailState(want?: string): { isDetail: boolean; eventContext: boolean; valuesActive: boolean; nameOk: boolean } {
  const out = { isDetail: false, eventContext: false, valuesActive: false, nameOk: true };
  try {
    // Visible text only (see readTaPanel): a closed detail Angular left in the DOM used to make isDetail
    // report true on an event panel, which produced the false "could not get back" and "a detail is still
    // on screen" lines.
    const t = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ');
    out.isDetail = /Tag Details/i.test(t) && /(Firing Triggers|Hits sent|Blocking Triggers)/i.test(t);
    // The toggle IS the discriminator. Live diagnostics proved an event-context detail
    // (crumb="22 form_submission >", toggle=yes, firingStatus=yes, radios=[Names, Values(on)]) ALSO carries
    // a "Messages Where This Tag Fired" section, so the earlier rule - which required that section to be
    // ABSENT - rejected perfectly good views and produced 0 proofs. A Summary-context detail has no toggle
    // at all, and no toggle means values can never be shown, so presence of the toggle is both the correct
    // signal and exactly what the next step needs.
    out.eventContext = /Display Variables as/i.test(t) || /Firing Status/i.test(t);
    const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
    if (want) {
      // Identity by the HEADER region: everything before the "Tag Details" heading is the breadcrumb plus
      // the tag title, so the requested name must appear there. Matching the region (not an element whose
      // text is exactly the name) survives a title rendered with a "Fired" badge or split across nodes,
      // while still excluding the same name lower down in a Tags-Fired list.
      const wantN = norm(want).toLowerCase();
      const flatLc = t.toLowerCase();
      const cut = flatLc.indexOf('tag details');
      out.nameOk = (cut > 0 ? flatLc.slice(0, cut) : flatLc).indexOf(wantN) >= 0;
    }
    // The tight label of a radio: its wrapping <label>, its label[for=id], else its next sibling. Kept tight
    // (exactly "Values") so the Names radio - whose PARENT text is "Names Values" - can never match.
    const labelOf = (r: Element): string => {
      const wrap = r.closest ? r.closest('label') : null;
      if (wrap && wrap.textContent) return wrap.textContent.replace(/\s+/g, ' ').trim();
      const id = (r as HTMLInputElement).id;
      if (id) {
        const l = document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]');
        if (l && l.textContent) return l.textContent.replace(/\s+/g, ' ').trim();
      }
      const sib = r.nextElementSibling;
      if (sib && sib.textContent) return sib.textContent.replace(/\s+/g, ' ').trim();
      return '';
    };
    const radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"],[role="radio"]')) as Element[];
    for (const r of radios) {
      if (labelOf(r).toLowerCase() !== 'values') continue;
      if ((r as HTMLInputElement).checked === true || r.getAttribute('aria-checked') === 'true') { out.valuesActive = true; break; }
    }
  } catch { /* best-effort */ }
  return out;
}

/** In the TA tag-detail page: tag the "Values" control of the "Display Variables as: Names | Values" toggle
 *  with data-ta-values="1" and return its selector, so the driver can REAL-click it and the proof shows
 *  RESOLVED values (click_url, page_url, ...) instead of {{variable}} names. Prefers the radio's own
 *  <label> (a Material radio input is often invisible, so Playwright cannot click it directly), else the
 *  tightest element whose text is exactly "Values". Returns '' when the toggle is not on this view. */
function tagTaValuesRadio(): string {
  try {
    document.querySelectorAll('[data-ta-values]').forEach((e) => e.removeAttribute('data-ta-values'));
    const mark = (el: Element): string => { el.setAttribute('data-ta-values', '1'); return '[data-ta-values="1"]'; };
    const tight = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // 1. The radio labelled exactly "Values" - click its label (reliably toggles the radio).
    const radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"],[role="radio"]')) as Element[];
    for (const r of radios) {
      const wrap = r.closest ? r.closest('label') : null;
      if (wrap && tight(wrap.textContent) === 'values') return mark(wrap);
      const id = (r as HTMLInputElement).id;
      if (id) {
        const l = document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]');
        if (l && tight(l.textContent) === 'values') return mark(l);
      }
      const sib = r.nextElementSibling;
      if (sib && tight(sib.textContent) === 'values') return mark(sib);
    }
    // 2. Fallback: the tightest element whose text is exactly "Values" (the singular "Value" column header
    //    of the Properties table cannot match).
    const cands = Array.prototype.slice.call(document.querySelectorAll('label,[role="radio"],button,span,a,div')) as HTMLElement[];
    let best: HTMLElement | null = null;
    for (const el of cands) {
      if (tight(el.textContent) !== 'values') continue;
      if (!best || el.querySelectorAll('*').length < best.querySelectorAll('*').length) best = el;
    }
    return best ? mark(best) : '';
  } catch { return ''; }
}

/** In the TA page: open the rail "Summary" view (the aggregate Tags-Fired list) so the FALLBACK proof
 *  screenshot is meaningful — never a random empty event. Best-effort. */
// Read the Google-tag ids Tag Assistant lists on the page (its "Google tags found" chip bar). Runs
// IN the TA page. Text/regex-based (not selector-based) so it survives TA DOM changes: any
// GTM-/AW-/DC-/G- id shown anywhere is a container/tag TA found. This is the AUTHORITATIVE "what's on
// the page" signal — the debug stream only carries containers that actually entered debug.
function readTaContainerChips(): string[] {
  try {
    const text = document.body ? document.body.innerText || '' : '';
    const ids = text.match(/\b(?:GTM|AW|DC)-[A-Z0-9]{4,}\b|\bG-[A-Z0-9]{6,}\b/gi) || [];
    return Array.from(new Set(ids.map((s) => s.toUpperCase())));
  } catch {
    return [];
  }
}

/** In the TA page: mark the rail's "Summary" item and return its selector, so the driver can REAL-click it.
 *  clickTaSummary below does an IN-PAGE synthetic click, which (as this file documents for rail rows) does
 *  NOT switch Tag Assistant's Angular view - so the reset it was meant to perform silently did nothing and
 *  the next capture started from whatever was already showing. */
function tagTaSummaryItem(): string {
  try {
    document.querySelectorAll('[data-ta-sum]').forEach((e) => e.removeAttribute('data-ta-sum'));
    const el = (Array.prototype.slice.call(document.querySelectorAll('a,li,button,[role="button"],div,span')) as HTMLElement[])
      .find((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'summary');
    if (!el) return '';
    let t: HTMLElement = el;
    let p: HTMLElement | null = el;
    for (let k = 0; k < 4 && p; k += 1, p = p.parentElement) {
      const tag = (p.tagName || '').toLowerCase();
      const role = ((p.getAttribute && p.getAttribute('role')) || '').toLowerCase();
      if ((p.textContent || '').replace(/\s+/g, ' ').trim().length > 30) break;
      if (tag === 'a' || tag === 'li' || tag === 'button' || role === 'button' || role === 'listitem' || (p.hasAttribute && p.hasAttribute('tabindex'))) { t = p; break; }
    }
    t.setAttribute('data-ta-sum', '1');
    return '[data-ta-sum="1"]';
  } catch { return ''; }
}

function clickTaSummary(): void {
  try {
    const el = (Array.prototype.slice.call(document.querySelectorAll('a,li,button,[role="button"],div,span')) as HTMLElement[])
      .find((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'summary');
    if (!el) return;
    let t: HTMLElement | null = el;
    for (let k = 0; k < 4 && t; k += 1) {
      if (t.tagName.toLowerCase() === 'button' || t.getAttribute('role') === 'button' || (t as unknown as { onclick?: unknown }).onclick) break;
      t = t.parentElement;
    }
    (t ?? el).click();
  } catch { /* best-effort */ }
}

/**
 * The Phase-2 drive: connect TA to `url`, then sequentially navigate the SAME debugged popup through each
 * tag's page and drive its trigger, capturing the debug stream throughout. Proof screenshots are captured
 * DURING the drive (per interaction) and the TA-style timeline UI renders them.
 */
export async function runTaVerify(
  profileDir: string,
  url: string,
  tags: VerifyDriverTag[],
  containerPublicId: string,
  opts: { settleMs?: number; navTimeoutMs?: number; loginHint?: string; signInTimeoutMs?: number; previewSnippet?: string; injectContainerId?: string; forms?: TaFormSubmit[]; onSignInPrompt?: () => void; onPageProgress?: (page: string, done: number, total: number) => void; onFormProgress?: (page: string, done: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<TaVerifyResult> {
  const settleMs = opts.settleMs ?? 900;
  const navTimeoutMs = opts.navTimeoutMs ?? 25_000;
  const perTag: PerTagCapture[] = [];
  const pagesDriven: string[] = [];
  if (!(await requestAllowed(url))) {
    return { pagesOk: false, perTag, pagesDriven, error: `Refusing to load ${url}: blocked by the SSRF guard.` };
  }
  // GTM PREVIEW mode: a published GTM container does NOT enter Tag Assistant debug via the plain connect
  // flow (only Google tags do). Loading the container's gtm.js WITH the preview creds (gtm_auth /
  // gtm_preview, parsed from the user's pasted GTM Preview snippet) makes Google serve the debug-
  // instrumented preview build, which DOES stream its tag-firing frames. previewParams=null => connect
  // only (Google-tag events, no GTM-container tags). Zero footprint (Quick Preview creates nothing).
  const previewParams = previewParamsFromAny(opts.previewSnippet);
  const withPreview = (u: string): string => withPreviewParams(u, previewParams);
  // If the operator pasted a FULL Tag Assistant link (the URL GTM's Preview button opens, e.g.
  // tagassistant.google.com/?...#/?source=TAG_MANAGER&id=GTM-XXXX&gtm_auth=...&gtm_preview=...), navigate
  // to THAT directly to start the container's real debug session. Our own "Add domain -> Connect" flow is
  // TA's inspect-a-live-site mode, which only surfaces Google tags and shows "not enabled for debugging"
  // for a GTM container - because a container only enters TA debug from a genuine Preview/debug session.
  const taDebugUrl = (() => {
    const m = (opts.previewSnippet || '').match(/https?:\/\/tagassistant\.google\.com\/[^\s"'<>]*/i);
    return m ? m[0] : null;
  })();
  // Serialize with any other profile access: the exclusive ta-profile lock means one at a time.
  return serializeProfile(async () => {
  // Close a window left open from a PREVIOUS run first — it still holds the profile's exclusive lock.
  // If we did close one, wait out the brief Windows lock-release lag before relaunching the same profile.
  if (await closeOpenTaWindow()) await new Promise((r) => setTimeout(r, 1200));
  // PREFLIGHT INJECTION (Step 3): the operator hit Proceed past a missing/mismatch gate, so the selected
  // container is NOT the one live on this page. Make Tag Assistant debug YOUR container by injecting its
  // gtm.js (carrying the pasted GTM Preview creds so it loads in DEBUG/preview mode) - this mirrors the
  // manual flow (inject the snippet + open the Preview link in a clean Incognito window).
  const injectContainerId = opts.injectContainerId ? opts.injectContainerId.trim().toUpperCase() : '';
  // (B) When we inject a non-live container with a Preview link, no Google sign-in is needed - so run in a
  // FRESH, cleared profile (incognito-like) rather than the saved TA profile. This removes stale cookies /
  // a prior session that can stop the injected container from entering debug, matching the user's Incognito
  // test exactly. Cleared each run so state never carries over.
  const useCleanProfile = Boolean(injectContainerId && previewParams);
  let launchDir = profileDir;
  if (useCleanProfile) {
    launchDir = path.join(os.tmpdir(), 'samarth-ta-inject');
    await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
    console.log('[preflight] using a fresh, cleared profile (incognito-like) for the injected-container run.');
  }
  // Inject the selected (non-live) container with addInitScript (runs in the page's MAIN world before any
  // page script) - the reliable, extension-free equivalent of the Adswerve "Inject Code" step. Chrome 137
  // removed --load-extension for real Chrome, so a side-loaded extension is unreliable; addInitScript is not.
  // The injected gtm.js carries the pasted Preview creds (gtm_auth/gtm_preview) so Google serves the debug
  // build, plus gtm_debug=x. Per how Tag Assistant preview actually works, a container enters DEBUG mode from
  // ANY of three signals - gtm_debug in the URL, a tagassistant.google.com referrer (the popup TA opens), or
  // the __TAG_ASSISTANT first-party cookie - so we set all we can, no manual "Connect" click required.
  const injectQs = injectContainerId
    ? (previewParams ? `&gtm_auth=${previewParams.gtm_auth}&gtm_preview=${previewParams.gtm_preview}&gtm_cookies_win=${previewParams.gtm_cookies_win}` : '') + '&gtm_debug=x'
    : '';
  // HEADED (visible): the user WATCHES Tag Assistant connect and show tags firing.
  const ctx = await launchProfile(launchDir, false);
  let keepWindowOpen = false; // on success, leave the TA window open for the user to inspect
  if (injectContainerId) {
    console.log(`[preflight] step 3: injecting ${injectContainerId} in DEBUG mode via addInitScript (gtm_debug=x${previewParams ? ' + preview creds' : ' + published build'}) ...`);
    // Set the __TAG_ASSISTANT first-party cookie on the target site so its gtm.js seeks a Tag Assistant
    // connection - one of the three debug signals, and it does not depend on the Connect handshake timing.
    try {
      const host = new URL(url).hostname;
      await ctx.addCookies([
        { name: '__TAG_ASSISTANT', value: 'x', domain: host, path: '/' },
        { name: '__TAG_ASSISTANT', value: 'x', domain: '.' + host, path: '/' },
      ]);
      console.log(`[preflight] set the __TAG_ASSISTANT debug cookie on ${host}.`);
    } catch (e) {
      console.log(`[preflight] could not set __TAG_ASSISTANT cookie (${(e as Error).message}); relying on gtm_debug + the tagassistant referrer.`);
    }
  }
  // Injects a GTM container's gtm.js (with the pasted preview creds + gtm_debug) into whatever page
  // runs it - the extension-free "inject code" step. Self-contained (no outer refs) so Playwright can
  // serialize it for BOTH addInitScript (future navigations) AND evaluate (an already-loaded page).
  // Used on the context, and - because the context init script does NOT always reach Tag Assistant's
  // debug popup - directly on that popup below.
  const gtmInjector = (arg: { id: string; qs: string }): void => {
    try {
      const o = location.origin;
      if (o === 'https://tagassistant.google.com' || o.indexOf('https://accounts.google.com') === 0) return; // TA / sign-in tabs only
      const w = window as unknown as { google_tag_manager?: Record<string, unknown>; dataLayer?: unknown[] };
      if (w.google_tag_manager && w.google_tag_manager[arg.id]) return; // already booted → never double-load
      w.dataLayer = w.dataLayer || [];
      w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://www.googletagmanager.com/gtm.js?id=' + arg.id + arg.qs;
      (document.head || document.documentElement).appendChild(s);
    } catch { /* injection is best-effort; the boot diagnostic confirms whether TA actually saw it */ }
  };
  const injectArg = { id: injectContainerId, qs: injectQs };
  try {
    await ctx.addInitScript(captureFramesInit);
    if (injectContainerId) {
      await ctx.addInitScript(gtmInjector, injectArg);
    }
    // Abort analytics collectors so driving tags never delivers a real hit (the TA stream, not beacons,
    // is the verdict source). In PREVIEW mode, rewrite the container's gtm.js request to carry the preview
    // creds (page-URL params are ignored by a normal loader, so the request itself must be rewritten) so
    // Google serves the debug-instrumented preview build. Everything else flows normally.
    await ctx.route('**/*', (route) => {
      const reqUrl = route.request().url();
      if (classifyCollector(reqUrl)) { void route.abort(); return; }
      // (C) Do NOT block the live container. The user's manual Incognito test had BOTH the live container
      // and the injected one on the page, and Tag Assistant still debugged the injected one (it has the
      // Preview session). Blocking the live gtm.js was a guess that could change page behaviour, so let
      // everything load and let TA attribute to the previewed container.
      if (
        previewParams &&
        /googletagmanager\.com\/gtm\.js/i.test(reqUrl) &&
        reqUrl.includes(`id=${containerPublicId}`) &&
        !/[?&]gtm_auth=/i.test(reqUrl)
      ) {
        const qp = `&gtm_auth=${previewParams.gtm_auth}&gtm_preview=${previewParams.gtm_preview}&gtm_cookies_win=${previewParams.gtm_cookies_win}`;
        void route.continue({ url: reqUrl + qp });
        return;
      }
      void route.continue();
    });

    // Reuse the profile's initial page (launchPersistentContext opened one) — no stray blank window.
    const ta = ctx.pages()[0] ?? (await ctx.newPage());

    // Sign-in is ONLY needed to debug a PUBLISHED container via signed-in GTM access. When a GTM Preview /
    // Share link is provided, its gtm_auth/gtm_preview ARE the authorization (a shared preview opens in any
    // Chrome with no Google login), so skip the one-time sign-in entirely and connect straight away.
    // ONE-TIME sign-in (no-preview path only) happens IN THIS SAME VISIBLE WINDOW, then SAVED FOREVER for
    // this account, so verify never asks again. login_hint pre-fills the account email on the sign-in form.
    if (previewParams) {
      console.log('[tag-assistant] preview link provided (gtm_auth/gtm_preview) - no Google sign-in needed.');
    } else if (await hasGoogleSession(ctx)) {
      console.log('[tag-assistant] using your saved Tag Assistant sign-in (no sign-in needed).');
    } else {
      console.log('[tag-assistant] first run for this account -> opening the ONE-TIME Tag Assistant sign-in...');
      opts.onSignInPrompt?.();
      const hint = opts.loginHint ? '&login_hint=' + encodeURIComponent(opts.loginHint) : '';
      await ta.goto('https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent(TA_URL) + hint,
        { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      const signInDeadline = Date.now() + (opts.signInTimeoutMs ?? 300_000);
      while (!(await hasGoogleSession(ctx))) {
        if (ta.isClosed() || Date.now() > signInDeadline) {
          return {
            pagesOk: false, perTag, pagesDriven, needSignIn: true,
            error: 'This is the ONE-TIME Tag Assistant sign-in - a Chrome window opened on the Google sign-in page (your email is pre-filled). It is a separate sign-in for Tag Assistant, not your normal Chrome, and you only do it once: after you complete it, it is saved and verify never asks again (and you never have to close your normal Chrome). Complete that sign-in, then click "Verify with Tag Assistant" again. Tip: connecting/reconnecting your Google account in Settings does NOT do this sign-in - it must be done in this window.',
          };
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      console.log('[tag-assistant] signed in and saved for next time.');
    }

    // Connect: navigate TA to the pasted Preview LINK (starts the container's debug session) when we have
    // one, else the bare TA app. Then Add domain -> URL -> Connect -> the debugged popup.
    console.log(`[tag-assistant] connecting to ${url} ${taDebugUrl ? '(via your pasted GTM Preview link - starts the container debug session)' : previewParams ? '(GTM PREVIEW mode)' : '(connect mode - Google tags only; paste your GTM Preview link to debug the GTM container)'} ...`);
    await ta.goto(taDebugUrl ?? TA_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await ta.waitForTimeout(2500);
    // DIAGNOSTIC: dump what the Tag Assistant landing actually shows (url + clickable labels), so a failed
    // connect is fixable from the log - button labels vary by TA version / locale, and a fresh profile can
    // land on a different first screen.
    const dumpTa = async (tag: string): Promise<void> => {
      try {
        const info = await ta.evaluate<{ url: string; clickables: string[] }>(() => ({
          url: location.href,
          clickables: Array.prototype.slice
            .call(document.querySelectorAll('button,[role="button"],a'))
            .map((b) => ((b as HTMLElement).textContent || '').trim())
            .filter((t) => t && t.length < 40)
            .slice(0, 30),
        }));
        console.log(`[tag-assistant] ${tag}: url=${info.url}`);
        console.log(`[tag-assistant] ${tag}: clickables=${JSON.stringify(info.clickables)}`);
      } catch { /* diagnostic only */ }
    };
    await dumpTa('landing');
    // A button can resolve but not be click-actionable yet while TA animates in. Give it longer + a force
    // retry so a transient overlay doesn't fail the run.
    const clickRobust = async (sel: string): Promise<boolean> => {
      const btn = ta.locator(sel).first();
      if (!(await btn.count())) return false;
      await btn.click({ timeout: 15_000 }).catch(async () => {
        await btn.click({ timeout: 6_000, force: true }).catch(() => undefined);
      });
      return true;
    };
    // Wait up to 15s for ANY connect-like control to appear, then click it (labels differ across TA versions
    // and locales). Returns whether something was clicked.
    const clickConnect = async (): Promise<boolean> => {
      const labels = ['Connect', 'Continue', 'Start debugging', 'Start', 'Debug', 'Confirm'];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        for (const label of labels) {
          if (await clickRobust(`button:has-text("${label}"), [role="button"]:has-text("${label}")`)) {
            console.log(`[tag-assistant] clicked "${label}".`);
            return true;
          }
        }
        await ta.waitForTimeout(500);
      }
      return false;
    };
    // ONE connect UI, both paths: the "Connect Tag Assistant to your site" modal. Its Connect button
    // stays DISABLED until the site URL is typed into the field (confirmed live: clicking Connect with
    // an empty field just leaves the modal open and no debug window ever opens - that was the "no debug
    // popup within 30s" failure). A pasted Preview/Share link pre-loads the container's debug creds but
    // still shows this same modal, so BOTH paths: open the modal -> TYPE the URL -> click the modal's
    // now-enabled Connect, which opens the debugged popup ("Opens your site in a new window").
    const popupP = ctx.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
    // The modal's URL text field (placeholder "e.g. https://www.google.com") - never the
    // "Include debug signal in the URL" checkbox.
    const urlField = ta.locator('input[placeholder*="http" i], [role="dialog"] input[type="url"], [role="dialog"] input[type="text"]').first();
    // 1) Make the modal appear if it is not already up: the bare app opens it from "Add domain", the
    //    preview-link landing from the header "Connect". A single click each (not the Connect loop, whose
    //    label also matches the modal's own disabled button).
    if (!(await urlField.isVisible().catch(() => false))) {
      await clickRobust('button:has-text("Add domain")');
      await ta.waitForTimeout(600);
    }
    if (!(await urlField.isVisible().catch(() => false))) {
      await clickRobust('button:has-text("Connect")');
      await ta.waitForTimeout(600);
    }
    // 2) Type the site URL so the modal's Connect enables. Tab blurs the field for builds that only
    //    validate/enable on change or blur.
    const urlFilled = await urlField.fill(url, { timeout: 12_000 }).then(() => true).catch(() => false);
    if (urlFilled) {
      await urlField.press('Tab').catch(() => undefined);
      await ta.waitForTimeout(400);
      console.log(`[tag-assistant] entered site URL in the connect modal: ${url}`);
    } else {
      await dumpTa('no-url-field');
      console.log('[tag-assistant] connect modal URL field not found - clicking Connect anyway.');
    }
    // 3) Click the modal's (now-enabled) Connect. Prefer the dialog-scoped button so a landing "Connect"
    //    behind the overlay is never clicked instead; fall back to the generic label search.
    const clickModalConnect = async (): Promise<boolean> => {
      const scoped = ta.locator('[role="dialog"] button:has-text("Connect"), mat-dialog-container button:has-text("Connect")').first();
      if (await scoped.count()) {
        await scoped.click({ timeout: 12_000 }).catch(async () => {
          await scoped.click({ timeout: 5_000, force: true }).catch(() => undefined);
        });
        console.log('[tag-assistant] clicked the modal Connect.');
        return true;
      }
      return clickConnect();
    };
    if (!(await clickModalConnect())) {
      await dumpTa('no-connect-button');
      console.log('[tag-assistant] no Connect-like button found - TA may auto-connect; waiting for the popup...');
    }
    let popup = await popupP;
    if (!popup) {
      // The debug link may have opened the site in an already-present tab rather than a fresh popup.
      const openUrls = ctx.pages().map((p) => p.url());
      console.log(`[tag-assistant] no debug popup within 30s. Open pages: ${JSON.stringify(openUrls)}`);
      popup = ctx.pages().find((p) => p !== ta && !/tagassistant\.google\.com|accounts\.google\.com/i.test(p.url())) ?? null;
    }
    if (!popup) return { pagesOk: false, perTag, pagesDriven, error: 'Tag Assistant did not open the debug window - reconnect and retry. (The log now lists the buttons the Tag Assistant page showed - send it and I will wire the right one.)' };
    console.log('[tag-assistant] debug window opened; waiting for the container to enter debug...');
    await popup.waitForLoadState('networkidle', { timeout: navTimeoutMs }).catch(() => undefined);
    await popup.waitForTimeout(Math.max(settleMs, 4000)); // debug handshake + container debug reload

    // DIAGNOSTIC: which containers actually BOOTED in the debug popup, and did the injected one load?
    // When TA shows "GTM-XXX not found - is it installed on this page?", this line distinguishes the
    // two very different failures: an INJECTION problem (the selected container never booted on the page
    // - CSP blocked the script, wrong timing, or the site serves GTM indirectly) vs a TA-ATTRIBUTION
    // problem (it booted but did not join this Tag Assistant session). Best-effort; never fails the run.
    const readBoot = async (): Promise<{ booted: string[]; injectedOk: boolean; gtmScripts: string[] }> =>
      popup.evaluate<{ booted: string[]; injectedOk: boolean; gtmScripts: string[] }>((wantId: string) => {
        const w = window as unknown as { google_tag_manager?: Record<string, unknown> };
        const booted = Object.keys(w.google_tag_manager || {}).filter((k) => /^(GTM-|G-|AW-|GT-)/.test(k));
        const gtmScripts = Array.prototype.slice
          .call(document.querySelectorAll('script[src*="gtm.js"]'))
          .map((s) => (s as HTMLScriptElement).src.replace(/([?&]gtm_auth=)[^&]+/i, '$1REDACTED'))
          .slice(0, 6);
        return { booted, injectedOk: !!(w.google_tag_manager && w.google_tag_manager[wantId]), gtmScripts };
      }, (injectContainerId || containerPublicId).toUpperCase());
    try {
      const want = (injectContainerId || containerPublicId).toUpperCase();
      let boot = await readBoot();
      console.log(`[tag-assistant] debug popup: containers booted = ${JSON.stringify(boot.booted)}`);
      // FIX: the context-level addInitScript does not reliably reach Tag Assistant's debug popup (proven
      // by the injected container being absent from the popup's gtm.js scripts). When the injected
      // container has NOT booted, inject it straight into the popup: an init script on THIS page (so every
      // page of the multi-page drive re-injects after navigation) PLUS an immediate evaluate for the page
      // already loaded. Then re-read so the log reflects the retry.
      if (injectContainerId && !boot.injectedOk) {
        console.log(`[tag-assistant] ${want} not present in the popup; injecting it directly into the debug window ...`);
        await popup.addInitScript(gtmInjector, injectArg).catch(() => undefined);
        await popup.evaluate(gtmInjector, injectArg).catch(() => undefined);
        await popup.waitForTimeout(Math.max(settleMs, 3500)); // let the injected gtm.js load + boot
        boot = await readBoot().catch(() => boot);
      }
      if (injectContainerId) {
        console.log(`[tag-assistant] injected ${want} booted on the page: ${boot.injectedOk ? 'YES (injection worked; if TA still says not found it is a debug-session/attribution issue)' : 'NO (the injected container never ran on the page)'}`);
        if (!boot.injectedOk) {
          console.log(`[tag-assistant] gtm.js scripts present on the page: ${JSON.stringify(boot.gtmScripts)}`);
          console.log(`[tag-assistant] -> ${want} still would not load. The site's Content-Security-Policy or a consent gate is blocking the injected gtm.js, or ${want} is simply not the container this site serves (live = ${JSON.stringify(boot.booted)}). Verify the installed container, or paste ${want}'s GTM Preview snippet / test it on a page where it is installed.`);
        }
      }
    } catch (e) {
      console.log(`[tag-assistant] boot diagnostic could not read the popup: ${(e as Error).message}`);
    }

    // Keep the injected (non-live) container present on EVERY page of the drive. The per-page init
    // script can lose the race with a fast `networkidle`, so after each navigation we poll for the
    // container and re-inject via evaluate until it boots (or a short budget elapses). Without this,
    // later drive pages flap to "not found" and their tags cannot fire. No-op when not injecting or
    // once it is already booted (the first poll returns true and the loop exits immediately).
    const ensureInjectedBooted = async (label: string): Promise<void> => {
      if (!injectContainerId) return;
      const want = injectContainerId.toUpperCase();
      const isBooted = (): Promise<boolean> =>
        popup
          .evaluate<boolean>((id: string) => !!((window as unknown as { google_tag_manager?: Record<string, unknown> }).google_tag_manager || {})[id], want)
          .catch(() => false);
      for (let i = 0; i < 8 && !(await isBooted()); i++) {
        await popup.evaluate(gtmInjector, injectArg).catch(() => undefined); // idempotent: guarded by google_tag_manager[id]
        await popup.waitForTimeout(450);
      }
      if (!(await isBooted())) console.log(`[tag-assistant] ${want} did not boot on ${label} in time; its tags cannot fire on this page.`);
    };

    // PROOF: screenshot the Tag Assistant panel DURING the drive. Right after each click / form submit, the
    // event we just caused is the NEWEST rail row, so clicking it shows exactly that event's Tags-Fired
    // panel. This beats a post-hoc rail search, which drowns in the scan's scroll_depth events and misses
    // the form_submission events that run LAST (highest seq). Each capture records the panel's fired-tag
    // text so the IPC attaches it to whichever tags it proves. `ta` is a SEPARATE page from the popup, so a
    // form submit reloading the popup never loses these. Best-effort — a screenshot never fails the run.
    const captures: Array<{ screenshot: string; fired: string; tag?: string }> = [];
    let snapTried = 0; // diagnostic: drive-events we tried to prove vs captures.length that switched to a real event view
    // Proof-quality counters, logged at the end of the run: how many proofs are this tag's OWN detail view,
    // how many of those show resolved VALUES, how many detail views we rejected (summary-context / stale),
    // and how many tags fell back to an event-panel shot. Makes a silent regression here visible.
    const proofStats = { detail: 0, values: 0, rejected: 0, eventOnly: 0 };
    let diagLogged = false; // structural readout is logged once per run, on the first rejected drill-down
    // Every tag name in this run. An event's Tags-Fired text is matched against these to learn WHICH tags
    // it fired, so each of them can be opened for its own detail proof - including on a real form submit,
    // which names no tag up front. Longest first, so a name that contains a shorter one is drilled first.
    const knownTagNames = [...new Set(tags.map((t) => t.name).filter((n): n is string => Boolean(n)))]
      .sort((a, b) => b.length - a.length);
    const firedBodyOf = (fired: string): string => fired.replace(/tags fired/i, '').trim();
    const hasFired = (fired: string): boolean => { const b = firedBodyOf(fired); return !!b && !/^none\b/i.test(b); };
    // Screenshot the TA panel for the EVENT we just drove. Tag the newest rail rows, then REAL-click each via
    // Playwright and read its panel — an in-page synthetic `.click()` does NOT switch Tag Assistant's Angular
    // panel (that made every proof come out as the aggregate Summary, the same image for every tag). Walk
    // newest → older and pick the row that proves `target`: for a click/custom_event, the one whose
    // Tags-Fired lists the tag we just drove (`target.names`); for a form submit, the newest form_submission
    // event that fired a tag (`target.event`). Fall back to the newest event that fired ANYTHING, so the
    // proof is still that event's own panel — never a blank "Tags Fired: None" and never the Summary.
    const snapNewestTa = async (target: { names?: string[]; event?: string } = {}): Promise<void> => {
      snapTried += 1;
      const step = snapTried; // this capture attempt's number, so interleaved lines stay readable
      const trace = (msg: string): void => console.log(`[ta-proof] #${step} ${msg}`);
      const want = (target.names ?? []).filter(Boolean);
      trace(`START target=${want.length ? `tag "${want[0]}"` : target.event ? `event /${target.event}/` : '(newest fired)'}`);
      // Clip the proof to the CONTENT column so the left rail (with "Summary") is never in the frame - this is
      // why full-page shots read like the Summary even when we are on the right event. Falls back to a
      // full-page shot when the panel rect can't be found, and logs which path it took.
      const snapPanel = async (): Promise<Buffer | null> => {
        const rect = await ta.evaluate<{ x: number; y: number; width: number; height: number } | null>(taContentRect).catch(() => null);
        if (rect && rect.width > 200 && rect.height > 150) {
          trace(`    clip proof to content panel ${Math.round(rect.width)}x${Math.round(rect.height)} @ ${Math.round(rect.x)},${Math.round(rect.y)}`);
          const clipped = await ta.screenshot({ type: 'jpeg', quality: 60, clip: rect, timeout: 5000 }).catch(() => null);
          if (clipped) return clipped;
        }
        trace('    content-panel rect not found - full-page proof (left rail may be in frame)');
        return ta.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 }).catch(() => null);
      };
      try {
        await ta.evaluate(dismissTaOverlays).catch(() => undefined);
        // Start from a NON-detail view. A tag detail left up by the previous capture hides the real rail
        // behind its own "Messages Where This Tag Fired" chips, so row tagging would pick a stale event
        // (that is why page 2 kept re-proving page 1's tags). Summary is the one rail item TA never
        // recycles, so it is the reliable way back.
        // "Am I on an EVENT panel?" is a POSITIVE signal: only an event view renders the API-Call block that
        // readTaPanel parses. Testing for the absence of a detail gave false alarms, because Angular can
        // keep a closed detail's markup in the DOM.
        const onEventPanel = async (): Promise<boolean> => {
          const p = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
          return Boolean(p.event);
        };
        const preView = await ta.evaluate<{ isDetail: boolean }>(readTaTagDetailState).catch(() => ({ isDetail: false }));
        if (preView.isDetail && !(await onEventPanel())) {
          trace('a tag detail was still open from the last capture - clicking Summary to get back to the rail');
          const sumSel = await ta.evaluate<string>(tagTaSummaryItem).catch(() => '');
          if (sumSel) await ta.click(sumSel, { timeout: 1200 }).catch(() => undefined); // REAL click: a synthetic one does not switch TA
          else await ta.evaluate(clickTaSummary).catch(() => undefined);
          await ta.waitForTimeout(300);
        }
        // Only the NEWEST few rail rows can be the event we just drove; scanning all 14 (each a real click
        // + render wait) made a non-firing tag cost seconds, and ~79 tags/page then looked stuck. The
        // post-hoc sweep is the backstop for anything not in the top rows.
        const rows = await ta.evaluate<Array<{ sel: string; num: number }>>(tagNewestTaRows, 6).catch(() => [] as Array<{ sel: string; num: number }>);
        if (!rows.length) { trace('STOP no rail rows found - Tag Assistant has no event list on screen.'); return; }
        trace(`rail rows (newest first): [${rows.map((r) => r.num).join(', ')}]`);
        const names = (target.names ?? []).filter(Boolean).map((n) => n.toLowerCase());
        const evRe = target.event ? new RegExp(target.event, 'i') : null;
        let best: { sel: string; fired: string } | null = null;
        let firstFired: { sel: string; fired: string } | null = null;
        for (const row of rows) {
          // Click, then CONFIRM the selection actually moved to this row. Two pages both produce a
          // "form_submission" event, so a click that failed to switch leaves a panel that still matches by
          // name, and the driver would prove the previous page's tags against this page's row. One retry,
          // re-marking the rows first in case Angular re-rendered the rail and dropped the attribute.
          let panel = { event: '', fired: '' };
          let sel = 0;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) await ta.evaluate(tagNewestTaRows, 6).catch(() => undefined);
            await ta.click(row.sel, { timeout: 1200 }).catch(() => undefined); // REAL click → Angular switches the panel
            await ta.waitForTimeout(300); // let Angular render the switched-to panel (API Call + Tags Fired)
            panel = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
            sel = await ta.evaluate<number>(readTaSelectedRow).catch(() => 0);
            if (!sel || sel === row.num) break;
          }
          trace(`  row #${row.num} -> event="${panel.event || '(none: panel did not switch)'}" firedTags=${hasFired(panel.fired) ? 'yes' : 'no'} selectedRow=${sel || 'unknown'}`);
          if (sel && sel !== row.num) { trace(`  row #${row.num}: the panel is still showing row #${sel} - not trusting this read`); continue; }
          // REQUIRE a real EVENT view: the Summary panel also has a "Tags Fired" list (every fired tag) but NO
          // API-Call event, so panel.event is empty there. Without this check a click that failed to switch the
          // panel left us on the Summary, whose all-tags list matched EVERY target → every proof was the Summary.
          if (!panel.event || !hasFired(panel.fired)) continue;
          if (!firstFired) firstFired = { sel: row.sel, fired: panel.fired };
          const firedLc = panel.fired.toLowerCase();
          const nameHit = names.length > 0 && names.some((n) => firedLc.includes(n));
          const evHit = !!evRe && evRe.test(panel.event);
          if (nameHit || evHit) { best = { sel: row.sel, fired: panel.fired }; break; } // this event proves the target
        }
        const chosen = best ?? firstFired;
        if (!chosen) { trace('STOP none of those rows showed an event that fired a tag - nothing to prove here.'); return; } // never screenshot a blank panel
        trace(`chosen event via ${best ? 'MATCH (its Tags-Fired names the target)' : 'FALLBACK (newest event that fired anything)'}`);
        if (!best) { await ta.click(chosen.sel, { timeout: 1200 }).catch(() => undefined); await ta.waitForTimeout(220); } // fallback row wasn't the last clicked - re-select it
        // Drill into EVERY tag this event fired, so each one gets ITS OWN detail view (properties + firing
        // triggers + hits sent) like the operator opening that tag in Tag Assistant - not the event's
        // tags-fired summary. Driving one trigger commonly fires several tags (a GA4 + Meta pair), and a
        // REAL FORM SUBMIT names no tag at all (target.names is empty), which is why form tags used to get
        // only the event panel. Names come from the event's own Tags-Fired text matched against the
        // container's tag names, so we can never drill a tag this event did not fire.
        const wanted = best ? (target.names ?? []).filter(Boolean) : [];
        const derived = knownTagNames.filter((n) => chosen.fired.includes(n));
        const already = new Set(captures.map((c) => c.tag).filter(Boolean) as string[]);
        // Cap per event so a busy event cannot stretch the run; the rest keep the event-panel proof.
        const toDrill = [...new Set([...wanted, ...derived])].filter((n) => !already.has(n)).slice(0, 8);
        const skipped = [...new Set([...wanted, ...derived])].filter((n) => already.has(n));
        trace(`this event fired ${derived.length} known tag(s); to drill now: ${toDrill.length ? toDrill.map((n) => `"${n}"`).join(', ') : '(none)'}${skipped.length ? ` | already proven earlier: ${skipped.length}` : ''}`);
        // Start from the EVENT panel: a detail view left up by the previous capture hides this event's
        // Tags-Fired list, so the first card lookup would search the wrong page (and a detail opened from
        // there carries no Values toggle). Bounded, and harmless when we are already on the event.
        for (let back = 0; back < 2; back += 1) {
          if (await onEventPanel()) break; // positive check, same reason as backToEvent
          await ta.click(chosen.sel, { timeout: 1200 }).catch(() => undefined);
          await ta.waitForTimeout(180);
        }
        // Return to THIS event's panel between tags. The breadcrumb ("22 form_submission >") is rendered by
        // the detail we are on and always points at the right event; the rail row's data-ta-snap attribute
        // can be dropped when Angular renders the detail, and that stale selector is why only the FIRST tag
        // of each event used to get a proof. Crumb first, rail row as the fallback, then verify.
        const backToEvent = async (): Promise<boolean> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const crumbSel = attempt === 0 ? await ta.evaluate<string>(tagTaCrumbLink).catch(() => '') : '';
            await ta.click(crumbSel || chosen.sel, { timeout: 1200 }).catch(() => undefined);
            await ta.waitForTimeout(200);
            // Confirm by the API-Call block, not by the absence of a detail: the old check reported a
            // failure on page 1 even though the return had worked and the next tag drilled fine.
            if (await onEventPanel()) return true;
          }
          return false;
        };
        let drilled = 0;
        for (const name of toDrill) {
          trace(`  DRILL "${name}"`);
          const tagSel = await ta.evaluate<string>(openFiredTagInPage, name).catch(() => '');
          if (!tagSel) { trace('    x its card was not found in this event\'s Tags-Fired list - no detail proof.'); continue; }
          await ta.click(tagSel, { timeout: 1200 }).catch(() => undefined); // REAL click → Angular opens Tag Details
          await ta.waitForTimeout(400); // let the Tag Details view render
          const blank = { isDetail: false, eventContext: false, valuesActive: false, nameOk: false };
          let st = await ta.evaluate<typeof blank>(readTaTagDetailState, name).catch(() => blank);
          const show = (s: typeof blank): string => `detail=${s.isDetail ? 'y' : 'n'} eventContext=${s.eventContext ? 'y' : 'n'} nameMatches=${s.nameOk ? 'y' : 'n'} values=${s.valuesActive ? 'ON' : 'off'}`;
          trace(`    opened: ${show(st)}`);
          // RECOVER a Summary-context detail: clicking a tag card often lands on the tag's GLOBAL page
          // (breadcrumb "Summary >", names only, no toggle). Its "Messages Where This Tag Fired" chip jumps
          // to the per-message EVENT-context view, which is the one that carries the Values toggle. Same
          // tag either way, so identity is preserved; re-checked below.
          if (st.isDetail && !st.eventContext) {
            const msgSel = await ta.evaluate<string>(tagTaMessageChip).catch(() => '');
            if (!msgSel) {
              trace('    landed on the tag\'s global page and found no "Messages Where This Tag Fired" chip to jump from');
            } else {
              await ta.click(msgSel, { timeout: 1200 }).catch(() => undefined);
              await ta.waitForTimeout(400);
              st = await ta.evaluate<typeof blank>(readTaTagDetailState, name).catch(() => st);
              trace(`    recovered via the message chip: ${show(st)}`);
            }
          }
          // Accept ONLY an event-context detail FOR THE TAG WE ASKED FOR: one opened from the SUMMARY has no
          // "Display Variables as" toggle so it can only ever show {{variable}} names, and a detail whose own
          // title is a different tag must never be stored under this name.
          if (st.isDetail && st.eventContext && st.nameOk) {
            // Flip the toggle to VALUES so the proof shows the RESOLVED values (click_url, page_url, ...).
            // Verify it actually took (a click can miss / land before the panel settles) and retry once.
            for (let attempt = 0; attempt < 2 && !st.valuesActive; attempt += 1) {
              const valSel = await ta.evaluate<string>(tagTaValuesRadio).catch(() => '');
              if (!valSel) { trace('    the Values radio was not locatable on this detail'); break; }
              await ta.click(valSel, { timeout: 1200 }).catch(() => undefined);
              await ta.waitForTimeout(300);
              st = await ta.evaluate<typeof blank>(readTaTagDetailState, name).catch(() => st);
              trace(`    clicked Values (try ${attempt + 1}): values=${st.valuesActive ? 'ON' : 'still off'}`);
            }
            const shot = await snapPanel();
            if (!shot) {
              trace('    x the screenshot failed - no proof stored for this tag');
            } else {
              captures.push({ screenshot: `data:image/jpeg;base64,${shot.toString('base64')}`, fired: chosen.fired, tag: name });
              drilled += 1;
              proofStats.detail += 1;
              if (st.valuesActive) proofStats.values += 1;
              trace(`    OK captured this tag's own detail${st.valuesActive ? ' with resolved VALUES' : ' but showing variable NAMES (Values did not engage)'}`);
            }
          } else {
            proofStats.rejected += 1;
            // One structural readout per run, so a persistent failure reports Tag Assistant's real DOM
            // instead of needing another round of guessing.
            if (!diagLogged) {
              diagLogged = true;
              const diag = await ta.evaluate<string>(readTaDiagnostics).catch(() => 'unavailable');
              console.log(`[ta-proof] view diagnostics at first reject: ${diag}`);
            }
            const why = !st.isDetail ? 'the detail view did not open'
              : !st.eventContext ? 'it opened from the Summary (no Values toggle, names only)'
              : 'the detail shown was a DIFFERENT tag';
            trace(`    x REJECTED - ${why}. No image is stored for this tag rather than a wrong one.`);
          }
          // Back to the event view: the next tag's card is only findable there, and leaving a detail up
          // would confuse the next capture's rail tagging ("Messages Where This Tag Fired" rows look like
          // rail rows).
          if (!(await backToEvent())) trace('    ! could not get back to the event panel - the next tag in this event may be unreachable');
        }
        // No tag detail could be opened for this event - keep ONE event-panel proof so the tags it fired
        // still have some evidence (matched by the Tags-Fired text, never mistaken for a tag's own detail).
        // GUARD: only when the event panel is really back on screen. If a rejected detail is still up (both
        // restore clicks missed), shooting now would store THAT tag's detail as an event-level capture, and
        // the Tags-Fired fallback would then hand one tag's page to every other tag in the event - exactly
        // the "wrong tag's screenshot" the operator reported. No proof beats a misleading proof.
        if (drilled === 0) {
          const view = await ta.evaluate<{ isDetail: boolean }>(readTaTagDetailState).catch(() => ({ isDetail: false }));
          if (view.isDetail) {
            trace('END no tag detail captured, and a detail is still on screen - skipping the event-level proof rather than storing another tag\'s picture.');
          } else {
            proofStats.eventOnly += 1;
            const buf = await snapPanel();
            if (!buf) { trace('END the event-panel screenshot failed - no proof stored.'); return; }
            captures.push({ screenshot: `data:image/jpeg;base64,${buf.toString('base64')}`, fired: chosen.fired });
            trace('END no tag detail captured - stored one event-panel proof for the tags this event fired.');
          }
        } else {
          trace(`END captured ${drilled} tag detail proof(s) from this event.`);
        }
      } catch (e) {
        trace(`END aborted by an error: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
      }
    };

    // Drive each page ONCE in the SAME popup (sequential; the debug session rides window.opener): its
    // click/custom/pageview tags first (guards block stray nav), THEN its reviewed form(s) submitted FOR
    // REAL, so a page that has BOTH is opened a single time, not once per phase.
    const pageKeyOf = (p: string | undefined): string =>
      p && /^https?:/i.test(p) ? p : p ? new URL(p, url).href : url;
    const byPage = new Map<string, VerifyDriverTag[]>();
    for (const t of tags) {
      const page = pageKeyOf(t.page);
      const arr = byPage.get(page) ?? [];
      arr.push(t);
      byPage.set(page, arr);
    }
    // Group the reviewed forms by the SAME page key, so each page's form(s) submit right after its clicks.
    const allForms = opts.forms ?? [];
    const formsByPage = new Map<string, TaFormSubmit[]>();
    for (const f of allForms) {
      const key = pageKeyOf(f.page);
      const arr = formsByPage.get(key) ?? [];
      arr.push(f);
      formsByPage.set(key, arr);
    }
    // Union of pages to visit: every page that has tags (in order), then any form-only page not listed yet.
    const pageKeys = [...byPage.keys()];
    for (const k of formsByPage.keys()) if (!byPage.has(k)) pageKeys.push(k);
    // Engine marker: proves at a glance WHICH proof engine is running. If this line is missing from a run's
    // log, the app is on an older build (the main process does not hot-reload - it needs a full restart),
    // so any "wrong screenshot" seen in that run is stale output, not a live defect.
    console.log('[ta-proof] proof engine: per-tag Tag Details, Values mode, identity-checked.');
    console.log(`[tag-assistant] driving ${tags.length} tag trigger(s) + ${allForms.length} form(s) across ${pageKeys.length} page(s)...`);
    let done = 0;
    let formDone = 0;
    for (const pageUrl of pageKeys) {
      const groupTags = byPage.get(pageUrl) ?? [];
      const pageForms = formsByPage.get(pageUrl) ?? [];
      if (opts.shouldStop?.()) { console.log('[tag-assistant] Stop pressed — ending the drive early.'); break; } // cancel between pages
      done += 1;
      console.log(`[tag-assistant]   page ${done}/${pageKeys.length}: ${pageUrl} (${groupTags.length} trigger(s), ${pageForms.length} form(s))`);
      try { opts.onPageProgress?.(pageUrl, done, pageKeys.length); } catch { /* progress is a nicety */ }
      if (!(await requestAllowed(pageUrl))) continue;
      // The first group is often the connect URL, already loaded — normally skip re-navigating it. BUT in
      // PREVIEW mode the connect URL loaded WITHOUT the preview params (no preview cookie set, published
      // build served), so we MUST (re)load it via withPreview so the container serves its debug preview
      // build under the debug session. So: skip only when NOT in preview mode and it's already the page.
      const alreadyOnPage = done === 1 && popup.url().split('?')[0].replace(/\/$/, '') === pageUrl.split('?')[0].replace(/\/$/, '');
      if (previewParams || !alreadyOnPage) {
        try { await popup.goto(withPreview(pageUrl), { waitUntil: 'networkidle', timeout: navTimeoutMs }); } catch {
          for (const t of groupTags) perTag.push({ tagId: t.id, kind: 'navigate', targetFound: false, performed: false, note: `could not load ${pageUrl}`, hits: [] });
          continue;
        }
        await popup.waitForTimeout(Math.max(settleMs, 2000)); // container + debug re-attach on the new page
      }
      // Re-establish the injected container on this page before driving its triggers (see above).
      await ensureInjectedBooted(pageUrl);
      pagesDriven.push(pageUrl);
      await popup.evaluate(installGuardsInPage).catch(() => undefined);
      await popup.evaluate(grantConsentInPage).catch(() => undefined);
      await popup.evaluate(hideCookieOverlaysInPage).catch(() => undefined);

      const pushedDlKeys = new Set<string>();
      let driven = 0;
      for (const tag of groupTags) {
        driven += 1;
        // Progress heartbeat so a long page (many triggers, each with a proof-capture pass) reads as
        // moving, not stuck.
        if (driven === 1 || driven % 15 === 0 || driven === groupTags.length) {
          console.log(`[tag-assistant]     driving trigger ${driven}/${groupTags.length} on this page...`);
        }
        const kind = tag.trigger.kind;
        if (kind === 'pageview') {
          perTag.push({ tagId: tag.id, kind: 'navigate', targetFound: true, performed: true, hits: [] });
          continue;
        }
        if (kind === 'custom_event') {
          const evName = tag.trigger.eventName ?? '';
          if (!evName) { perTag.push({ tagId: tag.id, kind: 'custom_event', targetFound: false, performed: false, note: 'the trigger has no dataLayer event name', hits: [] }); continue; }
          // FORM tags (form_submission etc.) are verified ONLY by the REAL form submit below — NEVER a
          // synthetic push. A synthetic push fires the tag on OUR event with the tag's OWN declared
          // form_name, which can contradict the real submit AND (now that form tags are credited from the
          // monitor stream) would be a false "fired" on a Skip run. So when no form was really submitted for
          // it, a form tag stays untested (inconclusive), not falsely fired.
          if (isFormEventName(evName)) {
            perTag.push({ tagId: tag.id, kind: 'custom_event', targetFound: true, performed: false, note: 'verified by the real form submit', hits: [] });
            continue;
          }
          const data = tag.trigger.customEventData ?? {};
          const payload = buildCustomEventPayload(evName, data, pushedDlKeys);
          Object.keys(data).forEach((k) => pushedDlKeys.add(k));
          try { await popup.evaluate(pushDataLayerInPage, payload); } catch { /* reported by stream absence */ }
          await popup.waitForTimeout(Math.max(settleMs, 700));
          await snapNewestTa({ names: tag.name ? [tag.name] : [] }); // proof of the event we just pushed — targeted to THIS tag
          perTag.push({ tagId: tag.id, kind: 'custom_event', targetFound: true, performed: true, conditionSupplied: Object.keys(data).length > 0 || !/(^|_)forms?(_|$)/i.test(evName), hits: [] });
          continue;
        }
        // Click / form-submit triggers: locate + drive the element (guards block real nav/submit).
        let outcome: DriveOutcome;
        try {
          outcome = await popup.evaluate<DriveOutcome>(driveInPage, specFor(tag.trigger));
        } catch (e) {
          outcome = { targetFound: false, performed: false, note: (e instanceof Error ? e.message : String(e)).slice(0, 150) };
        }
        if (outcome.performed) { await popup.waitForTimeout(Math.max(settleMs, 700)); await snapNewestTa({ names: tag.name ? [tag.name] : [] }); } // proof of the click we just drove — targeted to THIS tag
        perTag.push({
          tagId: tag.id,
          kind: kind === 'form_submit' ? 'submit' : 'click',
          targetFound: outcome.targetFound,
          performed: outcome.performed,
          ...(outcome.note ? { note: outcome.note } : {}),
          hits: [],
        });
      }

      // REAL FORM SUBMITS for THIS page, right after its clicks and on the SAME already-open page (no
      // second load). The route handler only aborts analytics collectors, so the form's own POST goes
      // through (a real lead) and the site fires its genuine form_submission, which Tag Assistant captures,
      // so the form tag's firing is proven by the REAL submit, not a synthetic push. allowFormSubmitInPage
      // lifts the submit-guard the click-drive installed; each submit navigates the page, so a 2nd form on
      // the same page reloads first.
      for (let fi = 0; fi < pageForms.length; fi += 1) {
        if (opts.shouldStop?.()) { console.log('[tag-assistant] Stop pressed - skipping remaining form submits.'); break; } // cancel between form submits
        const form = pageForms[fi];
        formDone += 1;
        console.log(`[tag-assistant] real form submit ${formDone}/${allForms.length}: ${pageUrl}`);
        try { opts.onFormProgress?.(pageUrl, formDone, allForms.length); } catch { /* progress is a nicety */ }
        if (fi > 0) {
          // A later form on the SAME page needs a fresh load (the prior submit navigated the page away).
          try { await popup.goto(withPreview(pageUrl), { waitUntil: 'networkidle', timeout: navTimeoutMs }); } catch { continue; }
          await popup.waitForTimeout(Math.max(settleMs, 1500));
          await ensureInjectedBooted(pageUrl);
          await popup.evaluate(grantConsentInPage).catch(() => undefined);
          await popup.evaluate(hideCookieOverlaysInPage).catch(() => undefined);
        }
        await popup.evaluate(allowFormSubmitInPage).catch(() => undefined); // lift the submit-guard for the real POST
        try {
          const outcome = await popup.evaluate<{ filled: number; submitted: boolean; note?: string }>(
            fillAndSubmitInPage,
            { formId: form.formId, formClasses: form.formClasses, method: form.method, fields: form.fields },
          );
          console.log(`[tag-assistant]   filled ${outcome.filled} field(s), submitted=${outcome.submitted}${outcome.note ? ` (${outcome.note})` : ''}`);
        } catch (e) {
          console.log(`[tag-assistant]   form submit failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
        }
        // Let the (often AJAX) submit resolve + the success-state form_submission push + the tag fire.
        await popup.waitForTimeout(Math.max(settleMs, 3000));
        // Poll briefly for the newest rail event to become form_submission (frames arrive async after the
        // reload), then snapshot that event's Tags-Fired panel (proof for THIS form's tags).
        for (let poll = 0; poll < 6; poll += 1) {
          const ev = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
          if (/form_submission|form_submit/i.test(ev.event)) break;
          await ta.waitForTimeout(400);
        }
        await snapNewestTa({ event: 'form_submission|form_submit' }); // proof of the real form submit we just did
      }
    }

    await popup.waitForTimeout(Math.max(settleMs, 1500)); // let the last TAG_STATUS frames arrive

    // POST-HOC per-event proof sweep. The rail is now STABLE (nothing streaming), so a real Playwright click
    // reliably switches TA's Angular panel and the row tag isn't wiped by a mid-stream re-render — the race
    // that could leave the during-drive snaps stuck on the Summary. Walk the newest ~40 rail rows once and
    // screenshot each REAL event view that fired a tag (panel.event non-empty), deduped against what we
    // already captured, so every fired tag can be matched to ITS OWN event panel rather than the Summary.
    try {
      await ta.evaluate(dismissTaOverlays).catch(() => undefined);
      const rows = await ta.evaluate<Array<{ sel: string; num: number }>>(tagNewestTaRows, 40).catch(() => [] as Array<{ sel: string; num: number }>);
      // Seed the dedup from EVENT-LEVEL captures only. A drill-down capture is a picture of ONE tag's detail
      // page, yet it still records the whole event's Tags-Fired text; seeding from it would make the sweep
      // skip that event and leave every OTHER tag in it with no event-level fallback proof at all.
      const seen = new Set<string>(captures.filter((c) => !c.tag).map((c) => firedBodyOf(c.fired).slice(0, 80)));
      let swept = 0;
      for (const row of rows) {
        if (captures.length >= 28) break; // bound the payload / time
        await ta.click(row.sel, { timeout: 2500 }).catch(() => undefined);
        await ta.waitForTimeout(300);
        const panel = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
        if (!panel.event || !hasFired(panel.fired)) continue; // real event view that fired a tag only
        const key = firedBodyOf(panel.fired).slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        const buf = await ta.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
        captures.push({ screenshot: `data:image/jpeg;base64,${buf.toString('base64')}`, fired: panel.fired });
        swept += 1;
      }
      console.log(`[tag-assistant] post-hoc sweep added ${swept} per-event proof(s) from ${rows.length} stable rail row(s).`);
      console.log(`[ta-proof] tag-detail proofs: ${proofStats.detail} (${proofStats.values} showing resolved VALUES) - event-panel only: ${proofStats.eventOnly} - detail views rejected: ${proofStats.rejected}`);
    } catch { /* proof is best-effort */ }

    // Harvest + parse the stream from the TA page.
    const frames = await ta.evaluate<string[]>(() => (window as unknown as { __taFrames?: string[] }).__taFrames ?? []).catch(() => [] as string[]);
    const capture = parseTaFrames(frames);
    const { containerDebugProblem, eventsForContainer, containersSeenOnPage } = await import('./ta-stream');
    // AUTHORITATIVE on-page list: TA's own "Google tags found" chips (read from the DOM), unioned with
    // the debug-stream containers. Includes containers PRESENT but not debugging — which the stream can't
    // show — so the diagnostic knows the selected container is installed even when it never streamed data.
    const chipIds = await ta.evaluate<string[]>(readTaContainerChips).catch(() => [] as string[]);
    const onPage = Array.from(new Set([...capture.containers.map((x) => x.id.toUpperCase()), ...chipIds]));
    const containersSeen = Array.from(new Set([...containersSeenOnPage(capture), ...chipIds.filter((id) => /^GTM-/i.test(id))]));
    const problem = containerDebugProblem(capture, containerPublicId, onPage);
    const evs = eventsForContainer(capture, containerPublicId);
    const firedCount = evs.reduce((n, e) => n + e.tags.filter((t) => t.status === 'fired').length, 0);
    console.log(`[tag-assistant] captured ${frames.length} debug frame(s) -> ${evs.length} event(s) for ${containerPublicId}, ${firedCount} tag-fire(s)${problem ? ` -- ${problem}` : ''}`);

    // STEP 4 — confirm the injection took: if we injected the selected container but Tag Assistant STILL
    // does not see it on the page, STOP with retry guidance rather than verify against nothing. A guard
    // (CSP / consent) or an indirect serve can block the injected loader. No verdicts are produced.
    if (injectContainerId) {
      const seen = onPage.includes(injectContainerId);
      console.log(`[preflight] step 4: after injection, Tag Assistant ${seen ? 'SEES' : 'does NOT see'} ${injectContainerId} on the page.`);
      if (!seen) {
        return {
          pagesOk: false, perTag, pagesDriven, ...(containersSeen.length ? { containersSeen } : {}),
          error: `Injected ${containerPublicId} into the verification session, but Tag Assistant still does not see it on ${url}. The page may block it (a Content-Security-Policy or a consent gate) or serve GTM indirectly. Paste this container's GTM Preview snippet in the box above and run again.`,
        };
      }
    }
    // Results came from a container we injected (it was not live on the page) — flag it so the UI is
    // honest that this proves the tags fire WHEN the container is present, not that it is deployed live.
    const injectedContainer = injectContainerId ? true : undefined;

    // Proof screenshots were captured DURING the drive (snapNewestTa), each recording the panel's fired-tag
    // text so the IPC attaches it to whichever tags it proves. Fallback = the TA SUMMARY view (the aggregate
    // Tags-Fired list) — a meaningful "everything that fired" panel, NEVER a random empty event — so a fired
    // tag whose per-event snap missed still shows real proof, not a blank "Tags Fired: None".
    let summaryShot: string | undefined;
    try {
      await ta.evaluate(dismissTaOverlays).catch(() => undefined);
      await ta.evaluate(clickTaSummary).catch(() => undefined);
      await ta.waitForTimeout(400);
      const buf = await ta.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
      summaryShot = `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch { /* best-effort */ }
    console.log(`[tag-assistant] captured ${captures.length}/${snapTried} in-drive per-event proof screenshot(s)${summaryShot ? ' + a Summary fallback' : ''}${snapTried > 0 && captures.length < snapTried / 2 ? ' -- LOW switch ratio: the rail clicks are not switching TA to the per-event panel, so those tags fall back to the Summary. If this persists, the TA rail-row selector needs revisiting.' : ''}`);

    console.log('[tag-assistant] leaving the Tag Assistant window OPEN so you can inspect it — it closes automatically when you run verify again or quit the app.');
    keepWindowOpen = true; // reached a real result — keep the TA panel up for the user to review
    return { pagesOk: true, perTag, pagesDriven, capture, ...(containersSeen.length ? { containersSeen } : {}), ...(injectedContainer ? { injectedContainer } : {}), ...(captures.length ? { captures } : {}), ...(summaryShot ? { summaryShot } : {}), ...(problem ? { debugProblem: problem } : {}) };
  } catch (e) {
    return { pagesOk: false, perTag, pagesDriven, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    // Keep the window open on success (user inspects it; closed at the next run's start); close on error.
    if (keepWindowOpen) openTaContext = ctx;
    else await ctx.close().catch(() => undefined);
  }
  });
}
