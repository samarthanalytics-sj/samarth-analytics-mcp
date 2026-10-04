/**
 * Approval broker tests.
 *
 * This is the gate that stands between a model proposing a change and that change happening to
 * somebody's production GTM container. The properties asserted here are the ones that make write
 * access defensible, so they are tested from the attacker's side as well as the happy path.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ApprovalBroker, ApprovalError, summarizeWrite } from '../approvals.js';
import { onClientGone } from '../sse.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const ARGS = { accountId: '1', containerId: '2', name: 'GA4 Purchase' };

console.log('the gate itself');

await test('a write does not proceed until the user approves', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  let settled = false;

  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i)).then((o) => {
    settled = true;
    return o;
  });

  // Nothing may resolve on its own.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, 'the write resolved without anyone approving it');

  broker.resolve(id, 'user-1', 'approve');
  const outcome = await pending;
  assert.equal(outcome.approved, true);
});

await test('declining resolves rather than throwing, so the model can react', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  broker.resolve(id, 'user-1', 'decline');
  const outcome = await pending;
  assert.equal(outcome.approved, false);
  assert.equal(outcome.approved === false && outcome.reason, 'declined');
});

await test('an unanswered approval times out as declined, never as approved', async () => {
  const broker = new ApprovalBroker(30);
  // The broker unrefs its timer so a parked approval never holds the process open, which is right
  // in production and means the loop would otherwise drain before the timeout fires here.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const outcome = await broker.request('user-1', 'tags_create', ARGS, () => {});
    assert.equal(outcome.approved, false);
    assert.equal(outcome.approved === false && outcome.reason, 'timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

console.log('who may approve');

await test('another user cannot approve someone else\'s write', async () => {
  // An approval id is a capability. Without this the id becomes a way to authorize a change
  // against a container the approver has no access to.
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('victim', 'tags_create', ARGS, (i) => (id = i));

  assert.throws(
    () => broker.resolve(id, 'attacker', 'approve'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'not_yours',
  );

  // And the original must still be waiting, not collaterally resolved.
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
});

await test('an approval cannot be replayed', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  broker.resolve(id, 'user-1', 'approve');
  await pending;
  assert.throws(
    () => broker.resolve(id, 'user-1', 'approve'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'unknown_approval',
  );
});

await test('an unknown id is rejected', () => {
  const broker = new ApprovalBroker();
  assert.throws(
    () => broker.resolve('no-such-id', 'user-1', 'approve'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'unknown_approval',
  );
});

console.log('editing what the model proposed');

await test('the user\'s corrected arguments are what execute', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  broker.resolve(id, 'user-1', 'approve', { ...ARGS, name: 'Corrected By Human' });
  const outcome = await pending;
  assert.equal(outcome.approved && outcome.args.name, 'Corrected By Human');
});

await test('without edits the original arguments are preserved', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  broker.resolve(id, 'user-1', 'approve');
  const outcome = await pending;
  assert.deepEqual(outcome.approved && outcome.args, ARGS);
});

console.log('abandonment');

await test('abandoning a turn declines that turn\'s parked write only', async () => {
  // Scoped to the turn, not the user. It used to be abortFor(userId), so one tab closing (or, once
  // the close listener was fixed, any turn simply finishing) declined the cards the same user had
  // waiting in another conversation.
  const broker = new ApprovalBroker();
  const turn = new AbortController();
  let mineId = '';
  const mine = broker.request('user-1', 'tags_create', ARGS, (i) => (mineId = i), undefined, turn.signal);
  const otherConversation = broker.request(
    'user-1',
    'tags_create',
    ARGS,
    () => {},
    undefined,
    new AbortController().signal,
  );
  const theirs = broker.request('user-2', 'tags_create', ARGS, () => {});

  turn.abort();

  const outcome = await mine;
  assert.equal(outcome.approved, false);
  assert.equal(outcome.approved === false && outcome.reason, 'aborted');

  let othersSettled = 0;
  void otherConversation.then(() => othersSettled++);
  void theirs.then(() => othersSettled++);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(othersSettled, 0, 'an approval outside the aborted turn was collaterally cancelled');
  assert.equal(broker.stats().pending, 2);
  assert.equal(mineId.length > 0, true);
});

await test('a turn that has already ended parks nothing', async () => {
  const broker = new ApprovalBroker();
  const turn = new AbortController();
  turn.abort();
  let carded = false;
  const outcome = await broker.request('user-1', 'tags_create', ARGS, () => (carded = true), undefined, turn.signal);
  assert.equal(outcome.approved === false && outcome.reason, 'aborted');
  assert.equal(carded, false, 'a card was shown for a turn nobody is watching');
  assert.equal(broker.stats().pending, 0);
});

await test('an abort after the decision changes nothing', async () => {
  const broker = new ApprovalBroker();
  const turn = new AbortController();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i), undefined, turn.signal);
  broker.resolve(id, 'user-1', 'approve');
  assert.equal((await pending).approved, true);
  turn.abort();
  assert.equal(broker.stats().pending, 0);
});

await test('pending count reflects outstanding approvals', async () => {
  const broker = new ApprovalBroker();
  assert.equal(broker.stats().pending, 0);
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  assert.equal(broker.stats().pending, 1);
  broker.resolve(id, 'user-1', 'decline');
  await pending;
  assert.equal(broker.stats().pending, 0);
});

console.log('noticing that the client left');

/**
 * Serves one POST the way the chat route does (body read by express.json(), then an SSE head) and
 * reports how many times onClientGone fired. `leave` drops the connection mid-stream, as closing
 * the tab does; otherwise the server ends the response normally.
 */
