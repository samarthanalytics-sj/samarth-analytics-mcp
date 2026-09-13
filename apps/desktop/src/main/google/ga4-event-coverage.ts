// Pure engine: RECOMMENDED-EVENT coverage for ecommerce properties ("funnel completeness"). GA4 defines
// a set of recommended online-sales event names that are NOT sent automatically; sending them under the
// standard names is what auto-populates GA4's ecommerce + checkout-journey reports and unlocks
// predictive/remarketing audiences. This flags which recommended events a property does NOT emit.
//
// Deliberately conservative and honest:
//  - It runs ONLY for properties already measuring ecommerce (a core anchor event is present), so a
//    content or lead-gen site is never told it "lacks add_to_cart".
//  - The finding is severity 'info' (an OPTIONAL opportunity), never a warning — recommended events are
//    not required and their absence is not data loss.
//  - Events are often implemented under CUSTOM names (transaction, product_view), so it says "not
//    detected under the standard name", never "not implemented".
//
// Presence (which recommended events actually have data) is resolved by an exact inListFilter query in
// data-service.getGa4PresentEvents; this engine only classifies that presence set into a finding.

import type { Ga4Finding } from './ga4-audit';

/** GA4's recommended online-sales / retail events, in purchase-journey order. Source of truth for both
 *  the presence query and the coverage classification. */
export const ECOMMERCE_RECOMMENDED_EVENTS = [
  'view_item_list',
  'select_item',
  'view_item',
  'add_to_cart',
  'view_cart',
  'remove_from_cart',
  'add_to_wishlist',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'purchase',
  'refund',
  'view_promotion',
  'select_promotion',
];

// The measurement backbone — the minimal purchase-funnel spine GA4 needs to render the checkout-journey
// and monetization reports. Absence of these on a confirmed ecommerce property is a genuine gap (the
// rest are enrichment).
const CORE_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase'];

// Observed-events gate: treat the property as ecommerce only if at least one of these is actually sent.
// Observed events beat the GA4 industry category (often unset/wrong) and key-event flags.
const ECOMMERCE_ANCHORS = ['purchase', 'add_to_cart', 'view_item'];

export interface Ga4EventCoverageInput {
  /** Which of ECOMMERCE_RECOMMENDED_EVENTS were found to have data (from the exact presence query). */
  presentRecommended: string[];
}

/** Zero or one 'info' finding — an aggregated coverage opportunity, only for ecommerce properties. */
export function auditGa4EventCoverage(input: Ga4EventCoverageInput): Ga4Finding[] {
  const present = new Set(input.presentRecommended.map((e) => e.trim()).filter(Boolean));
  if (!ECOMMERCE_ANCHORS.some((e) => present.has(e))) return [];
  const missing = ECOMMERCE_RECOMMENDED_EVENTS.filter((e) => !present.has(e));
  if (missing.length === 0) return [];
  const missingCore = missing.filter((e) => CORE_EVENTS.includes(e));
  const coreClause = missingCore.length
    ? ` This includes ${missingCore.length} of the core purchase-funnel steps (${missingCore.join(', ')}).`
    : '';
  return [
    {
      severity: 'info',
      category: 'conversions',
      message: `This property is measuring ecommerce, but ${missing.length} of GA4's recommended online-sales events were not detected under their standard names in this window: ${missing.join(', ')}.${coreClause}`,
      recommendation: `Recommended events are optional - GA4 works without them and their absence is not data loss. Sending them under the standard GA4 names (rather than custom ones like "transaction" or "product_view") is what auto-populates GA4's ecommerce and checkout-journey funnel reports and unlocks predictive/remarketing audiences. If you already fire these under custom names, no action is needed.`,
    },
  ];
}
