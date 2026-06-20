/**
 * Phase 3 orchestrator — pure report-building tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/scan.node.test.ts
 */
import { pagePath, toPageScan, assembleTagReport, accountNotScanned, type AssembleArgs } from '../scan.js';
import type { PageScan, PageScanRaw, RawElement } from '../collect.js';
import type { PageSignals } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const NO_SIG: PageSignals = { scriptSrcs: [], classNames: [], selectorsPresent: [] };
const a = (href: string, over: Partial<RawElement> = {}): RawElement => ({ tag: 'a', href, text: '', hasDownload: false, region: '', ...over });

// ── pagePath ─────────────────────────────────────────────────────────────────
check('pagePath: keeps the path', pagePath('https://acme.com/contact') === '/contact');
check('pagePath: root → "/"', pagePath('https://acme.com') === '/');
check('pagePath: drops query + hash', pagePath('https://acme.com/contact?utm=x#f') === '/contact');
check('pagePath: unparseable falls back to input', pagePath('::bogus') === '::bogus');

// ── toPageScan ───────────────────────────────────────────────────────────────
const raw: PageScanRaw = { elements: [a('mailto:hi@acme.com', { region: 'footer' }), a('https://acme.com/about')], signals: NO_SIG };
const ps = toPageScan('https://acme.com/contact?ref=nav', raw, [{ purpose: 'contact', action: 'https://acme.com/submit' }], 'acme.com');
check('toPageScan: stamps the page path (query stripped)', ps.page === '/contact');
check('toPageScan: classifies + keeps only trackable elements (mailto, drops internal nav)', ps.elements.length === 1 && ps.elements[0].kind === 'email');
check('toPageScan: element page path stamped on each element', ps.elements.every((e) => e.page === '/contact'));
check('toPageScan: forms carried through', ps.forms.length === 1 && ps.forms[0].purpose === 'contact');

// ── assembleTagReport (end-to-end through buildSuggestions) ───────────────────
const sigHub: PageSignals = { scriptSrcs: ['https://js.hsforms.net/forms/v2.js'], classNames: ['hs-form'], selectorsPresent: ['.hs-form'] };
const pages: PageScan[] = [
  // contact page: HubSpot contact form + a footer mailto
  { page: '/contact', signals: sigHub, forms: [{ purpose: 'contact', action: 'https://js.hsforms.net/x' }],
    elements: toPageScan('https://acme.com/contact', { elements: [a('mailto:hi@acme.com', { region: 'footer' })], signals: sigHub }, [], 'acme.com').elements },
  // home page: the SAME footer mailto (should dedup to one, marked site-wide) + a download
  { page: '/', signals: NO_SIG, forms: [],
    elements: toPageScan('https://acme.com/', { elements: [a('mailto:hi@acme.com', { region: 'footer' }), a('https://acme.com/guide.pdf')], signals: NO_SIG }, [], 'acme.com').elements },
];
const args: AssembleArgs = {
  site: 'https://acme.com', siteHost: 'acme.com', scannedAt: '2026-06-20T00:00:00.000Z',
  pagesCrawled: 7, pageScans: pages,
  notScanned: [{ url: 'https://acme.com/login', reason: 'over scan budget' }],
  notes: ['create note'],
};
const report = assembleTagReport(args);

check('report: passes through meta (site, host, scannedAt, pagesCrawled)',
  report.site === 'https://acme.com' && report.siteHost === 'acme.com' &&
  report.scannedAt === '2026-06-20T00:00:00.000Z' && report.summary.pagesCrawled === 7);
check('report: pagesScanned = number of page scans', report.summary.pagesScanned === 2);
check('report: formsFound counts forms across pages', report.summary.formsFound === 1);
check('report: trackableElements counts elements across pages (3 raw → 3 detected)', report.summary.trackableElements === 3);

const events = report.suggestions.map((s) => s.eventName);
check('report: contact(HubSpot) → generate_lead', events.includes('generate_lead'));
check('report: mailto → email_click (single, deduped site-wide)',
  events.filter((e) => e === 'email_click').length === 1);
