/**
 * The audit agent: orchestrates crawl → form scan → banner interaction →
 * consent compliance, and merges three finding sources:
 *
 *   1. Banner rules (this file) — proves ordering violations from scenario
 *      captures: tags firing before any choice, tags firing after Reject,
 *      tracking cookies set pre-consent, missing Reject on the first layer.
 *   2. Form rules (agent/forms.ts) — PII collection without notice, pre-ticked
 *      marketing opt-ins, third-party/insecure form actions.
 *   3. The shared Consent Mode v2 engine (apps/portal/shared/consent-audit.ts) —
 *      the same 170-case-tested engine the portal uses. RUNTIME rules only when
 *      no GTM container is supplied; the full CONFIG + RUNTIME + reconcile
 *      engine ("reconciled" coverage) when a container export is passed in.
 *
 * GA4 "advanced consent mode" pings (gcs=G1xx with denied digits) are treated
 * as informational, not violations — they are cookieless by design.
 */

import { loadPlaywright, PlaywrightMissingError, type CapturedHit } from './browser.js';
import { crawlSite, type CrawlResult } from './crawler.js';
import { captureScenario, type Scenario, type ScenarioCapture } from './capture.js';
import { parseGtmContainer } from './gtmConfig.js';
import { reconcile, type ReconcileFinding, type VendorReconcile } from './reconcile.js';
import { loadConfig, clampOpt } from '../utils/config.js';
import { urlAllowed } from '../utils/urlGuard.js';
import type {
  RuntimeInput,
  RuntimePage,
  ConsentFinding,
  ConsentStateLabel,
} from '../../../portal/shared/consent-audit.js';

