// Pure GA4 audit SCORING brain — deterministic, no I/O, no clock. Takes the area roll-up + findings
// the audit already produced and returns two rule-based headline numbers plus the supporting tables:
//   - Reporting reliability % (data-trust): how much of this property's data is safe to quote today,
//     derived from the Data Trust Matrix (Not-Verified evidence neither helps nor hurts).
//   - Composite /100 (+ letter grade): a WEIGHTED per-category scorecard. Pass=100, Partial=50,
//     Fail=0 per area; a category with no verified area is Not Verified, excluded, and its weight
//     redistributed over the scored categories. The number is computed by rule, never judged.
// Scoring follows the audit-brain spec: four status words only, Pass earned by positive evidence,
// Not Verified excluded from the number and reported as a count.

export interface ScorecardArea {
  area: string;
  statusKey: 'pass' | 'partial' | 'fail' | 'not_verified';
}
export interface ScorecardFindingLite {
  severity: string; // critical | high | medium | low | info
  category: string; // collection | conversions | data_quality | growth | …
}
export interface Ga4ScorecardInput {
  areas: ScorecardArea[];
  findings: ScorecardFindingLite[];
  /** Whether the growth/anomaly check actually ran (enough prior traffic). When false, the
   *  conversion/revenue trust rows state the comparison didn't run rather than claiming "verified safe". */
  growthAssessed?: boolean;
}

export interface ScorecardCategory {
  name: string;
  weight: number; // nominal weight (categories sum to 100)
  subscore: number | null; // 0-100; null = Not Verified (excluded from the composite)
  status: 'pass' | 'partial' | 'fail' | 'not_verified';
  contribution: number; // renormalised points this category adds to the composite (1 dp)
  /** Renormalised weight over the VERIFIED categories (0..1; 0 when Not Verified). The redistribution
   *  a scorecard footnote must honour — effective weights of scored categories sum to 1.0. */
  effectiveWeight: number;
}
export type TrustVerdict = 'safe' | 'caution' | 'unverified' | 'do_not_quote';
/** One line of the reliability RECEIPT: a metric that is not earning its full weight, with the
 *  points it costs, the SPECIFIC gate responsible, and the action that recovers them. Rendered under
 *  the headline so a low number always reads as "your property's verification state", never as an
 *  arbitrary judgement by the tool. */
export interface ReliabilityWhyRow {
  metric: string;
  /** This metric's share of the 100-point scale. */
  weightPct: number;
  /** Points this metric is currently NOT earning (weight × missing gate credit). */
  lostPts: number;
  verdict: TrustVerdict;
  /** The gate(s) responsible, e.g. "traffic-vs-conversion tracking failed". */
  cause: string;
  /** What recovers the points. */
  fix: string;
}

export interface TrustRow {
  metric: string;
  /** PASS-GATED verdict: SAFE only when EVERY gating check passed. A failed gate → do_not_quote; a
   *  missing/unverified gate → unverified (never safe — not-failed is not the same as passed); a
   *  partial gate → caution. */
  verdict: TrustVerdict;
  /** verdict === 'safe' — kept for consumers that only need the boolean. */
  safe: boolean;
  reason: string;
  /** The gating checks this metric requires — ALL must pass for "safe to quote". */
  requires: string[];
}
export interface Ga4Scorecard {
  composite: number | null; // weighted /100; null if nothing was scored
  grade: string; // A–F, or 'N/A'
  reliabilityPct: number; // 0-100 data-trust
  reliabilityConfidence: string; // 'High confidence' | 'Medium confidence' | 'Low confidence'
  /** When a decision-critical metric (conversions, revenue) is unverified/failed the headline is
   *  capped below the High band; these are the metrics that capped it (empty = uncapped). */
  reliabilityCappedBy: string[];
  /** Itemized points-lost receipt (biggest loss first) - why the headline is not higher. */
  reliabilityWhy: ReliabilityWhyRow[];
  categories: ScorecardCategory[];
  trust: TrustRow[];
  notVerifiedAreas: number;
}

