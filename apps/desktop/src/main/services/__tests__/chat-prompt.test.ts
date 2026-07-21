import assert from 'node:assert/strict';
import { dateContextLine, GTM_AUDIT_METHODOLOGY, GA4_TAG_NAMING, GA4_ECOMMERCE_REFERENCE, GTM_CREATION_METHODOLOGY, GTM_TRIGGER_VARIABLE_REFERENCE, GTM_DECISION_RULES, GA4_DATA_FRESHNESS, CORPUS_PROMPT } from '../chat-service';
import { AUDIT_REPORTING_METHODOLOGY } from '../../../shared/jit-reference';

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

// The audit brain is delivered in two parts now. What the PROMPT still carries must be enough for
// the model to reach the tool; everything about interpreting findings rides on the result.
test('GTM_AUDIT_METHODOLOGY (the prompt half) still routes the model to the deterministic audit', () => {
  const m = GTM_AUDIT_METHODOLOGY;
  assert.ok(/audit_gtm_container FIRST/i.test(m), 'calls the deterministic audit first');
  assert.ok(/never audit from memory or a generic checklist/i.test(m), 'forbids auditing from memory');
  assert.ok(/comes back WITH the audit result/i.test(m), 'says the rest arrives with the result');
  assert.ok(m.length < AUDIT_REPORTING_METHODOLOGY.length / 4, 'the prompt half is a fraction of the full brain');
});

