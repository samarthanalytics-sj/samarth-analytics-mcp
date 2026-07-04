// Framework-free "unified tracking status" roll-up. This does NOT re-audit —
// it AGGREGATES the outputs of the existing audits (verify_tracking_setup, the
// server-container audit, install-drift) into ONE card of 6 named DIMENSIONS,
// each with a single verdict, so a user sees at a glance:
//
//   setup ✓  consent ✓  schema ⚠  dedup ✗  runtime ✓  manifest ⚠
//
// PURE: no I/O, no googleapis. Only TYPE imports (erased at compile time) from
// the modules that own each source shape — importing types can never create a
// runtime cycle, and keeps this in lock-step with the real report shapes.

import type { TrackingSetupReport, TrackingSetupCheck, AuditFinding } from '../main/google/gtm-builders';
import type { DriftReport } from './install-manifest';

export type Dimension = 'setup' | 'consent' | 'schema' | 'dedup' | 'runtime' | 'manifest';
export type DimStatus = 'pass' | 'partial' | 'fail' | 'not_run';

export interface DimensionResult {
  dimension: Dimension;
  status: DimStatus;
  passed: number;
  warnings: number;
  failures: number;
  /** Up to 3 human-readable strings describing the worst items in this dimension. */
  topIssues: string[];
}

export interface TrackingStatusReport {
  overall: DimStatus;
  dimensions: DimensionResult[];
}

/** The minimal shapes this roll-up reads. They intentionally mirror the exported
 *  report types (via `import type` above) but are declared structurally on the
 *  input so a partial/stubbed report is still accepted. */
export interface TrackingStatusInput {
  /** Output of verify_tracking_setup (the pure checklist + the /healthy check the
   *  data-service appends). */
  setup?: Pick<TrackingSetupReport, 'checks'> | null;
  /** Findings from the SERVER container audit (auditServerContainer().findings) —
   *  the source of the dedup + consent signals. */
  serverFindings?: Array<Pick<AuditFinding, 'severity' | 'category' | 'message'>> | null;
  /** Install-manifest drift (diffManifest()). */
  drift?: Pick<DriftReport, 'summary'> | null;
  /** True when a SERVER container was actually audited — lets `dedup` distinguish
   *  "audited, no dedup problem" (pass) from "no server side to check" (not_run). */
  hasServerContainer?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
/** medium and up — the threshold at which a consent finding escalates a dimension. */
const isMediumPlus = (sev: string): boolean => (SEVERITY_RANK[sev] ?? 0) >= SEVERITY_RANK.medium;

type CheckLike = Pick<TrackingSetupCheck, 'status' | 'detail' | 'label'>;

/** Roll a set of pass/warn/fail/skip checks into a DimStatus: any fail → fail,
 *  else any warn → partial, else any pass → pass, else (only skips / empty) →
 *  not_run. `skip` never counts. */
function statusFromChecks(checks: CheckLike[]): DimStatus {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === 'fail') fail += 1;
    else if (c.status === 'warn') warn += 1;
    else if (c.status === 'pass') pass += 1;
    // 'skip' ignored
  }
  if (fail > 0) return 'fail';
  if (warn > 0) return 'partial';
  if (pass > 0) return 'pass';
  return 'not_run';
}

/** Human-readable line for a failing/warning check: prefer a label + detail. */
function checkIssue(c: CheckLike): string {
  const label = c.label ? `${c.label}: ` : '';
  return `${label}${c.detail ?? ''}`.trim();
}

/** Count + summarise a set of checks into a DimensionResult (worst-first topIssues). */
function dimFromChecks(dimension: Dimension, checks: CheckLike[]): DimensionResult {
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const failures = checks.filter((c) => c.status === 'fail').length;
  const worst = [
    ...checks.filter((c) => c.status === 'fail'),
    ...checks.filter((c) => c.status === 'warn'),
  ]
    .map(checkIssue)
    .filter(Boolean)
    .slice(0, 3);
  return { dimension, status: statusFromChecks(checks), passed, warnings, failures, topIssues: worst };
}

/** Does a setup check id belong to the SETUP dimension (plumbing coverage)? */
function isSetupCheck(id: string): boolean {
  return (
    id === 'web_google_tag' ||
    id === 'web_server_url' ||
    id === 'server_client' ||
    id === 'server_tagging_url' ||
    id.startsWith('web_event_') ||
    id.startsWith('server_event_')
  );
}

/** The single dedup finding auditServerContainer emits carries NO checkId and its
 *  category is the generic 'ga4' — so it is identified by its message signature:
 *  "sends no event_id" AND "deduplicate the browser and server events". */
export function isDedupFinding(f: { message?: string }): boolean {
  const m = f.message ?? '';
  return m.includes('sends no event_id') && m.includes('deduplicate the browser and server events');
}

// ── per-dimension mappings ─────────────────────────────────────────────────────

function buildSetup(byId: (pred: (id: string) => boolean) => CheckLike[]): DimensionResult {
  return dimFromChecks('setup', byId(isSetupCheck));
}

function buildSchema(byId: (pred: (id: string) => boolean) => CheckLike[]): DimensionResult {
  return dimFromChecks('schema', byId((id) => id.startsWith('schema_')));
}

function buildRuntime(byId: (pred: (id: string) => boolean) => CheckLike[]): DimensionResult {
  // The live /healthy probe. Absent for a client-only setup → not_run.
  return dimFromChecks('runtime', byId((id) => id === 'server_endpoint'));
}

