// Pure tests for the bounded page-worker pool that parallelizes tag verification / suggestion shots.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-pagepool.test.ts
//
// The pool's contract is the load-bearing correctness claim of the "scan multiple pages at once" work:
//   1. EVERY page is processed EXACTLY ONCE (no page twice, none left behind),
//   2. no more than `concurrency` pages run at a time,
//   3. each worker's isolated resource is created once and torn down once.

import { runPagePool, clampConcurrency, defaultPageConcurrency, PAGE_CONCURRENCY_CAP } from '../verify-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 3));

// ── clampConcurrency: never above the cap, the page count, and never below 1 ──────────────────────
{
  check('clamp: explicit request is honoured within bounds', clampConcurrency(3, 10) === 3);
  check('clamp: request above cap is capped', clampConcurrency(100, 50) === PAGE_CONCURRENCY_CAP);
  check('clamp: never more workers than pages', clampConcurrency(8, 2) === 2);
  check('clamp: zero/undefined → machine default (>=1)', clampConcurrency(0, 10) >= 1 && clampConcurrency(undefined, 10) >= 1);
  check('clamp: 0 pages → 1 (no divide-by-zero, harmless)', clampConcurrency(4, 0) === 1);
  check('default: within [1, cap]', defaultPageConcurrency(10) >= 1 && defaultPageConcurrency(10) <= PAGE_CONCURRENCY_CAP);
}

async function poolChecks(): Promise<void> {
  // ── exactly-once + none-left-behind, under real interleaving ──────────────────────────────────
  {
    const N = 50;
    const groups = Array.from({ length: N }, (_, i) => i);
    const seen = new Map<number, number>(); // group → times processed
    let madeWorkers = 0;
    let closedWorkers = 0;
    let active = 0;
    let maxActive = 0;
    const CONC = 4;
    await runPagePool(
      groups,
      CONC,
      async () => { madeWorkers += 1; return { id: madeWorkers }; },
      async (_w, g) => {
        active += 1; maxActive = Math.max(maxActive, active);
        await tick(); // force overlap so every worker is in-flight at once
        seen.set(g, (seen.get(g) ?? 0) + 1);
        active -= 1;
      },
      async () => { closedWorkers += 1; },
    );
    check('pool: every page processed (none left behind)', seen.size === N);
    check('pool: no page processed twice', [...seen.values()].every((c) => c === 1));
    check('pool: all N group indices present 0..N-1', groups.every((g) => seen.get(g) === 1));
    check('pool: concurrency never exceeded', maxActive <= CONC, `maxActive=${maxActive}`);
    check('pool: concurrency was actually reached (parallel, not serial)', maxActive === CONC, `maxActive=${maxActive}`);
    check('pool: one worker made + closed per lane', madeWorkers === CONC && closedWorkers === CONC, `made=${madeWorkers} closed=${closedWorkers}`);
  }

  // ── fewer pages than workers → workers capped at page count, still exactly-once ────────────────
  {
    const groups = ['a', 'b'];
    const seen: string[] = [];
    let made = 0;
    await runPagePool(groups, 5, async () => { made += 1; return {}; }, async (_w, g) => { await tick(); seen.push(g); }, async () => {});
    check('pool: 2 pages, cap 5 → only 2 workers spawned', made === 2, `made=${made}`);
    check('pool: 2 pages both processed once', seen.length === 2 && new Set(seen).size === 2);
  }

  // ── empty queue → no workers, no throw ────────────────────────────────────────────────────────
  {
    let made = 0;
    let threw = false;
    try { await runPagePool([], 4, async () => { made += 1; return {}; }, async () => {}, async () => {}); }
    catch { threw = true; }
    check('pool: empty groups → no worker, no throw', made === 0 && !threw);
  }

  // ── concurrency 1 → strictly sequential (old behaviour preserved) ──────────────────────────────
  {
    const groups = [1, 2, 3, 4, 5];
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    await runPagePool(groups, 1, async () => ({}), async (_w, g) => { active += 1; maxActive = Math.max(maxActive, active); await tick(); order.push(g); active -= 1; }, async () => {});
    check('pool: concurrency 1 is strictly sequential', maxActive === 1);
    check('pool: concurrency 1 still covers every page in order', JSON.stringify(order) === JSON.stringify(groups));
  }

  // ── teardown ALWAYS runs even when a page handler throws (resource-leak guard) ─────────────────
  {
    let closed = 0;
    let rejected = false;
    try {
      await runPagePool([1, 2], 1, async () => ({}), async (_w, g) => { if (g === 1) throw new Error('boom'); }, async () => { closed += 1; });
    } catch { rejected = true; }
    check('pool: a throwing handler still tears the worker down (finally)', closed === 1);
    check('pool: a throwing handler rejects the pool (surfaced, not swallowed)', rejected);
  }
}

void poolChecks().then(() => {
  console.log(`\nverify-pagepool: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 18) { console.error(`expected >= 18 checks, got ${passed}`); process.exit(1); }
});
