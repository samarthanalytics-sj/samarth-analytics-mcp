import assert from 'node:assert/strict';
import { buildGa4WriteTools, validateDataStreamBody } from '../ga4-write-tools';
import type { GoogleDataService } from '../../google/data-service';

let passed = 0;
let failed = 0;
let pending = 0;
function test(name: string, fn: () => Promise<void>): void {
  pending++;
  fn()
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; })
    .finally(() => { pending--; if (pending === 0) { console.log(`\n${passed} passed, ${failed} failed`); if (failed > 0) process.exit(1); } });
}

type Call = { verb: string; args: unknown[] };
function build(): { tools: ReturnType<typeof buildGa4WriteTools>; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (verb: string) => (...args: unknown[]) => {
    calls.push({ verb, args });
    return Promise.resolve({ ok: true });
  };
  const fake = {
    ga4AdminCreate: rec('create'),
    ga4AdminPatch: rec('patch'),
    ga4AdminDelete: rec('delete'),
    ga4AdminArchive: rec('archive'),
    ga4UpdateEnhancedMeasurement: rec('em'),
    ga4UpdateDataRedaction: rec('redaction'),
    ga4UpdateAttribution: rec('attribution'),
    ga4UpdateGoogleSignals: rec('signals'),
  } as unknown as GoogleDataService;
  return { tools: buildGa4WriteTools(fake), calls };
}

console.log('\nga4-write-tools:');

test('update_ga4_data_stream: typed defaultUri nests under webStreamData with a valid derived mask', async () => {
  const { tools, calls } = build();
  const t = tools.find((x) => x.name === 'update_ga4_data_stream')!;
  await t.handler({ name: 'properties/5/dataStreams/9', defaultUri: 'https://djhomeswa.com.au' });
  const patch = calls.find((c) => c.verb === 'patch')!;
  assert.ok(patch, 'patch was called');
  const [, , name, mask, body] = patch.args as [string, string, string, string, Record<string, unknown>];
  assert.equal(name, 'properties/5/dataStreams/9');
  assert.equal(mask, 'webStreamData', 'mask is a REAL field path, never the flat arg name');
  assert.deepEqual(body, { webStreamData: { defaultUri: 'https://djhomeswa.com.au' } });
});

test('update_ga4_data_stream REFUSES Google-tag-settings fields with directions, before any API call', async () => {
  const { tools, calls } = build();
  const t = tools.find((x) => x.name === 'update_ga4_data_stream')!;
  await assert.rejects(
    async () => t.handler({ name: 'properties/5/dataStreams/9', body: { webStreamData: { domains: ['a.com'], unwantedReferrals: ['b.com'] } } }),
    (e: Error) =>
      /Google tag settings/i.test(e.message) &&
      /Configure tag settings/.test(e.message) &&
      /webStreamData\.domains/.test(e.message) &&
      /webStreamData\.unwantedReferrals/.test(e.message),
  );
  assert.equal(calls.length, 0, 'the invalid body never reached the API');
});

test('create_ga4_data_stream still passes valid nested bodies and rejects tag-settings smuggling', async () => {
  const { tools, calls } = build();
  const c = tools.find((x) => x.name === 'create_ga4_data_stream')!;
  await c.handler({ property: '5', type: 'WEB_DATA_STREAM', displayName: 'Web', defaultUri: 'https://x.com' });
  const create = calls.find((x) => x.verb === 'create')!;
  const body = create.args[3] as Record<string, unknown>;
  assert.deepEqual(body.webStreamData, { defaultUri: 'https://x.com' });
  await assert.rejects(
    async () => c.handler({ property: '5', type: 'WEB_DATA_STREAM', displayName: 'Web', body: { sessionTimeoutDuration: '1800s' } }),
    /not GA4 Admin API data-stream fields: sessionTimeoutDuration/,
  );
});

test('singleton settings tools target their settings children with real masks', async () => {
  const { tools, calls } = build();
  const em = tools.find((x) => x.name === 'update_ga4_enhanced_measurement')!;
  await em.handler({ property: '5', dataStreamId: '9', siteSearchEnabled: true, searchQueryParameter: 'q,search' });
  const emCall = calls.find((c) => c.verb === 'em')!;
  assert.equal(emCall.args[0], 'properties/5/dataStreams/9/enhancedMeasurementSettings');
  assert.equal(emCall.args[1], 'siteSearchEnabled,searchQueryParameter');
  const sig = tools.find((x) => x.name === 'update_ga4_google_signals')!;
  await sig.handler({ property: '7', state: 'GOOGLE_SIGNALS_DISABLED' });
  const sigCall = calls.find((c) => c.verb === 'signals')!;
  assert.equal(sigCall.args[0], 'properties/7/googleSignalsSettings');
  assert.deepEqual(sigCall.args[2], { state: 'GOOGLE_SIGNALS_DISABLED' });
  const at = tools.find((x) => x.name === 'update_ga4_attribution_settings')!;
  await assert.rejects(async () => at.handler({ property: '7' }), /supply at least one setting/);
});

test('validateDataStreamBody: clean bodies pass; the message lists ONLY the offending fields', async () => {
  validateDataStreamBody({ displayName: 'x' }, false);
  validateDataStreamBody({ type: 'WEB_DATA_STREAM', displayName: 'x', webStreamData: { defaultUri: 'https://a' } }, true);
  try {
    validateDataStreamBody({ displayName: 'ok', webStreamData: { defaultUri: 'https://a', domains: [] } }, false);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok((e as Error).message.includes('webStreamData.domains'));
    assert.ok(/fields: webStreamData\.domains\./.test((e as Error).message), 'only the offending field is blamed: ' + (e as Error).message);
  }
});
