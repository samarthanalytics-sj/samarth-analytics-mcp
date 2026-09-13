import assert from 'node:assert/strict';
import { parseGtagSnapshot, diffGtagSnapshots } from '../gtag-spy';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// Fixture mirrors the REAL structure fetched live for G-EWV8Q3DDZ8 (2026-07 session).
function gtagJs(overrides: { keyEvents?: string[]; signalsOff?: boolean; search?: string } = {}): string {
  const rules = (overrides.keyEvents ?? ['purchase', 'form_start']).map(
    (e) => ['map', 'matchingRules', JSON.stringify({ type: 5, args: [{ stringValue: e }, { contextValue: { namespaceType: 1, keyParts: ['eventName'] } }] })],
  );
  const data = {
    resource: {
      version: '1',
      macros: [{ function: '__e' }],
      tags: [
        { function: '__ogt_auto_events', vtp_enableOutboundClick: true, vtp_enableScroll: true, vtp_enableDownload: true, vtp_enableHistoryEvents: true, vtp_enableForm: true, vtp_enableVideo: true, vtp_enablePageView: true },
        { function: '__ogt_1p_data_v2', vtp_isAutoEnabled: true, vtp_isManualEnabled: false, vtp_autoPhoneEnabled: true, vtp_isEnabled: true, vtp_autoAddressEnabled: true, vtp_autoEmailEnabled: true },
        { function: '__ccd_ga_regscope', vtp_settingsTable: ['list', ['map', 'redactFieldGroup', 'DEVICE_AND_GEO', 'disallowAllRegions', false, 'disallowedRegions', ''], ['map', 'redactFieldGroup', 'GOOGLE_SIGNALS', 'disallowAllRegions', overrides.signalsOff ?? true, 'disallowedRegions', '']], vtp_instanceDestinationId: 'G-TEST123' },
        { function: '__ccd_em_site_search', vtp_searchQueryParams: overrides.search ?? 'q,s,search,query,keyword', vtp_includeParams: true },
        { function: '__ccd_conversion_marking', vtp_conversionRules: ['list', ...rules] },
        { function: '__ccd_auto_redact', vtp_redactEmail: true },
        { function: '__gct', vtp_trackingId: 'G-TEST123', vtp_sessionDuration: 0 },
      ],
      predicates: [],
      rules: [],
    },
    blob: { '1': '1', '10': 'G-TEST123|GT-ABC999', '21': 'www.googletagmanager.com' },
  };
  return `// Copyright\n(function(){\n\nvar data = ${JSON.stringify(data, null, 1)};\n\nmore code here })()`;
}

console.log('\ngtag-spy:');

test('parses the real blob shape: EM toggles, key events, UPDC, redaction, signals, destinations', () => {
  const s = parseGtagSnapshot('G-TEST123', gtagJs());
  assert.equal(s.parsed, true);
  assert.deepEqual(s.destinations, ['G-TEST123', 'GT-ABC999']);
  assert.deepEqual(s.keyEvents, ['purchase', 'form_start']);
  assert.equal(s.autoEvents!.scroll, true);
  assert.equal(s.userData!.auto, true);
  assert.equal(s.userData!.email, true);
  assert.equal(s.redactEmail, true);
  assert.equal(s.googleSignalsDisallowedEverywhere, true);
  assert.equal(s.serverContainerUrl, null, 'no sGTM endpoint -> null, never guessed');
  assert.equal(s.sessionDurationSec, 0);
  assert.ok(s.tagFunctions.includes('__gct'));
});

test('unparseable content degrades to parsed:false - never a fabricated snapshot', () => {
  const s = parseGtagSnapshot('G-X', 'not a gtag script at all');
  assert.equal(s.parsed, false);
  assert.deepEqual(s.keyEvents, []);
  assert.deepEqual(diffGtagSnapshots(s, parseGtagSnapshot('G-X', gtagJs())), [], 'an unparsed side never produces changes');
});

test('diff reports REAL config changes with before/after, and nothing on identical snapshots', () => {
  const a = parseGtagSnapshot('G-TEST123', gtagJs());
  const b = parseGtagSnapshot('G-TEST123', gtagJs({ keyEvents: ['purchase'], signalsOff: false, search: 'q,term' }));
  const changes = diffGtagSnapshots(a, b);
  const fields = changes.map((c) => c.field);
  assert.ok(fields.includes('key events'), 'removed form_start detected');
  assert.ok(fields.includes('Google Signals disabled everywhere'));
  assert.ok(fields.includes('site-search params'));
  const ke = changes.find((c) => c.field === 'key events')!;
  assert.equal(ke.before, 'purchase, form_start');
  assert.equal(ke.after, 'purchase');
  assert.deepEqual(diffGtagSnapshots(a, parseGtagSnapshot('G-TEST123', gtagJs())), [], 'identical config -> zero changes');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
