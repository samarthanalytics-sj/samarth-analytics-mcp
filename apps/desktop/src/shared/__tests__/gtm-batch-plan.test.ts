// Pure tests for the GTM batch summary + deletion resolver.
// Run: tsx apps/desktop/src/shared/__tests__/gtm-batch-plan.test.ts
//
// The summary is the contract the user approves, so the tests are about it saying EXACTLY what will
// happen: right counts, every item named, blocked items excluded from the totals, nothing invented.

import { summarizeGtmBatch, resolveDeletions, isBuiltinTriggerId, type GtmBatchItem } from '../gtm-batch-plan';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── the categorized summary ──
{
  const items: GtmBatchItem[] = [
    ...Array.from({ length: 15 }, (_, i): GtmBatchItem => ({ action: 'create', entity: 'tag', name: `New Tag ${i + 1}` })),
    ...Array.from({ length: 8 }, (_, i): GtmBatchItem => ({ action: 'update', entity: 'tag', name: `Tag U${i + 1}`, change: 'tag configuration changed' })),
    { action: 'delete', entity: 'tag', name: 'Old Meta Pixel', id: '99' },
    { action: 'delete', entity: 'tag', name: 'Legacy UA', id: '100' },
    ...Array.from({ length: 10 }, (_, i): GtmBatchItem => ({ action: 'update', entity: 'trigger', name: `Trig ${i + 1}`, change: 'trigger conditions updated' })),
    ...Array.from({ length: 3 }, (_, i): GtmBatchItem => ({ action: 'replace', entity: 'variable', name: `Var ${i + 1}`, change: 'variable value modified' })),
  ];
  const s = summarizeGtmBatch(items);

  check('counts: tags 15 created / 8 updated / 2 deleted', s.counts.byEntityAction.tag.create === 15 && s.counts.byEntityAction.tag.update === 8 && s.counts.byEntityAction.tag.delete === 2);
  check('counts: triggers 10 updated', s.counts.byEntityAction.trigger.update === 10);
  check('counts: variables 3 replaced', s.counts.byEntityAction.variable.replace === 3);
  check('per-entity totals', s.counts.byEntity.tag === 25 && s.counts.byEntity.trigger === 10 && s.counts.byEntity.variable === 3);
  check('grand total', s.counts.total === 38 && s.counts.blocked === 0);

  check('headline names every entity total', /This batch will change 25 Tags, 10 Triggers, 3 Variables\./.test(s.text));
  check('the exact "N Tags will be updated" phrasing', s.text.includes('8 Tags will be updated:') && s.text.includes('15 Tags will be created:') && s.text.includes('2 Tags will be deleted:'));
  check('triggers and variables get their own phrasing', s.text.includes('10 Triggers will be updated:') && s.text.includes('3 Variables will be replaced:'));
  check('every affected item is listed by name', s.text.includes('Old Meta Pixel') && s.text.includes('New Tag 1') && s.text.includes('Var 3'));
  check('a delete shows its id for traceability', s.text.includes('Old Meta Pixel (id 99)'));
  check('the change description rides under the item', s.text.includes('trigger conditions updated') && s.text.includes('variable value modified'));
  check('a totals line closes the summary', /Total: 38 changes will be applied\./.test(s.text));
  check('no em dashes anywhere (house style)', !/[—–]/.test(s.text));
  check('singular grammar when exactly one', summarizeGtmBatch([{ action: 'delete', entity: 'tag', name: 'X' }]).text.includes('1 Tag will be deleted:'));
}

// ── blocked items are excluded from the totals but shown ──
{
  const s = summarizeGtmBatch([
    { action: 'delete', entity: 'tag', name: 'Real', id: '1' },
    { action: 'delete', entity: 'trigger', name: 'Ghost', blocked: 'not found in this workspace' },
    { action: 'delete', entity: 'trigger', name: 'All Pages', id: '2147479553', blocked: 'built-in trigger, cannot be deleted' },
  ]);
  check('applicable count excludes blocked', s.counts.total === 1 && s.counts.blocked === 2);
  check('blocked items are listed under their own heading with the reason', /Not applied \(2\)/.test(s.text) && s.text.includes('Ghost') && s.text.includes('built-in trigger'));
  check('the totals line notes the skipped count', /Total: 1 change will be applied, 2 skipped\./.test(s.text));
  check('an all-blocked batch is empty', summarizeGtmBatch([{ action: 'delete', entity: 'tag', name: 'X', blocked: 'gone' }]).empty === true);
  check('an empty list is empty and says so', summarizeGtmBatch([]).empty === true && summarizeGtmBatch([]).text.includes('no applicable changes'));
}

