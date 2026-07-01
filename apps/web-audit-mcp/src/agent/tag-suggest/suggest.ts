// The suggestion mapper: detected forms + elements → SuggestedTag[]. PURE +
// unit-tested. Encodes the "what GTM tag should exist for this?" rules, including
// the key nuance that GA4 Enhanced Measurement already auto-tracks some of these
// (outbound clicks, file downloads) — those are FLAGGED, not blindly pushed, so
// we don't suggest redundant tags. Output is directly creatable via the existing
// create_gtm_tracking_tag tool.

import type { DetectedForm, DetectedElement, SuggestInput, SuggestedTag, FormProvider, VideoEmbed, TriggerKind } from './types.js';
import { CTA_BY_INTENT, classifyCtaIntent } from './cta-intents.js';
import { buildSocialUrlPattern } from './social.js';

const GA4_VAR = '{{GA4 Measurement ID}}';
// Event-parameter VALUES are GTM built-in variables, so the tag captures the
// actual clicked link / submitted form at runtime (not a value baked in at scan
// time). The create flow enables whichever of these the parameters reference.
const CLICK_URL = '{{Click URL}}';
const CLICK_TEXT = '{{Click Text}}';
const FORM_ID = '{{Form ID}}';
// Page context on every suggested event. GA4 already auto-collects page_location + page_title, so we
// send the full page URL and the referrer ("previous page") for convenient reporting.
const PAGE_PARAMS = [
  { name: 'page_url', value: '{{Page URL}}' },
  { name: 'previous_page', value: '{{Referrer}}' },
];
/** Standard GA4 click params — what was clicked, its text, and page context.
 *  (click_url / click_text are the corpus-dominant names — 1090/1117 vs the GA4
 *  defaults link_url/link_text at 796/855.) */
const CLICK_PARAMS = [
  { name: 'click_text', value: CLICK_TEXT },
  { name: 'click_url', value: CLICK_URL },
  ...PAGE_PARAMS,
];
// Standard GA4 video params, valued by GTM's "Video" built-in variables (the
// YouTube Video trigger surfaces them). Corpus-dominant names + refs (video_title/
// _url/_provider/_percent/_duration/_current_time = {{Video …}}). The create flow
// auto-enables the built-ins the trigger declares.
const VIDEO_PARAMS = [
  { name: 'video_title', value: '{{Video Title}}' },
  { name: 'video_url', value: '{{Video URL}}' },
  { name: 'video_provider', value: '{{Video Provider}}' },
  { name: 'video_percent', value: '{{Video Percent}}' },
  { name: 'video_duration', value: '{{Video Duration}}' },
  { name: 'video_current_time', value: '{{Video Current Time}}' },
  ...PAGE_PARAMS,
];
// One event whose name resolves at runtime to GA4's recommended video_start /
// video_progress / video_complete via the {{Video Status}} built-in (start /
// progress / complete) — corpus-idiomatic (video_{{…status}} appears 60+×).
const YT_VIDEO_EVENT = 'video_{{Video Status}}';
// Single source of truth for "what's a downloadable file" — the collector's
// detection regex and this GTM trigger filter are both built from it, so a
// detected download always matches the tag we suggest for it.
export const DOWNLOAD_EXT = 'pdf|zip|docx?|xlsx?|pptx?|csv|dmg|exe|rar|7z|mp4|mp3|pkg|apk';
/** A download URL's file extension (lower-case, no dot), ignoring any ?query / #fragment — used to
 *  name the tag ("PDF Download") and build a readable "{{Click URL}} contains .<ext>" trigger.
 *  null when there's no clear extension → the trigger falls back to the multi-extension regex. */
const fileExt = (href?: string): string | null => {
  const path = (href ?? '').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(path);
  return m ? m[1].toLowerCase() : null;
};
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// GTM rejects some characters in resource names (notably ":"), which fails tag
// creation ("name contains invalid character"). Strip them so a name built from
// scraped page text (a CTA label) is always creatable. Mirrors gtm-builders
// sanitizeName (defence-in-depth at the create boundary).
const clean = (s: string): string => s.replace(/[<>:]/g, ' ').replace(/\s{2,}/g, ' ').trim();
// Title-case a label for tag/trigger names, preserving acronyms (PDF/CTA/FAQ/GA4…) and known
// mixed-case brands (YouTube/LinkedIn/WhatsApp). e.g. "talk to our experts" → "Talk To Our Experts".
const TITLE_ACRONYMS = new Set(['ga4', 'cta', 'faq', 'pdf', 'aov', 'roas', 'ai', 'seo', 'sms', 'url', 'api', 'b2b', 'b2c', 'crm', 'ppc', 'roi']);
const TITLE_MIXED: Record<string, string> = { youtube: 'YouTube', linkedin: 'LinkedIn', whatsapp: 'WhatsApp', github: 'GitHub', tiktok: 'TikTok', paypal: 'PayPal' };
const titleCase = (s: string): string =>
  clean(s)
    .split(/\s+/)
    .map((w) => {
      const lw = w.toLowerCase();
      if (TITLE_ACRONYMS.has(lw)) return w.toUpperCase();
      if (TITLE_MIXED[lw]) return TITLE_MIXED[lw];
      if (/^[A-Z0-9][A-Z0-9]+$/.test(w)) return w; // already an acronym (PDF, ZIP)
      if (/[a-z]/.test(w) && /[A-Z]/.test(w.slice(1))) return w; // keep intercaps (iOS, eBook, iPhone, macOS, SaaS)
      return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
    })
    .join(' ');

