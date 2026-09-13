/**
 * Shared, pure helpers for the assertion engine. No browser, no I/O.
 */

import type { CaptureResult, CheckResult, CheckSpec, Ga4Hit, HitEvidence, VerifySpec, Phase } from '../types.js';

/** Cookie names that indicate analytics/ads storage was written (pre-consent = a violation). */
const TRACKING_COOKIE_RE =
  /^(_ga($|_)|_gid$|_gac_|_gcl_|_fbp$|_fbc$|_uetsid$|_uetvid$|_ttp$|_scid$|_tt_|IDE$|MUID$|li_gc$|_pin_unauth$)/i;

export function isTrackingCookie(name: string): boolean {
  return TRACKING_COOKIE_RE.test(name);
}

export function trackingCookies(names: string[]): string[] {
  return names.filter(isTrackingCookie);
}

/** Which measurement IDs constrain a check (check.tid overrides spec.measurementIds). */
function tidConstraint(spec: VerifySpec, check: CheckSpec): string[] {
  if (check.tid) return [check.tid];
  return spec.measurementIds ?? [];
}

export function tidMatches(hit: Ga4Hit, spec: VerifySpec, check: CheckSpec): boolean {
  const ids = tidConstraint(spec, check);
  if (ids.length === 0) return true;
  return hit.tid !== undefined && ids.includes(hit.tid);
}

/**
 * Does a hit fall in the check's requested phase? When no consent action ran we
 * cannot partition, so phase is treated as satisfied (single-phase page).
 */
export function hitInPhase(hit: Ga4Hit, capture: CaptureResult, phase: Phase | undefined): boolean {
  if (!phase) return true;
  if (capture.consentActionTMs == null) return true;
  const actual: Phase = hit.tRelativeMs < capture.consentActionTMs ? 'pre_consent' : 'post_consent';
  return actual === phase;
}

/** GA4 hits matching a check's event + tid + phase (event optional). */
export function candidateHits(capture: CaptureResult, spec: VerifySpec, check: CheckSpec): Ga4Hit[] {
  return capture.ga4Hits.filter((h) => {
    if (check.event !== undefined && h.en !== check.event) return false;
    if (!tidMatches(h, spec, check)) return false;
    if (!hitInPhase(h, capture, check.phase)) return false;
    return true;
  });
}

export interface ParamMatch {
  allMatch: boolean;
  mismatches: { key: string; expected: string; actual?: string; reason: string }[];
}

/** Compare a hit's params against a spec param map. Numeric comparison for epn./upn. keys or number values. */
export function matchParams(hit: Ga4Hit, expected: Record<string, string | number | boolean>): ParamMatch {
  const mismatches: ParamMatch['mismatches'] = [];
  for (const [key, val] of Object.entries(expected)) {
    const actual = hit.params[key];
    if (val === true) {
      if (actual === undefined) mismatches.push({ key, expected: '(present)', reason: 'missing' });
      continue;
    }
    if (val === false) {
      if (actual !== undefined) mismatches.push({ key, expected: '(absent)', actual, reason: 'should be absent' });
      continue;
    }
    if (actual === undefined) {
      mismatches.push({ key, expected: String(val), reason: 'missing' });
      continue;
    }
    const numeric = key.startsWith('epn.') || key.startsWith('upn.') || typeof val === 'number';
    if (numeric) {
      if (Number(actual) !== Number(val)) mismatches.push({ key, expected: String(val), actual, reason: 'numeric mismatch' });
    } else if (actual !== String(val)) {
      mismatches.push({ key, expected: String(val), actual, reason: 'value mismatch' });
    }
  }
  return { allMatch: mismatches.length === 0, mismatches };
}

export function describeMismatches(m: ParamMatch['mismatches']): string {
  return m
    .map((x) => (x.actual === undefined ? `${x.key} ${x.reason} (expected ${x.expected})` : `${x.key}=${x.actual} (${x.reason}, expected ${x.expected})`))
    .join('; ');
}

/** Trim a hit to the report evidence shape. */
export function toEvidence(hit: Ga4Hit): HitEvidence {
  const ev: HitEvidence = { en: hit.en, tRelativeMs: hit.tRelativeMs, transport: hit.transport };
  if (hit.tid !== undefined) ev.tid = hit.tid;
  if (Object.keys(hit.params).length > 0) ev.params = hit.params;
  if (hit.gcs !== undefined) ev.gcs = hit.gcs;
  if (hit.gcd !== undefined) ev.gcd = hit.gcd;
  return ev;
}

// ── CheckResult builders ──────────────────────────────────────────────────────

function base(check: CheckSpec, evidence?: CheckResult['evidence']): Pick<CheckResult, 'id' | 'type'> & { evidence?: CheckResult['evidence'] } {
  return evidence ? { id: check.id, type: check.type, evidence } : { id: check.id, type: check.type };
}

function evidenceOf(hits?: Ga4Hit[], extra?: Record<string, unknown>): CheckResult['evidence'] | undefined {
  const ev: Record<string, unknown> = { ...(extra ?? {}) };
  if (hits && hits.length > 0) ev.hits = hits.map(toEvidence);
  return Object.keys(ev).length > 0 ? ev : undefined;
}

export function pass(check: CheckSpec, hits?: Ga4Hit[], extra?: Record<string, unknown>): CheckResult {
  return { ...base(check, evidenceOf(hits, extra)), status: 'Pass' };
}

export function fail(check: CheckSpec, reason: string, hits?: Ga4Hit[], extra?: Record<string, unknown>): CheckResult {
  return { ...base(check, evidenceOf(hits, extra)), status: 'Fail', reason };
}

export function partial(check: CheckSpec, reason: string, hits?: Ga4Hit[], extra?: Record<string, unknown>): CheckResult {
  return { ...base(check, evidenceOf(hits, extra)), status: 'Partial', reason };
}

export function notVerified(check: CheckSpec, reason: string, hits?: Ga4Hit[], extra?: Record<string, unknown>): CheckResult {
  return { ...base(check, evidenceOf(hits, extra)), status: 'Not Verified', reason };
}

/** Human-readable tid constraint for reasons. */
export function tidText(spec: VerifySpec, check: CheckSpec): string {
  const ids = check.tid ? [check.tid] : (spec.measurementIds ?? []);
  return ids.length ? ` for tid ${ids.join('/')}` : '';
}
