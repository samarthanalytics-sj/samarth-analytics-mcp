// Pure tests for affix stripping + the batch conversion-action plan.
// Run: tsx apps/desktop/src/shared/__tests__/ads-conversion-batch.test.ts

import { stripAffixes, planAdsConversionActions } from '../ads-conversion-batch';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── stripAffixes ──
{
  check('strips an exact prefix and tidies the leftover separator', stripAffixes('GA4 - Event - Book A Demo', { prefix: 'GA4 - Event -' }) === 'Book A Demo');
  check('strips an exact suffix', stripAffixes('Book A Demo Click Tag', { suffix: 'Click Tag' }) === 'Book A Demo');
  check('strips both ends', stripAffixes('GA4 - Event - Newsletter Form Tag', { prefix: 'GA4 - Event -', suffix: 'Form Tag' }) === 'Newsletter');
  check('affix match is case-insensitive and whitespace-tolerant', stripAffixes('  ga4 - event -  Purchase  Tag ', { prefix: 'GA4 - Event -', suffix: 'tag' }) === 'Purchase');
  check('no affixes given -> the name is returned trimmed/collapsed', stripAffixes('  Contact   Form  ') === 'Contact Form');
  check('an affix that does not match is left alone', stripAffixes('Purchase', { prefix: 'Nope -', suffix: 'Zzz' }) === 'Purchase');
  check('a name that is ONLY the prefix collapses to empty', stripAffixes('GA4 - Event -', { prefix: 'GA4 - Event -' }) === '');
  check('leading/trailing dashes and colons are cleaned', stripAffixes('- : Lead : -', { prefix: '', suffix: '' }) === 'Lead');
}

// ── the plan ──
{
  const plan = planAdsConversionActions(
    [
      { tagName: 'GA4 - Event - Book A Demo Click Tag' },
      { tagName: 'GA4 - Event - Newsletter Form Tag' },
      { tagName: 'GA4 - Event - Call Sales Click Tag', category: 'PHONE_CALL_LEAD' },
    ],
    { prefix: 'GA4 - Event -', suffix: 'Click Tag', defaultCategory: 'SUBMIT_LEAD_FORM' }
  );
  check('one step per entry, named by the affix rule', plan.steps.length === 3 && plan.steps[0].conversionName === 'Book A Demo');
  check('a suffix that does not fully match still strips what it can (Form Tag stays)', plan.steps[1].conversionName === 'Newsletter Form Tag');
  check('per-entry category overrides the default', plan.steps[2].category === 'PHONE_CALL_LEAD' && plan.steps[0].category === 'SUBMIT_LEAD_FORM');
  check('the card says these are LIVE and names each action + its tag', /3 LIVE Google Ads conversion actions will be created/.test(plan.text) && plan.text.includes('"Book A Demo" (SUBMIT_LEAD_FORM)') && plan.text.includes('for tag: GA4 - Event - Book A Demo Click Tag'));
  check('the card explains the id/label then flow into the GTM tags', /Conversion ID and Label \(read back from the Ads account\) are used/.test(plan.text));
  check('no em dashes (house style)', !/[—–]/.test(plan.text));
  check('not empty when there are creatable steps', plan.empty === false && plan.blockedCount === 0);

  const explicit = planAdsConversionActions([{ tagName: 'Whatever Tag', conversionName: 'My Exact Name' }], { prefix: 'X', suffix: 'Tag', defaultCategory: 'CONTACT' });
  check('an explicit conversionName wins over the derived one', explicit.steps[0].conversionName === 'My Exact Name');

  const blocked = planAdsConversionActions([{ tagName: 'GA4 - Event -' }], { prefix: 'GA4 - Event -', defaultCategory: 'CONTACT' });
  check('an entry that strips to empty is blocked, not created with a blank name', blocked.steps[0].blocked !== undefined && blocked.empty === true && blocked.blockedCount === 1);
  check('the card lists blocked entries with the reason', /Not applied \(1\)/.test(blocked.text) && /once the prefix\/suffix is stripped/.test(blocked.text));

  const mixed = planAdsConversionActions([{ tagName: 'Good Tag' }, { tagName: 'X' }], { prefix: 'X', defaultCategory: 'CONTACT' });
  check('a mixed batch counts only the creatable ones as LIVE', /1 LIVE Google Ads conversion action will be created/.test(mixed.text) && mixed.blockedCount === 1);

  check('an empty batch is empty', planAdsConversionActions([], { defaultCategory: 'CONTACT' }).empty === true);
  check('deterministic across runs', JSON.stringify(planAdsConversionActions([{ tagName: 'A Tag' }], { suffix: 'Tag', defaultCategory: 'CONTACT' })) === JSON.stringify(planAdsConversionActions([{ tagName: 'A Tag' }], { suffix: 'Tag', defaultCategory: 'CONTACT' })));

  // default (reuse off) always creates, even when an identical action already exists
  const existing = [
    { id: '111', name: 'Book A Demo', taggable: true, conversionId: 'AW-123', conversionLabel: 'lbl_demo' },
    { id: '222', name: 'Newsletter', taggable: true, conversionId: 'AW-123', conversionLabel: 'lbl_news' },
    { id: '333', name: 'No Label', taggable: true, conversionId: 'AW-123', conversionLabel: null },
    { id: '444', name: 'Not Taggable', taggable: false, conversionId: 'AW-123', conversionLabel: 'lbl_x' },
  ];
  const dup = planAdsConversionActions([{ tagName: 'GA4 - Event - Book A Demo Click Tag' }], { prefix: 'GA4 - Event -', suffix: 'Click Tag', defaultCategory: 'CONTACT', existingActions: existing });
  check('reuse OFF -> still a create even when a match exists', dup.steps[0].mode === 'create' && dup.createCount === 1 && dup.reuseCount === 0);
}