// Every essential the prompt used to carry must still exist, now on the result-borne half.
test('AUDIT_REPORTING_METHODOLOGY carries the Audit-Brain essentials', () => {
  const m = AUDIT_REPORTING_METHODOLOGY;
  assert.ok(/boundary statement/i.test(m) && /runtime verification/i.test(m), 'has the container-only boundary statement');
  assert.ok(/\[Certain\]/.test(m) && /\[Likely\]/.test(m) && /runtime-required/i.test(m), 'has the three confidence levels');
  assert.ok(/Hygiene[\s\S]*NEVER leads/i.test(m), 'orders by impact — hygiene never leads');
  assert.ok(/denied consent signal correctly BLOCKING a tag is correct/i.test(m), 'has the denied-pass false-positive guard');
  assert.ok(/ad_user_data/.test(m) && /ad_personalization/.test(m), 'names the four Consent Mode v2 signals');
  assert.ok(/Critical −30|Critical -30/.test(m), 'keeps the deterministic scoring');
  assert.ok(/needs verification/i.test(m), 'keeps the runtime-required list');
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

test('GTM_CREATION_METHODOLOGY carries the shared build-methodology (same rules the tag-suggestion engine uses)', () => {
  const m = GTM_CREATION_METHODOLOGY;
  // Shared GA4 event-selection taxonomy prefix.
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

test('GTM_TRIGGER_VARIABLE_REFERENCE covers trigger/variable types + the Lookup Table grouping pattern, honest about typed vs raw', () => {
  const m = GTM_TRIGGER_VARIABLE_REFERENCE;
  // Typed builder scope + the raw fallback.
  assert.ok(/create_gtm_variable_typed/.test(m) && /create_gtm_variable\b/.test(m) && /create_gtm_trigger\b/.test(m), 'names typed + raw tools');
  assert.ok(/constant \| data_layer \| javascript/.test(m), 'lists the four typed variable kinds');
  // Trigger reference incl. raw-only types.
  assert.ok(/Element Visibility/.test(m) && /elementVisibility/.test(m), 'Element Visibility trigger (raw)');
  assert.ok(/Scroll Depth/.test(m) && /History Change/.test(m), 'scroll + history triggers');
  // Variable reference incl. DOM Element.
  assert.ok(/DOM Element/.test(m) && /type d\b|\[d\]/.test(m) && /attribute/i.test(m), 'DOM Element variable (text or attribute)');
  // Lookup Table grouping pattern + the smm raw shape.
  assert.ok(/Lookup Table/.test(m) && /smm/.test(m), 'Lookup Table variable (smm)');
  assert.ok(/equals true/.test(m) && /GROUPING/.test(m), 'grouping: trigger fires on {{var}} equals true');
  assert.ok(/enable_gtm_builtin_variables/.test(m), 'enable the input built-in for the lookup table');
  assert.ok(/EQUALS for an exact/.test(m) && /CONTAINS \/ matchRegex/.test(m), 'equals-vs-contains rule');
});

test('GTM_DECISION_RULES carries the expert decision rules from the GTM guide (fork, ladder, page path, click/form, mistakes)', () => {
  const m = GTM_DECISION_RULES;
  assert.ok(/data layer/i.test(m) && /auto-event/i.test(m) && /PREFER the data layer/i.test(m), 'the data-layer vs auto-event fork');
  assert.ok(/reliability ladder/i.test(m) && /Data Layer Variable[\s\S]*Cookie[\s\S]*DOM Element/i.test(m), 'the value reliability ladder (DLV > cookie/global > DOM)');
  assert.ok(/\{\{Page URL\}\} equals "\/contact" NEVER matches/i.test(m) && /IDENTIFY A PAGE by \{\{Page Path\}\}/i.test(m), 'page path vs page URL rule');
  assert.ok(/\{\{Click ID\}\}[\s\S]*\{\{Click Text\}\} \/ \{\{Click Classes\}\} LAST/i.test(m), 'click-field stability preference');
  assert.ok(/data-layer success event[\s\S]*Element Visibility[\s\S]*native Form Submission/i.test(m), 'form reliability order');
  assert.ok(/MISTAKES TO AVOID/i.test(m) && /no firing trigger/i.test(m), 'the common-mistakes guards');
});

test('GA4_DATA_FRESHNESS teaches "when did data last arrive" — widen the window, find the last active day, no over-alarm', () => {
  const m = GA4_DATA_FRESHNESS;
  // Must answer with a specific date via a date-dimension report over a wide, retention-bounded window.
  assert.ok(/last active day/i.test(m) && /run_ga4_report/.test(m) && /\["date"\]/.test(m), 'find the last active day with a date-dimension report');
  assert.ok(/365daysAgo/.test(m) && /get_ga4_data_retention/.test(m), 'widen the window but respect the retention limit');
  assert.ok(/MOST RECENT date/i.test(m), 'report the most recent non-zero date');
  // Real-time is only the last 30 minutes — an empty realtime result is not "no data".
  assert.ok(/run_ga4_realtime_report/.test(m) && /last 30 minutes/i.test(m) && /NOT evidence that data stopped/i.test(m), 'realtime ≠ recency');
  // Do not over-alarm: a gap is POSSIBLE / Likely / runtime-required, not asserted "critical/broken".
  assert.ok(/do NOT (assert|over-alarm)/i.test(m) && /POSSIBLE/.test(m) && /DebugView/.test(m), 'no over-alarm; confirm at runtime');
});

console.log('\nChat system prompt - house patterns (corpus retrieval):');

test('CORPUS_PROMPT points at the tool and fences off every way its counts could mislead', () => {
  const m = CORPUS_PROMPT;
  assert.ok(/lookup_corpus_patterns/.test(m), 'names the tool');
  // Say WHEN, or the tool is simply never called.
  assert.ok(/BEFORE proposing an event name/i.test(m) && /naming convention/i.test(m), 'says when to call it');
  // Cite the real number rather than a vague superlative.
  assert.ok(/cite the real count/i.test(m) && /never a vague/i.test(m), 'demands the real count');
  // The three honesty fences, each mirrored by a guarantee in the result envelope.
  assert.ok(/not industry benchmarks/i.test(m), 'not benchmarks');
  assert.ok(/not proof a pattern is correct/i.test(m), 'frequency is not correctness');
  assert.ok(/never a reading of the CURRENT container/i.test(m), 'not a live reading of the container');
  assert.ok(/say so instead of inventing a frequency/i.test(m), 'a miss must not become an invented number');
  assert.ok(!/[—–]/.test(m), 'no em dashes (house style)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