const STATUS_SCORE: Record<string, number> = { pass: 100, partial: 50, fail: 0 };
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

// The six scorecard categories and the config areas that roll into each. "Data Quality" has no config
// area — it's derived from the data-quality + growth/anomaly findings (the live-data integrity layer).
const CATEGORY_DEFS: Array<{ name: string; weight: number; areas: string[] }> = [
  { name: 'Configuration', weight: 18, areas: ['Data collection', 'Data retention', 'Benchmarking'] },
  { name: 'Event Tracking', weight: 20, areas: ['Custom definitions', 'Ecommerce'] },
  { name: 'Key Events', weight: 18, areas: ['Key events'] },
  { name: 'Data Quality', weight: 22, areas: [] },
  { name: 'Audiences & Attribution', weight: 12, areas: ['Audiences', 'Attribution', 'Integrations'] },
  { name: 'Consent & Compliance', weight: 10, areas: ['Consent', 'Privacy (PII)'] },
];

// What a downstream consumer would quote, and the weight each carries toward "is the data trustworthy".
const TRUST_WEIGHT: Record<string, number> = {
  'Sessions, users, engagement rate': 30,
  'Conversion counts': 25,
  'Revenue / AOV / ROAS': 20,
  'Channel attribution': 15,
  'Smart Bidding optimisation': 10,
};

// Category status = the WORST verified member status. Status and subscore derive from the SAME
// member statuses, so they can never contradict each other (a category holding a failed area reads
// Fail even when its mean subscore lands in the "partial" band).
const WORST_RANK: Record<'pass' | 'partial' | 'fail', number> = { fail: 3, partial: 2, pass: 1 };

