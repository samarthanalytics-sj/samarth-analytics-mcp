import type {
  CaptureResult,
  CheckResult,
  CheckSpec,
  ConsentField,
  ConsentValue,
  Ga4Hit,
  Status,
  VerifySpec,
} from '../../types.js';
import { trackingCookies } from '../helpers.js';
import { analyticsStorageDenied, decodeGcs, decodeGcd } from '../../consent-signals.js';

interface Sub {
  status: Status;
  reason?: string;
}

/**
 * consent_mode — decode gcs/gcd, assert the pre-consent default and
 * post-consent updated states, and run the two pre-consent sub-checks:
 *   (a) no GA4 hit before the consent action unless its gcs shows analytics
 *       storage denied (a cookieless ping);
 *   (b) no analytics/ads cookies (_ga, _gid, _fbp, …) set pre-consent.
 * Worst sub-result wins; ambiguous consent timing → Not Verified (never guessed).
 */
export function checkConsentMode(capture: CaptureResult, _spec: VerifySpec, check: CheckSpec): CheckResult {
  const subs: Sub[] = [];
  const evidence: Record<string, unknown> = {};
  const hasConsentAction = capture.consentActionTMs != null;

  // ── (a) pre-consent firing ────────────────────────────────────────────────
  if (hasConsentAction) {
    const cutoff = capture.consentActionTMs as number;
    const preHits = capture.ga4Hits.filter((h) => h.tRelativeMs < cutoff);
    const offenders = preHits.filter((h) => !analyticsStorageDenied(h.gcs));
    if (preHits.length === 0) {
      subs.push({ status: 'Pass' });
    } else if (offenders.length > 0) {
      subs.push({
        status: 'Fail',
        reason: `${offenders.length} GA4 hit(s) fired before consent without analytics_storage denied (gcs: ${offenders
          .map((h) => h.gcs ?? 'absent')
          .join(', ')})`,
      });
      evidence.preConsentOffenders = offenders.slice(0, 5).map(hitDigest);
    } else {
      subs.push({ status: 'Pass' });
      evidence.preConsentCookielessHits = preHits.length;
    }
  } else if (capture.consentAction || check.phase === 'pre_consent') {
    // A consent flow was configured but no click landed → cannot partition.
    subs.push({ status: 'Not Verified', reason: 'consent action was not performed — pre-consent firing could not be determined' });
  }

  // ── (b) pre-consent cookies ───────────────────────────────────────────────
  if (hasConsentAction || capture.consentAction) {
    const bad = trackingCookies(capture.cookiesPreConsent);
    if (bad.length > 0) {
      subs.push({ status: 'Fail', reason: `analytics/ads cookies set before consent: ${bad.join(', ')}` });
      evidence.preConsentCookies = bad;
    } else {
      subs.push({ status: 'Pass' });
    }
  }

  // ── default state assertion ───────────────────────────────────────────────
  if (check.expectedDefault) {
    const def = capture.consentEvents.find((e) => e.kind === 'default');
    evidence.observedDefault = def?.fields ?? null;
    subs.push(compareState('default', def?.fields, check.expectedDefault, Boolean(def)));
  }

  // ── update state assertion ────────────────────────────────────────────────
  if (check.expectedUpdate) {
    if (!hasConsentAction) {
      subs.push({ status: 'Not Verified', reason: 'no consent action performed — post-consent update state could not be verified' });
    } else {
      const upd = capture.consentEvents.find((e) => e.kind === 'update');
      evidence.observedUpdate = upd?.fields ?? null;
      subs.push(compareState('update', upd?.fields, check.expectedUpdate, Boolean(upd)));
    }
  }

  // gcs/gcd decode surfaced as evidence (informational).
  const firstGcs = capture.ga4Hits.find((h) => h.gcs)?.gcs;
  const firstGcd = capture.ga4Hits.find((h) => h.gcd)?.gcd;
  if (firstGcs) evidence.gcs = { raw: firstGcs, ...decodeGcs(firstGcs) };
  if (firstGcd) evidence.gcd = decodeGcd(firstGcd);

  return combine(check, subs, evidence);
}

function hitDigest(h: Ga4Hit): Record<string, unknown> {
  return { en: h.en, tid: h.tid, gcs: h.gcs, tRelativeMs: h.tRelativeMs, transport: h.transport };
}

function compareState(
  kind: 'default' | 'update',
  observed: Partial<Record<ConsentField, 'granted' | 'denied'>> | undefined,
  expected: Partial<Record<ConsentField, ConsentValue>>,
  eventSeen: boolean,
): Sub {
  const wanted = Object.entries(expected).filter(([, v]) => v && v !== 'unknown') as [ConsentField, ConsentValue][];
  if (wanted.length === 0) return { status: 'Pass' };
  if (!eventSeen) {
    return { status: 'Fail', reason: `expected a consent "${kind}" state but no consent ${kind} event was observed` };
  }
  const mismatches: string[] = [];
  for (const [field, exp] of wanted) {
    const got = observed?.[field] ?? 'unknown';
    if (got !== exp) mismatches.push(`${field}=${got} (expected ${exp})`);
  }
  if (mismatches.length > 0) {
    return { status: 'Fail', reason: `consent ${kind} state mismatch: ${mismatches.join(', ')}` };
  }
  return { status: 'Pass' };
}

const RANK: Record<Status, number> = { Fail: 3, Partial: 2, 'Not Verified': 1, Pass: 0 };

function combine(check: CheckSpec, subs: Sub[], evidence: Record<string, unknown>): CheckResult {
  const ev = Object.keys(evidence).length > 0 ? evidence : undefined;
  if (subs.length === 0) {
    return { id: check.id, type: check.type, status: 'Not Verified', reason: 'no consent assertions could be evaluated (no consent flow, default, or update specified)', ...(ev ? { evidence: ev } : {}) };
  }
  let worst: Status = 'Pass';
  for (const s of subs) if (RANK[s.status] > RANK[worst]) worst = s.status;
  const reason = subs
    .filter((s) => s.status === worst && s.reason)
    .map((s) => s.reason as string)
    .join('; ');
  const result: CheckResult = { id: check.id, type: check.type, status: worst };
  if (worst !== 'Pass' && reason) result.reason = reason;
  if (ev) result.evidence = ev;
  return result;
}
