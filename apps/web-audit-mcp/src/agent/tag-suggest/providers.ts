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
    vendor: 'mailchimp',
    test: (s, action) =>
      (/list-manage\.com/i.test(action) ? 'action list-manage.com' : null) ??
      (hasSel(s, '#mce-EMAIL') || hasSel(s, '#mc-embedded-subscribe') ? 'mailchimp id' : null),
  },
  { vendor: 'gravityforms', test: (s) => (hasClass(s, 'gform_wrapper') ? 'class .gform_wrapper' : null) },
  { vendor: 'contactform7', test: (s) => (hasClass(s, 'wpcf7') || hasClass(s, 'wpcf7-form') ? 'class .wpcf7' : null) },
  { vendor: 'wpforms', test: (s) => (hasClass(s, 'wpforms-form') || hasClass(s, 'wpforms-container') ? 'class .wpforms-form' : null) },
  { vendor: 'marketo', test: (s) => (s.selectorsPresent.some((x) => /^#mktoForm_\d/.test(x)) ? 'id #mktoForm_*' : null) },
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
