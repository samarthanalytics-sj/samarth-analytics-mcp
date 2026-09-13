// Pure tests for the unified tracking-status roll-up. Run:
//   tsx src/shared/__tests__/tracking-status.test.ts
import {
  buildTrackingStatus,
  isDedupFinding,
  type DimensionResult,
  type Dimension,
  type DimStatus,
  type TrackingStatusInput,
} from '../tracking-status';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── small builders for the input shapes ────────────────────────────────────────
type Chk = { id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'skip'; detail: string };
const chk = (id: string, status: Chk['status'], detail = `${id} detail`): Chk => ({ id, label: id, status, detail });
const setup = (checks: Chk[]): TrackingStatusInput['setup'] => ({ checks });
// The stable checkId the server audit stamps on the browser↔server dedup finding.
const DEDUP_CHECK_ID = 'server_capi_no_event_id';
// A realistic current dedup finding message (kept only to exercise the backwards-compat fallback).
const dedupMsg =
  'Meta CAPI server tag "Meta - Purchase" has auto-map (autoMapServerEventData) turned off and maps no explicit event_id … the browser and server events can double-count.';

const dim = (r: { dimensions: DimensionResult[] }, d: Dimension): DimensionResult =>
  r.dimensions.find((x) => x.dimension === d)!;
const statusOf = (r: { dimensions: DimensionResult[] }, d: Dimension): DimStatus => dim(r, d).status;

// ── SETUP dimension ────────────────────────────────────────────────────────────
{
  const allPass = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass'), chk('web_event_purchase', 'pass'), chk('server_client', 'pass')]) });
  check('setup: all pass → pass', statusOf(allPass, 'setup') === 'pass');

  const oneWarn = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass'), chk('web_event_purchase', 'warn')]) });
  check('setup: a warn → partial', statusOf(oneWarn, 'setup') === 'partial');

  const oneFail = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'fail'), chk('web_event_purchase', 'warn')]) });
  check('setup: any fail → fail (fail beats warn)', statusOf(oneFail, 'setup') === 'fail');

  // Only schema/consent/runtime checks present → no setup checks → not_run.
  const none = buildTrackingStatus({ setup: setup([chk('schema_purchase', 'pass'), chk('web_consent_defaults', 'pass'), chk('server_endpoint', 'pass')]) });
  check('setup: no setup-scoped checks → not_run', statusOf(none, 'setup') === 'not_run');

  // skip is ignored (does not make it not_run if a pass exists; does not fail).
  const withSkip = buildTrackingStatus({ setup: setup([chk('web_server_url', 'skip'), chk('web_google_tag', 'pass')]) });
  check('setup: skip ignored, pass wins', statusOf(withSkip, 'setup') === 'pass');
  const onlySkip = buildTrackingStatus({ setup: setup([chk('web_server_url', 'skip')]) });
  check('setup: only skip → not_run', statusOf(onlySkip, 'setup') === 'not_run');

  // Counts reflect pass/warn/fail (skip not counted anywhere).
  const counted = dim(buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass'), chk('web_event_a', 'warn'), chk('web_event_b', 'fail'), chk('web_server_url', 'skip')]) }), 'setup');
  check('setup: counts pass/warn/fail correctly', counted.passed === 1 && counted.warnings === 1 && counted.failures === 1);
}

// ── SCHEMA dimension (schema_ prefix) ──────────────────────────────────────────
{
  const r = buildTrackingStatus({ setup: setup([chk('schema_purchase', 'pass'), chk('schema_search_name', 'warn'), chk('web_google_tag', 'fail')]) });
  check('schema: only schema_ checks feed schema (warn → partial)', statusOf(r, 'schema') === 'partial');
  const fail = buildTrackingStatus({ setup: setup([chk('schema_purchase_name', 'fail')]) });
  check('schema: a schema fail → fail', statusOf(fail, 'schema') === 'fail');
  const nr = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass')]) });
  check('schema: no schema checks → not_run', statusOf(nr, 'schema') === 'not_run');
}