async function serveOnce(leave: boolean): Promise<number> {
  const app = express();
  app.use(express.json());
  let gone = 0;
  let closed!: () => void;
  const handled = new Promise<void>((r) => (closed = r));
  app.post('/chat', (_req, res) => {
    onClientGone(res, () => gone++);
    res.on('close', () => setImmediate(closed));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {}\n\n');
    if (!leave) res.end();
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const client = http.request(
    { host: '127.0.0.1', port, method: 'POST', path: '/chat', headers: { 'content-type': 'application/json' } },
    (res) => {
      res.once('data', () => (leave ? client.destroy() : res.resume()));
    },
  );
  client.on('error', () => {});
  client.end(JSON.stringify({ messages: [] }));
  await handled;
  server.closeAllConnections();
  server.close();
  return gone;
}

await test('a client that leaves mid-stream is noticed, so its turn can be stopped', async () => {
  // The listener used to be on the request, which had already closed by the time the handler ran,
  // so a turn whose client was gone kept running and spending tokens.
  assert.equal(await serveOnce(true), 1);
});

await test('a response that simply finished is not mistaken for a client leaving', async () => {
  assert.equal(await serveOnce(false), 0);
});

console.log('typed confirmation for deletes');

await test('a delete cannot be approved without typing the word', async () => {
  // Enforced here, not in the UI. A client-side gate is a suggestion; this one has to be a rule.
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_delete', ARGS, (i) => (id = i), 'DELETE');

  assert.throws(
    () => broker.resolve(id, 'user-1', 'approve'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'confirmation_required',
  );
  assert.throws(
    () => broker.resolve(id, 'user-1', 'approve', undefined, 'delete'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'confirmation_required',
    'the check must be exact, not case-insensitive',
  );
  assert.throws(
    () => broker.resolve(id, 'user-1', 'approve', undefined, 'DELETE THIS'),
    (e: unknown) => e instanceof ApprovalError && e.code === 'confirmation_required',
  );

  // Still parked after every rejected attempt.
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);

  broker.resolve(id, 'user-1', 'approve', undefined, 'DELETE');
  assert.equal((await pending).approved, true);
});

await test('surrounding whitespace in the typed word is tolerated', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_delete', ARGS, (i) => (id = i), 'DELETE');
  broker.resolve(id, 'user-1', 'approve', undefined, '  DELETE  ');
  assert.equal((await pending).approved, true);
});

await test('declining a delete needs no typed word', async () => {
  // Making it harder to say no than to say yes would be exactly backwards.
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_delete', ARGS, (i) => (id = i), 'DELETE');
  broker.resolve(id, 'user-1', 'decline');
  assert.equal((await pending).approved, false);
});

await test('a non-delete write needs no typed word', async () => {
  const broker = new ApprovalBroker();
  let id = '';
  const pending = broker.request('user-1', 'tags_create', ARGS, (i) => (id = i));
  broker.resolve(id, 'user-1', 'approve');
  assert.equal((await pending).approved, true);
});

console.log('card headline');

await test('the summary names the action and the subject', () => {
  assert.equal(
    summarizeWrite('tags_create', { name: 'GA4 Purchase' }),
    'Create tags: GA4 Purchase',
  );
  assert.match(summarizeWrite('ga4_custom_dimension_create', { displayName: 'Plan' }), /^Create GA4/);
  assert.match(summarizeWrite('triggers_update', { triggerId: '77' }), /trigger 77/);
});

await test('a delete headline names what is being removed', () => {
  assert.match(summarizeWrite('tags_delete', { tagId: '42' }), /^Delete from tags: 42$/);
  assert.match(summarizeWrite('triggers_delete', {}), /^Delete from triggers$/);
});

await test('a nameless write still produces a readable headline', () => {
  const out = summarizeWrite('variables_create', {});
  assert.equal(out.includes('undefined'), false);
  assert.match(out, /^Create variables$/);
});

console.log(`\n${passed} assertions passed`);
