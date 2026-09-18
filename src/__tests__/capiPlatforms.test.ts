/**
 * The one table that describes every conversion-API destination.
 *
 * Its whole purpose is to stop the four facts about a platform (detection regexes, credential
 * fields, gallery coordinates, builder call) drifting apart in four files, so these tests check
 * the table is internally consistent and that every entry can actually build a tag.
 *
 * Run: tsx src/__tests__/capiPlatforms.test.ts
 */
import assert from 'assert';
import {
  CAPI_PLATFORMS, capiPlatform, capiValueKeys, capiCredentials, webPixelPlatform,
} from '../shared/capi-platforms';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}

console.log('\ncapi-platforms:');

test('every typed builder is represented exactly once', () => {
  const ids = CAPI_PLATFORMS.map((p) => p.platform);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate platform ids');
  assert.equal(ids.length, 17, 'seventeen typed destinations');
  for (const p of CAPI_PLATFORMS) assert.equal(capiPlatform(p.platform)?.platform, p.platform);
  assert.equal(capiPlatform('nope'), null, 'an unknown id resolves to nothing, never a guess');
});

test('every entry declares complete, well-formed credentials', () => {
  for (const p of CAPI_PLATFORMS) {
    assert.ok(p.fields.length > 0, `${p.platform} names at least one credential`);
    assert.equal(new Set(p.fields.map((f) => f.key)).size, p.fields.length, `${p.platform} field keys unique`);
    for (const f of p.fields) {
      assert.ok(f.label.trim().length > 0, `${p.platform}.${f.key} has a human label`);
      assert.ok(!f.label.includes('—'), `${p.platform}.${f.key} label must not use an em dash`);
    }
    assert.ok(p.gallery[0] && p.gallery[1], `${p.platform} has gallery coordinates`);
    assert.ok(p.label.trim().length > 0);
  }
});

test('value keys are namespaced, so two vendors can both want an "accessToken"', () => {
  const meta = capiPlatform('meta')!;
  const reddit = capiPlatform('reddit')!;
  assert.deepEqual(capiValueKeys(meta), ['meta.pixelId', 'meta.accessToken']);
  assert.deepEqual(capiValueKeys(reddit), ['reddit.accountId', 'reddit.accessToken']);
  const all = CAPI_PLATFORMS.flatMap(capiValueKeys);
  assert.equal(new Set(all).size, all.length, 'no key collides across platforms');
});

test('credentials are read per platform, and blanks are reported by their own labels', () => {
  const nextdoor = capiPlatform('nextdoor')!;
  const full = capiCredentials(nextdoor, {
    'nextdoor.pixelId': 'ND1', 'nextdoor.clientId': 'C1', 'nextdoor.accessToken': 'T1',
    'meta.accessToken': 'SHOULD NOT LEAK',
  });
  assert.deepEqual(full.missing, []);
  assert.deepEqual(full.creds, { pixelId: 'ND1', clientId: 'C1', accessToken: 'T1' }, 'only its own fields');

  const partial = capiCredentials(nextdoor, { 'nextdoor.pixelId': ' ND1 ' });
  assert.equal(partial.creds.pixelId, 'ND1', 'trimmed');
  assert.equal(partial.missing.length, 2);
  assert.ok(partial.missing.every((m) => /Nextdoor|Channel|client/i.test(m)), partial.missing.join(', '));

  // Yelp is the shape a two-credential model could not express.
  assert.deepEqual(capiCredentials(capiPlatform('yelp')!, { 'yelp.accessToken': 'T' }).missing, []);
});

test('every platform builds a real tag from its declared fields', () => {
  for (const p of CAPI_PLATFORMS) {
    // Enumerated fields must get a value from their own set: the builders deliberately normalise
    // anything else to a safe default, so a synthetic string would never appear in the tag.
    const ENUMERATED: Record<string, string> = { 'amazon.region': 'EU', 'stackadapt.pixelType': 'conv' };
    const creds = Object.fromEntries(
      p.fields.map((f) => [f.key, ENUMERATED[`${p.platform}.${f.key}`] ?? `v_${f.key}`]),
    );
    const tag = p.build('cvt_1', `${p.label} - purchase`, creds, { event: 'purchase', firingTriggerId: ['7'] });
    const t = tag as unknown as { type?: string; name?: string; firingTriggerId?: string[]; parameter?: unknown[] };
    assert.equal(t.type, 'cvt_1', `${p.platform} uses the template type it was given`);
    assert.deepEqual(t.firingTriggerId, ['7'], `${p.platform} fires on the trigger it was given`);
    assert.ok(Array.isArray(t.parameter) && t.parameter.length > 0, `${p.platform} produced parameters`);
    const blob = JSON.stringify(t.parameter);
    // The declared credentials must actually reach the tag, or the field is decorative.
    for (const f of p.fields) {
      const expected = ENUMERATED[`${p.platform}.${f.key}`] ?? `v_${f.key}`;
      assert.ok(blob.includes(expected), `${p.platform}: ${f.key} never reaches the built tag`);
    }
  }
});

test('web pixels resolve to their platform, and GA4 tags never do', () => {
  const t = (type: string, name: string, html?: string) =>
    ({ type, name, parameter: html ? [{ key: 'html', value: html }] : [] });
  assert.equal(webPixelPlatform(t('html', 'Meta Pixel')), 'meta');
  assert.equal(webPixelPlatform(t('html', 'Anything', '<script>fbq("track")</script>')), 'meta', 'by body');
  assert.equal(webPixelPlatform(t('bzi', 'Insight')), 'linkedin', 'native type is authoritative');
  assert.equal(webPixelPlatform(t('baut', 'UET')), 'microsoft');
  assert.equal(webPixelPlatform(t('html', 'LinkedIn Insight', '<script src="https://snap.licdn.com/x"></script>')), 'linkedin',
    'linkedin is matched before snapchat for snap.licdn.com');
  for (const ga4 of ['gaawe', 'gaawc', 'googtag']) {
    assert.equal(webPixelPlatform(t(ga4, 'GA4 - Purchase')), null, `${ga4} is never a CAPI destination`);
  }
  assert.equal(webPixelPlatform(t('html', 'Some unrelated tag')), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
