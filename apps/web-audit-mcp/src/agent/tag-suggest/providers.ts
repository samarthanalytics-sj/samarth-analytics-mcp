// Form-provider detection from normalized page signals (pure + unit-tested).
// Signatures are stable DOM/script markers; emit confidence + evidence and never
// act on a guess. Works on signals produced by Playwright OR a Cheerio static
// parse, so a custom-HTML form parsed without a browser detects the same way.

import type { PageSignals, ProviderMatch, FormProvider } from './types.js';

const some = (arr: string[], re: RegExp): string | null => arr.find((x) => re.test(x)) ?? null;
const hasClass = (s: PageSignals, c: string): boolean => s.classNames.includes(c);
const hasSel = (s: PageSignals, sel: string): boolean => s.selectorsPresent.includes(sel);

interface Signature {
  vendor: FormProvider;
  /** Returns evidence text on a match, else null. `action` is the form action. */
  test: (s: PageSignals, action: string) => string | null;
}

const SIGNATURES: Signature[] = [
  {
    vendor: 'hubspot',
    test: (s) =>
      some(s.scriptSrcs, /js\.hsforms\.net|js\.hs-scripts\.com|js\.hs-analytics\.net/i) ??
      (hasClass(s, 'hs-form') || hasSel(s, '.hs-form') ? 'class .hs-form' : null),
  },
  {
    vendor: 'typeform',
    test: (s, action) =>
      (hasSel(s, '[data-tf-widget]') ? '[data-tf-widget]' : null) ??
      some(s.scriptSrcs, /embed\.typeform\.com/i) ??
      (/typeform\.com/i.test(action) ? 'action typeform.com' : null),
  },
  {
    vendor: 'paperform',
    test: (s, action) =>
      some(s.scriptSrcs, /paperform\.co/i) ??
      (hasClass(s, 'paperform') || hasSel(s, '[data-paperform-id]') ? 'paperform embed' : null) ??
      (/paperform\.co/i.test(action) ? 'action paperform.co' : null),
  },
  {
    vendor: 'mailchimp',
    test: (s, action) =>
      (/list-manage\.com/i.test(action) ? 'action list-manage.com' : null) ??
      (hasSel(s, '#mce-EMAIL') || hasSel(s, '#mc-embedded-subscribe') ? 'mailchimp id' : null),
  },
  { vendor: 'gravityforms', test: (s) => (hasClass(s, 'gform_wrapper') ? 'class .gform_wrapper' : null) },
  { vendor: 'contactform7', test: (s) => (hasClass(s, 'wpcf7') || hasClass(s, 'wpcf7-form') ? 'class .wpcf7' : null) },
  { vendor: 'wpforms', test: (s) => (hasClass(s, 'wpforms-form') || hasClass(s, 'wpforms-container') ? 'class .wpforms-form' : null) },
  { vendor: 'ninjaforms', test: (s) => (hasClass(s, 'nf-form-cont') || hasClass(s, 'nf-form-layout') ? 'class .nf-form-cont' : null) },
  { vendor: 'elementor', test: (s) => (hasClass(s, 'elementor-form') ? 'class .elementor-form' : null) },
  {
    vendor: 'marketo',
    // A Marketo form rendered without the #mktoForm_<n> id still carries class .mktoForm; the forms2
    // loader script (app-*.marketo.com/js/forms2/…) is a further page-level marker.
    test: (s) =>
      (s.selectorsPresent.some((x) => /^#mktoForm_\d/.test(x)) ? 'id #mktoForm_*' : null) ??
      (hasClass(s, 'mktoForm') ? 'class .mktoForm' : null) ??
      // The forms2 LOADER only — munchkin.js is the analytics tracker, loaded site-wide without any
      // form, and must not flip unrelated forms to provider=marketo.
      some(s.scriptSrcs, /\.marketo\.(com|net)\/js\/forms2\//i),
  },
  {
    vendor: 'pardot',
    test: (s, action) =>
      some(s.scriptSrcs, /pi\.pardot\.com|go\.pardot\.com/i) ??
      (/pardot\.com/i.test(action) ? 'action pardot.com' : null), // form-handler endpoints
  },
];

export function detectFormProvider(signals: PageSignals, action = ''): ProviderMatch {
  for (const sig of SIGNATURES) {
    const evidence = sig.test(signals, action);
    if (evidence) return { vendor: sig.vendor, confidence: 'high', evidence };
  }
  return { vendor: 'unknown', confidence: 'low', evidence: 'no known provider signature' };
}

// FORM-SPECIFIC embed markers — used to recognize a CROSS-ORIGIN embedded form
// (whose fields we can't read) so it still gets a suggestion. Deliberately
// STRICTER than detectFormProvider: only the providers' form scripts/classes/
// selectors + form iframe srcs — NOT generic tracking (e.g. hs-scripts.com),
// so we never synthesize a form that isn't there.
const FORM_EMBED: Signature[] = [
  {
    vendor: 'hubspot',
    test: (s) =>
      some(s.scriptSrcs, /js\.hsforms\.net/i) ??
      (hasClass(s, 'hs-form') || hasSel(s, '.hs-form') ? 'class .hs-form' : null) ??
      some(s.iframeSrcs ?? [], /hsforms\.(com|net)|forms\.hubspot|share\.hsforms/i),
  },
  {
    vendor: 'typeform',
    test: (s) =>
      (hasSel(s, '[data-tf-widget]') ? '[data-tf-widget]' : null) ??
      some(s.scriptSrcs, /embed\.typeform\.com/i) ??
      some(s.iframeSrcs ?? [], /\.typeform\.com\/(to|embed|widget)/i),
  },
  {
    vendor: 'paperform',
    test: (s) =>
      some(s.scriptSrcs, /paperform\.co/i) ??
      (hasClass(s, 'paperform') || hasSel(s, '[data-paperform-id]') ? 'paperform embed' : null) ??
      some(s.iframeSrcs ?? [], /paperform\.co/i),
  },
  // class .mktoForm means a rendered Marketo form ELEMENT exists (not just the tracking script), so it
  // is a safe embed marker; a bare marketo script src is NOT (munchkin.js loads without a form).
  { vendor: 'marketo', test: (s) => (s.selectorsPresent.some((x) => /^#mktoForm_\d/.test(x)) ? 'id #mktoForm_*' : null) ?? (hasClass(s, 'mktoForm') ? 'class .mktoForm' : null) },
  { vendor: 'mailchimp', test: (s, a) => (/list-manage\.com/i.test(a) ? 'action list-manage.com' : null) ?? (hasSel(s, '#mce-EMAIL') || hasSel(s, '#mc-embedded-subscribe') ? 'mailchimp id' : null) },
  { vendor: 'gravityforms', test: (s) => (hasClass(s, 'gform_wrapper') ? 'class .gform_wrapper' : null) },
  { vendor: 'contactform7', test: (s) => (hasClass(s, 'wpcf7') || hasClass(s, 'wpcf7-form') ? 'class .wpcf7' : null) },
  { vendor: 'wpforms', test: (s) => (hasClass(s, 'wpforms-form') || hasClass(s, 'wpforms-container') ? 'class .wpforms-form' : null) },
  { vendor: 'pardot', test: (s) => some(s.iframeSrcs ?? [], /pardot\.com/i) ?? some(s.scriptSrcs, /pi\.pardot\.com/i) },
  // Cross-origin form/scheduling embeds whose fields can't be read but are clearly a conversion.
  {
    vendor: 'calendly',
    test: (s) =>
      some(s.iframeSrcs ?? [], /calendly\.com/i) ??
      some(s.scriptSrcs, /assets\.calendly\.com/i) ??
      (hasClass(s, 'calendly-inline-widget') || hasSel(s, '.calendly-inline-widget') || hasSel(s, '[data-url*="calendly.com"]') ? 'calendly widget' : null),
  },
  {
    vendor: 'jotform',
    test: (s) => some(s.iframeSrcs ?? [], /(form|submit)\.jotform\.com|jotfor\.ms/i) ?? some(s.scriptSrcs, /cdn\.jotfor\.ms|js\.jotform\.com/i),
  },
  // iframe-only: a bare scriptSrcs match would synth a phantom form when the SDK loads without a form
  // (Formstack Documents/Sign, a stray wufoo.com script), violating "never synthesize a form that isn't there".
  { vendor: 'formstack', test: (s) => some(s.iframeSrcs ?? [], /formstack\.(com|io)/i) },
  { vendor: 'tally', test: (s) => some(s.iframeSrcs ?? [], /tally\.so/i) ?? (hasSel(s, '[data-tally-src]') ? 'data-tally-src' : null) },
  { vendor: 'googleforms', test: (s) => some(s.iframeSrcs ?? [], /docs\.google\.com\/forms/i) },
  { vendor: 'wufoo', test: (s) => some(s.iframeSrcs ?? [], /wufoo\.com/i) },
];

/** A provider whose form is EMBEDDED on the page (often cross-origin), or null.
 *  Used to synthesize a suggestion when the form's own fields are unreadable. */
export function detectEmbeddedForm(signals: PageSignals): ProviderMatch | null {
  for (const sig of FORM_EMBED) {
    const evidence = sig.test(signals, '');
    if (evidence) return { vendor: sig.vendor, confidence: 'medium', evidence: `${evidence} (embedded form)` };
  }
  return null;
}