/** How much of the consent engine ran, surfaced in the report. */
export type ConsentCoverage = 'runtime_only' | 'runtime_imported' | 'reconciled';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface AuditFinding {
  id: string;
  domain: 'consent' | 'banner' | 'forms' | 'reconcile';
  severity: Severity;
  confidence: 'high' | 'medium' | 'low';
  finding: string;
  whyItMatters: string;
  suggestedFix: string;
  evidence?: string[];
  page?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Cookie names that identify users for analytics/ads — setting them needs consent in the EU. */
export const TRACKING_COOKIES = [
  '_ga', '_gid', '_gat', '_gcl_au', '_gcl_aw', '_gcl_dc',
  '_fbp', '_fbc', '_ttp', '_tt_enable_cookie',
  '_uetsid', '_uetvid', 'MUID', 'IDE', 'fr',
  'li_sugr', 'bcookie', 'lidc', 'UserMatchHistory',
  '_pin_unauth', 'hubspotutk', '__hssc', '__hstc',
];

function isTrackingCookie(name: string): boolean {
  return TRACKING_COOKIES.some((t) => name === t || name.startsWith(`${t}_`));
}

/**
 * A hit that actually transmits measurement/marketing data (vs. a script
 * load). Script loads (gtm.js, fbevents.js, snap.licdn.com) are noise for
 * ordering rules; endpoints are evidence.
 */
export function isFiringHit(hit: CapturedHit): boolean {
  if (hit.ids.includes('ga4_collect') || hit.ids.includes('ua_collect')) return true;
  if (hit.groups.includes('meta')) return /facebook\.com\/tr\b/i.test(hit.url);
  if (hit.groups.includes('linkedin')) return /px\.ads\.linkedin\.com/i.test(hit.url);
  if (hit.groups.includes('google_ads') || hit.groups.includes('floodlight') || hit.groups.includes('tiktok')) {
    return true;
  }
  return false;
}

/** GA4 consent signal: gcs=G100 → both denied; G110 ads-only; G101 analytics-only; G111 all granted. */
export function gcsIndicatesDenied(hit: CapturedHit): boolean {
  const gcs = hit.query?.gcs;
  if (!gcs || !/^G1[01][01]$/i.test(gcs)) return false;
  return gcs !== 'G111';
}

function evidenceFor(hits: CapturedHit[], max = 5): string[] {
  return hits.slice(0, max).map((h) => `[${h.groups.join(',')}] t+${h.tMs}ms ${h.url.slice(0, 160)}`);
}

// ── Banner rules ────────────────────────────────────────────────────────────

export function evaluateBannerRules(captures: ScenarioCapture[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const anyCmp = captures.find((c) => c.cmp.detected);
  const allFiring = captures.flatMap((c) => c.trackerHits.filter(isFiringHit));

  // 1. No banner at all, but trackers fire.
  if (!anyCmp && allFiring.length > 0) {
    out.push({
      id: 'banner_missing_cmp',
      domain: 'banner',
      severity: 'high',
      confidence: 'medium',
      finding: `No consent banner was detected, but ${allFiring.length} measurement/marketing hits fired.`,
      whyItMatters:
        'In the EU/UK (and many other regimes), analytics and ad trackers require prior consent. With no banner there is no lawful basis to set tracking identifiers.',
      suggestedFix:
        'Deploy a CMP (e.g. a TCF-registered vendor) wired to Google Consent Mode v2, and gate all marketing/analytics tags behind it.',
      evidence: evidenceFor(allFiring),
    });
  }

  for (const cap of captures) {
    const where = cap.finalUrl ?? cap.requestedUrl;

    // 2. Tags firing before any consent choice (scenario: ignore, banner shown).
    if (cap.scenario === 'ignore' && cap.cmp.detected) {
      const fired = cap.trackerHits.filter(isFiringHit);
      const hard = fired.filter((h) => !gcsIndicatesDenied(h));
      const soft = fired.filter((h) => gcsIndicatesDenied(h));
      if (hard.length > 0) {
        out.push({
          id: `banner_preconsent_fire_${shortKey(where)}`,
          domain: 'banner',
          severity: 'critical',
          confidence: 'high',
          finding: `${hard.length} tracker hit(s) fired before the user made any consent choice on ${where}.`,
          whyItMatters:
            'The banner is cosmetic if tags fire anyway: consent must be obtained BEFORE trackers run (GDPR Art. 6/7, ePrivacy 5(3)). This is the single most-enforced consent violation.',
          suggestedFix:
            'Block these tags until consent: in GTM use Consent Mode "additional consent checks" or consent-aware triggers; verify the CMP pushes the consent default before the container loads.',
          evidence: evidenceFor(hard),
          page: where,
        });
      }
      if (soft.length > 0 && hard.length === 0) {
        out.push({
          id: `banner_advanced_pings_${shortKey(where)}`,
          domain: 'banner',
          severity: 'info',
          confidence: 'high',
          finding: `GA4 sent ${soft.length} cookieless consent-mode ping(s) (gcs denied) before a choice on ${where}.`,
          whyItMatters:
            'This is "advanced consent mode" behaviour — cookieless pings for modelling. Generally accepted, but some DPAs read ePrivacy strictly; know which mode you intend.',
          suggestedFix:
            'If you want zero pre-consent requests, switch to basic consent mode (load gtag only after consent).',
          evidence: evidenceFor(soft, 3),
          page: where,
        });
      }
    }

    // 3. Tags firing after an explicit Reject.
    if (cap.scenario === 'reject' && cap.interaction?.clicked && cap.interactionTMs !== null) {
      const after = cap.trackerHits.filter(
        (h) => isFiringHit(h) && h.tMs > cap.interactionTMs! && !gcsIndicatesDenied(h),
      );
      if (after.length > 0) {
        out.push({
          id: `banner_fires_after_reject_${shortKey(where)}`,
          domain: 'banner',
          severity: 'critical',
          confidence: 'high',
          finding: `${after.length} tracker hit(s) fired AFTER the user clicked "${cap.interaction.selector}" to reject consent on ${where}.`,
          whyItMatters:
            'Ignoring an explicit refusal is the clearest possible consent violation and a common trigger for regulator fines and user complaints.',
          suggestedFix:
            'Verify the CMP pushes a consent update (all denied) on reject, and that every marketing/analytics tag honours it (Consent Mode v2 + consent checks on triggers).',
          evidence: evidenceFor(after),
          page: where,
        });
      }

      // 4. Reject clicked but no consent update signalled.
      const update = cap.consentEvents.find((e) => e.kind === 'update');
      if (!update) {
        out.push({
          id: `banner_reject_no_update_${shortKey(where)}`,
          domain: 'banner',
          severity: 'medium',
          confidence: 'medium',
          finding: `Rejecting the banner on ${where} produced no Consent Mode "update" event in the dataLayer.`,
          whyItMatters:
            'If the CMP never signals the choice, Google tags cannot honour it — the banner and the tags are not actually connected.',
          suggestedFix:
            "Enable the CMP's Google Consent Mode integration (or push gtag('consent','update',…) from its callback).",
          page: where,
        });
      }

      // 5. Tracking cookies still present after reject.
      const cookies = cap.cookiesFinal.filter(isTrackingCookie);
      if (cookies.length > 0) {
        out.push({
          id: `banner_cookies_after_reject_${shortKey(where)}`,
          domain: 'banner',
          severity: 'high',
          confidence: 'high',
          finding: `Tracking cookies (${[...new Set(cookies)].slice(0, 8).join(', ')}) present after consent was rejected on ${where}.`,
          whyItMatters:
            'Identifiers set despite refusal contradict the recorded consent state and are direct evidence in complaints/audits.',
          suggestedFix:
            'Gate the cookie-setting tags behind consent and have the CMP delete known tracking cookies on reject.',
          page: where,
        });
      }
    }

    // 6. Tracking cookies set before any interaction (banner present).
    if (cap.cmp.detected) {
      const pre = cap.cookiesPreInteraction.filter(isTrackingCookie);
      if (pre.length > 0) {
        out.push({
          id: `banner_cookies_preconsent_${shortKey(where)}`,
          domain: 'banner',
          severity: 'high',
          confidence: 'high',
          finding: `Tracking cookies (${[...new Set(pre)].slice(0, 8).join(', ')}) were set before any consent choice on ${where}.`,
          whyItMatters:
            'ePrivacy requires consent BEFORE storing identifiers on the device; the banner being visible is not consent.',
          suggestedFix:
            'Ensure analytics/ads tags wait for the consent update; with Consent Mode v2, denied ad_storage/analytics_storage must prevent these cookies.',
          page: where,
        });
      }
    }
  }

  // 7. Reject parity (dark pattern): accept on layer 1 but no reject.
  if (anyCmp && anyCmp.cmp.accept && !anyCmp.cmp.rejectOnFirstLayer) {
    out.push({
      id: 'banner_no_reject_first_layer',
      domain: 'banner',
      severity: 'medium',
      confidence: 'medium',
      finding: `The ${anyCmp.cmp.vendorName ?? 'consent'} banner offers "Accept" on the first layer but no equally easy "Reject".`,
      whyItMatters:
        'EDPB guidance and several DPAs (CNIL among others) require rejecting to be as easy as accepting; accept-only first layers invalidate the consent collected.',
      suggestedFix: 'Add a "Reject all" button on the first banner layer with the same prominence as "Accept all".',
    });
  }

  // 8. Banner present but Consent Mode never signalled (and Google tags exist).
  // A gcs= param on any hit is itself proof Consent Mode is active, even when
  // the CMP sets the default through gtag internals we can't observe.
  if (anyCmp) {
    const anyConsentEvents = captures.some((c) => c.consentEvents.length > 0);
    const anyGcsSignal = captures.some((c) => c.trackerHits.some((h) => h.query?.gcs));
    const usesGoogle = captures.some((c) =>
      c.trackerHits.some((h) => h.groups.includes('gtm') || h.groups.includes('ga4')),
    );
    if (!anyConsentEvents && !anyGcsSignal && usesGoogle) {
      out.push({
        id: 'banner_no_consent_mode_signals',
        domain: 'banner',
        severity: 'medium',
        confidence: 'medium',
        finding: 'A consent banner and Google tags are both present, but no Consent Mode v2 default/update events were observed.',
        whyItMatters:
          'Without consent signals, Google tags cannot adjust behaviour — and from March 2024 Consent Mode v2 is required to keep ads measurement/audiences for EEA traffic.',
        suggestedFix:
          "Wire the CMP to Google Consent Mode v2: push gtag('consent','default',…) before the container and gtag('consent','update',…) on choice.",
      });
    }
  }

  return out;
}

function shortKey(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'home').slice(0, 40);
  } catch {
    return 'page';
  }
}

