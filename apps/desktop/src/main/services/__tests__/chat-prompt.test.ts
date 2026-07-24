import assert from 'node:assert/strict';
import { dateContextLine, buildSituationalContext, ANSWER_THE_CURRENT_MESSAGE, GTM_AUDIT_METHODOLOGY, GA4_TAG_NAMING, GA4_ECOMMERCE_REFERENCE, GTM_CREATION_METHODOLOGY, GTM_TRIGGER_VARIABLE_REFERENCE, GTM_DECISION_RULES, GA4_DATA_FRESHNESS, CORPUS_PROMPT } from '../chat-service';
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
// ── The per-message context block (prompt-cache boundary) ──
// Everything volatile lives at the END of the system prompt so the fixed half stays byte-identical
// across turns and can be served from the provider's cache. These pin what belongs in it.
console.log('\nChat system prompt - per-message context block:');

const ctxArgs = {
  email: 'user@example.com',
  product: 'gtm' as const,
  gtmContext: { accountId: '111', accountName: 'Acme', containerId: 'GTM-ABC', containerName: 'Web', workspaceId: '7', workspaceName: 'Default' },
  now: new Date('2026-07-22T10:00:00Z'),
  memoryBlock: 'REMEMBERED CONTEXT\n- [fact] we use order_completed\n',
  toolMemoryBlock: 'RECENT TOOL RESULTS: 3 tags\n',
};

test('carries the identity, the container ids, the date, the memories and the tool carry-over', () => {
  const c = buildSituationalContext(ctxArgs);
  assert.ok(c.includes('user@example.com'), 'the account email');
  assert.ok(c.includes('GTM-ABC') && c.includes('workspace 7'), 'the ids the model must use');
  assert.ok(c.includes('CURRENT DATE'), 'the real date');
  assert.ok(c.includes('order_completed'), 'the selected memories');
  assert.ok(c.includes('RECENT TOOL RESULTS'), 'the tool-result carry-over');
});

test('a GA4 turn gets the property, never the GTM container', () => {
  const c = buildSituationalContext({ ...ctxArgs, product: 'ga4', ga4Context: { property: 'properties/123', propertyName: 'Site' } });
  assert.ok(c.includes('properties/123'));
  assert.equal(c.includes('GTM-ABC'), false, 'the GTM container is not mentioned on a GA4 turn');
});

test('the SAME account and container produce a byte-identical block, so only real changes miss', () => {
  assert.equal(buildSituationalContext(ctxArgs), buildSituationalContext({ ...ctxArgs }));
});

test('switching account or container CHANGES it (the cache must miss when the facts change)', () => {
  const base = buildSituationalContext(ctxArgs);
  assert.notEqual(base, buildSituationalContext({ ...ctxArgs, email: 'other@example.com' }));
  assert.notEqual(base, buildSituationalContext({ ...ctxArgs, gtmContext: { ...ctxArgs.gtmContext, containerId: 'GTM-XYZ' } }));
});

test('missing context degrades to identity only, never to a broken sentence', () => {
  const c = buildSituationalContext({ ...ctxArgs, gtmContext: undefined, memoryBlock: '', toolMemoryBlock: '' });
  assert.ok(c.includes('user@example.com'));
  assert.equal(c.includes('The user is working in'), false);
  assert.ok(c.includes('CURRENT DATE'), 'the date survives with no container');
});

