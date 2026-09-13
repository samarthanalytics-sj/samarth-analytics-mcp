// Tests for per-render form ids. The failure this prevents is the worst kind: GTM ACCEPTS a trigger
// built on an id that no longer exists, reports the tag as created, and the tag never fires again.
// Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/form-id-stability.node.test.ts
import { looksEphemeralFormId, uuidsIn, formIdScope, ephemeralFormIdNote, stableFormKey } from '../form-id-stability.js';
import { providerFormIdentity, groupFormIdentity } from '../provider-form-id.js';

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

// -- The provider's own id (HubSpot data-form-id): ONE sample is enough ----------
// Verified live on get.chownow.com: the wrapper and the <form> both carry
// data-form-id="79c35ad9-5d43-407b-8c0e-0b62b2cc8de0", and the DOM id ends with it.
{
  const one = ['cf2be672-0e24-4813-8728-42d97847318c-' + FORM_GUID];
  const sc = formIdScope(one, FORM_GUID);
  check('provider id: a SINGLE ephemeral sample now stabilizes', sc?.operator === 'contains' && sc.value === FORM_GUID);
  check('provider id: flagged as stabilized', sc?.stabilized === true);
  check('provider id: the note says it is the provider durable id', /durable form id/i.test(sc?.note ?? ''));
  check('provider id: no refusal note once stabilized', ephemeralFormIdNote(one, FORM_GUID) === null);
  check('provider id: without it, the same single sample is still refused', formIdScope(one) === null);
}
check('provider id: one that does NOT appear in the DOM id is not trusted', (() => {
  const other = '00000000-0000-0000-0000-000000000000';
  return formIdScope(['cf2be672-0e24-4813-8728-42d97847318c-' + FORM_GUID], other) === null;
})());
check('provider id: matched case-insensitively', (() => {
  const sc = formIdScope(['CF2BE672-0E24-4813-8728-42D97847318C-' + FORM_GUID.toUpperCase()], FORM_GUID);
  return sc?.operator === 'contains' && sc.value === FORM_GUID;
})());
check('provider id: blank is ignored, ordinary ids unaffected', (() => {
  const sc = formIdScope(['contact-form'], '');
  return sc?.operator === 'equals' && sc.value === 'contact-form';
})());

// -- stableFormKey: one form read twice must not become two forms ----------------
{
  // The real field signature from get.chownow.com carries a per-render GUID AND an epoch-ms run.
  const key = (guid: string, stamp: string): string =>
    `https://forms-na2.hsforms.com/submissions|post|0-1/firstname,0-1/email,${guid}-${stamp}-input,hs_context`;
  const a = stableFormKey(key('cf2be672-0e24-4813-8728-42d97847318c', '2118870237419'));
  const b = stableFormKey(key('90c40916-c9d8-4b32-b5fa-07cb0779ce19', '2118870999123'));
  check('key: two reads of the SAME re-rendered form collapse to one key', a === b, `${a} vs ${b}`);
  check('key: the volatile parts are replaced, not dropped', a.includes('<uid>') && a.includes('<n>'));
  check('key: genuinely DIFFERENT forms still differ', stableFormKey('/a|post|email') !== stableFormKey('/b|post|email'));
  check('key: different real field names still differ',
    stableFormKey('/a|post|email,name') !== stableFormKey('/a|post|email,phone'));
  check('key: case-insensitive, like the original', stableFormKey('/A|POST|Email') === stableFormKey('/a|post|email'));
  check('key: empty and missing are safe', stableFormKey('') === '' && stableFormKey(undefined as unknown as string) === '');
  check('key: a short number is NOT a per-render token (0-1/ field prefixes survive)',
    stableFormKey('0-1/firstname').includes('0-1/firstname'));
}

