/**
 * Pure GTM API v2 resource builders, shared by the MCP server and the desktop app.
 *
 * These were the desktop's alone (apps/desktop/src/main/google/gtm-builders.ts), which is why the
 * two assistants produced different work for the same request: the desktop had typed builders that
 * guarantee a correct resource shape, while the website chat had only the raw API primitives and
 * had to re-derive the shape every turn. Asked for a mailto: tag it reached for a Data Layer
 * Variable that can never populate, where the desktop correctly used a Custom JavaScript one.
 *
 * They live HERE, inside the MCP package, because that is the only directory all three surfaces can
 * reach. The MCP compiles with rootDir "src" and is published to npm, so it cannot import upward
 * out of src/ without moving dist/index.js and breaking the package's bin path. The desktop and the
 * orchestrator are both bundled and can import downward into it.
 *
 * No I/O and no dependencies beyond types: every function turns simple inputs into a GTM resource,
 * so OUR code owns the type codes, parameter keys, and the eventSettingsTable list-of-maps shape
 * rather than the model guessing them.
 *
 * The desktop's 206-case suite in apps/desktop/src/main/google/__tests__/gtm-builders.test.ts
 * exercises this code through its original import path and is the contract for any change here.
 */



export type Param = Record<string, unknown>;


export const tpl = (key: string, value: string): Param => ({ type: 'template', key, value });


/** A template Parameter for a DEDICATED top-level Trigger field (e.g. interval, eventName) —
 *  no `key`, unlike entries in a `parameter[]` array. */
export const namedParam = (value: string): Param => ({ type: 'template', value });


export const boolean = (key: string, value: boolean): Param => ({ type: 'boolean', key, value: String(value) });


export const integer = (key: string, value: string): Param => ({ type: 'integer', key, value });