const mail = report.suggestions.find((s) => s.eventName === 'email_click');
check('report: repeated footer mailto collapses to "site-wide"', mail?.page === 'site-wide');
check('report: download → file_download', events.includes('file_download'));

check('report: suggestions count = unique tags (generate_lead, email_click, file_download)', report.summary.suggestions === 3);
check('report: byConfidence sums to suggestions',
  report.summary.byConfidence.high + report.summary.byConfidence.medium + report.summary.byConfidence.low === report.summary.suggestions);
check('report: file_download flagged as Enhanced-Measurement overlap', report.summary.enhancedMeasurementOverlap === 1);
check('report: newTracking = suggestions − EM overlap', report.summary.newTracking === report.summary.suggestions - report.summary.enhancedMeasurementOverlap);

check('report: every suggestion is a creatable ga4_event payload',
  report.suggestions.every((s) => s.platform === 'ga4_event' && !!s.tagName && !!s.measurementId && !!s.eventName && !!s.trigger.kind));
check('report: suggestions ranked high→low confidence',
  report.suggestions.every((s, i, arr) => i === 0 || ({ high: 0, medium: 1, low: 2 }[arr[i - 1].confidence] <= { high: 0, medium: 1, low: 2 }[s.confidence])));

check('report: per-page breakdown reflects detected counts',
  report.pages.length === 2 &&
  report.pages.some((p) => p.page === '/contact' && p.forms === 1 && p.elements === 1) &&
  report.pages.some((p) => p.page === '/' && p.forms === 0 && p.elements === 2));
check('report: notScanned + notes carried through', report.notScanned.length === 1 && report.notes.length === 1);

// ── accountNotScanned: accurate reasons, each page listed exactly once ────────
{
  const scanned = new Set(['https://acme.com/contact', 'https://acme.com/']);
  const crawlPages = [
    { url: 'https://acme.com/', httpStatus: 200 },                                  // scanned → omitted
    { url: 'https://acme.com/contact', httpStatus: 200 },                           // scanned → omitted
    { url: 'https://acme.com/gone', httpStatus: 404 },                              // http error
    { url: 'https://acme.com/err', httpStatus: 500 },                               // http error
    { url: 'https://acme.com/blog', httpStatus: 200 },                              // over budget (ok, not a target)
    { url: 'https://acme.com/dead', httpStatus: null, note: 'navigation failed: timeout' }, // crawl note
  ];
  const skipped = [{ url: 'https://acme.com/admin', reason: 'private network' }];
  const collectFailures = [{ url: 'https://acme.com/contact', reason: 'scan failed: boom' }]; // a target that died mid-collect
  const out = accountNotScanned(crawlPages, skipped, scanned, collectFailures);

  const reasonFor = (u: string) => out.filter((n) => n.url === u);
  check('accountNotScanned: 404/500 labeled "http N" (not "over scan budget")',
    reasonFor('https://acme.com/gone')[0]?.reason === 'http 404' && reasonFor('https://acme.com/err')[0]?.reason === 'http 500');
  check('accountNotScanned: ok-but-unscanned page → "over scan budget"',
    reasonFor('https://acme.com/blog')[0]?.reason === 'over scan budget');
  check('accountNotScanned: crawl-noted page carries its note', /timeout/.test(reasonFor('https://acme.com/dead')[0]?.reason ?? ''));
  check('accountNotScanned: SSRF-skipped page carried through', reasonFor('https://acme.com/admin')[0]?.reason === 'private network');
  check('accountNotScanned: scanned-success pages are NOT listed', reasonFor('https://acme.com/').length === 0);
  check('accountNotScanned: a target that failed mid-collect is listed once (scan failed), not duplicated',
    reasonFor('https://acme.com/contact').length === 1 && reasonFor('https://acme.com/contact')[0].reason.startsWith('scan failed'));
}

// Empty input is a valid (empty) report, not a crash.
const empty = assembleTagReport({ site: 's', siteHost: 'h', scannedAt: 't', pagesCrawled: 0, pageScans: [], notScanned: [], notes: [] });
check('report: empty scan → zero suggestions, no throw', empty.summary.suggestions === 0 && empty.suggestions.length === 0 && empty.pages.length === 0);

console.log(`\nTag-scan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