// == provider-form-id: the VENDOR-specific durable identity ======================
// Lives beside this file because it answers the same question one layer down: not "is this id the
// same next time" but "what does THIS vendor call the form, where does it live, and which GTM scope
// actually matches it". The mechanism decides the scope kind, and getting that wrong is the bug the
// whole branch exists for: a native {{Form ID}} condition on a form that submits inside an iframe
// is accepted by GTM and never fires.
{
  // -- HubSpot: the form GUID, and never the per-render instance GUID ------------
  const hs = providerFormIdentity({ vendor: 'hubspot', formId: HS[0], providerFormId: FORM_GUID });
  check('pfid hubspot: the value is the form GUID', hs.value === FORM_GUID);
  check('pfid hubspot: read from data-form-id when present', hs.source === 'data-form-id');
  check('pfid hubspot: {{Form ID}} is CONTAINS, never equals (the DOM id has a per-render prefix)',
    hs.formIdCondition?.operator === 'contains' && hs.formIdCondition.value === FORM_GUID);
  check('pfid hubspot: the dataLayer key is hs_form_id, what its own listener pushes',
    hs.dataLayerCondition?.key === 'hs_form_id' && hs.dataLayerCondition.value === FORM_GUID);
  check('pfid hubspot: without data-form-id, the TRAILING uuid of the DOM id is the form GUID',
    providerFormIdentity({ vendor: 'hubspot', formId: HS[1] }).value === FORM_GUID);
  check('pfid hubspot: the classic hsForm_<guid> id resolves too',
    providerFormIdentity({ vendor: 'hubspot', formId: `hsForm_${FORM_GUID}` }).value === FORM_GUID);
  // hsForm_<instanceGuid>-<formGuid> ALSO starts with hsForm_<uuid>, so the classic rule must not
  // win there: it would pick the GUID HubSpot mints on every render, and ship
  // {{dlv - hs_form_id}} equals a value the vendor never posts again. Two uuids means the LAST one.
  {
    const INSTANCE = 'cf2be672-0e24-4813-8728-42d97847318c';
    const both = providerFormIdentity({ vendor: 'hubspot', formId: `hsForm_${INSTANCE}-${FORM_GUID}` });
    check('pfid hubspot: hsForm_<instance>-<form> resolves to the FORM guid, never the instance one',
      both.value === FORM_GUID, String(both.value));
    check('pfid hubspot: and the per-render guid appears nowhere in the scope it produces',
      !JSON.stringify(both).includes(INSTANCE), JSON.stringify(both));
    check('pfid hubspot: the source names the trailing guid it actually read',
      both.source === 'trailing GUID of the DOM id', both.source);
  }
  check('pfid hubspot: a BARE single uuid is ambiguous and is refused, not guessed',
    providerFormIdentity({ vendor: 'hubspot', formId: '90c40916-c9d8-4b32-b5fa-07cb0779ce19' }).value === null);
  check('pfid hubspot: the refusal explains why', /never fire/i.test(providerFormIdentity({ vendor: 'hubspot', formId: '90c40916-c9d8-4b32-b5fa-07cb0779ce19' }).note ?? ''));

  // -- Marketo: the numeric id, stable, so equals ------------------------------
  const mkto = providerFormIdentity({ vendor: 'marketo', formId: 'mktoForm_1234' });
  check('pfid marketo: numeric id from mktoForm_<n>', mkto.value === '1234');
  check('pfid marketo: {{Form ID}} equals the whole stable id', mkto.formIdCondition?.operator === 'equals' && mkto.formIdCondition.value === 'mktoForm_1234');
  check('pfid marketo: the dataLayer key is marketo_form_id carrying the NUMBER (what form.getId() returns)',
    mkto.dataLayerCondition?.key === 'marketo_form_id' && mkto.dataLayerCondition.value === '1234');

  // -- Contact Form 7: the ordinal must never be matched exactly ---------------
  const cf7 = providerFormIdentity({ vendor: 'contactform7', formId: 'wpcf7-f34-p9-o1' });
  check('pfid cf7: the post id is extracted', cf7.value === '34');
  check('pfid cf7: {{Form ID}} is contains wpcf7-f34, never equals the -o ordinal',
    cf7.formIdCondition?.operator === 'contains' && cf7.formIdCondition.value === 'wpcf7-f34');
  check('pfid cf7: the same form at a different placement resolves identically',
    providerFormIdentity({ vendor: 'contactform7', formId: 'wpcf7-f34-p112-o3' }).value === '34');
  check('pfid cf7: data-wpcf7-id alone is enough', providerFormIdentity({ vendor: 'contactform7', providerFormId: '34' }).value === '34');
  check('pfid cf7: the dataLayer value is the POST id (e.detail.contactFormId), not the DOM id',
    cf7.dataLayerCondition?.key === 'form_id' && cf7.dataLayerCondition.value === '34');

  // -- Gravity / Ninja / WPForms ------------------------------------------------
  const gf = providerFormIdentity({ vendor: 'gravityforms', formId: 'gform_wrapper_12' });
  check('pfid gravity: the wrapper id yields the <form> id gform_12', gf.formIdCondition?.operator === 'equals' && gf.formIdCondition.value === 'gform_12');
  check('pfid gravity: dataLayer form_id is the number', gf.dataLayerCondition?.key === 'form_id' && gf.dataLayerCondition.value === '12');
  const nf = providerFormIdentity({ vendor: 'ninjaforms', formId: 'nf-form-3-cont' });
  check('pfid ninja: scoped by the FULL container id so nf-form-1 cannot match nf-form-12',
    nf.formIdCondition?.operator === 'equals' && nf.formIdCondition.value === 'nf-form-3-cont');
  const wpf = providerFormIdentity({ vendor: 'wpforms', providerFormId: '1234' });
  check('pfid wpforms: data-formid (no dash) is read, which the old data-form-id-only capture missed',
    wpf.value === '1234' && wpf.source === 'data-formid');
  check('pfid wpforms: {{Form ID}} equals wpforms-form-<n>', wpf.formIdCondition?.value === 'wpforms-form-1234');
  check('pfid wpforms: the wpforms-form-<n> id alone also resolves',
    providerFormIdentity({ vendor: 'wpforms', formId: 'wpforms-form-88' }).value === '88');

  // -- Vendors that expose nothing: say so, never invent -------------------------
  const el = providerFormIdentity({ vendor: 'elementor', formClasses: 'elementor-form' });
  check('pfid elementor: no widget id in what the scan reads → null, not a guess', el.value === null && el.known);
  check('pfid elementor: it says where the id actually lives', /data-id|hidden form_id/i.test(el.note ?? ''));
  for (const vendor of ['typeform', 'calendly', 'jotform', 'formstack', 'paperform', 'tally', 'googleforms', 'wufoo', 'pardot', 'mailchimp'] as const) {
    const r = providerFormIdentity({ vendor });
    check(`pfid ${vendor}: no durable id at scan time → null with a stated reason`, r.known && r.value === null && !!r.note);
    check(`pfid ${vendor}: and no scope is fabricated`, r.formIdCondition === null && r.dataLayerCondition === null);
  }
  check('pfid unknown vendor: known=false, so the caller falls back to the generic id ladder',
    providerFormIdentity({ vendor: 'unknown', formId: 'contact-form' }).known === false);

  // -- Only a listener that REALLY pushes a key gets a dataLayer condition -------
  check('pfid: elementor gets NO dataLayer condition (submit_success carries no form id)',
    providerFormIdentity({ vendor: 'elementor', formClasses: 'elementor-element-7a1b2c3 elementor-form' }).dataLayerCondition === null);
  check('pfid: klaviyo has an id but no modelled submit signal, so no dataLayer condition',
    (() => {
      const k = providerFormIdentity({ vendor: 'klaviyo', formClasses: 'klaviyo-form-XyZ123' });
      return k.value === 'XyZ123' && k.dataLayerCondition === null && !!k.note;
    })());

  // -- Group agreement -----------------------------------------------------------
  const same = (page: string) => ({ vendor: 'contactform7' as const, formId: `wpcf7-f34-p${page}-o1` });
  check('pfid group: instances agreeing on the value give the group that identity',
    groupFormIdentity([same('9'), same('12')])?.value === '34');
  check('pfid group: instances resolving to DIFFERENT forms veto the group scope',
    groupFormIdentity([{ vendor: 'contactform7', formId: 'wpcf7-f34-p9-o1' }, { vendor: 'contactform7', formId: 'wpcf7-f99-p2-o1' }]) === null);
  {
    // The degrade case: one instance exposes nothing. The group keeps the identity of the ones that
    // do, and is flagged partial so the suggestion can say the other may not fire.
    const partial = groupFormIdentity([{ vendor: 'webflow', formId: 'wf-form-Contact' }, { vendor: 'webflow', formClasses: 'w-form' }]);
    check('pfid group: an instance with nothing does NOT collapse the group', partial?.value === 'Contact');
    check('pfid group: and the gap is flagged, not hidden', partial?.partial === true);
  }
  check('pfid group: a group where NO instance resolves still returns the reason',
    (() => {
      const g = groupFormIdentity([{ vendor: 'marketo' }, { vendor: 'marketo' }]);
      return !!g && g.value === null && !!g.note && g.partial !== true;
    })());
  check('pfid group: a mixed-vendor group has no shared identity', groupFormIdentity([{ vendor: 'marketo', formId: 'mktoForm_1' }, { vendor: 'gravityforms', formId: 'gform_1' }]) === null);
  check('pfid group: an empty group is null', groupFormIdentity([]) === null);

  // -- House style ---------------------------------------------------------------
  const allNotes = (['hubspot', 'marketo', 'contactform7', 'gravityforms', 'ninjaforms', 'wpforms', 'elementor', 'klaviyo', 'activecampaign', 'unbounce', 'webflow', 'typeform', 'calendly', 'jotform', 'formstack', 'paperform', 'tally', 'googleforms', 'wufoo', 'pardot', 'mailchimp'] as const)
    .map((vendor) => providerFormIdentity({ vendor, formId: 'wpcf7-f1-p1-o1 mktoForm_1', formClasses: 'klaviyo-form-A1 _form_1 lp-pom-form' }).note ?? '')
    .join(' ');
  check('pfid: no em dashes in any operator-facing text (house style)', !/[—–]/.test(allNotes));
}

console.log(`\nform-id-stability: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
