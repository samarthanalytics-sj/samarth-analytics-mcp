/**
 * TagDrishti Tag Verification Engine — shared types.
 *
 * These types are the contract between the four layers (capture → assertion →
 * journey → report). The assertion engine imports ONLY from this file (types),
 * never from `capture/`, which is what makes it a pure, browser-free function of
 * (CaptureResult, spec) and therefore deterministic and testable in isolation.
 *
 * Statuses use the spec's exact vocabulary ("Pass" | "Partial" | "Fail" |
 * "Not Verified"). `report/scorecard-adapter.ts` maps them to audit_brain's
 * lowercase `pass|partial|fail|not_verified` without importing audit_brain.
 */

export const ENGINE_VERSION = '0.1.0';

// ── Status + phase vocabulary ────────────────────────────────────────────────

export type Status = 'Pass' | 'Partial' | 'Fail' | 'Not Verified';

/** Two-phase consent model: what fired before vs after the consent action. */
export type Phase = 'pre_consent' | 'post_consent';

/** Consent Mode v2 canonical storage fields (snake_case, mirrors the portal engine). */
export const CONSENT_V2_FIELDS = [
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
] as const;
export type ConsentField = (typeof CONSENT_V2_FIELDS)[number];

export type ConsentValue = 'granted' | 'denied' | 'unknown';

// ── Parsed GA4 hit (produced by ga4-hits.ts, consumed by the assertion engine) ──

/**
 * One decoded GA4 event out of a /g/collect request. A single batched POST
 * request may yield several of these; request-level params (v/tid/cid/sid/
 * gcs/gcd/dl/dr) are copied onto every event derived from that request.
 *
 * `params` is keyed by the FULL GA4 param key ("ep.page_type", "epn.value",
 * "up.plan", "upn.age") so a spec's param map matches directly. Values are the
 * raw decoded strings; numeric comparison for `epn.*`/`upn.*` is done at
 * assert time (see assert/checks/param-validation.ts).
 */
export interface Ga4Hit {
  v?: string;
  tid?: string;
  cid?: string;
  sid?: string;
  /** GA4 event name (`en=`), as sent. May be '' for a param-only ping. */
  en: string;
  /** Full-key event + user params: ep.* / epn.* / up.* / upn.*. */
  params: Record<string, string>;
  gcs?: string;
  gcd?: string;
  dl?: string;
  dr?: string;
  /** Engagement time in ms (`_et`), if present. */
  etMs?: number;
  /** True when the hit carried ecommerce item params (pr1=, pr2=, …). */
  hasItems: boolean;
  transport: 'GET' | 'POST';
  /** True for the legacy /collect endpoint (captured but flagged). */
  legacy: boolean;
  /** ms since navigation start (monotonic, informational — excluded from the determinism guarantee). */
  tRelativeMs: number;
}

/** A non-GA4 (or GA4) tracker request observed on the wire, for tracker/linker checks. */
export interface TrackerObservation {
  url: string;
  /** Request hostname (lower-cased). */
  domain: string;
  /** Canonical vendor id: 'ga4' | 'meta_pixel' | 'clarity' | 'google_ads' | 'gtm' | 'tiktok' | 'linkedin' | 'floodlight' | 'other'. */
  vendor: string;
  method: string;
  tRelativeMs: number;
  /** Meta Pixel eventID (`eid`/`event_id`) if present — captured for future dedup work only. */
  eventId?: string;
}

/** What the journey runner did for one interaction/linker step (keyed to a check id). */
export interface ActionResult {
  checkId: string;
  kind: 'click' | 'submit' | 'navigate' | 'linker';
  /** The target selector / link found on the page. */
  selectorFound: boolean;
  /** The action was actually performed. */
  performed: boolean;
  /** ms since navigation start when the action fired (null if not performed). */
  atTMs: number | null;
  /** cross_domain_linker: the outbound destination URL captured after the click. */
  linkerDestUrl?: string;
  /** cross_domain_linker: whether the `_gl` param was present on that destination URL. */
  linkerParamPresent?: boolean;
  note?: string;
}

/** What consent action the runner took (if the spec defined a consent flow). */
export interface ConsentActionFacts {
  action: 'accept' | 'reject';
  /** The selector used (spec-supplied or CMP-detected). */
  selector?: string;
  clicked: boolean;
  /** ms since navigation start at click time. */
  atTMs: number | null;
  note?: string;
}