// ── reuse ──
{
  const existing = [
    { id: '111', name: 'Book A Demo', taggable: true, conversionId: 'AW-123', conversionLabel: 'lbl_demo' },
    { id: '333', name: 'No Label', taggable: true, conversionId: 'AW-123', conversionLabel: null },
    { id: '444', name: 'Not Taggable', taggable: false, conversionId: 'AW-123', conversionLabel: 'lbl_x' },
  ];
  const plan = planAdsConversionActions(
    [
      { tagName: 'GA4 - Event - Book A Demo Click Tag' },   // matches existing 111 -> reuse
      { tagName: 'GA4 - Event - Newsletter Click Tag' },    // no match -> create
      { tagName: 'GA4 - Event - No Label Click Tag' },      // name matches 333 but no label -> create
    ],
    { prefix: 'GA4 - Event -', suffix: 'Click Tag', defaultCategory: 'CONTACT', reuse: true, existingActions: existing }
  );
  check('reuse ON -> a taggable name+id+label match reuses the existing action', plan.steps[0].mode === 'reuse' && plan.steps[0].reuseId === '111' && plan.steps[0].conversionId === 'AW-123' && plan.steps[0].conversionLabel === 'lbl_demo');
  check('reuse ON -> an unmatched name is still a create', plan.steps[1].mode === 'create');
  check('reuse ON -> a name match with no usable label is NOT reused (falls back to create)', plan.steps[2].mode === 'create');
  check('reuse counts split creates vs reuses', plan.createCount === 2 && plan.reuseCount === 1 && plan.empty === false);
  check('reuse card lists the reused action by name + id and marks it no-write', /1 existing conversion action will be REUSED \(no new write\)/.test(plan.text) && plan.text.includes('"Book A Demo" (id 111)'));
  check('reuse card still shows the LIVE creates', /2 LIVE Google Ads conversion actions will be created/.test(plan.text));

  const allReuse = planAdsConversionActions([{ tagName: 'Book A Demo' }], { defaultCategory: 'CONTACT', reuse: true, existingActions: existing });
  check('a batch that reuses everything creates nothing but is not empty', allReuse.createCount === 0 && allReuse.reuseCount === 1 && allReuse.empty === false && /No new conversion actions will be created/.test(allReuse.text));
  check('reuse is a non-blocking, non-write path (blockedCount stays 0)', allReuse.blockedCount === 0 && !/[—–]/.test(allReuse.text));

  // case-insensitive name match for reuse
  const ci = planAdsConversionActions([{ tagName: 'book a demo' }], { defaultCategory: 'CONTACT', reuse: true, existingActions: existing });
  check('reuse name match is case-insensitive', ci.steps[0].mode === 'reuse' && ci.steps[0].reuseId === '111');
}

console.log(`\nads-conversion-batch: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 27) { console.error(`expected >= 27 checks, got ${passed}`); process.exit(1); }
