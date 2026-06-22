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
}

export type FormProvider =
  | 'hubspot' | 'typeform' | 'paperform' | 'mailchimp' | 'gravityforms' | 'contactform7'
  | 'wpforms' | 'marketo' | 'pardot' | 'unknown';

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
}

export type ElementKind = 'email' | 'phone' | 'download' | 'outbound' | 'social' | 'cta';

/** For kind==='cta': the inferred purpose of the call-to-action, so each one is
 *  named + triggered by what it actually does ("Subscribe", "Add to Cart", …)
 *  instead of a single generic "CTA". 'generic' = a conversion word with no more
 *  specific intent. */
export type CtaIntent =
  | 'add_to_cart' | 'subscribe' | 'book_demo' | 'request_quote' | 'contact_sales'
  | 'get_started' | 'login' | 'search' | 'view_more' | 'learn_more' | 'faq' | 'generic';

export interface DetectedElement {
  page: string;
  kind: ElementKind;
  /** Visible label text, trimmed. */
  text: string;
  href?: string;
  region?: 'header' | 'footer' | 'nav' | 'main';
  /** A stable CSS/text selector for the GTM trigger (Phase 2 fills this). */
  selector?: string;
  /** Set when kind==='cta' — drives the tag/trigger name + the trigger filter. */
  intent?: CtaIntent;
  /** Set when kind==='social' — which network (facebook, linkedin, …). */
  socialNetwork?: string;
  /** Set when kind==='social' — the EXACT domain scraped (e.g. "facebook.com"),
   *  so the trigger matches only the domains the site actually links to. */
  socialDomain?: string;
}

export interface SuggestInput {
  /** The audited site's host, used to classify outbound links. */
  siteHost: string;
  forms: DetectedForm[];
  elements: DetectedElement[];
}

export type TriggerKind = 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit';
export type FilterOp = 'equals' | 'contains' | 'startsWith' | 'matchRegex';

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
  confidence: 'high' | 'medium' | 'low';
  /** GA4 Enhanced Measurement already auto-tracks this kind — flag, don't push. */
  enhancedMeasurementOverlap: boolean;
  // ── create_gtm_tracking_tag payload ──
  platform: 'ga4_event';
  tagName: string;
  /** Defaults to the {{GA4 Measurement ID}} variable; user can override at create. */
  measurementId: string;
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  trigger: {
    name: string;
    kind: TriggerKind;
    clickUrlValue?: string;
    clickUrlOperator?: FilterOp;
    /** For all_clicks/link_click: also filter on {{Click Text}} (e.g. a CTA). */
    clickTextValue?: string;
    clickTextOperator?: FilterOp;
    /** For form_submit: scope to ONE form via {{Form ID}} / {{Form Classes}}, so
     *  the tag fires for this form only — not every form on the page. */
    formIdValue?: string;
    formIdOperator?: FilterOp;
    formClassesValue?: string;
    formClassesOperator?: FilterOp;
    eventName?: string;
  };
}
