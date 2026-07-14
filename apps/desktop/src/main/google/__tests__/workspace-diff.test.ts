// Pure tests for the Workspace Comparison engine (no GTM access). Run with tsx.
import { toWorkspaceInput, diffWorkspaces, compareWorkspaces, consolidateWorkspaces, pairHeadline, stableStringify } from '../workspace-diff';
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

// ── consolidation: common (safe/review/conflict) + uncommon + stats ──────────────────────────────────
{
  // 3 workspaces. Tag "Shared" identical everywhere (safe). Tag "Edited" differs in 1 ws (review).
  // Tag "Diverged" has 3 distinct configs (conflict). Tag "OnlySome" missing from ws3 (uncommon → copy).
  const p = (mid: string) => [{ type: 'template', key: 'measurementId', value: mid }];
  const w1 = toWorkspaceInput('1', 'WS1', snap({ tags: [tag({ name: 'Shared', tagId: 's', parameter: p('G-X') }), tag({ name: 'Edited', tagId: 'e', parameter: p('G-A') }), tag({ name: 'Diverged', tagId: 'd', parameter: p('G-1') }), tag({ name: 'OnlySome', tagId: 'o' })] }));
  const w2 = toWorkspaceInput('2', 'WS2', snap({ tags: [tag({ name: 'Shared', tagId: 's', parameter: p('G-X') }), tag({ name: 'Edited', tagId: 'e', parameter: p('G-B') }), tag({ name: 'Diverged', tagId: 'd', parameter: p('G-2') }), tag({ name: 'OnlySome', tagId: 'o' })] }));
  const w3 = toWorkspaceInput('3', 'WS3', snap({ tags: [tag({ name: 'Shared', tagId: 's', parameter: p('G-X') }), tag({ name: 'Edited', tagId: 'e', parameter: p('G-A') }), tag({ name: 'Diverged', tagId: 'd', parameter: p('G-3') })] }));
  const con = consolidateWorkspaces([w1, w2, w3]);
  const byName = new Map(con.common.map((e) => [e.name, e]));
  check('consolidate: identical common tag → safe (mergeable)', byName.get('Shared')!.mergeStatus === 'safe' && byName.get('Shared')!.identical);
  check('consolidate: one-off difference → review', byName.get('Edited')!.mergeStatus === 'review' && byName.get('Edited')!.differingFields.includes('param:measurementId'));
  check('consolidate: 3 divergent versions → conflict', byName.get('Diverged')!.mergeStatus === 'conflict' && byName.get('Diverged')!.variants === 3);
  const only = con.uncommon.find((e) => e.name === 'OnlySome')!;
  check('consolidate: a tag missing from one workspace is UNCOMMON', !!only && only.common === false);
  check('consolidate: uncommon presentIn / missingFrom are correct', only.presentIn.join() === 'WS1,WS2' && only.missingFrom.join() === 'WS3');
  check('consolidate: uncommon suggested action is copy', only.suggestedAction === 'copy');
  check('consolidate: stats — 3 common, 1 unique, 1 mergeable, 2 conflicts', con.stats.common === 3 && con.stats.unique === 1 && con.stats.mergeable === 1 && con.stats.conflicts === 2);
  check('consolidate: stats.missing counts each missing occurrence', con.stats.missing === 1);
  check('consolidate: byKind tags total = 4', con.stats.byKind.tag.total === 4);
  check('consolidate: perWorkspace holds each ws field map (null when missing)', only.perWorkspace['1'] !== null && only.perWorkspace['3'] === null);
  // wired into compareWorkspaces
  const res = compareWorkspaces('GTM-X', [w1, w2, w3]);
  check('consolidate: compareWorkspaces includes the consolidation', res.consolidated.common.length === 3 && res.consolidated.uncommon.length === 1);
}

// ── built-in variable comparison (a 5th kind) ─────────────────────────────────────────────────────────
{
  const w1 = toWorkspaceInput('1', 'WS1', snap({}), [], [{ type: 'clickUrl', name: 'Click URL' }, { type: 'pageUrl', name: 'Page URL' }]);
  const w2 = toWorkspaceInput('2', 'WS2', snap({}), [], [{ type: 'pageUrl', name: 'Page URL' }]);
  const d = diffWorkspaces(w1, w2);
  check('built-in: enabled in base only → removed', d.entities.some((e) => e.kind === 'builtInVariable' && e.name === 'Click URL' && e.status === 'removed'));
  check('built-in: enabled in both → unchanged', d.entities.some((e) => e.kind === 'builtInVariable' && e.name === 'Page URL' && e.status === 'unchanged'));
  check('built-in: counts.builtInVariable = 2 in WS1', w1.counts.builtInVariable === 2);
  const con = consolidateWorkspaces([w1, w2]);
  check('built-in: Page URL common, Click URL uncommon', con.common.some((e) => e.name === 'Page URL' && e.kind === 'builtInVariable') && con.uncommon.some((e) => e.name === 'Click URL' && e.kind === 'builtInVariable'));
  check('built-in: byKind.builtInVariable.total = 2', con.stats.byKind.builtInVariable.total === 2);
}

