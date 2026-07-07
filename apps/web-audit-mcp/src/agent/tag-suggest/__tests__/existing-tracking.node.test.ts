/**
 * Existing-tracking detector — pure heuristics tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/existing-tracking.node.test.ts
 */
import { detectExistingTracking } from '../existing-tracking.js';
import type { PageSignals } from '../types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const sig = (o: Partial<PageSignals>): PageSignals => ({ scriptSrcs: [], classNames: [], selectorsPresent: [], ...o });
const page = (o: Partial<PageSignals>) => ({ signals: sig(o) });

// ── GTM + GA4 via gtag ────────────────────────────────────────────────────────
{
  const t = detectExistingTracking([
    page({ scriptSrcs: ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123', 'https://www.googletagmanager.com/gtag/js?id=G-ABC123'] }),
  ]);
  check('gtm.js → gtm:true', t.gtm === true);
  check('gtag G-ABC123 → ga4:true', t.ga4 === true);
  check('ga4MeasurementIds = [G-ABC123]', t.ga4MeasurementIds.length === 1 && t.ga4MeasurementIds[0] === 'G-ABC123');
}

// ── ga4 only via a G-XXXX id (no explicit gtag/analytics host) ────────────────
{
  const t = detectExistingTracking([page({ scriptSrcs: ['https://cdn.example.com/loader.js?id=G-XYZ789'] })]);
  check('a bare G-XYZ789 id → ga4:true + id extracted', t.ga4 === true && t.ga4MeasurementIds[0] === 'G-XYZ789');
}

// ── GTM alone must NOT imply ga4 (conservative) ───────────────────────────────
{
  const t = detectExistingTracking([page({ scriptSrcs: ['https://www.googletagmanager.com/gtm.js?id=GTM-ONLY'] })]);
  check('gtm alone does NOT imply ga4', t.gtm === true && t.ga4 === false && t.ga4MeasurementIds.length === 0);
}

// ── Meta Pixel ────────────────────────────────────────────────────────────────
{
  const t = detectExistingTracking([page({ scriptSrcs: ['https://connect.facebook.net/en_US/fbevents.js'] })]);
  check('connect.facebook.net → metaPixel:true', t.metaPixel === true);
  check('meta without google → ga4:false, gtm:false', t.ga4 === false && t.gtm === false);
}

// ── Google Ads / TikTok / LinkedIn ────────────────────────────────────────────
{
  const t = detectExistingTracking([
    page({ scriptSrcs: ['https://www.googletagmanager.com/gtag/js?id=AW-111222333', 'https://analytics.tiktok.com/i18n/pixel/events.js', 'https://snap.licdn.com/li.lms-analytics/insight.min.js'] }),
  ]);
  check('AW- id → googleAds:true', t.googleAds === true);
  check('analytics.tiktok.com → tiktok:true', t.tiktok === true);
  check('snap.licdn.com → linkedin:true', t.linkedin === true);
}

// ── dataLayerEvents union across 2 pages, deduped ─────────────────────────────
{
  const t = detectExistingTracking([
    page({ dataLayerEvents: ['gtm.js', 'page_view', 'form_submit'] }),
    page({ dataLayerEvents: ['gtm.js', 'newsletter_signup'] }), // gtm.js repeats → deduped
  ]);
  check('dataLayerEvents unioned + deduped',
    t.dataLayerEvents.length === 4 &&
    ['gtm.js', 'page_view', 'form_submit', 'newsletter_signup'].every((e) => t.dataLayerEvents.includes(e)),
    JSON.stringify(t.dataLayerEvents));
}

// ── framework passthrough (first non-empty wins) ──────────────────────────────
{
  const t = detectExistingTracking([page({}), page({ framework: 'next' }), page({ framework: 'react' })]);
  check('framework = first non-empty across pages', t.framework === 'next');
  const none = detectExistingTracking([page({}), page({})]);
  check('no framework → undefined', none.framework === undefined);
}

// ── selectorsPresent also matched (a gtag id can arrive there) ────────────────
{
  const t = detectExistingTracking([page({ selectorsPresent: ['https://www.googletagmanager.com/gtag/js?id=G-SEL999'] })]);
  check('script signature matched from selectorsPresent too', t.ga4 === true && t.ga4MeasurementIds[0] === 'G-SEL999');
}

// ── empty scan → all false, no throw ──────────────────────────────────────────
{
  const t = detectExistingTracking([]);
  check('empty scan → all-false ExistingTracking',
    !t.gtm && !t.ga4 && !t.googleAds && !t.metaPixel && !t.tiktok && !t.linkedin &&
    t.ga4MeasurementIds.length === 0 && t.dataLayerEvents.length === 0 && t.framework === undefined);
}

// ── two distinct GA4 ids across pages, deduped + sorted ───────────────────────
{
  const t = detectExistingTracking([
    page({ scriptSrcs: ['https://www.googletagmanager.com/gtag/js?id=G-BBB222'] }),
    page({ scriptSrcs: ['https://www.googletagmanager.com/gtag/js?id=G-AAA111', 'https://www.googletagmanager.com/gtag/js?id=G-BBB222'] }),
  ]);
  check('multiple GA4 ids deduped + sorted', t.ga4MeasurementIds.join(',') === 'G-AAA111,G-BBB222');
}

console.log(`\nExisting-tracking: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
