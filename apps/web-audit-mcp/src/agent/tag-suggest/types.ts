import type { InstallPlan } from './install-plan.js';

// Phase 1 of "Measurement Plan from a URL": the data model for turning detected
// page elements + forms into suggested GTM tags. PURE — no browser, no MCP. The
// detection inputs (PageSignals, DetectedForm, DetectedElement) can be produced
// by EITHER Playwright (Phase 2) OR a Cheerio static parse, so this core stays
// dependency-free and unit-testable. The SuggestedTag output is deliberately the
// SAME shape the desktop create_gtm_tracking_tag tool already accepts, so Phase 3
// can feed a suggestion straight into the existing draft-only approval flow.

/** Normalized page signals for provider detection — from Playwright or Cheerio. */
export interface PageSignals {
  /** <script src> values on the page. */
  scriptSrcs: string[];
  /** Distinct class tokens present anywhere on the page. */
  classNames: string[];
  /** Selectors known to be present (e.g. '#mce-EMAIL', '[data-tf-widget]', '#mktoForm_12'). */
  selectorsPresent: string[];
  /** <iframe src> values — lets us detect a CROSS-ORIGIN embedded provider form
   *  (HubSpot/Typeform/Marketo) whose fields we can't read. */
  iframeSrcs?: string[];
  /** distinct dataLayer `event` values the site already pushes (mostly load-time). */
  dataLayerEvents?: string[];
  /** detected JS framework (next/react/vue/angular/gatsby). */
  framework?: string;
}

export type FormProvider =
  | 'hubspot' | 'typeform' | 'paperform' | 'mailchimp' | 'gravityforms' | 'contactform7'
  | 'wpforms' | 'ninjaforms' | 'elementor' | 'marketo' | 'pardot'
  | 'calendly' | 'jotform' | 'formstack' | 'tally' | 'googleforms' | 'wufoo'
  | 'embed' | 'unknown';

export interface ProviderMatch {
  vendor: FormProvider;
  confidence: 'high' | 'medium' | 'low';
  /** What matched (for the "evidence" shown to the user). */
  evidence: string;
}

/** Mirrors web-audit-mcp forms.ts FormPurpose. */
export type FormPurpose = 'search' | 'login' | 'signup' | 'newsletter' | 'contact' | 'checkout' | 'other';

/** A form field, compact — type + name + required (NEVER any entered value). */
export interface FormFieldSummary {
  type: string;
  name: string;
  required: boolean;
}

export interface DetectedForm {
  /** Page path, e.g. "/contact". */
  page: string;
  purpose: FormPurpose;
  /** Raw form action (its host is a provider hint). */
  action: string;
  provider: ProviderMatch;
  /** "js" = a div/JS form (no native submit); "get"/"post" = a real <form>. */
  method?: string;
  /** The form element's own id/classes — used to scope the GTM trigger to THIS
   *  form. Empty for cross-origin embedded forms (no readable element). */
  formId?: string;
  formClasses?: string;
  /** The form's visible heading (e.g. "Get a Free Consultation") — used to name
   *  the tag for what the user sees, falling back to the purpose. */
  title?: string;
  /** The form's input fields (type/name/required only) — drives the field-based
   *  signature shown to the user. */
  fields?: FormFieldSummary[];
  /** Not rendered at scan time — a modal/popup form that opens on a click (e.g. a
   *  "Book a demo" Marketo modal). Surfaced in the evidence so the user knows why
   *  no form is visible on the page. */
  hidden?: boolean;
}

export type ElementKind = 'email' | 'phone' | 'download' | 'outbound' | 'social' | 'share' | 'cta';

/** For kind==='cta': the inferred purpose of the call-to-action, so each one is
 *  named + triggered by what it actually does ("Subscribe", "Add to Cart", …)
 *  instead of a single generic "CTA". 'generic' = a conversion word with no more
 *  specific intent. */
export type CtaIntent =
  | 'add_to_cart' | 'subscribe' | 'book_demo' | 'request_quote' | 'contact_sales'
  | 'contact' | 'download' | 'get_started' | 'login' | 'search' | 'learn_more' | 'faq' | 'generic';

