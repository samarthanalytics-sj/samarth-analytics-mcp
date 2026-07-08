// Parallel-crawl orchestration tests (no browser). Proves the driver POOL added to crawlAndSuggest /
// scanUrls scans pages CONCURRENTLY while still visiting every page EXACTLY ONCE (no page twice, none
// left behind), respects the page budget, and closes every driver. Uses fake drivers that add latency
// (so opens genuinely overlap) and share a tracker recording concurrency + the URLs opened.
//
// Run: tsx apps/desktop/src/main/suggestions/__tests__/scan-parallel.node.test.ts

import { crawlAndSuggest, scanUrls, type PageDriver, type DrivenPage } from '../scan-core';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const norm = (u: string): string => u.replace(/\/$/, '');
const a = (href: string): { tag: 'a'; href: string; text: string; hasDownload: boolean; region: '' } => ({ tag: 'a', href, text: 'link', hasDownload: false, region: '' });
const rawOf = (hrefs: string[]): DrivenPage['raw'] => ({ elements: hrefs.map(a), signals: { scriptSrcs: [], classNames: [], selectorsPresent: [], iframeSrcs: [] } });
const page = (url: string, links: string[]): DrivenPage => ({ ok: true, httpStatus: 200, finalUrl: url, raw: rawOf(links), rawForms: [] });

interface Tracker { opened: string[]; active: number; maxActive: number; closes: number }
const newTracker = (): Tracker => ({ opened: [], active: 0, maxActive: 0, closes: 0 });

/** A fake driver that serves `pages` by URL with an artificial delay so concurrent opens across a pool
 *  actually overlap; every driver in a pool shares one tracker so maxActive is the true parallelism. */
function poolDriver(pages: Record<string, DrivenPage>, t: Tracker, delayMs = 6): PageDriver {
  return {
    async open(url: string): Promise<DrivenPage> {
      t.active += 1;
      t.maxActive = Math.max(t.maxActive, t.active);
      t.opened.push(url);
      await new Promise((r) => setTimeout(r, delayMs));
      t.active -= 1;
      return pages[url] ?? pages[norm(url)] ?? { ok: false, httpStatus: null, finalUrl: null, error: 'not found' };
    },
    async close(): Promise<void> { t.closes += 1; },
  };
}
const poolOf = (n: number, pages: Record<string, DrivenPage>, t: Tracker): PageDriver[] =>
  Array.from({ length: n }, () => poolDriver(pages, t));

// A 3-level tree: home → 4 children → each 2 grandchildren = 13 pages, all within depth 2.
const H = 'https://acme.com/';
const TREE: Record<string, DrivenPage> = (() => {
  const kids = ['a', 'b', 'c', 'd'];
  const pages: Record<string, DrivenPage> = {};
  pages[H] = page(H, kids.map((k) => `${H}${k}`));
  for (const k of kids) {
    pages[`${H}${k}`] = page(`${H}${k}`, [`${H}${k}1`, `${H}${k}2`]);
    pages[`${H}${k}1`] = page(`${H}${k}1`, []);
    pages[`${H}${k}2`] = page(`${H}${k}2`, []);
  }
  return pages;
})();
const TREE_SIZE = 13;

