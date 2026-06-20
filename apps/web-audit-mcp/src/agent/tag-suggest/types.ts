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
}

export type FormProvider =
  | 'hubspot' | 'typeform' | 'mailchimp' | 'gravityforms' | 'contactform7'
  | 'wpforms' | 'marketo' | 'pardot' | 'unknown';

export interface ProviderMatch {
  vendor: FormProvider;
  confidence: 'high' | 'medium' | 'low';
  /** What matched (for the "evidence" shown to the user). */
  evidence: string;
}

/** Mirrors web-audit-mcp forms.ts FormPurpose. */
export type FormPurpose = 'search' | 'login' | 'signup' | 'newsletter' | 'contact' | 'checkout' | 'other';

export interface DetectedForm {
  /** Page path, e.g. "/contact". */
  page: string;
  purpose: FormPurpose;
  /** Raw form action (its host is a provider hint). */
  action: string;
  provider: ProviderMatch;
}

export type ElementKind = 'email' | 'phone' | 'download' | 'outbound' | 'cta';
export interface DetectedElement {
  page: string;
  kind: ElementKind;
  /** Visible label text, trimmed. */
  text: string;
  href?: string;
  region?: 'header' | 'footer' | 'nav' | 'main';
  /** A stable CSS/text selector for the GTM trigger (Phase 2 fills this). */
  selector?: string;
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
    eventName?: string;
  };
}