// Naming convention: tags read "GA4 - Event - <Event Name in Title Case>[ Click| Form] Tag"; triggers
// read "<Event Name>[ Click| Form] Trigger". The Click/Form word reflects the trigger KIND (a click vs
// a form submit) and is omitted for other kinds (video/pageview/custom event); it is never doubled up
// when the label already ends in it (e.g. "Newsletter Form", "Email Click"). tagNameOf + trigNameOf
// share this so a tag and its trigger always carry the SAME kind word.
const kindWord = (d: string, kind: TriggerKind): string => {
  if (kind === 'form_submit') return /\bform(s)?$/i.test(d) || /submission/i.test(d) ? d : `${d} Form`;
  if (kind === 'link_click' || kind === 'all_clicks') return /\bclick$/i.test(d) ? d : `${d} Click`;
  return d; // youtube_video / pageview / custom_event — neither click nor form
};
export const tagNameOf = (label: string, kind: TriggerKind): string => clean(`GA4 - Event - ${kindWord(titleCase(label), kind)} Tag`);
export const trigNameOf = (label: string, kind: TriggerKind): string => clean(`${kindWord(titleCase(label), kind)} Trigger`);

// Human-readable label for a GA4 event name, used in tag names (elements only —
// forms use FORM_LABEL, CTAs use their intent label).
const EVENT_LABEL: Record<string, string> = {
  email_click: 'Email Click',
  phone_click: 'Phone Click',
  file_download: 'File Download',
  outbound_click: 'Outbound Click',
  social_click: 'Social Media Click',
  cta_click: 'CTA Click',
};
const eventLabel = (e: string): string => EVENT_LABEL[e] ?? e.split('_').map(cap).join(' ');

/** A GA4-valid event name derived from a tag label so the event MATCHES the tag name (a per-item tag
 *  gets its own event, not a shared generic one). Lowercased snake_case (letters/digits/underscore),
 *  MUST start with a letter, capped at GA4's 40-char event-name limit (trimmed at a word boundary).
 *  An optional kind suffix (e.g. "click") is appended unless the label already ends with it. */
export function eventFromLabel(label: string, suffix = ''): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (suffix && !base.endsWith(suffix)) base = base ? `${base}_${suffix}` : suffix;
  base = base.replace(/^[^a-z]+/, ''); // GA4 event names must start with a letter
  // GA4 SILENTLY DROPS events whose name starts with a reserved prefix (ga_, google_, firebase_) —
  // strip the offending leading segment(s), then re-ensure a letter start.
  while (/^(ga|google|firebase)_/.test(base)) base = base.replace(/^(ga|google|firebase)_/, '');
  base = base.replace(/^[^a-z]+/, '');
  if (!base) base = suffix || 'event';
  if (base.length > 40) base = base.slice(0, 40).replace(/_[^_]*$/, '') || base.slice(0, 40);
  return base;
}

// Form purpose → human tag/trigger label ("Contact Form", "Newsletter Form").
const FORM_LABEL: Record<string, string> = {
  contact: 'Contact Form',
  signup: 'Signup Form',
  newsletter: 'Newsletter Form',
  login: 'Login Form',
  search: 'Search Form',
  other: 'Form Submission',
};

// djb2 → base36; stable, no crypto dependency.
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Form purpose → GA4 event. Descriptive, form-specific event names.
const FORM_EVENT: Record<string, string> = {
  contact: 'contact_form',
  signup: 'signup_form',
  newsletter: 'newsletter_form',
  login: 'login', // GA4 recommended event (a login-form submit)
  search: 'search', // GA4 recommended event (a search-form submit)
  // NOT "form_submit": that's the reserved name GA4 Enhanced Measurement's form
  // interactions emits, so reusing it would double-count.
  other: 'form_submission',
};

// Providers whose form submits inside an iframe / via AJAX — GTM's NATIVE Form
// Submission trigger won't fire for these; they need a Custom Event listener.
const EMBED_PROVIDERS = new Set<FormProvider>([
  'hubspot', 'paperform', 'typeform', 'marketo', 'pardot',
  'calendly', 'jotform', 'formstack', 'tally', 'googleforms', 'wufoo',
]);
const PROVIDER_EVENT_HINT: Partial<Record<FormProvider, string>> = {
  hubspot: 'HubSpot fires a global submit callback (hsFormCallback / window message)',
  paperform: 'Paperform posts a window message on submit',
  typeform: 'Typeform posts a window message on submit',
  marketo: 'Marketo fires MktoForms2().onSuccess',
  pardot: 'Pardot redirects to a thank-you/completion URL on submit',
  calendly: 'Calendly posts a window message on booking (event_scheduled)',
  jotform: 'JotForm posts a window message on submit',
  formstack: 'Formstack submits inside its embed (window message / redirect)',
  tally: 'Tally posts a window message on submit',
  googleforms: 'Google Forms submits inside a cross-origin iframe — track the click into the form, or use server-side',
  wufoo: 'Wufoo submits inside its embed (confirmation redirect)',
};

