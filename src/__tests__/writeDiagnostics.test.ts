/**
 * The diagnosis must never contradict itself.
 *
 * GTM answers a refused delete and a missing id with the same 404, whose text is literally
 * "Not found or permission denied". explainMissingEntity used to read that as "missing" without
 * ever checking the id against its own kind, so a read-only caller deleting a tag that exists was
 * told there is no tag 3, that this was not a permissions problem, and then, in the same sentence,
 * that the tags which do exist are 3 (GA4 Config). That steers the reader away from the only cause
 * left. The id-exists case now answers permissions, and says so before the cross-kind branch runs.
 *
 * Run: tsx src/__tests__/writeDiagnostics.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { GtmClient } from '../utils/gtmClient.js';
import { explainMissingEntity } from '../utils/writeDiagnostics.js';

const SCOPE = { accountId: '1', containerId: '2', workspaceId: '5' };

interface Listed {
  tag?: Record<string, unknown>[];
  trigger?: Record<string, unknown>[];
  variable?: Record<string, unknown>[];
}

/** A workspace that lists exactly what the test says it holds, one page, no failures. */
const fakeClient = (listed: Listed): GtmClient =>
  ({
    accounts: {
      containers: {
        workspaces: {
          tags: { list: async () => ({ data: { tag: listed.tag ?? [] } }) },
          triggers: { list: async () => ({ data: { trigger: listed.trigger ?? [] } }) },
          variables: { list: async () => ({ data: { variable: listed.variable ?? [] } }) },
        },
      },
    },
  }) as unknown as GtmClient;

/** A 404 shaped the way googleapis delivers GTM's refusal. */
const notFoundError = () => {
  const err = new Error('Request failed with status code 404') as Error & {
    response: { data: { error: { code: number; message: string } } };
  };
  err.response = { data: { error: { code: 404, message: 'Not found or permission denied.' } } };
  return err;
};

test('an id that exists under its own kind is reported as a refused write, not a missing entity', async () => {
  const client = fakeClient({ tag: [{ tagId: '3', name: 'GA4 Config' }] });
  const msg = await explainMissingEntity(client, SCOPE, 'tag', '3', notFoundError());

  assert.match(msg, /tag 3 \("GA4 Config"\) does exist/);
  assert.match(msg, /permissions problem/);
  // The two sentences that made the old output self-contradicting.
  assert.doesNotMatch(msg, /There is no tag with id 3/);
  assert.doesNotMatch(msg, /This was not a permissions problem/);
  // The API's own words survive, so a caller can still see what Google said.
  assert.match(msg, /Not found or permission denied/);
});

test('the own-kind check wins over a same-numbered entity of another kind', async () => {
  // Both a tag 3 and a trigger 3 exist. Blaming the id space here would be wrong twice over.
  const client = fakeClient({
    tag: [{ tagId: '3', name: 'GA4 Config' }],
    trigger: [{ triggerId: '3', name: 'All Pages' }],
  });
  const msg = await explainMissingEntity(client, SCOPE, 'tag', '3', notFoundError());

  assert.match(msg, /does exist/);
  assert.doesNotMatch(msg, /different kind of entity/);
});

test('an id belonging only to another kind still gets the cross-type answer', async () => {
  const client = fakeClient({
    tag: [{ tagId: '7', name: 'Pageview' }],
    trigger: [{ triggerId: '3', name: 'All Pages' }],
  });
  const msg = await explainMissingEntity(client, SCOPE, 'tag', '3', notFoundError());

  assert.match(msg, /There is no tag with id 3/);
  assert.match(msg, /trigger 3 \("All Pages"\)/);
  assert.match(msg, /This was not a permissions problem/);
});

test('an empty workspace still says no id would have worked', async () => {
  const msg = await explainMissingEntity(fakeClient({}), SCOPE, 'tag', '3', notFoundError());

  assert.match(msg, /no tags at all/);
  assert.match(msg, /This was not a permissions problem/);
});
