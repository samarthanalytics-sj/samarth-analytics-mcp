/**
 * Live smoke test against a REAL URL, gated behind env flags so the offline
 * suite is unaffected. The operator supplies the URL (+ optional spec + expected
 * overall):
 *   VERIFY_LIVE_URL=https://site.com \
 *   VERIFY_LIVE_SPEC=./spec.json \
 *   VERIFY_LIVE_EXPECT=Pass \
 *   tsx apps/web-audit-mcp/src/verify/__tests__/live-smoke.browser.test.ts
 *
 * With no VERIFY_LIVE_SPEC, a minimal spec (page_view + ga4 present) is used.
 */

import { readFileSync } from 'node:fs';
import { verifyPage, formatHuman } from '../index.js';
import { loadPlaywright } from '../../agent/browser.js';
import { harness } from './_helpers.js';

const { check, done } = harness('live-smoke');

const url = process.env.VERIFY_LIVE_URL;
if (!url) {
  // eslint-disable-next-line no-console
  console.log('live-smoke: SKIPPED — set VERIFY_LIVE_URL to run');
  process.exit(0);
}

const pw = await loadPlaywright();
if (!pw) {
  // eslint-disable-next-line no-console
  console.log('live-smoke: SKIPPED — playwright/chromium not installed');
  process.exit(0);
}

const specPath = process.env.VERIFY_LIVE_SPEC;
const raw = specPath
  ? { ...(JSON.parse(readFileSync(specPath, 'utf8')) as object), url }
  : {
      url,
      expectedTrackers: ['ga4'],
      checks: [
        { id: 'pv', type: 'event_fired', event: 'page_view' },
        { id: 'ga4', type: 'tracker_present', tracker: 'ga4' },
      ],
    };

const report = await verifyPage(raw, { headless: true });
// eslint-disable-next-line no-console
console.log(formatHuman(report));

check('live: produced a report with checks', report.checks.length > 0);
check('live: overall is a known status', ['Pass', 'Partial', 'Fail', 'Not Verified'].includes(report.overall));

const expected = process.env.VERIFY_LIVE_EXPECT;
if (expected) {
  check(`live: overall === ${expected}`, report.overall === expected, `got ${report.overall}`);
}

done(2);
