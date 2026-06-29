// Pure GA4 growth / anomaly engine. The Audit Brain rule: a sudden traffic spike (or drop) is
// often double-tagging, a bot wave, a launch, or broken tracking — it must be correlated to a
// cause, not filed as a neutral baseline stat. So this compares the window vs the prior period for
// sessions AND the outcomes that should move with real growth (key events, revenue), and grades to
// the WORST unverified branch: a spike conversions didn't track may be junk traffic (engagement
// inflated) OR broken conversion tracking (revenue under-reported right now) — until one is ruled
// out, grade for the worse. Returning-user share is weighed as evidence for/against pure-bot. No
// I/O — the data layer feeds counts in, so the thresholds are fully unit-testable.

import type { ScorecardFinding } from './scorecard';

export interface Ga4GrowthInput {
  sessions: number;
  priorSessions: number;
  keyEvents: number;
  priorKeyEvents: number;
  revenue: number;
  priorRevenue: number;
  /** Largest channel by sessions — names the likely driver in the finding. */
  topChannel?: string | null;
  /** Returning-user share of the window (0–100) — a share that didn't collapse argues against pure bot. */
  returningSharePct?: number | null;
  /** Share of sessions with no usable source (Unassigned / "(not set)", 0–100) — evidence about the spike. */
  noSourceSharePct?: number | null;
}

/** A growth finding carries the structured fields the verdict/expanded-finding sections need. */
export interface Ga4GrowthFinding extends ScorecardFinding {
  evidence?: string;
  whyItMatters?: string;
  ifUnconfirmed?: string;
  businessRisk?: string;
}

export interface Ga4GrowthResult {
  sessionsTrendPct: number | null;
  keyEventsTrendPct: number | null;
  revenueTrendPct: number | null;
  /** True when the prior window had enough traffic to judge a spike/drop at all. */
  assessed: boolean;
  findings: Ga4GrowthFinding[];
}

const GROWTH = 'growth';
const fnum = (n: number): string => Math.round(n).toLocaleString('en-US');
const sign = (p: number): string => `${p >= 0 ? '+' : ''}${p}%`;
const trendPct = (cur: number, prior: number): number | null => (prior > 0 ? Math.round(((cur - prior) / prior) * 100) : null);

// The prior window must have meaningful traffic before a percentage swing means anything.
const MIN_PRIOR_SESSIONS = 100;
// >= +50% is the band where the Brain says "correlate to a cause"; a doubling (>= +100%) that
// conversions didn't track is a revenue-integrity risk → Critical. <= -40% is a sharp drop.
const SPIKE_PCT = 50;
const BIG_SPIKE_PCT = 100;
const DROP_PCT = -40;
// "Scaled" = the outcome grew at least half as fast as sessions. Below that, conversions did not
// track the traffic and the spike is suspect (junk/bot traffic or broken conversion tracking).
const SCALE_RATIO = 0.5;
// Minimum absolute key-event volume before a percentage "scaled" verdict is trusted — a +1-on-1
// conversion delta reads as +100% but is noise, not evidence the spike converted.
const MIN_KEY_EVENTS = 30;

