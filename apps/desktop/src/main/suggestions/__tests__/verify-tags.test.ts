// Pure tests for the "Verify tag firing" evaluator (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-tags.test.ts

import { evaluateVerify, type PerTagCapture } from '../verify-tags';
import type { VerifyTagInput, CapturedHitView, DetectedElementView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ga4Hit = (en: string): CapturedHitView => ({ url: `https://www.google-analytics.com/g/collect?v=2&tid=G-1&en=${en}`, body: null, collector: 'ga4' });
const metaHit = (): CapturedHitView => ({ url: 'https://www.facebook.com/tr?id=1&ev=Lead', body: null, collector: 'meta' });

const tag = (over: Partial<VerifyTagInput> = {}): VerifyTagInput => ({
  id: 't1', tagName: 'CTA Tag', eventName: 'cta_click', platform: 'ga4_event',
  trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'Get a Free Audit', clickTextOperator: 'equals' },
  ...over,
});
const cap = (over: Partial<PerTagCapture> = {}): PerTagCapture => ({
  tagId: 't1', kind: 'click', targetFound: true, performed: true, hits: [], ...over,
});
const els: DetectedElementView[] = [{ page: '/', kind: 'cta', text: 'Get a Free Audit' }];

// ── fired: GA4 event matches ───────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [ga4Hit('cta_click')] })], els);
  check('GA4 fired → fired true', v[0].fired === true && v[0].event === 'cta_click');
  check('GA4 fired carries evidence', Boolean(v[0].evidence));
}

// ── not fired: no hit at all ─────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [] })], els);
  check('GA4 no-hit → fired false', v[0].fired === false);
  check('GA4 no-hit → reason present', typeof v[0].reason === 'string' && v[0].reason!.length > 0);
}

// ── wrong event fired ────────────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [cap({ hits: [ga4Hit('page_view')] })], els);
  check('wrong-event → fired false', v[0].fired === false);
  check('wrong-event → reason names the seen event', /page_view/.test(v[0].reason ?? ''));
}

// ── target not found → repair proposed ──────────────────────────────────────────
{
  const t = tag({ trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'Free Audit', clickTextOperator: 'equals' } });
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], els);
  check('no-match → fired false', v[0].fired === false);
  check('no-match → suggestedTrigger proposed', Boolean(v[0].suggestedTrigger));
  check('no-match → repaired to real control text', v[0].suggestedTrigger?.clickTextValue === 'Get a Free Audit');
  check('no-match → fixNote present', typeof v[0].fixNote === 'string' && v[0].fixNote!.length > 0);
}

// ── target not found, no candidate → loosen operator ────────────────────────────
{
  const t = tag({ trigger: { name: 'X', kind: 'link_click', clickTextValue: 'Nonexistent CTA', clickTextOperator: 'equals' } });
  const v = evaluateVerify([t], [cap({ targetFound: false, performed: false, hits: [] })], [{ page: '/', kind: 'cta', text: 'Buy now' }]);
  check('no-candidate → loosen to contains (or note only)', v[0].suggestedTrigger?.clickTextOperator === 'contains' || v[0].suggestedTrigger === undefined);
  check('no-candidate → fixNote present', Boolean(v[0].fixNote));
}

// ── non-GA4 (meta) fired via collector ──────────────────────────────────────────
{
  const t = tag({ id: 'm1', platform: 'meta_pixel', eventName: 'Lead' });
  const v = evaluateVerify([t], [cap({ tagId: 'm1', hits: [metaHit()] })], els);
  check('meta hit → fired true', v[0].fired === true);
}

// ── not exercised ────────────────────────────────────────────────────────────────
{
  const v = evaluateVerify([tag()], [], els);
  check('no capture → fired false + interaction none', v[0].fired === false && v[0].interaction?.kind === 'none');
}

console.log(`\nverify-tags: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
