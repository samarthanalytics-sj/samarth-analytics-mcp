/** gcs/gcd decode tests. Run: tsx apps/web-audit-mcp/src/verify/__tests__/consent-signals.node.test.ts */

import { decodeGcs, decodeGcd, analyticsStorageDenied, analyticsStorageGranted } from '../consent-signals.js';
import { harness } from './_helpers.js';

const { check, done } = harness('consent-signals');

// ── gcs ────────────────────────────────────────────────────────────────────────
const g111 = decodeGcs('G111');
check('gcs G111 ad granted', g111.adStorage === 'granted');
check('gcs G111 analytics granted', g111.analyticsStorage === 'granted');
const g100 = decodeGcs('G100');
check('gcs G100 ad denied', g100.adStorage === 'denied');
check('gcs G100 analytics denied', g100.analyticsStorage === 'denied');
const g101 = decodeGcs('G101');
check('gcs G101 ad denied', g101.adStorage === 'denied');
check('gcs G101 analytics granted', g101.analyticsStorage === 'granted');
const g110 = decodeGcs('G110');
check('gcs G110 ad granted', g110.adStorage === 'granted');
check('gcs G110 analytics denied', g110.analyticsStorage === 'denied');
check('gcs undefined → unknown', decodeGcs(undefined).analyticsStorage === 'unknown');
check('gcs garbage → unknown', decodeGcs('nonsense').analyticsStorage === 'unknown');
check('gcs raw preserved', decodeGcs('G111').raw === 'G111');

// ── predicates (drive the pre-consent firing sub-check) ─────────────────────────
check('analyticsStorageDenied(G100)', analyticsStorageDenied('G100') === true);
check('analyticsStorageDenied(G111) false', analyticsStorageDenied('G111') === false);
check('analyticsStorageDenied(undefined) false', analyticsStorageDenied(undefined) === false);
check('analyticsStorageGranted(G111)', analyticsStorageGranted('G111') === true);
check('analyticsStorageGranted(G100) false', analyticsStorageGranted('G100') === false);

// ── gcd (best-effort) ──────────────────────────────────────────────────────────
const gcdDenied = decodeGcd('11t1t1t1t5');
check('gcd t-codes → denied', gcdDenied.fields.ad_storage === 'denied' && gcdDenied.fields.analytics_storage === 'denied');
check('gcd 4 fields confident', gcdDenied.confident === true);
const gcdUnknown = decodeGcd('13l3l3l3l5');
check('gcd l-codes → unknown/not confident', gcdUnknown.confident === false);
check('gcd undefined → not confident', decodeGcd(undefined).confident === false);
check('gcd raw preserved', decodeGcd('11t1t1t1t5').raw === '11t1t1t1t5');

done(20);