// ── folder MEMBERSHIP / organization (not just folder names) ──────────────────────────────────────────
{
  const fA = { folderId: 'fa', name: 'Analytics' };
  const fM = { folderId: 'fm', name: 'Marketing' };
  // Same tag "GA4" lives in folder "Analytics" in WS1 but "Marketing" in WS2 → a `folder` field change.
  const w1 = toWorkspaceInput('1', 'WS1', snap({ tags: [tag({ name: 'GA4', tagId: 't1', parentFolderId: 'fa' })] }), [fA]);
  const w2 = toWorkspaceInput('2', 'WS2', snap({ tags: [tag({ name: 'GA4', tagId: 't9', parentFolderId: 'fm' })] }), [fM]);
  const ga4 = diffWorkspaces(w1, w2).entities.find((e) => e.kind === 'tag' && e.name === 'GA4')!;
  check('folder-membership: a moved tag is "changed" on its folder field', ga4.status === 'changed' && (ga4.changes ?? []).some((c) => c.field === 'folder' && c.a === 'Analytics' && c.b === 'Marketing'));
  // The folder ENTITY itself differs in membership when it holds different tags.
  const w3 = toWorkspaceInput('3', 'WS3', snap({ tags: [tag({ name: 'GA4', tagId: 't1', parentFolderId: 'fa' }), tag({ name: 'Meta', tagId: 't2', parentFolderId: 'fa' })] }), [fA]);
  const w4 = toWorkspaceInput('4', 'WS4', snap({ tags: [tag({ name: 'GA4', tagId: 't1', parentFolderId: 'fa' })] }), [fA]);
  const folderEnt = diffWorkspaces(w3, w4).entities.find((e) => e.kind === 'folder' && e.name === 'Analytics')!;
  check('folder-membership: folder with different members is "changed"', folderEnt.status === 'changed' && (folderEnt.changes ?? []).some((c) => c.field === 'members'));
  const wX = toWorkspaceInput('5', 'WS5', snap({ tags: [tag({ name: 'X', tagId: 'x' })] }));
  const xTag = [...wX.entities.values()].find((e) => e.kind === 'tag' && e.name === 'X')!;
  check('folder-membership: an unfoldered entity resolves to no folder (field "")', xTag.fields.folder === '');
}

// ── dependency graph + cross-workspace missing dependency ─────────────────────────────────────────────
{
  const w1 = toWorkspaceInput('1', 'WS1', snap({
    triggers: [trig({ name: 'CTA Click', triggerId: 'tr1' })],
    variables: [vari({ name: 'GA4 ID', variableId: 'v1' })],
    tags: [tag({ name: 'GA4 Event', tagId: 't1', firingTriggerId: ['tr1'], parameter: [{ type: 'template', key: 'measurementId', value: '{{GA4 ID}}' }, { type: 'template', key: 'page', value: '{{Page URL}}' }] })],
  }));
  const w2 = toWorkspaceInput('2', 'WS2', snap({
    // The GA4 ID variable is MISSING here → the copied tag's {{GA4 ID}} is a broken dependency.
    triggers: [trig({ name: 'CTA Click', triggerId: 'tr9' })],
    tags: [tag({ name: 'GA4 Event', tagId: 't1', firingTriggerId: ['tr9'], parameter: [{ type: 'template', key: 'measurementId', value: '{{GA4 ID}}' }, { type: 'template', key: 'page', value: '{{Page URL}}' }] })],
  }));
  const res = compareWorkspaces('GTM-X', [w1, w2]);
  check('deps: per-workspace dependency graphs are returned', res.dependencies.length === 2 && res.dependencies[0].entities.length > 0);
  const dep1 = res.dependencies[0].entities.find((e) => e.name === 'GA4 Event')!;
  check('deps: tag depends on its firing trigger (present)', dep1.dependsOn.some((d) => d.kind === 'trigger' && d.name === 'CTA Click' && d.present));
  check('deps: tag depends on its variable (present in WS1)', dep1.dependsOn.some((d) => d.kind === 'variable' && d.name === 'GA4 ID' && d.present));
  check('deps: {{Page URL}} classified as an always-present built-in', dep1.dependsOn.some((d) => d.kind === 'builtInVariable' && d.name === 'Page URL' && d.present));
  const miss = res.missingDependencies.find((m) => m.entity.name === 'GA4 Event' && m.dependency.name === 'GA4 ID')!;
  check('deps: missing dependency detected (var present in WS1, missing in WS2)', !!miss && miss.presentIn.includes('WS1') && miss.missingIn.includes('WS2'));
  check('deps: a built-in ref is NEVER reported as a missing dependency', !res.missingDependencies.some((m) => m.dependency.name === 'Page URL'));
}

// ── guard: need >= 2 workspaces ──────────────────────────────────────────────────────────────────────
{
  let threw = false;
  try { compareWorkspaces('GTM-X', [toWorkspaceInput('1', 'Only', snap({}))]); } catch { threw = true; }
  check('guard: comparing < 2 workspaces throws', threw);
}

console.log(`\nworkspace-diff: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 44) { console.error(`expected >= 44 checks, got ${passed}`); process.exit(1); }
