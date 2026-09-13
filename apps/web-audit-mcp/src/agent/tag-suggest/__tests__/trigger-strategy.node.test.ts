/** Trigger-condition decision framework: the ladder, the trigger-type rule, and the edge cases. */
import assert from 'node:assert/strict';
import {
  chooseClickConditions,
  classRegex,
  describeStrategy,
  isGenericClass,
  looksGenerated,
  looksGeneratedId,
  semanticClasses,
  strategyStability,
  type ElementFacts,
} from '../trigger-strategy.js';

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const link = (o: Partial<ElementFacts> = {}): ElementFacts => ({ triggerKind: 'link_click', ...o });
const button = (o: Partial<ElementFacts> = {}): ElementFacts => ({ triggerKind: 'all_clicks', ...o });

console.log('trigger-strategy');

// ── generated-class detection ────────────────────────────────────────────────
t('build-generated classes are rejected', () => {
  for (const c of ['css-1x2y3z', 'sc-AbCdEfGh', 'jss142', 'button_a1b2c3', '_1a2b3c4d', 'ng-tns-c12345678', 'wpgb-block-3', 'elementor-element-a1b2c3d', 'et_pb_button_1', 'a1b2c3d4e5']) {
    assert.equal(looksGenerated(c), true, `${c} should be rejected`);
  }
});

t('hand-written classes are kept', () => {
  for (const c of ['dealer-phone', 'book-a-demo', 'newsletter-signup', 'hero-cta', 'js-open-modal']) {
    assert.equal(looksGenerated(c), false, `${c} should be kept`);
  }
});

t('framework ids are rejected, author ids kept', () => {
  for (const id of ['react-aria-1', 'radix-:r3:', ':r7:', '550e8400-e29b-41d4-a716-446655440000', 'menu-item-1234567']) {
    assert.equal(looksGeneratedId(id), true, `${id} should be rejected`);
  }
  for (const id of ['book-demo-btn', 'contactForm', 'nav_signup']) {
    assert.equal(looksGeneratedId(id), false, `${id} should be kept`);
  }
});

t('generic wrappers and utilities are not identifying signals', () => {
  for (const c of ['btn', 'btn-primary', 'card', 'wrapper', 'elementor-widget', 'flex', 'px-4', 'text-center']) {
    assert.equal(isGenericClass(c), true, `${c} should be generic`);
  }
  assert.equal(isGenericClass('dealer-phone'), false);
});

t('semanticClasses strips noise and orders most-distinctive first', () => {
  // Longest first, alphabetical on a tie, so the pick is identical across runs.
  assert.deepEqual(semanticClasses('btn flex dealer-phone css-9x8y7z is-active contact-link'), ['contact-link', 'dealer-phone']);
  assert.deepEqual(semanticClasses('au-region dealer-phone'), ['dealer-phone', 'au-region']);
  assert.deepEqual(semanticClasses('btn btn-primary px-4'), []);
  assert.deepEqual(semanticClasses(undefined), []);
  // Tailwind arbitrary variants are valid attribute values but throw in querySelector.
  assert.deepEqual(semanticClasses('[&>svg]:rotate-180 dealer-email'), ['dealer-email']);
});

// ── the ladder ───────────────────────────────────────────────────────────────
t('rung 1: an author id beats everything below it', () => {
  const r = chooseClickConditions(link({ id: 'book-demo-btn', classes: 'dealer-phone', href: 'tel:+61', text: 'Call' }));
  assert.equal(r.signal, 'clickId');
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].variable, '{{Click ID}}');
  assert.equal(r.conditions[0].operator, 'equals');
  assert.equal(r.conditions[0].value, 'book-demo-btn');
});

t('rung 2: a semantic class beats href and text', () => {
  const r = chooseClickConditions(link({ classes: 'dealer-phone', href: '/contact', text: '03 9999 1234' }));
  assert.equal(r.signal, 'clickClasses');
  assert.equal(r.conditions[0].variable, '{{Click Classes}}');
  assert.equal(r.conditions[0].operator, 'matchRegex');
  assert.equal(r.conditions[0].value, '(^|\\s)dealer-phone(\\s|$)');
});

