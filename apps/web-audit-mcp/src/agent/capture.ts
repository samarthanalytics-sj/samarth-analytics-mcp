/**
 * Scenario capture: load a page in a fresh browser context and observe tag
 * behaviour under one consent scenario —
 *   ignore  — never touch the banner (what fires before any choice?)
 *   accept  — click the banner's accept-all control
 *   reject  — click the banner's reject-all control
 * Network hits, dataLayer consent events, and cookies are snapshotted before
 * and after the interaction so rules can prove ordering ("tag fired before
 * consent", "tag fired after reject").
 */

import type { PwBrowser, CapturedHit } from './browser.js';
import { openInstrumentedPage } from './browser.js';
import { detectCmp, interactWithCmp, type CmpDetection, type CmpInteraction } from './cmp.js';
import { scanForms, type FormAnalysis } from './forms.js';

export type Scenario = 'ignore' | 'accept' | 'reject';

export interface ConsentEventCapture {
  kind: 'default' | 'update';
  tMs?: number;
  fields: Record<string, 'granted' | 'denied'>;
}

export interface ScenarioCapture {
  scenario: Scenario;
  requestedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  cmp: CmpDetection;
  interaction: CmpInteraction | null;
  /** ms since navigation start when the banner was clicked (if it was). */
  interactionTMs: number | null;
  trackerHits: CapturedHit[];
  networkRequestCount: number;
  consentEvents: ConsentEventCapture[];
  dataLayerEvents: string[];
  dataLayerKeys: string[];
  /** Cookie names present after settle but before any banner interaction. */
  cookiesPreInteraction: string[];
  /** Cookie names at the end of the capture. */
  cookiesFinal: string[];
  consoleErrors: string[];
  pageErrors: string[];
  forms: FormAnalysis[] | null;
  notes: string[];
}

export interface CaptureOptions {
  navTimeoutMs: number;
  settleMs: number;
  /** Also run the form scan on this page. */
  scanForms?: boolean;
}

const CONSENT_FIELDS = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];

interface DlLogEntry {
  t?: number;
  entry?: unknown;
}

/** Extract Consent Mode default/update events (with timing) from the hooked dataLayer log. */
export function extractConsentEvents(log: DlLogEntry[]): ConsentEventCapture[] {
  const out: ConsentEventCapture[] = [];
  for (const item of Array.isArray(log) ? log : []) {
    const entry = item?.entry;
    if (!Array.isArray(entry)) continue;
    if (entry[0] !== 'consent' || (entry[1] !== 'default' && entry[1] !== 'update')) continue;
    const cfg = entry[2] && typeof entry[2] === 'object' ? (entry[2] as Record<string, unknown>) : {};
    const fields: Record<string, 'granted' | 'denied'> = {};
    for (const f of CONSENT_FIELDS) {
      if (cfg[f] === 'granted' || cfg[f] === 'denied') fields[f] = cfg[f] as 'granted' | 'denied';
    }
    out.push({
      kind: entry[1] as 'default' | 'update',
      ...(typeof item.t === 'number' ? { tMs: item.t } : {}),
      fields,
    });
  }
  return out;
}

export function extractEventNames(log: DlLogEntry[]): string[] {
  const names: string[] = [];
  for (const item of Array.isArray(log) ? log : []) {
    const entry = item?.entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const ev = (entry as Record<string, unknown>).event;
      if (typeof ev === 'string' && ev && names.length < 300) names.push(ev);
    }
    if (Array.isArray(entry) && entry[0] === 'event' && typeof entry[1] === 'string' && names.length < 300) {
      names.push(entry[1]);
    }
  }
  return names;
}

export function extractDataLayerKeys(log: DlLogEntry[]): string[] {
  const keys = new Set<string>();
  for (const item of Array.isArray(log) ? log : []) {
    const entry = item?.entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      for (const k of Object.keys(entry)) {
        if (keys.size < 200) keys.add(k);
      }
    }
  }
  return [...keys];
}

function readDlLogInPage(): { t?: number; entry?: unknown }[] {
  const w = window as unknown as { __wa_dl_log?: { t?: number; entry?: unknown }[] };
  return Array.isArray(w.__wa_dl_log) ? w.__wa_dl_log : [];
}

/** Capture one page under one consent scenario, in its own browser context. */
export async function captureScenario(
  browser: PwBrowser,
  url: string,
  scenario: Scenario,
  opts: CaptureOptions,
): Promise<ScenarioCapture> {
  const notes: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  try {
    const inst = await openInstrumentedPage(context);
    const page = inst.page;

    const navStartWall = Date.now();
    inst.markNavigationStart();
    let httpStatus: number | null = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'load', timeout: opts.navTimeoutMs });
      httpStatus = resp ? resp.status() : null;
    } catch (err) {
      notes.push(`navigation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
    await page.waitForTimeout(opts.settleMs);

    const cookiesPreInteraction = (await context.cookies()).map((c) => c.name);
    const cmp = await detectCmp(page);

    let interaction: CmpInteraction | null = null;
    let interactionTMs: number | null = null;
    if (scenario !== 'ignore') {
      interactionTMs = Date.now() - navStartWall;
      interaction = await interactWithCmp(page, cmp, scenario);
      interaction.tMs = interactionTMs;
      if (interaction.clicked) {
        // Let post-consent tags fire (or prove they don't, after reject).
        await page.waitForTimeout(opts.settleMs);
      } else {
        interactionTMs = null;
        notes.push(`requested scenario "${scenario}" but ${interaction.note ?? 'the control was not clickable'}`);
      }
    }

    const dlLog = await page.evaluate<DlLogEntry[]>(readDlLogInPage).catch(() => [] as DlLogEntry[]);
    const forms = opts.scanForms ? await scanForms(page, page.url()).catch(() => null) : null;
    const cookiesFinal = (await context.cookies()).map((c) => c.name);

    return {
      scenario,
      requestedUrl: url,
      finalUrl: page.url(),
      httpStatus,
      cmp,
      interaction,
      interactionTMs,
      trackerHits: inst.trackerHits,
      networkRequestCount: inst.requestCount(),
      consentEvents: extractConsentEvents(dlLog),
      dataLayerEvents: extractEventNames(dlLog),
      dataLayerKeys: extractDataLayerKeys(dlLog),
      cookiesPreInteraction,
      cookiesFinal,
      consoleErrors: inst.consoleErrors,
      pageErrors: inst.pageErrors,
      forms,
      notes,
    };
  } finally {
    await context.close();
  }
}
