// Pure tests for the tag-verification results export builders (HTML). Run:
// tsx src/shared/__tests__/verify-results-html.test.ts
import { verifyResultsHtml, siteLabel } from '../verify-results-html';
import type { VerifyExportPayload, VerifyExportRow } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const rows: VerifyExportRow[] = [
  { status: 'Fired', tag: 'GA4 - Event - Phone Click Tag', triggerEvent: 'gtm.linkClick', firedVia: 'Tag', signal: 'GTM monitor: success', screenshot: PNG },
  { status: 'Issue', tag: 'Meta - Purchase', triggerEvent: 'gtm.click', firedVia: 'Click', signal: '—' },
];
const payload = (over: Partial<VerifyExportPayload> = {}): VerifyExportPayload => ({
  url: 'https://www.example.com/',
  authoritative: true,
  counts: { fired: 1, config: 0, server: 0, untested: 0, issues: 1 },
  pagesDriven: 8,
  pagesCrawled: 226,
  pagesTotal: 300,
  rows,
  ...over,
});

// ── siteLabel ──────────────────────────────────────────────────────────────────
check('siteLabel strips www + scheme', siteLabel('https://www.example.com/x') === 'example.com');
check('siteLabel of a bad url is empty', siteLabel('not a url') === '');
check('siteLabel of undefined is empty', siteLabel(undefined) === '');

// ── verifyResultsHtml ────────────────────────────────────────────────────────────
const html = verifyResultsHtml(payload());
check('html: heading shows the host', html.includes('Tag Verification Report — example.com'));
check('html: authoritative note present', /Authoritative/.test(html));
check('html: coverage line reflects pages driven/crawled/total', html.includes('Drove across 8 pages') && html.includes('scanned 226 of 300 site pages'));
check('html: table header has Event, and no GA4 event column', html.includes('<th>Event</th>') && !html.includes('GA4 event'));
check('html: does not show a configured GA4 event name (removed)', !html.includes('<code>phone_click</code>'));
check('html: embeds the proof screenshot as an <img> data-uri', html.includes(`<img src="${PNG}"`));
check('html: a row without a screenshot shows a dash, not an img', (html.match(/<img /g) || []).length === 1);
check('html: scorecard shows Fired + Issues counts', html.includes('>1</div><div style="font-size:12px;color:#374151;margin-top:3px">Fired</div>') || (/Fired/.test(html) && /Issues/.test(html)));

// Security: a non-image / script data-URI is NEVER embedded, and tag names are HTML-escaped.
const evil = verifyResultsHtml(payload({
  rows: [{ status: 'Fired', tag: '<img src=x onerror=alert(1)>', screenshot: 'data:text/html,<script>alert(1)</script>' }],
}));
check('html: rejects a non-image screenshot data-uri (no injection)', !evil.includes('<script>alert(1)</script>') && !evil.includes('data:text/html'));
check('html: escapes a malicious tag name', evil.includes('&lt;img src=x onerror=alert(1)&gt;') && !evil.includes('<img src=x onerror'));

// Empty run: no rows → a friendly note, no <table>.
const none = verifyResultsHtml(payload({ rows: [], counts: { fired: 0, config: 0, server: 0, untested: 0, issues: 0 } }));
check('html: empty run shows a note and no table', none.includes('No tags were verified') && !none.includes('<table>'));

// config/server cards only appear when non-zero (mirrors the on-screen scorecard).
const full = verifyResultsHtml(payload({ counts: { fired: 3, config: 2, server: 1, untested: 4, issues: 0 } }));
check('html: scorecard adds Config OK / Server-side / Untested when > 0', /Config OK/.test(full) && /Server-side/.test(full) && /Untested/.test(full));

console.log(`\nverify-results-html: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
