// Single source of truth for CTA intents. The SAME regex is used to (a) classify
// a button/link's text into an intent AND (b) build the GTM {{Click Text}} trigger
// that fires the tag — so detection and the deployed trigger can never disagree
// (no dead triggers, no over-firing). PURE — no browser, no GTM.
//
// The pattern is a regex SOURCE string (no flags). It is matched
// case-INSENSITIVELY and is word-bounded, so:
//   - the GTM trigger uses it as `(?i)<pattern>` via matchRegex (RE2 honours the
//     inline (?i) flag), firing regardless of the button's casing; and
//   - it never fires on a substring of a larger word ("demo" inside
//     "demonstration") because every alternative is \b-anchored.

import type { CtaIntent } from './types.js';

export interface CtaIntentDef {
  intent: CtaIntent;
  /** Regex SOURCE (no flags) — matched case-insensitively + word-bounded. */
  pattern: string;
  /** GA4 event name. */
  event: string;
  /** Human tag label, e.g. "Subscribe Click". */
  label: string;
}

// Ordered most-specific first; the first match wins. Bare "register" stays out of
// the generic bucket (only "register now/today") — but "log in"/"sign in" IS a
// tracked intent (login) now, so "Login / Register" classifies as login.
//
// Precision note: these are HEURISTIC suggestions a human reviews, and the GTM
// trigger uses the SAME pattern via RE2 matchRegex. RE2 has no lookahead, so the
// trigger cannot exclude a trailing noun without also dropping the canonical CTA.
// Known accepted residuals (text-matching can't disambiguate intent perfectly):
//   - "Subscribe to calendar/RSS/podcast" still reads as subscribe (newsletter
//     "Subscribe" is the dominant real case; narrowing would lose it).
//   - "Get started guide/videos" still reads as get_started (doc nav vs CTA).
//   - "Get a demo account" / "Request demo files" still read as book_demo.
// "view" was dropped from book_demo because "View demo reel/gallery/video" is
// product content, not a booking — and "View demo" is a rare button vs the cost.
export const CTA_INTENTS: CtaIntentDef[] = [
  { intent: 'add_to_cart', pattern: '\\badd\\s+to\\s+(cart|bag|basket)\\b', event: 'add_to_cart_click', label: 'Add to Cart Click' },
  { intent: 'book_demo', pattern: '\\b(book|request|schedule|get)\\s+(?:(?:a|an|your|the|free|quick|live|personalized|product)\\s+){0,2}demo\\b|\\bbook\\s+a\\s+(call|meeting|consultation)\\b', event: 'book_demo_click', label: 'Book Demo Click' },
  { intent: 'request_quote', pattern: '\\b(request|get)\\s+(?:(?:a|an|your|my|the|free|instant|fast|quick|custom|online)\\s+){0,2}quote\\b', event: 'request_quote_click', label: 'Request Quote Click' },
  { intent: 'contact_sales', pattern: '\\b(contact|talk\\s+to)\\s+sales\\b', event: 'contact_sales_click', label: 'Contact Sales Click' },
  { intent: 'subscribe', pattern: '\\bsubscribe\\b|\\bsign\\s*me\\s*up\\b', event: 'subscribe_click', label: 'Subscribe Click' },
  { intent: 'get_started', pattern: '\\b(get\\s+started|start\\s+(free|now|your\\s+(free\\s+)?trial)|free\\s+trial|try\\s+(it\\s+)?free|start\\s+for\\s+free)\\b', event: 'get_started_click', label: 'Get Started Click' },
  { intent: 'login', pattern: '\\b(log\\s*in|login|sign\\s*in)\\b', event: 'login_click', label: 'Login Click' },
  // event is 'search_click' (NOT bare 'search'): the search FORM's submit tag uses
  // the GA4 'search' event, and clicking a "Search" submit button raises BOTH
  // gtm.click and gtm.formSubmit — a shared event name would double-count.
  { intent: 'search', pattern: '\\bsearch\\b', event: 'search_click', label: 'Search' },
  { intent: 'view_more', pattern: '\\b(see|view|browse|explore|show)\\s+(all|more)\\b|\\bcase\\s+stud(y|ies)\\b|\\bview\\s+case\\b|\\bread\\s+more\\b', event: 'view_all_click', label: 'View All Click' },
  { intent: 'learn_more', pattern: '\\b(learn\\s+more|find\\s+out\\s+more|discover\\s+more)\\b', event: 'learn_more_click', label: 'Learn More Click' },
  { intent: 'faq', pattern: '\\b(faqs?|frequently\\s+asked\\s+questions?)\\b', event: 'faq_click', label: 'FAQ Click' },
  { intent: 'generic', pattern: '\\b(buy\\s+now|create\\s+(an\\s+)?account|sign\\s*up|join\\s+(now|today)|order\\s+now|shop\\s+now|donate|apply\\s+now|register\\s+(now|today))\\b', event: 'cta_click', label: 'CTA Click' },
];

const COMPILED = CTA_INTENTS.map((d) => ({ d, re: new RegExp(d.pattern, 'i') }));

export const CTA_BY_INTENT = Object.fromEntries(CTA_INTENTS.map((d) => [d.intent, d])) as Record<CtaIntent, CtaIntentDef>;

/** Map a button/link's text to a CTA intent (case-insensitive), or null. PURE. */
export function classifyCtaIntent(text: string): CtaIntent | null {
  for (const { d, re } of COMPILED) if (re.test(text)) return d.intent;
  return null;
}
