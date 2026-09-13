// Tests for "is a form still on its way?". The counter runs INSIDE the scanned page, so these drive
// it against a hand-built DOM stub rather than a real browser: what matters is which containers count
// as pending, and that nothing here can throw a scan over.
// Run: tsx apps/web-audit-mcp/src/agent/__tests__/pending-embeds.node.test.ts
import { countPendingEmbedsInPage, EMBED_CONTAINER_SELECTORS } from '../pending-embeds.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** A minimal element stub: only what the counter touches. */
interface StubEl { tagName: string; matches: string[]; inner: string[] }
const el = (tagName: string, matches: string[], inner: string[] = []): StubEl => ({ tagName, matches, inner });

/** Install a document stub whose querySelectorAll answers from a fixture. */
function withDom(nodes: StubEl[], fn: () => number): number {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  // ONE wrapper object per node, reused across queries: the counter dedupes by element IDENTITY, so
  // a stub that minted a fresh object per selector would silently defeat that check.
  const wrappers = new Map<StubEl, unknown>();
  for (const n of nodes) {
    wrappers.set(n, {
      tagName: n.tagName,
      querySelector: (q: string) => {
        const wanted = q.split(',').map((x) => x.trim());
        return n.inner.some((i) => wanted.includes(i)) ? {} : null;
      },
    });
  }
  g.document = {
    querySelectorAll: (sel: string) => nodes.filter((n) => n.matches.includes(sel)).map((n) => wrappers.get(n)),
  };
  try { return fn(); } finally { g.document = before; }
}

// ── The case this exists for ────────────────────────────────────────────────────
check('a HubSpot container with no form yet counts as PENDING',
  withDom([el('DIV', ['.hs-form-html'])], countPendingEmbedsInPage) === 1);
check('once its form has rendered it is NOT pending',
  withDom([el('DIV', ['.hs-form-html'], ['form'])], countPendingEmbedsInPage) === 0);
check('a div-form (inputs, no <form>) also counts as arrived',
  withDom([el('DIV', ['.hbspt-form'], ['input'])], countPendingEmbedsInPage) === 0);
check('the <form> element itself is never pending (it matches [data-form-id] too)',
  withDom([el('FORM', ['[data-form-id]'])], countPendingEmbedsInPage) === 0);

// ── Counting ────────────────────────────────────────────────────────────────────
check('two empty containers count as two',
  withDom([el('DIV', ['.hs-form-html']), el('DIV', ['.mktoForm'])], countPendingEmbedsInPage) === 2);
check('one element matching SEVERAL selectors is counted once', (() => {
  // The real HubSpot wrapper matches both .hs-form-html and [data-form-id].
  const node = el('DIV', ['.hs-form-html', '[data-form-id]']);
  return withDom([node], countPendingEmbedsInPage) === 1;
})());
check('a page with no embeds waits for nothing', withDom([], countPendingEmbedsInPage) === 0);
check('an ordinary div is not an embed container',
  withDom([el('DIV', ['.some-card'])], countPendingEmbedsInPage) === 0);

// ── The other providers are actually wired ─────────────────────────────────────
for (const sel of ['.mktoForm', '.gform_wrapper', '.wpcf7', '[data-tf-widget]', '.pardotForm']) {
  check(`${sel} is recognised`, withDom([el('DIV', [sel])], countPendingEmbedsInPage) === 1);
}
check('the exported selector list matches what the in-page copy uses',
  EMBED_CONTAINER_SELECTORS.includes('.hs-form-html') && EMBED_CONTAINER_SELECTORS.includes('.mktoForm')
  && EMBED_CONTAINER_SELECTORS.length >= 10);

// ── It must never break a scan ──────────────────────────────────────────────────
check('a querySelectorAll that throws on one selector does not abort the count', (() => {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  let calls = 0;
  g.document = {
    querySelectorAll: (sel: string) => {
      calls += 1;
      if (sel === '.hbspt-form') throw new Error('unsupported selector');
      return sel === '.mktoForm' ? [{ tagName: 'DIV', querySelector: () => null }] : [];
    },
  };
  try { return countPendingEmbedsInPage() === 1 && calls > 3; } finally { g.document = before; }
})());
check('no document at all returns 0 rather than throwing', (() => {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  delete g.document;
  try { return countPendingEmbedsInPage() === 0; } finally { g.document = before; }
})());

console.log(`\npending-embeds: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