/** consent = the web consent-defaults check + any server-side consent findings.
 *  A fail/warn on the check, OR any consent finding, downgrades the dimension;
 *  a medium+ consent finding (or a failing check) makes it fail. */
function buildConsent(
  byId: (pred: (id: string) => boolean) => CheckLike[],
  consentFindings: Array<Pick<AuditFinding, 'severity' | 'message'>>
): DimensionResult {
  const checks = byId((id) => id === 'web_consent_defaults');
  let passed = checks.filter((c) => c.status === 'pass').length;
  let warnings = checks.filter((c) => c.status === 'warn').length;
  let failures = checks.filter((c) => c.status === 'fail').length;
  const issues: string[] = [
    ...checks.filter((c) => c.status === 'fail'),
    ...checks.filter((c) => c.status === 'warn'),
  ].map(checkIssue);

  // Fold the server-side consent findings in: medium+ → a failure, otherwise a warning.
  const sortedFindings = [...consentFindings].sort(
    (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
  );
  for (const f of sortedFindings) {
    if (isMediumPlus(f.severity)) failures += 1;
    else warnings += 1;
    issues.push(f.message);
  }

  let status: DimStatus;
  if (failures > 0) status = 'fail';
  else if (warnings > 0) status = 'partial';
  else if (passed > 0) status = 'pass';
  else status = 'not_run';

  return { dimension: 'consent', status, passed, warnings, failures, topIssues: issues.filter(Boolean).slice(0, 3) };
}

/** dedup = the missing-event_id findings from the server audit.
 *  - any medium+ dedup finding → fail; only-low findings → partial.
 *  - a server container WAS audited but no dedup finding → pass.
 *  - no server container (client-only / no server CAPI) → not_run. */
function buildDedup(
  dedupFindings: Array<Pick<AuditFinding, 'severity' | 'message'>>,
  hasServerContainer: boolean
): DimensionResult {
  if (dedupFindings.length > 0) {
    const sorted = [...dedupFindings].sort(
      (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    );
    const anyMediumPlus = sorted.some((f) => isMediumPlus(f.severity));
    return {
      dimension: 'dedup',
      status: anyMediumPlus ? 'fail' : 'partial',
      passed: 0,
      warnings: anyMediumPlus ? 0 : sorted.length,
      failures: anyMediumPlus ? sorted.length : 0,
      topIssues: sorted.map((f) => f.message).slice(0, 3),
    };
  }
  if (hasServerContainer) {
    return { dimension: 'dedup', status: 'pass', passed: 1, warnings: 0, failures: 0, topIssues: [] };
  }
  return { dimension: 'dedup', status: 'not_run', passed: 0, warnings: 0, failures: 0, topIssues: [] };
}

/** manifest = install-drift summary. deleted>0 → fail; modified/unmanaged>0 →
 *  partial; all intact → pass; no manifest → not_run. */
function buildManifest(drift: Pick<DriftReport, 'summary'> | null | undefined): DimensionResult {
  if (!drift) {
    return { dimension: 'manifest', status: 'not_run', passed: 0, warnings: 0, failures: 0, topIssues: [] };
  }
  const { intact, modified, deleted, unmanaged } = drift.summary;
  const topIssues: string[] = [];
  if (deleted > 0) topIssues.push(`${deleted} managed resource${deleted === 1 ? '' : 's'} DELETED since setup.`);
  if (modified > 0) topIssues.push(`${modified} managed resource${modified === 1 ? '' : 's'} MODIFIED since setup.`);
  if (unmanaged > 0) topIssues.push(`${unmanaged} UNMANAGED resource${unmanaged === 1 ? '' : 's'} added outside setup.`);

  let status: DimStatus;
  if (deleted > 0) status = 'fail';
  else if (modified > 0 || unmanaged > 0) status = 'partial';
  else if (intact > 0) status = 'pass';
  else status = 'not_run';

  return {
    dimension: 'manifest',
    status,
    passed: intact,
    warnings: modified + unmanaged,
    failures: deleted,
    topIssues: topIssues.slice(0, 3),
  };
}

/** Roll the per-dimension verdicts up: fail if ANY dimension fails; else partial
 *  if any is partial; else pass if any passes; else not_run. not_run is neutral. */
function rollUp(dimensions: DimensionResult[]): DimStatus {
  if (dimensions.some((d) => d.status === 'fail')) return 'fail';
  if (dimensions.some((d) => d.status === 'partial')) return 'partial';
  if (dimensions.some((d) => d.status === 'pass')) return 'pass';
  return 'not_run';
}

// ── entry point ────────────────────────────────────────────────────────────────

/** Aggregate the existing audit outputs into the 6-dimension status card. PURE. */
export function buildTrackingStatus(input: TrackingStatusInput): TrackingStatusReport {
  const byId = (pred: (id: string) => boolean): CheckLike[] =>
    ((input.setup?.checks ?? []) as TrackingSetupCheck[]).filter((c) => pred(c.id));

  const findings = (input.serverFindings ?? []) as Array<Pick<AuditFinding, 'severity' | 'category' | 'message'>>;
  const consentFindings = findings.filter((f) => f.category === 'consent');
  const dedupFindings = findings.filter(isDedupFinding);

  const dimensions: DimensionResult[] = [
    buildSetup(byId),
    buildConsent(byId, consentFindings),
    buildSchema(byId),
    buildDedup(dedupFindings, Boolean(input.hasServerContainer)),
    buildRuntime(byId),
    buildManifest(input.drift),
  ];

  return { overall: rollUp(dimensions), dimensions };
}