export interface DetectedElement {
  page: string;
  kind: ElementKind;
  /** Visible label text, trimmed. */
  text: string;
  href?: string;
  region?: 'header' | 'footer' | 'nav' | 'main';
  /** A stable CSS/text selector for the GTM trigger (Phase 2 fills this). */
  selector?: string;
  /** The element's own class attribute (from the collector) — used to find a shared accordion/FAQ
   *  class so grouped FAQ question rows become ONE tag. */
  className?: string;
  /** Set when kind==='cta' — drives the tag/trigger name + the trigger filter. */
  intent?: CtaIntent;
  /** Set when kind==='social' — which network (facebook, linkedin, …). */
  socialNetwork?: string;
  /** Set when kind==='social' — the EXACT domain scraped (e.g. "facebook.com"),
   *  so the trigger matches only the domains the site actually links to. */
  socialDomain?: string;
  /** Set when kind==='share' — the GA4 `share` method this control invokes
   *  (twitter/linkedin/facebook/whatsapp/… for a network SHARE link, 'copy_link'
   *  for a "Copy link" clipboard button). Distinct from a `social` FOLLOW link. */
  shareMethod?: string;
}

/** An embedded video player detected on a page (drives a video-tracking tag).
 *  Only 'youtube' is directly trackable via GTM's built-in YouTube Video trigger;
 *  other providers (vimeo, html5) would need a custom-JS setup. */
export interface VideoEmbed {
  page: string;
  provider: 'youtube';
}

/** Which ad platforms a scan generates tags for. Each maps the SAME detected elements to its own
 *  tags, sharing one trigger per detection. 'ga4' is the always-available default; the rest derive
 *  from the GA4 suggestions (so the trigger name is shared on create). */
export type SuggestPlatform = 'ga4' | 'meta' | 'google_ads' | 'tiktok' | 'linkedin' | 'reddit' | 'pinterest';

export interface SuggestInput {
  /** The audited site's host, used to classify outbound links. */
  siteHost: string;
  forms: DetectedForm[];
  elements: DetectedElement[];
  /** Embedded video players found across the scanned pages (YouTube → one tag). */
  videoEmbeds?: VideoEmbed[];
  /** Auto-detected site type (set by buildSuggestInput). 'ecommerce' unlocks the ecommerce funnel
   *  event suggestions (view_item → purchase); 'non_ecommerce' emits NONE of them. */
  websiteType?: 'ecommerce' | 'non_ecommerce';
  /** Human-readable signals that led to the ecommerce classification (for the UI's "why" tooltip). */
  ecommerceEvidence?: string[];
  /** Distinct dataLayer `event` values the SITE already pushes (union across the scanned pages, set by
   *  buildSuggestInput). Lets the install-plan step mark a custom_event suggestion whose event is
   *  already pushed as "already tracked — nothing to install" instead of requiring new site code. */
  dataLayerEvents?: string[];
}

export type TriggerKind = 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit' | 'youtube_video';
export type FilterOp = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'matchRegex' | 'cssSelector';

