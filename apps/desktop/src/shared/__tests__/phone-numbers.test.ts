// Pure tests for phone detection, normalization, cross-page merging and the implementation plan.
// Run: tsx apps/desktop/src/shared/__tests__/phone-numbers.test.ts
//
// The stakes: a false positive here becomes a LIVE Google Ads conversion action wired to a number
// that does not exist, and a bad merge either splits one line into two actions or collapses two
// real lines into one. So most of this file is about identity, not formatting.

import {
  phoneFromTelHref,
  normalizePhone,
  extractPhonesFromText,
  mergePhoneSightings,
  phoneSlug,
  phoneConversionNames,
  buildPhoneConversionPlan,
  type RawPhoneSighting,
} from '../phone-numbers';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── tel: hrefs ──
{
  check('plain tel href', phoneFromTelHref('tel:+15551234567') === '+15551234567');
  check('uppercase scheme + spaces', phoneFromTelHref('TEL:+1 555 123 4567') === '+1 555 123 4567');
  check('percent-encoded plus is decoded', phoneFromTelHref('tel:%2B15551234567') === '+15551234567');
  check('extension metadata is dropped', phoneFromTelHref('tel:+15551234567;ext=99') === '+15551234567');
  check('phone-context suffix is dropped', phoneFromTelHref('tel:5551234567;phone-context=+1') === '5551234567');
  check('pause sequence is dropped', phoneFromTelHref('tel:+15551234567,,123') === '+15551234567');
  check('a non-tel href is not a phone', phoneFromTelHref('mailto:a@b.com') === null && phoneFromTelHref('https://x.com') === null);
}

// ── normalization: the country is never guessed ──
{
  check('E.164 stays E.164 and is confident', (() => { const n = normalizePhone('+15551234567'); return n.e164 === '+15551234567' && n.confident; })());
  check('formatting is stripped', normalizePhone('+1 (555) 123-4567').e164 === '+15551234567');
  check('00 international prefix is treated as +', (() => { const n = normalizePhone('0044 20 7946 0958'); return n.e164 === '+442079460958' && n.confident; })());
  check('a bare 10-digit number is NOT assumed to be +1', (() => { const n = normalizePhone('(555) 123-4567'); return n.e164 === null && !n.confident && /No country code/.test(n.reason ?? ''); })());
  check('but IS completed when the caller supplies a NANP default', (() => { const n = normalizePhone('(555) 123-4567', 'US'); return n.e164 === '+15551234567' && !n.confident; })());
  check('11 digits starting with 1 completes under a NANP default', normalizePhone('1-555-123-4567', 'US').e164 === '+15551234567');
  check('too short is rejected with the count', (() => { const n = normalizePhone('12345'); return n.e164 === null && /too short/.test(n.reason ?? ''); })());
  check('too long is rejected against the E.164 maximum', (() => { const n = normalizePhone('+1234567890123456789'); return n.e164 === null && /E.164 maximum/.test(n.reason ?? ''); })());
  check('an extension is not part of the number', normalizePhone('+1 555 123 4567 ext 99').e164 === '+15551234567');
  check('x-style extension too', normalizePhone('555-123-4567 x22', 'US').e164 === '+15551234567');
}

// ── text extraction: conservative, because a false positive spends money ──
{
  const found = extractPhonesFromText('Call us on (555) 123-4567 or +44 20 7946 0958 today.');
  check('finds grouped and international numbers in prose', found.length === 2 && found.some((f) => f.includes('555')) && found.some((f) => f.includes('7946')));

  check('an ISO date is not a phone number', extractPhonesFromText('Published 2026-07-24 by the team').length === 0);
  check('a price is not a phone number', extractPhonesFromText('Only $1,299.00 this week').length === 0);
  check('a percentage is not a phone number', extractPhonesFromText('Up 12.5% (1234567) year on year').length === 0);
  check('a bare unpunctuated digit run is not a phone number', extractPhonesFromText('Order 12345678 shipped').length === 0);
  check('a long id with no country code is rejected', extractPhonesFromText('IMEI 1234567890123456').length === 0);
  check('a digit slice of a longer run is never matched', extractPhonesFromText('ref 9995551234567890123').length === 0);
  check('the same number twice yields one candidate', extractPhonesFromText('(555) 123-4567 and again (555) 123-4567').length === 1);
  check('empty and junk input degrade to nothing, never a throw', extractPhonesFromText('').length === 0 && extractPhonesFromText('no digits here').length === 0);
}