export function buildGa4Scorecard(input: Ga4ScorecardInput): Ga4Scorecard {
  const { areas, findings } = input;
  const statusOf = new Map(areas.map((a) => [a.area, a.statusKey]));

  // Data Quality category = worst of the data-quality + growth/anomaly + integrity findings. (The
  // channel-grouping gate below deliberately uses ONLY 'data_quality' so an ecommerce/event integrity
  // issue affects the Data Quality SCORE without falsely gating Channel-attribution trust.)
  const dqGrowthWorst = findings
    .filter((f) => f.category === 'data_quality' || f.category === 'growth' || f.category === 'integrity')
    .reduce((m, f) => Math.max(m, SEV_RANK[f.severity] ?? 0), 0);
  const dqStatus: 'pass' | 'partial' | 'fail' = dqGrowthWorst >= 3 ? 'fail' : dqGrowthWorst >= 1 ? 'partial' : 'pass';

  const categories: ScorecardCategory[] = CATEGORY_DEFS.map((def) => {
    if (def.name === 'Data Quality') {
      return { name: def.name, weight: def.weight, subscore: STATUS_SCORE[dqStatus], status: dqStatus, contribution: 0, effectiveWeight: 0 };
    }
    const verified = def.areas
      .map((a) => statusOf.get(a))
      .filter((s): s is 'pass' | 'partial' | 'fail' => s === 'pass' || s === 'partial' || s === 'fail');
    if (verified.length === 0) return { name: def.name, weight: def.weight, subscore: null, status: 'not_verified', contribution: 0, effectiveWeight: 0 };
    const subscore = Math.round(verified.reduce((sum, s) => sum + STATUS_SCORE[s], 0) / verified.length);
    const status = verified.reduce<'pass' | 'partial' | 'fail'>((w, s) => (WORST_RANK[s] > WORST_RANK[w] ? s : w), 'pass');
    return { name: def.name, weight: def.weight, subscore, status, contribution: 0, effectiveWeight: 0 };
  });

  // Composite: renormalise the weights over the categories that actually scored, so Not-Verified
  // categories neither help nor hurt and the contributions sum to the composite. The redistribution
  // is exposed per category (effectiveWeight) so a footnote can honour it — scored weights sum to 1.
  const scored = categories.filter((c) => c.subscore !== null);
  const totalWeight = scored.reduce((s, c) => s + c.weight, 0);
  let composite: number | null = null;
  if (totalWeight > 0) {
    let sum = 0;
    for (const c of scored) {
      c.effectiveWeight = c.weight / totalWeight;
      const points = (c.subscore as number) * c.effectiveWeight;
      c.contribution = Math.round(points * 10) / 10;
      sum += points;
    }
    composite = Math.round(sum);
  }
  const grade =
    composite === null ? 'N/A' : composite >= 90 ? 'A' : composite >= 80 ? 'B' : composite >= 70 ? 'C' : composite >= 60 ? 'D' : 'F';

  // ── Data Trust Matrix — PASS-GATED ────────────────────────────────────────
  // A metric is SAFE TO QUOTE only when EVERY gating check PASSED. Not-failed is not the same as
  // passed: a failed gate → DO NOT QUOTE; a gate that could not be verified (didn't run / no data)
  // → UNVERIFIED, never safe — this is the fix for "revenue safe while the traffic-vs-conversion
  // comparison never ran". A partial gate → QUOTE WITH CAUTION.
  type GateStatus = 'pass' | 'partial' | 'fail' | 'not_verified';
  const areaGate = (area: string): GateStatus => statusOf.get(area) ?? 'not_verified';
  const worstIn = (cat: string): number =>
    findings.filter((f) => f.category === cat).reduce((m, f) => Math.max(m, SEV_RANK[f.severity] ?? 0), 0);

  const collectionGate = areaGate('Data collection');
  const ecommerceGate = areaGate('Ecommerce');
  const consentGate = areaGate('Consent');
  // Key events: the configured area, degraded by conversion-integrity findings.
  const convWorst = worstIn('conversions');
  const keyEventsBase = areaGate('Key events');
  const keyEventsGate: GateStatus =
    keyEventsBase === 'fail' || convWorst >= 3 ? 'fail'
    : keyEventsBase === 'not_verified' ? 'not_verified'
    : keyEventsBase === 'partial' || convWorst >= 1 ? 'partial'
    : 'pass';
  // Traffic-vs-conversion tracking: only PASSES when the growth comparison actually RAN and
  // CONCLUDED cleanly. critical/high = failed. MEDIUM = ran but could NOT conclude (a spike with too
  // little conversion signal to judge, or a sharp drop that may be broken tagging) — that is an
  // unverified gate, never a pass. LOW (channel-mix dilution) is a concluded, non-blocking read and
  // keeps passing (the no-over-alarm rule). An unrun comparison is not_verified.
  const growthWorst = worstIn('growth');
  const growthGate: GateStatus =
    growthWorst >= 3 ? 'fail'
    : growthWorst >= 2 ? 'not_verified'
    : input.growthAssessed === true ? 'pass'
    : 'not_verified';
  // Channel grouping: unattributed-traffic findings first (medium+ = fail, low = partial), else
  // CONFIRMED channel-integrity anti-lie findings (a concentration burst, campaign/channel revenue
  // that does not reconcile, or self-referrals) cap the gate at partial — the split exists but is
  // measurably distorted, so it must read CAUTION, never SAFE — else the Attribution area's own
  // status (not_verified when attribution settings weren't readable).
  const dqWorst = worstIn('data_quality');
  const chanIntegrityWorst = Math.max(worstIn('concentration'), worstIn('attribution_mismatch'), worstIn('self_referral'));
  const attributionBase = areaGate('Attribution');
  // The anti-lie degrade only ever pulls a PASS down to partial - it must never upgrade a failed or
  // unverified gate (that would mint credit from a finding).
  const channelGate: GateStatus =
    dqWorst >= 2 ? 'fail'
    : dqWorst >= 1 ? 'partial'
    : chanIntegrityWorst >= 1 && attributionBase === 'pass' ? 'partial'
    : attributionBase;
  // Window integrity: a confirmed single-bucket burst (concentration) or an invalid-traffic cluster
  // means the WINDOW TOTALS describe an event, not the business. The counts are real, so this caps
  // Sessions at CAUTION (partial) rather than do-not-quote — but "SAFE" alongside a finding that
  // says "distorts the headline session count" would be the report contradicting itself. The gate is
  // a pure DEGRADER: it only joins the spec when a distortion was actually measured, so its absence
  // never mints credit (an unrun check cannot make a metric safer, either).
  const windowWorst = Math.max(worstIn('concentration'), worstIn('invalid_traffic'));
  const sessionsGates: Array<[string, GateStatus]> = [['data collection', collectionGate]];
  if (windowWorst >= 1) sessionsGates.push(['window integrity', 'partial']);

  const TRUST_SPEC: Array<{ metric: string; gates: Array<[string, GateStatus]> }> = [
    { metric: 'Sessions, users, engagement rate', gates: sessionsGates },
    { metric: 'Conversion counts', gates: [['data collection', collectionGate], ['key events', keyEventsGate], ['traffic-vs-conversion tracking', growthGate]] },
    { metric: 'Revenue / AOV / ROAS', gates: [['data collection', collectionGate], ['ecommerce setup', ecommerceGate], ['traffic-vs-conversion tracking', growthGate]] },
    // Channel attribution ALSO needs collection: the channel split of sessions whose collection is
    // failing cannot be quotable while the sessions themselves are not.
    { metric: 'Channel attribution', gates: [['data collection', collectionGate], ['channel grouping', channelGate]] },
    { metric: 'Smart Bidding optimisation', gates: [['data collection', collectionGate], ['key events', keyEventsGate], ['traffic-vs-conversion tracking', growthGate], ['consent mode', consentGate]] },
  ];

  const trust: TrustRow[] = TRUST_SPEC.map(({ metric, gates }) => {
    const failed = gates.filter(([, s]) => s === 'fail').map(([n]) => n);
    const unverified = gates.filter(([, s]) => s === 'not_verified').map(([n]) => n);
    const partial = gates.filter(([, s]) => s === 'partial').map(([n]) => n);
    let verdict: TrustVerdict;
    let reason: string;
    if (failed.length) {
      verdict = 'do_not_quote';
      reason = `Gating check failed: ${failed.join(', ')} — do not quote this metric until fixed.`;
    } else if (unverified.length) {
      verdict = 'unverified';
      reason = `Not verified: ${unverified.join(', ')} — an unrun check cannot make a metric safe; verify before quoting.`;
    } else if (partial.length) {
      verdict = 'caution';
      reason = `Partial: ${partial.join(', ')} — quote with caution.`;
    } else {
      verdict = 'safe';
      reason = 'All gating checks passed.';
    }
    return { metric, verdict, safe: verdict === 'safe', reason, requires: gates.map(([n]) => n) };
  });
  // Reliability = Σ(quote_weight × share_of_this_metric's_gates_passed) / Σ(quote_weight).
  // Per-gate credit: pass = 1, partial = 0.5, fail / unrun = 0 — an unrun check cannot make a metric
  // safe (never scored 0.5 for being blocked). A metric whose verdict is UNVERIFIED or DO NOT QUOTE
  // contributes NOTHING regardless of individual gates: partially-checked-but-unquotable must not
  // raise the headline. So only SAFE/CAUTION metrics earn credit, and a caution metric earns the
  // FRACTION of its own gates that actually passed (not a flat one-half).
  const gateCredit = (s: GateStatus): number => (s === 'pass' ? 1 : s === 'partial' ? 0.5 : 0);
  const metricShare = (metric: string): number => {
    const spec = TRUST_SPEC.find((t) => t.metric === metric);
    if (!spec || !spec.gates.length) return 0;
    return spec.gates.reduce((s, [, g]) => s + gateCredit(g), 0) / spec.gates.length;
  };
  const rawReliability = Math.round(
    trust.reduce((s, t) => s + (TRUST_WEIGHT[t.metric] ?? 0) * (t.verdict === 'safe' || t.verdict === 'caution' ? metricShare(t.metric) : 0), 0),
  );
  // Critical-metric cap: a weighted average must not let clean traffic hide unquotable revenue. When
  // a decision-critical metric (conversions, revenue) is unverified or failed, the headline is capped
  // BELOW the High band and the capping metrics are named — the report says WHY the number stops there.
  const CRITICAL_METRICS = ['Conversion counts', 'Revenue / AOV / ROAS'];
  const reliabilityCappedBy = trust
    .filter((t) => CRITICAL_METRICS.includes(t.metric) && (t.verdict === 'unverified' || t.verdict === 'do_not_quote'))
    .map((t) => `${t.metric} (${t.verdict === 'do_not_quote' ? 'failed' : 'unverified'})`);
  const reliabilityPct = reliabilityCappedBy.length ? Math.min(rawReliability, 44) : rawReliability;
  // Confidence bands are calibrated to the pass-gated scale's REACHABLE range: the Admin API caps
  // Data collection at Partial and cannot read consent mode, so a genuinely clean production property
  // tops out near ~60 under gate-fraction credit — that IS the high band on this scale, and the critical-metric cap (44) always lands below it.
  const reliabilityConfidence = reliabilityPct >= 55 ? 'High confidence' : reliabilityPct >= 20 ? 'Medium confidence' : 'Low confidence';

  // ── The receipt: every point below 100 is attributed to a NAMED gate with its fix, so the low
  // number reads as the property's verification state, never the tool's opinion. Sorted by points
  // lost, biggest first. Gate → remedy wording is fixed here so all surfaces say the same thing.
  const GATE_FIX: Record<string, string> = {
    'traffic-vs-conversion tracking': 'Verify in GA4 DebugView/Realtime that purchase + key events fire for the new traffic; the gate passes on the next window where outcomes track the sessions.',
    'consent mode': 'Consent Mode is not readable via the Google APIs - verify it in DebugView / the tag setup once; it stays unverified until then.',
    'data collection': 'The Admin API can only see configuration; a window where sessions arrive every single day upgrades this automatically.',
    'ecommerce setup': 'Run a window with transactions: no duplicate transaction_ids and <5% missing ids upgrades revenue on evidence.',
    'key events': 'Fix the conversion-integrity findings (an event that stopped or dropped sharply) so key-event counts are trustworthy.',
    'channel grouping': 'Resolve the attribution findings (unattributed share, channel/campaign mismatch, self-referrals) so the channel split is quotable.',
    'window integrity': 'Segment or exclude the one-off burst (see the concentration finding) so window totals describe the business again.',
  };
  const reliabilityWhy: ReliabilityWhyRow[] = trust
    .map((t) => {
      const weight = TRUST_WEIGHT[t.metric] ?? 0;
      const earned = t.verdict === 'safe' || t.verdict === 'caution' ? metricShare(t.metric) : 0;
      const lostPts = Math.round(weight * (1 - earned) * 10) / 10;
      if (lostPts <= 0) return null;
      const spec = TRUST_SPEC.find((x) => x.metric === t.metric);
      // Cause lists every imperfect gate; the FIX targets the WORST one (a failed gate outranks an
      // unverified one outranks a partial) - that is the action that actually moves the verdict.
      const badRank: Record<string, number> = { fail: 3, not_verified: 2, partial: 1 };
      const bad = (spec?.gates ?? []).filter(([, g]) => g !== 'pass').sort((a, b) => (badRank[b[1]] ?? 0) - (badRank[a[1]] ?? 0));
      const cause = bad.length
        ? bad.map(([n, g]) => `${n} ${g === 'fail' ? 'FAILED' : g === 'not_verified' ? 'not verified' : 'partial'}`).join('; ')
        : 'gating checks incomplete';
      const fix = bad.map(([n]) => GATE_FIX[n]).find(Boolean) ?? 'Re-run once the blocking checks can execute.';
      return { metric: t.metric, weightPct: weight, lostPts, verdict: t.verdict, cause, fix };
    })
    .filter((r): r is ReliabilityWhyRow => r !== null)
    .sort((a, b) => b.lostPts - a.lostPts);

  return {
    composite,
    grade,
    reliabilityPct,
    reliabilityConfidence,
    reliabilityCappedBy,
    reliabilityWhy,
    categories,
    trust,
    notVerifiedAreas: areas.filter((a) => a.statusKey === 'not_verified').length,
  };
}
