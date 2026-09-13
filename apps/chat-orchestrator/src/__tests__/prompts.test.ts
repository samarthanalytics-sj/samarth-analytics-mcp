/**
 * System-prompt tests.
 *
 * A prompt is not usually worth unit-testing: asserting that a string contains a sentence proves
 * little about what the model does. These four are the exception, because each one was added after
 * a specific, observed, expensive failure, and a later edit that trims the prompt for tokens would
 * remove them silently and reintroduce exactly that failure.
 *
 * The test does not claim the model OBEYS them. It claims they are still being sent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStaticSystem } from '../prompts.js';

const build = (over: Partial<Parameters<typeof buildStaticSystem>[0]> = {}): string =>
  buildStaticSystem({ product: 'gtm', canWrite: true, mcpInstructions: '', ...over });

test('re-read rather than recall, on every product and mode', () => {
  // Observed: asked to restate tags with their trigger conditions, the model answered from the
  // previous turn and reported a tag firing on a trigger it had only DISCUSSED.
  for (const opts of [
    { product: 'gtm' as const, canWrite: true },
    { product: 'gtm' as const, canWrite: false },
    { product: 'ga4' as const, canWrite: true },
  ]) {
    const p = build(opts);
    assert.ok(p.includes('RE-READ, DO NOT RECALL'), `missing for ${opts.product}/${opts.canWrite}`);
    assert.ok(p.includes('your memory of it is not evidence'));
  }
});

test('identifiers are copied exactly, never tidied', () => {
  // Observed: "addtocart" was reported as "add_to_cart". Implementing the tidied name produces a
  // tag that never fires, and the container looks correct while it does nothing.
  const p = build();
  assert.ok(p.includes('COPY IDENTIFIERS EXACTLY'));
  assert.ok(p.includes('addtocart'), 'the concrete example earns its place: it is what went wrong');
  assert.ok(p.includes('REPORT it as it is'), 'a suspicious name is reported, not silently corrected');
});

test('a variable reference must be confirmed before it is written', () => {
  // Observed: a tag was created referencing {{User Email}} with no variables_list call. The API
  // accepts it, so the tag looks finished and does nothing.
  const p = build();
  assert.ok(p.includes('NEVER REFERENCE A VARIABLE YOU HAVE NOT CONFIRMED EXISTS'));
  assert.ok(p.includes('list the variables'));
});

test('personal data never goes into a container', () => {
  // Observed: an email address written into a meta tag on All Pages, with no warning.
  const p = build();
  assert.ok(p.includes('DO NOT PUT PERSONAL DATA INTO A CONTAINER'));
  assert.ok(p.includes('hashed or') || p.includes('server-side'), 'an alternative is offered, not just a refusal');
});

test('a read-only session still carries the honesty rules', () => {
  // The rules above are about REPORTING, not writing: a read-only chat can still misreport an
  // event name, and that is just as costly.
  const p = build({ canWrite: false });
  assert.ok(p.includes('RE-READ, DO NOT RECALL'));
  assert.ok(p.includes('COPY IDENTIFIERS EXACTLY'));
  assert.ok(p.includes('THIS CONVERSATION IS READ-ONLY'), 'and still says it cannot write');
});
