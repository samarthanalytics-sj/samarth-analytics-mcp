// Tests for the bulk conversion-action plan. Every item this produces becomes an IMMEDIATELY LIVE
// object in the advertiser's Google Ads account, so the plan must be exactly what the operator
// confirmed: nothing extra, nothing silently dropped, no duplicate names.
// Run: tsx src/shared/__tests__/ads-bulk-plan.test.ts
import { planAdsConversionActions, categoryForRow, type AdsPlanRow } from '../ads-bulk-plan';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const row = (over: Partial<AdsPlanRow> = {}): AdsPlanRow => ({
  id: over.id ?? 'r1',
  platform: over.platform ?? 'google_ads_conversion',
  tagName: over.tagName ?? 'Google Ads - Conversion - Get A Free Consultation Form Tag',
  eventName: over.eventName,
  measurementId: over.measurementId ?? '{{Google Ads Conversion ID}}',
  conversionLabel: over.conversionLabel ?? '{{Google Ads Conversion Label}}',
  page: over.page,
});

// ── The core case ───────────────────────────────────────────────────────────────
{
  const p = planAdsConversionActions([row()]);
  check('a placeholder Ads row is planned', p.create.length === 1 && p.skipped.length === 0);
  check('the action name comes from the tag name, boilerplate stripped',
    p.create[0].actionName === 'Get A Free Consultation Form', p.create[0].actionName);
  check('the row it belongs to is carried, so the fill cannot go to the wrong row', p.create[0].rowId === 'r1');
}

// ── What must NOT be created ────────────────────────────────────────────────────
check('a row that already has a real id and label is left alone', (() => {
  const p = planAdsConversionActions([row({ measurementId: 'AW-17667466396', conversionLabel: 'g9RqCLD6kdQcEJzJwOhB' })]);
  return p.create.length === 0 && /already has a real/i.test(p.skipped[0]?.reason ?? '');
})());
check('a remarketing row is skipped WITH a reason (it has no label to create)', (() => {
  const p = planAdsConversionActions([row({ platform: 'google_ads_remarketing' })]);
  return p.create.length === 0 && /no conversion label/i.test(p.skipped[0]?.reason ?? '');
})());
check('a non-Ads row ticked alongside is skipped, not planned', (() => {
  const p = planAdsConversionActions([row({ platform: 'ga4_event', tagName: 'GA4 - Event - Phone Click Tag' })]);
  return p.create.length === 0 && p.skipped.length === 1;
})());
check('a tag name that reduces to nothing is skipped rather than creating an unnamed action', (() => {
  const p = planAdsConversionActions([row({ tagName: 'Google Ads - Conversion - Tag' })]);
  return p.create.length === 0 && /could not derive/i.test(p.skipped[0]?.reason ?? '');
})());
check('every skip names its tag, so nothing vanishes silently', (() => {
  const p = planAdsConversionActions([row({ id: 'x', platform: 'google_ads_remarketing', tagName: 'Google Ads - Remarketing - All Pages Tag' })]);
  return p.skipped[0].rowId === 'x' && p.skipped[0].tagName.includes('All Pages');
})());
check('an empty selection plans nothing', planAdsConversionActions([]).create.length === 0);

// ── Duplicate names are disambiguated, not silently doubled ────────────────────
{
  const p = planAdsConversionActions([
    row({ id: 'a', tagName: 'Google Ads - Conversion - Contact Us Form Tag' }),
    row({ id: 'b', tagName: 'Google Ads - Conversion - Contact Us Form Tag' }),
    row({ id: 'c', tagName: 'Google Ads - Conversion - Contact Us Form Tag' }),
  ]);
  check('three same-named rows produce three DISTINCT action names',
    new Set(p.create.map((c) => c.actionName)).size === 3, p.create.map((c) => c.actionName).join(' | '));
  check('the first keeps the clean name', p.create[0].actionName === 'Contact Us Form');
  check('the rest are numbered', p.create[1].actionName === 'Contact Us Form (2)' && p.create[2].actionName === 'Contact Us Form (3)');
  check('each still maps to its own row', p.create.map((c) => c.rowId).join() === 'a,b,c');
}
check('case-different names still count as duplicates', (() => {
  const p = planAdsConversionActions([
    row({ id: 'a', tagName: 'Google Ads - Conversion - Contact Us Form Tag' }),
    row({ id: 'b', tagName: 'Google Ads - Conversion - contact us form Tag' }),
  ]);
  return p.create[1].actionName.endsWith('(2)');
})());

