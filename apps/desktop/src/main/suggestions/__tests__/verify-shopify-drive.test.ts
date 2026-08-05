// Pure tests for the Shopify search / filter tag detection (no browser). These decide whether a tag is
// routed to the dedicated in-page search/facet drivers before the generic click-drive.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-shopify-drive.test.ts

import { isShopifySearchTag, isShopifyFilterTag } from '../verify-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}`); }
}

// SEARCH detection — by tag name, trigger name, event, click text, or the {{Click Element}} selector.
check('search: tag name', isShopifySearchTag('GA4 - Event - Search Click Tag', {}) === true);
check('search: trigger name', isShopifySearchTag(undefined, { name: 'Search Click Trigger' }) === true);
check('search: event name', isShopifySearchTag(undefined, { eventName: 'search_submit' }) === true);
check('search: click element selector', isShopifySearchTag(undefined, { clickElementValue: '.header__search-toggle' }) === true);
check('search: negative (a plain CTA)', isShopifySearchTag('GA4 - Event - Add to Cart Tag', { clickTextValue: 'Add to cart' }) === false);
check('search: negative (research is not a word-boundary search)', isShopifySearchTag('GA4 - Event - Research Guide Click', {}) === false);

// FILTER detection — filter / facet, across name + trigger + form scopes.
check('filter: tag name (Filter Form)', isShopifyFilterTag('GA4 - Event - Filter Form Tag', {}) === true);
check('filter: tag name (Active Filters)', isShopifyFilterTag('GA4 - Event - Active Filters Form Tag', {}) === true);
check('filter: facet form id', isShopifyFilterTag(undefined, { formIdValue: 'FacetFiltersForm' }) === true);
check('filter: event name', isShopifyFilterTag(undefined, { eventName: 'filter_applied' }) === true);
check('filter: negative (a plain form)', isShopifyFilterTag('GA4 - Event - Contact Form Tag', { formIdValue: 'contact' }) === false);

console.log(`\nverify-shopify-drive: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 11) { console.error(`expected >= 11 checks, got ${passed}`); process.exit(1); }