// ── Form findings ───────────────────────────────────────────────────────────

export function evaluateFormFindings(captures: ScenarioCapture[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const seen = new Set<string>();
  for (const cap of captures) {
    if (!cap.forms) continue;
    const where = cap.finalUrl ?? cap.requestedUrl;
    for (const form of cap.forms) {
      for (const issue of form.issues) {
        const id = `forms_${shortKey(where)}_${issue.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          domain: 'forms',
          severity: issue.severity,
          confidence: 'medium',
          finding: issue.finding,
          whyItMatters:
            'Forms are the point where tracking data becomes directly identifiable personal data — collection without notice/valid opt-in carries the highest complaint risk.',
          suggestedFix: issue.suggestedFix,
          page: where,
        });
      }
    }
  }
  return out;
}

// ── Bridge into the shared Consent Mode v2 engine ───────────────────────────

const SCENARIO_LABEL: Record<Scenario, ConsentStateLabel> = {
  ignore: 'unknown',
  accept: 'granted',
  reject: 'default_denied',
};

export function buildRuntimeInput(captures: ScenarioCapture[]): RuntimeInput {
  const pages: RuntimePage[] = captures.map((cap) => {
    const ga4First = cap.trackerHits
      .filter((h) => h.ids.includes('ga4_collect'))
      .reduce<number | undefined>((min, h) => (min === undefined || h.tMs < min ? h.tMs : min), undefined);
    return {
      requestedUrl: cap.requestedUrl,
      finalUrl: cap.finalUrl,
      consentState: SCENARIO_LABEL[cap.scenario],
      consoleErrors: cap.consoleErrors,
      pageErrors: cap.pageErrors,
      trackerHits: cap.trackerHits.map((h) => ({
        url: h.url,
        method: h.method,
        groups: h.groups,
        matched: h.ids,
        ...(h.query ? { query: h.query } : {}),
        tMs: h.tMs,
      })),
      dataLayerEvents: cap.dataLayerEvents,
      dataLayerKeys: cap.dataLayerKeys,
      consentEvents: cap.consentEvents.map((e) => ({ kind: e.kind, ...(e.tMs !== undefined ? { tMs: e.tMs } : {}), fields: e.fields })),
      cookies: cap.cookiesFinal.map((name) => ({ name })),
      ...(ga4First !== undefined ? { firstMeasurementTMs: ga4First } : {}),
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    pages,
    states: [...new Set(captures.map((c) => SCENARIO_LABEL[c.scenario]))],
    ok: true,
  };
}

function mapEngineFinding(f: ConsentFinding): AuditFinding {
  return {
    id: `engine_${f.id}`,
    domain: 'consent',
    severity: f.severity as Severity,
    confidence: f.confidence,
    finding: f.finding,
    whyItMatters: f.whyItMatters,
    suggestedFix: f.suggestedFix,
    ...(f.evidence && f.evidence.length > 0 ? { evidence: f.evidence } : {}),
    ...(f.entity?.path ? { page: f.entity.path } : {}),
  };
}

function mapReconcileFinding(f: ReconcileFinding): AuditFinding {
  return {
    id: `reconcile_${f.id}`,
    domain: 'reconcile',
    severity: f.severity as Severity,
    confidence: f.confidence,
    finding: f.finding,
    whyItMatters: f.whyItMatters,
    suggestedFix: f.suggestedFix,
    ...(f.evidence && f.evidence.length > 0 ? { evidence: f.evidence } : {}),
  };
}

/**
 * Run the shared consent engine over the captures. With a GTM container export
 * the full CONFIG + RUNTIME + reconcile engine runs ("reconciled" coverage when
 * the config carries consent intent); without one, only the RUNTIME rules run.
 * A malformed container never fails the audit — the runtime findings stand and
 * the reason is surfaced as a note.
 */
export async function runConsentEngine(
  captures: ScenarioCapture[],
  gtmContainer: unknown,
): Promise<{ findings: AuditFinding[]; coverage: ConsentCoverage; note?: string; configUsable: boolean }> {
  const rt = buildRuntimeInput(captures);
  const mod = await import('../../../portal/shared/consent-audit.js');
  if (gtmContainer !== undefined && gtmContainer !== null) {
    try {
      const cfg = parseGtmContainer(gtmContainer);
      const result = mod.runConsentAudit(cfg, rt);
      return {
        findings: result.findings.map(mapEngineFinding),
        coverage: result.coverage === 'reconciled' ? 'reconciled' : 'runtime_imported',
        configUsable: true,
      };
    } catch (err) {
      // A malformed/summary container is ignored by the consent engine — and
      // must NOT be reconciled either (parameters are stripped/absent).
      return {
        findings: mod.runConsentRuntimeRules(rt).map(mapEngineFinding),
        coverage: 'runtime_only',
        note: `GTM container ignored: ${err instanceof Error ? err.message : String(err)}`,
        configUsable: false,
      };
    }
  }
  return { findings: mod.runConsentRuntimeRules(rt).map(mapEngineFinding), coverage: 'runtime_only', configUsable: false };
}

// ── Report + orchestration ──────────────────────────────────────────────────

export interface ComplianceReport {
  site: string;
  auditedAt: string;
  score: number;
  verdict: 'compliant_looking' | 'needs_attention' | 'poor' | 'non_compliant';
  summary: {
    pagesCrawled: number;
    pagesCaptured: number;
    scenariosRun: Scenario[];
    cmp: { detected: boolean; vendor?: string; rejectOnFirstLayer?: boolean };
    formsFound: number;
    /** How much of the consent engine ran (reconciled requires a GTM container). */
    consentCoverage: ConsentCoverage;
    findingCounts: Record<Severity, number>;
  };
  /** Audit-level notes (e.g. a GTM container that could not be used). */
  notes: string[];
  /** Per-vendor configured-vs-fired reconciliation (present only when a GTM
   *  container was supplied). */
  reconciliation?: VendorReconcile[];
  crawl: CrawlResult;
  captures: {
    scenario: Scenario;
    url: string;
    httpStatus: number | null;
    trackerHits: number;
    firingHits: number;
    consentEvents: number;
    interactionClicked: boolean | null;
    notes: string[];
  }[];
  findings: AuditFinding[];
  /** Present only when the caller passed debug:true — see AuditDebug. */
  debug?: AuditDebug;
}

/**
 * Diagnostics for troubleshooting a run (opt-in via debug:true). Surfaces the
 * browser console/page errors each scenario capture already records but the
 * normal report drops, plus the effective run mode. Purely additive — it does
 * not change what the audit does (still read-only, consent-click only).
 */
export interface AuditDebug {
  /** Chromium launch mode (set WEB_AUDIT_HEADED=true to watch a run). */
  headless: boolean;
  navTimeoutMs: number;
  settleMs: number;
  interactionEnabled: boolean;
  captures: {
    scenario: Scenario;
    url: string;
    consoleErrors: string[];
    pageErrors: string[];
  }[];
}

export function scoreFindings(findings: AuditFinding[]): { score: number; verdict: ComplianceReport['verdict'] } {
  let score = 100;
  for (const f of findings) {
    // Tag-presence reconciliation is diagnostic (and sample-based), not a
    // privacy-compliance violation — it informs but does not dock the score.
    if (f.domain === 'reconcile') continue;
    if (f.severity === 'critical') score -= 25;
    else if (f.severity === 'high') score -= 15;
    else if (f.severity === 'medium') score -= 7;
    else if (f.severity === 'low') score -= 3;
  }
  score = Math.max(0, score);
  const verdict =
    score >= 90 ? 'compliant_looking' : score >= 70 ? 'needs_attention' : score >= 40 ? 'poor' : 'non_compliant';
  return { score, verdict };
}

export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  );
}

export interface ComplianceAuditOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Pages (beyond the start URL) that also get a pre-consent capture + form scan. */
  capturePages?: number;
  scenarios?: Scenario[];
  /**
   * Parsed GTM container export (export_container, format:"full"). When present,
   * the consent engine reconciles configured intent against runtime behaviour
   * ("reconciled" coverage) instead of running runtime-only rules.
   */
  gtmContainer?: unknown;
  /** Include an AuditDebug block (browser console/page errors + run mode) for troubleshooting. */
  debug?: boolean;
}

/** Full audit: crawl the site, scan forms, exercise the banner, run all rules. */
export async function runComplianceAudit(
  startUrl: string,
  options: ComplianceAuditOptions = {},
): Promise<ComplianceReport> {
  const config = loadConfig();
  const verdict = urlAllowed(startUrl, config.allowlist);
  if (!verdict.ok) throw new Error(`start URL rejected: ${verdict.reason}`);

  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightMissingError();

  const maxPages = clampOpt(options.maxPages, config.maxPages, config.maxPagesCap);
  const maxDepth = clampOpt(options.maxDepth, config.maxDepth, config.maxDepthCap);
  const capturePages = clampOpt(options.capturePages, 3, 8);
  let scenarios: Scenario[] = options.scenarios ?? ['ignore', 'reject', 'accept'];
  if (!config.interactionEnabled) scenarios = scenarios.filter((s) => s === 'ignore');
  if (!scenarios.includes('ignore')) scenarios = ['ignore', ...scenarios];

  const browser = await pw.chromium.launch({ headless: config.headless });
  try {
    const crawl = await crawlSite(browser, startUrl, {
      maxPages,
      maxDepth,
      navTimeoutMs: config.navTimeoutMs,
      allowlist: config.allowlist,
    });

    const captureOpts = { navTimeoutMs: config.navTimeoutMs, settleMs: config.settleMs, scanForms: true };
    const captures: ScenarioCapture[] = [];

    // Pre-consent behaviour + forms on the start page and the most form-heavy pages.
    const okPages = crawl.pages.filter((p) => !p.note && p.httpStatus !== null && p.httpStatus < 400);
    const ranked = [...okPages].sort((a, b) => b.formsCount - a.formsCount || a.depth - b.depth);
    const targets = [okPages[0], ...ranked].filter(Boolean);
    const ignoreTargets: string[] = [];
    for (const p of targets) {
      if (!ignoreTargets.includes(p.url)) ignoreTargets.push(p.url);
      if (ignoreTargets.length >= capturePages) break;
    }
    for (const url of ignoreTargets) {
      captures.push(await captureScenario(browser, url, 'ignore', captureOpts));
    }

    // Banner click-through scenarios on the entry page, each in a fresh context.
    const entry = ignoreTargets[0] ?? startUrl;
    for (const scenario of scenarios) {
      if (scenario === 'ignore') continue;
      captures.push(await captureScenario(browser, entry, scenario, { ...captureOpts, scanForms: false }));
    }

    // Findings from all sources. The consent engine runs reconciled (CONFIG +
    // RUNTIME) when a GTM container was supplied, runtime-only otherwise. With a
    // container we also reconcile tag PRESENCE: configured-but-never-fired,
    // fired-but-not-configured, GA4 id mismatch.
    const engine = await runConsentEngine(captures, options.gtmContainer);
    // Reconcile only when the container actually parsed (not a summary/empty
    // export the consent engine rejected). Suppress "configured but never fired"
    // unless a consent-GRANTED capture ran, so consent-gated tags aren't flagged.
    const consentGranted = captures.some((c) => c.scenario === 'accept' && c.interaction?.clicked === true);
    const recon = engine.configUsable ? reconcile(options.gtmContainer, captures, { consentGranted }) : null;
    const findings = sortFindings([
      ...evaluateBannerRules(captures),
      ...evaluateFormFindings(captures),
      ...engine.findings,
      ...(recon ? recon.findings.map(mapReconcileFinding) : []),
    ]);

    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) counts[f.severity] += 1;
    const { score, verdict: v } = scoreFindings(findings);
    const cmpCapture = captures.find((c) => c.cmp.detected);

    return {
      site: startUrl,
      auditedAt: new Date().toISOString(),
      score,
      verdict: v,
      summary: {
        pagesCrawled: crawl.pages.length,
        pagesCaptured: captures.length,
        scenariosRun: [...new Set(captures.map((c) => c.scenario))],
        cmp: cmpCapture
          ? {
              detected: true,
              vendor: cmpCapture.cmp.vendorName,
              rejectOnFirstLayer: cmpCapture.cmp.rejectOnFirstLayer,
            }
          : { detected: false },
        formsFound: captures.reduce((n, c) => n + (c.forms?.length ?? 0), 0),
        consentCoverage: engine.coverage,
        findingCounts: counts,
      },
      notes: engine.note ? [engine.note] : [],
      ...(recon ? { reconciliation: recon.byVendor } : {}),
      crawl,
      captures: captures.map((c) => ({
        scenario: c.scenario,
        url: c.requestedUrl,
        httpStatus: c.httpStatus,
        trackerHits: c.trackerHits.length,
        firingHits: c.trackerHits.filter(isFiringHit).length,
        consentEvents: c.consentEvents.length,
        interactionClicked: c.interaction ? c.interaction.clicked : null,
        notes: c.notes,
      })),
      findings,
      ...(options.debug
        ? {
            debug: {
              headless: config.headless,
              navTimeoutMs: config.navTimeoutMs,
              settleMs: config.settleMs,
              interactionEnabled: config.interactionEnabled,
              captures: captures.map((c) => ({
                scenario: c.scenario,
                url: c.requestedUrl,
                consoleErrors: c.consoleErrors,
                pageErrors: c.pageErrors,
              })),
            } satisfies AuditDebug,
          }
        : {}),
    };
  } finally {
    await browser.close();
  }
}
