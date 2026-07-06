// Pure tests for the container-snapshot → verify-input mapper (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/container-verify.test.ts

import { snapshotToVerifyInputs } from '../container-verify';
import type { ContainerSnapshot, AuditTag, AuditTrigger } from '../../google/gtm-builders';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A GTM condition: arg0 = the {{variable}}, arg1 = the value. Negated conditions carry an extra
// {type:boolean, key:'negate', value:'true'} parameter (how GTM stores "does not equal/contain").
const cond = (variable: string, op: string, value: string, negate = false): Record<string, unknown> => ({
  type: op,
  parameter: [
    { type: 'template', key: 'arg0', value: variable },
    { type: 'template', key: 'arg1', value },
    ...(negate ? [{ type: 'boolean', key: 'negate', value: 'true' }] : []),
  ],
});
// The REAL GA4 event (gaawe) parameter shape: an EMPTY measurementId tagReference plus
// measurementIdOverride holding the actual G-XXXX (what buildGa4EventTag emits + what the API returns).
const ga4EventParams = (measurementId: string, eventName: string): AuditTag['parameter'] => [
  { type: 'tagReference', key: 'measurementId', value: '' },
  { type: 'template', key: 'measurementIdOverride', value: measurementId },
  { type: 'template', key: 'eventName', value: eventName },
];
const tag = (over: Partial<AuditTag>): AuditTag => ({
  tagId: '1', name: 'Tag', type: 'gaawe', firingTriggerId: [], paused: false, parameter: [], ...over,
});
const trig = (over: Partial<AuditTrigger>): AuditTrigger => ({ triggerId: 't1', name: 'Trig', type: 'linkClick', ...over });
const snap = (tags: AuditTag[], triggers: AuditTrigger[]): ContainerSnapshot => ({ tags, triggers, variables: [] });