// GTM rejects certain characters in resource names (notably ":"), failing
// creation with "name contains invalid character". A tag/trigger name built from
// scraped page text (a CTA label) can contain them, so strip the offenders and
// collapse whitespace at the create boundary. Letters (incl. non-ASCII), digits,
// and common punctuation are kept.
export function sanitizeName(name: string): string {
  const cleaned = (name ?? '').replace(/[<>:]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned || 'Unnamed';
}



export interface GtmTagResource {
  name: string;
  type: string;
  parameter: Param[];
  firingTriggerId?: string[];
}


export interface GtmTriggerResource {
  name: string;
  type: string;
  filter?: Param[];
  autoEventFilter?: Param[];
  customEventFilter?: Param[];
  /** Form-trigger options — DEDICATED top-level fields (single Parameter each, no
   *  `key`), per the GTM API v2 Trigger schema; NOT entries in a `parameter[]`. */
  waitForTags?: Param;
  checkValidation?: Param;
  /** Generic "Additional parameters" array — used by trigger types whose settings
   *  legitimately live here, e.g. the YouTube Video trigger's capture options
   *  (corpus: 69/69 youTubeVideo triggers store them in `parameter`). NOT for
   *  form waitForTags/checkValidation (those are the top-level fields above). */
  parameter?: Param[];
  /** Timer-trigger options — DEDICATED top-level fields (single Parameter each, no `key`),
   *  per the GTM API v2 Trigger schema; NOT entries in `parameter[]`. */
  eventName?: Param;
  interval?: Param;
  limit?: Param;
}


export interface GtmVariableResource {
  name: string;
  type: string;
  parameter: Param[];
}



/* ───────────── Tags ───────────── */

export interface Ga4EventInput {
  name: string;
  measurementId: string; // G-XXXX (or {{Variable}})
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  firingTriggerId?: string[];
  /** GA4 "Send Ecommerce data" from the dataLayer — forwards the WHOLE ecommerce object (items,
   *  value, currency, transaction_id, …) with no per-param variables. Corpus shape:
   *  sendEcommerceData=true + getEcommerceDataFrom='dataLayer'. Use for funnel event tags. */
  sendEcommerceData?: boolean;
  /** When no eventParameters are passed, auto-fill DEFAULT_GA4_EVENT_PARAMS (default true). Set false
   *  to create a bare tag with no event parameters. */
  autoEventParameters?: boolean;
}



/** Default GA4 event parameters auto-added to a GA4 event tag when the caller passes none: page_url +
 *  previous_page, bound to the default-enabled {{Page URL}} / {{Referrer}} built-in variables. These are
 *  CUSTOM names (not GA4's auto-collected page_location/page_referrer), so they add reportable data
 *  without clashing with automatic collection, and their variables need no setup. Mirrors the
 *  measurement-plan scan's default page params. GA4 auto-collects session/engagement/geo/device, so
 *  those are intentionally not re-added; context params (click_text, form_id) are added per-event by
 *  the scan / passed explicitly. */
export const DEFAULT_GA4_EVENT_PARAMS: Array<{ name: string; value: string }> = [
  { name: 'page_url', value: '{{Page URL}}' },
  { name: 'previous_page', value: '{{Referrer}}' },
];


/** GA4 ecommerce events whose value/currency/items ride the `ecommerce` dataLayer object. For these,
 *  a GA4 event tag defaults "Send Ecommerce data" ON (forward the object) when the caller passes no
 *  explicit event parameters — so the tag ships with its ecommerce payload instead of nothing. */
export const GA4_ECOMMERCE_EVENTS = new Set([
  'view_item', 'view_item_list', 'select_item', 'add_to_cart', 'remove_from_cart', 'view_cart',
  'add_to_wishlist', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase', 'refund',
  'view_promotion', 'select_promotion',
]);


export function isGa4EcommerceEvent(event: string): boolean {
  return GA4_ECOMMERCE_EVENTS.has((event ?? '').trim().toLowerCase());
}



export function buildGa4EventTag(o: Ga4EventInput): GtmTagResource {
  // GTM requires an (empty) measurementId tagReference plus measurementIdOverride
  // holding the actual G-XXXX / {{variable}}. Verified against a reference GTM
  // MCP server's templates.
  // Default Send-Ecommerce ON for an ecommerce event when the caller neither set it nor passed
  // explicit event parameters — the ecommerce object is how GA4 carries value/currency/items, so
  // the tag ships complete instead of empty. An explicit sendEcommerceData / eventParameters wins.
  const callerParams = o.eventParameters ?? [];
  const sendEcom = o.sendEcommerceData ?? (isGa4EcommerceEvent(o.eventName) && callerParams.length === 0);
  // Auto-fill the default event parameters when the caller passes none (opt out with
  // autoEventParameters:false) — so a created GA4 event tag ships with reportable page context instead
  // of an empty Event Parameters table. Computed off the CALLER's params so it never flips the
  // sendEcommerceData decision above.
  const params = callerParams.length ? callerParams : (o.autoEventParameters !== false ? DEFAULT_GA4_EVENT_PARAMS : []);
  const parameter: Param[] = [
    { type: 'tagReference', key: 'measurementId', value: '' },
    tpl('measurementIdOverride', o.measurementId),
    tpl('eventName', o.eventName),
    // Off by default — present on 99% of real GA4 event tags (corpus of 562).
    boolean('sendEcommerceData', sendEcom === true),
  ];
  if (sendEcom === true) parameter.push(tpl('getEcommerceDataFrom', 'dataLayer'));
  if (params.length) {
    // Event parameters live in `eventSettingsTable` as a list of maps keyed
    // `parameter`/`parameterValue` — NOT an `eventParameters` list of name/value
    // maps (0 of 8,148 real GA4 tags use that; 5,127 use eventSettingsTable).
    // The old shape was silently ignored by GTM, dropping every parameter.
    parameter.push({
      type: 'list',
      key: 'eventSettingsTable',
      list: params.map((p) => ({
        type: 'map',
        map: [tpl('parameter', p.name), tpl('parameterValue', p.value)],
      })),
    });
  }
  return { name: sanitizeName(o.name), type: 'gaawe', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}



/* ───────────── Triggers ───────────── */

export const FILTER_OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex', 'cssSelector', 'greater', 'greaterOrEquals', 'less', 'lessOrEquals']);


// Our operator TOKEN → the GTM Condition `type` + whether it is a NEGATED ("does not …") condition.
// GTM stores negation as the base type PLUS a `negate` boolean parameter (verified against the corpus:
// {type: BOOLEAN, key: 'negate', value: 'true'} alongside arg0/arg1), NOT a distinct condition type.
export const OP_TO_CONDITION: Record<string, { type: string; negate?: boolean }> = {
  equals: { type: 'equals' }, notEquals: { type: 'equals', negate: true },
  contains: { type: 'contains' }, notContains: { type: 'contains', negate: true },
  startsWith: { type: 'startsWith' }, notStartsWith: { type: 'startsWith', negate: true },
  endsWith: { type: 'endsWith' }, notEndsWith: { type: 'endsWith', negate: true },
  cssSelector: { type: 'cssSelector' }, notCssSelector: { type: 'cssSelector', negate: true },
  matchRegex: { type: 'matchRegex' }, notMatchRegex: { type: 'matchRegex', negate: true },
  less: { type: 'less' }, lessOrEquals: { type: 'lessOrEquals' },
  greater: { type: 'greater' }, greaterOrEquals: { type: 'greaterOrEquals' },
};


// ignoreCase emits GTM's condition-level ignore_case parameter ("matches RegEx (ignore case)") — the
// mechanism real containers use (corpus: 812 conditions across 168/562 files). gtm.js evaluates web
// matchRegex with the browser's JS RegExp, which CANNOT parse an inline (?i) flag (SyntaxError →
// silent no-match), so an inline flag must never be baked into arg1.
export function condition(variable: string, op: string, value: string, ignoreCase?: boolean): Param {
  const m = OP_TO_CONDITION[op] ?? { type: FILTER_OPS.has(op) ? op : 'contains' };
  return {
    type: m.type,
    parameter: [
      tpl('arg0', variable),
      tpl('arg1', value),
      ...(m.negate ? [boolean('negate', true)] : []),
      ...(ignoreCase ? [boolean('ignore_case', true)] : []),
    ],
  };
}



export type TriggerKind =
  | 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit' | 'youtube_video' | 'timer'
  // Added after auditing the official EventType enum against the 562-container corpus. Frequencies
  // there: DOM_READY 425, ELEMENT_VISIBILITY 311, WINDOW_LOADED 183, SCROLL_DEPTH 94,
  // HISTORY_CHANGE 63 - all common enough that not being able to build them was a real gap.
  | 'element_visibility' | 'history_change' | 'scroll_depth' | 'dom_ready' | 'window_loaded' | 'js_error';



/** The standard GTM "Video" built-in variables a YouTube Video tag reports. */
export const VIDEO_BUILT_IN_VARS = [
  'videoProvider', 'videoUrl', 'videoTitle', 'videoDuration', 'videoCurrentTime', 'videoPercent', 'videoStatus', 'videoVisible',
] as const;


export interface TriggerInput {
  name: string;
  kind: TriggerKind;
  /** For link_click/all_clicks: filter on {{Click URL}}. */
  clickUrlValue?: string;
  clickUrlOperator?: string;
  /** For a matchRegex click-URL condition: GTM's "matches RegEx (ignore case)" — emitted as the
   *  condition-level ignore_case parameter (a web container cannot parse an inline (?i) flag). */
  clickUrlIgnoreCase?: boolean;
  /** For link_click/all_clicks: also filter on {{Click Text}} (e.g. a CTA). */
  clickTextValue?: string;
  clickTextOperator?: string;
  /** For a matchRegex click-text condition: GTM's "matches RegEx (ignore case)" — emitted as the
   *  condition-level ignore_case parameter (a web container cannot parse an inline (?i) flag). */
  clickTextIgnoreCase?: boolean;
  /** For all_clicks: fire when a companion Lookup Table variable returns "true" — the classic GTM
   *  grouping pattern (ONE tag for several click texts). The trigger condition is {{<name>}} equals
   *  "true"; the variable itself (type smm, input {{Click Text}}, each text → "true", exact-match)
   *  is auto-provisioned by create_gtm_tracking_tag when missing. */
  lookupTable?: { name: string; texts: string[] };
  /** For all_clicks: fire on any click matching a CSS selector via {{Click Element}} (operator
   *  cssSelector) — e.g. an FAQ accordion header ".faq__q, .faq__q *" so a click on the question text,
   *  the row padding, OR the arrow icon all fire (they are all inside the matched element). */
  clickElementValue?: string;
  clickElementOperator?: string;
  /** For clicks: match the element's class ATTRIBUTE via {{Click Classes}}. GTM exposes the whole
   *  attribute as one string, so a single class is matched with `contains`, never `equals` - an
   *  `equals` on one class of several silently never fires. Preferred over a CSS selector because it
   *  keys on the author's own naming rather than on DOM structure. */
  clickClassesValue?: string;
  clickClassesOperator?: string;
  /** For clicks: match the element's id via {{Click ID}}. The most durable click signal there is,
   *  when the author gave one. */
  clickIdValue?: string;
  clickIdOperator?: string;
  /** For form_submit: scope to one form via {{Form ID}} / {{Form Classes}}. */
  formIdValue?: string;
  formIdOperator?: string;
  formClassesValue?: string;
  formClassesOperator?: string;
  /** For form_submit with no id/class: scope to the form's page via {{Page Path}}. */
  pagePathValue?: string;
  pagePathOperator?: string;
  /** For pageview scoped to a results / specific page (e.g. a GET site-search results URL): filter on {{Page URL}}. */
  pageUrlValue?: string;
  pageUrlOperator?: string;
  /** For custom_event: the dataLayer event name. */
  eventName?: string;
  /** For custom_event: extra ANDed scope conditions that read a pushed dataLayer KEY via an
   *  auto-created {{dlv - <key>}} Data Layer Variable — e.g. scope an AJAX/embed form's custom_event
   *  to ONE form by the `form_id` its listener pushes. GTM's built-in {{Form ID}} does NOT resolve on a
   *  manual dataLayer.push (it is only populated by the native form-submit auto-event), so a pushed-key
   *  variable is the only reliable way to scope a data-layer form trigger. Each key auto-provisions its
   *  `dlv - <key>` variable. Operator matches the other *Operator fields (default 'equals'). */
  dataLayerConditions?: Array<{ key: string; value: string; operator?: string }>;
  /** Page-context scope conditions, ANDed into the filter of ANY filter-capable trigger kind.
   *  {{Page Hostname}} and {{Referrer}} are GTM built-ins. */
  pageHostnameValue?: string;
  pageHostnameOperator?: string;
  referrerValue?: string;
  referrerOperator?: string;
  /** Match the URL's QUERY STRING. Web containers have NO built-in query-string variable (the
   *  API's `queryString` built-in is server-container only, confirmed against Google's built-in
   *  variable reference), so this references a {{URL - query}} URL variable with component QUERY,
   *  auto-provisioned by triggerUrlVarNames the same way dataLayerConditions provision dlv vars. */
  queryStringValue?: string;
  queryStringOperator?: string;
  /** For element_visibility: the element to observe. Give EITHER a CSS selector or an element id;
   *  selectorType follows whichever was supplied (corpus: CSS 295, ID 16 of 311). */
  visibilitySelector?: string;
  visibilityElementId?: string;
  /** For element_visibility: minimum percent of the element on screen before it fires.
   *  Corpus default 50 (269/311). */
  visibilityMinPercent?: number | string;
  /** For element_visibility: ONCE | ONCE_PER_ELEMENT | MANY_PER_ELEMENT. Corpus default ONCE. */
  visibilityFiringFrequency?: string;
  /** For element_visibility: keep watching for elements added to the DOM after page load. ON by
   *  default (corpus 267/311) - without it an AJAX confirmation message that appears AFTER load is
   *  never observed, which is the single most common use of this trigger type. */
  visibilityObserveDomChanges?: boolean;
  /** For element_visibility: require the element to stay on screen for N ms before firing. */
  visibilityMinOnScreenMs?: number | string;
  /** For scroll_depth: vertical thresholds. Percent by default; PIXELS switches units. */
  scrollPercentages?: string;
  scrollPixels?: string;
  /** For scroll_depth: horizontal thresholds (rarely used; off unless supplied). */
  scrollHorizontalPercentages?: string;
  /** For timer: fire every N milliseconds (required). */
  intervalMs?: number | string;
  /** For timer: max number of times to fire (omit/empty = unlimited). */
  limit?: number | string;
}


/** GTM defaults "Wait for Tags" + "Check Validation" to ON for linkClick ("Just Links")
 *  and formSubmission triggers — which delays the click/submit and skips some events.
 *  Force them OFF unless they were EXPLICITLY set (so a user asking to enable them, or a
 *  builder that already set them, is respected). Applied at the create funnel so EVERY
 *  trigger path (chat, structured, suggestions) gets the off-by-default behavior. PURE. */
export function applyTriggerWaitDefaults(trigger: Record<string, unknown>): Record<string, unknown> {
  const type = String((trigger as { type?: unknown }).type ?? '');
  if (type !== 'linkClick' && type !== 'formSubmission') return trigger;
  const out = { ...trigger };
  if (out.waitForTags === undefined) out.waitForTags = { type: 'boolean', value: 'false' };
  if (out.checkValidation === undefined) out.checkValidation = { type: 'boolean', value: 'false' };
  return out;
}



/** Display name of the user variable a queryString condition references.
 *  Deliberately NOT of the form `URL - <param>`: that convention means "the value of ONE query
 *  parameter" and is auto-provisioned with a queryKey. This one is the WHOLE query string (component
 *  QUERY with no key), and it borrows the name Google itself uses for the equivalent server-container
 *  built-in, which is what a GTM practitioner will look for. */
export const URL_QUERY_VAR = 'Query String';



/**
 * Page-context conditions, ANDed into ANY filter-capable trigger.
 *
 * GTM puts no restriction on which variables a trigger's filter reads, so the same page scoping is
 * valid on a click, a form submit, a scroll, a history change or a visibility trigger. Kept in one
 * place so a new trigger kind cannot silently lose the ability to be scoped.
 *
 * Page Path and Page URL stay with their existing per-kind defaults and are NOT emitted here, so
 * this addition cannot change any trigger the builder already produced.
 */
export function pageScopeConditions(o: TriggerInput): Param[] {
  const out: Param[] = [];
  if (o.pageHostnameValue) out.push(condition('{{Page Hostname}}', o.pageHostnameOperator ?? 'equals', o.pageHostnameValue));
  if (o.queryStringValue) out.push(condition(`{{${URL_QUERY_VAR}}}`, o.queryStringOperator ?? 'contains', o.queryStringValue));
  if (o.referrerValue) out.push(condition('{{Referrer}}', o.referrerOperator ?? 'contains', o.referrerValue));
  return out;
}



export function buildTrigger(o: TriggerInput): GtmTriggerResource {
  switch (o.kind) {
    case 'link_click':
    case 'all_clicks': {
      // The "fires on SOME clicks when …" scope conditions go in `filter` (fires
      // iff ALL conditions are true) — NOT autoEventFilter. Verified against the
      // user's 562-container corpus: {{Click URL}}/{{Click Text}} appear in
      // `filter` ~2,700× vs ~1× in autoEventFilter. With the conditions in the
      // wrong array GTM ignores them and the trigger fires on EVERY click.
      const t: GtmTriggerResource = { name: sanitizeName(o.name), type: o.kind === 'link_click' ? 'linkClick' : 'click' };
      const filters: Param[] = [];
      if (o.clickUrlValue) filters.push(condition('{{Click URL}}', o.clickUrlOperator ?? 'contains', o.clickUrlValue, o.clickUrlIgnoreCase === true));
      if (o.clickTextValue) filters.push(condition('{{Click Text}}', o.clickTextOperator ?? 'contains', o.clickTextValue, o.clickTextIgnoreCase === true));
      if (o.clickIdValue) filters.push(condition('{{Click ID}}', o.clickIdOperator ?? 'equals', o.clickIdValue));
      // `contains` by default: {{Click Classes}} is the entire class attribute, so equals on one
      // class of several never matches.
      if (o.clickClassesValue) filters.push(condition('{{Click Classes}}', o.clickClassesOperator ?? 'contains', o.clickClassesValue));
      if (o.clickElementValue) filters.push(condition('{{Click Element}}', o.clickElementOperator ?? 'cssSelector', o.clickElementValue));
      // Lookup-table grouping: the condition reads the companion smm variable, not {{Click Text}}.
      if (o.lookupTable?.name) filters.push(condition(`{{${o.lookupTable.name}}}`, 'equals', 'true'));
      // Page-scoped click trigger (e.g. an FAQ accordion tracked only on its page): a second ANDed
      // {{Page Path}} condition, as real containers do ("Click Text ends with ? AND Page Path contains /faq/").
      if (o.pagePathValue) filters.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      filters.push(...pageScopeConditions(o));
      if (filters.length) t.filter = filters;
      return t;
    }
    case 'custom_event': {
      const t: GtmTriggerResource = {
        name: sanitizeName(o.name),
        type: 'customEvent',
        customEventFilter: [condition('{{_event}}', 'equals', normalizeCustomEventName(o.eventName ?? ''))],
      };
      // Real containers routinely scope a data-layer form trigger further — "event EQUALS form_submit
      // AND {{Form ID}} EQUALS x" / "AND {{Page Path}} CONTAINS /contact" (the corpus' dominant,
      // "Best"-rated form-tracking route). Those secondary ANDed conditions live in `filter`,
      // alongside customEventFilter.
      const filters: Param[] = [];
      if (o.formIdValue) filters.push(condition('{{Form ID}}', o.formIdOperator ?? 'equals', o.formIdValue));
      if (o.pagePathValue) filters.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      if (o.pageUrlValue) filters.push(condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue));
      // Scope a custom_event to a pushed dataLayer KEY via its {{dlv - <key>}} variable — the reliable
      // way to pin a manual-push form event to ONE form (built-in {{Form ID}} does NOT resolve on a
      // pushed event). The dlv variable itself is auto-provisioned by create_gtm_tracking_tag.
      for (const c of o.dataLayerConditions ?? []) {
        const key = (c?.key ?? '').trim();
        const value = c?.value ?? '';
        if (!key || value === '') continue;
        filters.push(condition(`{{dlv - ${key}}}`, c.operator ?? 'equals', value));
      }
      filters.push(...pageScopeConditions(o));
      if (filters.length) t.filter = filters;
      return t;
    }
    case 'form_submit': {
      // A formSubmission trigger with no `filter` fires on ALL forms; the
      // {{Form ID}}/{{Form Classes}} "Some Forms" scope goes in `filter` (same as
      // clicks — corpus: 85× in filter vs 3× in autoEventFilter).
      // waitForTags/checkValidation OFF: GTM's UI defaults them ON, which delays
      // the submit and skips non-validating/AJAX forms — not wanted for tracking.
      // These are DEDICATED top-level Trigger fields (single Parameter, no `key`) —
      // NOT entries in `parameter[]` (corpus: 269/269 form triggers store them so).
      const t: GtmTriggerResource = {
        name: sanitizeName(o.name),
        type: 'formSubmission',
        waitForTags: { type: 'boolean', value: 'false' },
        checkValidation: { type: 'boolean', value: 'false' },
      };
      const filters: Param[] = [];
      if (o.formIdValue) filters.push(condition('{{Form ID}}', o.formIdOperator ?? 'equals', o.formIdValue));
      if (o.formClassesValue) filters.push(condition('{{Form Classes}}', o.formClassesOperator ?? 'contains', o.formClassesValue));
      // {{Page Path}} is ANDed whenever set — so "Form ID equals X AND Page Path equals /contact"
      // scopes a shared-form-name tag to ONE page (not only when no id/class scope exists). GTM filters
      // are ANDed, so this narrows firing to the intended form+page.
      if (o.pagePathValue) filters.push(condition('{{Page Path}}', o.pagePathOperator ?? 'equals', o.pagePathValue));
      filters.push(...pageScopeConditions(o));
      if (filters.length) t.filter = filters;
      return t;
    }
    case 'youtube_video':
      // Built-in YouTube Video trigger (GTM type 'youTubeVideo'). It fires on the
      // YouTube iframe-player events; its settings live in `parameter[]` (corpus:
      // 69/69 store them there). Capture Start/Complete/Progress (not Pause), with
      // the standard percentage milestones — matches GA4's video_start/_progress/
      // _complete recommended events when the tag's eventName is video_{{Video Status}}.
      return {
        name: sanitizeName(o.name),
        type: 'youTubeVideo',
        parameter: [
          boolean('captureStart', true),
          boolean('captureComplete', true),
          boolean('captureProgress', true),
          boolean('capturePause', false),
          tpl('radioButtonGroup1', 'PERCENTAGE'),
          tpl('progressThresholdsPercent', '25,50,75,90'),
          tpl('triggerStartOption', 'DOM_READY'),
          boolean('fixMissingApi', true),
        ],
      };
    case 'timer': {
      // GTM Timer trigger: eventName (gtm.timer), interval (ms), and limit (count; omit =
      // unlimited) are DEDICATED top-level Trigger fields — a single Parameter each, with
      // NO `key` (like waitForTags) — NOT entries in parameter[]. Putting them in
      // parameter[] leaves the GTM UI's Interval/Limit blank.
      const t: GtmTriggerResource = {
        name: sanitizeName(o.name),
        type: 'timer',
        eventName: namedParam(o.eventName || 'gtm.timer'),
      };
      if (o.intervalMs !== undefined && String(o.intervalMs) !== '') t.interval = namedParam(String(o.intervalMs));
      if (o.limit !== undefined && String(o.limit) !== '') t.limit = namedParam(String(o.limit));
      return t;
    }
    case 'pageview': {
      // Fires on All Pages by default; a search-results / page-specific Page View scopes on {{Page URL}}.
      const t: GtmTriggerResource = { name: sanitizeName(o.name), type: 'pageview' };
      const pv: Param[] = [];
      if (o.pageUrlValue) pv.push(condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue));
      if (o.pagePathValue) pv.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      pv.push(...pageScopeConditions(o));
      if (pv.length) t.filter = pv;
      return t;
    }
    // ── Page-load family. Identical to `pageview` apart from WHEN it fires, and all three take the
    //    same page-scope filter (corpus: DOM_READY 425 and WINDOW_LOADED 183 carry filter[] only,
    //    never a parameter[]).
    case 'dom_ready':
    case 'window_loaded':
    case 'history_change':
    case 'js_error': {
      const TYPE = { dom_ready: 'domReady', window_loaded: 'windowLoaded', history_change: 'historyChange', js_error: 'jsError' } as const;
      const t: GtmTriggerResource = { name: sanitizeName(o.name), type: TYPE[o.kind] };
      const f: Param[] = [];
      if (o.pageUrlValue) f.push(condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue));
      if (o.pagePathValue) f.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      f.push(...pageScopeConditions(o));
      if (f.length) t.filter = f;
      return t;
    }
    case 'element_visibility': {
      // Settings live in parameter[] (corpus: 311/311). selectorType follows which of the two
      // targeting fields was supplied, and the VALUE key changes with it: CSS -> elementSelector,
      // ID -> elementId. Getting that pairing wrong leaves the GTM UI's target box empty.
      const useId = !o.visibilitySelector && !!o.visibilityElementId;
      const params: Param[] = [
        tpl('selectorType', useId ? 'ID' : 'CSS'),
        useId ? tpl('elementId', String(o.visibilityElementId ?? '')) : tpl('elementSelector', String(o.visibilitySelector ?? '')),
        // 50% is the corpus default (269/311): enough of the element on screen to count as seen,
        // without requiring a tall element to be fully visible (which on mobile may be impossible).
        tpl('onScreenRatio', String(o.visibilityMinPercent ?? 50)),
        tpl('firingFrequency', String(o.visibilityFiringFrequency ?? 'ONCE')),
        // ON unless explicitly disabled. Without it an element injected AFTER page load - an AJAX
        // form's confirmation message, the most common use of this trigger - is never observed.
        boolean('useDomChangeListener', o.visibilityObserveDomChanges !== false),
      ];
      const dwell = o.visibilityMinOnScreenMs !== undefined && String(o.visibilityMinOnScreenMs) !== '';
      params.push(boolean('useOnScreenDuration', dwell));
      if (dwell) params.push(tpl('onScreenDuration', String(o.visibilityMinOnScreenMs)));
      const t: GtmTriggerResource = { name: sanitizeName(o.name), type: 'elementVisibility', parameter: params };
      const f: Param[] = [];
      if (o.pagePathValue) f.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      if (o.pageUrlValue) f.push(condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue));
      f.push(...pageScopeConditions(o));
      if (f.length) t.filter = f;
      return t;
    }
    case 'scroll_depth': {
      // Corpus shape: verticalThresholdOn/Units/sPercent + horizontalThresholdOn + triggerStartOption.
      // Vertical percent thresholds are the near-universal configuration; pixels and the horizontal
      // axis are supported but stay off unless asked for.
      const usePixels = !!o.scrollPixels && !o.scrollPercentages;
      const horizontal = !!o.scrollHorizontalPercentages;
      const params: Param[] = [
        boolean('verticalThresholdOn', true),
        tpl('verticalThresholdUnits', usePixels ? 'PIXELS' : 'PERCENT'),
        usePixels
          ? tpl('verticalThresholdsPixels', String(o.scrollPixels))
          : tpl('verticalThresholdsPercent', String(o.scrollPercentages ?? '25, 50, 75, 90')),
        boolean('horizontalThresholdOn', horizontal),
        // WINDOW_LOAD, so thresholds are measured against the final laid-out page height rather than
        // a partially-rendered one, which otherwise fires deep-scroll milestones immediately.
        tpl('triggerStartOption', 'WINDOW_LOAD'),
      ];
      if (horizontal) {
        params.push(tpl('horizontalThresholdUnits', 'PERCENT'));
        params.push(tpl('horizontalThresholdsPercent', String(o.scrollHorizontalPercentages)));
      }
      const t: GtmTriggerResource = { name: sanitizeName(o.name), type: 'scrollDepth', parameter: params };
      const f: Param[] = [];
      if (o.pagePathValue) f.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
      if (o.pageUrlValue) f.push(condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue));
      f.push(...pageScopeConditions(o));
      if (f.length) t.filter = f;
      return t;
    }
    default:
      return { name: sanitizeName(o.name), type: 'pageview' };
  }
}