// ── merging: identity across pages and formats ──
{
  const sightings: RawPhoneSighting[] = [
    { raw: 'tel:+15551234567', source: 'tel_link', page: '/contact', label: 'Call sales' },
    { raw: '(555) 123-4567', source: 'text', page: '/about' },
    { raw: '+1 555 123 4567', source: 'text', page: '/contact' },
    { raw: 'tel:+442079460958', source: 'tel_link', page: '/contact', label: 'UK office' },
  ];
  const merged = mergePhoneSightings(sightings);
  check('one entry per real line, not per sighting', merged.length === 2, `got ${merged.length}`);
  const us = merged.find((m) => m.digits.endsWith('5551234567'));
  check('all three writings of the US line merge into one', us?.occurrences === 3);
  check('the merged line keeps every page it was seen on', JSON.stringify(us?.pages) === JSON.stringify(['/about', '/contact']));
  check('it is clickable because at least one sighting was a tel: link', us?.clickable === true);
  check('both sources are recorded', JSON.stringify(us?.sources) === JSON.stringify(['tel_link', 'text']));
  check('the label survives for display', us?.labels.includes('Call sales') === true);
  check('E.164 is the canonical key', us?.key === '+15551234567' && us?.e164 === '+15551234567');
  check('clickable numbers sort first', merged[0].clickable === true);

  // The bare 10-digit form on a page that ALSO carries an explicit +1 number is completed from that
  // evidence, rather than by assuming a country.
  const derived = mergePhoneSightings([
    { raw: 'tel:+15559998888', source: 'tel_link', page: '/a' },
    { raw: '555-111-2222', source: 'text', page: '/a' },
  ]);
  check('a NANP default is DERIVED from explicit evidence on the same site', derived.every((d) => d.e164?.startsWith('+1')), JSON.stringify(derived.map((d) => d.e164)));

  // With no international evidence anywhere, nothing is guessed.
  const noEvidence = mergePhoneSightings([{ raw: '555-111-2222', source: 'text', page: '/a' }]);
  check('with no evidence the number stays unnormalized and says so', noEvidence[0].e164 === null && noEvidence[0].key === 'digits:5551112222' && /No country code/.test(noEvidence[0].note ?? ''));

  const textOnly = mergePhoneSightings([{ raw: '+1 555 777 8888', source: 'text', page: '/a' }]);
  check('a text-only number is flagged as having no click to fire on', textOnly[0].clickable === false && /no click event/.test(textOnly[0].note ?? ''));

  check('too-short junk never becomes a number', mergePhoneSightings([{ raw: '12345', source: 'text', page: '/a' }]).length === 0);
}

// ── determinism: the same page always produces the same plan ──
{
  const a: RawPhoneSighting[] = [
    { raw: '(555) 123-4567', source: 'text', page: '/b' },
    { raw: 'tel:+15551234567', source: 'tel_link', page: '/a', label: 'Sales' },
    { raw: 'tel:+442079460958', source: 'tel_link', page: '/a' },
  ];
  const shuffled = [a[2], a[0], a[1]];
  check('input order does not change the output', JSON.stringify(mergePhoneSightings(a)) === JSON.stringify(mergePhoneSightings(shuffled)));
  check('slug is stable and punctuation-free', phoneSlug({ e164: '+15551234567', digits: '15551234567' }) === '15551234567');
  const names = phoneConversionNames({ e164: '+15551234567', digits: '15551234567', display: '+15551234567', labels: ['Call sales'] });
  check('names are derived from the NUMBER, so two lines never collide', names.actionName.includes('+15551234567') && names.tagName.includes('+15551234567') && names.triggerName.includes('+15551234567'));
  check('a human label rides along without breaking uniqueness', names.actionName.includes('Call sales'));
  const numericLabel = phoneConversionNames({ e164: '+15551234567', digits: '15551234567', display: '+15551234567', labels: ['555-123-4567'] });
  check('a label that is just the number again is not repeated', !numericLabel.actionName.includes('(555-123-4567)'));
}

