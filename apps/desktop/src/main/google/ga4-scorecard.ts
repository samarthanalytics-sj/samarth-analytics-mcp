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
}
export interface TrustRow {
  metric: string;
  safe: boolean;
  reason: string;
}
export interface Ga4Scorecard {
  composite: number | null; // weighted /100; null if nothing was scored
  grade: string; // A–F, or 'N/A'
  reliabilityPct: number; // 0-100 data-trust
  reliabilityConfidence: string; // 'High confidence' | 'Medium confidence' | 'Low confidence'
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

const statusFromScore = (s: number): 'pass' | 'partial' | 'fail' => (s >= 75 ? 'pass' : s >= 40 ? 'partial' : 'fail');

export function buildGa4Scorecard(input: Ga4ScorecardInput): Ga4Scorecard {
  const { areas, findings } = input;
  const statusOf = new Map(areas.map((a) => [a.area, a.statusKey]));

  // Data Quality category = worst of the data-quality + growth/anomaly findings.
  const dqGrowthWorst = findings
    .filter((f) => f.category === 'data_quality' || f.category === 'growth')
    .reduce((m, f) => Math.max(m, SEV_RANK[f.severity] ?? 0), 0);
  const dqStatus: 'pass' | 'partial' | 'fail' = dqGrowthWorst >= 3 ? 'fail' : dqGrowthWorst >= 1 ? 'partial' : 'pass';

  const categories: ScorecardCategory[] = CATEGORY_DEFS.map((def) => {
    if (def.name === 'Data Quality') {
      return { name: def.name, weight: def.weight, subscore: STATUS_SCORE[dqStatus], status: dqStatus, contribution: 0 };
    }
    const verified = def.areas
      .map((a) => statusOf.get(a))
      .filter((s): s is 'pass' | 'partial' | 'fail' => s === 'pass' || s === 'partial' || s === 'fail');
    if (verified.length === 0) return { name: def.name, weight: def.weight, subscore: null, status: 'not_verified', contribution: 0 };
    const subscore = Math.round(verified.reduce((sum, s) => sum + STATUS_SCORE[s], 0) / verified.length);
    return { name: def.name, weight: def.weight, subscore, status: statusFromScore(subscore), contribution: 0 };
  });

  // Composite: renormalise the weights over the categories that actually scored, so Not-Verified
  // categories neither help nor hurt and the contributions sum to the composite.
  const scored = categories.filter((c) => c.subscore !== null);
  const totalWeight = scored.reduce((s, c) => s + c.weight, 0);
  let composite: number | null = null;
  if (totalWeight > 0) {
    let sum = 0;
    for (const c of scored) {
      const points = ((c.subscore as number) * c.weight) / totalWeight;
      c.contribution = Math.round(points * 10) / 10;
      sum += points;
    }
    composite = Math.round(sum);
  }
  const grade =
    composite === null ? 'N/A' : composite >= 90 ? 'A' : composite >= 80 ? 'B' : composite >= 70 ? 'C' : composite >= 60 ? 'D' : 'F';

  // Data Trust Matrix — what a client can safely quote from this audit, by rule.
  const serious = (f: ScorecardFindingLite): boolean => f.severity === 'critical' || f.severity === 'high';
  const growthSerious = findings.some((f) => f.category === 'growth' && serious(f));
  const keyEventIssue = findings.some((f) => f.category === 'conversions' && f.severity !== 'info');
  const attribSerious = findings.some((f) => f.category === 'data_quality' && (SEV_RANK[f.severity] ?? 0) >= 2);
  const collectionFail = statusOf.get('Data collection') === 'fail';
  const convSafe = !growthSerious && !keyEventIssue;
  // "Not assessed" ≠ "verified safe": when the growth comparison didn't run, say so rather than
  // claiming the metric demonstrably tracked traffic (honours the Not-Verified-≠-Pass principle).
  const assessed = input.growthAssessed === true;
  const unran = ' — but the traffic-vs-conversion comparison did not run this window (insufficient prior traffic); quote with caution.';

  const trust: TrustRow[] = [
    {
      metric: 'Sessions, users, engagement rate',
      safe: !collectionFail,
      reason: collectionFail ? 'Data collection is failing — session metrics are unreliable.' : 'No collection failure detected; session metrics are usable (deep collection health is not API-verifiable).',
    },
    {
      metric: 'Conversion counts',
      safe: convSafe,
      reason: !convSafe
        ? 'Conversions did not track the traffic (or key-event setup is unverified) — counts may be wrong.'
        : assessed
          ? 'Key events tracked the traffic over this window.'
          : 'No conversion-tracking anomaly found' + unran,
    },
    {
      metric: 'Revenue / AOV / ROAS',
      safe: !growthSerious,
      reason: growthSerious
        ? 'A traffic spike conversions did not track means revenue may be under-reported — resolve before quoting.'
        : assessed
          ? 'Revenue moved with traffic; safe to quote with the usual caveats.'
          : 'No revenue anomaly found' + unran,
    },
    {
      metric: 'Channel attribution',
      safe: !attribSerious,
      reason: attribSerious ? 'A material share of sessions arrive without source data — channel grouping is unreliable.' : 'Channel grouping is clean enough for media-mix analysis.',
    },
    {
      metric: 'Smart Bidding optimisation',
      safe: convSafe,
      reason: !convSafe
        ? "Don't run value-based bidding until the conversion-integrity findings are resolved."
        : assessed
          ? 'Conversion signal is reliable enough to feed value-based bidding.'
          : 'Conversion signal looks intact, but it was not stress-tested against a traffic change this window.',
    },
  ];
  const reliabilityPct = Math.round(trust.filter((t) => t.safe).reduce((s, t) => s + (TRUST_WEIGHT[t.metric] ?? 0), 0));
  const reliabilityConfidence = reliabilityPct >= 75 ? 'High confidence' : reliabilityPct >= 40 ? 'Medium confidence' : 'Low confidence';

  return {
    composite,
    grade,
    reliabilityPct,
    reliabilityConfidence,
    categories,
    trust,
    notVerifiedAreas: areas.filter((a) => a.statusKey === 'not_verified').length,
  };
}