/** A Consent Mode v2 default/update event seen in the dataLayer (with timing). */
export interface ConsentEventCapture {
  kind: 'default' | 'update';
  tMs?: number;
  fields: Partial<Record<ConsentField, 'granted' | 'denied'>>;
}

/**
 * The full facts artifact produced by the capture layer. Pure data — no browser
 * handles, no functions. This is the sole input (with the spec) to the
 * assertion engine.
 */
export interface CaptureResult {
  requestedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  /** Page navigation succeeded. */
  loaded: boolean;
  /** window.google_tag_manager or a hooked dataLayer was detected. */
  gtmPresent: boolean;
  /** The settle window resolved cleanly (vs. the run never producing stable capture). */
  settled: boolean;
  /** ALL parsed GA4 events, ordered by tRelativeMs. */
  ga4Hits: Ga4Hit[];
  /** ALL tracker requests observed (incl. GA4), for tracker_present + linker. */
  trackers: TrackerObservation[];
  /** ms since nav start when the consent action was performed; null if no consent flow ran. */
  consentActionTMs: number | null;
  consentAction: ConsentActionFacts | null;
  /** Cookie names present just before the consent action (or at settle if no consent flow). */
  cookiesPreConsent: string[];
  /** Cookie names at the end of capture. */
  cookiesPostConsent: string[];
  dataLayerEvents: string[];
  consentEvents: ConsentEventCapture[];
  /** Per-step interaction/linker facts (event_on_interaction, cross_domain_linker). */
  actions: ActionResult[];
  notes: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

// ── Spec (input) — validated by spec-schema.ts. Types kept here to avoid a zod dep in the pure engine. ──

export type CheckType =
  | 'event_fired'
  | 'event_on_interaction'
  | 'param_validation'
  | 'consent_mode'
  | 'duplicate_event'
  | 'tracker_present'
  | 'cross_domain_linker';

/** A param assertion value: `true` = present (any value); string/number = exact match. */
export type ParamAssertion = string | number | boolean;

export interface InteractionAction {
  /** CSS selector to click. */
  click?: string;
  /** CSS selector of a form to submit. */
  submit?: string;
  /** URL to navigate to. */
  navigate?: string;
}

export interface CheckSpec {
  id: string;
  type: CheckType;
  tracker?: string;
  event?: string;
  /** Overrides spec.measurementIds for this check's tid match. */
  tid?: string;
  phase?: Phase;
  params?: Record<string, ParamAssertion>;
  action?: InteractionAction;
  /** duplicate_event: max allowed occurrences (default 1). */
  allowedCount?: number;
  /** duplicate_event: which params make an event "the same" (default: none → en only). */
  keyParams?: string[];
  /** cross_domain_linker: destination domains to check for `_gl`. */
  expectedDomains?: string[];
  /** consent_mode: expected pre-consent default state, per field. */
  expectedDefault?: Partial<Record<ConsentField, ConsentValue>>;
  /** consent_mode: expected post-consent updated state, per field. */
  expectedUpdate?: Partial<Record<ConsentField, ConsentValue>>;
}

export interface ConsentSpec {
  acceptSelector?: string;
  rejectSelector?: string;
  /** Which control to click for the two-phase flow (default 'accept'). */
  mode?: 'accept' | 'reject';
  /** Run the pre-consent firing sub-checks (a) and (b). */
  checkPreConsent?: boolean;
}

export interface SettleSpec {
  /** Stop capturing when no new GA4 collect for this many ms (default 2000). */
  quietMs?: number;
  /** Hard cap on total capture time (default 10000). */
  maxMs?: number;
}

export interface VerifySpec {
  url: string;
  measurementIds?: string[];
  expectedTrackers?: string[];
  consent?: ConsentSpec;
  settle?: SettleSpec;
  checks: CheckSpec[];
}

// ── Report (output) — matches the spec's Output format verbatim ──────────────

export interface HitEvidence {
  tid?: string;
  en: string;
  params?: Record<string, string>;
  gcs?: string;
  gcd?: string;
  tRelativeMs: number;
  transport: 'GET' | 'POST';
}

export interface CheckResult {
  id: string;
  type: CheckType;
  status: Status;
  /** Required on every Fail and Partial. */
  reason?: string;
  evidence?: {
    hits?: HitEvidence[];
    [k: string]: unknown;
  };
}

export interface VerifyReport {
  url: string;
  engineVersion: string;
  specHash: string;
  overall: Status;
  checks: CheckResult[];
  /** Non-fatal capture notes (navigation warnings, unclicked banners, …). */
  notes?: string[];
}
