// Pure engine: rule-based "Key insights" for the GA4 audit baseline — short, plain-English bullets that
// call out the peaks, the lows, and the notable points across the Section-6 breakdown tables. Entirely
// DETERMINISTIC (computed from the data, no LLM), so it can never invent a claim; every superlative is
// picked by an explicit max/min with a volume guard so a tiny high-variance row can't win.
//
// Trust guard: the whole conversion-based analysis is suppressed when the property's conversion rates
// are implausibly high (a non-conversion event marked as a key event) — instead we surface THAT as the
// insight, because "best converting channel" is meaningless when everything converts at ~100%.

import type { Ga4Baseline } from './data-service';

const n = (x: number): string => Math.round(x).toLocaleString('en-US');
const pct = (x: number): number => Math.round(x * 100);
const money = (x: number, cur: string): string => `${cur ? cur + ' ' : ''}${n(x)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtYmd(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  const mi = m ? Number(m[2]) - 1 : -1;
  return m && mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(m[3])}` : ymd; // guard malformed month → raw date, never "undefined"
}

function topBy<T>(rows: T[], key: (r: T) => number): T | null {
  return rows.length ? rows.reduce((best, r) => (key(r) > key(best) ? r : best)) : null;
}
// Best conversion among rows carrying at least `minShare` of the table's sessions — so a 5-session row
// at 100% can never be called "best converting".
function bestConv<T extends { sessions: number; convRate: number }>(rows: T[], minShare: number): T | null {
  const total = rows.reduce((a, r) => a + r.sessions, 0);
  const eligible = rows.filter((r) => total > 0 && r.sessions >= minShare * total);
  return eligible.length ? eligible.reduce((b, r) => (r.convRate > b.convRate ? r : b)) : null;
}

const FUNNEL_LABEL: Record<string, string> = { view_item: 'View item', add_to_cart: 'Add to cart', begin_checkout: 'Begin checkout', purchase: 'Purchase' };

/** Zero or more one-line insight bullets, most-notable first. Empty when there's no baseline.
 *  `trust` carries the Data Trust Matrix verdicts for conversion counts and revenue; a bullet whose
 *  claim leans on an unverified metric is tagged "(provisional - … unverified)" so a superlative like
 *  "converts best" isn't read as established fact. Omitting `trust` treats both as safe, so callers
 *  that don't compute the matrix (and the engine's own unit tests) are unchanged. */
