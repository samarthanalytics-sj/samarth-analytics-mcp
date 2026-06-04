// Audit accuracy invariants — pure, dependency-free, framework-agnostic.
//
// For a public SaaS the dominant risk is *false confidence*: a config-only
// inspection phrased (or scored) as if it proved live behaviour. The audit rules
// in api/gtm/audit.ts already follow the right conventions by hand; this module
// turns those conventions into a single enforced normalizer so they cannot drift
// as new rules are added.
//
// Vercel-safe by construction: this file imports nothing (no node:*, no engine,
// no googleapis). Like shared/cache-keys.ts it is therefore safe to import at the
// top level from the `api/**` serverless routes — an unauthenticated probe still
// evaluates nothing heavy. See docs/AUDIT_ACCURACY.md for the model these helpers
// encode (evidence sources, confidence, coverage states, false-positive policy).

export type AccuracySource =
  | "CONFIG"
  | "RUNTIME"
  | "SGTM"
  | "GA4_ADMIN"
  | "DATA_API";
export type AccuracySeverity = "info" | "low" | "medium" | "high" | "critical";
export type AccuracyConfidence = "high" | "medium" | "low";

const CONFIG_ONLY_SOURCES: AccuracySource[] = ["CONFIG"];

/**
 * One structured piece of evidence backing a finding. Deliberately a small, flat
 * shape of *short, safe* strings — never raw JSON blobs. It records WHICH source
 * the evidence came from and a human-readable label, plus optional pointers
 * (entity path, parameter) and the value/snippet observed. The UI renders these
 * as compact rows so a reader can see exactly what the finding is grounded in.
 */
export interface EvidenceItem {
  /** The evidence source (CONFIG / RUNTIME / SGTM / GA4_ADMIN / DATA_API). */
  source: AccuracySource;
  /** Short human label, e.g. "GTM parameter", "Captured GA4 hit". */
  label: string;
  /** Short observed value/snippet. Callers must keep this brief and PII-safe. */
  value?: string;
  /** GTM entity path the evidence points at, e.g. "tags/12". */
  entityPath?: string;
  /** Implicated parameter / setting key, e.g. "firingTriggerId". */
  parameter?: string;
  /** Confidence this single piece of evidence carries, when meaningful. */
  confidence?: AccuracyConfidence;
}

/** Minimal finding shape this module reasons about; a real AuditFinding is a superset. */
export interface AccuracyFinding {
  finding?: string;
  title?: string;
  severity: AccuracySeverity;
  sources?: AccuracySource[];
  confidence?: AccuracyConfidence;
  needsManualReview?: boolean;
  /** Structured, short evidence rows. Normalized/derived when absent. */
  evidence?: EvidenceItem[];
  entity?: { name?: string; id?: string; path?: string };
  parameter?: string;
  /** Plain-language notes about any accuracy tightening applied (downgrades). */
  accuracyNotes?: string[];
  /** True when the normalizer lowered the supplied confidence. */
  confidenceDowngraded?: boolean;
}