// Framework/wrapper classes shared by EVERY form of a stack — useless (harmful)
// for scoping a trigger to ONE form. Never used as a {{Form Classes}} filter.
const GENERIC_FORM_CLASS = /^(form|form-(wrapper|container|inner|inline|horizontal|vertical|group|control|row|inputs?|fields?|signin|signup|stacked)|wpforms-(form|container|validate)|wpcf7(-form)?|gform_wrapper|hs-form|hbspt-form|mc4wp-form|mc-field-group|needs-validation|was-validated|elementor-form|nf-form|frm-show-form|et_pb_contact_form)$/i;

/** A class that reliably scopes to ONE form — i.e. a form-ish class carrying a
 *  numeric instance id (gform_1, mktoForm_521, form-42). Bare/wrapper classes are
 *  rejected (they're shared across all forms of a stack → would over-fire).
 *  Returns null if none → the caller warns "fires on every form". */
function pickFormClass(classes?: string): string | null {
  if (!classes) return null;
  for (const c of classes.split(/\s+/).filter(Boolean)) {
    if (GENERIC_FORM_CLASS.test(c)) continue;
    if (/form/i.test(c) && /\d/.test(c) && c.length >= 5) return c;
  }
  return null;
}

/** Stable per-form signature (purpose + field shape + action) — two forms with
 *  the SAME id but different signatures are DIFFERENT forms sharing a non-unique
 *  id, so that id can't scope a trigger. NEVER includes entered values. */
function formSignature(f: DetectedForm): string {
  const fields = (f.fields ?? [])
    .map((x) => `${x.type}:${x.name}`)
    .sort()
    .join(',');
  return `${f.purpose}|${fields}|${f.action}`;
}

interface FormScopeCtx {
  nonUniqueIds: Set<string>;
  nonUniqueClasses: Set<string>;
  /** signature → the single page it lives on (for page-scoping a form with no usable id/class), or
   *  null when the same form appears on >1 page (site-wide → leave unscoped, the catch-all covers it). */
  pageBySignature: Map<string, string | null>;
}

