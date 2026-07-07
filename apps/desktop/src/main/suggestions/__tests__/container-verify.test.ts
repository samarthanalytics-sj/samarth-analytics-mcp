// Pure tests for the container-snapshot → verify-input mapper (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/container-verify.test.ts

import { snapshotToVerifyInputs } from '../container-verify';
import type { ContainerSnapshot, AuditTag, AuditTrigger, AuditVariable } from '../../google/gtm-builders';

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
const snapV = (tags: AuditTag[], triggers: AuditTrigger[], variables: AuditVariable[]): ContainerSnapshot => ({ tags, triggers, variables });
// A Data Layer Variable: display name → the dataLayer key it reads (in its `name` parameter).
const dlv = (name: string, key: string): AuditVariable => ({ variableId: name, name, type: 'v', parameter: [{ type: 'template', key: 'name', value: key }] });

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
      tag({ tagId: 'sa', name: 'Conversion Linker', type: 'gclidw', firingTriggerId: ['t1'] }),
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

// ── condition-aware custom_event push: resolve {{DLV}} conditions → dataLayer key/value pairs ─────
// Many tags share ONE form_submission event and split by {{form_name}}/{{form_id}}. Capture those so
// the synthetic push satisfies the RIGHT tag instead of leaving every form tag "inconclusive".
{
  const s = snapV(
    [tag({ tagId: 'gi', name: 'Get In Touch Form Tag', type: 'gaawe', firingTriggerId: ['tg'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'tg', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{DLV - form_name}}', 'equals', 'Get In Touch')] })],
    [dlv('DLV - form_name', 'form_name')],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event: DLV condition → customEventData key/value', r.tags[0]?.trigger.customEventData?.form_name === 'Get In Touch', JSON.stringify(r.tags[0]?.trigger.customEventData));
  check('custom_event: event name still form_submission', r.tags[0]?.trigger.eventName === 'form_submission');
}
{
  // Two DLV conditions on one event → both keys pushed. `contains`/`startsWith` push the literal value.
  const s = snapV(
    [tag({ tagId: 'm', name: 'Multi', type: 'gaawe', firingTriggerId: ['tm'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'tm', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{DLV - form_id}}', 'equals', 'gform_5'), cond('{{DLV - form_name}}', 'contains', 'Consult')] })],
    [dlv('DLV - form_id', 'form_id'), dlv('DLV - form_name', 'form_name')],
  );
  const r = snapshotToVerifyInputs(s);
  const d = r.tags[0]?.trigger.customEventData ?? {};
  check('custom_event: two DLV conditions → both keys', d.form_id === 'gform_5' && d.form_name === 'Consult', JSON.stringify(d));
}
{
  // An UNRESOLVABLE variable (no matching DLV in the container) is left out → no false data pushed.
  const s = snapV(
    [tag({ tagId: 'u', name: 'Unresolvable', type: 'gaawe', firingTriggerId: ['tu'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'tu', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{Some Custom JS}}', 'equals', 'x')] })],
    [], // no variables
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event: unresolvable variable → no customEventData', r.tags[0]?.trigger.customEventData === undefined);
}
{
  // matchRegex + negated conditions can't be synthesized → excluded.
  const s = snapV(
    [tag({ tagId: 'rx', name: 'Regex', type: 'gaawe', firingTriggerId: ['trx'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'trx', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{DLV - form_name}}', 'matchRegex', '.*'), cond('{{DLV - form_id}}', 'equals', 'x', true)] })],
    [dlv('DLV - form_name', 'form_name'), dlv('DLV - form_id', 'form_id')],
  );
  const r = snapshotToVerifyInputs(s);
  // The negated condition makes the WHOLE trigger un-drivable (existing behavior) → tag skipped.
  check('custom_event: negated condition → trigger skipped entirely', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'rx'));
}
{
  // A matchRegex-only extra condition (no negation) is dropped, but the event still drives (no data).
  const s = snapV(
    [tag({ tagId: 'rx2', name: 'RegexOnly', type: 'gaawe', firingTriggerId: ['trx2'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'trx2', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{DLV - form_name}}', 'matchRegex', 'contact.*')] })],
    [dlv('DLV - form_name', 'form_name')],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event: matchRegex extra condition → no customEventData, still drivable', r.tags.length === 1 && r.tags[0]?.trigger.customEventData === undefined);
}
{
  // A built-in {{Page Path}} condition on a custom_event is NOT pushed as data — it routes the page.
  const s = snapV(
    [tag({ tagId: 'pp', name: 'Page-scoped form', type: 'gaawe', firingTriggerId: ['tpp'], parameter: ga4EventParams('G-1', 'generate_lead') })],
    [trig({ triggerId: 'tpp', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'form_submission')], filter: [cond('{{Page Path}}', 'equals', '/contact'), cond('{{DLV - form_name}}', 'equals', 'Contact')] })],
    [dlv('DLV - form_name', 'form_name')],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event: Page Path routes the page, not pushed as data', r.tags[0]?.page === '/contact');
  check('custom_event: Page Path excluded from customEventData', r.tags[0]?.trigger.customEventData?.form_name === 'Contact' && !('page path' in (r.tags[0]?.trigger.customEventData ?? {})));
}

// ── Meta / custom-template pixel tags are now VERIFIABLE (by network beacon), not skipped ─────────
// The user's "Meta - Event - FAQs Click Tag" is a Custom Template (type cvt_5RM3Q); it used to be
// "not verifiable in this MVP". Now it maps to meta_pixel so the driver's beacon capture proves it.
{
  const s = snap(
    [tag({ tagId: 'meta1', name: 'Meta - Event - FAQs Click Tag', type: 'cvt_5RM3Q', firingTriggerId: ['tfaq'], parameter: [] })],
    [trig({ triggerId: 'tfaq', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'FAQs')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('cvt_ Meta tag → verifiable, not skipped', r.tags.length === 1 && r.skipped.length === 0);
  check('cvt_ Meta tag → meta_pixel platform', r.tags[0]?.platform === 'meta_pixel');
  check('cvt_ Meta tag → click trigger still mapped', r.tags[0]?.trigger.kind === 'link_click');
}
{
  // A custom template with NO pinpointable vendor in its name → SKIPPED (a generic beacon match would
  // risk crediting it for another pixel that fired on the same interaction). Honest over eager.
  const s = snap(
    [tag({ tagId: 'cv', name: 'Custom Conversion Tag', type: 'cvt_9XX', firingTriggerId: ['tc'], parameter: [] })],
    [trig({ triggerId: 'tc', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Buy')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('cvt_ with no vendor in name → skipped (no cross-attribution guess)', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'cv'));
}
{
  // Vendor-by-name across template + custom HTML + Google Ads conversion — all verifiable now.
  const mk = (id: string, name: string, type: string): AuditTag => tag({ tagId: id, name, type, firingTriggerId: ['tk'], parameter: [] });
  const s = snap(
    [mk('tt', 'TikTok Pixel - Lead', 'cvt_1'), mk('li', 'LinkedIn Insight Tag', 'html'), mk('aw', 'Google Ads - Purchase', 'awct')],
    [trig({ triggerId: 'tk', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Go')] })],
  );
  const r = snapshotToVerifyInputs(s);
  const by = (id: string): (typeof r.tags)[number] | undefined => r.tags.find((t) => t.id === id);
  check('cvt_ TikTok by name → tiktok_pixel', by('tt')?.platform === 'tiktok_pixel');
  check('Custom HTML LinkedIn by name → linkedin_insight', by('li')?.platform === 'linkedin_insight');
  check('awct → google_ads_conversion', by('aw')?.platform === 'google_ads_conversion');
  check('all three pixel/ad tags verifiable', r.tags.length === 3 && r.skipped.length === 0);
}
{
  // A type with no observable client beacon (Conversion Linker) stays SKIPPED — honest, not a false pass.
  const s = snap(
    [tag({ tagId: 'cl', name: 'Conversion Linker', type: 'gclidw', firingTriggerId: ['tcl'], parameter: [] })],
    [trig({ triggerId: 'tcl', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'X')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('non-beacon type (gclidw) → still skipped', r.tags.length === 0 && r.skipped.some((x) => x.tagId === 'cl'));
}

console.log(`\ncontainer-verify: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 39) { console.error(`expected >= 39 checks, got ${passed}`); process.exit(1); }