// ── the implementation plan ──
{
  const clickable = mergePhoneSightings([{ raw: 'tel:+15551234567', source: 'tel_link', page: '/a', label: 'Sales' }])[0];
  const textOnly = mergePhoneSightings([{ raw: '+1 555 777 8888', source: 'text', page: '/a' }])[0];

  const fresh = buildPhoneConversionPlan({ phones: [clickable], existingActions: [], existingTagNames: [], hasConversionLinker: false });
  check('a clickable number plans a create + a click-scoped tag', fresh.steps[0].method === 'click_to_call' && Boolean(fresh.steps[0].createAction) && fresh.steps[0].tag?.platform === 'google_ads_conversion');
  check('the trigger is scoped to THIS number, not to tel: generally', fresh.steps[0].tag?.clickUrlValue === 'tel:+15551234567');
  check('the category is the phone-call lead category', fresh.steps[0].createAction?.category === 'PHONE_CALL_LEAD' && fresh.steps[0].createAction?.type === 'WEBPAGE');
  check('a missing Conversion Linker is planned ONCE for the container', fresh.createConversionLinker === true);
  check('the summary counts what will happen', fresh.summary.total === 1 && fresh.summary.creatingActions === 1 && fresh.summary.clickToCall === 1);

  const reuse = buildPhoneConversionPlan({
    phones: [clickable],
    existingActions: [{ id: '111', name: 'Phone call - +15551234567', taggable: true, conversionId: 'AW-1', conversionLabel: 'LBL' }],
    existingTagNames: [],
    hasConversionLinker: true,
  });
  check('an existing action for the same number is REUSED, not duplicated', reuse.steps[0].reuseActionId === '111' && !reuse.steps[0].createAction);
  check('an existing Conversion Linker is not re-created', reuse.createConversionLinker === false);

  const unusable = buildPhoneConversionPlan({
    phones: [clickable],
    existingActions: [{ id: '222', name: 'Phone call - +15551234567', taggable: false, conversionId: null, conversionLabel: null }],
    existingTagNames: [],
    hasConversionLinker: true,
  });
  check('a matching but UNTAGGABLE action is not reused, and the reason says so', Boolean(unusable.steps[0].createAction) && /no usable conversion id and label/.test(unusable.steps[0].reason));

  const already = buildPhoneConversionPlan({
    phones: [clickable],
    existingActions: [],
    existingTagNames: ['Google Ads - Phone Call - +15551234567'],
    hasConversionLinker: true,
  });
  check('an implementation already in the container is detected, so a re-run is idempotent', already.steps[0].tagExists === true && already.summary.tagsAlreadyPresent === 1);

  const blocked = buildPhoneConversionPlan({ phones: [textOnly], existingActions: [], existingTagNames: [], hasConversionLinker: true });
  check('a text-only number is UNSUPPORTED by default, with the reason and the way forward', blocked.steps[0].method === 'unsupported' && /no click to fire a tag on/.test(blocked.steps[0].reason) && /number swap/.test(blocked.steps[0].blocked ?? ''));
  check('and it plans no tag at all rather than a tag that cannot fire', !blocked.steps[0].tag);
  check('an all-unsupported plan does not demand a Conversion Linker', blocked.createConversionLinker === false);

  const withCall = buildPhoneConversionPlan({ phones: [textOnly], existingActions: [], existingTagNames: [], hasConversionLinker: false, allowWebsiteCall: true });
  check('with website-call enabled it plans a WEBSITE_CALL action + the call tag', withCall.steps[0].method === 'website_call' && withCall.steps[0].createAction?.type === 'WEBSITE_CALL' && withCall.steps[0].tag?.platform === 'google_ads_call_conversion');
  check('the call tag carries the number to swap', withCall.steps[0].tag?.phoneNumber === '+15557778888');
  check('and the reason explains number swapping in plain words', /replaces the displayed number/.test(withCall.steps[0].reason));

  const mixed = buildPhoneConversionPlan({ phones: [clickable, textOnly], existingActions: [], existingTagNames: [], hasConversionLinker: true, allowWebsiteCall: true });
  check('a mixed page plans each number its OWN step', mixed.steps.length === 2 && mixed.summary.clickToCall === 1 && mixed.summary.websiteCall === 1);
  check('every planned tag name is unique', new Set(mixed.steps.map((s) => s.tag?.name)).size === 2);
  check('the plan is deterministic across runs', JSON.stringify(buildPhoneConversionPlan({ phones: [clickable, textOnly], existingActions: [], existingTagNames: [], hasConversionLinker: true, allowWebsiteCall: true })) === JSON.stringify(mixed));
}

console.log(`\nphone-numbers: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 45) { console.error(`expected >= 45 checks, got ${passed}`); process.exit(1); }