function formSuggestion(f: DetectedForm, ctx: FormScopeCtx): SuggestedTag | null {
  // Skip: search/login submits aren't conversions; checkout is ECOMMERCE — it
  // needs the dataLayer (begin_checkout/purchase), not a form-submit tag, so it's
  // deferred to the v3 ecommerce phase rather than mis-suggested here.
  // checkout is ECOMMERCE — needs the dataLayer (begin_checkout/purchase), so it's
  // deferred to the v3 ecommerce phase rather than a form-submit tag. Search/login
  // forms ARE tracked now (→ GA4 search / login events).
  if (f.purpose === 'checkout') return null;
  // A SEARCH bar is almost always ONE site-wide component (usually the header). Track it once as GA4
  // site search (view_search_results + search_term), NOT a per-page form-submit: a Form Submission
  // trigger with no id/class cannot isolate the search box (it fires on any form). Every per-page
  // search instance collapses to this one unscoped, site-wide suggestion via dedup. GA4 Enhanced
  // Measurement already auto-tracks site search, so it is FLAGGED (not auto-selected).
  if (f.purpose === 'search') {
    // The RIGHT trigger depends on HOW search runs (collected during the crawl): a GET form reloads to
    // a results URL carrying ?<key>=… → a Page View on {{Page URL}}; a JS/AJAX form does NOT reload →
    // a "site_search" dataLayer Custom Event; a POST form → native Form Submission. Every per-page
    // instance of the (site-wide) bar collapses to ONE tag via dedup. view_search_results is GA4's
    // site-search event, which Enhanced Measurement may already track, so it is FLAGGED (not auto-selected).
    const queryKey = (f.fields ?? []).map((x) => x.name || '').find((n) => /^(q|s|query|search|keyword|term)$/i.test(n)) || 'q';
    const method = (f.method || 'get').toLowerCase();
    let trigger: SuggestedTag['trigger'];
    let note: string;
    // Name is method-specific so a site with MIXED search mechanisms (e.g. a GET header search AND an
    // AJAX widget) yields DISTINCT tags/triggers/ids instead of colliding (GTM rejects duplicate names).
    let searchLabel: string;
    // Only the GET case carries a resolvable search_term (a URL Query variable auto-created on create);
    // js/post keep the note-guided setup (term is in the dataLayer / POST body, no URL to read).
    let searchParams: Array<{ name: string; value: string }> = [...PAGE_PARAMS];
    if (method === 'js') {
      searchLabel = 'Site Search AJAX';
      trigger = { name: trigNameOf(searchLabel, 'custom_event'), kind: 'custom_event', eventName: 'site_search' };
      note = `AJAX/SPA search (no page reload). This fires on a "site_search" Custom Event — have the site push dataLayer.push({event:"site_search", search_term:"<term>"}) on each search, then add a search_term parameter from a Data Layer Variable reading "search_term". GA4 Enhanced Measurement may already track site search.`;
    } else if (method === 'post') {
      searchLabel = 'Site Search Form';
      trigger = { name: trigNameOf(searchLabel, 'custom_event'), kind: 'form_submit' };
      note = `POST search form. It fires on Form Submission, but that cannot isolate the search box (it fires on any form) and the term is in the POST body, not the URL. Prefer firing view_search_results on the results URL (a Page View where {{Page URL}} contains "?${queryKey}="), or add search_term from a Custom JavaScript / Data Layer Variable reading the "${queryKey}" field. GA4 Enhanced Measurement may already track site search.`;
    } else {
      searchLabel = 'Site Search';
      trigger = { name: trigNameOf(searchLabel, 'pageview'), kind: 'pageview', pageUrlValue: `?${queryKey}=`, pageUrlOperator: 'contains' };
      searchParams = [{ name: 'search_term', value: `{{URL - ${queryKey}}}` }, ...PAGE_PARAMS];
      note = `GET search bar: submitting reloads to a results URL carrying "?${queryKey}=<term>", so this fires on a Page View where {{Page URL}} contains "?${queryKey}=". search_term is read by {{URL - ${queryKey}}} — a URL Query variable on the "${queryKey}" key that is created automatically when this tag is created. GA4 Enhanced Measurement may already track site search.`;
    }
    return {
      // id keyed by trigger kind so mixed-method search variants stay distinct (and same-method
      // instances across pages still collapse to one via dedup).
      id: hashId(`form|site-search|${trigger.kind}`),
      page: f.page,
      label: 'Site search → GA4 "view_search_results"',
      evidence: `search bar; method=${method}; query key="${queryKey}"; provider=${f.provider.vendor}`,
      note,
      confidence: 'medium',
      enhancedMeasurementOverlap: true,
      platform: 'ga4_event',
      tagName: tagNameOf(searchLabel, 'custom_event'),
      measurementId: GA4_VAR,
      eventName: 'view_search_results',
      // GET ships search_term = {{URL - <key>}} (the create flow auto-provisions that URL Query
      // variable); js/post keep only resolvable built-ins and guide search_term in the note.
      eventParameters: searchParams,
      trigger,
    };
  }
  const formLabel = FORM_LABEL[f.purpose] ?? 'Form Submission';
  const prov = f.provider.vendor !== 'unknown' ? ` (${f.provider.vendor})` : '';

  // Name the tag for the form's actual heading when we captured one — e.g.
  // "Get a Free Consultation" → "Get a Free Consultation Form Tag" — falling back
  // to the purpose label. (Don't double up "Form" if the title already says it.)
  const titleText = (f.title ?? '').replace(/\s+/g, ' ').trim();
  const displayLabel = titleText ? (/\bforms?\b/i.test(titleText) ? titleText : `${titleText} Form`) : formLabel;
  // A TITLED form gets a distinct event from its title so the event matches the tag name (e.g.
  // "Download Form" → download_form) instead of a shared purpose event; an untitled form keeps its
  // purpose event (contact_form / login / …, which is already GA4-appropriate and stays recommended).
  const eventName = titleText ? eventFromLabel(displayLabel) : (FORM_EVENT[f.purpose] ?? 'form_submission');

  // Scope the trigger to THIS form via its id (preferred) or an instance-unique
  // class — but ONLY if that id/class isn't shared with another form (else it
  // would fire for both). Otherwise it stays unscoped (fires on every form).
  const trigger: SuggestedTag['trigger'] = { name: trigNameOf(displayLabel, 'form_submit'), kind: 'form_submit' };
  const rawClass = pickFormClass(f.formClasses);
  const idUnique = !!f.formId && !ctx.nonUniqueIds.has(f.formId);
  const classUnique = !!rawClass && !ctx.nonUniqueClasses.has(rawClass);
  let usedClass: string | null = null;
  let usedPage: string | null = null;
  if (idUnique) {
    trigger.formIdValue = f.formId;
    trigger.formIdOperator = 'equals';
  } else if (classUnique) {
    trigger.formClassesValue = rawClass!;
    trigger.formClassesOperator = 'contains';
    usedClass = rawClass;
  } else {
    // No usable id/class. If this form lives on ONE page, scope the trigger to that page via
    // {{Page Path}} so it gets its OWN tag (instead of folding into the All-Forms catch-all). A
    // site-wide form (same form on many pages) has no single page → stays unscoped.
    const onePage = ctx.pageBySignature.get(formSignature(f)) ?? null;
    if (onePage) {
      trigger.pagePathValue = onePage;
      // Prefer "contains" so the trigger still matches with a trailing slash / query string / locale
      // prefix; fall back to "equals" for a root or very short path, where "contains" would match
      // essentially every page.
      trigger.pagePathOperator = onePage.replace(/[^a-z0-9]/gi, '').length >= 3 ? 'contains' : 'equals';
      usedPage = onePage;
    }
  }

  // Flag the cases where the trigger won't fire / won't scope correctly.
  // Pardot's form-HANDLER mode is a native <form> POST the native trigger handles
  // — only its iframe-embed mode (method 'js' / no native form) needs a listener.
  const isEmbed =
    EMBED_PROVIDERS.has(f.provider.vendor) &&
    !(f.provider.vendor === 'pardot' && (f.method === 'post' || f.method === 'get'));
  let note: string | undefined;
  if (isEmbed) {
    note = `${cap(f.provider.vendor)} submits in an iframe / via AJAX — GTM's native Form Submission trigger usually won't fire. Track it with a Custom Event trigger: ${PROVIDER_EVENT_HINT[f.provider.vendor] ?? 'listen for the provider submit event'} → push a dataLayer event → fire this tag on it.`;
  } else if (f.method === 'js') {
    note = `JS/div form (no native <form> submit) — GTM's Form Submission trigger may not fire. Use an All-Clicks trigger on the submit button, or a Custom Event from the form's submit handler.`;
  } else if (trigger.pagePathValue) {
    // Page-scoped (single page) takes precedence over the shared-id warning below: even when the
    // form carries a NON-unique id, {{Page Path}} equals <page> scopes it precisely, so there is no
    // real collision to warn about (warning here would contradict the tag's own page scope).
    note = `This form has no unique id/class, so it is scoped to submits on ${trigger.pagePathValue} (the only page it was found on). Add an id to the <form> for a more precise, page-independent trigger.`;
  } else if ((f.formId && !idUnique) || (rawClass && !classUnique)) {
    const what = f.formId && !idUnique ? `id "#${f.formId}"` : `class ".${rawClass}"`;
    note = `Another form on the site shares this ${what}, so this trigger will also fire for that form (double-counting). Give each <form> a unique id to scope it.`;
  } else if (!trigger.formIdValue && !trigger.formClassesValue) {
    note = `This form has no id or unique class and appears on multiple pages, so the trigger fires on EVERY form submit. Add an id to each <form> to scope it.`;
  }

  // Field signature (type/name only — never values) for the evidence line.
  const sig = (f.fields ?? [])
    .filter((x) => !['checkbox', 'radio', 'select', 'hidden'].includes(x.type))
    .map((x) => x.name || x.type)
    .filter(Boolean)
    .slice(0, 8);

  return {
    id: hashId('form|' + f.page + '|' + f.purpose + '|' + (f.formId || f.action)),
    page: f.page,
    label: `${cap(f.purpose)} form${prov} → GA4 "${eventName}" on form submit`,
    evidence:
      `form purpose=${f.purpose}; provider=${f.provider.vendor} (${f.provider.evidence})` +
      (trigger.formIdValue ? `; id=#${f.formId}` : usedClass ? `; class=.${usedClass}` : usedPage ? `; page=${usedPage}` : '') +
      (sig.length ? `; fields: ${sig.join(', ')}` : ''),
    ...(note ? { note } : {}),
    confidence: 'high',
    // GA4 EM "form interactions" is limited/generic; a dedicated lead event is valuable.
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: tagNameOf(displayLabel, 'form_submit'),
    measurementId: GA4_VAR,
    eventName,
    // form_id is the runtime {{Form ID}}; form_name is this form's known name baked in as a constant
    // (GTM has no built-in {{Form Name}} variable, and this tag is scoped to one form). Strip any
    // "{{ }}" from the scraped label so GTM does not resolve it as a variable reference in the value.
    eventParameters: [
      { name: 'form_id', value: FORM_ID },
      { name: 'form_name', value: displayLabel.replace(/[{}]/g, '') },
      ...PAGE_PARAMS,
    ],
    trigger,
  };
}

