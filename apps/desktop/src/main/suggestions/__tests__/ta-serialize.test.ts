// Proves serializeProfile() gives MUTUAL EXCLUSION — the concurrency guarantee that stops two
// launchPersistentContext calls from hitting the one ta-profile at once (which crashes Chromium and
// surfaced as the "sign-in not completed" failure). Run: tsx …/__tests__/ta-serialize.test.ts

import { serializeProfile, taProfileDirFor } from '../ta-driver';

let passed = 0, failed = 0;
const fails: string[] = [];
const check = (n: string, ok: boolean) => { ok ? passed++ : (failed++, fails.push('✗ ' + n)); };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 1) No overlap: track concurrent executions; must never exceed 1.
  let active = 0, maxActive = 0;
  const order: number[] = [];
  const task = (id: number, ms: number) => serializeProfile(async () => {
    active += 1; maxActive = Math.max(maxActive, active);
    await sleep(ms);
    order.push(id);
    active -= 1;
    return id;
  });
  // Fire five tasks "at once" with varied durations — a lock collision would spike maxActive.
  const results = await Promise.all([task(1, 30), task(2, 5), task(3, 20), task(4, 5), task(5, 10)]);
  check('never more than one task runs at a time', maxActive === 1);
  check('all tasks completed', results.join(',') === '1,2,3,4,5');
  check('tasks ran in submission order (FIFO)', order.join(',') === '1,2,3,4,5');

  // 2) A rejecting task must not wedge the queue — later tasks still run.
  let ranAfterReject = false;
  await serializeProfile(async () => { throw new Error('boom'); }).catch(() => undefined);
  await serializeProfile(async () => { ranAfterReject = true; });
  check('a rejected task does not block subsequent tasks', ranAfterReject);

  // 3) The rejection propagates to its OWN caller (not swallowed).
  let caught = false;
  await serializeProfile(async () => { throw new Error('x'); }).catch(() => { caught = true; });
  check('rejection surfaces to the caller', caught);

  // 5) Per-account profile keying: distinct accounts → distinct dirs; same account → same dir; ids are
  //    sanitized to a safe path segment; a missing id falls back to a shared 'default' bucket.
  const ud = 'C:/Users/x/AppData/Roaming/app';
  check('per-account: distinct accounts get distinct profile dirs',
    taProfileDirFor(ud, 'acc-1') !== taProfileDirFor(ud, 'acc-2'));
  check('per-account: same account id is stable across calls',
    taProfileDirFor(ud, 'acc-1') === taProfileDirFor(ud, 'acc-1'));
  check('per-account: dir lives under ta-profiles/<id>',
    taProfileDirFor(ud, 'acc-1').endsWith('/ta-profiles/acc-1'));
  check('per-account: unsafe chars in id are stripped (no path escape)',
    taProfileDirFor(ud, '../../etc/passwd').endsWith('/ta-profiles/etcpasswd'));
  check('per-account: missing id falls back to a default bucket',
    taProfileDirFor(ud, null).endsWith('/ta-profiles/default') && taProfileDirFor(ud, undefined).endsWith('/ta-profiles/default'));

  console.log(`\nta-serialize: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(fails.join('\n')); process.exit(1); }
  if (passed < 10) { console.error(`expected >= 10 checks, got ${passed}`); process.exit(1); }
}
void main();
