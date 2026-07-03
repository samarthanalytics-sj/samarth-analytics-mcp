// Pure GA4 data-integrity engines — the reporting-data checks the config + data-quality passes can't
// see: a per-event regression (a key event silently dropping to zero = a broken tag) and duplicate /
// unlabelled ecommerce transactions (double-counted revenue). No I/O — the data layer runs the report
// queries and feeds the counts in, so the thresholds are fully unit-testable.

import type { ScorecardFinding } from './scorecard';

// A dedicated category (NOT 'data_quality') so these ecommerce/event findings feed the Data Quality
// SCORE without being mistaken for the channel-attribution ("Unassigned"/"(not set)") signal that
// gates the Channel-attribution trust row in the scorecard.
const INTEGRITY = 'integrity';
const fnum = (n: number): string => Math.round(n).toLocaleString('en-US');

/* ── Per-event deltas ── */

export interface Ga4EventDeltaInput {
  /** eventName → count this window and the prior equal window. */
  events: Array<{ name: string; count: number; priorCount: number }>;
  /** The property's KEY EVENT names — a key event dropping to 0 is unambiguously serious (high); a
   *  non-key event dropping to 0 could also be a retired campaign / seasonal event (medium). */
  keyEventNames?: string[];
}

// An event needs a meaningful prior volume before a swing means anything (a 5→0 delta is noise).
const MIN_PRIOR = 30;
// Only flag a NON-zero plunge on a clearly-established event, and only when it lost most of its volume.
const PLUNGE_MIN_PRIOR = 100;
const PLUNGE_RATIO = 0.2;

export function auditGa4EventDeltas(input: Ga4EventDeltaInput): ScorecardFinding[] {
  const findings: ScorecardFinding[] = [];
  const events = input.events ?? [];
  const keyEvents = new Set(input.keyEventNames ?? []);

  // Events that fired meaningfully last period and are now ZERO. A KEY event going silent is almost
  // certainly a broken tag (high); a non-key event could instead be a retired campaign / seasonal
  // event, so it is graded medium with that framing rather than asserted broken.
  const dropped = events
    .filter((e) => e.priorCount >= MIN_PRIOR && e.count === 0)
    .sort((a, b) => b.priorCount - a.priorCount);
  for (const e of dropped.slice(0, 5)) {
    if (keyEvents.has(e.name)) {
      findings.push({
        severity: 'high',
        category: INTEGRITY,
        message: `Key event "${e.name}" stopped firing entirely (${fnum(e.priorCount)} in the prior period, 0 now) — a key event going silent is almost always a broken or removed tag, and the conversions and reports built on it are now empty.`,
        recommendation: `Check the tag/trigger that sends "${e.name}" (GTM or gtag) in GA4 DebugView/Realtime; a recent site or tag release is the usual cause.`,
      });
    } else {
      findings.push({
        severity: 'medium',
        category: INTEGRITY,
        message: `Event "${e.name}" stopped firing entirely (${fnum(e.priorCount)} in the prior period, 0 now) — likely a broken/removed tag, though a retired campaign or seasonal event that legitimately ended is also possible.`,
        recommendation: `Confirm whether "${e.name}" is meant to still fire; if so, check its tag/trigger in DebugView (a recent release is the usual cause).`,
      });
    }
  }

  // Established events that lost MOST of their volume (a partial regression), excluding the zero case above.
  const plunged = events
    .filter((e) => e.priorCount >= PLUNGE_MIN_PRIOR && e.count > 0 && e.count < e.priorCount * PLUNGE_RATIO)
    .sort((a, b) => b.priorCount - a.priorCount);
  for (const e of plunged.slice(0, 3)) {
    const pctDrop = Math.round((1 - e.count / e.priorCount) * 100);
    findings.push({
      severity: 'medium',
      category: INTEGRITY,
      message: `Event "${e.name}" fell ${pctDrop}% (${fnum(e.priorCount)} → ${fnum(e.count)}) vs the prior period — a partial tracking regression (tag firing intermittently, a consent change) or a genuine behavior shift.`,
      recommendation: `Verify "${e.name}" still fires reliably in DebugView; rule out a tag/consent/release change before treating the drop as real.`,
    });
  }

  return findings;
}

/* ── Ecommerce transaction integrity ── */

export interface Ga4TransactionInput {
  /** Only run when the property actually tracks ecommerce (has purchase/item key events). */
  hasEcommerce: boolean;
  /** transactionId → purchase-event count (top-N by count; '(not set)' handled via notSetShare). */
  transactions: Array<{ id: string; purchases: number }>;
  /** Share (0–100) of purchase events whose transactionId is "(not set)". */
  notSetShare: number;
}

export function auditGa4Transactions(input: Ga4TransactionInput): ScorecardFinding[] {
  const findings: ScorecardFinding[] = [];
  if (!input.hasEcommerce) return findings;

  // A transactionId with more than one purchase event was double-fired → the same order counted twice.
  const dupes = (input.transactions ?? []).filter((t) => t.id && !/\(not set\)/i.test(t.id) && t.purchases > 1);
  if (dupes.length) {
    const extra = dupes.reduce((s, t) => s + (t.purchases - 1), 0);
    findings.push({
      severity: 'high',
      category: INTEGRITY,
      message: `${fnum(dupes.length)} transaction id(s) recorded more than one purchase (${fnum(extra)} duplicate purchase event(s)) — duplicate purchases double-count revenue and conversions, inflating ROAS and misinforming ad bidding.`,
      recommendation: 'Fix the double-firing purchase tag/trigger (a purchase should fire once per order) and/or add event-level deduplication; confirm in DebugView that a refresh/back-navigation does not re-fire purchase.',
    });
  }

  // Purchases without a transaction_id can't be de-duplicated and break item/revenue reconciliation.
  if (input.notSetShare >= 5) {
    findings.push({
      severity: input.notSetShare >= 20 ? 'high' : 'medium',
      category: INTEGRITY,
      message: `${input.notSetShare.toFixed(1)}% of purchases have no transaction_id ("(not set)") — GA4 cannot deduplicate those purchases, so revenue may be double-counted and item-level reporting is unreliable.`,
      recommendation: 'Ensure every purchase event carries a unique transaction_id (and value + currency).',
    });
  }

  return findings;
}