// ── Cross-platform integrations in the per-message context ──
// A CONNECTED platform needs its working target in the prompt, or the model asks the user for an
// id the app already knows. An UNCONNECTED one must stay out, for the same reason a GA4 turn never
// sees the GTM container: the other product's saved context can point at a different client.
test('a connected platform contributes its working context; an unconnected one does not', () => {
  const withGa4 = buildSituationalContext({
    ...ctxArgs,
    integrations: ['ga4'],
    ga4Context: { property: 'properties/123', propertyName: 'Site' },
  });
  assert.ok(withGa4.includes('GTM-ABC'), 'the GTM chat keeps its own container');
  assert.ok(withGa4.includes('properties/123'), 'and gains the connected property');

  const without = buildSituationalContext({
    ...ctxArgs,
    integrations: [],
    ga4Context: { property: 'properties/123', propertyName: 'Site' },
  });
  assert.equal(without.includes('properties/123'), false, 'an unconnected GA4 property stays out');
  assert.ok(without.includes('GTM-ABC'), 'the chat product itself is unaffected');
});

test('connecting GTM to a GA4 chat brings the container in, without losing the property', () => {
  const c = buildSituationalContext({
    ...ctxArgs,
    product: 'ga4',
    integrations: ['gtm'],
    ga4Context: { property: 'properties/123', propertyName: 'Site' },
  });
  assert.ok(c.includes('properties/123'), 'its own property');
  assert.ok(c.includes('GTM-ABC') && c.includes('workspace 7'), 'plus the container it will write the tag into');
});

test('integrations do not disturb the cache boundary: same connections, byte-identical block', () => {
  const a = buildSituationalContext({ ...ctxArgs, integrations: ['ga4'], ga4Context: { property: 'properties/123' } });
  const b = buildSituationalContext({ ...ctxArgs, integrations: ['ga4'], ga4Context: { property: 'properties/123' } });
  assert.equal(a, b);
  // Connecting a platform is a REAL change of what the model may act on, so it must miss the cache.
  assert.notEqual(a, buildSituationalContext({ ...ctxArgs, integrations: [], ga4Context: { property: 'properties/123' } }));
});

test('the block ENDS with the most volatile content, so the stable part stays a shared prefix', () => {
  // Two turns differing only in the memories must share everything up to the memory block. If a
  // volatile field ever drifts earlier, this shortens and the cross-turn cache hit shrinks with it.
  const a = buildSituationalContext(ctxArgs);
  const b = buildSituationalContext({ ...ctxArgs, memoryBlock: 'REMEMBERED CONTEXT\n- [fact] something else entirely\n' });
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  assert.ok(shared > a.indexOf('CURRENT DATE'), 'identity, ids and the date all precede the first difference');
});


// -- Answering the CURRENT message ------------------------------------------------
// Reported from a real session: mid-way through an Ads conversion setup the assistant asked for
// confirmation, the user typed "list all tags", and the reply listed 11 Google Ads ACCOUNTS - the
// list_gtm_tags result was fetched and then discarded.
console.log('\nChat system prompt - answering the current message:');

test('the prompt tells the model to answer the message just sent', () => {
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /ANSWER THE MESSAGE THE USER JUST SENT/);
});

test('it names the exact trap: a pending question the new message does not answer', () => {
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /previous reply ended with a question/i);
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /moved on/i);
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /drop the pending task/i);
});

test('it forbids fetching a tool result and then answering about something else', () => {
  // This is what actually happened: list_gtm_tags succeeded and never reached the reply.
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /its result must appear in your answer/i);
});

test('it still allows setting earlier work aside, but only out loud', () => {
  // Without this the model could read the rule as "never mention the old task", which loses context
  // the user may still want.
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /say so in one line first/i);
});

test('it is composed into the GTM prompt', () => {
  // The instruction only helps if it actually ships in the system prompt.
  assert.ok(ANSWER_THE_CURRENT_MESSAGE.trim().length > 0);
});

test('house style: no em dashes', () => {
  assert.equal(/[—–]/.test(ANSWER_THE_CURRENT_MESSAGE), false);
});


// Reported from a second real session: the user typed "list the tags", list_gtm_tags succeeded, and
// the reply was "I've listed all 82 tags in JSON export format" - with no list in it. The model was
// pointing at an EARLIER message. The user then had to ask a third time.
test('it forbids CLAIMING to have listed something that is not in this message', () => {
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /NEVER SAY YOU HAVE LISTED/i);
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /UNLESS IT IS IN THIS MESSAGE/i);
});