/** Truncate a value to a short, log-safe length for evidence display. */
function shortValue(v: string | undefined, max = 160): string | undefined {
  if (!v) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Derive structured evidence for a finding from its existing fields when the
 * rule did not supply an explicit `evidence[]`. This never invents claims: it
 * only restates what the finding already references — its source(s), the GTM
 * entity it points at, and the implicated parameter — as short, safe rows. A
 * rule that wants richer evidence (a captured hit URL, a console line) should
 * pass `evidence[]` directly; this fills the floor so every finding carries at
 * least its provenance.
 */
export function deriveEvidence(
  f: Pick<AccuracyFinding, "sources" | "entity" | "parameter">,
): EvidenceItem[] {
  const sources: AccuracySource[] =
    f.sources && f.sources.length > 0 ? f.sources : CONFIG_ONLY_SOURCES;
  const primary = sources[0];
  const out: EvidenceItem[] = [];

  const entityPath = f.entity?.path;
  const entityName = f.entity?.name ?? f.entity?.id;
  if (entityName || entityPath) {
    out.push({
      source: primary,
      label: "GTM entity",
      value: shortValue(entityName),
      entityPath: entityPath,
    });
  }
  if (f.parameter) {
    out.push({
      source: primary,
      label: "Parameter / setting",
      parameter: f.parameter,
      entityPath: entityPath,
    });
  }
  if (out.length === 0) {
    // No entity/parameter pointer — record provenance so the row is never empty.
    out.push({ source: primary, label: "Evidence source" });
  }
  return out;
}

/**
 * Verbs/phrases that assert *observed runtime behaviour* (a tag actually fired,
 * double-fired, sent data on a real page load). A CONFIG-only finding must never
 * read as one of these — configuration is intent, not proof. Kept narrow and
 * word-boundaried so legitimate config wording ("configured to fire",
 * "firing trigger", "trigger fires the tag in GTM") is not falsely flagged: we
 * match the *assertive* forms, not the noun "trigger" or the config phrase
 * "firing trigger".
 */
export const RUNTIME_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bdouble[- ]?fires?\b/i,
  /\bdouble[- ]?fired\b/i,
  /\bis (?:actually )?firing\b/i,
  /\bare (?:actually )?firing\b/i,
  /\b(?:tag|pixel|event|hit) fires\b/i,
  /\bfires on\b/i,
  /\bfired (?:on|during|at runtime)\b/i,
  /\bsends? (?:a |an )?(?:\w+ ){1,3}on every\b/i,
  /\bobserved firing\b/i,
];

/** True if the text makes an assertion about observed runtime behaviour. */
export function containsRuntimeClaim(text: string | undefined): boolean {
  if (!text) return false;
  return RUNTIME_CLAIM_PATTERNS.some((re) => re.test(text));
}

/** A finding is "config-only" when CONFIG is its sole evidence source. */
export function isConfigOnly(sources: AccuracySource[] | undefined): boolean {
  const s = sources && sources.length > 0 ? sources : CONFIG_ONLY_SOURCES;
  return s.length === 1 && s[0] === "CONFIG";
}

/** True when only the CONFIG capability is connected (no runtime/cross-source). */
export function coverageIsConfigOnly(flags: {
  CONFIG?: boolean;
  RUNTIME?: boolean;
  SGTM?: boolean;
  GA4_ADMIN?: boolean;
  DATA_API?: boolean;
}): boolean {
  return (
    !!flags.CONFIG &&
    !flags.RUNTIME &&
    !flags.SGTM &&
    !flags.GA4_ADMIN &&
    !flags.DATA_API
  );
}

/** Canonical warning shown when CONFIG is the only connected source. */
export function configOnlyCoverageWarning(): string {
  return "Only CONFIG is connected. Cross-source reconciliation is Not Covered. A clean result from a single source is not a clean audit.";
}

/**
 * Default confidence for a finding given its sources and manual-review flag.
 * Mirrors (and centralizes) the rule used in api/gtm/audit.ts:
 * - anything needing manual review is "low",
 * - CONFIG-only is at most "medium" (intent, not observed behaviour),
 * - any non-CONFIG proof source lifts it to "high".
 */
export function defaultConfidence(
  sources: AccuracySource[] | undefined,
  needsManualReview: boolean | undefined,
): AccuracyConfidence {
  if (needsManualReview) return "low";
  const s = sources && sources.length > 0 ? sources : CONFIG_ONLY_SOURCES;
  if (isConfigOnly(s)) return "medium";
  if (s.includes("RUNTIME") || s.includes("SGTM") || s.includes("GA4_ADMIN")) {
    return "high";
  }
  return "medium";
}

const CONFIDENCE_RANK: Record<AccuracyConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Clamp a confidence so it is no higher than `ceiling`. */
function capConfidence(
  value: AccuracyConfidence,
  ceiling: AccuracyConfidence,
): AccuracyConfidence {
  return CONFIDENCE_RANK[value] > CONFIDENCE_RANK[ceiling] ? ceiling : value;
}