export function auditGa4Growth(input: Ga4GrowthInput): Ga4GrowthResult {
  const st = trendPct(input.sessions, input.priorSessions);
  const kt = trendPct(input.keyEvents, input.priorKeyEvents);
  const rt = trendPct(input.revenue, input.priorRevenue);
  const findings: Ga4GrowthFinding[] = [];
  const driver = input.topChannel ? ` (largest channel: ${input.topChannel})` : '';
  const assessed = input.priorSessions >= MIN_PRIOR_SESSIONS && st !== null;

  if (assessed && st !== null) {
    if (st >= SPIKE_PCT) {
      const movement = `Sessions grew ${sign(st)} vs the prior period (${fnum(input.priorSessions)} → ${fnum(input.sessions)})`;
      // An outcome "scaled" with the traffic if it grew at least half as fast as sessions on a real
      // volume, OR went from ~0 to a meaningful amount this period (a brand-new conversion/revenue
      // stream is real growth, not a failure to track).
      const convScaled =
        input.priorKeyEvents === 0
          ? input.keyEvents >= MIN_KEY_EVENTS
          : kt !== null && kt >= st * SCALE_RATIO && input.keyEvents >= MIN_KEY_EVENTS;
      const revScaled = input.revenue > 0 && (input.priorRevenue === 0 || (rt !== null && rt >= st * SCALE_RATIO));
      const scaled = convScaled || revScaled;
      const enoughToJudge =
        input.keyEvents >= MIN_KEY_EVENTS || input.priorKeyEvents >= MIN_KEY_EVENTS || input.revenue > 0 || input.priorRevenue > 0;

      if (scaled) {
        const parts: string[] = [];
        if (convScaled) parts.push(input.priorKeyEvents === 0 ? `key events are new this period (${fnum(input.keyEvents)})` : `key events ${kt !== null ? sign(kt) : 'n/a'}`);
        if (revScaled) parts.push(input.priorRevenue === 0 ? 'revenue is new this period' : `revenue ${rt !== null ? sign(rt) : 'n/a'}`);
        findings.push({
          severity: 'info',
          category: GROWTH,
          message: `${movement} and ${parts.join(' and ')} moved with it — consistent with a real launch or campaign rather than a tracking artifact.`,
          recommendation: `Confirm the driver${driver} is an intended campaign; no fix needed if expected.`,
        });
      } else if (enoughToJudge) {
        // Grade to the WORSE branch: broken conversion tracking (revenue under-reported now) outranks
        // junk/bot traffic (engagement inflated). Returning-user share tilts the likely cause.
        const ret = input.returningSharePct ?? null;
        const noSrc = input.noSourceSharePct ?? null;
        let natureLine: string;
        if (ret !== null && ret >= 15) {
          natureLine = `Returning users are still ${Math.round(ret)}% of traffic, so this is unlikely to be pure bot/junk — broken conversion tracking is the more probable cause, which means revenue is under-reported.`;
        } else if (ret !== null && ret < 5) {
          natureLine = `Returning users are only ${Math.round(ret)}% of traffic, consistent with bot or one-off traffic — but broken conversion tracking must still be ruled out before trusting revenue.`;
        } else {
          natureLine = `It cannot yet be told apart: junk/bot traffic vs broken conversion tracking.`;
        }
        const srcLine =
          noSrc !== null && noSrc >= 8
            ? ` ~${Math.round(noSrc)}% of sessions arrive without source attribution (see data quality), typical of social in-app browsers stripping the referrer.`
            : '';
        const kPart = kt === null ? `are minimal (${fnum(input.keyEvents)} this period)` : `grew only ${sign(kt)}`;
        const rPart = rt === null ? 'no revenue is recorded' : `revenue grew ${sign(rt)}`;
        const big = st >= BIG_SPIKE_PCT;
        findings.push({
          severity: big ? 'critical' : 'high',
          category: GROWTH,
          message: `${movement} but conversions did not keep pace (key events ${kPart}, ${rPart}) — the spike is unconfirmed and your revenue/ROAS may be wrong right now.`,
          evidence: `Sessions ${sign(st)} (${fnum(input.priorSessions)} → ${fnum(input.sessions)}); key events ${kt === null ? 'n/a' : sign(kt)}; revenue ${rt === null ? 'n/a' : sign(rt)}.${srcLine}`,
          whyItMatters: `If conversion tracking broke for the new traffic, revenue and ROAS are under-reported in live reports today and ad-spend decisions are being made on a wrong number. ${natureLine}`,
          ifUnconfirmed: `Graded to the worse branch — broken conversion tracking (revenue understated), not merely junk/bot traffic (engagement inflated) — because neither can be ruled out from the Admin/Data API.`,
          businessRisk: `Revenue & ROAS unreliable today; campaign spend decisions at risk.`,
          recommendation: `Treat revenue/ROAS as unverified until confirmed: in GA4 DebugView/Realtime, verify purchase and key events still fire for the new traffic and the tag isn't double-firing; trace the source${driver}.`,
        });
      } else {
        const evText = input.keyEvents > 0 || input.priorKeyEvents > 0 ? `${fnum(input.keyEvents)} key event(s)` : 'no key events';
        findings.push({
          severity: 'medium',
          category: GROWTH,
          message: `${movement}, but there isn't enough conversion signal (${evText}, no/low revenue) to confirm whether it's real growth or bot/junk traffic.`,
          recommendation: `Mark conversions as key events if missing, then confirm the spike's source${driver} in Realtime/DebugView and rule out double-tagging or bots before trusting the increase.`,
        });
      }
    } else if (st <= DROP_PCT) {
      findings.push({
        severity: 'medium',
        category: GROWTH,
        message: `Sessions fell ${sign(st)} vs the prior period (${fnum(input.priorSessions)} → ${fnum(input.sessions)}) — a sharp drop can indicate broken or blocked tagging, a tracking regression, or seasonality.`,
        recommendation: 'Confirm the GA4 tag still fires (Realtime), review recent site/tag releases and consent changes, and rule out seasonality before treating this as a real decline.',
      });
    }
  }

  return { sessionsTrendPct: st, keyEventsTrendPct: kt, revenueTrendPct: rt, assessed, findings };
}