/** Find form ids / classes that are shared by DIFFERENT forms (different
 *  signatures) — those can't scope a trigger to one form. */
function nonUniqueFormScopes(forms: DetectedForm[]): FormScopeCtx {
  const idSigs = new Map<string, Set<string>>();
  const classSigs = new Map<string, Set<string>>();
  const sigPages = new Map<string, Set<string>>();
  for (const f of forms) {
    const s = formSignature(f);
    if (!sigPages.has(s)) sigPages.set(s, new Set());
    sigPages.get(s)!.add(f.page);
    if (f.formId) {
      if (!idSigs.has(f.formId)) idSigs.set(f.formId, new Set());
      idSigs.get(f.formId)!.add(s);
    }
    const c = pickFormClass(f.formClasses);
    if (c) {
      if (!classSigs.has(c)) classSigs.set(c, new Set());
      classSigs.get(c)!.add(s);
    }
  }
  // A form unique to ONE page can be page-scoped; one seen on several pages is site-wide (null).
  const pageBySignature = new Map<string, string | null>();
  for (const [sig, pages] of sigPages) pageBySignature.set(sig, pages.size === 1 ? [...pages][0] : null);
  return {
    nonUniqueIds: new Set([...idSigs].filter(([, s]) => s.size > 1).map(([k]) => k)),
    nonUniqueClasses: new Set([...classSigs].filter(([, s]) => s.size > 1).map(([k]) => k)),
    pageBySignature,
  };
}

