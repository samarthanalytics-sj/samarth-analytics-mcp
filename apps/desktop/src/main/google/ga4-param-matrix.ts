// Pure engine: EVENT-PARAMETER matrix for GA4's recommended events. An event that fires but carries
// none of the parameters GA4 expects produces EMPTY reports (a purchase with no value = zero revenue;
// view_item with no items[] = an empty ecommerce report; search with no search_term = a blank terms
// report) - the event "works" while the reporting built on it silently doesn't.
//
// Honest-by-design: the Data API cannot enumerate arbitrary event parameters, so every verdict here
// is grounded in a PREDEFINED signal the API does expose - the eventValue metric (the sum of the
// `value` parameter), the items* metrics (the items[] array), the searchTerm dimension - or, when no
// such signal exists (sign_up's `method`), the row is reported as NOT VERIFIABLE with the reason,
// never guessed. transaction_id coverage stays ga4-integrity's finding (dedup by design); it is only
// mentioned here when the parameter is missing WHOLESALE (never sent at all).

import type { Ga4Finding } from './ga4-audit';

/** Predefined-signal readings the data layer fetched (ga4-audit-ipc → data-service). */
export interface Ga4ParamSignals {
  /** Per-event count + summed `value` parameter (the eventValue metric). */
  events: Array<{ name: string; count: number; value: number }>;
  /** "(not set)" share (0-100) of the searchTerm dimension; null = search never fired / not fetched. */
  searchTermNotSetPct: number | null;
  /** Totals of the items* metrics; null = not fetched (no ecommerce events fired). */
  items: { viewed: number; addedToCart: number; checkedOut: number; purchased: number } | null;
  /** "(not set)" transaction_id share (0-100) from the transactions pass; null = not run. */
  txnNotSetShare: number | null;
  /** Registered event-scoped custom-dimension parameter names (for the not-verifiable rows). */
  registeredParams: string[];
}

interface Row {
  event: string;
  param: string;
  detail: string;
}

const n = (x: number): string => x.toLocaleString('en-US');

export function auditGa4ParamMatrix(input: Ga4ParamSignals): Ga4Finding[] {
  const out: Ga4Finding[] = [];
  const byName = new Map(input.events.map((e) => [e.name, e]));
  const fired = (name: string): number => byName.get(name)?.count ?? 0;
  const valueOf = (name: string): number => byName.get(name)?.value ?? 0;
  const registered = new Set(input.registeredParams.map((p) => p.trim()).filter(Boolean));

  const missing: Row[] = [];
  const recommendedGaps: Row[] = [];
  const notVerifiable: Row[] = [];

  // ── purchase: value (required), items[] (required), transaction_id (wholesale-missing only) ──
  const purchases = fired('purchase');
  if (purchases > 0) {
    if (valueOf('purchase') === 0) {
      missing.push({ event: 'purchase', param: 'value', detail: `${n(purchases)} purchases carried NO value - GA4 records zero revenue for them` });
    }
    if (input.items && input.items.purchased === 0) {
      missing.push({ event: 'purchase', param: 'items[]', detail: 'no items[] array - item/product reports stay empty and refunds cannot be itemised' });
    }
    if (input.txnNotSetShare != null && input.txnNotSetShare >= 99) {
      missing.push({ event: 'purchase', param: 'transaction_id', detail: 'never sent - purchases cannot be de-duplicated (partial gaps are flagged by the transaction-integrity check)' });
    }
  }

  // ── ecommerce funnel steps: items[] required for the reports each step feeds ──
  const funnelItems: Array<{ event: string; metric: keyof NonNullable<Ga4ParamSignals['items']>; report: string }> = [
    { event: 'view_item', metric: 'viewed', report: 'item views' },
    { event: 'add_to_cart', metric: 'addedToCart', report: 'cart analysis' },
    { event: 'begin_checkout', metric: 'checkedOut', report: 'checkout journey' },
  ];
  for (const step of funnelItems) {
    const c = fired(step.event);
    if (c > 0 && input.items && input.items[step.metric] === 0) {
      missing.push({ event: step.event, param: 'items[]', detail: `${n(c)} events but ZERO items recorded - the ${step.report} report stays empty` });
    }
  }

  // ── search: search_term ──
  if (fired('search') > 0 && input.searchTermNotSetPct != null && input.searchTermNotSetPct > 5) {
    recommendedGaps.push({
      event: 'search',
      param: 'search_term',
      detail: `${input.searchTermNotSetPct.toFixed(0)}% of search events carry no search_term - the site-search terms report is mostly "(not set)"`,
    });
  }

  // ── generate_lead: value (recommended - lead value powers ROAS on lead-gen properties) ──
  const leads = fired('generate_lead');
  if (leads > 0 && valueOf('generate_lead') === 0) {
    recommendedGaps.push({ event: 'generate_lead', param: 'value', detail: `${n(leads)} leads carry no value - lead-gen ROAS reads as zero return` });
  }

  // ── sign_up / login / select_content: parameters with NO predefined API signal → honest not-verifiable ──
  const unverifiable: Array<{ event: string; param: string }> = [
    { event: 'sign_up', param: 'method' },
    { event: 'login', param: 'method' },
    { event: 'select_content', param: 'content_type' },
  ];
  for (const u of unverifiable) {
    if (fired(u.event) > 0 && !registered.has(u.param)) {
      notVerifiable.push({
        event: u.event,
        param: u.param,
        detail: `the API exposes no predefined signal for "${u.param}" and it is not registered as a custom dimension - register it to make it reportable (and auditable)`,
      });
    }
  }

  if (missing.length) {
    const hard = missing.some((m) => m.event === 'purchase');
    out.push({
      severity: hard ? 'high' : 'medium',
      category: 'params',
      message: `Required event parameters missing: ${missing.map((m) => `${m.event} → ${m.param} (${m.detail})`).join('; ')}. These events fire, but the reports built on their parameters are empty - the event "works" while the reporting silently doesn't.`,
      recommendation: 'Attach the parameters where the event is sent (the GTM tag’s event parameters / ecommerce items array, or the dataLayer push). Verify one live event in DebugView afterwards - parameters are not retroactive.',
    });
  }
  if (recommendedGaps.length) {
    out.push({
      severity: 'low',
      category: 'params',
      message: `Recommended parameters missing: ${recommendedGaps.map((m) => `${m.event} → ${m.param} (${m.detail})`).join('; ')}.`,
      recommendation: 'Optional but high-value: populate these parameters at the source so the reports they feed stop reading as "(not set)"/zero.',
    });
  }
  if (notVerifiable.length) {
    out.push({
      severity: 'info',
      category: 'params',
      message: `Parameters that cannot be verified from the API: ${notVerifiable.map((m) => `${m.event} → ${m.param}`).join(', ')} - ${notVerifiable[0].detail.split(' - ')[0]}. Not flagged as missing: absence of a signal is not evidence of absence.`,
      recommendation: 'Register these parameters as event-scoped custom dimensions (Admin > Custom definitions); future audits can then verify their coverage, and reports can segment by them.',
    });
  }
  return out;
}