/** Normalize a raw Timer trigger so interval/limit/eventName end up where GTM actually reads
 *  them — as DEDICATED top-level Trigger fields (a single template Parameter each, no `key`),
 *  per the GTM API v2 schema. The model often supplies them as a raw string, or wrongly in
 *  parameter[], which leaves the GTM UI's Interval/Limit BLANK. This pulls a value from a
 *  top-level field (raw string OR Parameter object) OR a parameter[] entry, and writes it to
 *  the top-level field. eventName defaults to gtm.timer; interval/limit are kept only when a
 *  value is present (no limit = unlimited). PURE; applied at the create funnel. */
/** Normalize a Custom Event trigger's EVENT NAME (the dataLayer value it matches) to the real
 *  event token: strip our display-name prefixes ("CE - ", "GA4 - Event - ", "Meta - ", …) and
 *  snake_case a display phrase ("Add To Cart" → "add_to_cart"). A clean token (purchase,
 *  add_to_cart, gtm.dom, .*) is left untouched. The dataLayer pushes `purchase`, never
 *  "CE - Purchase" — using the display name as the event name means the trigger never fires. PURE. */
export function normalizeCustomEventName(name: string): string {
  const raw = (name ?? '').trim();
  // A clean event token has no spaces and no " - " display separator — leave it as-is.
  if (!raw.includes(' - ') && !/\s/.test(raw)) return raw;
  let n = raw;
  const i = n.lastIndexOf(' - ');
  if (i >= 0) n = n.slice(i + 3);
  return n.trim().toLowerCase().replace(/\s+/g, '_');
}