t('rung 3: contact schemes are matched by scheme, not by number', () => {
  const r = chooseClickConditions(link({ href: 'tel:+61399991234', text: '03 9999 1234' }));
  assert.equal(r.signal, 'clickUrl');
  assert.deepEqual([r.conditions[0].operator, r.conditions[0].value], ['startsWith', 'tel:']);
  assert.equal(chooseClickConditions(link({ href: 'mailto:a@b.com' })).conditions[0].value, 'mailto:');
});

t('rung 3: an outbound link is keyed on its host', () => {
  const r = chooseClickConditions(link({ href: 'https://partner.example.com/a/b?x=1', text: 'Visit' }));
  assert.equal(r.conditions[0].value, 'partner.example.com');
});

t('rung 4: text is the last resort', () => {
  const r = chooseClickConditions(button({ text: '  Get   a  Quote ' }));
  assert.equal(r.signal, 'clickText');
  assert.equal(r.conditions[0].value, 'Get a Quote');
  assert.equal(strategyStability(r), 'low');
});

t('nothing durable produces NO trigger rather than a guess', () => {
  const r = chooseClickConditions(button({ classes: 'btn btn-primary px-4', text: '' }));
  assert.equal(r.signal, null);
  assert.deepEqual(r.conditions, []);
  assert.match(describeStrategy(r), /No durable click signal/);
});

// ── the trigger-type rule (the silent-failure case) ──────────────────────────
t('all_clicks uses a descendant-safe CSS selector, not Click Classes', () => {
  const r = chooseClickConditions(button({ classes: 'book-a-demo' }));
  assert.equal(r.signal, 'clickClasses');
  assert.equal(r.conditions[0].variable, '{{Click Element}}');
  assert.equal(r.conditions[0].operator, 'cssSelector');
  assert.equal(r.conditions[0].value, '.book-a-demo, .book-a-demo *');
});

t('all_clicks does the same for an id', () => {
  const r = chooseClickConditions(button({ id: 'signup' }));
  assert.equal(r.conditions[0].value, '#signup, #signup *');
  assert.equal(r.conditions[0].operator, 'cssSelector');
});

t('link_click keeps the readable variable form', () => {
  assert.equal(chooseClickConditions(link({ classes: 'book-a-demo' })).conditions[0].variable, '{{Click Classes}}');
  assert.equal(chooseClickConditions(link({ id: 'signup' })).conditions[0].variable, '{{Click ID}}');
});

// ── multi-condition rules ────────────────────────────────────────────────────
t('a unique signal stays a SINGLE-condition trigger', () => {
  const r = chooseClickConditions(link({ classes: 'dealer-phone', occurrences: 1, page: '/contact-us' }));
  assert.equal(r.conditions.length, 1);
});

t('a shared class picks up a second class to narrow it', () => {
  const r = chooseClickConditions(link({ classes: 'dealer-phone au-region', occurrences: 12, page: '/locate-a-dealer' }));
  assert.equal(r.conditions.length, 2);
  assert.equal(r.conditions[1].variable, '{{Click Classes}}');
  assert.equal(r.conditions[1].value, '(^|\\s)au-region(\\s|$)');
});

t('a shared signal with nothing to narrow it falls back to page scoping', () => {
  const r = chooseClickConditions(link({ classes: 'dealer-phone', occurrences: 12, page: '/locate-a-dealer' }));
  assert.equal(r.conditions.length, 2);
  assert.equal(r.conditions[1].variable, '{{Page Path}}');
  assert.equal(r.conditions[1].operator, 'contains');
});

t('a short page path is scoped with equals, not contains', () => {
  const r = chooseClickConditions(link({ text: 'Submit', occurrences: 4, page: '/' }));
  assert.equal(r.conditions[1].operator, 'equals');
});

t('a sitewide component is NEVER page-scoped', () => {
  const r = chooseClickConditions(link({ text: 'Contact', occurrences: 9, page: '/about', sitewide: true }));
  assert.equal(r.conditions.length, 1, 'header/footer links must keep firing on every page');
});

