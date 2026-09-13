// END-TO-END test for the form-provider recipe flow, across BOTH packages:
//   detect the provider (web-audit) → scanner recommends a trigger (web-audit suggest.ts) →
//   get_form_tracking_recipe builds the listener + GA4 tag (desktop form-recipes.ts).
// The load-bearing assertion is COHERENCE: the Custom Event the scanner tells the tag to fire on
// MUST equal the dataLayer event the recipe's listener pushes — those live in two separate files and
// would silently break form tracking if they drifted.
//
// Run: tsx apps/desktop/src/main/tools/__tests__/form-recipe-e2e.test.ts

import assert from 'node:assert/strict';
import { detectFormProvider } from '../../../../../web-audit-mcp/src/agent/tag-suggest/providers.js';
import { buildSuggestions } from '../../../../../web-audit-mcp/src/agent/tag-suggest/suggest.js';
import type { PageSignals, DetectedForm, FormProvider } from '../../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import { formTrackingRecipe, AJAX_FORM_PROVIDERS_LIST } from '../form-recipes';
import { buildToolRegistry } from '../registry';
import type { GoogleDataService } from '../../google/data-service';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// The DOM class that identifies each AJAX plugin (matches providers.ts detection).
const PROVIDER_CLASS: Record<string, string> = {
  contactform7: 'wpcf7',
  gravityforms: 'gform_wrapper',
  ninjaforms: 'nf-form-cont',
  wpforms: 'wpforms-form',
  elementor: 'elementor-form',
};

console.log('\nform-recipe (end-to-end, both packages):');

for (const provider of AJAX_FORM_PROVIDERS_LIST) {
  const cls = PROVIDER_CLASS[provider];
  const signals: PageSignals = { scriptSrcs: [], classNames: [cls], selectorsPresent: [], iframeSrcs: [] };

  // 1) detection
  const detected = detectFormProvider(signals, '/submit');
  check(`${provider}: detected from class .${cls}`, detected.vendor === (provider as FormProvider));

  // 2) scanner suggestion → a Custom Event trigger (NOT native form_submit)
  const form: DetectedForm = { page: '/contact', purpose: 'contact', action: '/submit', method: 'post', provider: detected, fields: [{ type: 'email', name: 'email', required: true }] };
  const sugg = buildSuggestions({ siteHost: 'example.com', forms: [form], elements: [] });
  const trig = sugg[0]?.trigger;
  check(`${provider}: scanner recommends a custom_event trigger`, sugg.length === 1 && trig?.kind === 'custom_event' && !trig?.formIdValue);

  // 3) recipe builds listener + GA4 tag
  const recipe = formTrackingRecipe(provider);
  check(`${provider}: recipe produced`, Boolean(recipe));
  if (!recipe) continue;

  // 4) COHERENCE — the two files must agree on the event name, or the tag never fires.
  check(
    `${provider}: scanner event === recipe event === GA4-trigger event === what the listener pushes`,
    trig?.eventName === recipe.dataLayerEvent &&
      recipe.ga4Tag.trigger.eventName === recipe.dataLayerEvent &&
      recipe.listenerTag.html.includes(`event: '${recipe.dataLayerEvent}'`),
    `scanner=${trig?.eventName} recipe=${recipe.dataLayerEvent} ga4=${recipe.ga4Tag.trigger.eventName}`,
  );

  // 5) the pieces are shaped for create_gtm_tracking_tag
  check(
    `${provider}: listener is Custom HTML on All Pages, GA4 tag on the Custom Event`,
    recipe.listenerTag.platform === 'custom_html' && recipe.listenerTag.trigger.kind === 'pageview' &&
      recipe.ga4Tag.platform === 'ga4_event' && recipe.ga4Tag.trigger.kind === 'custom_event',
  );
}

void (async () => {
  // 6) the get_form_tracking_recipe TOOL returns the recipe through the registry
  const reg = buildToolRegistry({} as unknown as GoogleDataService); // recipe handler is pure — never touches data
  const out = JSON.parse(await reg.execute('get_form_tracking_recipe', { provider: 'gravityforms', measurementId: 'G-1234567', eventName: 'generate_lead' }));
  check('tool: get_form_tracking_recipe returns listener + GA4 tag + guide', Boolean(out.listenerTag && out.ga4Tag && Array.isArray(out.guide) && out.guide.length >= 3));
  check('tool: measurementId + eventName flow into the GA4 tag', out.ga4Tag.measurementId === 'G-1234567' && out.ga4Tag.eventName === 'generate_lead');
  check('tool: GA4 tag fires on what the listener pushes', out.ga4Tag.trigger.eventName === out.dataLayerEvent && out.listenerTag.html.includes(out.dataLayerEvent));

  // 7) an unsupported provider is rejected with a clear error
  await assert.rejects(
    () => reg.execute('get_form_tracking_recipe', { provider: 'typeform' }),
    /No AJAX form recipe/,
  );
  check('tool: unsupported provider (typeform) rejected', true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  if (passed < 29) { console.error(`expected >= 29 checks, got ${passed}`); process.exit(1); }
})();
