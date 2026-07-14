// Pure tests for the Workspace Comparison engine (no GTM access). Run with tsx.
import { toWorkspaceInput, diffWorkspaces, compareWorkspaces, pairHeadline, stableStringify } from '../workspace-diff';
import type { ContainerSnapshot, AuditTag, AuditTrigger, AuditVariable } from '../gtm-builders';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean): void => { if (cond) passed += 1; else { failed += 1; failures.push(name); } };

const tag = (over: Partial<AuditTag> & { name: string; tagId: string }): AuditTag =>
  ({ type: 'googtag', firingTriggerId: [], paused: false, parameter: [], ...over });
const trig = (over: Partial<AuditTrigger> & { name: string; triggerId: string }): AuditTrigger =>
  ({ type: 'pageview', ...over });
const vari = (over: Partial<AuditVariable> & { name: string; variableId: string }): AuditVariable =>
  ({ type: 'c', parameter: [], ...over });
const snap = (over: Partial<ContainerSnapshot>): ContainerSnapshot =>
  ({ tags: [], triggers: [], variables: [], ...over });

// ── stableStringify: order-independent ───────────────────────────────────────────────────────────────
check('stableStringify: key order does not matter', stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }));

// ── added / removed / unchanged ──────────────────────────────────────────────────────────────────────
{
  const a = toWorkspaceInput('1', 'Base', snap({ tags: [tag({ name: 'GA4 Config', tagId: 't1' })] }));
  const b = toWorkspaceInput('2', 'Draft', snap({ tags: [tag({ name: 'GA4 Config', tagId: 't9' }), tag({ name: 'Meta Pixel', tagId: 't2' })] }));
  const d = diffWorkspaces(a, b);
  const byName = new Map(d.entities.map((e) => [e.name, e]));
  check('added: a tag only in B is "added"', byName.get('Meta Pixel')!.status === 'added');
  check('unchanged: same-name same-config tag (different id) is "unchanged"', byName.get('GA4 Config')!.status === 'unchanged');
  check('summary: 1 added, 1 unchanged', d.summary.added === 1 && d.summary.unchanged === 1 && d.summary.removed === 0);
  check('byKind: 1 tag added', d.summary.byKind.tag.added === 1);
}
{
  const a = toWorkspaceInput('1', 'Base', snap({ variables: [vari({ name: 'Old Var', variableId: 'v1' })] }));
  const b = toWorkspaceInput('2', 'Draft', snap({}));
  const d = diffWorkspaces(a, b);
  check('removed: a variable only in A is "removed"', d.entities[0].status === 'removed' && d.entities[0].kind === 'variable');
}

// ── changed: field-level ─────────────────────────────────────────────────────────────────────────────
{
  const a = toWorkspaceInput('1', 'Base', snap({ tags: [tag({ name: 'GA4', tagId: 't1', paused: false, parameter: [{ type: 'template', key: 'measurementId', value: 'G-AAA' }] })] }));
  const b = toWorkspaceInput('2', 'Draft', snap({ tags: [tag({ name: 'GA4', tagId: 't1', paused: true, parameter: [{ type: 'template', key: 'measurementId', value: 'G-BBB' }] })] }));
  const d = diffWorkspaces(a, b);
  const e = d.entities[0];
  check('changed: a differing tag is "changed"', e.status === 'changed');
  const changed = new Map((e.changes ?? []).map((c) => [c.field, c]));
  check('changed: paused flip is reported', changed.get('paused')!.a === 'false' && changed.get('paused')!.b === 'true');
  check('changed: the measurement-id param change is reported', changed.get('param:measurementId')!.a === 'G-AAA' && changed.get('param:measurementId')!.b === 'G-BBB');
  check('changed: unchanged fields are NOT reported', !changed.has('type'));
}

// ── trigger-id churn must NOT show as a change (resolve firing ids to trigger NAMES) ──────────────────
{
  const a = toWorkspaceInput('1', 'Base', snap({
    triggers: [trig({ name: 'All Pages', triggerId: '2147479553' })],
    tags: [tag({ name: 'GA4', tagId: 't1', firingTriggerId: ['2147479553'] })],
  }));
  const b = toWorkspaceInput('2', 'Draft', snap({
    triggers: [trig({ name: 'All Pages', triggerId: '99' })], // SAME trigger, different id in this workspace
    tags: [tag({ name: 'GA4', tagId: 't1', firingTriggerId: ['99'] })],
  }));
  const d = diffWorkspaces(a, b);
  const ga4 = d.entities.find((e) => e.name === 'GA4')!;
  check('trigger-id churn: same trigger name → tag is unchanged (no false diff on ids)', ga4.status === 'unchanged');
}

// ── folders ──────────────────────────────────────────────────────────────────────────────────────────
{
  const a = toWorkspaceInput('1', 'Base', snap({}), [{ name: 'GA4' }]);
  const b = toWorkspaceInput('2', 'Draft', snap({}), [{ name: 'GA4' }, { name: 'Ads' }]);
  const d = diffWorkspaces(a, b);
  check('folders: a new folder is "added"', d.entities.some((e) => e.kind === 'folder' && e.name === 'Ads' && e.status === 'added'));
}

// ── multi-workspace: base vs each ────────────────────────────────────────────────────────────────────
{
  const w1 = toWorkspaceInput('1', 'Base', snap({ tags: [tag({ name: 'A', tagId: 't1' })] }));
  const w2 = toWorkspaceInput('2', 'Draft A', snap({ tags: [tag({ name: 'A', tagId: 't1' }), tag({ name: 'B', tagId: 't2' })] }));
  const w3 = toWorkspaceInput('3', 'Draft B', snap({ tags: [tag({ name: 'A', tagId: 't1' })] }));
  const res = compareWorkspaces('GTM-X', [w1, w2, w3]);
  check('multi: base-vs-each produces N-1 pairs', res.pairs.length === 2);
  check('multi: base is the first workspace', res.baseWorkspaceId === '1');
  check('multi: pair 1 (Draft A) has 1 added', res.pairs[0].summary.added === 1);
  check('multi: pair 2 (Draft B) is identical', res.pairs[1].summary.added + res.pairs[1].summary.removed + res.pairs[1].summary.changed === 0);
  check('multi: workspace counts carried', res.workspaces[1].counts.tag === 2);
  check('headline: identical pair reads "identical"', /identical/i.test(pairHeadline(res.pairs[1])));
  check('headline: changed pair names the counts', /added/i.test(pairHeadline(res.pairs[0])));
}

// ── guard: need >= 2 workspaces ──────────────────────────────────────────────────────────────────────
{
  let threw = false;
  try { compareWorkspaces('GTM-X', [toWorkspaceInput('1', 'Only', snap({}))]); } catch { threw = true; }
  check('guard: comparing < 2 workspaces throws', threw);
}

console.log(`\nworkspace-diff: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 20) { console.error(`expected >= 20 checks, got ${passed}`); process.exit(1); }
