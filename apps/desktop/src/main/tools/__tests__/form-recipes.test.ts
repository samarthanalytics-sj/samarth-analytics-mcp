// Pure tests for the AJAX form-plugin tracking recipe builder.
// Run: tsx apps/desktop/src/main/tools/__tests__/form-recipes.test.ts

import assert from 'node:assert/strict';
import { formTrackingRecipe, AJAX_FORM_PROVIDERS_LIST } from '../form-recipes';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}

console.log('\nform-recipes:');

test('unknown provider → null', () => {
  assert.equal(formTrackingRecipe('typeform'), null);
  assert.equal(formTrackingRecipe(''), null);
});

test('all AJAX providers produce a complete recipe', () => {
  for (const p of AJAX_FORM_PROVIDERS_LIST) {
    const r = formTrackingRecipe(p);
    assert.ok(r, `${p} recipe`);
    assert.equal(r!.provider, p);
    assert.equal(r!.listenerTag.platform, 'custom_html');
    assert.equal(r!.listenerTag.trigger.kind, 'pageview'); // All Pages
    assert.ok(/<script>/.test(r!.listenerTag.html) && /dataLayer\.push/.test(r!.listenerTag.html), `${p} listener pushes dataLayer`);
    assert.equal(r!.ga4Tag.platform, 'ga4_event');
    assert.equal(r!.ga4Tag.trigger.kind, 'custom_event');
    // The GA4 tag fires on the SAME event the listener pushes — the whole point.
    assert.equal(r!.ga4Tag.trigger.eventName, r!.dataLayerEvent);
    assert.ok(r!.listenerTag.html.includes(r!.dataLayerEvent), `${p} snippet pushes its own event`);
    assert.ok(r!.guide.length >= 3);
  }
});

test('CF7 uses the wpcf7mailsent DOM event + cf7submission, no jQuery', () => {
  const r = formTrackingRecipe('contactform7')!;
  assert.equal(r.dataLayerEvent, 'cf7submission');
  assert.equal(r.requiresJquery, false);
  assert.ok(r.listenerTag.html.includes("addEventListener('wpcf7mailsent'"));
});

test('Gravity/Ninja/WPForms/Elementor use jQuery hooks', () => {
  assert.ok(formTrackingRecipe('gravityforms')!.listenerTag.html.includes('gform_confirmation_loaded'));
  assert.ok(formTrackingRecipe('ninjaforms')!.listenerTag.html.includes('nfFormSubmitResponse'));
  assert.ok(formTrackingRecipe('wpforms')!.listenerTag.html.includes('wpformsAjaxSubmitSuccess'));
  assert.ok(formTrackingRecipe('elementor')!.listenerTag.html.includes('submit_success'));
  for (const p of ['gravityforms', 'ninjaforms', 'wpforms', 'elementor']) assert.equal(formTrackingRecipe(p)!.requiresJquery, true);
});

test('eventName + measurementId flow into the GA4 tag; default event is form_submission', () => {
  const d = formTrackingRecipe('contactform7')!;
  assert.equal(d.ga4Tag.eventName, 'form_submission');
  assert.equal(d.ga4Tag.measurementId, undefined);
  const r = formTrackingRecipe('contactform7', { eventName: 'generate_lead', measurementId: 'G-123' })!;
  assert.equal(r.ga4Tag.eventName, 'generate_lead');
  assert.equal(r.ga4Tag.measurementId, 'G-123');
  // The trigger event (what actually fires it) stays the plugin's dataLayer event, not the GA4 name.
  assert.equal(r.ga4Tag.trigger.eventName, 'cf7submission');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
