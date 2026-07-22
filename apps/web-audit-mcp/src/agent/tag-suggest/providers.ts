// Form-provider detection from normalized page signals (pure + unit-tested).
// Signatures are stable DOM/script markers; emit confidence + evidence and never
// act on a guess. Works on signals produced by Playwright OR a Cheerio static
// parse, so a custom-HTML form parsed without a browser detects the same way.
//
// EVERY vendor is matched by SEVERAL INDEPENDENT signals (script src, wrapper class,
// data attribute, element-id shape, form action host). A vendor that only had one
// signal went blind the moment it shipped new markup: that is exactly how a HubSpot
// form rendered with the newer hsfc markup (no js.hsforms.net embed script tag in the
// server HTML, no .hs-form class) was read as an ordinary native form, and given a
// native Form Submission trigger that can never fire because the submit happens inside
// a cross-origin iframe.
//
// The signals are PAGE-level and the verdict is applied to every form on the page, so a marker
// only qualifies if it means "a form BY THIS VENDOR is on this page". A marker that merely means
// "this vendor's code is loaded somewhere on this site" is banned for any vendor whose verdict
// changes the trigger MECHANISM (the embed and AJAX-plugin lists in suggest.ts): every Elementor
// page loads /elementor/assets/, every page of a site with Contact Form 7 installed loads
// /contact-form-7/, and classifying an unrelated hand-written <form> by that flips it from a
// working native Form Submission trigger to a Custom Event whose listener that form never fires.
// That is the same silent-dead-tag failure in the opposite direction, so the wrapper class / id /
// data-attribute markers (which only exist where the form is) carry those vendors instead.

import type { PageSignals, ProviderMatch, FormProvider } from './types.js';

const some = (arr: string[], re: RegExp): string | null => arr.find((x) => re.test(x)) ?? null;
const hasClass = (s: PageSignals, c: string): boolean => s.classNames.includes(c);
const hasSel = (s: PageSignals, sel: string): boolean => s.selectorsPresent.includes(sel);
/** Any of several exact class tokens present, as "class .<token>" evidence. */
const anyClass = (s: PageSignals, ...tokens: string[]): string | null => {
  const hit = tokens.find((t) => hasClass(s, t));
  return hit ? `class .${hit}` : null;
};
/** A class token matching a SHAPE (klaviyo-form-<id>, _form_<n>, hsfc-*). */
const classLike = (s: PageSignals, re: RegExp): string | null => {
  const hit = s.classNames.find((c) => re.test(c));
  return hit ? `class .${hit}` : null;
};
/** Any of several PROBED selectors present (collect.ts records the ones it found). */
const anySel = (s: PageSignals, ...sels: string[]): string | null => sels.find((x) => hasSel(s, x)) ?? null;
/** A probed element id matching a SHAPE. The collectors record "#<id>" for every id whose prefix is
 *  in PROVIDER_ID_PREFIXES, so a vendor that names its form element is recognised by that alone. */
const idLike = (s: PageSignals, re: RegExp): string | null => {
  const hit = s.selectorsPresent.find((x) => x.startsWith('#') && re.test(x));
  return hit ? `id ${hit}` : null;
};
/** The form's own action host, the strongest single signal when a vendor posts to its own endpoint. */
const actionLike = (action: string, re: RegExp, label: string): string | null =>
  action && re.test(action) ? `action ${label}` : null;

/**
 * ATTRIBUTE-shaped markers the page collectors probe for. A bare class-token list (PageSignals.
 * classNames) already covers class markers, so this list only carries what a class token cannot
 * express: data attributes and element ids.
 *
 * MUST stay in sync with the copy inlined inside collectPageInBrowser, which is stringified into
 * the scanned page and therefore may not reference this module. collect.node.test.ts asserts the
 * inlined copy matches this list exactly.
 */
