// Pure tests for the shared page-render cache (makePageCache) — the optimisation that makes the verify
// action's TWO crawls render each page ONCE. Injected clock; a counting fake driver. No browser.
// Run: tsx src/main/suggestions/__tests__/page-cache.test.ts

import { makePageCache } from '../scan-url';
import type { PageDriver, DrivenPage } from '../scan-core';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}`); }
}

const okPage = (url: string): DrivenPage => ({ ok: true, httpStatus: 200, finalUrl: url } as DrivenPage);
function counting(result: (url: string) => DrivenPage): { driver: PageDriver; opens: () => number } {
  let opens = 0;
  const driver: PageDriver = { open: async (url: string) => { opens += 1; return result(url); }, close: async () => {} };
  return { driver, opens: () => opens };
}

async function main(): Promise<void> {
  // ── dedup: concurrent + repeated same URL → ONE underlying render ──────────────
  {
    let t = 1000;
    const { driver, opens } = counting(okPage);
    const d = makePageCache(() => t, 90_000, 150).wrap(driver);
    await Promise.all([d.open('https://x.com/a'), d.open('https://x.com/a')]);
    check('dedup: concurrent same URL → 1 render', opens() === 1);
    await d.open('https://x.com/a/');        // trailing slash normalised
    await d.open('https://x.com/a#section'); // hash stripped
    check('dedup: trailing-slash + hash normalise to the same key → still 1', opens() === 1);
    await d.open('https://x.com/b');
    check('distinct URL → a new render', opens() === 2);
  }

  // ── TTL: within → cached, past → re-render ─────────────────────────────────────
  {
    let t = 1000;
    const { driver, opens } = counting(okPage);
    const d = makePageCache(() => t, 5_000).wrap(driver);
    await d.open('https://x.com/a');
    t += 4_000; await d.open('https://x.com/a');
    check('within TTL → served from cache (1 render)', opens() === 1);
    t += 2_000; await d.open('https://x.com/a'); // age 6000 > 5000 TTL
    check('past TTL → re-render (2 renders)', opens() === 2);
  }

  // ── a FAILED render is not cached → the next request retries ────────────────────
  {
    let t = 1000;
    let n = 0;
    const driver: PageDriver = { open: async () => { n += 1; return ({ ok: false, httpStatus: 500, finalUrl: null } as DrivenPage); }, close: async () => {} };
    const d = makePageCache(() => t).wrap(driver);
    await d.open('https://x.com/f');
    await d.open('https://x.com/f');
    check('failed render is NOT cached → retried', n === 2);
  }

  // ── the wrapper preserves close + optional methods ─────────────────────────────
  {
    let closed = false;
    const driver: PageDriver = { open: async (u) => okPage(u), close: async () => { closed = true; } };
    const d = makePageCache().wrap(driver);
    await d.close();
    check('wrapper delegates close()', closed);
    check('no screenshot on a driver without one', d.screenshot === undefined);
  }

  console.log(`\npage-cache: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 7) { console.error(`expected >= 7 checks, got ${passed}`); process.exit(1); }
}

void main();
