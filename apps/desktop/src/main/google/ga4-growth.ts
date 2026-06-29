// Pure GA4 growth / anomaly engine. The Audit Brain rule: a sudden traffic spike (or drop) is
// often double-tagging, a bot wave, a launch, or broken tracking — it must be correlated to a
// cause, not filed as a neutral baseline stat. So this compares the window vs the prior period for
// sessions AND the outcomes that should move with real growth (key events, revenue), and decides
// whether the change is trustworthy. No I/O — the data layer feeds current/prior counts in, so the
// thresholds are fully unit-testable.

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
}

export interface Ga4GrowthResult {
  sessionsTrendPct: number | null;
  keyEventsTrendPct: number | null;
  revenueTrendPct: number | null;
  /** True when the prior window had enough traffic to judge a spike/drop at all. */
  assessed: boolean;
  findings: ScorecardFinding[];
}

const GROWTH = 'growth';
const fnum = (n: number): string => Math.round(n).toLocaleString('en-US');
const sign = (p: number): string => `${p >= 0 ? '+' : ''}${p}%`;
const trendPct = (cur: number, prior: number): number | null => (prior > 0 ? Math.round(((cur - prior) / prior) * 100) : null);

// The prior window must have meaningful traffic before a percentage swing means anything.
const MIN_PRIOR_SESSIONS = 100;
// >= +50% is the band where the Brain says "correlate to a cause"; <= -40% is a sharp drop.
const SPIKE_PCT = 50;
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
  const findings: ScorecardFinding[] = [];
  const driver = input.topChannel ? ` (largest channel: ${input.topChannel})` : '';
  const assessed = input.priorSessions >= MIN_PRIOR_SESSIONS && st !== null;

  if (assessed && st !== null) {
    if (st >= SPIKE_PCT) {
      const movement = `Sessions grew ${sign(st)} vs the prior period (${fnum(input.priorSessions)} → ${fnum(input.sessions)})`;
      // An outcome "scaled" with the traffic if it grew at least half as fast as sessions on a real
      // volume, OR it went from ~0 to a meaningful amount this period — a brand-new conversion/revenue
      // stream is real growth, not a failure to track. (prior == 0 makes the % trend null, so handle
      // it explicitly rather than letting a null trend fall through to "did not scale".)
      const convScaled =
        input.priorKeyEvents === 0
          ? input.keyEvents >= MIN_KEY_EVENTS
          : kt !== null && kt >= st * SCALE_RATIO && input.keyEvents >= MIN_KEY_EVENTS;
      const revScaled = input.revenue > 0 && (input.priorRevenue === 0 || (rt !== null && rt >= st * SCALE_RATIO));
      const scaled = convScaled || revScaled;
      // Enough of a conversion/revenue baseline to call a NON-scaled spike "broken/junk" with confidence.
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
        const kPart = kt === null ? `are minimal (${fnum(input.keyEvents)} this period, none before)` : `only grew ${sign(kt)}`;
        const rPart = rt === null ? 'no revenue is recorded' : `revenue grew ${sign(rt)}`;
        findings.push({
          severity: 'high',
          category: GROWTH,
          message: `${movement}, but key events ${kPart} and ${rPart} — conversions did not track the traffic spike. This usually means junk/bot traffic or broken conversion tracking, not real growth.`,
          recommendation: `Identify the spike's source${driver}; check Realtime/DebugView for bot patterns, verify the GA4 tag is not double-firing, and confirm conversions still record for the new traffic before reporting this as growth.`,
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
