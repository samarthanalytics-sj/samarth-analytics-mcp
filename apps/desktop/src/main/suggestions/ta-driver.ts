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

import { requestAllowed } from './ssrf';
import { classifyCollector } from '../../shared/runtime-capture';
import { PlaywrightUnavailableError } from './playwright-driver';
import {
  installGuardsInPage, grantConsentInPage, hideCookieOverlaysInPage, pushDataLayerInPage,
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
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<void>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  locator(sel: string): { first(): { count(): Promise<number>; click(o?: Record<string, unknown>): Promise<void>; fill(v: string, o?: Record<string, unknown>): Promise<void> } };
  screenshot(opts?: { type?: 'jpeg' | 'png'; quality?: number; fullPage?: boolean; timeout?: number }): Promise<Buffer>;
  isClosed(): boolean;
  url(): string;
}
interface PwContext {
  addInitScript(fn: unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: { request(): { url(): string }; continue(overrides?: { url?: string }): Promise<void>; abort(): Promise<void> }) => unknown): Promise<void>;
  waitForEvent(event: 'page', opts?: { timeout?: number }): Promise<PwPage>;
  close(): Promise<void>;
  pages(): PwPage[];
  cookies(urls?: string | string[]): Promise<Array<{ name: string }>>;
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
  error?: string;
  perTag: PerTagCapture[];
  pagesDriven: string[];
  /** The parsed authoritative debug capture (per-event tags fired + API-Call pushes). */
  capture?: TaCapture;
  /** Proof screenshots captured DURING the drive: each is the Tag Assistant panel right after an
   *  interaction, with `fired` = the "Tags Fired" text shown, so the IPC attaches it to whichever tags it
   *  proves. Best-effort. */
  captures?: Array<{ screenshot: string; fired: string }>;
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
    const all = Array.prototype.slice.call(document.querySelectorAll('a,li,button,[role="button"],div,span')) as HTMLElement[];
    for (const el of all) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = /^(\d+)\s*(\D.*)$/.exec(t);
      if (!m || t.length > 44) continue;
      const num = parseInt(m[1], 10);
      const depth = el.querySelectorAll('*').length;
      if (!byNum[num] || depth < byNum[num].depth) byNum[num] = { el, depth };
    }
  } catch { /* best-effort */ }
  const nums = Object.keys(byNum).map(Number).sort((a, b) => b - a).slice(0, limit ?? 14); // newest first
  return nums.map((num, i) => { byNum[num].el.setAttribute('data-ta-snap', String(i)); return { sel: `[data-ta-snap="${i}"]`, num }; });
}

/** In the TA page: read the panel now showing — the raw dataLayer event from the API Call block + the
 *  "Tags Fired" text region (to confirm the target tag is listed and the event isn't empty). */
