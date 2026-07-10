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
  driveInPage, specFor, buildCustomEventPayload,
  type VerifyDriverTag, type DriveOutcome,
} from './verify-driver';
import { parseTaFrames, type TaCapture } from './ta-stream';
import type { PerTagCapture } from './verify-tags';

const TA_URL = 'https://tagassistant.google.com/';

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
  locator(sel: string): { first(): { count(): Promise<number>; click(o?: Record<string, unknown>): Promise<void>; fill(v: string, o?: Record<string, unknown>): Promise<void> } };
  isClosed(): boolean;
  url(): string;
}
interface PwContext {
  addInitScript(fn: unknown): Promise<void>;
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => unknown): Promise<void>;
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
  error?: string;
  perTag: PerTagCapture[];
  pagesDriven: string[];
  /** The parsed authoritative debug capture (per-event tags fired + API-Call pushes). */
  capture?: TaCapture;
}

/**
 * The Phase-2 drive: connect TA to `url`, then sequentially navigate the SAME debugged popup through each
 * tag's page and drive its trigger, capturing the debug stream throughout. Screenshots + the TA-style
 * timeline UI land in Phase 3.
 */
export async function runTaVerify(
  profileDir: string,
  url: string,
  tags: VerifyDriverTag[],
  containerPublicId: string,
  opts: { settleMs?: number; navTimeoutMs?: number; loginHint?: string; signInTimeoutMs?: number; onSignInPrompt?: () => void; onPageProgress?: (page: string, done: number, total: number) => void } = {},
): Promise<TaVerifyResult> {
  const settleMs = opts.settleMs ?? 900;
  const navTimeoutMs = opts.navTimeoutMs ?? 25_000;
  const perTag: PerTagCapture[] = [];
  const pagesDriven: string[] = [];
  if (!(await requestAllowed(url))) {
    return { pagesOk: false, perTag, pagesDriven, error: `Refusing to load ${url}: blocked by the SSRF guard.` };
  }
  // Serialize with any other profile access: the exclusive ta-profile lock means one at a time.
  return serializeProfile(async () => {
  // HEADED (visible): the user WATCHES Tag Assistant sign in (once), connect, and show tags firing — that
  // real Tag Assistant tab IS the "show it in detail" view — and the one-time sign-in happens in context.
  const ctx = await launchProfile(profileDir, false);
  try {
    await ctx.addInitScript(captureFramesInit);
    // Abort analytics collectors so driving tags never delivers a real hit (the TA stream, not beacons,
    // is the verdict source). Everything else (gtm.js, TA channel, page assets) flows normally.
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (classifyCollector(u)) { void route.abort(); return; }
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
    console.log(`[tag-assistant] connecting to ${url} ...`);
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
      done += 1;
      console.log(`[tag-assistant]   page ${done}/${groups.length}: ${pageUrl} (${groupTags.length} trigger(s))`);
      try { opts.onPageProgress?.(pageUrl, done, groups.length); } catch { /* progress is a nicety */ }
      if (!(await requestAllowed(pageUrl))) continue;
      // First group often IS the connect URL — already loaded; skip the redundant navigation.
      if (!(done === 1 && popup.url().split('?')[0].replace(/\/$/, '') === pageUrl.split('?')[0].replace(/\/$/, ''))) {
        try { await popup.goto(pageUrl, { waitUntil: 'networkidle', timeout: navTimeoutMs }); } catch {
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
          const data = tag.trigger.customEventData ?? {};
          const payload = buildCustomEventPayload(evName, data, pushedDlKeys);
          Object.keys(data).forEach((k) => pushedDlKeys.add(k));
          try { await popup.evaluate(pushDataLayerInPage, payload); } catch { /* reported by stream absence */ }
          await popup.waitForTimeout(Math.max(settleMs, 700));
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
        if (outcome.performed) await popup.waitForTimeout(Math.max(settleMs, 700));
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
    await popup.waitForTimeout(Math.max(settleMs, 1500)); // let the last TAG_STATUS frames arrive

    // Harvest + parse the stream from the TA page.
    const frames = await ta.evaluate<string[]>(() => (window as unknown as { __taFrames?: string[] }).__taFrames ?? []).catch(() => [] as string[]);
    const capture = parseTaFrames(frames);
    const { containerDebugProblem, eventsForContainer } = await import('./ta-stream');
    const problem = containerDebugProblem(capture, containerPublicId);
    const evs = eventsForContainer(capture, containerPublicId);
    const firedCount = evs.reduce((n, e) => n + e.tags.filter((t) => t.status === 'fired').length, 0);
    console.log(`[tag-assistant] captured ${frames.length} debug frame(s) -> ${evs.length} event(s) for ${containerPublicId}, ${firedCount} tag-fire(s)${problem ? ` -- ${problem}` : ''}`);
    return { pagesOk: true, perTag, pagesDriven, capture, ...(problem ? { debugProblem: problem } : {}) };
  } catch (e) {
    return { pagesOk: false, perTag, pagesDriven, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    await ctx.close().catch(() => undefined);
  }
  });
}
