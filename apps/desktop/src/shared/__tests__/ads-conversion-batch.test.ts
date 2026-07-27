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
  check('the card explains the id/label then flow into the GTM tags', /Conversion ID and Label are read back/.test(plan.text));
  check('no em dashes (house style)', !/[—–]/.test(plan.text));
  check('not empty when there are creatable steps', plan.empty === false && plan.blockedCount === 0);

  const explicit = planAdsConversionActions([{ tagName: 'Whatever Tag', conversionName: 'My Exact Name' }], { prefix: 'X', suffix: 'Tag', defaultCategory: 'CONTACT' });
  check('an explicit conversionName wins over the derived one', explicit.steps[0].conversionName === 'My Exact Name');

  const blocked = planAdsConversionActions([{ tagName: 'GA4 - Event -' }], { prefix: 'GA4 - Event -', defaultCategory: 'CONTACT' });
  check('an entry that strips to empty is blocked, not created with a blank name', blocked.steps[0].blocked !== undefined && blocked.empty === true && blocked.blockedCount === 1);
  check('the card lists blocked entries with the reason', /Not creatable \(1\)/.test(blocked.text) && blocked.text.includes('nothing will be applied') === false && /once the prefix\/suffix is stripped/.test(blocked.text));

  const mixed = planAdsConversionActions([{ tagName: 'Good Tag' }, { tagName: 'X' }], { prefix: 'X', defaultCategory: 'CONTACT' });
  check('a mixed batch counts only the creatable ones as LIVE', /1 LIVE Google Ads conversion action will be created/.test(mixed.text) && mixed.blockedCount === 1);

  check('an empty batch is empty', planAdsConversionActions([], { defaultCategory: 'CONTACT' }).empty === true);
  check('deterministic across runs', JSON.stringify(planAdsConversionActions([{ tagName: 'A Tag' }], { suffix: 'Tag', defaultCategory: 'CONTACT' })) === JSON.stringify(planAdsConversionActions([{ tagName: 'A Tag' }], { suffix: 'Tag', defaultCategory: 'CONTACT' })));
}

console.log(`\nads-conversion-batch: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 18) { console.error(`expected >= 18 checks, got ${passed}`); process.exit(1); }