/* ───────────── Variables ───────────── */

export type VariableKind = 'constant' | 'data_layer' | 'javascript' | 'event_data' | 'request_header';


export interface VariableInput {
  name: string;
  kind: VariableKind;
  value?: string; // constant
  dataLayerName?: string; // data_layer
  javascript?: string; // javascript (custom JS)
  keyPath?: string; // event_data (server) — the event-data key to read, e.g. "items" or "x-ga-mp1-x"
  defaultValue?: string; // event_data — value when the key is absent (sets setDefaultValue true)
  headerName?: string; // request_header (server) — the HTTP header to read, e.g. "X-Geo-Country"
}



export function buildVariable(o: VariableInput): GtmVariableResource {
  switch (o.kind) {
    case 'constant':
      return { name: o.name, type: 'c', parameter: [tpl('value', o.value ?? '')] };
    case 'data_layer':
      return {
        name: o.name,
        type: 'v',
        parameter: [tpl('name', o.dataLayerName ?? ''), integer('dataLayerVersion', '2')],
      };
    case 'event_data': {
      // Server-container Event Data variable (`ed`) — reads keyPath from the incoming event.
      // Shape corpus-validated (setDefaultValue + keyPath). Default value is optional.
      const hasDefault = o.defaultValue !== undefined && o.defaultValue !== '';
      const parameter: Param[] = [boolean('setDefaultValue', hasDefault), tpl('keyPath', o.keyPath ?? '')];
      if (hasDefault) parameter.push(tpl('defaultValue', o.defaultValue as string));
      return { name: o.name, type: 'ed', parameter };
    }
    case 'request_header': {
      // Server-container Request Header variable (`rh`) — reads one HTTP header off the incoming
      // request (geo/device the tagging host injects, e.g. X-Geo-Country, X-Device-Os). Shape
      // corpus-validated (a single headerName parameter).
      return { name: o.name, type: 'rh', parameter: [tpl('headerName', o.headerName ?? '')] };
    }
    case 'javascript':
      return { name: o.name, type: 'jsm', parameter: [tpl('javascript', o.javascript ?? '')] };
    default:
      // An off-enum kind must FAIL loudly — the old fallthrough silently created an EMPTY Custom JS
      // variable (a resolves-to-nothing landmine the user only finds later in GTM).
      throw new Error(`Unknown variable kind "${String(o.kind)}" — use constant / data_layer / javascript / event_data / request_header (or create_gtm_variable for raw types).`);
  }
}