async function run(): Promise<void> {
  // ── crawlAndSuggest: parallel BFS visits EVERY page exactly once, concurrently ────────────────
  {
    const t = newTracker();
    const pool = poolOf(4, TREE, t);
    const res = await crawlAndSuggest(pool[0], H, { maxPages: 20, maxDepth: 2, drivers: pool.slice(1) });
    const uniqueOpened = new Set(t.opened.map(norm));
    check('crawl/par: every reachable page scanned', res.summary.pagesScanned === TREE_SIZE, `${res.summary.pagesScanned}`);
    check('crawl/par: no page opened twice (exactly-once)', uniqueOpened.size === t.opened.length && t.opened.length === TREE_SIZE, `opened ${t.opened.length}, unique ${uniqueOpened.size}`);
    check('crawl/par: none left behind (every tree URL opened)', Object.keys(TREE).every((u) => uniqueOpened.has(norm(u))));
    check('crawl/par: ran CONCURRENTLY (maxActive > 1)', t.maxActive > 1, `maxActive=${t.maxActive}`);
    check('crawl/par: concurrency never exceeded the pool size', t.maxActive <= 4, `maxActive=${t.maxActive}`);
    check('crawl/par: every driver in the pool was closed', t.closes === 4, `closes=${t.closes}`);
  }

  // ── budget is respected under concurrency: exactly maxPages scanned, not maxPages + workers ────
  {
    const t = newTracker();
    const pool = poolOf(4, TREE, t);
    const res = await crawlAndSuggest(pool[0], H, { maxPages: 5, maxDepth: 3, drivers: pool.slice(1) });
    check('crawl/budget: exactly maxPages scanned despite N concurrent workers', res.summary.pagesScanned === 5, `${res.summary.pagesScanned}`);
    check('crawl/budget: never opened more than the budget', new Set(t.opened.map(norm)).size === 5, `${t.opened.length}`);
  }

  // ── equivalence: the SET of pages scanned is identical at concurrency 1 vs 4 ───────────────────
  {
    const t1 = newTracker();
    const solo = poolOf(1, TREE, t1);
    const r1 = await crawlAndSuggest(solo[0], H, { maxPages: 20, maxDepth: 2 });
    const t4 = newTracker();
    const quad = poolOf(4, TREE, t4);
    const r4 = await crawlAndSuggest(quad[0], H, { maxPages: 20, maxDepth: 2, drivers: quad.slice(1) });
    const set1 = [...new Set(t1.opened.map(norm))].sort();
    const set4 = [...new Set(t4.opened.map(norm))].sort();
    check('crawl/equiv: same pages scanned at concurrency 1 and 4', JSON.stringify(set1) === JSON.stringify(set4));
    check('crawl/equiv: same suggestion count at concurrency 1 and 4', r1.summary.suggestions === r4.summary.suggestions, `${r1.summary.suggestions} vs ${r4.summary.suggestions}`);
    check('crawl/equiv: concurrency 1 stayed sequential (maxActive === 1)', t1.maxActive === 1, `maxActive=${t1.maxActive}`);
  }

  // ── scanUrls (fixed list): parallel, exactly-once over the list, all drivers closed ────────────
  {
    const list = Array.from({ length: 10 }, (_, i) => `${H}p${i}`);
    const pages: Record<string, DrivenPage> = {};
    for (const u of list) pages[u] = page(u, []);
    const t = newTracker();
    const pool = poolOf(4, pages, t);
    const res = await scanUrls(pool[0], list, 'acme.com', undefined, { drivers: pool.slice(1) });
    const uniqueOpened = new Set(t.opened.map(norm));
    check('scanUrls/par: every listed page scanned once', res.summary.pagesScanned === 10 && uniqueOpened.size === 10 && t.opened.length === 10, `scanned=${res.summary.pagesScanned} opened=${t.opened.length}`);
    check('scanUrls/par: ran concurrently', t.maxActive > 1, `maxActive=${t.maxActive}`);
    check('scanUrls/par: all pool drivers closed', t.closes === 4, `closes=${t.closes}`);
  }

  // ── early return on a non-crawlable start URL still closes the WHOLE pool (no driver leak) ─────
  {
    const t = newTracker();
    const pool = poolOf(3, {}, t); // start URL is an asset (.xml) → normalizeUrl → null → early return
    const res = await crawlAndSuggest(pool[0], 'https://acme.com/sitemap.xml', { maxPages: 10, drivers: pool.slice(1) });
    check('crawl/early-return: non-crawlable start → empty result', res.summary.pagesScanned === 0);
    check('crawl/early-return: EVERY pool driver closed, not just the primary (no leak)', t.closes === 3, `closes=${t.closes}`);
  }

  // ── a dead page (nav failure) in the middle doesn't stall or skip the rest ─────────────────────
  {
    const list = [`${H}ok1`, `${H}dead`, `${H}ok2`, `${H}ok3`];
    const pages: Record<string, DrivenPage> = { [`${H}ok1`]: page(`${H}ok1`, []), [`${H}ok2`]: page(`${H}ok2`, []), [`${H}ok3`]: page(`${H}ok3`, []) };
    // `${H}dead` absent → the fake driver returns { ok:false } → notScanned, others proceed.
    const t = newTracker();
    const pool = poolOf(3, pages, t);
    const res = await scanUrls(pool[0], list, 'acme.com', undefined, { drivers: pool.slice(1) });
    check('scanUrls/par: a failed page is recorded, the rest still scanned', res.summary.pagesScanned === 3 && new Set(t.opened.map(norm)).size === 4);
  }
}

void run().then(() => {
  console.log(`\nscan-parallel: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 17) { console.error(`expected >= 17 checks, got ${passed}`); process.exit(1); }
});
