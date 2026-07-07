// Pure tests for the real-submit driver's analytics-abort gate (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/form-submit-driver.test.ts
//
// SAFETY-CRITICAL: isAnalyticsHit decides which requests are captured+aborted (never delivered) vs
// let through. It MUST catch first-party sGTM (/g/collect on any host) so a real submit doesn't send a
// test conversion to real GA4, and MUST NOT match a normal form POST (which would kill the submission).

import { isAnalyticsHit } from '../form-submit-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── ABORT (analytics — must never be delivered on a real submit) ─────────────────────────────────
check('direct GA4 /g/collect', isAnalyticsHit('https://www.google-analytics.com/g/collect?v=2&tid=G-1&en=generate_lead'));
check('direct GA4 /collect (v=2)', isAnalyticsHit('https://www.google-analytics.com/collect?v=2&tid=G-1'));
check('region GA4 host', isAnalyticsHit('https://region1.google-analytics.com/g/collect?v=2&tid=G-1'));
check('FIRST-PARTY sGTM /g/collect (the fix)', isAnalyticsHit('https://sgtm.samarthanalytics.com/g/collect?v=2&tid=G-1&en=form_submission'));
check('first-party sGTM /g/collect no query still caught (POST-batch)', isAnalyticsHit('https://sgtm.example.com/g/collect'));
check('Meta pixel facebook.com/tr', isAnalyticsHit('https://www.facebook.com/tr?id=1&ev=Lead'));
check('generic /collect with tid', isAnalyticsHit('https://collect.example.com/collect?tid=G-1&en=x'));

// ── DELIVER (a real form POST / normal request — must NOT be aborted) ─────────────────────────────
check('CF7 REST feedback endpoint NOT analytics', !isAnalyticsHit('https://site.com/wp-json/contact-form-7/v1/contact-forms/12/feedback'));
check('WordPress admin-ajax NOT analytics', !isAnalyticsHit('https://site.com/wp-admin/admin-ajax.php'));
check('Gravity forms submit path NOT analytics', !isAnalyticsHit('https://site.com/?gf_page=preview'));
check('plain form action /submit NOT analytics', !isAnalyticsHit('https://site.com/submit'));
check('a /collect WITHOUT GA4 markers is not treated as analytics', !isAnalyticsHit('https://site.com/api/collect'));
check('a normal page/api request NOT analytics', !isAnalyticsHit('https://site.com/api/leads'));
check('a static asset NOT analytics', !isAnalyticsHit('https://site.com/assets/app.js'));
check('a bad url is not analytics (no throw)', !isAnalyticsHit('not a url'));

console.log(`\nform-submit-driver: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 14) { console.error(`expected >= 14 checks, got ${passed}`); process.exit(1); }
