// Pure builders that construct valid Google Tag Manager API v2 resources from
// simple inputs, so the LLM supplies fields and OUR code guarantees the correct
// shape (type codes, parameter keys, the eventSettingsTable list-of-maps keyed
// parameter/parameterValue, etc.). No I/O — fully unit-testable.

type Param = Record<string, unknown>;
const tpl = (key: string, value: string): Param => ({ type: 'template', key, value });
const boolean = (key: string, value: boolean): Param => ({ type: 'boolean', key, value: String(value) });
const integer = (key: string, value: string): Param => ({ type: 'integer', key, value });

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
}
export function buildGa4EventTag(o: Ga4EventInput): GtmTagResource {
  // GTM requires an (empty) measurementId tagReference plus measurementIdOverride
  // holding the actual G-XXXX / {{variable}}. Verified against a reference GTM
  // MCP server's templates.
  const parameter: Param[] = [
    { type: 'tagReference', key: 'measurementId', value: '' },
    tpl('measurementIdOverride', o.measurementId),
    tpl('eventName', o.eventName),
    // Off by default — present on 99% of real GA4 event tags (corpus of 562).
    boolean('sendEcommerceData', false),
  ];
  if (o.eventParameters?.length) {
    // Event parameters live in `eventSettingsTable` as a list of maps keyed
    // `parameter`/`parameterValue` — NOT an `eventParameters` list of name/value
    // maps (0 of 8,148 real GA4 tags use that; 5,127 use eventSettingsTable).
    // The old shape was silently ignored by GTM, dropping every parameter.
    parameter.push({
      type: 'list',
      key: 'eventSettingsTable',
      list: o.eventParameters.map((p) => ({
        type: 'map',
        map: [tpl('parameter', p.name), tpl('parameterValue', p.value)],
      })),
    });
  }
  return { name: sanitizeName(o.name), type: 'gaawe', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

export interface GoogleTagInput {
  name: string;
  tagId: string; // G-XXXX / AW-XXXX / GT-XXXX (or {{Variable}})
  /** Optional config settings (key/value), e.g. send_page_view=false. */
  configSettings?: Array<{ name: string; value: string }>;
  firingTriggerId?: string[];
}
// The "Google tag" (googtag) — the modern base tag that loads gtag.js and
// configures GA4/Ads. 4th-most-common tag type in the corpus (826). Config
// settings use configSettingsTable with parameter/parameterValue maps.
export function buildGoogleTag(o: GoogleTagInput): GtmTagResource {
  const parameter: Param[] = [tpl('tagId', o.tagId)];
  if (o.configSettings?.length) {
    parameter.push({
      type: 'list',
      key: 'configSettingsTable',
      list: o.configSettings.map((p) => ({
        type: 'map',
        map: [tpl('parameter', p.name), tpl('parameterValue', p.value)],
      })),
    });
  }
  return { name: o.name, type: 'googtag', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

/** The GTM built-in "All Pages" trigger — a reserved id present in every web
 *  container, so the base Google Tag can fire on it without creating a trigger.
 *  (Corpus: the most common firing trigger for googtag base tags.) */
export const BUILTIN_ALL_PAGES_TRIGGER_ID = '2147479553';

/** Find an existing, LIVE GA4 base/config tag in a container snapshot: a legacy
 *  GA4 Configuration (gaawc), OR a Google Tag (googtag) whose Tag ID is a G-/GT-
 *  id or a {{variable}} reference (configured for GA4 — not an Ads-only AW-
 *  googtag). Paused tags fire nothing, so they're treated as absent. Returns the
 *  tag name, or null when none is present. PURE. */
export function findGa4BaseTag(snap: ContainerSnapshot): { name: string } | null {
  // Resolve a "{{Some Constant}}" Tag ID to the constant's value, so a Google Tag
  // configured for GA4 via a variable counts — but an Ads tag using e.g.
  // "{{Conversion ID}}" (→ AW-…) does NOT falsely count as a GA4 base.
  const resolve = (ref: string): string => {
    const m = /^\s*\{\{(.+?)\}\}\s*$/.exec(ref);
    if (!m) return ref;
    const v = snap.variables.find((x) => x.name === m[1]);
    return v ? String((v.parameter ?? []).find((p) => (p as { key?: string }).key === 'value')?.value ?? '') : '';
  };
  for (const t of snap.tags) {
    if (t.paused) continue; // a paused base tag fires nothing → effectively absent
    if (t.type === 'gaawc') return { name: t.name };
    if (t.type === 'googtag') {
      // G-XXXX (GA4) and GT-XXXX (Google-tag destination group, also configures
      // GA4) qualify; a {{variable}} tagId is resolved to its value first.
      const id = resolve(String(t.parameter.find((p) => (p as { key?: string }).key === 'tagId')?.value ?? ''));
      if (/^G[T]?-/i.test(id)) return { name: t.name };
    }
  }
  return null;
}

/** Decide how the GA4 Measurement-ID variable should be handled before binding a
 *  base tag to {{name}}: 'create' (no such variable), 'reuse' (a Constant of that
 *  name already exists), or 'conflict' (a NON-constant owns the name — binding to
 *  it would misconfigure the tag, so the caller must not proceed silently). PURE. */
export function ga4VariablePlan(snap: ContainerSnapshot, variableName: string): { action: 'create' | 'reuse' | 'conflict'; existingType?: string } {
  const v = snap.variables.find((x) => x.name === variableName);
  if (!v) return { action: 'create' };
  if (v.type === 'c') return { action: 'reuse' };
  return { action: 'conflict', existingType: v.type };
}

export interface GoogleAdsConversionInput {
  name: string;
  conversionId: string; // "AW-123456789" or the bare numeric id
  conversionLabel: string;
  firingTriggerId?: string[];
}
// GTM's awct conversionId is the NUMERIC id only — GTM rejects the "AW-" prefix
// (and a {{variable}} reference is left as-is). Normalize so callers can pass
// either "AW-123456789" or "123456789" and the tag still validates.
export function normalizeAdsConversionId(id: string): string {
  const t = id.trim();
  return t.includes('{{') ? t : t.replace(/^AW-/i, '');
}
export function buildGoogleAdsConversionTag(o: GoogleAdsConversionInput): GtmTagResource {
  return {
    name: o.name,
    type: 'awct',
    parameter: [tpl('conversionId', normalizeAdsConversionId(o.conversionId)), tpl('conversionLabel', o.conversionLabel)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

export interface CustomHtmlInput {
  name: string;
  html: string; // platform snippet (Facebook/LinkedIn/TikTok pixels, etc.)
  firingTriggerId?: string[];
}
export function buildCustomHtmlTag(o: CustomHtmlInput): GtmTagResource {
  return {
    name: o.name,
    type: 'html',
    parameter: [tpl('html', o.html), boolean('supportDocumentWrite', false)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

/* ───────────── Triggers ───────────── */

const FILTER_OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex', 'greater', 'less']);
function condition(variable: string, op: string, value: string): Param {
  return {
    type: FILTER_OPS.has(op) ? op : 'contains',
    parameter: [tpl('arg0', variable), tpl('arg1', value)],
  };
}

export type TriggerKind = 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit' | 'youtube_video';

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
  /** For link_click/all_clicks: also filter on {{Click Text}} (e.g. a CTA). */
  clickTextValue?: string;
  clickTextOperator?: string;
  /** For form_submit: scope to one form via {{Form ID}} / {{Form Classes}}. */
  formIdValue?: string;
  formIdOperator?: string;
  formClassesValue?: string;
  formClassesOperator?: string;
  /** For custom_event: the dataLayer event name. */
  eventName?: string;
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
      if (o.clickUrlValue) filters.push(condition('{{Click URL}}', o.clickUrlOperator ?? 'contains', o.clickUrlValue));
      if (o.clickTextValue) filters.push(condition('{{Click Text}}', o.clickTextOperator ?? 'contains', o.clickTextValue));
      if (filters.length) t.filter = filters;
      return t;
    }
    case 'custom_event':
      return {
        name: sanitizeName(o.name),
        type: 'customEvent',
        customEventFilter: [condition('{{_event}}', 'equals', o.eventName ?? '')],
      };
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
    case 'pageview':
    default:
      return { name: sanitizeName(o.name), type: 'pageview' };
  }
}

/** Built-in variables a trigger needs (so we can auto-enable them). */
export function triggerBuiltInVars(o: TriggerInput): string[] {
  const vars: string[] = [];
  if (o.kind === 'link_click' || o.kind === 'all_clicks') {
    if (o.clickUrlValue) vars.push('clickUrl');
    if (o.clickTextValue) vars.push('clickText');
  }
  if (o.kind === 'form_submit') {
    if (o.formIdValue) vars.push('formId');
    if (o.formClassesValue) vars.push('formClasses');
  }
  // The YouTube Video trigger surfaces the "Video" built-in variables — enable them
  // all so the tag's {{Video Title}}/{{Video Percent}}/… and event-name {{Video
  // Status}} resolve.
  if (o.kind === 'youtube_video') vars.push(...VIDEO_BUILT_IN_VARS);
  return vars;
}

// GTM built-in variable DISPLAY NAME → API `type` key, for the ones a tag's
// event/config parameters commonly reference. Used to auto-enable exactly the
// built-in variables a tag's {{...}} values need (user variables like
// {{GA4 Measurement ID}} are not built-in and are intentionally absent here).
const BUILT_IN_VAR_KEYS: Record<string, string> = {
  'page url': 'pageUrl', 'page hostname': 'pageHostname', 'page path': 'pagePath', 'referrer': 'referrer',
  'click element': 'clickElement', 'click classes': 'clickClasses', 'click id': 'clickId',
  'click target': 'clickTarget', 'click url': 'clickUrl', 'click text': 'clickText',
  'form element': 'formElement', 'form classes': 'formClasses', 'form id': 'formId',
  'form target': 'formTarget', 'form url': 'formUrl', 'form text': 'formText',
  'video provider': 'videoProvider', 'video url': 'videoUrl', 'video title': 'videoTitle',
  'video duration': 'videoDuration', 'video current time': 'videoCurrentTime',
  'video percent': 'videoPercent', 'video status': 'videoStatus', 'video visible': 'videoVisible',
};

/** Built-in variable type keys referenced by {{Name}} tokens in the given values
 *  (e.g. an event parameter value "{{Click Text}}" → "clickText"). Unknown names
 *  (user-defined variables) are skipped. */
export function builtInVarsForTemplates(values: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) {
      const key = BUILT_IN_VAR_KEYS[m[1].trim().toLowerCase()];
      if (key) out.add(key);
    }
  }
  return [...out];
}

/* ───────────── Variables ───────────── */

export type VariableKind = 'constant' | 'data_layer' | 'javascript';
export interface VariableInput {
  name: string;
  kind: VariableKind;
  value?: string; // constant
  dataLayerName?: string; // data_layer
  javascript?: string; // javascript (custom JS)
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
    case 'javascript':
    default:
      return { name: o.name, type: 'jsm', parameter: [tpl('javascript', o.javascript ?? '')] };
  }
}

/* ───────────── Container audit ───────────── */

export interface AuditTag {
  tagId: string;
  name: string;
  type: string;
  firingTriggerId: string[];
  /** Exception/blocking triggers — a trigger listed here IS in use. */
  blockingTriggerId?: string[];
  paused: boolean;
  parameter: Array<Record<string, unknown>>;
  /** Consent Mode v2 settings, when present on the tag. consentType is a
   *  parameter list that may itself reference {{variables}}. */
  consentSettings?: { consentStatus?: string; consentType?: unknown } | null;
}
export interface AuditTrigger {
  triggerId: string;
  name: string;
  type: string;
  /** Condition filters + generic parameters — scanned for {{variable}} references. */
  filter?: Array<Record<string, unknown>>;
  autoEventFilter?: Array<Record<string, unknown>>;
  customEventFilter?: Array<Record<string, unknown>>;
  parameter?: Array<Record<string, unknown>>;
}
export interface AuditVariable {
  variableId: string;
  name: string;
  type: string;
  /** Variable config — scanned for {{variable}} references to other variables. */
  parameter?: Array<Record<string, unknown>>;
}

/**
 * A machine-applicable fix for a finding: call `tool` with `args`. The audit
 * fills the resource id (tagId/triggerId/variableId); the registry injects the
 * workspace ids (accountId/containerId/workspaceId) before returning, so the
 * model can apply the fix in one call once the user approves.
 */
export interface AuditFix {
  tool: string;
  args: Record<string, unknown>;
}
export interface AuditFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Audit Brain confidence: certain = provable from the container; likely = strong
   *  inference needing one cheap confirmation; runtime-required = needs live evidence. */
  confidence: 'certain' | 'likely' | 'runtime-required';
  /** Coarse grouping: firing | paused | ga4 | deprecated | consent | security | performance | unused | naming. */
  category: string;
  message: string;
  /** The GTM resource the finding is about, when it targets one. */
  resource?: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string };
  /** What to change to resolve it (always present, human-readable). */
  recommendation: string;
  /** True when `fix` is a ready-to-run tool call the model can apply on approval. */
  autoFixable: boolean;
  fix?: AuditFix;
}

/** Container-only boundary statement — what a config audit proves and what it cannot. */
export const AUDIT_BOUNDARY =
  'Container-only audit: this proves CONFIGURATION, not runtime behaviour. It cannot confirm firing timing, dataLayer contents, PII in actual hits, or live consent behaviour — verify those in Tag Assistant / Network, GA4 DebugView, and your CMP.';

/** Checks a container export CANNOT settle — surfaced so no one assumes they passed. */
export const AUDIT_RUNTIME_REQUIRED: string[] = [
  'Consent timing — load the site with no prior consent and watch the network: do GA4/Ads requests fire BEFORE the user chooses?',
  'Double-firing — does any event (page_view, purchase, …) appear twice in GA4 DebugView for one interaction?',
  'PII in hits — inspect actual /collect requests for email/phone/name in the page path, query params, or event parameters.',
  'dataLayer reality — do custom-event triggers’ events actually push during the real user journey?',
  'Ecommerce integrity — is the items array well-formed (currency/value) in the collect request?',
  'Cross-domain & server IP — correct linker behaviour, and (server-side) the real client IP rather than the edge IP.',
];

/** Audit Brain confidence per finding category. Most container findings are provable
 *  ('certain'); consent + "unused" are strong inferences whose real impact needs one
 *  confirmation (runtime CMP behaviour / published-version check) → 'likely'. */
function confidenceFor(category: string): AuditFinding['confidence'] {
  if (category === 'consent' || category === 'unused') return 'likely';
  return 'certain';
}

/** Consent types to REQUIRE on a tag with no Consent Mode v2 settings, by its
 *  destination type. Ads/Floodlight need the ad signals; GA4/analytics need
 *  analytics_storage; the Google tag serves both. Drives the one-click consent fix. */
export function consentTypesFor(tagType: string): string[] {
  if (['awct', 'sp', 'gclidw', 'flc', 'fls'].includes(tagType)) {
    return ['ad_storage', 'ad_user_data', 'ad_personalization'];
  }
  if (tagType === 'googtag') return ['analytics_storage', 'ad_storage'];
  return ['analytics_storage'];
}
export interface ContainerSnapshot {
  tags: AuditTag[];
  triggers: AuditTrigger[];
  variables: AuditVariable[];
}
export interface AuditReport {
  counts: { tags: number; triggers: number; variables: number; findings: number };
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  findings: AuditFinding[];
  /** Container-only boundary statement (state it before the findings). */
  boundary: string;
  /** Checks that need live verification (never scored as confirmed defects). */
  runtimeRequired: string[];
  /** True if a GA4/Google base Configuration tag (googtag/gaawc) is present — drives
   *  whether the "Add GA4 base tag" bootstrap is offered (hidden when one exists). */
  hasGa4Config: boolean;
}

// GTM tag types that send data to ad/analytics platforms and therefore should
// declare Consent Mode v2 settings: GA4 event, the Google tag, Google Ads
// conversion/remarketing, Conversion Linker, Floodlight counter/sales, plus the
// major third-party trackers (Microsoft Ads UET, LinkedIn Insight, Hotjar).
// (Grounded in a corpus of 562 real containers — googtag (826) and baut (448)
// were common data-senders the set previously missed.)
const CONSENT_RELEVANT_TYPES = new Set([
  'gaawe', 'googtag', 'awct', 'sp', 'gclidw', 'flc', 'fls', 'baut', 'bzi', 'hjtc',
]);

// consentStatus arrives UPPER_SNAKE in container EXPORT JSON ("NOT_SET") but
// camelCase from the live API ("notSet") — normalize so the audit is identical
// on both. → 'notset' | 'needed' | 'notneeded' | '' (absent/unknown).
export function normConsent(status: unknown): string {
  return typeof status === 'string' ? status.replace(/_/g, '').toLowerCase() : '';
}

// Pull every {{Variable Name}} token out of any nested value into `into`.
const VAR_REF = /\{\{([^}]+)\}\}/g;
function refsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(VAR_REF)) into.add(m[1].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) refsIn(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) refsIn(v, into);
  }
}

