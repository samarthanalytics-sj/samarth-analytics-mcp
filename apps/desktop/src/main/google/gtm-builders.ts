// Pure builders that construct valid Google Tag Manager API v2 resources from
// simple inputs, so the LLM supplies fields and OUR code guarantees the correct
// shape (type codes, parameter keys, the eventSettingsTable list-of-maps keyed
// parameter/parameterValue, etc.). No I/O — fully unit-testable.

import { classifyPixel } from './pixel-signatures';

type Param = Record<string, unknown>;
const tpl = (key: string, value: string): Param => ({ type: 'template', key, value });
/** A template Parameter for a DEDICATED top-level Trigger field (e.g. interval, eventName) —
 *  no `key`, unlike entries in a `parameter[]` array. */
const namedParam = (value: string): Param => ({ type: 'template', value });
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

/**
 * Build the GTM install snippet for an ENVIRONMENT — the normal container snippet plus the
 * environment's gtm_auth (authorizationCode), gtm_preview (env-<environmentId>) and
 * gtm_cookies_win params. `publicId` is the GTM-XXXXXX container id. Returns the <head>
 * script and the <body> noscript. Pure / testable.
 */
export function buildEnvironmentSnippet(
  publicId: string,
  authorizationCode: string,
  environmentId: string
): { head: string; body: string } {
  const params = `&gtm_auth=${authorizationCode}&gtm_preview=env-${environmentId}&gtm_cookies_win=x`;
  const head =
    '<!-- Google Tag Manager -->\n' +
    "<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\n" +
    "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\n" +
    "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n" +
    `'https://www.googletagmanager.com/gtm.js?id='+i+dl+'${params}';\n` +
    "f.parentNode.insertBefore(j,f);\n" +
    `})(window,document,'script','dataLayer','${publicId}');</script>\n` +
    '<!-- End Google Tag Manager -->';
  const body =
    '<!-- Google Tag Manager (noscript) -->\n' +
    `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${publicId}${params}"\n` +
    'height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>\n' +
    '<!-- End Google Tag Manager (noscript) -->';
  return { head, body };
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

/** Upsert a Google-tag config setting (e.g. server_container_url for server-side tagging)
 *  in the tag's configSettingsTable, preserving every other setting. Returns a NEW
 *  parameter[] (read-modify-write safe). PURE / testable. */
export function upsertGoogleTagConfig(tag: Record<string, unknown>, configKey: string, value: string): Param[] {
  const params: Param[] = Array.isArray(tag.parameter) ? (tag.parameter as Param[]).map((p) => ({ ...p })) : [];
  let idx = params.findIndex((p) => (p as { key?: unknown }).key === 'configSettingsTable');
  if (idx < 0) {
    params.push({ type: 'list', key: 'configSettingsTable', list: [] });
    idx = params.length - 1;
  }
  const table = { ...(params[idx] as { type?: string; key?: string; list?: Param[] }) };
  const list: Param[] = Array.isArray(table.list) ? table.list.map((m) => ({ ...m })) : [];
  const entry: Param = { type: 'map', map: [tpl('parameter', configKey), tpl('parameterValue', value)] };
  const at = list.findIndex((m) => {
    const map = ((m as { map?: Param[] }).map ?? []) as Param[];
    return map.some((kv) => (kv as { key?: unknown }).key === 'parameter' && (kv as { value?: unknown }).value === configKey);
  });
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  table.list = list;
  params[idx] = table;
  return params;
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

/* ───────────── Server-side GTM (sGTM) ───────────── */

/** A server-container Client resource (claims incoming requests). */
export interface GtmClientResource {
  name: string;
  type: string;
  parameter?: Param[];
  priority?: number;
}

/** The GA4 client (`gaaw_client`) — claims incoming GA4 / gtag requests on a server
 *  container so server tags can read the event. Shape corpus-validated (3 server
 *  containers). `activateDefaultPaths` claims the standard /g/collect endpoints. */
export function buildGa4Client(name: string): GtmClientResource {
  return {
    name: sanitizeName(name),
    type: 'gaaw_client',
    parameter: [boolean('activateDefaultPaths', true), boolean('activateGtagSupport', true)],
  };
}

/** A server-side GA4 tag (`sgtmgaaw`) — forwards the event the client received on to GA4.
 *  Shape corpus-validated. eventName is OMITTED when not given so GTM inherits the incoming
 *  event's event_name (per Google/Stape docs — a blank Event Name relays whatever arrived;
 *  this also avoids depending on the {{Event Name}} built-in being enabled). Pass a literal
 *  (e.g. "purchase") for a per-event tag. ep/upToIncludeDropdown='all' forwards all event +
 *  user parameters. */
export function buildGa4ServerTag(name: string, measurementId: string, eventName?: string, firingTriggerId?: string[]): GtmTagResource {
  const parameter: Param[] = [];
  if (eventName && eventName.trim() !== '') parameter.push(tpl('eventName', eventName));
  parameter.push(tpl('measurementId', measurementId), tpl('epToIncludeDropdown', 'all'), tpl('upToIncludeDropdown', 'all'));
  return {
    name: sanitizeName(name),
    type: 'sgtmgaaw',
    ...(firingTriggerId ? { firingTriggerId } : {}),
    parameter,
  };
}

/** A server "All Events" Custom Event trigger — fires on every event a client produces
 *  ({{_event}} matches `.*`). Shape corpus-validated (server triggers are CUSTOM_EVENT with a
 *  customEventFilter on {{_event}}). Needs no built-in variable. This is the firing trigger
 *  for a forward-all GA4 server tag. PURE. */
export function buildServerAllEventsTrigger(name: string): GtmTriggerResource {
  return {
    name: sanitizeName(name),
    type: 'customEvent',
    customEventFilter: [condition('{{_event}}', 'matchRegex', '.*')],
  };
}

/** Server-side Google Ads CONVERSION tag (`sgtmadsct`). Shape corpus-validated. Reads the
 *  conversion value/currency from the event the client received; conversionId is the AW-
 *  account id, conversionLabel the per-conversion label (both may be {{variables}}). */
export function buildAdsConversionServerTag(name: string, conversionId: string, conversionLabel: string, firingTriggerId?: string[]): GtmTagResource {
  return {
    name: sanitizeName(name),
    type: 'sgtmadsct',
    parameter: [
      tpl('conversionId', conversionId),
      tpl('conversionLabel', conversionLabel),
      boolean('enableConversionLinker', true),
      tpl('productReportingDataSource', 'EVENT'),
      boolean('enableProductReporting', true),
      boolean('rdp', false),
    ],
    ...(firingTriggerId ? { firingTriggerId } : {}),
  };
}

/** Server-side Google Ads CONVERSION LINKER tag (`sgtmadscl`). Shape corpus-validated.
 *  Reads/sets the linker (gclid etc.) on the server. */
export function buildAdsConversionLinkerServerTag(name: string, firingTriggerId?: string[]): GtmTagResource {
  return {
    name: sanitizeName(name),
    type: 'sgtmadscl',
    parameter: [boolean('enableLinkerParams', false), boolean('enableCookieOverrides', false)],
    ...(firingTriggerId ? { firingTriggerId } : {}),
  };
}

/** Server-side Google Ads REMARKETING tag (`sgtmadsremarket`). Shape corpus-validated.
 *  Dynamic remarketing reads item data from the event; conversionId is the AW- id. */
export function buildAdsRemarketingServerTag(name: string, conversionId: string, firingTriggerId?: string[]): GtmTagResource {
  return {
    name: sanitizeName(name),
    type: 'sgtmadsremarket',
    parameter: [
      tpl('conversionId', conversionId),
      boolean('enableConversionLinker', true),
      boolean('enableDynamicRemarketing', true),
      tpl('remarketingEventDataSource', 'EVENT_DATA'),
      boolean('rdp', false),
    ],
    ...(firingTriggerId ? { firingTriggerId } : {}),
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

/** The dataLayer event a Custom Event trigger fires on — the arg1 of the {{_event}}
 *  condition in customEventFilter (e.g. "product_view"). '' if not a custom-event trigger. */
export function customEventNameOf(trigger: Record<string, unknown>): string {
  const cef = (trigger as { customEventFilter?: unknown }).customEventFilter;
  if (!Array.isArray(cef)) return '';
  for (const cond of cef) {
    const params = (cond as { parameter?: unknown }).parameter;
    if (!Array.isArray(params)) continue;
    let onEvent = false;
    let val = '';
    for (const p of params) {
      const k = (p as { key?: unknown }).key;
      const v = (p as { value?: unknown }).value;
      if (k === 'arg0' && String(v ?? '') === '{{_event}}') onEvent = true;
      if (k === 'arg1') val = String(v ?? '');
    }
    if (onEvent && val) return val;
  }
  return '';
}

/** Find an EXISTING trigger that the proposed one would duplicate — matched by name
 *  (case-insensitive) OR, for Custom Event triggers, by the SAME dataLayer event. Lets the
 *  create tools reuse it (and skip the approval) instead of making a duplicate. PURE. */
export function findExistingTrigger(
  existing: Array<{ triggerId: string; name: string; type?: string; customEventName?: string }>,
  proposed: { name?: string; type?: string; customEventName?: string }
): { triggerId: string; name: string } | undefined {
  const pName = (proposed.name ?? '').trim().toLowerCase();
  const pEvent = (proposed.customEventName ?? '').trim();
  const pIsCustomEvent = (proposed.type ?? '') === 'customEvent';
  return existing.find(
    (e) =>
      (pName !== '' && e.name.trim().toLowerCase() === pName) ||
      (pIsCustomEvent && pEvent !== '' && e.type === 'customEvent' && (e.customEventName ?? '') === pEvent)
  );
}

export type TriggerKind = 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit' | 'youtube_video' | 'timer';

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
    case 'pageview':
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
export function normalizeTimerTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  if (String((trigger as { type?: unknown }).type ?? '') !== 'timer') return trigger;
  const out: Record<string, unknown> = { ...trigger };
  const params = Array.isArray(out.parameter) ? [...(out.parameter as Param[])] : [];
  // Resolve a value for `field` from: a top-level Parameter object, a top-level raw string,
  // or a parameter[] entry keyed `field`.
  const resolve = (field: string): string | undefined => {
    const top = out[field];
    if (top != null && typeof top === 'object') {
      const v = (top as { value?: unknown }).value;
      if (v != null && String(v) !== '') return String(v);
    } else if (top != null && String(top) !== '') {
      return String(top);
    }
    const p = params.find((x) => (x as { key?: unknown }).key === field) as { value?: unknown } | undefined;
    return p && p.value != null && String(p.value) !== '' ? String(p.value) : undefined;
  };
  const eventName = resolve('eventName') ?? 'gtm.timer';
  const interval = resolve('interval');
  const limit = resolve('limit');
  // Timer settings live at the TOP LEVEL — strip any stray copies from parameter[].
  const others = params.filter((x) => !['eventName', 'interval', 'limit'].includes(String((x as { key?: unknown }).key ?? '')));
  if (others.length) out.parameter = others;
  else delete out.parameter;
  out.eventName = namedParam(eventName);
  if (interval !== undefined) out.interval = namedParam(interval);
  else delete out.interval;
  if (limit !== undefined) out.limit = namedParam(limit);
  else delete out.limit;
  return out;
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

export type VariableKind = 'constant' | 'data_layer' | 'javascript' | 'event_data';
export interface VariableInput {
  name: string;
  kind: VariableKind;
  value?: string; // constant
  dataLayerName?: string; // data_layer
  javascript?: string; // javascript (custom JS)
  keyPath?: string; // event_data (server) — the event-data key to read, e.g. "items" or "x-ga-mp1-x"
  defaultValue?: string; // event_data — value when the key is absent (sets setDefaultValue true)
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
    case 'javascript':
    default:
      return { name: o.name, type: 'jsm', parameter: [tpl('javascript', o.javascript ?? '')] };
  }
}

/** Server "Allow parameters" transformation (`tf_allow_params`) — keeps ONLY the listed
 *  event parameters (drops the rest, e.g. to strip PII before tags run). Shape corpus-
 *  validated: an allowedParamsTable list of {allowedParams} maps. PURE. */
export function buildAllowParamsTransformation(name: string, allowedParams: string[]): Record<string, unknown> {
  return {
    name: sanitizeName(name),
    type: 'tf_allow_params',
    parameter: [
      boolean('matchingConditionsEnabled', false),
      {
        type: 'list',
        key: 'allowedParamsTable',
        list: allowedParams.map((p) => ({ type: 'map', map: [tpl('allowedParams', p)] })),
      },
    ],
  };
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
   *  inference needing one cheap confirmation; runtime-required = needs live evidence;
   *  guessing = a low-confidence heuristic match (never scored). */
  confidence: 'certain' | 'likely' | 'runtime-required' | 'guessing';
  /** Stable per-check identifier. Combined with the resource id it forms a finding's
   *  identity, so the same check never emits twice for the same tag/variable (dedup). */
  checkId?: string;
  /** Coarse grouping: firing | paused | ga4 | deprecated | consent | security | performance | unused | naming. */
  category: string;
  message: string;
  /** The GTM resource the finding is about, when it targets one. */
  resource?: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string; type?: string };
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
  counts: { tags: number; triggers: number; variables: number; findings: number; clients?: number; transformations?: number };
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

// B6 consent-gate evaluation. An advertising pixel in Custom HTML has NO built-in Consent
// Mode — it fires by raw <script> unless an explicit additional-consent check is declared.
// We read the tag's declared consent and decide whether that gate is valid for the network.
//
// Regions whose privacy law makes an ungated ad pixel a Consent Mode v2 / GDPR exposure.
const RISK_REGIONS = ['EU', 'UK', 'AU'];

export type ConsentGate =
  | 'gated' // status 'needed' AND ad_storage declared (and all required types) — VALID, no finding
  | 'partial' // gated on ad_storage but missing some required ad types
  | 'wrong_types' // status 'needed' but ad_storage NOT among the declared types
  | 'ungated' // status 'notSet'/absent — no additional consent check at all
  | 'declared_no_consent'; // status 'notNeeded' — explicitly declared as needing none

/** Lowercased consent-type values declared on a tag (consentType.list[].value, or a bare array). */
export function configuredConsentTypes(consentSettings: AuditTag['consentSettings']): string[] {
  const ct = consentSettings?.consentType as unknown;
  const list = Array.isArray(ct)
    ? ct
    : ct && typeof ct === 'object' && Array.isArray((ct as { list?: unknown[] }).list)
      ? (ct as { list: unknown[] }).list
      : [];
  return list
    .map((e) => (e && typeof e === 'object' ? (e as { value?: unknown }).value : e))
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.toLowerCase());
}

/** Evaluate the consent gate on a tag against the network's required consent types. */
export function evaluateConsentGate(
  consentSettings: AuditTag['consentSettings'],
  requiredConsent: string[]
): ConsentGate {
  const status = normConsent(consentSettings?.consentStatus); // '' | 'notset' | 'needed' | 'notneeded'
  const configured = configuredConsentTypes(consentSettings);
  if (status === 'needed') {
    if (configured.includes('ad_storage')) {
      return requiredConsent.every((rc) => configured.includes(rc)) ? 'gated' : 'partial';
    }
    return 'wrong_types';
  }
  if (status === 'notneeded') return 'declared_no_consent';
  return 'ungated'; // 'notset' or absent
}

// GA4 Enhanced Measurement auto-tracks these — a manual tag for them double-counts unless
// EM is off (A11). Lowercased for comparison.
const ENHANCED_MEASUREMENT_EVENTS = new Set([
  'page_view', 'scroll', 'click', 'view_search_results', 'file_download',
  'video_start', 'video_progress', 'video_complete', 'form_start', 'form_submit',
]);

// Known GTM tag-type codes (section 4 is documentation; this is the runtime registry). A
// type that is neither here nor a custom template (`cvt_…`) is flagged for manual review
// rather than skipped, so a new/vendor tag never passes unaudited. `isKnownTagType` is
// exported so the registry has one source of truth.
const KNOWN_TAG_TYPES = new Set([
  'googtag', 'gaawc', 'gaawe', 'awct', 'sp', 'gclidw', 'html', 'img', 'ua',
  'flc', 'fls', 'baut', 'bzi', 'hjtc', 'awcr', 'gclidw',
]);
export function isKnownTagType(type: string): boolean {
  return KNOWN_TAG_TYPES.has(type) || type.startsWith('cvt_');
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

export function auditContainer(s: ContainerSnapshot, opts?: { clientRegion?: string[] }): AuditReport {
  // Built with confidence OPTIONAL — most get it per-category at the end, but a finding
  // may set its own (e.g. B6 ad-pixel-without-consent is [Certain], not the [Likely]
  // the general consent check gets).
  const findings: Array<Omit<AuditFinding, 'confidence'> & { confidence?: AuditFinding['confidence'] }> = [];
  // Client region drives B6 severity. Default to UK/EU — the higher-risk assumption that
  // matches the client base — so an ungated ad pixel is Critical unless told otherwise.
  const regions = (opts?.clientRegion && opts.clientRegion.length ? opts.clientRegion : ['UK', 'EU']).map((r) =>
    String(r).toUpperCase()
  );
  const riskRegions = regions.filter((r) => RISK_REGIONS.includes(r));
  const measurementIds = new Set<string>();
  // The exact Measurement/Tag IDs (variable tokens AND hardcoded ids) that Google /
  // Configuration tags declare. GTM matches an event tag's id against THESE specifically —
  // if it matches, "Google tag found in this container"; if not, "Cannot detect the Google
  // tag". (e.g. an event tag on {{GA4 Variable}} is NOT covered by a config tag that uses
  // {{GA4 Measurement ID}} — different tokens, so GTM warns.)
  const googleTagIds = new Set<string>();
  for (const t of s.tags) {
    if (t.type === 'googtag') {
      const v = t.parameter.find((p) => (p.key === 'tagId' || p.key === 'tag_id') && p.value)?.value;
      if (v) googleTagIds.add(String(v));
    } else if (t.type === 'gaawc') {
      const v = t.parameter.find((p) => p.key === 'measurementId' && p.value)?.value;
      if (v) googleTagIds.add(String(v));
    }
  }

  for (const t of s.tags) {
    const resource = { kind: 'tag' as const, id: t.tagId, name: t.name };

    // Section 4: a tag whose type isn't in the registry is flagged for manual review, never
    // skipped silently — otherwise a new vendor tag passes unaudited.
    if (t.type && !isKnownTagType(t.type)) {
      findings.push({
        severity: 'low',
        confidence: 'likely',
        category: 'security',
        resource,
        message: `Tag "${t.name}" has an unrecognised type "${t.type}" — not in the audit's tag-type registry, so its type-specific checks were skipped.`,
        recommendation: 'Review this tag manually; if it is a legitimate new/vendor tag type, add it to the registry so future audits cover it.',
        autoFixable: false,
      });
    }

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
      // D1: a paused tag is Low on its own, BUT a paused conversion (awct) or GA4/Google
      // CONFIG tag (googtag/gaawc) is likely a tracking gap nobody noticed — escalate.
      const keyPaused = t.type === 'awct' || t.type === 'googtag' || t.type === 'gaawc';
      findings.push({
        severity: keyPaused ? 'high' : 'low',
        category: 'paused',
        resource,
        message: keyPaused
          ? `Tag "${t.name}" is PAUSED — and it is a ${t.type === 'awct' ? 'conversion' : 'GA4/Google config'} tag, so this likely means tracking is silently off.`
          : `Tag "${t.name}" is paused.`,
        recommendation: keyPaused
          ? 'Unpause it if it should be live; if it is paused deliberately, confirm that — a paused conversion/config tag stops data collection with nothing else signalling it.'
          : 'Unpause it if it should be live.',
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
      } else if (mid.includes('{{') && !googleTagIds.has(mid)) {
        // A8 / "Cannot detect the Google tag": the event tag's variable Measurement ID is
        // declared by NO Google/Configuration tag in this container, so GTM cannot match
        // it. A variable id is best practice, not a defect — but this specific id isn't
        // covered, so flag it runtime-required (never scored): confirm a Google tag loads
        // for it. (When a config tag DOES use the same id → "Google tag found" → suppressed.)
        findings.push({
          severity: 'high',
          confidence: 'likely',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" uses a variable Measurement ID (${mid}) that NO Google/Configuration tag in this container declares — GTM shows "Cannot detect the Google tag", so these events may not be collected.`,
          recommendation: `Point this tag at the Measurement ID your Google/Configuration tag uses, or add a Google tag for ${mid}. Then confirm on a live load (Tag Assistant / GA4 DebugView) that ${mid} resolves to a valid G-XXXXXXX id.`,
          autoFixable: false,
        });
      }
      const eventNameParam = t.parameter.find((p) => p.key === 'eventName' && p.value);
      const eventName = eventNameParam ? String(eventNameParam.value) : '';
      if (!eventName) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" has no event name.`,
          recommendation: 'Set the GA4 event name (e.g. "purchase", "generate_lead", "page_view").',
          autoFixable: false,
        });
      } else if (ENHANCED_MEASUREMENT_EVENTS.has(eventName.toLowerCase())) {
        // A11: GA4 Enhanced Measurement auto-tracks these, so a manual tag double-counts
        // UNLESS EM is off for it — and EM state lives on the web stream, not the
        // container, so this is a [Likely] cross-check, not a verdict.
        findings.push({
          severity: 'medium',
          confidence: 'likely',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" sends "${eventName}", which GA4 Enhanced Measurement also auto-tracks — this double-counts unless Enhanced Measurement is off for it.`,
          recommendation: `On the GA4 web stream, check whether Enhanced Measurement tracks "${eventName}"; if so, turn off either the EM toggle or this manual tag — not both.`,
          autoFixable: false,
        });
      }
    }
    if (t.type === 'googtag') {
      // The Google tag loads gtag.js and configures GA4/Ads — it needs a tag ID
      // (G-/AW-/GT-…). (Corpus: googtag is the 4th-most-common tag type, 826.)
      const idParam = t.parameter.find((p) => (p.key === 'tagId' || p.key === 'tag_id') && p.value);
      const id = idParam ? String(idParam.value) : '';
      if (!id) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `Google tag "${t.name}" has no tag ID — it can't configure GA4/Ads.`,
          recommendation: 'Set its Tag ID (a G-XXXXXXX / AW-XXXXXX / GT-XXXXXX value or a {{variable}}).',
          autoFixable: false,
        });
      }
      // A {{variable}} Tag ID on the Google tag itself is fine — GTM does not show the
      // "Cannot detect" warning on the source tag, so it is NOT flagged.
    }
    if (t.type === 'awct') {
      // A8: a Google Ads conversion tag with no Conversion ID/Label tracks nothing —
      // it looks active but sends no conversion. (A {{variable}} value is fine, not flagged.)
      const hasConvId = t.parameter.some((p) => (p.key === 'conversionId' || p.key === 'conversionLabel') && p.value);
      if (!hasConvId) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `Google Ads conversion tag "${t.name}" has no Conversion ID/Label — it records no conversions.`,
          recommendation: 'Set the Conversion ID (AW-XXXXXX) and Conversion Label from the Google Ads conversion action.',
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
      // Generic security/PII note — the SECONDARY note on the tag (the B6 pixel finding,
      // when present, is the headline and outranks it by severity).
      findings.push({
        severity: 'info',
        category: 'security',
        checkId: 'html-review',
        resource,
        message: `Tag "${t.name}" is Custom HTML — review the snippet for security/PII.`,
        recommendation: 'Prefer a native template where one exists; ensure the HTML contains no secrets or unvetted third-party script.',
        autoFixable: false,
      });
      const htmlParam = t.parameter.find((p) => p.key === 'html');
      const snippet = htmlParam ? String(htmlParam.value) : '';
      if (/document\.write/.test(snippet)) {
        findings.push({
          severity: 'medium',
          category: 'performance',
          checkId: 'html-document-write',
          resource,
          message: `Custom HTML tag "${t.name}" uses document.write — it can block rendering.`,
          recommendation: 'Replace document.write with DOM insertion, or enable "Support document.write" only if truly required.',
          autoFixable: false,
        });
      }
      // B6: classify the snippet (strong/weak signals, externalized registry), then evaluate
      // its consent gate. Custom HTML has no built-in Consent Mode, so the gate must be an
      // explicit additional-consent check. The container PROVES no valid gate is configured
      // ([Certain]); whether it actually fires before consent stays runtime-required.
      const match = snippet ? classifyPixel(snippet) : ({ classification: 'not_a_pixel' } as const);
      if (match.classification === 'advertising_pixel' && match.network && match.requiredConsent) {
        const network = match.network;
        const required = match.requiredConsent;
        const gate = evaluateConsentGate(t.consentSettings, required);
        // False-positive guard: a correctly gated pixel is correct behaviour — emit nothing.
        if (gate === 'partial') {
          const missing = required.filter((rc) => !configuredConsentTypes(t.consentSettings).includes(rc));
          findings.push({
            severity: 'medium',
            confidence: 'certain',
            category: 'consent',
            checkId: 'B6-ad-pixel-consent',
            resource,
            message: `${network} advertising pixel "${t.name}" is consent-gated but its declaration is incomplete — missing ${missing.join(', ')}. Consent Mode v2 expects all of ${required.join(', ')} for ${network}.`,
            recommendation: `Add ${missing.join(', ')} to the tag's Consent Settings (additional consent required) so ${network} only fires with full advertising consent.`,
            autoFixable: true,
            fix: {
              tool: 'set_gtm_tag_consent',
              args: { tagId: t.tagId, consentStatus: 'needed', consentTypes: required, name: t.name },
            },
          });
        } else if (gate !== 'gated') {
          // ungated | wrong_types | declared_no_consent — no valid gate exists.
          const regionRisk = riskRegions.length > 0;
          const regionLabel = regionRisk ? riskRegions.join('/') : 'this';
          const why =
            gate === 'declared_no_consent'
              ? 'It is built as Custom HTML and explicitly declared as needing NO consent (consentStatus "notNeeded")'
              : gate === 'wrong_types'
                ? 'It is built as Custom HTML and requires consent, but not the advertising types (ad_storage is not declared)'
                : 'It is built as Custom HTML with consentStatus "notSet"';
          findings.push({
            severity: regionRisk ? 'critical' : 'high',
            confidence: 'certain',
            category: 'consent',
            checkId: 'B6-ad-pixel-consent',
            resource,
            message: `${network} advertising pixel "${t.name}" fires without a consent gate. ${why}, so it runs on every load regardless of consent, drops advertising cookies, and sends user data to ${network}. On a ${regionLabel} site this is a Consent Mode v2 / GDPR exposure.`,
            recommendation: `Best: replace the raw snippet with a consent-aware ${network} community template that integrates Consent Mode. Otherwise add an additional consent check requiring ${required.join(', ')} under the tag's Consent Settings. Long term, route server-side and gate at the server. (A Custom HTML gate is binary — no cookieless fallback.)`,
            autoFixable: true,
            fix: {
              tool: 'set_gtm_tag_consent',
              args: { tagId: t.tagId, consentStatus: 'needed', consentTypes: required, name: t.name },
            },
          });
        }
      } else if (match.classification === 'possible_pixel_review' || match.classification === 'opaque_review') {
        // A domain seen with no clear init, or an unreadable injected script — review, not a
        // scored failure. NOT passed as clean.
        const detail =
          match.classification === 'opaque_review'
            ? "injects an external script this audit can't read"
            : `references ${match.network ?? 'an ad network'}'s domain but shows no clear pixel initialisation`;
        findings.push({
          severity: 'info',
          confidence: 'guessing',
          category: 'consent',
          checkId: 'B6-ad-pixel-review',
          resource,
          message: `Custom HTML tag "${t.name}" ${detail} — it may be an advertising pixel that needs a consent gate.`,
          recommendation: 'Open the snippet: if it loads an ad/marketing pixel, gate it with an additional consent check (e.g. ad_storage, ad_user_data) or replace it with a consent-aware template. Confirm on a live load whether it fires before consent.',
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
  // C5: Custom JavaScript variables (jsm) run wherever referenced — not on a trigger — so
  // they execute broadly and are a wider risk surface than a Custom HTML tag.
  // Unused-vs-risk precedence: an UNUSED jsm variable runs nowhere, so it cannot be a
  // runtime risk surface — suppress the C5 finding and let the unused-cleanup finding win.
  for (const v of s.variables) {
    if (v.type === 'jsm' && refs.has(v.name)) {
      findings.push({
        severity: 'medium',
        confidence: 'likely',
        category: 'security',
        checkId: 'C5-custom-js-variable',
        resource: { kind: 'variable', id: v.variableId, name: v.name },
        message: `Custom JavaScript variable "${v.name}" runs arbitrary JS wherever it is referenced — a wider risk surface than a Custom HTML tag.`,
        recommendation: 'Review its code for DOM scraping, cookie/PII reads, external calls, and unguarded paths that return undefined (which poisons every tag that consumes it). Prefer a built-in or template variable where possible.',
        autoFixable: false,
      });
    }
  }
  for (const v of s.variables) {
    if (!refs.has(v.name)) {
      findings.push({
        severity: 'low',
        category: 'unused',
        checkId: 'unused-variable',
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

  // Dedup by finding identity = checkId + resource id (spec §7). The message is included so
  // two DIFFERENT checks on the same resource never collapse — only a true repeat of the
  // same check on the same resource is dropped.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.checkId ?? f.category}::${f.resource?.id ?? ''}::${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Enrich each finding's resource with its GTM type code (gaawe/googtag/html/…) so the UI
  // can filter findings — and scope batch fixes — by tag type.
  const typeById = new Map<string, string>();
  for (const t of s.tags) typeById.set(`tag:${t.tagId}`, t.type);
  for (const tr of s.triggers) typeById.set(`trigger:${tr.triggerId}`, tr.type);
  for (const v of s.variables) typeById.set(`variable:${v.variableId}`, v.type);

  // Add the Audit Brain confidence + resource type to each finding in one pass.
  const withConfidence: AuditFinding[] = deduped.map((f) => ({
    ...f,
    confidence: f.confidence ?? confidenceFor(f.category),
    resource: f.resource ? { ...f.resource, type: typeById.get(`${f.resource.kind}:${f.resource.id}`) } : f.resource,
  }));

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

/* ───────────── Server-container audit (sGTM) ───────────── */

export interface ServerContainerSnapshot {
  /** The container's tagging server URL(s) — empty if the host isn't provisioned yet. */
  taggingServerUrls: string[];
  clients: Array<{ clientId: string; name: string; type: string }>;
  tags: AuditTag[];
  transformations: Array<{ transformationId: string; name: string; type: string }>;
}

export const AUDIT_SERVER_BOUNDARY =
  'Server-container audit: this proves the server CONFIGURATION (a client to claim requests, server tags with their destination ids, no silent gaps) — NOT that the tagging server is deployed/reachable or that data actually flows. Confirm the live server with verify_server_endpoint, the web container\'s server_container_url, and GTM Preview on the server container.';

export const AUDIT_SERVER_RUNTIME_REQUIRED: string[] = [
  'Server reachable — is the tagging-server host deployed and responding (GET <url>/healthy)?',
  'Web→server flow — is the web Google tag\'s server_container_url pointed at this server, so requests actually arrive?',
  'Client claim — on a live request, does the GA4 client claim it and do the server tags fire (GTM Preview on the server container)?',
];

/** The Google destination server-tag types — each depends on the GA4 (gaaw) client
 *  claiming the incoming gtag/GA4 request, so any of them implies a gaaw_client is needed. */
const GOOGLE_SERVER_TAG_TYPES = new Set(['sgtmgaaw', 'sgtmadsct', 'sgtmadscl', 'sgtmadsremarket']);

/** Audit a SERVER container: a client must claim requests, server tags need their
 *  destination id + a firing trigger and shouldn't be paused, and the host should be
 *  provisioned. Returns the same AuditReport shape as the web audit. PURE. */
export function auditServerContainer(s: ServerContainerSnapshot): AuditReport {
  const findings: AuditFinding[] = [];
  const push = (f: Omit<AuditFinding, 'confidence'> & { confidence?: AuditFinding['confidence'] }): void => {
    findings.push({ ...f, confidence: f.confidence ?? confidenceFor(f.category) });
  };
  const hasGa4Client = s.clients.some((c) => c.type === 'gaaw_client');

  if (s.clients.length === 0) {
    push({
      severity: 'critical',
      confidence: 'certain',
      category: 'firing',
      message: 'This server container has NO client — nothing claims incoming requests, so no server tag can ever run.',
      recommendation: 'Add a client (a GA4 client claims GA4/gtag requests): bootstrap_server_side_tagging or create_gtm_client.',
      autoFixable: false,
    });
  } else if (!hasGa4Client && s.tags.some((t) => GOOGLE_SERVER_TAG_TYPES.has(t.type))) {
    push({
      severity: 'high',
      confidence: 'certain',
      category: 'ga4',
      // Ads server tags also depend on the GA4/gtag client claiming the incoming request —
      // not just GA4 server tags. Without a gaaw_client none of them ever see an event.
      message: 'Google server tags (GA4 / Ads) exist but there is no GA4 client (gaaw_client) to claim the incoming gtag/GA4 requests they react to — they will not be processed.',
      recommendation: 'Add a GA4 client (create_gtm_client with type gaaw_client).',
      autoFixable: false,
    });
  }

  if (!s.taggingServerUrls.length) {
    push({
      severity: 'high',
      confidence: 'likely',
      category: 'firing',
      message: 'The container has no tagging server URL — the tagging-server host may not be provisioned/deployed yet, so nothing receives requests.',
      recommendation: 'Record it with set_server_container_tagging_url once you have the server URL (the API CAN write taggingServerUrls), and deploy the host — then confirm it responds with verify_server_endpoint.',
      autoFixable: false,
    });
  }

  for (const t of s.tags) {
    const resource = { kind: 'tag' as const, id: t.tagId, name: t.name };
    const params = Array.isArray(t.parameter) ? t.parameter : [];
    const has = (k: string): boolean => params.some((p) => (p as { key?: string; value?: unknown }).key === k && Boolean((p as { value?: unknown }).value));
    if (!t.firingTriggerId || t.firingTriggerId.length === 0) {
      push({ severity: 'high', category: 'firing', resource, message: `Server tag "${t.name}" has no firing trigger — it never fires.`, recommendation: 'Add a firing trigger (e.g. a Custom Event matching the events it should handle).', autoFixable: false });
    }
    if (t.paused) {
      push({ severity: 'high', category: 'paused', resource, message: `Server tag "${t.name}" is PAUSED — it sends nothing while paused.`, recommendation: 'Unpause it if it should be live.', autoFixable: true, fix: { tool: 'set_gtm_tag_paused', args: { tagId: t.tagId, paused: false, name: t.name } } });
    }
    if (t.type === 'sgtmgaaw' && !has('measurementId')) {
      push({ severity: 'high', category: 'ga4', resource, message: `GA4 server tag "${t.name}" has no Measurement ID — it forwards nothing to GA4.`, recommendation: 'Set its Measurement ID (G-XXXXXXX or a {{variable}}).', autoFixable: false });
    }
    if (t.type === 'sgtmadsct' && (!has('conversionId') || !has('conversionLabel'))) {
      push({ severity: 'high', category: 'ga4', resource, message: `Google Ads conversion server tag "${t.name}" is missing its Conversion ID and/or Label — it records no conversion.`, recommendation: 'Set conversionId (AW-…) and conversionLabel.', autoFixable: false });
    }
    if (t.type === 'sgtmadsremarket' && !has('conversionId')) {
      push({ severity: 'high', category: 'ga4', resource, message: `Google Ads remarketing server tag "${t.name}" has no Conversion ID.`, recommendation: 'Set its conversionId (AW-…).', autoFixable: false });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const t of s.tags) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);
  for (const [name, c] of nameCounts) if (c > 1) push({ severity: 'medium', category: 'naming', message: `Duplicate server-tag name "${name}" (${c} tags) — hard to tell them apart.`, recommendation: 'Rename so each tag is uniquely identifiable.', autoFixable: false });

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  return {
    counts: { tags: s.tags.length, triggers: 0, variables: 0, clients: s.clients.length, transformations: s.transformations.length, findings: findings.length },
    summary,
    findings,
    boundary: AUDIT_SERVER_BOUNDARY,
    runtimeRequired: AUDIT_SERVER_RUNTIME_REQUIRED,
    hasGa4Config: hasGa4Client,
  };
}