// ── deletion resolution against the live container ──
{
  const snap = {
    tags: [
      { tagId: '10', name: 'GA4 Config', firingTriggerId: ['t1'] },
      { tagId: '11', name: 'Meta Pixel', firingTriggerId: ['t2'], blockingTriggerId: [] },
      { tagId: '12', name: 'Dup', firingTriggerId: [] },
      { tagId: '13', name: 'Dup', firingTriggerId: [] },
    ],
    triggers: [
      { triggerId: 't1', name: 'All Pages' },
      { triggerId: 't2', name: 'Meta Trigger' },
      { triggerId: 't3', name: 'Orphan' },
    ],
    variables: [{ variableId: 'v1', name: 'GA4 ID' }],
  };

  const byId = resolveDeletions({ tags: [{ id: '11' }] }, snap);
  check('resolve a tag by id, carrying its real name', byId.length === 1 && byId[0].id === '11' && byId[0].name === 'Meta Pixel' && !byId[0].blocked);

  const byName = resolveDeletions({ variables: [{ name: 'ga4 id' }] }, snap);
  check('resolve by case-insensitive name to the right id', byName[0].id === 'v1' && !byName[0].blocked);

  const missing = resolveDeletions({ tags: [{ name: 'Nope' }] }, snap);
  check('a name that matches nothing is blocked, not invented', Boolean(missing[0].blocked) && /not found/.test(missing[0].blocked ?? ''));

  const ambiguous = resolveDeletions({ tags: [{ name: 'Dup' }] }, snap);
  check('an ambiguous name is blocked with the fix (delete by id)', Boolean(ambiguous[0].blocked) && /ambiguous/.test(ambiguous[0].blocked ?? ''));

  const builtin = resolveDeletions({ triggers: [{ id: '2147479553', name: 'All Pages (builtin)' }] }, snap);
  check('a built-in trigger id is refused', Boolean(builtin[0].blocked) && /built-in/.test(builtin[0].blocked ?? ''));

  const referenced = resolveDeletions({ triggers: [{ id: 't2' }] }, snap);
  check('deleting a referenced trigger is ALLOWED but the note warns which SURVIVING tags lose it', !referenced[0].blocked && /still referenced by 1 surviving tag/.test(referenced[0].change ?? '') && (referenced[0].change ?? '').includes('Meta Pixel'));
  // A trigger referenced ONLY by a tag that is ALSO being deleted orphans nothing, so no warning.
  const trigWithItsTag = resolveDeletions({ tags: [{ id: '11' }], triggers: [{ id: 't2' }] }, snap);
  const trigItem = trigWithItsTag.find((i) => i.entity === 'trigger');
  check('a trigger whose only referrer is also being deleted gets a clean note', trigItem?.change === 'trigger deleted');

  const orphan = resolveDeletions({ triggers: [{ id: 't3' }] }, snap);
  check('an unreferenced trigger has a clean change note', !orphan[0].blocked && orphan[0].change === 'trigger deleted');

  // The whole thing composes: resolve then summarize.
  const combined = summarizeGtmBatch(resolveDeletions({ tags: [{ id: '11' }], triggers: [{ id: 't3' }], variables: [{ name: 'GA4 ID' }] }, snap));
  check('resolve -> summarize produces a coherent multi-entity plan', combined.counts.total === 3 && combined.text.includes('1 Tag will be deleted:') && combined.text.includes('1 Trigger will be deleted:') && combined.text.includes('1 Variable will be deleted:'));
}