// ── CONSENT dimension (web_consent_defaults + consent findings) ────────────────
{
  const pass = buildTrackingStatus({ setup: setup([chk('web_consent_defaults', 'pass')]) });
  check('consent: passing check, no findings → pass', statusOf(pass, 'consent') === 'pass');

  const warnCheck = buildTrackingStatus({ setup: setup([chk('web_consent_defaults', 'warn')]) });
  check('consent: a warn check → partial', statusOf(warnCheck, 'consent') === 'partial');

  // A low-severity consent finding downgrades a passing check to partial.
  const lowFinding = buildTrackingStatus({
    setup: setup([chk('web_consent_defaults', 'pass')]),
    serverFindings: [{ severity: 'low', category: 'consent', message: 'minor consent nit' }],
  });
  check('consent: a low consent finding → partial', statusOf(lowFinding, 'consent') === 'partial');

  // A medium+ consent finding fails the dimension.
  const medFinding = buildTrackingStatus({
    setup: setup([chk('web_consent_defaults', 'pass')]),
    serverFindings: [{ severity: 'high', category: 'consent', message: 'ad pixel fires without consent' }],
  });
  check('consent: a medium+ consent finding → fail', statusOf(medFinding, 'consent') === 'fail');

  // Non-consent findings are ignored by the consent dimension.
  const ignoreOther = buildTrackingStatus({
    setup: setup([chk('web_consent_defaults', 'pass')]),
    serverFindings: [{ severity: 'critical', category: 'security', message: 'unrelated' }],
  });
  check('consent: non-consent findings ignored', statusOf(ignoreOther, 'consent') === 'pass');

  const nr = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass')]) });
  check('consent: no check + no findings → not_run', statusOf(nr, 'consent') === 'not_run');
}

// ── DEDUP dimension (missing-event_id finding) ─────────────────────────────────
{
  // PRIMARY: isDedupFinding matches the stable checkId regardless of message wording.
  check('dedup: isDedupFinding matches the stable checkId', isDedupFinding({ checkId: DEDUP_CHECK_ID }) === true);
  check('dedup: isDedupFinding matches the stable checkId even with an empty message', isDedupFinding({ checkId: DEDUP_CHECK_ID, message: '' }) === true);
  // FALLBACK: still matches by message (older audit builds / a reword) but not unrelated findings.
  check('dedup: isDedupFinding message fallback still matches', isDedupFinding({ message: dedupMsg }) === true);
  check('dedup: isDedupFinding rejects an unrelated ga4 finding', isDedupFinding({ checkId: 'B6-ad-pixel-consent', message: 'GA4 tag missing a measurement ID' }) === false);

  // A medium dedup finding (matched by checkId) → fail.
  const failR = buildTrackingStatus({ serverFindings: [{ severity: 'medium', category: 'ga4', checkId: DEDUP_CHECK_ID, message: dedupMsg }], hasServerContainer: true });
  check('dedup: a medium dedup finding → fail', statusOf(failR, 'dedup') === 'fail');

  // Only a low dedup finding → partial.
  const partialR = buildTrackingStatus({ serverFindings: [{ severity: 'low', category: 'ga4', checkId: DEDUP_CHECK_ID, message: dedupMsg }], hasServerContainer: true });
  check('dedup: only a low dedup finding → partial', statusOf(partialR, 'dedup') === 'partial');

  // Server audited, NO dedup finding → pass.
  const passR = buildTrackingStatus({ serverFindings: [{ severity: 'medium', category: 'naming', message: 'dup name' }], hasServerContainer: true });
  check('dedup: server audited, no dedup finding → pass', statusOf(passR, 'dedup') === 'pass');

  // No server container → not_run (even with an empty findings list).
  const nrR = buildTrackingStatus({ serverFindings: [], hasServerContainer: false });
  check('dedup: no server container → not_run', statusOf(nrR, 'dedup') === 'not_run');
}

// ── RUNTIME dimension (server_endpoint /healthy) ───────────────────────────────
{
  const pass = buildTrackingStatus({ setup: setup([chk('server_endpoint', 'pass')]) });
  check('runtime: /healthy pass → pass', statusOf(pass, 'runtime') === 'pass');
  const fail = buildTrackingStatus({ setup: setup([chk('server_endpoint', 'fail')]) });
  check('runtime: /healthy fail → fail', statusOf(fail, 'runtime') === 'fail');
  const nr = buildTrackingStatus({ setup: setup([chk('web_google_tag', 'pass')]) });
  check('runtime: no endpoint check (client-only) → not_run', statusOf(nr, 'runtime') === 'not_run');
}

