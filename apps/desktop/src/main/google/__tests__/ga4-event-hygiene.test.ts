import assert from 'node:assert/strict';
import { auditGa4EventHygiene, toSnakeEventName, type Ga4EventHygieneInput } from '../ga4-event-hygiene';

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

const ev = (name: string, count = 100, priorCount = 90): Ga4EventHygieneInput['events'][number] => ({ name, count, priorCount });
const run = (over: Partial<Ga4EventHygieneInput> = {}) =>
  auditGa4EventHygiene({ events: [ev('page_view'), ev('cta_click')], keyEventNames: [], windowDays: 28, ...over });

console.log('\nGA4 event hygiene:');

test('toSnakeEventName: camelCase, PascalCase, hyphens, spaces, repeats', () => {
  assert.equal(toSnakeEventName('PageView'), 'page_view');
  assert.equal(toSnakeEventName('ctaClick'), 'cta_click');
  assert.equal(toSnakeEventName('page-view'), 'page_view');
  assert.equal(toSnakeEventName('Add To Cart'), 'add_to_cart');
  assert.equal(toSnakeEventName('CTA__Click!'), 'cta_click');
});

test('clean snake_case events produce NO finding', () => {
  assert.deepEqual(run(), []);
});

test('a misspelt STANDARD event gets the standard rename at MEDIUM', () => {
  const f = run({ events: [ev('PageView'), ev('signup'), ev('Add To Cart')] });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].category, 'hygiene');
  assert.ok(/"PageView" -> page_view \(GA4 standard name\)/.test(f[0].message), f[0].message);
  assert.ok(/"signup" -> sign_up/.test(f[0].message), 'normalized match finds sign_up');
  assert.ok(/"Add To Cart" -> add_to_cart/.test(f[0].message));
  assert.ok(/Rename at the source/.test(f[0].recommendation));
});

test('a non-standard convention violation gets a snake_case rename at LOW', () => {
  const f = run({ events: [ev('heroBannerClick'), ev('cta_click')] });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'low', 'no standard-name misspelling involved');
  assert.ok(/"heroBannerClick" -> hero_banner_click/.test(f[0].message));
});

test('system names (gtm.*, _internal, "(not set)") and zero-traffic events are ignored', () => {
  const f = run({ events: [ev('gtm.linkClick'), ev('_ga_internal'), ev('(not set)'), { name: 'OldEvent', count: 0, priorCount: 0 }] });
  assert.deepEqual(f, []);
});

test('high-cardinality name families flagged at >=5 variants, not at 4', () => {
  const five = ['product_101_click', 'product_102_click', 'product_103_click', 'product_104_click', 'product_105_click'].map((n) => ev(n));
  const f = run({ events: five });
  assert.equal(f.length, 1);
  assert.ok(/product_#_click \(5 variants, e\.g\. "product_101_click"\)/.test(f[0].message), f[0].message);
  assert.ok(/parameter/.test(f[0].recommendation), 'recommends moving the id into a parameter');
  const four = five.slice(0, 4);
  assert.deepEqual(run({ events: four }), [], '4 variants is not a family problem');
});

test('key event that NEVER fired (zero both windows) → integrity finding; drop-to-zero left to ga4-integrity', () => {
  const f = run({ events: [ev('page_view'), { name: 'demo_booked', count: 0, priorCount: 0 }], keyEventNames: ['demo_booked', 'page_view'] });
  assert.equal(f.length, 1);
  assert.equal(f[0].category, 'integrity');
  assert.ok(/"demo_booked"/.test(f[0].message) && /ZERO times/.test(f[0].message), f[0].message);
  assert.ok(/last 56 days/.test(f[0].message), 'names the doubled window');
  // prior>0 -> 0 is the drop-to-zero case, owned by ga4-integrity - no duplicate finding here.
  const dropped = run({ events: [ev('page_view'), { name: 'demo_booked', count: 0, priorCount: 40 }], keyEventNames: ['demo_booked'] });
  assert.deepEqual(dropped, []);
  // A key event absent from the list entirely is also "never fired".
  const absent = run({ events: [ev('page_view')], keyEventNames: ['ghost_goal'] });
  assert.equal(absent.length, 1);
});

test('never-fired check stays SILENT when the event list may be truncated', () => {
  const f = run({ events: [ev('page_view')], keyEventNames: ['ghost_goal'], possiblyTruncated: true });
  assert.deepEqual(f, [], 'absence at the row cap is not evidence');
});

test('all three checks can fire together, one aggregated finding each', () => {
  const f = run({
    events: [ev('PageView'), ...['a_1_x', 'a_2_x', 'a_3_x', 'a_4_x', 'a_5_x'].map((n) => ev(n))],
    keyEventNames: ['ghost_goal'],
  });
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((x) => x.category), ['hygiene', 'hygiene', 'integrity']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