export const PROVIDER_SELECTORS: readonly string[] = [
  // HubSpot: the classic embed wrapper, plus the newer hsfc renderer markup.
  '.hs-form', '.hs-form-html', '.hbspt-form', '[data-hsfc-id]',
  // Typeform: the legacy widget attribute and the current data-tf-live embed.
  '[data-tf-widget]', '[data-tf-live]', '[data-tf-popup]',
  '[data-paperform-id]',
  // Mailchimp embedded signup.
  '#mce-EMAIL', '#mc-embedded-subscribe', '#mc_embed_signup',
  // WordPress plugins.
  '.gform_wrapper', '.wpcf7', '.wpforms-form', '.wpforms-container', '.nf-form-cont', '.elementor-form',
  // Marketo / Pardot.
  '.mktoForm', '.pardotForm',
  // Hosted form builders.
  '.fsForm', '.jotform-form', '[class^="klaviyo-form"]',
  // Page builders whose own form markup is the only marker.
  '.lp-pom-form', '.w-form', '[data-wf-page]',
];

/**
 * Element-id PREFIXES whose real id the collectors record as "#<id>". Two jobs: the id SHAPE
 * identifies the vendor, and the id itself carries the vendor's durable form number (gform_12,
 * mktoForm_521, wpcf7-f34-p9-o1), which provider-form-id.ts turns into a trigger scope.
 *
 * Same sync rule as PROVIDER_SELECTORS: collectPageInBrowser inlines a copy.
 */
export const PROVIDER_ID_PREFIXES: readonly string[] = [
  'mktoForm_', 'hsForm_', 'gform_', 'wpcf7-f', 'wpforms-form-', 'wpforms-', 'nf-form-',
  'lp-pom-form', 'wf-form-', 'fsForm', 'JotFormIFrame-', '_form_', 'mc4wp-form-', 'mc_embed_signup',
];

interface Signature {
  vendor: FormProvider;
  /** Returns evidence text on a match, else null. `action` is the form action. */
  test: (s: PageSignals, action: string) => string | null;
}