/**
 * Enforce the evidence-scoped accuracy invariants on a single finding and return
 * a corrected copy. Behaviour-compatible by design: it only ever *tightens*
 * (downgrades confidence/severity, sets manual-review) — it never invents a
 * higher severity or stronger confidence than a rule asked for, and it never
 * touches the id/category/text. Conservative policy:
 *
 *  1. sources/confidence are always populated (never undefined).
 *  2. CONFIG-only confidence is capped at "medium".
 *  3. A high/critical finding that is CONFIG-only AND flagged needsManualReview
 *     is downgraded to "medium" with "low" confidence — incomplete evidence must
 *     not present as a hard high-severity claim. Multi-source / runtime findings
 *     (which carry proof) are left untouched.
 *  4. If the finding text makes a runtime claim but RUNTIME is not among its
 *     sources, force needsManualReview (the wording asserts more than the
 *     evidence supports). This is the drift safety-net; rule copy is also fixed
 *     at the source so this rarely triggers in practice.
 */
export function normalizeFindingAccuracy<T extends AccuracyFinding>(
  f: T,
): T & {
  sources: AccuracySource[];
  severity: AccuracySeverity;
  confidence: AccuracyConfidence;
  needsManualReview: boolean;
  evidence: EvidenceItem[];
  confidenceDowngraded: boolean;
  accuracyNotes?: string[];
} {
  const sources: AccuracySource[] =
    f.sources && f.sources.length > 0 ? f.sources : CONFIG_ONLY_SOURCES;
  const configOnly = isConfigOnly(sources);
  const hasRuntime = sources.includes("RUNTIME");

  let needsManualReview = f.needsManualReview ?? false;
  let severity = f.severity;
  const notes: string[] = [];

  // (4) Wording asserts runtime behaviour without a RUNTIME source.
  if (!hasRuntime && containsRuntimeClaim(f.finding ?? f.title)) {
    if (!needsManualReview) {
      notes.push(
        "Wording implies observed runtime behaviour but no RUNTIME capture backs it — flagged for manual review.",
      );
    }
    needsManualReview = true;
  }

  const suppliedConfidence = f.confidence;
  let confidence: AccuracyConfidence =
    f.confidence ?? defaultConfidence(sources, needsManualReview);

  // (3) Incomplete CONFIG-only evidence must not present as high/critical.
  if (
    configOnly &&
    needsManualReview &&
    (severity === "high" || severity === "critical")
  ) {
    notes.push(
      `Severity reduced from ${severity} to medium: CONFIG-only evidence flagged for manual review cannot present as a hard ${severity} finding.`,
    );
    severity = "medium";
    confidence = "low";
  }

  // (2) CONFIG-only is capped at medium confidence.
  if (configOnly) {
    const capped = capConfidence(confidence, "medium");
    if (capped !== confidence) {
      notes.push(
        "Confidence capped at medium: configuration intent is not proof of runtime behaviour (CONFIG-only).",
      );
    }
    confidence = capped;
  }
  // Manual-review findings are never high confidence.
  if (needsManualReview) {
    const capped = capConfidence(confidence, "low");
    if (capped !== confidence) {
      notes.push(
        "Confidence lowered to low: this finding needs manual review to confirm.",
      );
    }
    confidence = capped;
  }

  // A downgrade is any tightening of the *supplied* confidence (or a default
  // confidence that landed below "high" because of a cap). We only flag when a
  // caller-supplied value was actively lowered, so callers that omit confidence
  // are not spuriously marked as "downgraded".
  const confidenceDowngraded =
    suppliedConfidence !== undefined &&
    CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[suppliedConfidence];

  // Evidence floor: keep any explicit evidence the rule supplied, else derive a
  // provenance row from sources/entity/parameter. Never empty.
  const evidence: EvidenceItem[] =
    f.evidence && f.evidence.length > 0
      ? f.evidence
      : deriveEvidence({ sources, entity: f.entity, parameter: f.parameter });

  const accuracyNotes =
    notes.length > 0
      ? [...(f.accuracyNotes ?? []), ...notes]
      : f.accuracyNotes;

  return {
    ...f,
    sources,
    severity,
    confidence,
    needsManualReview,
    evidence,
    confidenceDowngraded,
    ...(accuracyNotes ? { accuracyNotes } : {}),
  };
}