// ── the variable-reference warning (the dangerous case: GTM does not block it) ──
{
  const refSnap = {
    tags: [
      { tagId: 'T1', name: 'GA4 Purchase', firingTriggerId: [], references: ['GA4 Measurement ID', 'Transaction Value'] },
      { tagId: 'T2', name: 'Doomed Tag', firingTriggerId: [], references: ['Only Here'] },
    ],
    triggers: [{ triggerId: 'g1', name: 'Value Gate', references: ['Transaction Value'] }],
    variables: [
      { variableId: 'V1', name: 'GA4 Measurement ID' },
      { variableId: 'V2', name: 'Transaction Value' },
      { variableId: 'V3', name: 'Only Here' },
      { variableId: 'V4', name: 'Truly Unused' },
      { variableId: 'V5', name: 'Chained', references: ['GA4 Measurement ID'] },
    ],
  };

  // "GA4 Measurement ID" is used by tag "GA4 Purchase" AND variable "Chained" - both survive.
  const usedByTag = resolveDeletions({ variables: [{ id: 'V1' }] }, refSnap);
  check('deleting a used variable warns and names the referrers', !usedByTag[0].blocked && /still referenced by 2 surviving items/.test(usedByTag[0].change ?? '') && (usedByTag[0].change ?? '').includes('tag "GA4 Purchase"') && /references will break/.test(usedByTag[0].change ?? ''));
  check('the warning names the variable whose {{reference}} breaks', (usedByTag[0].change ?? '').includes('{{GA4 Measurement ID}}'));

  const usedByTagAndTrigger = resolveDeletions({ variables: [{ name: 'Transaction Value' }] }, refSnap);
  check('a variable used by a tag AND a trigger warns about both', /still referenced by 2 surviving items/.test(usedByTagAndTrigger[0].change ?? '') && (usedByTagAndTrigger[0].change ?? '').includes('tag "GA4 Purchase"') && (usedByTagAndTrigger[0].change ?? '').includes('trigger "Value Gate"'));

  const usedByVar = resolveDeletions({ variables: [{ id: 'V1' }] }, { ...refSnap, tags: [], triggers: [] });
  check('a variable referenced by another VARIABLE is caught too', (usedByVar[0].change ?? '').includes('variable "Chained"'));

  const unused = resolveDeletions({ variables: [{ name: 'Truly Unused' }] }, refSnap);
  check('an unreferenced variable has the clean note, no false alarm', unused[0].change === 'variable deleted');

  // The only referrer of V3 ("Only Here") is "Doomed Tag" - delete both, and there is no surviving
  // referrer, so no warning: the batch is self-consistent.
  const together = resolveDeletions({ tags: [{ id: 'T2' }], variables: [{ id: 'V3' }] }, refSnap);
  const varItem = together.find((i) => i.entity === 'variable');
  check('deleting a variable together with its ONLY referrer is clean (no orphan warning)', varItem?.change === 'variable deleted');

  // Case sensitivity: {{Only Here}} must not match a delete of "only here" - but that name resolves
  // to V3 exactly, and its referrer Doomed Tag survives, so it warns. Confirms exact-name ref match.
  const caseRef = resolveDeletions({ variables: [{ id: 'V3' }] }, refSnap);
  check('reference match is exact-name (the {{Only Here}} referrer is found)', (caseRef[0].change ?? '').includes('Doomed Tag'));

  // A missing `references` (older snapshot data) degrades to no warning rather than a throw.
  const noRefs = resolveDeletions({ variables: [{ id: 'V1' }] }, { tags: [{ tagId: 'T1', name: 'X', firingTriggerId: [] }], triggers: [], variables: [{ variableId: 'V1', name: 'GA4 Measurement ID' }] });
  check('absent reference data degrades to the clean note, never a crash', noRefs[0].change === 'variable deleted');
}

// ── the built-in guard mirrors gtm-builders ──
{
  check('built-in trigger id range', isBuiltinTriggerId('2147479553') && isBuiltinTriggerId('2147479001') && !isBuiltinTriggerId('t2') && !isBuiltinTriggerId('12345'));
}

console.log(`\ngtm-batch-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 35) { console.error(`expected >= 35 checks, got ${passed}`); process.exit(1); }