// Order matters: the FIRST match wins. Dedicated form vendors come before the site builders
// (Unbounce, Webflow), whose own form markup is on every page of the site and would otherwise
// shadow a HubSpot or Klaviyo form embedded into one of their pages.
const SIGNATURES: Signature[] = [
  {
    vendor: 'hubspot',
    // Regional embed hosts (js-na1/js-na2/js-eu1.hsforms.net) are as common as the bare js.hsforms.net,
    // and the submissions endpoint (forms-na2.hsforms.com) is what a readable HubSpot form POSTs to,
    // which is the only marker left when the embed script is injected after the HTML is served.
    // hs-scripts.com / hs-analytics.net are the SITE-WIDE tracking code, loaded on every page of a
    // HubSpot-tracked site whether or not a form exists, so they are not form markers: treating them
    // as one flipped an ordinary <form> on such a site to a HubSpot Custom Event trigger whose
    // listener that form never fires. (FORM_EMBED below already excluded them for this reason.)
    test: (s, action) =>
      some(s.scriptSrcs, /\bjs(-[a-z0-9]+)?\.hsforms\.(net|com)/i) ??
      anySel(s, '[data-hsfc-id]', '.hs-form-html', '.hbspt-form', '.hs-form') ??
      anyClass(s, 'hs-form', 'hs-form-html', 'hbspt-form', 'hs-form-frame') ??
      classLike(s, /^hsfc-/) ??
      idLike(s, /^#hsForm_/) ??
      actionLike(action, /\bforms(-[a-z0-9]+)?\.hsforms\.com|\bapi\.hsforms\.com|\bshare\.hsforms\.com/i, 'hsforms.com'),
  },
  {
    vendor: 'marketo',
    // A Marketo form rendered without the #mktoForm_<n> id still carries class .mktoForm; the forms2
    // loader script (app-*.marketo.com/js/forms2/...) is a further page-level marker.
    test: (s, action) =>
      idLike(s, /^#mktoForm_\d/) ??
      anyClass(s, 'mktoForm') ??
      anySel(s, '.mktoForm') ??
      // The forms2 LOADER only. munchkin.js is the analytics tracker, loaded site-wide without any
      // form, and must not flip unrelated forms to provider=marketo.
      some(s.scriptSrcs, /\.marketo\.(com|net)\/js\/forms2\//i) ??
      actionLike(action, /\.marketo\.com\/index\.php\/leadCapture/i, 'marketo leadCapture'),
  },
  {
    vendor: 'pardot',
    test: (s, action) =>
      some(s.scriptSrcs, /pi\.pardot\.com|go\.pardot\.com/i) ??
      anyClass(s, 'pardotForm') ??
      anySel(s, '.pardotForm') ??
      some(s.iframeSrcs ?? [], /\.pardot\.com\/l\/|go\.pardot\.com/i) ??
      actionLike(action, /pardot\.com/i, 'pardot.com'), // form-handler endpoints
  },
  {
    vendor: 'typeform',
    test: (s, action) =>
      anySel(s, '[data-tf-widget]', '[data-tf-live]', '[data-tf-popup]') ??
      some(s.scriptSrcs, /embed\.typeform\.com/i) ??
      anyClass(s, 'typeform-widget') ??
      some(s.iframeSrcs ?? [], /\.typeform\.com\/(to|embed|widget)/i) ??
      actionLike(action, /typeform\.com/i, 'typeform.com'),
  },
  {
    vendor: 'paperform',
    test: (s, action) =>
      some(s.scriptSrcs, /paperform\.co/i) ??
      anyClass(s, 'paperform') ??
      anySel(s, '[data-paperform-id]') ??
      some(s.iframeSrcs ?? [], /paperform\.co/i) ??
      actionLike(action, /paperform\.co/i, 'paperform.co'),
  },
  {
    vendor: 'jotform',
    test: (s, action) =>
      some(s.scriptSrcs, /(form|js|cdn)\.jotform\.com|cdn\.jotfor\.ms|jotform\.com\/jsform\//i) ??
      anyClass(s, 'jotform-form') ??
      anySel(s, '.jotform-form') ??
      idLike(s, /^#JotFormIFrame-/) ??
      some(s.iframeSrcs ?? [], /(form|submit)\.jotform\.com|jotfor\.ms/i) ??
      actionLike(action, /jotform\.com|jotfor\.ms/i, 'jotform.com'),
  },
  {
    vendor: 'formstack',
    test: (s, action) =>
      some(s.scriptSrcs, /\.formstack\.com\/forms\/js\.php\//i) ??
      anyClass(s, 'fsForm', 'fsBody') ??
      anySel(s, '.fsForm') ??
      idLike(s, /^#fsForm\d/) ??
      some(s.iframeSrcs ?? [], /formstack\.(com|io)/i) ??
      actionLike(action, /formstack\.(com|io)/i, 'formstack.com'),
  },
  {
    vendor: 'klaviyo',
    // The embed is a single <div class="klaviyo-form-<formId>">, so the class SHAPE both identifies
    // the vendor and carries the durable form id.
    test: (s, action) =>
      classLike(s, /^klaviyo-form(-|$)/) ??
      anySel(s, '[class^="klaviyo-form"]') ??
      some(s.scriptSrcs, /static(-tracking)?\.klaviyo\.com/i) ??
      actionLike(action, /manage\.kmail-lists\.com|klaviyo\.com/i, 'klaviyo.com'),
  },
  {
    vendor: 'activecampaign',
    test: (s, action) =>
      some(s.scriptSrcs, /activehosted\.com\/f\/embed\.php|prism\.app-us1\.com|trackcmp\.net/i) ??
      classLike(s, /^_form(_\d+)?$/) ??
      anyClass(s, '_form-content', '_form_element') ??
      idLike(s, /^#_form_\d/) ??
      actionLike(action, /activehosted\.com\/proc\.php|activehosted\.com\/f\//i, 'activehosted.com'),
  },
  {
    vendor: 'mailchimp',
    test: (s, action) =>
      actionLike(action, /list-manage\.com/i, 'list-manage.com') ??
      anySel(s, '#mce-EMAIL', '#mc-embedded-subscribe', '#mc_embed_signup') ??
      anyClass(s, 'mc4wp-form', 'mc-field-group') ??
      idLike(s, /^#(mc4wp-form-|mc_embed_signup)/) ??
      some(s.scriptSrcs, /chimpstatic\.com|list-manage\.com/i),
  },
  {
    vendor: 'gravityforms',
    // No /gravityforms/ script marker: see the page-level note at the top. The plugin's scripts load
    // on pages that have no Gravity form, and this vendor's verdict turns a native trigger into a
    // Custom Event one, so only markers that prove a Gravity FORM is present may decide it.
    test: (s, action) =>
      anyClass(s, 'gform_wrapper', 'gform_body', 'gform_footer', 'gform-body') ??
      anySel(s, '.gform_wrapper') ??
      idLike(s, /^#gform(_wrapper)?_\d/) ??
      actionLike(action, /#gf_\d/i, 'gravity forms anchor'),
  },
  {
    vendor: 'contactform7',
    // No /contact-form-7/ script marker: CF7 enqueues its script on EVERY page of a site that has
    // the plugin active, so it says nothing about this page having a CF7 form.
    test: (s, action) =>
      anyClass(s, 'wpcf7', 'wpcf7-form') ??
      anySel(s, '.wpcf7') ??
      idLike(s, /^#wpcf7-f\d/) ??
      actionLike(action, /#wpcf7-f\d/i, 'contact form 7 anchor'),
  },
  {
    vendor: 'wpforms',
    // No /wpforms/ script marker: same page-level rule as the other WordPress plugins.
    test: (s) =>
      anyClass(s, 'wpforms-form', 'wpforms-container', 'wpforms-validate') ??
      anySel(s, '.wpforms-form', '.wpforms-container') ??
      idLike(s, /^#wpforms(-form)?-\d/),
  },
  {
    vendor: 'ninjaforms',
    // No /ninja-forms/ script marker: same page-level rule as the other WordPress plugins.
    test: (s) =>
      anyClass(s, 'nf-form-cont', 'nf-form-layout', 'nf-form-wrap') ??
      anySel(s, '.nf-form-cont') ??
      idLike(s, /^#nf-form-\d/),
  },
  {
    vendor: 'elementor',
    // No /elementor/assets/ script marker: EVERY page of an Elementor-built site loads it, form or
    // not, and Elementor is an AJAX-plugin vendor, so that one marker alone reclassified every
    // hand-written <form> on a large share of WordPress sites into a Custom Event tag waiting on a
    // submit_success event those forms never fire. The form widget's own classes decide instead.
    test: (s) =>
      anyClass(s, 'elementor-form', 'elementor-widget-form', 'elementor-field-group') ??
      anySel(s, '.elementor-form'),
  },
  {
    vendor: 'unbounce',
    test: (s) =>
      anyClass(s, 'lp-pom-form', 'lp-pom-button', 'lp-form-errors') ??
      anySel(s, '.lp-pom-form') ??
      idLike(s, /^#lp-pom-form/) ??
      some(s.scriptSrcs, /unbounce\.com|ubembed\.com/i),
  },
  {
    vendor: 'webflow',
    // LAST: .w-form is on every Webflow page, so any dedicated form vendor embedded into a Webflow
    // site must win first.
    test: (s) =>
      anyClass(s, 'w-form', 'w-form-done', 'w-form-fail') ??
      anySel(s, '.w-form', '[data-wf-page]') ??
      idLike(s, /^#wf-form-/) ??
      some(s.scriptSrcs, /website-files\.com\/.*webflow|webflow\.js/i),
  },
];

export function detectFormProvider(signals: PageSignals, action = ''): ProviderMatch {
  for (const sig of SIGNATURES) {
    const evidence = sig.test(signals, action);
    if (evidence) return { vendor: sig.vendor, confidence: 'high', evidence };
  }
  return { vendor: 'unknown', confidence: 'low', evidence: 'no known provider signature' };
}

// FORM-SPECIFIC embed markers, used to recognize a CROSS-ORIGIN embedded form
// (whose fields we can't read) so it still gets a suggestion. Deliberately
// STRICTER than detectFormProvider: only the providers' form scripts/classes/
// selectors + form iframe srcs, NOT generic tracking (e.g. hs-scripts.com),
// so we never synthesize a form that isn't there.
const FORM_EMBED: Signature[] = [
  {
    vendor: 'hubspot',
    // js.hsforms.net (any region) is the FORM embed loader; hs-scripts.com is site-wide tracking and
    // is deliberately absent. [data-hsfc-id] / .hs-form-html / .hbspt-form are the container the embed
    // mounts, so their presence means a form really is there.
    test: (s) =>
      some(s.scriptSrcs, /\bjs(-[a-z0-9]+)?\.hsforms\.(net|com)/i) ??
      anySel(s, '[data-hsfc-id]', '.hs-form-html', '.hbspt-form', '.hs-form') ??
      anyClass(s, 'hs-form', 'hs-form-html', 'hbspt-form') ??
      classLike(s, /^hsfc-/) ??
      idLike(s, /^#hsForm_/) ??
      some(s.iframeSrcs ?? [], /hsforms\.(com|net)|forms\.hubspot|share\.hsforms/i),
  },
  {
    vendor: 'typeform',
    test: (s) =>
      anySel(s, '[data-tf-widget]', '[data-tf-live]', '[data-tf-popup]') ??
      some(s.scriptSrcs, /embed\.typeform\.com/i) ??
      anyClass(s, 'typeform-widget') ??
      some(s.iframeSrcs ?? [], /\.typeform\.com\/(to|embed|widget)/i),
  },
  {
    vendor: 'paperform',
    test: (s) =>
      some(s.scriptSrcs, /paperform\.co/i) ??
      anyClass(s, 'paperform') ??
      anySel(s, '[data-paperform-id]') ??
      some(s.iframeSrcs ?? [], /paperform\.co/i),
  },
  // class .mktoForm means a rendered Marketo form ELEMENT exists (not just the tracking script), so it
  // is a safe embed marker; a bare marketo script src is NOT (munchkin.js loads without a form).
  {
    vendor: 'marketo',
    test: (s) => idLike(s, /^#mktoForm_\d/) ?? anyClass(s, 'mktoForm') ?? anySel(s, '.mktoForm'),
  },
  {
    vendor: 'mailchimp',
    test: (s, a) =>
      actionLike(a, /list-manage\.com/i, 'list-manage.com') ??
      anySel(s, '#mce-EMAIL', '#mc-embedded-subscribe', '#mc_embed_signup') ??
      anyClass(s, 'mc4wp-form'),
  },
  {
    vendor: 'klaviyo',
    // The embed div itself, never the site-wide klaviyo.js onsite tracker (which loads with no form).
    test: (s) => classLike(s, /^klaviyo-form(-|$)/) ?? anySel(s, '[class^="klaviyo-form"]'),
  },
  {
    vendor: 'gravityforms',
    test: (s) => anyClass(s, 'gform_wrapper', 'gform_body') ?? anySel(s, '.gform_wrapper') ?? idLike(s, /^#gform(_wrapper)?_\d/),
  },
  {
    vendor: 'contactform7',
    test: (s) => anyClass(s, 'wpcf7', 'wpcf7-form') ?? anySel(s, '.wpcf7') ?? idLike(s, /^#wpcf7-f\d/),
  },
  {
    vendor: 'wpforms',
    test: (s) =>
      anyClass(s, 'wpforms-form', 'wpforms-container') ??
      anySel(s, '.wpforms-form', '.wpforms-container') ??
      idLike(s, /^#wpforms(-form)?-\d/),
  },
  {
    vendor: 'ninjaforms',
    test: (s) => anyClass(s, 'nf-form-cont', 'nf-form-wrap') ?? anySel(s, '.nf-form-cont') ?? idLike(s, /^#nf-form-\d/),
  },
  {
    vendor: 'pardot',
    test: (s) => some(s.iframeSrcs ?? [], /pardot\.com/i) ?? some(s.scriptSrcs, /pi\.pardot\.com/i) ?? anyClass(s, 'pardotForm'),
  },
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
    test: (s) =>
      some(s.iframeSrcs ?? [], /(form|submit)\.jotform\.com|jotfor\.ms/i) ??
      some(s.scriptSrcs, /cdn\.jotfor\.ms|js\.jotform\.com|jotform\.com\/jsform\//i) ??
      anyClass(s, 'jotform-form') ??
      idLike(s, /^#JotFormIFrame-/),
  },
  // iframe-or-form-script only: a bare vendor SDK match would synth a phantom form when the SDK loads
  // without a form (Formstack Documents/Sign, a stray wufoo.com script), violating "never synthesize a
  // form that isn't there". js.php/<id> IS the per-form embed, so it is safe.
  {
    vendor: 'formstack',
    test: (s) =>
      some(s.iframeSrcs ?? [], /formstack\.(com|io)/i) ??
      some(s.scriptSrcs, /\.formstack\.com\/forms\/js\.php\//i) ??
      anyClass(s, 'fsForm') ??
      idLike(s, /^#fsForm\d/),
  },
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
