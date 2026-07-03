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
// The dataLayer EVENT the suggested Custom Event trigger fires on, per provider — from the corpus of
// real form triggers ("hubspot-form-success" 15×; the generic "form_submit" 213× is the default). The
// push itself comes from the provider listener described in PROVIDER_EVENT_HINT.
const PROVIDER_DL_EVENT: Partial<Record<FormProvider, string>> = {
  hubspot: 'hubspot-form-success',
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
  /** signature → EVERY page the form was seen on (drives the per-page form_name Lookup Table for a
   *  multi-page form: ONE tag whose form_name reflects which page it fired on). */
  pagesBySignature: Map<string, Set<string>>;
  /** lowercased display label → EVERY page the SAME-named form was seen on. Groups multi-page
   *  instances of one form into ONE tag (a {{Page Path}} form_name lookup + an all-pages trigger)
   *  even when their signatures differ (e.g. a per-page form action). Case-insensitive. */
  pagesByLabel: Map<string, Set<string>>;
  /** lowercased label → the canonical (first-seen) display label, so case variants share one tag. */
  canonicalLabel: Map<string, string>;
  /** lowercased label → the DISTINCT unique {{Form ID}}s to scope by (one tag firing on ^(id1|id2)$),
   *  but ONLY when EVERY instance of the group has a unique id (else null → scope by the page RegEx). */
  formIdsByLabel: Map<string, string[] | null>;
  /** lowercased label → the {{Form Classes}} value, same group-uniform rule as formIdByLabel. */
  formClassByLabel: Map<string, string | null>;
}

/** The tag-identifying display label for a form — drives its tagName + event, and is the SAME across
 *  every page the same form appears on (so it groups multi-page instances into one tag). Returns '' for
 *  an untitled "other" form, which yields no tag. Mirrors the inline logic in formSuggestion. */
function formDisplayLabel(f: DetectedForm): string {
  if (f.purpose === 'search' || f.purpose === 'checkout') return '';
  const titleText = (f.title ?? '').replace(/\s+/g, ' ').trim();
  if (f.purpose === 'other' && !titleText) return '';
  return titleText ? (/\bforms?\b/i.test(titleText) ? titleText : `${titleText} Form`) : (FORM_LABEL[f.purpose] ?? 'Form Submission');
}

const escRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  // An unrecognized form with no heading has no meaningful event or scope — do NOT emit a generic
  // "Form Submission" tag (that catch-all was removed by design). A TITLED "other" form still gets its
  // title-derived tag.
  if (f.purpose === 'other' && !titleText) return null;
  const rawLabel = titleText ? (/\bforms?\b/i.test(titleText) ? titleText : `${titleText} Form`) : formLabel;
  // Use the GROUP's canonical (first-seen) casing so case variants of the same form share ONE tag.
  const labelKey = rawLabel.toLowerCase();
  const displayLabel = ctx.canonicalLabel.get(labelKey) ?? rawLabel;
  // A TITLED form gets a distinct event from its title so the event matches the tag name (e.g.
  // "Download Form" → download_form) instead of a shared purpose event; an untitled form keeps its
  // purpose event (contact_form / login / …, which is already GA4-appropriate and stays recommended).
  const eventName = titleText ? eventFromLabel(displayLabel) : (FORM_EVENT[f.purpose] ?? 'form_submission');

  // EVERY page this same-named form was found on (its tag-identity group). >=2 means the SAME form
  // spans multiple pages, so it becomes ONE tag firing on all of them (not N page-scoped duplicates).
  const labelPages = [...(ctx.pagesByLabel.get(labelKey) ?? new Set([f.page]))].filter(Boolean).sort();
  const multiPage = labelPages.length >= 2 && labelPages.length <= 50;

  // Scope the trigger to THIS form. GROUP-LEVEL id/class (every instance of the same-named form shares
  // the SAME unique one) is preferred; a MIXED group (id on some pages, not others) must NOT scope by
  // that id — it would split the group into an id-tag + a page-regex tag with the SAME name (a
  // duplicate-name collision at create) — so it falls through to the page RegEx (one tag for the group).
  const trigger: SuggestedTag['trigger'] = { name: trigNameOf(displayLabel, 'form_submit'), kind: 'form_submit' };
  const rawClass = pickFormClass(f.formClasses);
  const groupIds = ctx.formIdsByLabel.get(labelKey) ?? null;
  const groupClass = ctx.formClassByLabel.get(labelKey) ?? null;
  const idUnique = !!f.formId && !ctx.nonUniqueIds.has(f.formId);
  const classUnique = !!rawClass && !ctx.nonUniqueClasses.has(rawClass);
  let usedClass: string | null = null;
  let usedPage: string | null = null;
  if (groupIds && groupIds.length) {
    // Scope by {{Form ID}} — one id → equals; several distinct ids in the group → ^(id1|id2)$ matchRegex
    // (fires on exactly those forms, wherever they appear, with no page over-fire).
    if (groupIds.length === 1) {
      trigger.formIdValue = groupIds[0];
      trigger.formIdOperator = 'equals';
    } else {
      trigger.formIdValue = `^(${groupIds.map(escRe).join('|')})$`;
      trigger.formIdOperator = 'matchRegex';
    }
  } else if (groupClass) {
    trigger.formClassesValue = groupClass;
    trigger.formClassesOperator = 'contains';
    usedClass = groupClass;
  } else if (multiPage) {
    // Same form, no id/class, on a HANDFUL of pages → ONE tag firing on a submit on ANY of those pages
    // via a {{Page Path}} RegEx (^(/a|/b|…)/?$). This scopes it to exactly its pages (not the site-wide
    // "every form submit" catch-all), and every per-page instance dedups to this one tag.
    trigger.pagePathValue = `^(${labelPages.map(escRe).join('|')})/?$`;
    trigger.pagePathOperator = 'matchRegex';
    usedPage = `${labelPages.length} pages`;
  } else if (labelPages.length === 1) {
    // No usable id/class, ONE page → scope the trigger to that page via {{Page Path}} so it gets its
    // OWN tag (instead of folding into the All-Forms catch-all).
    const onePage = labelPages[0];
    trigger.pagePathValue = onePage;
    // Prefer "contains" so the trigger still matches with a trailing slash / query string / locale
    // prefix; fall back to "equals" for a root or very short path, where "contains" would match
    // essentially every page.
    trigger.pagePathOperator = onePage.replace(/[^a-z0-9]/gi, '').length >= 3 ? 'contains' : 'equals';
    usedPage = onePage;
  }
  // else: the form is on MORE than 50 pages (effectively site-wide) → a page RegEx would be unwieldy,
  // so leave the trigger unscoped (fires on every form submit); the note below warns about that.

  // Flag the cases where the trigger won't fire / won't scope correctly.
  // Pardot's form-HANDLER mode is a native <form> POST the native trigger handles
  // — only its iframe-embed mode (method 'js' / no native form) needs a listener.
  const isEmbed =
    EMBED_PROVIDERS.has(f.provider.vendor) &&
    !(f.provider.vendor === 'pardot' && (f.method === 'post' || f.method === 'get'));
  // AJAX/embed + JS/div forms: the native Form Submission trigger usually never fires there, and the
  // corpus' dominant ("Best"-rated) route is a CUSTOM EVENT trigger — so suggest THAT trigger, fired
  // by the provider listener / submit-handler push described in the note. The {{Form ID}}/{{Form
  // Classes}} built-ins don't resolve on a pushed event, so only the page scope carries over (the
  // builder supports ANDed {{Page Path}} conditions on custom_event, as real containers do).
  const dlEvent = isEmbed || f.method === 'js' ? (PROVIDER_DL_EVENT[f.provider.vendor] ?? 'form_submit') : null;
  if (dlEvent) {
    trigger.kind = 'custom_event';
    trigger.eventName = dlEvent;
    delete trigger.formIdValue;
    delete trigger.formIdOperator;
    delete trigger.formClassesValue;
    delete trigger.formClassesOperator;
  }
  let note: string | undefined;
  if (isEmbed) {
    note = `${cap(f.provider.vendor)} submits in an iframe / via AJAX — GTM's native Form Submission trigger usually won't fire, so this tag fires on a "${dlEvent}" Custom Event. Add the push: ${PROVIDER_EVENT_HINT[f.provider.vendor] ?? 'listen for the provider submit event'} → dataLayer.push({event: "${dlEvent}"}). Fallback: an Element Visibility trigger on the thank-you message.`;
  } else if (f.method === 'js') {
    note = `JS/div form (no native <form> submit) — GTM's Form Submission trigger may not fire, so this tag fires on a "${dlEvent}" Custom Event; push dataLayer.push({event: "${dlEvent}"}) from the form's submit handler. Fallbacks: an All-Clicks trigger on the submit button, or an Element Visibility trigger on the thank-you message.`;
  } else if (trigger.pagePathOperator === 'matchRegex') {
    // The multi-page consolidated case: ONE tag scoped by a {{Page Path}} RegEx over the group's pages.
    // A Page-Path-only Form Submission trigger fires on EVERY form submit on those pages, so warn that
    // a DIFFERENT form co-located on any of them would also fire this tag (and be double-counted).
    note = `Forms sharing this name/heading appear on ${labelPages.length} pages, so they are ONE tag firing when a form is submitted on any of them ({{Page Path}} matches the ${labelPages.length}-page RegEx). Because it is scoped by page (not by the form), ANOTHER form on one of those pages would also fire this tag — give the <form> a shared unique id and switch to a {{Form ID}} trigger to fire on this form only.`;
  } else if (trigger.pagePathValue) {
    // Page-scoped (single page) takes precedence over the shared-id warning below: even when the
    // form carries a NON-unique id, {{Page Path}} equals <page> scopes it precisely, so there is no
    // real collision to warn about (warning here would contradict the tag's own page scope).
    note = `This form has no unique id/class, so it is scoped to submits on ${trigger.pagePathValue} (the only page it was found on). A Page-Path-only trigger fires on any form submit on that page — add a unique id to the <form> for a form-specific {{Form ID}} trigger.`;
  } else if ((f.formId && !idUnique) || (rawClass && !classUnique)) {
    const what = f.formId && !idUnique ? `id "#${f.formId}"` : `class ".${rawClass}"`;
    note = `Another form on the site shares this ${what}, so this trigger will also fire for that form (double-counting). Give each <form> a unique id to scope it.`;
  } else if (!trigger.formIdValue && !trigger.formClassesValue) {
    note = `This form has no id or unique class and appears on multiple pages, so the trigger fires on EVERY form submit. Add an id to each <form> to scope it.`;
  }

  // form_name is a SINGLE reusable {{Form Name}} Custom JavaScript variable (GTM has no built-in
  // {{Form Name}}) — every form tag references the same one, resolved at submit time from the form
  // element (name → id → aria-label → nearest heading). Auto-created with the tag (see FORM_NAME_JS in
  // the desktop builder). NOTE: for embed/AJAX forms that fire on a dataLayer Custom Event (not a
  // native form submit), {{Form Element}} isn't set, so it falls back to "form".
  const formNameValue = '{{Form Name}}';

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
      (sig.length ? `; fields: ${sig.join(', ')}` : '') +
      (f.hidden ? '; hidden at page load — typically opens in a modal/popup or tab (e.g. a "Book a demo" overlay)' : ''),
    ...(note ? { note } : {}),
    confidence: 'high',
    // GA4 EM "form interactions" is limited/generic; a dedicated lead event is valuable.
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: tagNameOf(displayLabel, 'form_submit'),
    measurementId: GA4_VAR,
    eventName,
    // form_id is the runtime {{Form ID}}; form_name is the shared {{Form Name}} Custom JS variable
    // (auto-created on tag create), so every form tag reports a name consistently from ONE variable.
    eventParameters: [
      { name: 'form_id', value: FORM_ID },
      { name: 'form_name', value: formNameValue },
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
  // Grouping is CASE-INSENSITIVE on the display label ("Get a Free Audit" and "GET A FREE AUDIT" are
  // the same form) — key on the lowercased label, keep the first-seen casing as canonical.
  const labelPages = new Map<string, Set<string>>();
  const canonicalLabel = new Map<string, string>();
  const labelForms = new Map<string, DetectedForm[]>();
  for (const f of forms) {
    const label = formDisplayLabel(f);
    if (label) {
      const key = label.toLowerCase();
      if (!canonicalLabel.has(key)) canonicalLabel.set(key, label);
      if (!labelPages.has(key)) labelPages.set(key, new Set());
      labelPages.get(key)!.add(f.page);
      if (!labelForms.has(key)) labelForms.set(key, []);
      labelForms.get(key)!.push(f);
    }
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
  const nonUniqueIds = new Set([...idSigs].filter(([, s]) => s.size > 1).map(([k]) => k));
  const nonUniqueClasses = new Set([...classSigs].filter(([, s]) => s.size > 1).map(([k]) => k));
  // A form unique to ONE page can be page-scoped; one seen on several pages is site-wide (null).
  const pageBySignature = new Map<string, string | null>();
  for (const [sig, pages] of sigPages) pageBySignature.set(sig, pages.size === 1 ? [...pages][0] : null);
  // Per-label GROUP-LEVEL id/class scope, computed so the WHOLE same-named group becomes ONE tag with
  // ONE trigger (never split into an id-tag + a page-regex tag with the same name → a duplicate-name
  // collision at create). {{Form ID}} scope is usable ONLY if EVERY instance carries a UNIQUE id — then
  // scope by the distinct ids ({{Form ID}} matches ^(id1|id2)$), firing on exactly those forms. A MIXED
  // group (id on some pages, not others) falls through to the page RegEx.
  const formIdsByLabel = new Map<string, string[] | null>();
  const formClassByLabel = new Map<string, string | null>();
  for (const [key, group] of labelForms) {
    const allUniqueId = group.every((f) => !!f.formId && !nonUniqueIds.has(f.formId));
    formIdsByLabel.set(key, allUniqueId ? [...new Set(group.map((f) => f.formId!))].sort() : null);
    const classes = new Set(group.map((f) => pickFormClass(f.formClasses) ?? ''));
    const uniformClass = !allUniqueId && classes.size === 1 && !classes.has('') && !nonUniqueClasses.has([...classes][0]) ? [...classes][0] : null;
    formClassByLabel.set(key, uniformClass);
  }
  return {
    nonUniqueIds,
    nonUniqueClasses,
    pageBySignature,
    pagesBySignature: sigPages,
    pagesByLabel: labelPages,
    canonicalLabel,
    formIdsByLabel,
    formClassByLabel,
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
          // Plain regex + the condition-level ignore-case flag — gtm.js evaluates web matchRegex with
          // the browser's JS RegExp, which cannot parse an inline (?i) (SyntaxError → never fires).
          : { name: trigNameOf('File Download', 'link_click'), kind: 'link_click', clickUrlValue: `\\.(${DOWNLOAD_EXT})(\\?|#|$)`, clickUrlOperator: 'matchRegex', clickUrlIgnoreCase: true },
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

const CONF = { high: 0, medium: 1, low: 2 } as const;

// ── FAQ accordion grouping ───────────────────────────────────────────────────
// Question rows (CTA text ending in "?") are ONE FAQ, tracked by a SINGLE tag — never per-question
// tags. The trigger follows the corpus of real FAQ triggers: PREFER a distinctive shared accordion
// class → {{Click Element}} matches CSS "<sel>, <sel> *" (fires on the question text, the row padding,
// OR the arrow icon); else the corpus-dominant {{Click Text}} ends with "?". Either way, when every
// question lives on ONE page the trigger ALSO carries a {{Page Path}} condition (multiple ANDed
// conditions in one trigger, as real containers do); a multi-page FAQ stays site-wide.
const FAQ_UTILITY_RE = /^(flex|grid|block|inline|inline-block|hidden|relative|absolute|fixed|sticky|static|container|row|col|w|h|min|max|p[xytblr]?|m[xytblr]?|gap|space|items|justify|content|self|text|font|leading|tracking|bg|border|rounded|shadow|cursor|group|transition|duration|ease|transform|active|open|show|collapsed?)([-:].*)?$/i;
const FAQ_ACCORDION_RE = /(accordion|faq|question|toggle|collaps|expand|disclos|panel|__item|__header|__trigger|__button|__title|__q)/i;
// Runtime STATE tokens (Bootstrap "collapsed", SMACSS "is-open") — toggled as the accordion opens, so
// they must never scope the trigger. Matches the trailing token so prefixed forms are caught too.
const FAQ_STATE_RE = /(^|[-_])(collapsed?|collapsing|open(ed)?|closed?|active|expanded|show(n)?)$/i;
// Generic component/wrapper classes that are NOT accordion-specific — a SHARED one of these (btn, card,
// elementor-widget, …) would scope the trigger to every button/card on the site. So the fallback must
// reject them; only a clearly accordion-ish token (matched first) or a distinctive class is allowed.
const FAQ_GENERIC_CLASS_RE = /^(btn|button|card|cta|link|box|tile|wrap|wrapper|widget|module|component|block|content|section|nav|menu|header|footer|elementor|col|row|container|list|item|entry|node|field|group|wpb|vc|e|el|ui)([-_].*)?$/i;

/** A CSS class shared by ALL the FAQ question rows to scope the accordion trigger to. Prefers a clearly
 *  accordion-ish token; else a DISTINCTIVE shared class (>=4 chars, not a layout utility, not a generic
 *  component/wrapper). Returns null when nothing usable is shared — so unrelated "?" buttons that merely
 *  share a generic ".btn"/".card" wrapper are NOT grouped into a bogus, page-wide-firing tag. */
function faqSharedClass(questions: DetectedElement[]): string | null {
  const sets = questions.map((q) => new Set((q.className ?? '').split(/\s+/).filter(Boolean)));
  if (!sets.length || sets.some((s) => s.size === 0)) return null;
  // Tokens shared by EVERY question row, longest-first then alpha so the pick is deterministic.
  const shared = [...sets[0]].filter((t) => sets.every((s) => s.has(t))).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (!shared.length) return null;
  // A STATE class (Bootstrap-style "collapsed"/"is-open" — toggled as the accordion opens) must never
  // scope the trigger: it disappears from the open row, so half the clicks wouldn't fire. It can look
  // accordion-ish ("collapsed"/"is-collapsed" match "collaps"), so BOTH picks reject utility/state
  // tokens — leaving a stable structural class (e.g. "acc-tog") for the distinctive fallback.
  return (
    shared.find((t) => FAQ_ACCORDION_RE.test(t) && !FAQ_UTILITY_RE.test(t) && !FAQ_STATE_RE.test(t)) ??
    shared.find((t) => t.length >= 4 && !FAQ_UTILITY_RE.test(t) && !FAQ_GENERIC_CLASS_RE.test(t) && !FAQ_STATE_RE.test(t)) ??
    null
  );
}

function faqTagFor(questions: DetectedElement[]): SuggestedTag {
  const pages = [...new Set(questions.map((q) => q.page))];
  const onePage = pages.length === 1 ? pages[0] : null;
  const distinct = new Set(questions.map((q) => q.text.replace(/\s+/g, ' ').trim().toLowerCase())).size;
  const cls = faqSharedClass(questions);
  // {{Click Text}} ends with "?" is the PRIMARY FAQ condition (the corpus-dominant signal) and is
  // ALWAYS present. When a stable shared class exists it is ANDed with the {{Click Element}} CSS
  // selector — the corpus combines them the same way ("Click Text ENDS_WITH ? AND Click Classes
  // CONTAINS <accordion class>"), so the tag never fires on a non-question element that merely sits
  // inside the accordion, and never on a "?" text outside it.
  const trigger: SuggestedTag['trigger'] = {
    name: trigNameOf('FAQ', 'all_clicks'),
    kind: 'all_clicks',
    clickTextValue: '?',
    clickTextOperator: 'endsWith',
    ...(cls ? { clickElementValue: `.${cls}, .${cls} *`, clickElementOperator: 'cssSelector' as const } : {}),
  };
  if (onePage) {
    // ANDed condition scoping the trigger to the FAQ's page. Same operator guard as the
    // form path: "contains" survives trailing slash/locale prefixes; a root/short path uses equals.
    trigger.pagePathValue = onePage;
    trigger.pagePathOperator = onePage.replace(/[^a-z0-9]/gi, '').length >= 3 ? 'contains' : 'equals';
  }
  const how = cls
    ? `share class ".${cls}" — ONE tag fires when the clicked text ends with "?" inside the accordion (.${cls})`
    : `are tracked by ONE tag firing when the clicked text ends with "?"`;
  return {
    id: hashId(`cta|faq|${cls ?? 'text'}|${onePage ?? 'site-wide'}`),
    page: onePage ?? 'site-wide',
    label: `FAQ accordion (${distinct} questions) → GA4 "faq_click"`,
    evidence: `${distinct} FAQ question rows ${how}${onePage ? `; scoped to ${onePage} via {{Page Path}}` : ''}`,
    note: 'The {{Click Text}} ends-with-"?" condition fires on a click of the question text or the row; a click landing exactly on a bare arrow icon (no text of its own) is not counted.',
    confidence: 'medium',
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: tagNameOf('FAQ', 'all_clicks'),
    measurementId: GA4_VAR,
    eventName: 'faq_click',
    eventParameters: CLICK_PARAMS,
    trigger,
  };
}

/** Group FAQ question rows into ONE tag, consuming them — grouped questions are never ALSO emitted as
 *  individual per-question CTAs. Guarded against over-folding: only GENERIC-intent "?" CTAs qualify
 *  (an intent CTA like "Want to book a demo?" keeps its intent tag), and grouping needs ACCORDION
 *  EVIDENCE — a page with >=2 DISTINCT question texts (accordion rows co-locate). A stray "?" CTA on
 *  another page stays an individual CTA (so it cannot strip the class route / page scoping off a real
 *  accordion), and a repeated identical "Questions?" button across pages never fabricates a group. */
function extractFaqGroups(elements: DetectedElement[]): { faqTags: SuggestedTag[]; consumed: Set<DetectedElement> } {
  const consumed = new Set<DetectedElement>();
  const candidates = elements.filter((e) => e.kind === 'cta' && (e.intent ?? 'generic') === 'generic' && /\?\s*$/.test(e.text || ''));
  const byPage = new Map<string, DetectedElement[]>();
  for (const e of candidates) {
    const list = byPage.get(e.page) ?? [];
    list.push(e);
    byPage.set(e.page, list);
  }
  const anchorPages = new Set(
    [...byPage.entries()].filter(([, list]) => new Set(list.map((e) => e.text.replace(/\s+/g, ' ').trim().toLowerCase())).size >= 2).map(([p]) => p),
  );
  if (!anchorPages.size) return { faqTags: [], consumed };
  const grouped = candidates.filter((e) => anchorPages.has(e.page));
  for (const q of grouped) consumed.add(q);
  return { faqTags: [faqTagFor(grouped)], consumed };
}

// ── Meta (Facebook) Pixel suggestions ────────────────────────────────────────
// Meta suggestions are DERIVED from the GA4 ones so a Meta tag REUSES its GA4 source's trigger name —
// on create, the shared trigger create/reuse-by-name path attaches one trigger to both (GA4 + Meta).
// A Meta suggestion reuses the SuggestedTag fields exactly like GA4: `measurementId` holds the Meta
// Pixel ID (default {{Meta Pixel ID}}), `eventName` is the Meta event, no eventParameters.
const META_PIXEL_VAR = '{{Meta Pixel ID}}';

/** Map a GA4 SuggestedTag to its Meta (Facebook) Pixel counterpart, or null when there is no sensible
 *  Meta event (generic outbound/social/video/faq/learn-more clicks). PURE. The base google_tag becomes
 *  the Meta base PageView pixel; a ga4_event picks the Meta standard/custom event from the GA4 event
 *  name by normalized keyword (forms with no keyword default to Lead). */
export function toMetaSuggestion(ga4: SuggestedTag): SuggestedTag | null {
  const clone = { ...ga4 };
  if (ga4.platform === 'google_tag') {
    // The GA4 base (Google tag) → the Meta BASE pixel: PageView on all pages, no object properties.
    return {
      ...clone,
      platform: 'meta_pixel',
      eventName: 'PageView',
      measurementId: META_PIXEL_VAR,
      tagName: 'Meta Pixel - Base Code',
      tagId: undefined,
      configSettings: undefined,
      eventParameters: undefined,
      eventParamLookups: undefined,
      enhancedMeasurementOverlap: false,
      id: 'meta-' + ga4.id,
      label: 'Meta Pixel base code (PageView on all pages)',
      trigger: ga4.trigger,
    };
  }
  // ga4_event → pick the Meta event from the GA4 event name by normalized keyword.
  const key = ga4.eventName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let metaEvent: string | null = null;
  if (key.includes('purchase')) metaEvent = 'Purchase';
  else if (key.includes('addtocart') || (key.includes('add') && key.includes('cart'))) metaEvent = 'AddToCart';
  else if (key.includes('checkout') || key.includes('initiatecheckout')) metaEvent = 'InitiateCheckout';
  else if (key.includes('viewitem') || key.includes('viewcontent')) metaEvent = 'ViewContent';
  else if (key.includes('search')) metaEvent = 'Search';
  else if (key.includes('subscribe') || key.includes('newsletter')) metaEvent = 'Subscribe';
  else if (key.includes('signup') || key.includes('register')) metaEvent = 'CompleteRegistration';
  else if (key.includes('lead') || key.includes('contact') || key.includes('quote') || key.includes('demo') || key.includes('getstarted')) metaEvent = 'Lead';
  else if (key.includes('email')) metaEvent = 'Contact';
  else if (key.includes('phone') || key.includes('call')) metaEvent = 'Contact';
  else if (key.includes('download')) metaEvent = 'Download';
  else if (ga4.trigger.kind === 'form_submit') metaEvent = 'Lead'; // forms default to Lead
  else return null; // no Meta counterpart — skip generic clicks (outbound/social/video/faq/learn_more)
  return {
    ...clone,
    platform: 'meta_pixel',
    eventName: metaEvent,
    measurementId: META_PIXEL_VAR,
    tagName: 'Meta - ' + metaEvent + ' - ' + ga4.tagName.replace(/^GA4 - (Event - )?/, ''),
    id: 'meta-' + ga4.id,
    label: 'Meta ' + metaEvent + ': ' + ga4.label,
    evidence: ga4.evidence,
    note: ga4.note,
    enhancedMeasurementOverlap: false,
    eventParameters: undefined,
    eventParamLookups: undefined,
    tagId: undefined,
    configSettings: undefined,
    trigger: ga4.trigger,
  };
}

/** opts.full prepends the GA4 Configuration tag (always) so the review list is the COMPLETE set of
 *  creatable tags — not only the scan-derived ones. opts.platforms (default ['ga4']) selects which
 *  platforms to emit: 'ga4' returns the GA4 tags; 'meta' returns their Meta Pixel counterparts (derived
 *  from the GA4 tags so the trigger name is SHARED). 'meta' only computes GA4 internally but does not
 *  return them. */
export function buildSuggestions(
  input: SuggestInput,
  opts: { full?: boolean; platforms?: Array<'ga4' | 'meta'> } = {},
): SuggestedTag[] {
  const scopeCtx = nonUniqueFormScopes(input.forms);
  // Social trigger fires on ONLY the exact domains scraped from the site's links.
  const presentDomains = new Set(
    input.elements.filter((e) => e.kind === 'social' && e.socialDomain).map((e) => e.socialDomain as string),
  );
  const socialPattern = buildSocialUrlPattern(presentDomains);
  // FAQ accordion rows (>=2 question CTAs sharing a class on a page) become ONE tag each; the consumed
  // question elements are NOT also emitted as individual per-question CTAs.
  const { faqTags, consumed } = extractFaqGroups(input.elements);
  const raw: SuggestedTag[] = [
    ...input.forms.map((f) => formSuggestion(f, scopeCtx)),
    ...faqTags,
    ...input.elements.filter((e) => !consumed.has(e)).map((e) => elementSuggestion(e, socialPattern)),
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
    const key = `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${s.trigger.clickTextValue ?? ''}|${s.trigger.clickElementValue ?? ''}|${s.trigger.formIdValue ?? ''}|${s.trigger.formClassesValue ?? ''}|${s.trigger.pagePathValue ?? ''}|${s.trigger.pageUrlValue ?? ''}`;
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
  // The GA4 list (the base Google tag is prepended only in full mode).
  const ga4Suggestions = opts.full ? [ga4ConfigSuggestion(), ...ranked] : ranked;

  // Which platforms to emit (default GA4 only, so existing callers are unchanged). Meta counterparts
  // are DERIVED from the GA4 list so each Meta tag reuses its GA4 source's trigger name (one shared
  // trigger on create). 'meta' alone computes GA4 internally but returns only the Meta tags.
  const platforms = opts.platforms ?? ['ga4'];
  const out: SuggestedTag[] = [];
  if (platforms.includes('ga4')) out.push(...ga4Suggestions);
  if (platforms.includes('meta')) {
    out.push(...ga4Suggestions.map(toMetaSuggestion).filter((x): x is SuggestedTag => x !== null));
  }
  return out;
}