// ── Category inference ──────────────────────────────────────────────────────────
check('phone → phone call lead', categoryForRow({ tagName: 'Google Ads - Conversion - Phone Click Tag' }) === 'PHONE_CALL_LEAD');
check('demo/consultation booking → book appointment', categoryForRow({ tagName: 'Book A Demo Click Tag' }) === 'BOOK_APPOINTMENT');
check('quote → request quote', categoryForRow({ tagName: 'Request A Quote Form Tag' }) === 'REQUEST_QUOTE');
check('newsletter/signup → signup', categoryForRow({ tagName: 'Newsletter Signup Form Tag' }) === 'SIGNUP');
check('purchase → purchase', categoryForRow({ tagName: 'Purchase Tag', eventName: 'purchase' }) === 'PURCHASE');
check('email/contact → contact', categoryForRow({ tagName: 'Email Click Tag' }) === 'CONTACT');
check('anything else falls back to the same default the single-row picker uses',
  categoryForRow({ tagName: 'Get Started Form Tag' }) === 'SUBMIT_LEAD_FORM');
check('the event name is considered too, not just the tag name',
  categoryForRow({ tagName: 'Untitled Tag', eventName: 'phone_click' }) === 'PHONE_CALL_LEAD');
check('every planned item carries a category', planAdsConversionActions([row(), row({ id: 'r2' })]).create.every((c) => !!c.category));

// ── Mixed selection: the realistic case ────────────────────────────────────────
{
  const p = planAdsConversionActions([
    row({ id: '1', tagName: 'Google Ads - Conversion - Get A Free Consultation Form Tag' }),
    row({ id: '2', platform: 'ga4_event', tagName: 'GA4 - Event - Phone Click Tag' }),
    row({ id: '3', tagName: 'Google Ads - Conversion - Contact Us Form Tag', measurementId: 'AW-123456789', conversionLabel: 'abc' }),
    row({ id: '4', tagName: 'Google Ads - Conversion - Phone Click Tag' }),
  ]);
  check('mixed selection: only the two that need one are planned', p.create.length === 2);
  check('mixed selection: the other two are accounted for', p.skipped.length === 2);
  check('mixed selection: every input row appears exactly once across create+skipped',
    new Set([...p.create.map((c) => c.rowId), ...p.skipped.map((s) => s.rowId)]).size === 4);
  // "Get A Free Consultation" is an appointment request, not a generic lead form, and the phone row
  // is a call lead: the point is that each row gets the category IT deserves.
  check('mixed selection: categories are inferred per row, not one default for all',
    p.create[0].category === 'BOOK_APPOINTMENT' && p.create[1].category === 'PHONE_CALL_LEAD',
    p.create.map((c) => `${c.actionName}=${c.category}`).join(' | '));
}

// ── Placeholder handling ───────────────────────────────────────────────────────
check('an empty id counts as needing one', planAdsConversionActions([row({ measurementId: '', conversionLabel: '' })]).create.length === 1);
check('a real id with a placeholder label still needs one',
  planAdsConversionActions([row({ measurementId: 'AW-123456789' })]).create.length === 1);
check('no em dashes in operator-facing skip reasons (house style)',
  !planAdsConversionActions([row({ platform: 'google_ads_remarketing' })]).skipped.some((s) => /[—–]/.test(s.reason)));

console.log(`\nads-bulk-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