export function deriveGa4Insights(
  baseline: Ga4Baseline | null,
  currency: string,
  trust?: { convSafe: boolean; revSafe: boolean },
): string[] {
  if (!baseline) return [];
  const b = baseline;
  const cur = currency || '';
  const convSafe = trust?.convSafe ?? true;
  const revSafe = trust?.revSafe ?? true;
  const provisional = (dep: 'conv' | 'rev' | 'convrev'): string => {
    const conv = (dep === 'conv' || dep === 'convrev') && !convSafe;
    const rev = (dep === 'rev' || dep === 'convrev') && !revSafe;
    if (conv && rev) return ' (provisional - conversion & revenue unverified)';
    if (conv) return ' (provisional - conversion tracking unverified)';
    if (rev) return ' (provisional - revenue unverified)';
    return '';
  };
  const out: string[] = [];

  // 1. Peak day (only when it's genuinely a spike vs the daily average).
  if (b.peakDay && b.dailySessions.length >= 3) {
    const avg = b.dailySessions.reduce((a, d) => a + d.sessions, 0) / b.dailySessions.length;
    const over = avg > 0 ? Math.round((b.peakDay.sessions / avg - 1) * 100) : 0;
    if (over >= 20) out.push(`Traffic peaked on ${fmtYmd(b.peakDay.date)} at ${n(b.peakDay.sessions)} sessions - ${over}% above the daily average.`);
  }

  // 2. Near-100% conversion-rate flag (data quality). Session-weighted: if channels carrying most of the
  //    traffic all "convert" above 50%, a non-conversion event is almost certainly marked as a key event.
  const ch = b.channelPerformance ?? [];
  const chTotal = ch.reduce((a, c) => a + c.sessions, 0);
  const inflatedShare = chTotal > 0 ? ch.filter((c) => c.convRate > 0.5).reduce((a, c) => a + c.sessions, 0) / chTotal : 0;
  const convUnreliable = ch.length >= 2 && inflatedShare > 0.5;
  if (convUnreliable) {
    out.push('Conversion rates are near 100% on the channels that carry most of your traffic - this almost always means a non-conversion event (like view_item or session_start) is marked as a key event. Mark only true conversions (purchase, sign_up) so the rate reflects real outcomes.');
  }

  // 3. Channel: top revenue, plus best conversion when the rate is trustworthy.
  if (ch.length >= 2) {
    const topRev = topBy(ch, (c) => c.revenue);
    if (topRev && topRev.revenue > 0) {
      const bc = convUnreliable ? null : bestConv(ch, 0.05);
      if (bc && bc.channel === topRev.channel) {
        out.push(`${topRev.channel} brings the most revenue (${money(topRev.revenue, cur)}) and converts best at ${pct(bc.convRate)}%.${provisional('convrev')}`);
      } else {
        let s = `${topRev.channel} brings the most revenue (${money(topRev.revenue, cur)}).`;
        if (bc) s += ` ${bc.channel} converts best at ${pct(bc.convRate)}%.`;
        out.push(s + provisional(bc ? 'convrev' : 'rev'));
      }
    }
  }

  // 4. Landing-page leak: a high-volume entry page converting well below the best (trustworthy only).
  const lp = b.landingPages ?? [];
  if (lp.length >= 2 && !convUnreliable) {
    const topVol = topBy(lp, (p) => p.sessions);
    const bestP = bestConv(lp, 0.05);
    // topVol is the highest-volume page by construction, but on a tiny property even the top page can be
    // negligible — require real traffic (>=100 sessions) before calling it a "CRO opportunity".
    if (topVol && bestP && bestP.page !== topVol.page && topVol.sessions >= 100 && topVol.convRate > 0 && topVol.convRate < bestP.convRate * 0.6) {
      out.push(`${topVol.page} is your top entry page (${n(topVol.sessions)} sessions) but converts at only ${pct(topVol.convRate)}%, below ${bestP.page}'s ${pct(bestP.convRate)}% - the clearest CRO opportunity.${provisional('conv')}`);
    }
  }

  // 5. Device: most-volume vs best-converting differ (trustworthy only).
  const dev = b.devicePerformance ?? [];
  if (dev.length >= 2 && !convUnreliable) {
    const topVol = topBy(dev, (d) => d.sessions);
    const bc = bestConv(dev, 0.1);
    if (topVol && bc && bc.device !== topVol.device && bc.convRate > topVol.convRate) {
      out.push(`Most visits are on ${topVol.device} but ${bc.device} converts better (${pct(bc.convRate)}% vs ${pct(topVol.convRate)}%) - worth checking the ${topVol.device} experience.${provisional('conv')}`);
    }
  }

  // 6. Funnel biggest drop-off.
  const fs = b.funnelSteps ?? [];
  if (fs.length >= 2 && (fs[0]?.users ?? 0) > 0) {
    let worst = { drop: -1, from: '', to: '' };
    for (let i = 1; i < fs.length; i++) {
      const prev = fs[i - 1].users;
      if (prev > 0) {
        const drop = 1 - fs[i].users / prev;
        if (drop > worst.drop) worst = { drop, from: FUNNEL_LABEL[fs[i - 1].event] ?? fs[i - 1].event, to: FUNNEL_LABEL[fs[i].event] ?? fs[i].event };
      }
    }
    if (worst.drop >= 0.1) out.push(`Biggest funnel drop-off: ${worst.from} to ${worst.to}, where ${Math.round(worst.drop * 100)}% of users leave.${provisional('conv')}`);
  }

  // 7. AI-assistant channel materiality (emerging channel).
  const llm = b.llmTraffic ?? [];
  if (llm.length) {
    const aiSessions = llm.reduce((a, c) => a + c.sessions, 0);
    const share = b.sessions > 0 ? (aiSessions / b.sessions) * 100 : 0;
    const shareTxt = share > 0 && share < 0.1 ? '<0.1' : share.toFixed(1);
    const top = topBy(llm, (c) => c.sessions);
    out.push(`AI assistants sent ${n(aiSessions)} sessions (${shareTxt}% of traffic)${top ? `, led by ${top.source}` : ''} - an emerging channel to watch.`);
  }

  return out;
}