// ── edge cases from the brief ────────────────────────────────────────────────
t('repeated components: one class-keyed trigger covers all instances', () => {
  const dealers = Array.from({ length: 12 }, (_, i) =>
    link({ classes: 'dealer-phone', href: `tel:+6139999${1000 + i}`, text: `03 9999 ${1000 + i}`, occurrences: 12, page: '/locate-a-dealer' }),
  );
  const built = dealers.map((d) => JSON.stringify(chooseClickConditions(d)));
  assert.equal(new Set(built).size, 1, 'all 12 dealer rows must collapse to ONE identical trigger');
  assert.equal(chooseClickConditions(dealers[0]).signal, 'clickClasses');
});

t('obfuscated email: the class carries the tag when there is no mailto', () => {
  // Cloudflare rewrites the href to /cdn-cgi/l/email-protection, so a tel:/mailto: rule finds nothing.
  const r = chooseClickConditions(link({ classes: 'dealer-email', href: '/cdn-cgi/l/email-protection#a1b2', text: '[email protected]', occurrences: 9, page: '/locate-a-dealer' }));
  assert.equal(r.signal, 'clickClasses');
  assert.equal(r.conditions[0].value, '(^|\\s)dealer-email(\\s|$)');
});

t('a non-link element (an address) is still trackable via its class', () => {
  const r = chooseClickConditions(button({ classes: 'dealer-address', text: '12 Example St', occurrences: 9, page: '/locate-a-dealer' }));
  assert.equal(r.signal, 'clickClasses');
  assert.equal(r.conditions[0].operator, 'cssSelector');
});

t('hidden/revealed content: state classes never scope the trigger', () => {
  // "is-active"/"collapsed" toggle as the element opens, so half the clicks would miss.
  const r = chooseClickConditions(link({ classes: 'faq-question collapsed is-active', occurrences: 6, page: '/faq' }));
  assert.equal(r.conditions[0].value, '(^|\\s)faq-question(\\s|$)');
  assert.equal(r.conditions.length, 2);
  assert.equal(r.conditions[1].variable, '{{Page Path}}', 'no second semantic class exists once state tokens are dropped');
});

t('SPA: a hash/JS route is not mistaken for an outbound host', () => {
  const r = chooseClickConditions(link({ href: '#/checkout', text: 'Checkout' }));
  assert.equal(r.conditions[0].variable, '{{Click URL}}');
  assert.equal(r.conditions[0].value, '#/checkout');
});

t('dynamic elements: a generated class is skipped for the stable one beside it', () => {
  const r = chooseClickConditions(link({ classes: 'css-1x2y3z checkout-submit sc-AbCdEfGh', occurrences: 1 }));
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].value, '(^|\\s)checkout-submit(\\s|$)');
});

t('classRegex escapes regex metacharacters in a class name', () => {
  assert.equal(classRegex('a.b+c'), '(^|\\s)a\\.b\\+c(\\s|$)');
});

t('the substring hazard that motivated matchRegex is actually avoided', () => {
  const re = new RegExp(classRegex('btn-buy'));
  assert.equal(re.test('btn-buy other'), true);
  assert.equal(re.test('other btn-buy'), true);
  assert.equal(re.test('btn-buy-now'), false, 'must NOT fire on a longer class that merely starts the same');
  assert.equal(re.test('xbtn-buy'), false);
});

t('stability grading matches the ladder', () => {
  assert.equal(strategyStability(chooseClickConditions(link({ id: 'x-signup' }))), 'high');
  assert.equal(strategyStability(chooseClickConditions(link({ classes: 'dealer-phone' }))), 'high');
  assert.equal(strategyStability(chooseClickConditions(link({ href: 'tel:+1' }))), 'high');
  assert.equal(strategyStability(chooseClickConditions(link({ href: '/pricing' }))), 'medium');
  assert.equal(strategyStability(chooseClickConditions(link({ text: 'Go' }))), 'low');
  assert.equal(strategyStability(chooseClickConditions(button({}))), 'none');
});

t('describeStrategy reads as an explanation, not a dump', () => {
  const d = describeStrategy(chooseClickConditions(link({ classes: 'dealer-phone', occurrences: 12, page: '/locate-a-dealer' })));
  assert.match(d, /^Fires when \{\{Click Classes\}\} matchRegex .* AND \{\{Page Path\}\} contains "\/locate-a-dealer"\./);
});

console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
