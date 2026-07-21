// Tests for per-render form ids. The failure this prevents is the worst kind: GTM ACCEPTS a trigger
// built on an id that no longer exists, reports the tag as created, and the tag never fires again.
// Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/form-id-stability.node.test.ts
import { looksEphemeralFormId, uuidsIn, formIdScope, ephemeralFormIdNote } from '../form-id-stability.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// The real ids observed across three scans of one HubSpot page. The trailing GUID is constant; the
// leading one is minted per render.
const FORM_GUID = '79c35ad9-5d43-407b-8c0e-0b62b2cc8de0';
const HS = [
  `90c40916-c9d8-4b32-b5fa-07cb0779ce19-${FORM_GUID}`,
  `f03fb5b3-eb64-4f2a-b823-6f1d016e87e9-${FORM_GUID}`,
  `19a16022-1bc5-49fe-81a4-116f0ff6a9ef-${FORM_GUID}`,
];

// ── Detection ───────────────────────────────────────────────────────────────────
check('a UUID-bearing id is treated as possibly per-render', HS.every(looksEphemeralFormId));
check('an ordinary hand-written id is not', !looksEphemeralFormId('contact-form')
  && !looksEphemeralFormId('wpcf7-f123-p45-o1') && !looksEphemeralFormId('mktoForm_1234'));
check('empty / missing is not', !looksEphemeralFormId('') && !looksEphemeralFormId(undefined));
check('both UUIDs are extracted, in order', uuidsIn(HS[0]).length === 2 && uuidsIn(HS[0])[1] === FORM_GUID);

// ── Ordinary ids keep the old behaviour exactly ────────────────────────────────
check('one stable id → equals', (() => {
  const s = formIdScope(['contact-form']);
  return s?.operator === 'equals' && s.value === 'contact-form' && !s.stabilized;
})());
check('several stable ids → the ^(a|b)$ regex, as before', (() => {
  const s = formIdScope(['contact-form', 'demo-form']);
  return s?.operator === 'matchRegex' && s.value === '^(contact-form|demo-form)$';
})());
check('regex-special characters in an id are escaped', (() => {
  const s = formIdScope(['a.b', 'c+d']);
  return s?.operator === 'matchRegex' && s.value.includes('a\\.b') && s.value.includes('c\\+d');
})());

// ── The HubSpot case: several samples prove which fragment is durable ──────────
{
  const s = formIdScope(HS);
  check('ephemeral ids are NOT matched exactly', s?.operator !== 'equals' && !(s?.value ?? '').includes('90c40916'));
  check('the shared form GUID becomes a CONTAINS scope', s?.operator === 'contains' && s.value === FORM_GUID, JSON.stringify(s));
  check('it is flagged as stabilized', s?.stabilized === true);
  check('the note explains the id changes and what the trigger now matches',
    /changes on every page load/i.test(s?.note ?? '') && (s?.note ?? '').includes(FORM_GUID));
  check('no refusal note when it was successfully stabilized', ephemeralFormIdNote(HS) === null);
}

// ── A single ephemeral sample: refuse rather than guess which half is durable ──
{
  const one = [HS[0]];
  check('a single ephemeral id yields NO id scope', formIdScope(one) === null);
  const n = ephemeralFormIdNote(one) ?? '';
  check('the refusal is explained', /generated per page load/i.test(n));
  check('it warns the tag would never fire, which is the whole point', /never fire/i.test(n));
  check('it says what happens instead', /class or page/i.test(n));
  check('it tells the operator how to fix it properly', /add a stable id/i.test(n));
}

// ── Edge cases ──────────────────────────────────────────────────────────────────
check('identical ephemeral ids repeated are still one sample, so still refused',
  formIdScope([HS[0], HS[0], HS[0]]) === null);
check('ephemeral ids sharing NOTHING are refused (no false stabilization)', (() => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  return formIdScope([a, b]) === null && (ephemeralFormIdNote([a, b]) ?? '').length > 0;
})());
check('empty input yields nothing at all', formIdScope([]) === null && ephemeralFormIdNote([]) === null);
check('blank strings are ignored', formIdScope(['', '   ']) === null);
check('case differences in a UUID do not defeat the match', (() => {
  const s = formIdScope([HS[0], HS[1].toUpperCase()]);
  return s?.operator === 'contains' && s.value === FORM_GUID;
})());
check('no em dashes in operator-facing text (house style)',
  !/[—–]/.test((formIdScope(HS)?.note ?? '') + (ephemeralFormIdNote([HS[0]]) ?? '')));

console.log(`\nform-id-stability: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
