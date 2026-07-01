import assert from 'node:assert/strict';
import { dateContextLine, GTM_AUDIT_METHODOLOGY, GA4_TAG_NAMING, GA4_ECOMMERCE_REFERENCE, GTM_CREATION_METHODOLOGY } from '../chat-service';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nChat system prompt — current date:');

test('dateContextLine states the real date as ISO + human and tells the model to ignore training-date', () => {
  // Construct with local components so getFullYear/Month/Date are deterministic.
  const line = dateContextLine(new Date(2026, 5, 19)); // June 19, 2026
  assert.ok(line.includes('2026-06-19'), 'ISO date present');
  assert.ok(line.includes('June 19, 2026'), 'human date present');
  assert.ok(/IGNORE any date from your training data/i.test(line), 'instructs to ignore training date');
  assert.ok(/only dates AFTER today are "in the future"/i.test(line), 'frames future correctly');
});

test('pads single-digit month/day to a valid ISO date', () => {
  const line = dateContextLine(new Date(2026, 0, 5)); // Jan 5, 2026
  assert.ok(line.includes('2026-01-05'), 'zero-padded ISO');
  assert.ok(!line.includes('2026-1-5'));
});

test('GTM_AUDIT_METHODOLOGY carries the Audit-Brain essentials', () => {
  const m = GTM_AUDIT_METHODOLOGY;
  assert.ok(/audit_gtm_container FIRST/i.test(m), 'calls the deterministic audit first');
  assert.ok(/boundary statement/i.test(m) && /runtime verification/i.test(m), 'has the container-only boundary statement');
  assert.ok(/\[Certain\]/.test(m) && /\[Likely\]/.test(m) && /runtime-required/i.test(m), 'has the three confidence levels');
  assert.ok(/Hygiene[\s\S]*NEVER leads/i.test(m), 'orders by impact — hygiene never leads');
  assert.ok(/denied consent signal correctly BLOCKING a tag is correct/i.test(m), 'has the denied-pass false-positive guard');
  assert.ok(/ad_user_data/.test(m) && /ad_personalization/.test(m), 'names the four Consent Mode v2 signals');
});

test('GA4_TAG_NAMING defines the "GA4 - Event - <Name>[ Click|Form] Tag" / "<Name>[ Click|Form] Trigger" format', () => {
  const m = GA4_TAG_NAMING;
  assert.ok(m.includes('GA4 - Event - <Name>') && m.includes(' Tag'), 'tag-name format (GA4 - Event - <Name> ... Tag)');
  assert.ok(/Click Tag/.test(m) && /Form Tag/.test(m), 'has both Click and Form kind words');
  assert.ok(/Book A Demo Click Tag/.test(m) && /Book A Demo Click Trigger/.test(m), 'click worked example (tag + trigger)');
  assert.ok(/Newsletter Form Tag/.test(m) && /Newsletter Form Trigger/.test(m), 'form worked example (tag + trigger)');
  assert.ok(/Add To Cart Tag/.test(m) && /Add To Cart Trigger/.test(m), 'custom-event example omits the kind word');
  assert.ok(/OMIT the word/i.test(m), 'states the omit-kind-word rule for custom-event/pageview');
});

test('GA4_ECOMMERCE_REFERENCE maps each ecommerce event to its parameters', () => {
  const m = GA4_ECOMMERCE_REFERENCE;
  assert.ok(/add_to_cart[\s\S]*items, value, currency/.test(m), 'add_to_cart → items/value/currency');
  assert.ok(m.includes('purchase, refund → items, transaction_id, value, tax, shipping, currency, coupon'), 'purchase/refund row');
  assert.ok(m.includes('view_promotion, select_promotion → creative_name, creative_slot, promotion_id, promotion_name, items'), 'promotion row');
  assert.ok(/ecommerce\.items/.test(m) && /Custom Event trigger/i.test(m), 'reads from the ecommerce data layer + Custom Event trigger');
});

test('GTM_CREATION_METHODOLOGY carries the shared build-methodology (same rules the tag-suggestion engine + AI scan use)', () => {
  const m = GTM_CREATION_METHODOLOGY;
  // Shared event-selection prefix (also injected into the AI-scan vision prompt).
  assert.ok(/GA4 EVENT SELECTION/.test(m) && /snake_case/.test(m), 'includes the event-selection taxonomy in snake_case');
  assert.ok(/primary navigation/i.test(m) && /cookie-consent \/ CMP/i.test(m), 'names the skip list (nav + consent controls)');
  // Creation methodology.
  assert.ok(/create_gtm_tracking_tag/.test(m), 'points at the deterministic builder tool');
  assert.ok(/variables → triggers → tag/.test(m), 'states the dependency creation order');
  assert.ok(/\{\{Form ID\}\}[\s\S]*\{\{Form Classes\}\}[\s\S]*\{\{Page Path\}\}/.test(m), 'form-submit scoping ladder: id → class → page');
  assert.ok(/iframe\/AJAX/i.test(m) && /Custom Event trigger/i.test(m), 'iframe/AJAX forms fall back to a Custom Event trigger');
  assert.ok(/TOP-LEVEL/.test(m), 'keeps the timer top-level-fields gotcha');
  assert.ok(/click_text[\s\S]*click_url[\s\S]*page_url[\s\S]*previous_page/.test(m), 'standard click event params');
  assert.ok(/form_id[\s\S]*form_name[\s\S]*page_url[\s\S]*previous_page/.test(m), 'standard form event params');
  assert.ok(/\{\{Click Text\}\} EQUALS/.test(m) && /CONTAINS the path fragment/i.test(m), 'exact click-text + page-contains trigger conditions');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
