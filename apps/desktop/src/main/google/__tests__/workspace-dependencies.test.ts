// Pure tests for the Workspace Comparison dependency engine (no GTM access). Run with tsx.
import { buildDependencies, crossWorkspaceMissingDependencies, type EntityDependencies } from '../workspace-dependencies';
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
const dep = (deps: EntityDependencies[], name: string): EntityDependencies => deps.find((e) => e.name === name)!;

// ── buildDependencies: tag → trigger + variable + built-in ────────────────────────────────────────────
{
  const s = snap({
    triggers: [trig({ name: 'CTA Click', triggerId: 'tr1' })],
    variables: [vari({ name: 'GA4 ID', variableId: 'v1' })],
    tags: [tag({ name: 'GA4 Event', tagId: 't1', firingTriggerId: ['tr1'], blockingTriggerId: ['trX'], parameter: [{ type: 'template', key: 'id', value: '{{GA4 ID}}' }, { type: 'template', key: 'p', value: '{{Page URL}}' }, { type: 'template', key: 'm', value: '{{Missing Var}}' }] })],
  });
  const deps = buildDependencies(s);
  const t = dep(deps, 'GA4 Event');
  check('dep: firing trigger present', t.dependsOn.some((d) => d.kind === 'trigger' && d.name === 'CTA Click' && d.present));
  check('dep: blocking trigger id with no name resolves to #id and is absent', t.dependsOn.some((d) => d.kind === 'trigger' && d.name === '#trX' && !d.present));
  check('dep: defined variable is present', t.dependsOn.some((d) => d.kind === 'variable' && d.name === 'GA4 ID' && d.present));
  check('dep: built-in {{Page URL}} is builtInVariable + present', t.dependsOn.some((d) => d.kind === 'builtInVariable' && d.name === 'Page URL' && d.present));
  check('dep: undefined {{Missing Var}} is a variable, NOT present', t.dependsOn.some((d) => d.kind === 'variable' && d.name === 'Missing Var' && !d.present));
}

// ── reserved built-in triggers (All Pages, etc.) are ALWAYS present, never a missing dependency ───────
{
  const s = snap({
    // triggers.list never returns built-in ids, so the tag fires 2147479553 with NO matching trigger entity.
    tags: [tag({ name: 'GA4 Config', tagId: 't1', firingTriggerId: ['2147479553'], blockingTriggerId: ['2147479572'] })],
  });
  const t = dep(buildDependencies(s), 'GA4 Config');
  check('built-in trigger: All Pages resolves as present (not a false MISSING)', t.dependsOn.some((d) => d.kind === 'trigger' && d.name === 'All Pages' && d.present));
  check('built-in trigger: Consent Initialization resolves as present', t.dependsOn.some((d) => d.kind === 'trigger' && d.name === 'Consent Initialization' && d.present));
  check('built-in trigger: NO trigger dep is reported as not-present', !t.dependsOn.some((d) => d.kind === 'trigger' && !d.present));
  // And it must never surface as a cross-workspace gap.
  const cw = crossWorkspaceMissingDependencies([
    { workspaceId: '1', name: 'WS1', deps: buildDependencies(s) },
    { workspaceId: '2', name: 'WS2', deps: buildDependencies(snap({ tags: [] })) },
  ]);
  check('built-in trigger: never a cross-workspace gap', !cw.some((m) => m.dependency.kind === 'trigger' && (m.dependency.name === 'All Pages' || m.dependency.name.startsWith('#'))));
}

// ── variable self-reference is excluded; variable→variable edge kept ─────────────────────────────────
{
  const s = snap({
    variables: [
      vari({ name: 'Full Name', variableId: 'v1', parameter: [{ type: 'template', key: 'x', value: '{{Full Name}} {{First Name}}' }] }),
      vari({ name: 'First Name', variableId: 'v2' }),
    ],
  });
  const v = dep(buildDependencies(s), 'Full Name');
  check('dep: a variable does not depend on itself', !v.dependsOn.some((d) => d.name === 'Full Name'));
  check('dep: a variable-to-variable reference is captured (present)', v.dependsOn.some((d) => d.name === 'First Name' && d.present));
}

// ── trigger group → member trigger reference ──────────────────────────────────────────────────────────
{
  const s = snap({
    triggers: [
      trig({ name: 'Group', triggerId: 'g1', type: 'triggerGroup', parameter: [{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: 'tr2' }] }] }),
      trig({ name: 'Member', triggerId: 'tr2' }),
    ],
  });
  const g = dep(buildDependencies(s), 'Group');
  check('dep: trigger group depends on its member trigger (present)', g.dependsOn.some((d) => d.kind === 'trigger' && d.name === 'Member' && d.present));
}

// ── crossWorkspaceMissingDependencies ─────────────────────────────────────────────────────────────────
{
  const withVar = snap({ variables: [vari({ name: 'GA4 ID', variableId: 'v1' })], tags: [tag({ name: 'T', tagId: 't1', parameter: [{ type: 'template', key: 'id', value: '{{GA4 ID}}' }] })] });
  const withoutVar = snap({ tags: [tag({ name: 'T', tagId: 't1', parameter: [{ type: 'template', key: 'id', value: '{{GA4 ID}}' }] })] });
  const perWs = [
    { workspaceId: '1', name: 'WS1', deps: buildDependencies(withVar) },
    { workspaceId: '2', name: 'WS2', deps: buildDependencies(withoutVar) },
    { workspaceId: '3', name: 'WS3', deps: buildDependencies(withVar) },
  ];
  const miss = crossWorkspaceMissingDependencies(perWs);
  const gap = miss.find((m) => m.entity.name === 'T' && m.dependency.name === 'GA4 ID')!;
  check('cross: gap emitted (present in WS1/WS3, missing in WS2)', !!gap && gap.presentIn.join() === 'WS1,WS3' && gap.missingIn.join() === 'WS2');
}
{
  // A globally-undefined reference (typo present in ALL workspaces) must NOT be flagged — presentIn empty.
  const both = snap({ tags: [tag({ name: 'T', tagId: 't1', parameter: [{ type: 'template', key: 'id', value: '{{Typo Var}}' }] })] });
  const miss = crossWorkspaceMissingDependencies([
    { workspaceId: '1', name: 'WS1', deps: buildDependencies(both) },
    { workspaceId: '2', name: 'WS2', deps: buildDependencies(both) },
  ]);
  check('cross: a globally-missing ref is NOT a cross-workspace gap', !miss.some((m) => m.dependency.name === 'Typo Var'));
}
{
  // Built-in references are always present → never a cross-workspace gap.
  const a = snap({ tags: [tag({ name: 'T', tagId: 't1', parameter: [{ type: 'template', key: 'p', value: '{{Click URL}}' }] })] });
  const miss = crossWorkspaceMissingDependencies([
    { workspaceId: '1', name: 'WS1', deps: buildDependencies(a) },
    { workspaceId: '2', name: 'WS2', deps: buildDependencies(a) },
  ]);
  check('cross: a built-in ref is never a gap', !miss.some((m) => m.dependency.name === 'Click URL'));
}

console.log(`\nworkspace-dependencies: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 15) { console.error(`expected >= 15 checks, got ${passed}`); process.exit(1); }
