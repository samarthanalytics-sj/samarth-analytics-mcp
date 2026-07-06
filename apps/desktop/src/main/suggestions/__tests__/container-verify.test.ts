// Pure tests for the container-snapshot → verify-input mapper (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/container-verify.test.ts

import { snapshotToVerifyInputs } from '../container-verify';
import type { ContainerSnapshot, AuditTag, AuditTrigger } from '../../google/gtm-builders';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const cond = (variable: string, op: string, value: string): Record<string, unknown> => ({
  type: op,
  parameter: [
    { type: 'template', key: 'arg0', value: variable },
    { type: 'template', key: 'arg1', value },
  ],
});
const tag = (over: Partial<AuditTag>): AuditTag => ({
  tagId: '1', name: 'Tag', type: 'gaawe', firingTriggerId: [], paused: false, parameter: [], ...over,
});
const trig = (over: Partial<AuditTrigger>): AuditTrigger => ({ triggerId: 't1', name: 'Trig', type: 'linkClick', ...over });
const snap = (tags: AuditTag[], triggers: AuditTrigger[]): ContainerSnapshot => ({ tags, triggers, variables: [] });

// ── GA4 event tag + link-click trigger with a Click Text condition ──────────────
{
  const s = snap(
    [tag({ tagId: 'g1', name: 'CTA Tag', type: 'gaawe', firingTriggerId: ['t1'], parameter: [{ type: 'template', key: 'eventName', value: 'cta_click' }, { type: 'template', key: 'measurementId', value: 'G-1' }] })],
    [trig({ triggerId: 't1', type: 'linkClick', filter: [cond('{{Click Text}}', 'equals', 'Book a Call')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('gaawe → one verify input', r.tags.length === 1);
  check('event name + measurementId extracted', r.tags[0].eventName === 'cta_click' && r.tags[0].measurementId === 'G-1');
  check('link-click kind', r.tags[0].trigger.kind === 'link_click');
  check('click-text condition mapped', r.tags[0].trigger.clickTextValue === 'Book a Call' && r.tags[0].trigger.clickTextOperator === 'equals');
}

// ── googtag firing the built-in All Pages trigger → pageview ────────────────────
{
  const s = snap(
    [tag({ tagId: 'base', name: 'GA4 Configuration', type: 'googtag', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'tagId', value: 'G-1' }] })],
    [],
  );
  const r = snapshotToVerifyInputs(s);
  check('googtag → pageview', r.tags.length === 1 && r.tags[0].trigger.kind === 'pageview' && r.tags[0].eventName === 'page_view');
  check('googtag measurementId from tagId', r.tags[0].measurementId === 'G-1');
}

// ── form submission trigger scoped by Form ID ───────────────────────────────────
{
  const s = snap(
    [tag({ tagId: 'f1', name: 'Contact Form', type: 'gaawe', firingTriggerId: ['tf'], parameter: [{ type: 'template', key: 'eventName', value: 'generate_lead' }] })],
    [trig({ triggerId: 'tf', type: 'formSubmission', filter: [cond('{{Form ID}}', 'equals', 'contact-form')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('form_submit kind + Form ID', r.tags[0].trigger.kind === 'form_submit' && r.tags[0].trigger.formIdValue === 'contact-form');
}

// ── custom-event trigger → event name from customEventFilter ────────────────────
{
  const s = snap(
    [tag({ tagId: 'c1', name: 'Purchase', type: 'gaawe', firingTriggerId: ['tc'], parameter: [{ type: 'template', key: 'eventName', value: 'purchase' }] })],
    [trig({ triggerId: 'tc', type: 'customEvent', customEventFilter: [cond('{{_event}}', 'equals', 'purchase')] })],
  );
  const r = snapshotToVerifyInputs(s);
  check('custom_event kind + dataLayer event name', r.tags[0].trigger.kind === 'custom_event' && r.tags[0].trigger.eventName === 'purchase');
}

// ── skips: paused, unsupported type, unmappable trigger ─────────────────────────
{
  const s = snap(
    [
      tag({ tagId: 'p1', name: 'Paused', type: 'gaawe', firingTriggerId: ['t1'], paused: true }),
      tag({ tagId: 'a1', name: 'Ads Conv', type: 'awct', firingTriggerId: ['t1'] }),
      tag({ tagId: 's1', name: 'Scroll Tag', type: 'gaawe', firingTriggerId: ['ts'] }),
    ],
    [trig({ triggerId: 't1', type: 'linkClick' }), trig({ triggerId: 'ts', type: 'scrollDepth' })],
  );
  const r = snapshotToVerifyInputs(s);
  check('paused tag skipped', r.skipped.some((x) => x.tagId === 'p1' && /paused/.test(x.reason)));
  check('unsupported tag type skipped', r.skipped.some((x) => x.tagId === 'a1' && /not verifiable/.test(x.reason)));
  check('unmappable trigger (scrollDepth) skipped', r.skipped.some((x) => x.tagId === 's1'));
  check('only the link-click gaawe survives', r.tags.length === 0); // p1 paused, a1 unsupported, s1 scroll → none
}

console.log(`\ncontainer-verify: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
