// Pure tests for the cross-platform chat integrations (no Electron, no network).
// Run: tsx apps/desktop/src/shared/__tests__/chat-integrations.test.ts

import { INTEGRATION_OPTIONS, INTEGRATION_LABEL, INTEGRATION_HINT, sanitizeIntegrations, buildIntegrationPrompt } from '../chat-integrations';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── the option matrix (the product decision, pinned) ──
{
  check('GTM chat offers GA4 and Google Ads', INTEGRATION_OPTIONS.gtm.includes('ga4') && INTEGRATION_OPTIONS.gtm.includes('ads') && INTEGRATION_OPTIONS.gtm.length === 2);
  check('GA4 chat offers ONLY GTM', INTEGRATION_OPTIONS.ga4.length === 1 && INTEGRATION_OPTIONS.ga4[0] === 'gtm');
  check('Ads chat offers ONLY GTM', INTEGRATION_OPTIONS.ads.length === 1 && INTEGRATION_OPTIONS.ads[0] === 'gtm');
  check('no chat offers itself as an integration', (['gtm', 'ga4', 'ads'] as const).every((p) => !INTEGRATION_OPTIONS[p].includes(p)));
  check('GA4 and Ads are never offered to each other', !INTEGRATION_OPTIONS.ga4.includes('ads') && !INTEGRATION_OPTIONS.ads.includes('ga4'));
  check('every offered option has a label and a hint', (['gtm', 'ga4', 'ads'] as const).every((p) => INTEGRATION_OPTIONS[p].every((o) => Boolean(INTEGRATION_LABEL[o]) && Boolean(INTEGRATION_HINT[p][o]))));
  check('no em dashes in any user-visible label or hint', (['gtm', 'ga4', 'ads'] as const).every((p) => INTEGRATION_OPTIONS[p].every((o) => !/[—–]/.test(INTEGRATION_HINT[p][o]))));
}

// ── sanitize: this is an IPC boundary, so nothing off-matrix may survive ──
{
  check('keeps what the product may connect', JSON.stringify(sanitizeIntegrations('gtm', ['ads'])) === JSON.stringify(['ads']));
  check('drops a platform this product does NOT offer (ga4 chat cannot connect ads)', sanitizeIntegrations('ga4', ['ads', 'gtm']).join() === 'gtm');
  check('drops the product itself', sanitizeIntegrations('gtm', ['gtm']).length === 0);
  check('drops junk and dedupes, in canonical option order', JSON.stringify(sanitizeIntegrations('gtm', ['ads', 'nope', 'ads', 'ga4'])) === JSON.stringify(['ga4', 'ads']));
  check('a non-array degrades to nothing connected, never to a throw', sanitizeIntegrations('gtm', 'ads').length === 0 && sanitizeIntegrations('gtm', undefined).length === 0 && sanitizeIntegrations('gtm', null).length === 0);
}

// ── the prompt block: silent when off (prompt-cache), specific when on ──
{
  check('nothing connected -> EMPTY string, so the single-product prompt is byte-identical', buildIntegrationPrompt('gtm', [], true) === '');
  check('an off-matrix request alone -> still empty (sanitized inside)', buildIntegrationPrompt('ga4', ['ads'], true) === '');

  const gtmAds = buildIntegrationPrompt('gtm', ['ads'], true);
  check('GTM+Ads: reuse-first, then the create, then the tag from LITERAL id + label', /list_google_ads_conversion_actions/.test(gtmAds) && /REUSE/.test(gtmAds) && /create_google_ads_conversion_action/.test(gtmAds) && /conversionLabel/.test(gtmAds) && /LITERAL/.test(gtmAds));
  check('GTM+Ads: names the Conversion Linker check', /gclidw/.test(gtmAds));
  check('GTM+Ads: says the Ads write is LIVE, not a draft', /LIVE/.test(gtmAds));
  check('GTM+Ads: no GA4 instructions leak in', !/Measurement ID/.test(gtmAds));

  const gtmAdsRead = buildIntegrationPrompt('gtm', ['ads'], false);
  check('GTM+Ads read-only: never promises the create it does not have', !/create_google_ads_conversion_action/.test(gtmAdsRead) && /list_google_ads_conversion_actions/.test(gtmAdsRead));

  const gtmGa4 = buildIntegrationPrompt('gtm', ['ga4'], true);
  check('GTM+GA4: resolves the Measurement ID from the SELECTED property via data streams', /list_ga4_data_streams/.test(gtmGa4) && /measurementId/.test(gtmGa4) && /SELECTED GA4 property/.test(gtmGa4));
  check('GTM+GA4: forbids inventing or assuming a Measurement ID', /Never invent a Measurement ID/.test(gtmGa4) && /never assume an id already in the container/.test(gtmGa4));
  check('GTM+GA4: builds the tag with platform ga4_event', /create_gtm_tracking_tag platform ga4_event/.test(gtmGa4));
  check('GTM+GA4 with writes: offers the key event as a LIVE GA4 change', /create_ga4_key_event/.test(gtmGa4) && /LIVE GA4 Admin change/.test(gtmGa4));
  check('GTM+GA4 read-only: routes the key event to the GA4 Admin UI instead of promising a tool', !/create_ga4_key_event/.test(buildIntegrationPrompt('gtm', ['ga4'], false)));

  const both = buildIntegrationPrompt('gtm', ['ga4', 'ads'], true);
  check('both connected: BOTH workflows present, and both platforms named up front', /list_ga4_data_streams/.test(both) && /list_google_ads_conversion_actions/.test(both) && /GA4, Google Ads/.test(both));

  const ga4Gtm = buildIntegrationPrompt('ga4', ['gtm'], true);
  check('GA4+GTM: builds the GA4 tag in the working container from THIS property', /working GTM container/.test(ga4Gtm) && /create_gtm_tracking_tag platform ga4_event/.test(ga4Gtm) && /THIS property/.test(ga4Gtm));
  check('GA4+GTM: never claims collection before publish + verify', /Never claim the event is collecting/.test(ga4Gtm));

  const adsGtm = buildIntegrationPrompt('ads', ['gtm'], true);
  check('Ads+GTM: the conversion tag is built HERE, from literal id + label', /create_gtm_tracking_tag platform google_ads_conversion/.test(adsGtm) && /LITERAL/.test(adsGtm) && !/\{\{/.test(adsGtm.split('never {{variables}}')[0]));
  check('Ads+GTM: a null label is reported, never fabricated', /null conversionLabel/.test(adsGtm) && /instead of fabricating/.test(adsGtm));
  check('Ads+GTM: states the live-vs-draft asymmetry', /Ads changes are LIVE/.test(adsGtm) && /DRAFT workspace/.test(adsGtm));

  check('every generated block relaxes the single-product rule explicitly', [gtmAds, gtmGa4, ga4Gtm, adsGtm].every((b) => /CROSS-PLATFORM INTEGRATIONS/.test(b) && /instead of telling the user to switch/.test(b)));
  check('no em dashes in any generated block (house style)', [gtmAds, gtmGa4, ga4Gtm, adsGtm, both, gtmAdsRead].every((b) => !/[—–]/.test(b)));
}

console.log(`\nchat-integrations: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 25) { console.error(`expected >= 25 checks, got ${passed}`); process.exit(1); }