// ── GA4 event tag (REAL shape) + link-click trigger with a Click Text condition ─────────────────
{
  const s = snap(
    [tag({ tagId: 'g1', name: 'CTA Tag', type: 'gaawe', firingTriggerId: ['t1'], parameter: ga4EventParams('G-1', 'cta_click') })],
    [trig({ triggerId: 't1', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Book a Call')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('gaawe → one verify input', r.tags.length === 1);
  check('event name extracted', r.tags[0]?.eventName === 'cta_click');
  // The real gaawe shape shadows the empty measurementId with measurementIdOverride — assert the id survives.
  check('measurementId from measurementIdOverride (not the empty tagReference)', r.tags[0]?.measurementId === 'G-1', JSON.stringify(r.tags[0]?.measurementId));
  check('link-click kind', r.tags[0]?.trigger.kind === 'link_click');
  check('click-text condition mapped', r.tags[0]?.trigger.clickTextValue === 'Book a Call' && r.tags[0]?.trigger.clickTextOperator === 'equals');
}

// ── googtag firing the built-in All Pages trigger → pageview ─────────────────────────────────────
{
  const s = snap(
    [tag({ tagId: 'base', name: 'GA4 Configuration', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'tagId', value: 'G-1' }] })],
    [],
  );
  const r = snapshotToVerifyInputs(s);
  check('googtag → pageview', r.tags.length === 1 && r.tags[0]?.trigger.kind === 'pageview' && r.tags[0]?.eventName === 'page_view');
  check('googtag measurementId from tagId', r.tags[0]?.measurementId === 'G-1');
}

// ── form submission trigger scoped by Form ID ────────────────────────────────────────────────────
{
  const s = snap(
    [tag({ tagId: 'f1', name: 'Contact Form', type: 'gaawe', firingTriggerId: ['tf'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'tf', type: 'formSubmission', filter: [cond('{{Form ID}}', 'equals', 'contact-form')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('form_submit kind + Form ID', r.tags[0]?.trigger.kind === 'form_submit' && r.tags[0]?.trigger.formIdValue === 'contact-form');
}

// ── custom-event trigger → event name from customEventFilter ─────────────────────────────────────
{
  const s = snap(
    [tag({ tagId: 'c1', name: 'Purchase', type: 'gaawe', firingTriggerId: ['tc'], parameter: ga4EventParams('G-1', 'purchase') })],
    [trig({ triggerId: 'tc', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'purchase')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event kind + dataLayer event name', r.tags[0]?.trigger.kind === 'custom_event' && r.tags[0]?.trigger.eventName === 'purchase');
}

// ── NEGATED condition ("Click Text does not equal X") → skipped (driver can't drive an exclusion) ─
{
  const s = snap(
    [tag({ tagId: 'n1', name: 'Neg Tag', type: 'gaawe', firingTriggerId: ['tn'], parameter: ga4EventParams('G-1', 'x') })],
    [trig({ triggerId: 'tn', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Logout', true)] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('negated condition → not emitted', r.tags.length === 0);
  check('negated condition → recorded as skipped', r.skipped.some((x) => x.tagId === 'n1'));
}

// ── page-scoped click WITH a Click Text condition → page lifted so it's driven on that page ───────
{
  const s = snap(
    [tag({ tagId: 'p1', name: 'Pricing CTA', type: 'gaawe', firingTriggerId: ['tp'], parameter: ga4EventParams('G-1', 'cta_click') })],
    [trig({ triggerId: 'tp', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Buy'), cond('{{Page Path}}', 'equals', '/pricing')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('page-scoped click → page lifted for routing', r.tags[0]?.page === '/pricing', JSON.stringify(r.tags[0]?.page));
  check('page-scoped click still drivable by Click Text', r.tags[0]?.trigger.clickTextValue === 'Buy');
}

// ── click trigger scoped ONLY by page (no Click Text/URL) → skipped (no locatable target) ─────────
{
  const s = snap(
    [tag({ tagId: 'po', name: 'Any Click on Pricing', type: 'gaawe', firingTriggerId: ['tpo'], parameter: ga4EventParams('G-1', 'x') })],
    [trig({ triggerId: 'tpo', type: 'linkClick', filter: [cond('{{Page Path}}', 'equals', '/pricing')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('page-only click → skipped', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'po'));
}

// ── click trigger scoped by {{Click ID}} only → skipped (driver matches text/url, not id) ─────────
{
  const s = snap(
    [tag({ tagId: 'ci', name: 'Click ID Tag', type: 'gaawe', firingTriggerId: ['tci'], parameter: ga4EventParams('G-1', 'x') })],
    [trig({ triggerId: 'tci', type: 'linkClick', filter: [cond('{{Click ID}}', 'equals', 'signup-btn')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('click-id-only → skipped', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'ci'));
}

// ── multi firing triggers: a non-drivable trigger BEFORE a built-in id resolves to pageview ───────
{
  const base = { tagId: 'm1', name: 'Base', type: 'gaawe', parameter: ga4EventParams('G-1', 'page_view') } as const;
  const scroll = trig({ triggerId: 'ts', type: 'scrollDepth' });
  const fwd = snapshotToVerifyInputs(snap([tag({ ...base, firingTriggerId: ['ts', '2147479553'] })], [scroll]));
  const rev = snapshotToVerifyInputs(snap([tag({ ...base, firingTriggerId: ['2147479553', 'ts'] })], [scroll]));
  check('multi-trigger [scroll, builtin] → pageview', fwd.tags.length === 1 && fwd.tags[0]?.trigger.kind === 'pageview');
  check('multi-trigger [builtin, scroll] → pageview', rev.tags.length === 1 && rev.tags[0]?.trigger.kind === 'pageview');
}

// ── custom-event trigger with no concrete event name → skipped ────────────────────────────────────
{
  const s = snap(
    [tag({ tagId: 'ce', name: 'Bad Custom', type: 'gaawe', firingTriggerId: ['tce'], parameter: ga4EventParams('G-1', 'x') })],
    [trig({ triggerId: 'tce', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'matchRegex', '.*')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom-event without a concrete name → skipped', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'ce'));
}

// ── skips: paused, unsupported type, unmappable trigger — all three, none survive ─────────────────
{
  const s = snap(
    [
      tag({ tagId: 'sp', name: 'Paused', type: 'gaawe', firingTriggerId: ['t1'], paused: true }),
      tag({ tagId: 'sa', name: 'Ads Conv', type: 'awct', firingTriggerId: ['t1'] }),
      tag({ tagId: 'ss', name: 'Scroll Tag', type: 'gaawe', firingTriggerId: ['ts'] }),
    ],
    [trig({ triggerId: 't1', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Go')] }), trig({ triggerId: 'ts', type: 'scrollDepth' })],
  );
  const r = snapshotToVerifyInputs(s);
  check('paused tag skipped', r.skipped.some((x) => x.tagId === 'sp' && /paused/.test(x.reason)));
  check('unsupported tag type skipped', r.skipped.some((x) => x.tagId === 'sa' && /not verifiable/.test(x.reason)));
  check('unmappable trigger (scrollDepth) skipped', r.skipped.some((x) => x.tagId === 'ss'));
  check('all three tags skipped, none survive', r.tags.length === 0 && r.skipped.length === 3, `tags=${r.tags.length} skipped=${r.skipped.length}`);
}

console.log(`\ncontainer-verify: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 22) { console.error(`expected >= 22 checks, got ${passed}`); process.exit(1); }
