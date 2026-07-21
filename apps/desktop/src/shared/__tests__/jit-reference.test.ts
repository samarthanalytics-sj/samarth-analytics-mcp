// Tests for just-in-time reference delivery. Moving knowledge out of the always-sent prompt is only
// safe if delivery is GUARANTEED at the moment it is needed, so these assert the routing and the
// completeness of what arrives, not just that something was attached.
// Run: tsx src/shared/__tests__/jit-reference.test.ts
import {
  AUDIT_POINTER, AUDIT_REPORTING_METHODOLOGY, GTM_RAW_SHAPES,
  referenceForResult, referenceForError, attachReference,
} from '../jit-reference';
import { GTM_TRIGGER_VARIABLE_REFERENCE } from '../gtm-methodology';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Routing: the right reference, only where it belongs ─────────────────────────
check('audit results carry the reporting methodology', referenceForResult('audit_gtm_container') === AUDIT_REPORTING_METHODOLOGY
  && referenceForResult('audit_server_container') === AUDIT_REPORTING_METHODOLOGY);
check('ordinary results carry nothing', referenceForResult('list_gtm_tags') === undefined
  && referenceForResult('create_gtm_tracking_tag') === undefined
  && referenceForResult('lookup_corpus_patterns') === undefined);
check('a failed RAW create carries the resource shapes', referenceForError('create_gtm_trigger') === GTM_RAW_SHAPES
  && referenceForError('create_gtm_variable') === GTM_RAW_SHAPES);
check('a failed TYPED create does not (the builder shapes it)', referenceForError('create_gtm_variable_typed') === undefined
  && referenceForError('create_gtm_tracking_tag') === undefined);
check('a failed audit does not carry the shapes', referenceForError('audit_gtm_container') === undefined);

// ── attachReference keeps the payload usable ────────────────────────────────────
{
  const json = JSON.stringify({ findings: [{ severity: 'high' }], counts: { tags: 2 } });
  const out = attachReference(json, AUDIT_REPORTING_METHODOLOGY);
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(out) as Record<string, unknown>; } catch { /* undefined */ }
  check('attach: JSON stays parseable', !!parsed);
  check('attach: the original fields survive', Array.isArray(parsed?.findings) && !!parsed?.counts);
  check('attach: the methodology rides along', String(parsed?._methodology).includes('boundary statement'));
}
check('attach: a non-JSON payload gets the reference appended', (() => {
  const out = attachReference('GTM said: invalid parameter', GTM_RAW_SHAPES);
  return out.startsWith('GTM said: invalid parameter') && out.includes('RAW SHAPES');
})());
check('attach: a bare array is wrapped rather than corrupted', (() => {
  const out = attachReference('[1,2,3]', AUDIT_REPORTING_METHODOLOGY);
  try { const p = JSON.parse(out) as { result?: unknown[]; _methodology?: string }; return Array.isArray(p.result) && !!p._methodology; }
  catch { return false; }
})());
check('attach: no reference means byte-identical passthrough', attachReference('{"a":1}', undefined) === '{"a":1}');
check('attach: empty/missing content is safe', attachReference('', undefined) === ''
  && attachReference(undefined as unknown as string, undefined) === '');

// ── Nothing was LOST in the move ────────────────────────────────────────────────
// The prompt half must still route the model to the tool that delivers the rest.
check('pointer: names the audit tool', AUDIT_POINTER.includes('audit_gtm_container'));
check('pointer: promises the methodology arrives with the result', /comes back WITH the audit result/i.test(AUDIT_POINTER));
check('pointer: is a fraction of what it replaced', AUDIT_POINTER.length < AUDIT_REPORTING_METHODOLOGY.length / 4,
  `${AUDIT_POINTER.length} vs ${AUDIT_REPORTING_METHODOLOGY.length}`);
// Every rule (2)..(11) has to exist somewhere: they are the audit brain.
for (const rule of ['(2)', '(3)', '(4)', '(5)', '(6)', '(7)', '(8)', '(9)', '(10)', '(11)']) {
  check(`methodology: rule ${rule} survived the move`, AUDIT_REPORTING_METHODOLOGY.includes(rule));
}
check('methodology: rule (1) stayed in the PROMPT, where it must arrive first', AUDIT_POINTER.includes('(1)')
  && !AUDIT_REPORTING_METHODOLOGY.startsWith('(1)'));

// The raw shapes must still be reachable, and the prompt must say how.
check('shapes: the smm Lookup Table shape survived', GTM_RAW_SHAPES.includes('"smm"') && GTM_RAW_SHAPES.includes('setDefaultValue'));
check('shapes: the DOM Element shape survived', GTM_RAW_SHAPES.includes('elementSelector') && GTM_RAW_SHAPES.includes('attributeName'));
check('shapes: the Element Visibility shape survived', GTM_RAW_SHAPES.includes('elementVisibility'));
check('reference: the always-sent prompt tells the model the shapes arrive on rejection',
  /rejected/i.test(GTM_TRIGGER_VARIABLE_REFERENCE) && /comes back WITH the error/i.test(GTM_TRIGGER_VARIABLE_REFERENCE));
check('reference: the always-sent prompt no longer carries the shapes themselves',
  !GTM_TRIGGER_VARIABLE_REFERENCE.includes('setDefaultValue'));

console.log(`\njit-reference: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
