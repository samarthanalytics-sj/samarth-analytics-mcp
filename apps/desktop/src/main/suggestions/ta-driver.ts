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

import { existsSync, readFileSync } from 'node:fs';
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

// ── Use the user's REAL Chrome profile (their existing Google login) ──────────────────────────────
// The user chose to run Tag Assistant in their actual Chrome profile, so it uses the account they are
// already signed into ("last open account") with no separate sign-in and no blank isolated profile. The
// one cost: their Chrome must be fully closed, because a running Chrome holds an exclusive lock on its
// user-data-dir; if it is open, launching against that dir fails and we surface a clear "close Chrome".

/** Locate the installed Chrome "User Data" directory for the current OS, or null if not found. */
export function realChromeUserDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}\\Google\\Chrome\\User Data`);
  if (env.HOME) {
    candidates.push(`${env.HOME}/Library/Application Support/Google/Chrome`); // macOS
    candidates.push(`${env.HOME}/.config/google-chrome`); // Linux
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The profile directory name Chrome last used (e.g. "Default", "Profile 1") — so we open the account the
 *  user was actually on, not always Default. Falls back to "Default". PURE given the file contents. */
export function lastUsedChromeProfile(userDataDir: string): string {
  try {
    const ls = JSON.parse(readFileSync(`${userDataDir}/Local State`, 'utf8')) as { profile?: { last_used?: string } };
    const last = ls.profile?.last_used;
    return last && typeof last === 'string' ? last : 'Default';
  } catch {
    return 'Default';
  }
}

/** Thrown when the real Chrome profile can't be opened because Chrome is still running (profile locked).
 *  Carries a flag so the caller returns the actionable "close Chrome" message instead of a raw error. */
class ChromeProfileLockedError extends Error {
  readonly chromeLocked = true;
  constructor() { super('Chrome profile is locked (Chrome is running).'); }
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

/** Launch the user's REAL Chrome profile (their existing Google login). `--profile-directory` selects the
 *  same profile Chrome last used. Real installed Chrome only (no bundled-Chromium fallback — that wouldn't
 *  have their login). If Chrome is running the profile is locked: the launched process forwards to the
 *  existing instance and exits, so the launch/first-page fails — we translate that to ChromeProfileLocked. */
async function launchRealChrome(userDataDir: string, profileName: string): Promise<PwContext> {
  const pw = await loadPw();
  if (!pw) throw new PlaywrightUnavailableError();
  let ctx: PwContext;
  try {
    ctx = await pw.chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chrome',
      viewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', `--profile-directory=${profileName}`, '--no-first-run', '--no-default-browser-check'],
    });
  } catch {
    throw new ChromeProfileLockedError();
  }
  // A locked profile can still "launch" but immediately lose the browser; probe with a page to be sure.
  try {
    const p = ctx.pages()[0] ?? (await ctx.newPage());
    void p;
  } catch {
    await ctx.close().catch(() => undefined);
    throw new ChromeProfileLockedError();
  }
  return ctx;
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
  url: string,
  tags: VerifyDriverTag[],
  containerPublicId: string,
  opts: { settleMs?: number; navTimeoutMs?: number; onPageProgress?: (page: string, done: number, total: number) => void } = {},
): Promise<TaVerifyResult> {
  const settleMs = opts.settleMs ?? 900;
  const navTimeoutMs = opts.navTimeoutMs ?? 25_000;
  const perTag: PerTagCapture[] = [];
  const pagesDriven: string[] = [];
  if (!(await requestAllowed(url))) {
    return { pagesOk: false, perTag, pagesDriven, error: `Refusing to load ${url}: blocked by the SSRF guard.` };
  }
  const userDataDir = realChromeUserDataDir();
  if (!userDataDir) {
    return { pagesOk: false, perTag, pagesDriven, error: 'Could not find your Google Chrome profile. Tag Assistant verification runs in your real Chrome so it uses your existing Google login - please install/enable Google Chrome and try again.' };
  }
  const profileName = lastUsedChromeProfile(userDataDir);
  // Serialize with any other profile access: one browser launch at a time.
  return serializeProfile(async () => {
  // Run Tag Assistant in the user's REAL Chrome profile (their existing Google login) - no separate
  // sign-in, no blank profile. Requires Chrome to be closed (locked profile otherwise).
  let ctx: PwContext;
  try {
    ctx = await launchRealChrome(userDataDir, profileName);
  } catch (e) {
    if (e instanceof ChromeProfileLockedError) {
      return {
        pagesOk: false, perTag, pagesDriven,
        error: 'Google Chrome is open, so Tag Assistant can\'t use your Chrome profile (a running Chrome locks it). Please FULLY CLOSE Google Chrome - every window, and check the system tray / Task Manager for a background chrome.exe - then click "Verify with Tag Assistant" again. It will use the account you\'re already signed into, so there is no separate sign-in.',
      };
    }
    return { pagesOk: false, perTag, pagesDriven, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
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

    // No sign-in step: the real profile already carries the user's Google login. If it somehow isn't
    // signed in, TA can't debug a GTM container — surface that as a clear, actionable message.
    if (!(await hasGoogleSession(ctx))) {
      console.log('[tag-assistant] real Chrome profile is not signed into Google.');
      return {
        pagesOk: false, perTag, pagesDriven, needSignIn: true,
        error: `Your Chrome profile "${profileName}" is not signed into Google. Open Chrome, sign into the Google account that has access to this GTM container, then FULLY close Chrome and run "Verify with Tag Assistant" again.`,
      };
    }
    console.log(`[tag-assistant] using your Chrome profile "${profileName}" (already signed in); connecting to ${url} ...`);

    // Connect: Add domain -> URL -> Connect -> the debugged popup.
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