/** SAME shape as the desktop create_gtm_tracking_tag input → directly creatable. */
export interface SuggestedTag {
  /** Stable id (dedupe / UI key). */
  id: string;
  /** "/contact" or "site-wide" once deduped across pages. */
  page: string;
  /** Human-readable one-liner for the review list. */
  label: string;
  /** Why we suggested it. */
  evidence: string;
  /** Optional caveat (e.g. an embedded provider whose native trigger won't fire). */
  note?: string;
  /** The STRUCTURED, installable companion to `note`: the site-side requirement(s)
   *  for this tag's trigger to fire, expressed (where possible) as an auto-creatable
   *  GTM Custom HTML listener tag. Currently attached to form suggestions only. */
  install?: InstallPlan;
  confidence: 'high' | 'medium' | 'low';
  /** GA4 Enhanced Measurement already auto-tracks this kind — flag, don't push. */
  enhancedMeasurementOverlap: boolean;
  // ── create_gtm_tracking_tag payload ──
  /** 'ga4_event' = a GA4 event tag (gaawe). 'google_tag' = the base Google tag
   *  (the "GA4 Configuration" that loads GA4 on every page) — uses tagId, not
   *  eventName/eventParameters. 'meta_pixel' = a Meta (Facebook) Pixel tag built via
   *  the official gallery template — here `measurementId` holds the Meta Pixel ID
   *  (default {{Meta Pixel ID}}), `eventName` is the Meta standard/custom event
   *  (PageView/Lead/Purchase/…), and `eventParameters` are optional Object Properties.
   *  The other pixel platforms mirror meta_pixel (measurementId = that platform's ID
   *  variable, eventName = its event): 'tiktok_pixel' / 'linkedin_insight' / 'reddit_pixel'
   *  / 'pinterest_tag'. Google Ads uses 'google_ads_conversion' (measurementId = the
   *  Conversion ID, conversionLabel = the Conversion Label), 'google_ads_remarketing'
   *  (measurementId = the Conversion ID), and 'conversion_linker' (no id fields). */
  platform:
    | 'ga4_event'
    | 'google_tag'
    | 'meta_pixel'
    | 'tiktok_pixel'
    | 'linkedin_insight'
    | 'reddit_pixel'
    | 'pinterest_tag'
    | 'google_ads_conversion'
    | 'google_ads_remarketing'
    | 'conversion_linker';
  tagName: string;
  /** Defaults to the {{GA4 Measurement ID}} variable; user can override at create.
   *  For a pixel platform this is that platform's ID (e.g. {{Meta Pixel ID}}); for
   *  google_ads_conversion/remarketing it is the Google Ads Conversion ID. */
  measurementId: string;
  /** For platform 'google_ads_conversion': the Ads Conversion Label (default
   *  {{Google Ads Conversion Label}}). Ignored for other platforms. */
  conversionLabel?: string;
  /** For platform 'google_tag': the Measurement ID (or its {{variable}}) the base
   *  tag loads. Ignored for 'ga4_event'. */
  tagId?: string;
  /** For platform 'google_tag': optional gtag config settings (name/value). */
  configSettings?: Array<{ name: string; value: string }>;
  /** For a CTA-derived tag: the classified CTA intent, so platform derivations map by intent
   *  (authoritative) rather than the event-name text. */
  ctaIntent?: CtaIntent;
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  /** Companion Lookup Table variable(s) an event parameter VALUE references by {{name}} (e.g.
   *  form_name = {{Lookup - X Form Name}} keyed on {{Page Path}}, so ONE multi-page form tag records a
   *  per-page form name). Each is auto-created (type smm) with the tag when missing. */
  eventParamLookups?: Array<{
    variableName: string;
    input: string; // e.g. '{{Page Path}}'
    rows: Array<{ key: string; value: string }>;
    defaultValue?: string;
  }>;
  trigger: {
    name: string;
    kind: TriggerKind;
    clickUrlValue?: string;
    clickUrlOperator?: FilterOp;
    /** For matchRegex click-URL: GTM's "matches RegEx (ignore case)" condition parameter (a web
     *  container cannot parse an inline (?i) flag). */
    clickUrlIgnoreCase?: boolean;
    /** For all_clicks/link_click: also filter on {{Click Text}} (e.g. a CTA). */
    clickTextValue?: string;
    clickTextOperator?: FilterOp;
    /** For all_clicks: fire when a companion Lookup Table variable returns "true" (the classic GTM
     *  grouping pattern — ONE tag for several exact click texts). The variable (type smm, input
     *  {{Click Text}}, each text → "true") is auto-created with the tag when missing. */
    lookupTable?: { name: string; texts: string[] };
    /** For all_clicks: fire on any click matching a CSS selector via {{Click Element}} (operator
     *  cssSelector) — an FAQ accordion header so a click on the text, the row, or the arrow all fire. */
    clickElementValue?: string;
    clickElementOperator?: FilterOp;
    /** For form_submit: scope to ONE form via {{Form ID}} / {{Form Classes}}, so
     *  the tag fires for this form only — not every form on the page. */
    formIdValue?: string;
    formIdOperator?: FilterOp;
    formClassesValue?: string;
    formClassesOperator?: FilterOp;
    /** For form_submit with no usable id/class: scope to the one page the form lives on via
     *  {{Page Path}}, so a per-page form gets its OWN tag instead of folding into the All-Forms catch-all. */
    pagePathValue?: string;
    pagePathOperator?: FilterOp;
    /** For pageview scoped to a results / specific page (e.g. a GET site-search results URL): filter on {{Page URL}}. */
    pageUrlValue?: string;
    pageUrlOperator?: FilterOp;
    eventName?: string;
    /** For custom_event: extra ANDed scope conditions on a pushed dataLayer KEY, read via an
     *  auto-created {{dlv - <key>}} Data Layer Variable. Scopes an AJAX/embed form's custom_event to
     *  ONE form by the `form_id` its install listener pushes — GTM's built-in {{Form ID}} does NOT
     *  resolve on a manual dataLayer.push, so this pushed-key variable is the only reliable scope. */
    dataLayerConditions?: Array<{ key: string; value: string; operator?: FilterOp }>;
  };
  /** Best-effort JPEG data-URI of the page location this tag would track (its CTA/form ringed),
   *  captured by a locate-only pass that reuses the verify driver's screenshot logic. Absent when the
   *  element couldn't be located, the kind has no on-page element, or the screenshot cap was hit. */
  screenshot?: string;
}