// ── MANIFEST dimension (drift summary) ─────────────────────────────────────────
{
  const intact = buildTrackingStatus({ drift: { summary: { intact: 5, modified: 0, deleted: 0, unmanaged: 0 } } });
  check('manifest: all intact → pass', statusOf(intact, 'manifest') === 'pass');

  const modified = buildTrackingStatus({ drift: { summary: { intact: 4, modified: 1, deleted: 0, unmanaged: 0 } } });
  check('manifest: modified>0 → partial', statusOf(modified, 'manifest') === 'partial');

  const unmanaged = buildTrackingStatus({ drift: { summary: { intact: 4, modified: 0, deleted: 0, unmanaged: 2 } } });
  check('manifest: unmanaged>0 → partial', statusOf(unmanaged, 'manifest') === 'partial');

  const deleted = buildTrackingStatus({ drift: { summary: { intact: 3, modified: 2, deleted: 1, unmanaged: 0 } } });
  check('manifest: deleted>0 → fail (beats modified)', statusOf(deleted, 'manifest') === 'fail');

  const noManifest = buildTrackingStatus({ drift: null });
  check('manifest: no drift → not_run', statusOf(noManifest, 'manifest') === 'not_run');

  // Counts: passed=intact, warnings=modified+unmanaged, failures=deleted.
  const counts = dim(buildTrackingStatus({ drift: { summary: { intact: 3, modified: 2, deleted: 1, unmanaged: 4 } } }), 'manifest');
  check('manifest: counts map from the summary', counts.passed === 3 && counts.warnings === 6 && counts.failures === 1);
}

// ── OVERALL roll-up ────────────────────────────────────────────────────────────
{
  const empty = buildTrackingStatus({});
  check('overall: nothing supplied → all not_run → overall not_run', empty.overall === 'not_run' && empty.dimensions.every((d) => d.status === 'not_run'));
  check('overall: always six dimensions', buildTrackingStatus({}).dimensions.length === 6);

  const allPass = buildTrackingStatus({
    setup: setup([chk('web_google_tag', 'pass'), chk('web_consent_defaults', 'pass'), chk('schema_purchase', 'pass'), chk('server_endpoint', 'pass')]),
    drift: { summary: { intact: 2, modified: 0, deleted: 0, unmanaged: 0 } },
    hasServerContainer: true,
  });
  check('overall: everything pass/not_run → pass', allPass.overall === 'pass');

  const partial = buildTrackingStatus({
    setup: setup([chk('web_google_tag', 'pass'), chk('web_event_x', 'warn')]),
    drift: { summary: { intact: 2, modified: 0, deleted: 0, unmanaged: 0 } },
  });
  check('overall: a partial with no fail → partial', partial.overall === 'partial');

  const fail = buildTrackingStatus({
    setup: setup([chk('web_google_tag', 'pass'), chk('web_event_x', 'warn')]),
    serverFindings: [{ severity: 'medium', category: 'ga4', message: dedupMsg }],
    hasServerContainer: true,
  });
  check('overall: any fail → fail (dedup fail dominates the partial setup)', fail.overall === 'fail');
}

// ── topIssues truncation (max 3, worst-first) ──────────────────────────────────
{
  const many = dim(buildTrackingStatus({
    setup: setup([
      chk('web_event_a', 'fail', 'A failed'),
      chk('web_event_b', 'fail', 'B failed'),
      chk('web_event_c', 'warn', 'C warned'),
      chk('web_event_d', 'warn', 'D warned'),
      chk('web_event_e', 'warn', 'E warned'),
    ]),
  }), 'setup');
  check('topIssues: capped at 3', many.topIssues.length === 3);
  check('topIssues: fails come before warns', many.topIssues[0].includes('A failed') && many.topIssues[1].includes('B failed') && many.topIssues[2].includes('C warned'));
  check('topIssues: includes the label + detail', many.topIssues[0] === 'web_event_a: A failed');

  // manifest topIssues describe deleted/modified/unmanaged counts.
  const mDim = dim(buildTrackingStatus({ drift: { summary: { intact: 1, modified: 2, deleted: 3, unmanaged: 4 } } }), 'manifest');
  check('topIssues: manifest lists deleted first', mDim.topIssues[0].includes('3 managed resources DELETED'));

  // dedup topIssues carry the finding messages (worst-first).
  const dDim = dim(buildTrackingStatus({
    serverFindings: [
      { severity: 'low', category: 'ga4', message: `TikTok ${dedupMsg}` },
      { severity: 'medium', category: 'ga4', message: `Meta ${dedupMsg}` },
    ],
    hasServerContainer: true,
  }), 'dedup');
  check('topIssues: dedup sorts worst finding first', dDim.topIssues[0].startsWith('Meta '));
}

console.log(`\ntracking-status: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