export function auditContainer(s: ContainerSnapshot): AuditReport {
  // Built without `confidence`; it's added per-category in one pass at the end.
  const findings: Array<Omit<AuditFinding, 'confidence'>> = [];
  const measurementIds = new Set<string>();

  for (const t of s.tags) {
    const resource = { kind: 'tag' as const, id: t.tagId, name: t.name };

    if (!t.firingTriggerId || t.firingTriggerId.length === 0) {
      findings.push({
        severity: 'high',
        category: 'firing',
        resource,
        message: `Tag "${t.name}" has no firing trigger — it will never fire.`,
        recommendation: 'Attach a firing trigger so the tag can fire (add one in GTM or via create_gtm_tag_with_trigger).',
        autoFixable: false,
      });
    }
    if (t.paused) {
      findings.push({
        severity: 'medium',
        category: 'paused',
        resource,
        message: `Tag "${t.name}" is paused.`,
        recommendation: 'Unpause it if it should be live.',
        autoFixable: true,
        fix: { tool: 'set_gtm_tag_paused', args: { tagId: t.tagId, paused: false, name: t.name } },
      });
    }
    if (t.type === 'gaawe') {
      const midParam = t.parameter.find(
        (p) => (p.key === 'measurementId' || p.key === 'measurementIdOverride') && p.value
      );
      const mid = midParam ? String(midParam.value) : '';
      if (!mid) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" has no measurement ID.`,
          recommendation: 'Set its Measurement ID (a G-XXXXXXX value or a {{GA4 Measurement ID}} variable).',
          autoFixable: false,
        });
      } else if (mid.startsWith('G-')) {
        measurementIds.add(mid);
      }
      const hasEventName = t.parameter.some((p) => p.key === 'eventName' && p.value);
      if (!hasEventName) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" has no event name.`,
          recommendation: 'Set the GA4 event name (e.g. "purchase", "generate_lead", "page_view").',
          autoFixable: false,
        });
      }
    }
    if (t.type === 'googtag') {
      // The Google tag loads gtag.js and configures GA4/Ads — it needs a tag ID
      // (G-/AW-/GT-…). (Corpus: googtag is the 4th-most-common tag type, 826.)
      const hasTagId = t.parameter.some((p) => (p.key === 'tagId' || p.key === 'tag_id') && p.value);
      if (!hasTagId) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `Google tag "${t.name}" has no tag ID — it can't configure GA4/Ads.`,
          recommendation: 'Set its Tag ID (a G-XXXXXXX / AW-XXXXXX / GT-XXXXXX value or a {{variable}}).',
          autoFixable: false,
        });
      }
    }
    if (t.type === 'ua') {
      // Universal Analytics: 758 such tags in the corpus, all now inert.
      findings.push({
        severity: 'medium',
        category: 'deprecated',
        resource,
        message: `Tag "${t.name}" is a Universal Analytics tag — UA stopped collecting data on 1 July 2023, so it reports nothing and only adds page weight.`,
        recommendation: 'Remove it, or migrate the measurement to a GA4 event tag (gaawe) or the Google tag (googtag).',
        autoFixable: false,
      });
    }
    if (t.type === 'html') {
      findings.push({
        severity: 'info',
        category: 'security',
        resource,
        message: `Tag "${t.name}" is Custom HTML — review the snippet for security/PII.`,
        recommendation: 'Prefer a native template where one exists; ensure the HTML contains no secrets or unvetted third-party script.',
        autoFixable: false,
      });
      const htmlParam = t.parameter.find((p) => p.key === 'html');
      if (htmlParam && /document\.write/.test(String(htmlParam.value))) {
        findings.push({
          severity: 'medium',
          category: 'performance',
          resource,
          message: `Custom HTML tag "${t.name}" uses document.write — it can block rendering.`,
          recommendation: 'Replace document.write with DOM insertion, or enable "Support document.write" only if truly required.',
          autoFixable: false,
        });
      }
    }
    // Consent Mode v2: ad/analytics tags should declare their consent. Only the
    // 'notSet' (or absent) state is unconfigured — 'needed' and the deliberate
    // 'notNeeded' are both valid, configured choices and must NOT be flagged.
    if (CONSENT_RELEVANT_TYPES.has(t.type)) {
      const status = normConsent(t.consentSettings?.consentStatus);
      if (!status || status === 'notset') {
        findings.push({
          severity: 'high',
          category: 'consent',
          resource,
          message: `Tag "${t.name}" has no Consent Mode v2 settings (consent status is not set).`,
          recommendation: 'In the tag\'s "Consent Settings", declare the consent types it requires (e.g. ad_storage, analytics_storage), or "No additional consent required" if it genuinely needs none. "Apply fix" requires the consent types for this tag type.',
          autoFixable: true,
          fix: {
            tool: 'set_gtm_tag_consent',
            args: { tagId: t.tagId, consentStatus: 'needed', consentTypes: consentTypesFor(t.type), name: t.name },
          },
        });
      }
    }
  }

  if (measurementIds.size > 1) {
    findings.push({
      severity: 'medium',
      category: 'ga4',
      message: `Multiple GA4 measurement IDs are in use (${[...measurementIds].join(', ')}).`,
      recommendation: 'Confirm this is intentional; most setups send to one property, ideally via a single {{GA4 Measurement ID}} variable.',
      autoFixable: false,
    });
  }

  // Unused triggers — referenced by no tag as either a FIRING or a BLOCKING
  // (exception) trigger. Both link a tag to a trigger, so both count as "used".
  const usedTriggers = new Set(
    s.tags.flatMap((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])])
  );
  for (const tr of s.triggers) {
    if (!usedTriggers.has(tr.triggerId)) {
      findings.push({
        severity: 'low',
        category: 'unused',
        resource: { kind: 'trigger', id: tr.triggerId, name: tr.name },
        message: `Trigger "${tr.name}" isn't used by any tag.`,
        recommendation: 'Delete it if it is not needed — unused triggers add clutter and unnecessary listeners.',
        autoFixable: true,
        fix: { tool: 'delete_gtm_trigger', args: { triggerId: tr.triggerId, name: tr.name } },
      });
    }
  }

  // Unused variables — referenced by no tag, trigger, or other variable. We scan
  // every {{variable}}-bearing field we capture (tag parameters + consentSettings,
  // all trigger filters + generic parameters, variable parameters). This is
  // ADVISORY ONLY (no auto-fix): the workspace snapshot can't see published
  // versions, and GTM has more variable-bearing fields than we capture, so a
  // "no references found" result is a strong hint — not proof — that a variable
  // is safe to delete. Deleting is left to the user via delete_gtm_variable.
  const refs = new Set<string>();
  for (const t of s.tags) {
    refsIn(t.parameter, refs);
    refsIn(t.consentSettings?.consentType, refs);
  }
  for (const tr of s.triggers) {
    refsIn(tr.filter, refs);
    refsIn(tr.autoEventFilter, refs);
    refsIn(tr.customEventFilter, refs);
    refsIn(tr.parameter, refs);
  }
  for (const v of s.variables) refsIn(v.parameter, refs);
  for (const v of s.variables) {
    if (!refs.has(v.name)) {
      findings.push({
        severity: 'low',
        category: 'unused',
        resource: { kind: 'variable', id: v.variableId, name: v.name },
        message: `Variable "${v.name}" appears unused — no tag, trigger, or variable in this workspace references it.`,
        recommendation: 'Review it in GTM and delete it (delete_gtm_variable) if truly unused — first confirm it is not relied on by a published version or a field this audit does not inspect.',
        autoFixable: false,
      });
    }
  }

  // Duplicate names.
  const dupes = (
    items: Array<{ name: string }>,
    severity: AuditFinding['severity'],
    noun: string
  ): void => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
    for (const [name, count] of counts) {
      if (count > 1) {
        findings.push({
          severity,
          category: 'naming',
          message: `Duplicate ${noun} name "${name}" (${count} ${noun}s).`,
          recommendation: `Rename or remove duplicates so each ${noun} is uniquely identifiable.`,
          autoFixable: false,
        });
      }
    }
  };
  dupes(s.tags, 'medium', 'tag');
  dupes(s.triggers, 'low', 'trigger');

  // Add the Audit Brain confidence to each finding in one pass.
  const withConfidence: AuditFinding[] = findings.map((f) => ({ ...f, confidence: confidenceFor(f.category) }));

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of withConfidence) summary[f.severity]++;

  return {
    counts: {
      tags: s.tags.length,
      triggers: s.triggers.length,
      variables: s.variables.length,
      findings: withConfidence.length,
    },
    summary,
    findings: withConfidence,
    boundary: AUDIT_BOUNDARY,
    runtimeRequired: AUDIT_RUNTIME_REQUIRED,
    hasGa4Config: s.tags.some((t) => t.type === 'googtag' || t.type === 'gaawc'),
  };
}