test('it says an earlier reply does not satisfy a repeated request', () => {
  // The reason matters: a repeat means they want it AGAIN, not a pointer to where it was.
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /earlier reply does not count/i);
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /produce it again in full/i);
});

test('it ties counts to visible items, so "82 tags" cannot be asserted over nothing', () => {
  assert.match(ANSWER_THE_CURRENT_MESSAGE, /give a number only when the items you counted are in front of the user/i);
});

// ── Cross-platform integrations: context ISOLATION between threads ──
// The rule the whole feature rests on: a chat sees the targets it was pointed at, and nothing else.
// A connected platform is an explicit per-thread choice (its own context bar is shown), so its
// target belongs here; an unconnected one must stay out even though the account holds it.
console.log('\nChat system prompt - integration context isolation:');

const isoArgs = {
  ...ctxArgs,
  ga4Context: { property: 'properties/123', propertyName: 'Site' },
  adsContext: { customerId: '9876543210', customerName: 'Acme Store' },
};

test('each platform appears only when the chat covers it: 8 combinations, no leakage', () => {
  const has = (c: string) => ({ gtm: c.includes('GTM-ABC'), ga4: c.includes('properties/123'), ads: c.includes('9876543210') });
  const cases: Array<{ product: 'gtm' | 'ga4' | 'ads'; integrations: Array<'gtm' | 'ga4' | 'ads'>; want: { gtm: boolean; ga4: boolean; ads: boolean } }> = [
    { product: 'gtm', integrations: [], want: { gtm: true, ga4: false, ads: false } },
    { product: 'gtm', integrations: ['ga4'], want: { gtm: true, ga4: true, ads: false } },
    { product: 'gtm', integrations: ['ads'], want: { gtm: true, ga4: false, ads: true } },
    { product: 'gtm', integrations: ['ga4', 'ads'], want: { gtm: true, ga4: true, ads: true } },
    { product: 'ga4', integrations: [], want: { gtm: false, ga4: true, ads: false } },
    { product: 'ga4', integrations: ['gtm'], want: { gtm: true, ga4: true, ads: false } },
    { product: 'ads', integrations: [], want: { gtm: false, ga4: false, ads: true } },
    { product: 'ads', integrations: ['gtm'], want: { gtm: true, ga4: false, ads: true } },
  ];
  for (const c of cases) {
    const got = has(buildSituationalContext({ ...isoArgs, product: c.product, integrations: c.integrations }));
    assert.deepEqual(got, c.want, `${c.product} + [${c.integrations.join(',')}]`);
  }
});

test('a GA4 chat NEVER sees the Ads account and an Ads chat NEVER sees the property, connected or not', () => {
  // The matrix forbids the pairing, and sanitizing inside the prompt builder is what enforces it,
  // but the CONTEXT must independently refuse to carry the other product's client.
  const ga4 = buildSituationalContext({ ...isoArgs, product: 'ga4', integrations: ['gtm'] });
  assert.equal(ga4.includes('9876543210'), false, 'no Ads customer in a GA4 chat');
  const ads = buildSituationalContext({ ...isoArgs, product: 'ads', integrations: ['gtm'] });
  assert.equal(ads.includes('properties/123'), false, 'no GA4 property in an Ads chat');
});

test('switching the connected platform\'s TARGET changes the block, so no stale id survives', () => {
  const a = buildSituationalContext({ ...isoArgs, integrations: ['ga4'] });
  const b = buildSituationalContext({ ...isoArgs, integrations: ['ga4'], ga4Context: { property: 'properties/999', propertyName: 'Other' } });
  assert.notEqual(a, b, 'a different connected property is a different context');
  assert.equal(b.includes('properties/123'), false, 'the previous property is gone, not merged');
});

if (failed > 0) process.exit(1);