function elementSuggestion(el: DetectedElement, socialPattern: string): SuggestedTag | null {
  const base = (eventName: string, conf: SuggestedTag['confidence'], em: boolean) => ({
    id: hashId(el.kind + '|' + el.page + '|' + (el.href ?? el.text ?? '')),
    page: el.page,
    confidence: conf,
    enhancedMeasurementOverlap: em,
    platform: 'ga4_event' as const,
    tagName: tagNameOf(eventLabel(eventName), 'link_click'),
    measurementId: GA4_VAR,
    eventName,
  });
  switch (el.kind) {
    case 'email':
      return {
        ...base('email_click', 'high', false),
        label: 'Email link (mailto) → GA4 "email_click"',
        evidence: `mailto link${el.region ? ' in ' + el.region : ''}`,
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Email', 'link_click'), kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
      };
    case 'phone':
      return {
        ...base('phone_click', 'high', false),
        label: 'Phone link (tel) → GA4 "phone_click"',
        evidence: `tel link${el.region ? ' in ' + el.region : ''}`,
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Phone', 'link_click'), kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' },
      };
    case 'download': {
      // A download link with a MEANINGFUL label ("Download brochure", "Datasheet") surfaces as its OWN
      // selectable suggestion, scoped to its {{Click Text}}, instead of folding into the generic
      // extension tag — so a named brochure/datasheet download is visible + selectable in the list. It
      // stays flagged as EM-overlap (GA4 auto-tracks file downloads), so it is de-selected until the
      // user opts in. A bare/icon-only "Download" (or no descriptive text) falls through to the generic.
      // Gate on a clear DOWNLOAD-CTA label ("Download brochure", "Datasheet", "Whitepaper") via the
      // shared download intent — a generic file label ("Guide", "Bundle", a bare filename) has no
      // download intent and stays in the generic extension tag below.
      const dlText = el.text.replace(/\s+/g, ' ').trim();
      const labeled = dlText.length >= 3 && dlText.length <= 48 && classifyCtaIntent(dlText) === 'download';
      if (labeled) {
        const dlLabel = dlText.slice(0, 60);
        return {
          ...base('file_download', 'medium', true), // EM already auto-tracks downloads → de-selected, but visible
          tagName: tagNameOf(dlLabel, 'link_click'),
          label: `"${dlLabel}" download → GA4 "file_download"  ⚠ Enhanced Measurement already covers this`,
          evidence: `download link "${el.text}" → ${el.href ?? ''}`.trim(),
          eventParameters: CLICK_PARAMS,
          trigger: { name: trigNameOf(dlLabel, 'link_click'), kind: 'link_click', clickTextValue: dlText, clickTextOperator: 'equals' },
        };
      }
      // Name + scope the tag for the ACTUAL file type ("PDF Download") with a plain
      // "{{Click URL}} ends with .pdf" condition instead of a multi-extension regex. "ends with"
      // anchors at the end of the URL, so it never false-fires on a mid-string match (a /our-services
      // .pdf-guide nav link, ?ref=brochure.pdf) and ".doc" can't match ".docx". Same extension on many
      // pages collapses (dedup key is the click-URL value). The trade-off is a download URL carrying a
      // ?query/#fragment after the extension; those are rare, and no clear extension (e.g. a
      // /download?file= route) → the multi-ext regex fallback, the only place a regex remains.
      const ext = fileExt(el.href);
      const extLabel = ext ? ext.toUpperCase() : 'File';
      return {
        ...base('file_download', 'medium', true), // EM already auto-tracks downloads
        tagName: tagNameOf(`${extLabel} Download`, 'link_click'),
        label: `${extLabel} download → GA4 "file_download"  ⚠ Enhanced Measurement already covers this`,
        evidence: `download link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: ext
          ? { name: trigNameOf(`${extLabel} Download`, 'link_click'), kind: 'link_click', clickUrlValue: `.${ext}`, clickUrlOperator: 'endsWith' }
          : { name: trigNameOf('File Download', 'link_click'), kind: 'link_click', clickUrlValue: `(?i)\\.(${DOWNLOAD_EXT})(\\?|#|$)`, clickUrlOperator: 'matchRegex' },
      };
    }
    case 'outbound':
      return {
        ...base('outbound_click', 'medium', true), // EM already auto-tracks outbound
        label: 'Outbound link → GA4 "outbound_click"  ⚠ Enhanced Measurement already covers this',
        evidence: `outbound link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Outbound', 'link_click'), kind: 'link_click' },
      };
    case 'social':
      return {
        ...base('social_click', 'medium', false),
        label: 'Social media link → GA4 "social_click"',
        // A social link IS outbound, so EM's outbound_click also fires — but this
        // dedicated, named event (with the link captured) is what's usually wanted.
        evidence: `social media link ${el.href ?? ''}`.trim() + ' (note: EM also tracks this as an outbound click)',
        eventParameters: CLICK_PARAMS,
        // Fires ONLY on the social networks actually found on the site.
        trigger: { name: trigNameOf('Social Media', 'link_click'), kind: 'link_click', clickUrlValue: socialPattern, clickUrlOperator: 'matchRegex' },
      };
    case 'cta': {
      const def = CTA_BY_INTENT[el.intent ?? 'generic'];
      const isSpecific = def.intent !== 'generic';
      // Fire on the EXACT button/link text the user sees with "{{Click Text}} equals <text>" — a
      // precise, readable condition (the label from the page, e.g. "Get a Quote") rather than a broad
      // "contains" (which also fires on "Get a Quote Now") or an intent regex. NOTE: GTM's {{Click
      // Text}} is the RENDERED text of the clicked node; a button that wraps an icon / hidden a11y span
      // may have a runtime text that differs from the scraped label, in which case this exact match
      // needs widening to "contains". The intent still selects the semantic GA4 event (book_demo_click,
      // …) + confidence; a CTA with different text becomes its OWN tag, and the SAME text on multiple
      // pages still collapses site-wide (dedup key is the click-text value).
      const ctaText = el.text.replace(/\s+/g, ' ').trim();
      const displayLabel = ctaText.slice(0, 60) || def.label;
      const trigger: SuggestedTag['trigger'] = {
        name: trigNameOf(displayLabel, 'all_clicks'),
        kind: 'all_clicks',
        clickTextValue: ctaText || def.label,
        clickTextOperator: 'equals',
      };
      // Event matches the tag name (both derived from the button text), e.g. "Buy Now" → buy_now_click,
      // instead of a shared generic cta_click. The intent still sets confidence (isSpecific).
      const ctaEvent = eventFromLabel(displayLabel, 'click');
      return {
        ...base(ctaEvent, isSpecific ? 'medium' : 'low', false),
        tagName: tagNameOf(displayLabel, 'all_clicks'),
        label: `"${displayLabel}" → GA4 "${ctaEvent}"`,
        evidence: `button/link text "${el.text}"` + (isSpecific ? ` (intent: ${el.intent})` : ''),
        // Standard click params: click_text ({{Click Text}}) is the dynamic clicked label, click_url
        // the href when the CTA is a link, plus page context.
        eventParameters: CLICK_PARAMS,
        trigger,
      };
    }
  }
}

// An embedded YouTube player → one GA4 video tag firing on GTM's built-in YouTube
// Video trigger. EM "Video engagement" can also auto-track YouTube, so it's FLAGGED
// (like downloads/outbound) — the explicit tag adds the standard video_* params and
// works even when EM video is off.
function videoSuggestion(embeds: VideoEmbed[]): SuggestedTag | null {
  const pages = [...new Set(embeds.filter((e) => e.provider === 'youtube').map((e) => e.page))];
  if (!pages.length) return null;
  return {
    id: hashId('video|youtube'),
    page: pages.length === 1 ? pages[0] : 'site-wide',
    confidence: 'medium',
    enhancedMeasurementOverlap: true,
    platform: 'ga4_event',
    tagName: tagNameOf('YouTube Video', 'youtube_video'),
    measurementId: GA4_VAR,
    eventName: YT_VIDEO_EVENT,
    label: 'YouTube video → GA4 "video_start / video_progress / video_complete"  ⚠ Enhanced Measurement may already cover this',
    evidence: `embedded YouTube player on ${pages.join(', ')} (note: GA4 EM "Video engagement" also tracks this when enabled)`,
    eventParameters: VIDEO_PARAMS,
    trigger: { name: trigNameOf('YouTube Video', 'youtube_video'), kind: 'youtube_video' },
  };
}

// ── Always-/conditionally-offered tags (independent of which exact elements were
//    found) — only emitted in `full` mode so the existing scan output is unchanged.

/** The base "Google tag" (the GA4 Configuration that loads GA4 on every page).
 *  Created via the google_tag platform — tagId is the Measurement-ID variable. The
 *  desktop marks it "already exists" when the container already has a GA4 base tag. */
/** Default Measurement ID for the GA4 Configuration tag — a valid-shaped placeholder
 *  the user can keep or edit. Creating the tag makes a "GA4 Measurement ID" Constant
 *  with this value (changeable in GTM afterwards); only an all-X / empty id is blocked. */
export const GA4_MID_PLACEHOLDER = 'G-1234567890';

export function ga4ConfigSuggestion(): SuggestedTag {
  return {
    id: 'ga4-config',
    page: 'site-wide',
    label: 'GA4 Configuration (Google tag) — loads GA4 on every page',
    evidence: 'the base Google tag every GA4 setup needs; fires on All Pages',
    note: `Creates a "GA4 Measurement ID" Constant variable (= ${GA4_MID_PLACEHOLDER}) and a Google tag using {{GA4 Measurement ID}}. Edit the Measurement ID here (or change the variable's value in GTM) to your real G-XXXXXXXXXX.`,
    confidence: 'high',
    enhancedMeasurementOverlap: false,
    platform: 'google_tag',
    tagName: 'GA4 Configuration',
    // measurementId is the real id the user supplies (default = placeholder); tagId
    // references the variable provisioned from it, so config + event tags share one id.
    measurementId: GA4_MID_PLACEHOLDER,
    tagId: GA4_VAR,
    eventName: '',
    trigger: { name: 'All Pages', kind: 'pageview' },
  };
}

/** One catch-all tag firing on EVERY form submit (no per-form scope). Offered
 *  alongside the scoped per-form tags so the user can pick either. */
export function allFormsSuggestion(): SuggestedTag {
  return {
    id: 'all-forms',
    page: 'site-wide',
    label: 'All form submissions → GA4 "form_submission"',
    evidence: 'one tag firing on every form submit on the site',
    confidence: 'medium',
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: tagNameOf('All Form Submissions', 'form_submit'),
    measurementId: GA4_VAR,
    eventName: 'form_submission',
    eventParameters: [{ name: 'form_id', value: FORM_ID }, { name: 'form_name', value: FORM_ID }, ...PAGE_PARAMS],
    trigger: { name: trigNameOf('All Form Submissions', 'form_submit'), kind: 'form_submit' },
  };
}

const CONF = { high: 0, medium: 1, low: 2 } as const;

/** opts.full prepends the GA4 Configuration tag (always) and the All-form catch-all
 *  (when the site has any form), so the review list is the COMPLETE set of creatable
 *  tags — not only the scan-derived ones. (PDF downloads need no separate catch-all:
 *  the per-file "PDF Download" tag's {{Click URL}} contains .pdf already fires site-wide.) */
export function buildSuggestions(input: SuggestInput, opts: { full?: boolean } = {}): SuggestedTag[] {
  const scopeCtx = nonUniqueFormScopes(input.forms);
  // Social trigger fires on ONLY the exact domains scraped from the site's links.
  const presentDomains = new Set(
    input.elements.filter((e) => e.kind === 'social' && e.socialDomain).map((e) => e.socialDomain as string),
  );
  const socialPattern = buildSocialUrlPattern(presentDomains);
  const raw: SuggestedTag[] = [
    ...input.forms.map((f) => formSuggestion(f, scopeCtx)),
    ...input.elements.map((e) => elementSuggestion(e, socialPattern)),
    videoSuggestion(input.videoEmbeds ?? []),
  ].filter((x): x is SuggestedTag => x !== null);

  // Site-wide dedup: the same tag (event + trigger filter + kind) seen on multiple
  // pages — e.g. a footer email link on every page — collapses to ONE suggestion
  // marked "site-wide", instead of N copies.
  const byKey = new Map<string, SuggestedTag>();
  for (const s of raw) {
    // CTAs are distinguished by their click-text filter, and downloads by their
    // per-file-type click-URL filter (one PDF tag, one ZIP tag, …) — distinct ones
    // stay distinct; everything else genuinely collapses to one tag (one mailto:,
    // one outbound, etc.). The eventParameters are now all GTM-variable refs
    // (identical across instances), so the trigger filter is the discriminator,
    // not the parameter value.
    const key = `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${s.trigger.clickTextValue ?? ''}|${s.trigger.formIdValue ?? ''}|${s.trigger.formClassesValue ?? ''}|${s.trigger.pagePathValue ?? ''}|${s.trigger.pageUrlValue ?? ''}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...s });
    else if (seen.page !== s.page) seen.page = 'site-wide';
  }

  // Rank: confidence (high→low), then real-value (non-EM-overlap first), then label.
  const ranked = [...byKey.values()].sort(
    (a, b) =>
      CONF[a.confidence] - CONF[b.confidence] ||
      Number(a.enhancedMeasurementOverlap) - Number(b.enhancedMeasurementOverlap) ||
      a.label.localeCompare(b.label)
  );
  if (!opts.full) return ranked;
  // COMPLETE list: the GA4 Configuration base tag (always) + the All-form catch-all
  // (when the site has any form), surfaced ABOVE the scan-derived tags.
  const head: SuggestedTag[] = [ga4ConfigSuggestion()];
  let body = ranked;
  if (input.forms.length > 0) {
    head.push(allFormsSuggestion());
    // The All-Form catch-all IS the unscoped generic "form_submission" tag, so drop
    // any scan-derived one that's identical (unscoped + event 'form_submission') to
    // avoid an exact double. SCOPED per-form tags and purpose-specific events
    // (contact_form, signup_form, …) are KEPT — they send a different event.
    body = body.filter((s) => !(s.trigger.kind === 'form_submit' && s.eventName === 'form_submission' && !s.trigger.formIdValue && !s.trigger.formClassesValue && !s.trigger.pagePathValue));
  }
  return [...head, ...body];
}