function readTaPanel(): { event: string; fired: string } {
  try {
    const all = (document.body.textContent || '').replace(/\s+/g, ' ');
    const m = /dataLayer\.push\(\{\s*event:\s*["']([^"']+)["']/.exec(all);
    const fi = all.indexOf('Tags Fired');
    const nfi = fi >= 0 ? all.indexOf('Tags Not Fired', fi) : -1;
    const fired = fi >= 0 ? all.slice(fi, nfi > fi ? nfi : fi + 1500) : '';
    return { event: m ? m[1] : '', fired };
  } catch { return { event: '', fired: '' }; }
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
  opts: { settleMs?: number; navTimeoutMs?: number; loginHint?: string; signInTimeoutMs?: number; previewSnippet?: string; forms?: TaFormSubmit[]; onSignInPrompt?: () => void; onPageProgress?: (page: string, done: number, total: number) => void; onFormProgress?: (page: string, done: number, total: number) => void; shouldStop?: () => boolean } = {},
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
  // Serialize with any other profile access: the exclusive ta-profile lock means one at a time.
  return serializeProfile(async () => {
  // Close a window left open from a PREVIOUS run first — it still holds the profile's exclusive lock.
  // If we did close one, wait out the brief Windows lock-release lag before relaunching the same profile.
  if (await closeOpenTaWindow()) await new Promise((r) => setTimeout(r, 1200));
  // HEADED (visible): the user WATCHES Tag Assistant sign in (once), connect, and show tags firing — that
  // real Tag Assistant tab IS the "show it in detail" view — and the one-time sign-in happens in context.
  const ctx = await launchProfile(profileDir, false);
  let keepWindowOpen = false; // on success, leave the TA window open for the user to inspect
  try {
    await ctx.addInitScript(captureFramesInit);
    // Abort analytics collectors so driving tags never delivers a real hit (the TA stream, not beacons,
    // is the verdict source). In PREVIEW mode, rewrite the container's gtm.js request to carry the preview
    // creds (page-URL params are ignored by a normal loader, so the request itself must be rewritten) so
    // Google serves the debug-instrumented preview build. Everything else flows normally.
    await ctx.route('**/*', (route) => {
      const reqUrl = route.request().url();
      if (classifyCollector(reqUrl)) { void route.abort(); return; }
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

    // ONE-TIME sign-in IN THIS SAME VISIBLE WINDOW, then SAVED FOREVER for this account. This is the
    // deliberate trade (chosen over "use real Chrome, close it every time"): sign in once here, and the
    // session persists in this account's profile so verify never asks again — and the user never has to
    // close their normal Chrome. login_hint pre-fills the account email on the sign-in form.
    if (await hasGoogleSession(ctx)) {
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

    // Connect: Add domain -> URL -> Connect -> the debugged popup.
    console.log(`[tag-assistant] connecting to ${url} ${previewParams ? '(GTM PREVIEW mode - your container will enter debug)' : '(connect mode - Google tags only; paste your GTM Preview snippet to debug the GTM container)'} ...`);
    await ta.goto(TA_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await ta.waitForTimeout(2500);
    const addBtn = ta.locator('button:has-text("Add domain")').first();
    if (await addBtn.count()) { await addBtn.click({ timeout: 8_000 }); await ta.waitForTimeout(1200); }
    await ta.locator('input').first().fill(url, { timeout: 8_000 });
    const popupP = ctx.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
    await ta.locator('button:has-text("Connect")').first().click({ timeout: 8_000 });
    const popup = await popupP;
    if (!popup) return { pagesOk: false, perTag, pagesDriven, error: 'Tag Assistant did not open the debug window - reconnect and retry.' };
    console.log('[tag-assistant] debug window opened; waiting for the container to enter debug...');
    await popup.waitForLoadState('networkidle', { timeout: navTimeoutMs }).catch(() => undefined);
    await popup.waitForTimeout(Math.max(settleMs, 4000)); // debug handshake + container debug reload

    // PROOF: screenshot the Tag Assistant panel DURING the drive. Right after each click / form submit, the
    // event we just caused is the NEWEST rail row, so clicking it shows exactly that event's Tags-Fired
    // panel. This beats a post-hoc rail search, which drowns in the scan's scroll_depth events and misses
    // the form_submission events that run LAST (highest seq). Each capture records the panel's fired-tag
    // text so the IPC attaches it to whichever tags it proves. `ta` is a SEPARATE page from the popup, so a
    // form submit reloading the popup never loses these. Best-effort — a screenshot never fails the run.
    const captures: Array<{ screenshot: string; fired: string }> = [];
    let snapTried = 0; // diagnostic: drive-events we tried to prove vs captures.length that switched to a real event view
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
      try {
        await ta.evaluate(dismissTaOverlays).catch(() => undefined);
        const rows = await ta.evaluate<Array<{ sel: string; num: number }>>(tagNewestTaRows).catch(() => [] as Array<{ sel: string; num: number }>);
        if (!rows.length) return;
        const names = (target.names ?? []).filter(Boolean).map((n) => n.toLowerCase());
        const evRe = target.event ? new RegExp(target.event, 'i') : null;
        let best: { sel: string; fired: string } | null = null;
        let firstFired: { sel: string; fired: string } | null = null;
        for (const row of rows) {
          await ta.click(row.sel, { timeout: 2500 }).catch(() => undefined); // REAL click → Angular switches the panel
          await ta.waitForTimeout(350); // let Angular render the switched-to event panel (API Call + Tags Fired)
          const panel = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
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
        if (!chosen) return; // nothing fired to prove — never screenshot a blank panel
        if (!best) { await ta.click(chosen.sel, { timeout: 2500 }).catch(() => undefined); await ta.waitForTimeout(220); } // fallback row wasn't the last clicked — re-select it
        const buf = await ta.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
        captures.push({ screenshot: `data:image/jpeg;base64,${buf.toString('base64')}`, fired: chosen.fired });
      } catch { /* proof is best-effort */ }
    };

    // Drive each page's tags IN THE SAME POPUP (sequential — the debug session rides window.opener).
    const byPage = new Map<string, VerifyDriverTag[]>();
    for (const t of tags) {
      const page = t.page && /^https?:/i.test(t.page) ? t.page : t.page ? new URL(t.page, url).href : url;
      const arr = byPage.get(page) ?? [];
      arr.push(t);
      byPage.set(page, arr);
    }
    const groups = [...byPage.entries()];
    console.log(`[tag-assistant] driving ${tags.length} tag trigger(s) across ${groups.length} page(s)...`);
    let done = 0;
    for (const [pageUrl, groupTags] of groups) {
      if (opts.shouldStop?.()) { console.log('[tag-assistant] Stop pressed — ending the drive early.'); break; } // cancel between pages
      done += 1;
      console.log(`[tag-assistant]   page ${done}/${groups.length}: ${pageUrl} (${groupTags.length} trigger(s))`);
      try { opts.onPageProgress?.(pageUrl, done, groups.length); } catch { /* progress is a nicety */ }
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
      pagesDriven.push(pageUrl);
      await popup.evaluate(installGuardsInPage).catch(() => undefined);
      await popup.evaluate(grantConsentInPage).catch(() => undefined);
      await popup.evaluate(hideCookieOverlaysInPage).catch(() => undefined);

      const pushedDlKeys = new Set<string>();
      for (const tag of groupTags) {
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
    }

    // REAL FORM SUBMITS: for each reviewed form, load its page in the SAME debugged popup, fill the
    // reviewed values, and submit FOR REAL. The route handler only aborts analytics collectors, so the
    // form's own POST goes through (a real lead) and the site fires its genuine form_submission event —
    // which Tag Assistant captures, so the form tag's firing is proven by the REAL submit, not a synthetic
    // push. Sequential (each submit navigates the page). Screenshots of the TA panel land in Phase 3.
    const forms = opts.forms ?? [];
    for (let i = 0; i < forms.length; i += 1) {
      if (opts.shouldStop?.()) { console.log('[tag-assistant] Stop pressed — skipping remaining form submits.'); break; } // cancel between form submits
      const form = forms[i];
      console.log(`[tag-assistant] real form submit ${i + 1}/${forms.length}: ${form.page}`);
      try { opts.onFormProgress?.(form.page, i + 1, forms.length); } catch { /* progress is a nicety */ }
      if (!(await requestAllowed(form.page))) continue;
      try { await popup.goto(withPreview(form.page), { waitUntil: 'networkidle', timeout: navTimeoutMs }); } catch { continue; }
      await popup.waitForTimeout(Math.max(settleMs, 1500));
      await popup.evaluate(grantConsentInPage).catch(() => undefined);
      await popup.evaluate(hideCookieOverlaysInPage).catch(() => undefined);
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
      // reload), then snapshot that event's Tags-Fired panel — proof for THIS form's tags.
      for (let poll = 0; poll < 6; poll += 1) {
        const ev = await ta.evaluate<{ event: string; fired: string }>(readTaPanel).catch(() => ({ event: '', fired: '' }));
        if (/form_submission|form_submit/i.test(ev.event)) break;
        await ta.waitForTimeout(400);
      }
      await snapNewestTa({ event: 'form_submission|form_submit' }); // proof of the real form submit we just did
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
      const seen = new Set<string>(captures.map((c) => firedBodyOf(c.fired).slice(0, 80)));
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
    return { pagesOk: true, perTag, pagesDriven, capture, ...(containersSeen.length ? { containersSeen } : {}), ...(captures.length ? { captures } : {}), ...(summaryShot ? { summaryShot } : {}), ...(problem ? { debugProblem: problem } : {}) };
  } catch (e) {
    return { pagesOk: false, perTag, pagesDriven, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    // Keep the window open on success (user inspects it; closed at the next run's start); close on error.
    if (keepWindowOpen) openTaContext = ctx;
    else await ctx.close().catch(() => undefined);
  }
  });
}
