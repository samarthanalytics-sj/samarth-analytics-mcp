// Pure builders that construct valid Google Tag Manager API v2 resources from
// simple inputs, so the LLM supplies fields and OUR code guarantees the correct
// shape (type codes, parameter keys, the eventSettingsTable list-of-maps keyed
// parameter/parameterValue, etc.). No I/O — fully unit-testable.

import { classifyPixel } from './pixel-signatures';
import { classifyEventName, validateEventParams, EVENT_CONTRACT } from '../../shared/tracking-contract';

// Pure builders now live in the MCP package so the website chat can use the SAME code, instead of
// re-deriving GTM resource shapes from raw API primitives every turn. See src/shared/gtm-builders.ts.
import {
  type Param,
  tpl,
  namedParam,
  boolean,
  integer,
  sanitizeName,
  type GtmTagResource,
  type GtmTriggerResource,
  type GtmVariableResource,
  type Ga4EventInput,
  DEFAULT_GA4_EVENT_PARAMS,
  GA4_ECOMMERCE_EVENTS,
  isGa4EcommerceEvent,
  buildGa4EventTag,
  buildGoogleTag,
  type GoogleTagInput,
  FILTER_OPS,
  OP_TO_CONDITION,
  condition,
  type TriggerKind,
  VIDEO_BUILT_IN_VARS,
  type TriggerInput,
  applyTriggerWaitDefaults,
  URL_QUERY_VAR,
  pageScopeConditions,
  buildTrigger,
  TRIGGER_KINDS,
  isTriggerKind,
  normalizeCustomEventName,
  type VariableKind,
  type VariableInput,
  buildVariable,
  triggerUrlVarNames,
  triggerDataLayerVarKeys,
  triggerBuiltInVars,
  builtInVarsForTemplates,
} from '../../../../../src/shared/gtm-builders';
// The web→server migration surface (audit types, recognisers, CAPI + native server builders, the planner)
// lives in src/shared/server-migration.ts so the MCP server ships the same tools; re-exported here so
// every existing desktop importer of these names keeps working unchanged.
export * from '../../../../../src/shared/server-migration';
// Names the code that STAYS in this file uses internally (export * does not bring them into scope).
import {
  type AuditTag,
  type AuditTrigger,
  type AuditVariable,
  type ContainerSnapshot,
  type ServerContainerSnapshot,
  type GoogleAdsConversionInput,
  META_EVENT_OBJECT_PROPERTIES,
  metaStandardEvent,
  normalizeAdsConversionId,
  serverTagParam,
  isVariableRef,
  isMetaCapiServerTag,
  isTikTokCapiServerTag,
  isSnapchatCapiServerTag,
  isMicrosoftCapiServerTag,
  isAnyCapiServerTag,
} from '../../../../../src/shared/server-migration';

export {
  type Param,
  tpl,
  namedParam,
  boolean,
  integer,
  sanitizeName,
  type GtmTagResource,
  type GtmTriggerResource,
  type GtmVariableResource,
  type Ga4EventInput,
  DEFAULT_GA4_EVENT_PARAMS,
  GA4_ECOMMERCE_EVENTS,
  isGa4EcommerceEvent,
  buildGa4EventTag,
  buildGoogleTag,
  type GoogleTagInput,
  FILTER_OPS,
  OP_TO_CONDITION,
  condition,
  type TriggerKind,
  VIDEO_BUILT_IN_VARS,
  type TriggerInput,
  applyTriggerWaitDefaults,
  URL_QUERY_VAR,
  pageScopeConditions,
  buildTrigger,
  TRIGGER_KINDS,
  isTriggerKind,
  normalizeCustomEventName,
  type VariableKind,
  type VariableInput,
  buildVariable,
  triggerUrlVarNames,
  triggerDataLayerVarKeys,
  triggerBuiltInVars,
  builtInVarsForTemplates,
};


/** True when a container is the SERVER container with the given name (case-insensitive on both
 *  the name and the usageContext, since GTM may echo usageContext as "server" or "SERVER").
 *  Used to make "create server container from web" idempotent — a retry reuses the container a
 *  prior (quota-interrupted) run created instead of creating a duplicate. PURE. */
export function matchesServerContainer(
  c: { name?: string | null; usageContext?: Array<string | null> | null },
  name: string
): boolean {
  return (
    (c.name ?? '').trim().toLowerCase() === name.trim().toLowerCase() &&
    (c.usageContext ?? []).some((u) => (u ?? '').toLowerCase() === 'server')
  );
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

// GoogleTagInput / buildGoogleTag moved to src/shared/gtm-builders.ts (imported above and
// re-exported below) so the MCP can build the same tag. The website needs one to stand up a GA4
// configuration, and a second copy of the resource shape is how the two surfaces drift.

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

export function buildGoogleAdsConversionTag(o: GoogleAdsConversionInput): GtmTagResource {
  return {
    name: sanitizeName(o.name),
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
    name: sanitizeName(o.name),
    type: 'html',
    parameter: [tpl('html', o.html), boolean('supportDocumentWrite', false)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

/* ───────────── Other Google web tags (corpus-verified shapes) ─────────────
 * Parameter shapes below were mined from 562 real container exports; the API v2
 * create call uses the lowercase param `type` the tpl/boolean helpers emit
 * (exports serialize them UPPER_SNAKE). Enum VALUES that are literal strings the
 * tag reads (ordinalType STANDARD/UNIQUE, customParamsFormat NONE, urlPosition
 * "query") stay in the exact casing the corpus uses. */

export interface FloodlightCounterInput {
  name: string;
  advertiserId: string; // numeric CM360/DV360 Floodlight advertiser id (or {{variable}})
  groupTag: string; // activity group tag string
  activityTag: string; // activity tag string
  /** Floodlight counting/ordinal method. Corpus uses only STANDARD (every conversion) and UNIQUE
   *  (one per user/session); defaults to standard. */
  countingMethod?: 'standard' | 'unique';
  /** Read the Conversion Linker cookies for attribution (recommended). Default true. */
  enableConversionLinker?: boolean;
  firingTriggerId?: string[];
}
// Floodlight Counter (flc) — 62/62 corpus tags carry advertiserId, groupTag, activityTag,
// ordinalType, useImageTag=false; the Conversion Linker pair (52/62) is added by default.
export function buildFloodlightCounterTag(o: FloodlightCounterInput): GtmTagResource {
  const parameter: Param[] = [
    tpl('advertiserId', o.advertiserId),
    tpl('groupTag', o.groupTag),
    tpl('activityTag', o.activityTag),
    tpl('ordinalType', o.countingMethod === 'unique' ? 'UNIQUE' : 'STANDARD'),
    boolean('useImageTag', false),
  ];
  if (o.enableConversionLinker !== false) parameter.push(boolean('enableConversionLinker', true), tpl('conversionCookiePrefix', '_gcl'));
  return { name: sanitizeName(o.name), type: 'flc', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

export interface GoogleAdsCallConversionInput {
  name: string;
  phoneNumber: string; // the on-page phone number, formatted exactly as it appears on the site
  conversionId: string; // numeric Google Ads id (AW- prefix stripped, or {{variable}})
  conversionLabel: string;
  firingTriggerId?: string[];
}
// Google Ads Call Conversion (awcc) — 49/49 corpus tags have EXACTLY three template params in this
// fixed order. conversionId is the bare numeric id (GTM rejects "AW-", same as awct).
export function buildGoogleAdsCallConversionTag(o: GoogleAdsCallConversionInput): GtmTagResource {
  return {
    name: sanitizeName(o.name),
    type: 'awcc',
    parameter: [tpl('phoneConversionNumber', o.phoneNumber), tpl('conversionId', normalizeAdsConversionId(o.conversionId)), tpl('conversionLabel', o.conversionLabel)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

export interface GoogleAdsRemarketingInput {
  name: string;
  conversionId: string; // Google Ads conversion id (AW- or bare numeric or {{variable}})
  /** Read/refresh the linker (gclid) first-party cookies. Default true. */
  enableConversionLinker?: boolean;
  firingTriggerId?: string[];
}
// Google Ads Remarketing (sp) — the basic all-pages audience shape (customParamsFormat NONE, the
// 31/43 corpus majority). conversionId passes through unchanged: the corpus stores it both with the
// AW- prefix and bare, so both validate for this type (unlike awct/awcc which require bare numeric).
export function buildGoogleAdsRemarketingTag(o: GoogleAdsRemarketingInput): GtmTagResource {
  const parameter: Param[] = [];
  if (o.enableConversionLinker !== false) parameter.push(boolean('enableConversionLinker', true), tpl('conversionCookiePrefix', '_gcl'));
  parameter.push(boolean('enableDynamicRemarketing', false), tpl('conversionId', o.conversionId.trim()), tpl('customParamsFormat', 'NONE'), boolean('rdp', false));
  return { name: sanitizeName(o.name), type: 'sp', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

export interface ConversionLinkerInput {
  name: string;
  /** Decorate outbound links/forms for cross-domain measurement. Default false. Passing
   *  linkerDomains implies cross-domain. */
  enableCrossDomain?: boolean;
  /** Comma-separated domains to link (only used when cross-domain). */
  linkerDomains?: string;
  firingTriggerId?: string[];
}
// Conversion Linker (gclidw) — every corpus tag (253/253) carries enableCookieOverrides=false; the
// two other booleans default false. Cross-domain adds acceptIncoming/linkerDomains/formDecoration/
// urlPosition (urlPosition is the literal lowercase "query" — do not upper-case it).
export function buildConversionLinkerTag(o: ConversionLinkerInput): GtmTagResource {
  const crossDomain = o.enableCrossDomain === true || !!o.linkerDomains?.trim();
  const parameter: Param[] = [boolean('enableCrossDomain', crossDomain), boolean('enableUrlPassthrough', false), boolean('enableCookieOverrides', false)];
  if (crossDomain) {
    parameter.push(boolean('acceptIncoming', true));
    if (o.linkerDomains?.trim()) parameter.push(tpl('linkerDomains', o.linkerDomains.trim()));
    parameter.push(boolean('formDecoration', false), tpl('urlPosition', 'query'));
  }
  return { name: sanitizeName(o.name), type: 'gclidw', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

export interface CustomImageInput {
  name: string;
  url: string; // pixel/beacon URL (protocol-relative //host/path or https, may contain {{variables}})
  /** Append a random cache-buster query param so the browser refetches. Default true. */
  useCacheBuster?: boolean;
  /** Query-key for the cache buster (only emitted when useCacheBuster). Default "gtmcb". */
  cacheBusterQueryParam?: string;
  firingTriggerId?: string[];
}
// Custom Image (img) — the fallback beacon pixel: a url plus a cache buster. cacheBusterQueryParam is
// only meaningful (and only emitted) when useCacheBuster is true.
export function buildCustomImageTag(o: CustomImageInput): GtmTagResource {
  const useCacheBuster = o.useCacheBuster !== false;
  const parameter: Param[] = [tpl('url', o.url), boolean('useCacheBuster', useCacheBuster)];
  if (useCacheBuster) parameter.push(tpl('cacheBusterQueryParam', o.cacheBusterQueryParam?.trim() || 'gtmcb'));
  return { name: sanitizeName(o.name), type: 'img', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

/* ───────────── Server-side GTM (sGTM) ───────────── */

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

/** How a trigger CONDITION's operator prints in readable form. Keys are the GTM API
 *  Condition.type enum; anything unmapped falls through to the raw type string. */
const CONDITION_OPERATOR_WORD: Record<string, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matchRegex: 'matches regex',
  cssSelector: 'matches CSS selector',
  urlMatches: 'URL matches',
  greater: '>',
  greaterOrEquals: '>=',
  less: '<',
  lessOrEquals: '<=',
};

/**
 * Render a trigger's firing CONDITIONS as readable strings, decoded from its
 * `filter` and `autoEventFilter` arrays: each condition is `arg0 <operator> arg1`,
 * e.g. "{{Click Classes}} contains res-brochure-download". A condition carrying a
 * `negate:true` parameter is prefixed "NOT ". The `{{_event}}` custom-event
 * condition is skipped here because it is surfaced separately as customEventName.
 * Returns [] when the trigger fires unconditionally. PURE — this is the ground
 * truth for "check trigger conditions"; without it a caller can only guess the
 * conditions from the trigger NAME.
 */
export function describeTriggerConditions(trigger: Record<string, unknown>): string[] {
  const out: string[] = [];
  const render = (conds: unknown) => {
    if (!Array.isArray(conds)) return;
    for (const cond of conds) {
      const type = String((cond as { type?: unknown }).type ?? '');
      const params = (cond as { parameter?: unknown }).parameter;
      let arg0 = '';
      let arg1 = '';
      let negate = false;
      if (Array.isArray(params)) {
        for (const p of params) {
          const k = (p as { key?: unknown }).key;
          const v = (p as { value?: unknown }).value;
          if (k === 'arg0') arg0 = String(v ?? '');
          else if (k === 'arg1') arg1 = String(v ?? '');
          else if (k === 'negate' && String(v ?? '') === 'true') negate = true;
        }
      }
      // The {{_event}} match is the custom-event name, surfaced via customEventNameOf — not a "condition".
      if (arg0 === '{{_event}}') continue;
      if (!arg0 && !type) continue;
      const op = CONDITION_OPERATOR_WORD[type] ?? type;
      out.push(`${negate ? 'NOT ' : ''}${arg0} ${op} ${arg1}`.trim());
    }
  };
  render((trigger as { filter?: unknown }).filter);
  render((trigger as { autoEventFilter?: unknown }).autoEventFilter);
  return out;
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

/** How to repair a CREATED tag's firing trigger to a corrected shape (from "Verify firing"). */
export interface TriggerRetargetPlan {
  tagId: string;
  tagName: string;
  /** The tag's current (first) firing trigger id. */
  triggerId: string;
  /** 'rewrite' the trigger's conditions in place (it fires ONLY this tag), or 'rebind' this tag to a
   *  fresh corrected trigger because the current one is shared by other tags (never disturb them). */
  mode: 'rewrite' | 'rebind';
  /** The corrected GTM trigger resource (from buildTrigger). */
  built: GtmTriggerResource;
  /** How many tags fire on the current trigger (>1 ⇒ rebind). */
  sharedBy: number;
}

/**
 * PURE: decide how to apply a corrected trigger to an existing (created) tag, given a container
 * snapshot. Finds the tag by name and its first firing trigger; if that trigger fires only this tag
 * it is rewritten in place, otherwise a corrected trigger is created and this tag is re-bound to it
 * so sibling tags keep their trigger. Throws if the tag / firing trigger can't be found. No I/O.
 */
export function planTriggerRetarget(snapshot: ContainerSnapshot, tagName: string, corrected: TriggerInput): TriggerRetargetPlan {
  const want = tagName.trim();
  const tag = snapshot.tags.find((t) => (t.name ?? '').trim() === want);
  if (!tag) throw new Error(`No tag named "${tagName}" in this workspace to repair.`);
  const triggerId = (tag.firingTriggerId ?? [])[0];
  if (!triggerId) throw new Error(`Tag "${tagName}" has no firing trigger to repair.`);
  const sharedBy = snapshot.tags.filter((t) => (t.firingTriggerId ?? []).includes(triggerId)).length;
  return { tagId: tag.tagId, tagName: tag.name, triggerId, mode: sharedBy > 1 ? 'rebind' : 'rewrite', built: buildTrigger(corrected), sharedBy };
}

/** SET a customEvent trigger's `{{_event}}` match value to a new event (normalized to snake_case),
 *  preserving the rest of the trigger and any other conditions. Used to UPDATE a trigger's Event
 *  name in place (no delete+recreate). PURE. */
export function setCustomEventName(trigger: Record<string, unknown>, eventName: string): Record<string, unknown> {
  const ev = normalizeCustomEventName(eventName);
  const cef = Array.isArray((trigger as { customEventFilter?: unknown }).customEventFilter)
    ? [...(trigger as { customEventFilter: Array<Record<string, unknown>> }).customEventFilter]
    : [];
  let found = false;
  const updated = cef.map((cond) => {
    const params = (cond as { parameter?: unknown }).parameter;
    if (Array.isArray(params) && params.some((p) => (p as { key?: string; value?: unknown }).key === 'arg0' && (p as { value?: unknown }).value === '{{_event}}')) {
      found = true;
      return { ...cond, parameter: params.map((p) => ((p as { key?: string }).key === 'arg1' ? { ...(p as object), value: ev } : p)) };
    }
    return cond;
  });
  if (!found) updated.push({ type: 'equals', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', ev)] });
  return { ...trigger, type: 'customEvent', customEventFilter: updated };
}

/** The exact GTM v2 `Trigger.type` enum, keyed by a canonicalized form (lower-cased, with spaces /
 *  underscores / hyphens stripped). Every VALID type maps to itself so a correct trigger is never
 *  rewritten; the extra entries are the aliases the chat model routinely invents. */
const TRIGGER_TYPE_ALIASES: Record<string, string> = {
  // All-Elements clicks: GTM's enum value is the bare "click" (the model loves "all_clicks"/"allElements").
  click: 'click', clicks: 'click', allclick: 'click', allclicks: 'click',
  allelement: 'click', allelements: 'click', allelementclick: 'click', allelementclicks: 'click',
  allelementsclick: 'click', allelementsclicks: 'click', elementclick: 'click', clickall: 'click',
  // Just-Links clicks.
  linkclick: 'linkClick', linkclicks: 'linkClick', justlink: 'linkClick', justlinks: 'linkClick',
  linksclick: 'linkClick', linkonly: 'linkClick', clicklink: 'linkClick',
  // Form submission.
  formsubmission: 'formSubmission', formsubmissions: 'formSubmission', formsubmit: 'formSubmission',
  formsubmits: 'formSubmission', submitform: 'formSubmission', form: 'formSubmission',
  // Custom Event (dataLayer).
  customevent: 'customEvent', customevents: 'customEvent', custom: 'customEvent', datalayerevent: 'customEvent',
  // Page-load family.
  pageview: 'pageview', pageviews: 'pageview', pageload: 'pageview',
  domready: 'domReady', dom: 'domReady', domcontentloaded: 'domReady',
  windowloaded: 'windowLoaded', windowload: 'windowLoaded', pageloaded: 'windowLoaded', windowonload: 'windowLoaded',
  // History / JS error / timer.
  historychange: 'historyChange', history: 'historyChange',
  jserror: 'jsError', javascripterror: 'jsError', error: 'jsError',
  timer: 'timer',
  // Element visibility / scroll / video.
  elementvisibility: 'elementVisibility', visibility: 'elementVisibility', elementvisible: 'elementVisibility',
  scrolldepth: 'scrollDepth', scroll: 'scrollDepth',
  youtubevideo: 'youTubeVideo', youtube: 'youTubeVideo', ytvideo: 'youTubeVideo', video: 'youTubeVideo',
  // Initialization / consent. The Consent Initialization trigger's API enum value is "consentInit"
  // (NOT "consentInitialization") - confirmed by container-verify.ts + the web-audit GTM fixture; the
  // longer spellings are aliases that must be REPAIRED to consentInit, and the correct value maps to itself.
  init: 'init', initialization: 'init', initallpages: 'init', pageviewinit: 'init',
  consentinit: 'consentInit', consentinitialization: 'consentInit', consentinitialisation: 'consentInit',
  // Trigger group.
  triggergroup: 'triggerGroup', group: 'triggerGroup',
};

/** Repair a hand-authored trigger `type` to the exact GTM v2 enum value. The chat model routinely
 *  invents aliases the API rejects ("Invalid value at 'trigger.type'"): "all_clicks"/"allClicks"/
 *  "allElements"/"all_elements" for the All-Elements click trigger (correct: "click"), "form_submit"
 *  for "formSubmission", "custom_event" for "customEvent", and so on. We canonicalize by stripping
 *  case / underscores / hyphens / spaces, then map RECOGNIZED aliases only; an unrecognized type
 *  passes through untouched so a genuinely valid (or server-only) type is never mangled and the API
 *  can still return its own clear error. PURE. */
export function normalizeTriggerType(trigger: Record<string, unknown>): Record<string, unknown> {
  const raw = (trigger as { type?: unknown }).type;
  if (typeof raw !== 'string' || !raw) return trigger;
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
  const canonical = TRIGGER_TYPE_ALIASES[key];
  return canonical && canonical !== raw ? { ...trigger, type: canonical } : trigger;
}

/** Normalize AND REPAIR a Custom Event trigger so the API always accepts it. The model often
 *  hand-builds a customEvent trigger (via the raw create_gtm_trigger tool) with the event name at the
 *  TOP-LEVEL `eventName` field (timer-only, so the API rejects `trigger.event_name` on a customEvent) and/or
 *  a malformed `customEventFilter`. GTM requires `customEventFilter` to hold EXACTLY ONE condition (the
 *  `{{_event}} equals <name>` match); every other scope condition belongs in `filter` (corpus-verified
 *  in buildTrigger). This repairs all three:
 *    - keeps the single `{{_event}}` condition (snake_casing its match value), rebuilding it from the
 *      top-level eventName / any arg1 if none is present, and dropping duplicates so exactly one remains;
 *    - MOVES any non-event conditions the model mis-placed inside `customEventFilter` out into `filter`
 *      (merged after existing `filter` conditions); this is what fixes the API's "Custom-event trigger
 *      must have exactly one custom-event filter" rejection;
 *    - ALWAYS strips a top-level `eventName` from a customEvent trigger.
 *  PURE. */
export function normalizeCustomEventTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const t = trigger as { type?: unknown; eventName?: unknown; customEventFilter?: unknown; filter?: unknown };
  if (String(t.type ?? '') !== 'customEvent') return trigger;

  const stripEventName = (o: Record<string, unknown>): Record<string, unknown> => {
    if (!('eventName' in o)) return o;
    const rest = { ...o };
    delete rest.eventName;
    return rest;
  };
  const isEventCond = (cond: Record<string, unknown>): boolean => {
    const params = (cond as { parameter?: unknown }).parameter;
    return Array.isArray(params) && params.some((p) => (p as { key?: string; value?: unknown }).key === 'arg0' && (p as { value?: unknown }).value === '{{_event}}');
  };
  const valueOf = (v: unknown): string =>
    typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string' ? (v as { value: string }).value : '';

  // Keep only real condition OBJECTS: a hand-authoring model can emit a null/primitive array element,
  // and a bare `.parameter` access on one would throw mid-create instead of repairing the trigger.
  const cefIn = (Array.isArray(t.customEventFilter) ? (t.customEventFilter as unknown[]) : []).filter(
    (c): c is Record<string, unknown> => c != null && typeof c === 'object',
  );
  const eventConds = cefIn.filter(isEventCond);
  const nonEventConds = cefIn.filter((cond) => !isEventCond(cond));

  // The single {{_event}} condition customEventFilter is allowed to keep.
  let eventCond: Record<string, unknown>;
  if (eventConds.length >= 1) {
    // Keep the first {{_event}} condition (dropping any duplicates), snake_casing its match value.
    const first = eventConds[0] as { parameter: Array<Record<string, unknown>> };
    eventCond = {
      ...(eventConds[0] as Record<string, unknown>),
      parameter: first.parameter.map((p) => {
        const pp = p as { key?: string; value?: unknown };
        return pp.key === 'arg1' && typeof pp.value === 'string' ? { ...pp, value: normalizeCustomEventName(pp.value) } : p;
      }),
    };
  } else {
    // No {{_event}} condition present → rebuild one from the top-level eventName, else any arg1 present.
    let arg1 = '';
    for (const cond of cefIn) {
      const params = (cond as { parameter?: unknown }).parameter;
      if (Array.isArray(params)) {
        const a1 = params.find((p) => (p as { key?: string }).key === 'arg1');
        if (a1 && typeof (a1 as { value?: unknown }).value === 'string') { arg1 = (a1 as { value: string }).value; break; }
      }
    }
    eventCond = condition('{{_event}}', 'equals', normalizeCustomEventName(valueOf(t.eventName) || arg1));
  }

  // Any scope conditions the model mis-placed inside customEventFilter move to `filter`, after any
  // conditions already there. customEventFilter is left holding exactly the one {{_event}} match.
  const existingFilter = Array.isArray(t.filter) ? (t.filter as Array<Record<string, unknown>>) : [];
  const filter = [...existingFilter, ...nonEventConds];
  const out: Record<string, unknown> = { ...trigger, type: 'customEvent', customEventFilter: [eventCond] };
  if (filter.length) out.filter = filter;
  else delete out.filter;
  return stripEventName(out);
}

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
/** A URL variable that reads ONE query-string key: {{URL - <key>}} resolves to the value of ?<key>=…
 *  — the standard way to capture a GA4 search_term from a results URL. Corpus-verified shape (type "u",
 *  component QUERY + queryKey). The name is used verbatim so a {{URL - <key>}} reference resolves to it. */
/** A URL variable returning the ENTIRE query string (component QUERY, no queryKey). Web containers
 *  have no built-in for this, so a queryString trigger condition needs it created. Distinct from
 *  buildUrlQueryVariable, which returns ONE named parameter's value. */
export function buildQueryStringVariable(name: string = URL_QUERY_VAR): GtmVariableResource {
  return { name, type: 'u', parameter: [tpl('component', 'QUERY')] };
}

export function buildUrlQueryVariable(name: string, queryKey: string): GtmVariableResource {
  return { name, type: 'u', parameter: [tpl('component', 'QUERY'), tpl('queryKey', queryKey)] };
}

/** A Lookup Table variable (type "smm") mapping an INPUT to a per-row OUTPUT, with an optional
 *  default. Corpus-verified shape (setDefaultValue [+ defaultValue], input, map = list of {key,value}
 *  rows). Matching is EXACT (case-sensitive). Use for {{Page Path}} → a per-page form_name, or any
 *  input → value table. */
export function buildLookupTableVariable(
  name: string,
  input: string,
  rows: Array<{ key: string; value: string }>,
  defaultValue?: string,
): GtmVariableResource {
  const hasDefault = defaultValue !== undefined && defaultValue !== '';
  const parameter: Param[] = [boolean('setDefaultValue', hasDefault), tpl('input', input)];
  if (hasDefault) parameter.push(tpl('defaultValue', defaultValue as string));
  parameter.push({ type: 'list', key: 'map', list: rows.map((r) => ({ type: 'map', map: [tpl('key', r.key), tpl('value', r.value)] })) });
  return { name, type: 'smm', parameter };
}

/** A "Google Tag: Event Settings" variable (type "gtes"): a REUSABLE event-parameter table that
 *  GA4 event tags / Google tags reference (their eventSettingsVariable field), instead of hand-
 *  rolling a Custom JavaScript object. Rows land in `eventSettingsTable` as list-of-maps keyed
 *  `parameter`/`parameterValue` - the SAME corpus-validated shape the gaawe tag builder writes
 *  inline (5,127 of 8,148 real GA4 tags; the name/value list shape is silently ignored). PURE. */
export function buildGoogleTagEventSettingsVariable(name: string, rows: Array<{ key: string; value: string }>): GtmVariableResource {
  return {
    name,
    type: 'gtes',
    parameter: [
      {
        type: 'list',
        key: 'eventSettingsTable',
        list: rows.map((r) => ({ type: 'map', map: [tpl('parameter', r.key), tpl('parameterValue', r.value)] })),
      },
    ],
  };
}

/** A RegEx Table variable (type "remm") mapping a regex-matched input to output values. Corpus shape:
 *  setDefaultValue, input, fullMatch, replaceAfterMatch, ignoreCase [+ defaultValue], map. Defaults to
 *  partial match + ignoreCase (the corpus norm, 72/97 and 89/97) — use when many URLs under one
 *  section should map to one value (e.g. {{Page Path}} matching "^/services/" → a section name). */
export function buildRegexTableVariable(
  name: string,
  input: string,
  rows: Array<{ key: string; value: string }>,
  defaultValue?: string,
): GtmVariableResource {
  const hasDefault = defaultValue !== undefined && defaultValue !== '';
  const parameter: Param[] = [
    boolean('setDefaultValue', hasDefault),
    tpl('input', input),
    boolean('fullMatch', false),
    boolean('replaceAfterMatch', false),
    boolean('ignoreCase', true),
  ];
  if (hasDefault) parameter.push(tpl('defaultValue', defaultValue as string));
  parameter.push({ type: 'list', key: 'map', list: rows.map((r) => ({ type: 'map', map: [tpl('key', r.key), tpl('value', r.value)] })) });
  return { name, type: 'remm', parameter };
}

/** A Lookup Table variable mapping several exact {{Click Text}} values to "true" — the classic GTM
 *  grouping pattern (ONE tag/trigger for many related click texts; the trigger fires on
 *  {{<name>}} equals "true"). Each text variant ("Learn More", "LEARN MORE") is its own row. */
export function buildClickTextLookupVariable(name: string, texts: string[]): GtmVariableResource {
  return buildLookupTableVariable(name, '{{Click Text}}', texts.map((t) => ({ key: t, value: 'true' })));
}

/** The reusable "Form Name" Custom JavaScript variable — GTM has no built-in {{Form Name}}, so this
 *  derives it from the submitted form element at fire time (name → id → aria-label → nearest heading →
 *  "form"). Every GA4 form tag references {{Form Name}} instead of a hardcoded string, so form_name is
 *  reported consistently from ONE variable. References the {{Form Element}} built-in (auto-enabled). */
export const FORM_NAME_JS =
  "function(){\n  var f = {{Form Element}};\n  if(!f || !f.getAttribute) return 'form';\n  return f.getAttribute('name') || f.getAttribute('id') || f.getAttribute('aria-label') || ((f.querySelector('h1,h2,h3')||{}).innerText||'').trim() || 'form';\n}";
export function buildFormNameVariable(): GtmVariableResource {
  return buildVariable({ kind: 'javascript', name: 'Form Name', javascript: FORM_NAME_JS });
}

/** The GA4 ecommerce FUNNEL events a one-shot setup installs (order = the funnel). */
export const GA4_ECOMMERCE_FUNNEL_EVENTS = [
  'view_item',
  'add_to_cart',
  'view_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'purchase',
] as const;

/** The ecommerce dataLayer variables downstream tags (Ads value/currency, Meta contents) read —
 *  corpus keys: ecommerce.currency 52×, .items 48×, .value 44×, .transaction_id 42×, .coupon 45×. */
export const ECOMMERCE_DLV_KEYS = ['ecommerce.value', 'ecommerce.currency', 'ecommerce.items', 'ecommerce.transaction_id', 'ecommerce.coupon'] as const;
export function buildEcommerceDlvVariables(): GtmVariableResource[] {
  return ECOMMERCE_DLV_KEYS.map((k) => buildVariable({ name: `dlv - ${k}`, kind: 'data_layer', dataLayerName: k }));
}

/** GTM's built-in "Consent Initialization - All Pages" trigger id — the earliest firing point,
 *  BEFORE every other trigger; the consent-default tag must fire on it. Corpus: the consent-default
 *  tags reference this id directly (2/2). */
export const CONSENT_INIT_TRIGGER_ID = '2147479572';

export interface ConsentDefaults {
  ad_storage?: 'granted' | 'denied';
  analytics_storage?: 'granted' | 'denied';
  ad_user_data?: 'granted' | 'denied';
  ad_personalization?: 'granted' | 'denied';
  functionality_storage?: 'granted' | 'denied';
  security_storage?: 'granted' | 'denied';
  /** ms to wait for the CMP's consent update before tags fire (default 500). */
  waitForUpdate?: number;
}
/** The Consent Mode v2 DEFAULT-consent tag: a Custom HTML gtag('consent','default', …) firing on the
 *  built-in Consent Initialization trigger (before everything else). Denied-by-default unless
 *  overridden — the CMP then upgrades via gtag('consent','update', …). Includes BOTH v2 signals
 *  (ad_user_data + ad_personalization); the portal's consent audit requires them present in the
 *  default call and firing before any GA/Ads tag — which the consent-init trigger guarantees. */
export function buildConsentModeDefaultTag(name: string, defaults?: ConsentDefaults): GtmTagResource {
  const d = defaults ?? {};
  const val = (v: 'granted' | 'denied' | undefined): string => (v === 'granted' ? 'granted' : 'denied');
  const wait = d.waitForUpdate && d.waitForUpdate > 0 ? d.waitForUpdate : 500;
  const html =
    '<script>\n' +
    'window.dataLayer = window.dataLayer || [];\n' +
    'function gtag(){dataLayer.push(arguments);}\n' +
    "gtag('consent', 'default', {\n" +
    `  ad_storage: '${val(d.ad_storage)}',\n` +
    `  analytics_storage: '${val(d.analytics_storage)}',\n` +
    `  ad_user_data: '${val(d.ad_user_data)}',\n` +
    `  ad_personalization: '${val(d.ad_personalization)}',\n` +
    `  functionality_storage: '${d.functionality_storage === 'denied' ? 'denied' : 'granted'}',\n` +
    `  security_storage: '${d.security_storage === 'denied' ? 'denied' : 'granted'}',\n` +
    `  wait_for_update: ${wait}\n` +
    '});\n' +
    '</script>';
  return {
    name: sanitizeName(name),
    type: 'html',
    firingTriggerId: [CONSENT_INIT_TRIGGER_ID],
    parameter: [tpl('html', html), boolean('supportDocumentWrite', false)],
  };
}

// ---------------------------------------------------------------------------
// verify_tracking_setup — the post-install QA checklist. PURE (the live endpoint
// health check is appended by the data-service, which owns network access).
// ---------------------------------------------------------------------------

export interface TrackingSetupCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
}
export interface TrackingSetupReport {
  ok: boolean;
  passed: number;
  warnings: number;
  failures: number;
  checks: TrackingSetupCheck[];
}

/** Read a top-level string parameter off a raw Tag resource. */
function tagParam(tag: Record<string, unknown>, key: string): string {
  const params = Array.isArray(tag.parameter) ? (tag.parameter as Array<Record<string, unknown>>) : [];
  const hit = params.find((p) => p.key === key);
  return hit && hit.value != null ? String(hit.value) : '';
}

/** The identifying fields worth surfacing when LISTING tags, so "what event does this tag send?" is
 *  answerable without confusing the tag's own GA4 event name with its firing trigger's custom event
 *  name. For a GA4 Event tag (gaawe): its eventName (the "Event Name" field) + measurement id; for a
 *  Google tag (googtag): its tagId. Empty object for other tag types. */
export function ga4TagFields(tag: Record<string, unknown>): { eventName?: string; measurementId?: string } {
  const type = String(tag.type ?? '');
  if (type === 'gaawe') {
    const out: { eventName?: string; measurementId?: string } = {};
    const ev = tagParam(tag, 'eventName');
    if (ev) out.eventName = ev;
    const mid = tagParam(tag, 'measurementIdOverride') || tagParam(tag, 'measurementId');
    if (mid) out.measurementId = mid;
    return out;
  }
  if (type === 'googtag') {
    const mid = tagParam(tag, 'tagId');
    return mid ? { measurementId: mid } : {};
  }
  return {};
}

/** Read a GA4 Event tag's actual event parameters out of its `eventSettingsTable` (the list-of-maps
 *  keyed parameter/parameterValue that GTM stores). Returns the real {name, value} pairs so a tag
 *  inventory can show what each tag ACTUALLY sends, instead of the model assuming a standard set. */
export function readGa4EventParameters(tag: Record<string, unknown>): Array<{ name: string; value: string }> {
  const params = Array.isArray(tag.parameter) ? (tag.parameter as Array<Record<string, unknown>>) : [];
  const table = params.find((p) => p.key === 'eventSettingsTable' && Array.isArray(p.list));
  if (!table) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const row of table.list as Array<Record<string, unknown>>) {
    const map = Array.isArray(row.map) ? (row.map as Array<Record<string, unknown>>) : [];
    const name = map.find((m) => m.key === 'parameter')?.value;
    const value = map.find((m) => m.key === 'parameterValue')?.value;
    if (name != null && String(name) !== '') out.push({ name: String(name), value: value != null ? String(value) : '' });
  }
  return out;
}

/** Read one setting (e.g. server_container_url) out of a Google tag's configSettingsTable —
 *  the list-of-maps shape upsertGoogleTagConfig writes. */
export function googleTagConfigValue(tag: Record<string, unknown>, configKey: string): string {
  const params = Array.isArray(tag.parameter) ? (tag.parameter as Array<Record<string, unknown>>) : [];
  const table = params.find((p) => p.key === 'configSettingsTable');
  const rows = table && Array.isArray(table.list) ? (table.list as Array<Record<string, unknown>>) : [];
  for (const row of rows) {
    const cells = Array.isArray(row.map) ? (row.map as Array<Record<string, unknown>>) : [];
    const k = cells.find((c) => c.key === 'parameter');
    if (k && String(k.value ?? '') === configKey) {
      const v = cells.find((c) => c.key === 'parameterValue');
      return v && v.value != null ? String(v.value) : '';
    }
  }
  return '';
}

const eventTitle = (ev: string): string => ev.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/** Evaluate a full web(+server) tracking install against the funnel checklist:
 *  web Google tag, per-event GA4 tags (present / not paused / has trigger / forwards ecommerce),
 *  consent defaults on Consent Initialization, and — when the server side is passed — the GA4
 *  client, tagging server URL, and per-event server relay coverage (a base all-events relay
 *  counts as coverage for every event). PURE — takes RAW resources. */
export function evaluateTrackingSetup(
  webTags: Array<Record<string, unknown>>,
  events: string[],
  server?: {
    tags: Array<Record<string, unknown>>;
    clients: Array<{ name?: string; type?: string }>;
    taggingServerUrls: string[];
  } | null
): TrackingSetupReport {
  const checks: TrackingSetupCheck[] = [];
  const ecommerceEvents = new Set<string>(GA4_ECOMMERCE_FUNNEL_EVENTS);
  // Event parameters explicitly mapped on a gaawe tag (eventSettingsTable rows keyed parameter/parameterValue).
  const ga4TagParamNames = (tag: Record<string, unknown>): string[] => {
    const list = (tag.parameter as Array<{ key?: string; list?: Array<{ map?: Array<{ key?: string; value?: string }> }> }> | undefined)?.find((p) => p.key === 'eventSettingsTable')?.list ?? [];
    return list.map((row) => row.map?.find((m) => m.key === 'parameter')?.value ?? '').filter(Boolean);
  };

  // 1. The web Google tag (GA4 loader).
  const googleTag = webTags.find((t) => t.type === 'googtag');
  checks.push(
    googleTag
      ? { id: 'web_google_tag', label: 'Web: Google tag', status: 'pass', detail: `"${String(googleTag.name ?? '')}" (GA4 loads on the site).` }
      : { id: 'web_google_tag', label: 'Web: Google tag', status: 'fail', detail: 'No Google tag (googtag) found — GA4 does not load. Create it first (create_googtag_tag).' }
  );

  // 2. Web → server link (only meaningful when a server container is being verified).
  const serverUrlOnWeb = googleTag ? googleTagConfigValue(googleTag, 'server_container_url') : '';
  if (serverUrlOnWeb) {
    checks.push({ id: 'web_server_url', label: 'Web: server_container_url', status: 'pass', detail: `Google tag sends to ${serverUrlOnWeb}.` });
  } else if (server) {
    checks.push({ id: 'web_server_url', label: 'Web: server_container_url', status: 'fail', detail: 'The web Google tag is NOT pointed at the server container — hits go straight to Google. Fix with set_web_server_container_url.' });
  } else {
    checks.push({ id: 'web_server_url', label: 'Web: server_container_url', status: 'skip', detail: 'No server container in this check (client-side only setup).' });
  }

  // 3. Consent defaults must fire on the built-in Consent Initialization trigger.
  const consentTag = webTags.find((t) => Array.isArray(t.firingTriggerId) && (t.firingTriggerId as unknown[]).map(String).includes(CONSENT_INIT_TRIGGER_ID));
  checks.push(
    consentTag
      ? { id: 'web_consent_defaults', label: 'Web: consent defaults', status: 'pass', detail: `"${String(consentTag.name ?? '')}" fires on Consent Initialization (defaults set before any tag).` }
      : { id: 'web_consent_defaults', label: 'Web: consent defaults', status: 'warn', detail: 'No tag fires on Consent Initialization — Consent Mode v2 defaults are never set. Add one with setup_consent_mode_defaults.' }
  );

  // 4. Per-event web coverage.
  for (const ev of events) {
    const id = `web_event_${ev}`;
    const label = `Web: ${ev}`;
    const tag = webTags.find((t) => t.type === 'gaawe' && tagParam(t, 'eventName') === ev);
    if (!tag) {
      checks.push({ id, label, status: 'fail', detail: `No GA4 event tag sends "${ev}". Create it with setup_ecommerce_funnel or create_ga4_event_tag.` });
      continue;
    }
    const name = String(tag.name ?? '');
    if (tag.paused === true) checks.push({ id, label, status: 'warn', detail: `"${name}" exists but is PAUSED — it never fires.` });
    else if (!Array.isArray(tag.firingTriggerId) || (tag.firingTriggerId as unknown[]).length === 0) checks.push({ id, label, status: 'warn', detail: `"${name}" has NO firing trigger — it never fires.` });
    else if (ecommerceEvents.has(ev) && tagParam(tag, 'sendEcommerceData') !== 'true') checks.push({ id, label, status: 'warn', detail: `"${name}" fires but does not forward the dataLayer ecommerce object (Send Ecommerce data is off) — items/value/currency will be missing.` });
    else checks.push({ id, label, status: 'pass', detail: `"${name}" fires${ecommerceEvents.has(ev) ? ' and forwards ecommerce data' : ''}.` });

    // TAXONOMY (contract): flag an event NAME GA4 will reject or drop.
    const nameClass = classifyEventName(ev);
    if (nameClass.kind === 'reserved' || nameClass.kind === 'malformed') {
      checks.push({ id: `schema_${ev}_name`, label: `Schema: ${ev} name`, status: nameClass.kind === 'reserved' ? 'fail' : 'warn', detail: nameClass.message });
    }
    // SCHEMA (contract): required parameters for a recommended event. When the tag forwards the whole
    // ecommerce object (Send Ecommerce data), the required params ride along — the tool can only assert
    // the PLUMBING, so it names what the site's dataLayer must include for a runtime (DebugView) check.
    const schema = EVENT_CONTRACT[ev];
    if (schema) {
      const sid = `schema_${ev}`;
      const slabel = `Schema: ${ev}`;
      if (schema.category === 'ecommerce' && tagParam(tag, 'sendEcommerceData') === 'true') {
        checks.push({ id: sid, label: slabel, status: 'pass', detail: `Forwards the ecommerce object — the site must push ${schema.requiredParams.join(', ')} in the dataLayer (confirm in GA4 DebugView).` });
      } else {
        const v = validateEventParams(ev, ga4TagParamNames(tag));
        checks.push(
          v.missingRequired.length
            ? { id: sid, label: slabel, status: 'warn', detail: `"${name}" is missing required parameter(s): ${v.missingRequired.join(', ')}${schema.category === 'ecommerce' ? ' — add them or turn on Send Ecommerce data' : ''}.` }
            : { id: sid, label: slabel, status: 'pass', detail: `"${name}" carries the required parameter(s)${v.missingRecommended.length ? ` (recommended still missing: ${v.missingRecommended.join(', ')})` : ''}.` }
        );
      }
    }
  }

  if (server) {
    // 5. A client must claim incoming GA4 requests.
    const ga4Client = server.clients.find((c) => c.type === 'gaaw_client');
    checks.push(
      ga4Client
        ? { id: 'server_client', label: 'Server: GA4 client', status: 'pass', detail: `"${ga4Client.name ?? 'GA4'}" claims incoming GA4 requests.` }
        : { id: 'server_client', label: 'Server: GA4 client', status: 'fail', detail: 'No GA4 client (gaaw_client) — the server container cannot claim incoming requests, so NOTHING is processed.' }
    );

    // 6. The container must know its tagging server URL (liveness is checked separately).
    const urls = server.taggingServerUrls.filter((u) => u && u.trim());
    checks.push(
      urls.length > 0
        ? { id: 'server_tagging_url', label: 'Server: tagging server URL', status: 'pass', detail: urls.join(', ') }
        : { id: 'server_tagging_url', label: 'Server: tagging server URL', status: 'fail', detail: 'No tagging server URL on the container — deploy the host, then record it with set_server_container_tagging_url.' }
    );

    // 7. Per-event relay coverage: a per-event sgtmgaaw tag, else the base relay (no eventName)
    //    which forwards every incoming event.
    const relays = server.tags.filter((t) => t.type === 'sgtmgaaw');
    const baseRelay = relays.find((t) => !tagParam(t, 'eventName') && t.paused !== true && Array.isArray(t.firingTriggerId) && (t.firingTriggerId as unknown[]).length > 0);
    for (const ev of events) {
      const id = `server_event_${ev}`;
      const label = `Server: ${ev}`;
      const tag = relays.find((t) => tagParam(t, 'eventName') === ev);
      if (tag) {
        const name = String(tag.name ?? '');
        if (tag.paused === true) checks.push({ id, label, status: 'warn', detail: `"${name}" exists but is PAUSED.` });
        else if (!Array.isArray(tag.firingTriggerId) || (tag.firingTriggerId as unknown[]).length === 0) checks.push({ id, label, status: 'warn', detail: `"${name}" has NO firing trigger.` });
        else checks.push({ id, label, status: 'pass', detail: `"${name}" relays ${eventTitle(ev)} to GA4.` });
      } else if (baseRelay) {
        checks.push({ id, label, status: 'pass', detail: `Relayed by the base GA4 server tag "${String(baseRelay.name ?? '')}" (forwards all events).` });
      } else {
        checks.push({ id, label, status: 'fail', detail: `No server tag relays "${ev}" — add it with setup_server_ecommerce_funnel or create_server_tag.` });
      }
    }
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const failures = checks.filter((c) => c.status === 'fail').length;
  return { ok: failures === 0, passed, warnings, failures, checks };
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
/** House style for ALL user-visible generated audit text: plain hyphens, never em/en
 *  dashes. Applied at the audit-report boundary so the UI, the on-screen documentation,
 *  and every export (MD/CSV/XLSX/PDF) inherit it without each sanitizing separately. */
export const plainDashes = (t: string): string => t.replace(/[\u2014\u2013]/g, '-');

export const AUDIT_BOUNDARY =
  'Container-only audit: this proves CONFIGURATION, not runtime behaviour. It cannot confirm firing timing, dataLayer contents, PII in actual hits, or live consent behaviour - verify those in Tag Assistant / Network, GA4 DebugView, and your CMP.';

/** Checks a container export CANNOT settle — surfaced so no one assumes they passed. */
export const AUDIT_RUNTIME_REQUIRED: string[] = [
  'Consent timing - load the site with no prior consent and watch the network: do GA4/Ads requests fire BEFORE the user chooses?',
  'Double-firing - does any event (page_view, purchase, …) appear twice in GA4 DebugView for one interaction?',
  'PII in hits - inspect actual /collect requests for email/phone/name in the page path, query params, or event parameters.',
  'dataLayer reality - do custom-event triggers’ events actually push during the real user journey?',
  'Ecommerce integrity - is the items array well-formed (currency/value) in the collect request?',
  'Cross-domain & server IP - correct linker behaviour, and (server-side) the real client IP rather than the edge IP.',
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

/** Reserved GTM built-in trigger ids (All Pages, Initialization, Consent Initialization, DOM Ready,
 *  Window Loaded) live in the 2147479xxx range and are never user-deletable. triggers.list doesn't
 *  return them, but guard anyway so a cleanup never targets one. PURE. */
export function isBuiltinTriggerId(id: string): boolean {
  return /^2147479\d{3}$/.test(id);
}

/** Walk a parameter tree and collect every `triggerReference` value — e.g. a Trigger Group's member
 *  trigger ids. */
function collectTriggerReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectTriggerReferences(v, into);
  } else if (value && typeof value === 'object') {
    const p = value as { type?: unknown; value?: unknown; list?: unknown; map?: unknown };
    if (p.type === 'triggerReference' && typeof p.value === 'string') into.add(p.value);
    collectTriggerReferences(p.list, into);
    collectTriggerReferences(p.map, into);
  }
}

/** Map each trigger id → the trigger ids it references (a Trigger Group → its member triggers). */
function triggerGroupEdges(snapshot: ContainerSnapshot): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const tr of snapshot.triggers) {
    const refs = new Set<string>();
    collectTriggerReferences(tr.parameter, refs);
    if (refs.size) edges.set(tr.triggerId, [...refs]);
  }
  return edges;
}

/** Expand a seed set of USED trigger ids through Trigger Group membership: a group's members count
 *  as used ONLY when the group itself is reached (used). So a trigger referenced solely by a group
 *  that NO tag uses is NOT marked used — it's a real orphan, since nothing live reaches it.
 *  Cycle-safe (a member already in the set is never re-queued). PURE. */
function expandUsedThroughGroups(seed: Set<string>, edges: Map<string, string[]>): Set<string> {
  const used = new Set(seed);
  const queue = [...seed];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const member of edges.get(id) ?? []) {
      if (!used.has(member)) {
        used.add(member);
        queue.push(member);
      }
    }
  }
  return used;
}

/** Every trigger id in USE: referenced by a tag as a FIRING or BLOCKING (exception) trigger, OR a
 *  member of a Trigger Group that is itself used (transitively). A trigger referenced ONLY by an
 *  UNUSED group is NOT in this set — it's an orphan, because nothing live reaches it (the previous
 *  version wrongly marked every group member used regardless of whether the group was). PURE. */
export function collectUsedTriggerIds(snapshot: ContainerSnapshot): Set<string> {
  const seed = new Set<string>();
  for (const t of snapshot.tags) {
    for (const id of t.firingTriggerId ?? []) seed.add(id);
    for (const id of t.blockingTriggerId ?? []) seed.add(id);
  }
  return expandUsedThroughGroups(seed, triggerGroupEdges(snapshot));
}

/** Triggers referenced by NO tag (firing or blocking) and by no USED Trigger Group — orphaned
 *  clutter that is safe to delete — excluding reserved built-in ids. (The GTM API also refuses to
 *  delete a referenced trigger, so deletion is the final safety net.) PURE. */
export function findUnusedTriggers(snapshot: ContainerSnapshot): AuditTrigger[] {
  const used = collectUsedTriggerIds(snapshot);
  return snapshot.triggers.filter((tr) => tr.triggerId !== '' && !used.has(tr.triggerId) && !isBuiltinTriggerId(tr.triggerId));
}

/** All variable NAMES referenced by a {{...}} token anywhere we can read — tag parameters +
 *  consentType, every trigger filter/parameter, and OTHER variables' parameters. ADVISORY: GTM has
 *  more variable-bearing fields than we capture and we can't see published versions, so absence here
 *  is a strong HINT a variable is unused, not proof. PURE. */
export function collectReferencedVariableNames(snapshot: ContainerSnapshot): Set<string> {
  const refs = new Set<string>();
  for (const t of snapshot.tags) {
    refsIn(t.parameter, refs);
    refsIn(t.consentSettings?.consentType, refs);
  }
  for (const tr of snapshot.triggers) {
    refsIn(tr.filter, refs);
    refsIn(tr.autoEventFilter, refs);
    refsIn(tr.customEventFilter, refs);
    refsIn(tr.parameter, refs);
  }
  for (const v of snapshot.variables) refsIn(v.parameter, refs);
  return refs;
}

/** Variables referenced by NO tag, trigger, or other variable in the workspace — likely orphans.
 *  ADVISORY (see collectReferencedVariableNames): unlike triggers, the GTM API does NOT refuse to
 *  delete a referenced variable, so deletion is best-effort — a variable referenced only in a field
 *  this audit can't read, or by a published version, would be wrongly flagged. PURE. */
export function findUnusedVariables(snapshot: ContainerSnapshot): AuditVariable[] {
  const refs = collectReferencedVariableNames(snapshot);
  return snapshot.variables.filter((v) => v.variableId !== '' && !refs.has(v.name));
}

/* ───────────── Broken-variable & variable-type inspector ─────────────
 * Three PURE checks that extend the container audit with variable-health findings:
 *   1) dangling {{references}} — a resource reads a variable that doesn't exist;
 *   2) objectively-broken per-type config (empty Data Layer key, URL QUERY with no
 *      queryKey, cookie with no name, empty Lookup/RegEx table);
 *   3) placeholder/whitespace naming issues across tags + triggers + variables.
 * All reuse the existing reference model (refsIn + the container snapshot). */

/** GTM built-in variable DISPLAY names. A {{Page URL}}-style token resolves to a built-in that never
 *  appears in `snapshot.variables`, so it must NOT be flagged dangling. (This is the enabled-built-ins
 *  DISPLAY name set, not the internal `_`-prefixed keys — those are excluded separately.) */
export const BUILTIN_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  // Page / environment
  'Page URL', 'Page Hostname', 'Page Path', 'Referrer', 'Event',
  'Container ID', 'Container Version', 'Random Number', 'HTML ID',
  'Environment Name', 'Debug Mode',
  // Clicks
  'Click Element', 'Click Classes', 'Click ID', 'Click Target', 'Click URL', 'Click Text',
  // Forms
  'Form Element', 'Form Classes', 'Form ID', 'Form Target', 'Form Text', 'Form URL',
  // Errors
  'Error Message', 'Error URL', 'Error Line',
  // Scroll
  'Scroll Depth Threshold', 'Scroll Depth Units', 'Scroll Direction',
  // Video
  'Video Provider', 'Video Status', 'Video URL', 'Video Title', 'Video Duration',
  'Video Current Time', 'Video Percent', 'Video Visible',
  // History
  'New History Fragment', 'Old History Fragment', 'New History State', 'Old History State', 'History Source',
  // Visibility
  'Percent Visible', 'On-Screen Duration',
]);

/** Read a scalar (template) parameter value off an AuditVariable by key — '' when missing/blank. The
 *  snapshot carries the raw GTM param shape ({type,key,value} for scalars), so we match on `key` and
 *  stringify `value`. Ignores list params (they have no scalar `value`). */
export function varParam(v: AuditVariable, key: string): string {
  const params = Array.isArray(v.parameter) ? v.parameter : [];
  const hit = params.find((p) => p && (p as { key?: unknown }).key === key);
  const val = hit ? (hit as { value?: unknown }).value : undefined;
  return val == null ? '' : String(val);
}

/** True when the variable has NO rows in its `map` list param (an empty Lookup/RegEx table) — the list
 *  is absent, not an array, or an array of length 0. */
function hasEmptyMap(v: AuditVariable): boolean {
  const params = Array.isArray(v.parameter) ? v.parameter : [];
  const map = params.find((p) => p && (p as { key?: unknown }).key === 'map');
  if (!map) return true;
  const list = (map as { list?: unknown }).list;
  return !Array.isArray(list) || list.length === 0;
}

/** For EACH tag / trigger / variable, the variable names it references via {{...}} that are NOT
 *  defined in this workspace, NOT a GTM built-in, and NOT an internal `_`-prefixed built-in (e.g.
 *  {{_event}}) — i.e. DANGLING references that resolve to undefined at runtime. One entry per resource
 *  with ≥1 missing ref. A variable never flags a reference to ITSELF. Skips resources with empty id.
 *  ADVISORY: a "missing" name could still be a published-only variable or a built-in not in our list. PURE. */
export function findDanglingVariableReferences(
  snapshot: ContainerSnapshot,
): Array<{ resource: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string }; missing: string[] }> {
  const defined = new Set(snapshot.variables.map((v) => v.name));
  const results: Array<{ resource: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string }; missing: string[] }> = [];

  const missingFrom = (refs: Set<string>, self?: string): string[] =>
    [...refs].filter(
      (name) =>
        name !== self &&
        !defined.has(name) &&
        !BUILTIN_VARIABLE_NAMES.has(name) &&
        !name.startsWith('_'),
    );

  for (const t of snapshot.tags) {
    if (t.tagId === '') continue;
    const refs = new Set<string>();
    refsIn(t.parameter, refs);
    refsIn(t.consentSettings?.consentType, refs);
    const missing = missingFrom(refs);
    if (missing.length) results.push({ resource: { kind: 'tag', id: t.tagId, name: t.name }, missing });
  }
  for (const tr of snapshot.triggers) {
    if (tr.triggerId === '') continue;
    const refs = new Set<string>();
    refsIn(tr.filter, refs);
    refsIn(tr.autoEventFilter, refs);
    refsIn(tr.customEventFilter, refs);
    refsIn(tr.parameter, refs);
    const missing = missingFrom(refs);
    if (missing.length) results.push({ resource: { kind: 'trigger', id: tr.triggerId, name: tr.name }, missing });
  }
  for (const v of snapshot.variables) {
    if (v.variableId === '') continue;
    const refs = new Set<string>();
    refsIn(v.parameter, refs);
    const missing = missingFrom(refs, v.name); // a variable must not flag a self-reference
    if (missing.length) results.push({ resource: { kind: 'variable', id: v.variableId, name: v.name }, missing });
  }
  return results;
}

/** Per-variable objectively-broken config, by type code. Only these four checks (jsm is covered by C5,
 *  'c' constants are always valid). Each returns a stable checkId + a human-readable issue clause. PURE.
 *   - 'v'  Data Layer:  the dataLayer key ('name') is empty         → always returns undefined
 *   - 'u'  URL(QUERY):  component QUERY but 'queryKey' empty        → nothing to read
 *   - 'k'  1st-party Cookie: cookie name ('name') empty             → nothing to read
 *   - 'smm'/'remm' Lookup / RegEx table: 'map' has no rows          → always returns default/undefined */
export function inspectVariableConfig(
  snapshot: ContainerSnapshot,
): Array<{ variable: AuditVariable; checkId: string; issue: string }> {
  const out: Array<{ variable: AuditVariable; checkId: string; issue: string }> = [];
  for (const v of snapshot.variables) {
    if (v.variableId === '') continue;
    switch (v.type) {
      case 'v':
        if (varParam(v, 'name') === '') {
          out.push({ variable: v, checkId: 'variable-config-dlv', issue: 'has no Data Layer key set — always returns undefined' });
        }
        break;
      case 'u':
        if (varParam(v, 'component') === 'QUERY' && varParam(v, 'queryKey') === '') {
          out.push({ variable: v, checkId: 'variable-config-url', issue: 'reads a URL query parameter but no query key is set' });
        }
        break;
      case 'k':
        if (varParam(v, 'name') === '') {
          out.push({ variable: v, checkId: 'variable-config-cookie', issue: 'has no cookie name set' });
        }
        break;
      case 'smm':
      case 'remm':
        if (hasEmptyMap(v)) {
          out.push({ variable: v, checkId: 'variable-config-lookup', issue: 'has no rows — always returns its default/undefined' });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

const PLACEHOLDER_NAME_RE = /^(untitled|copy of|new (tag|trigger|variable))\b/i;

/** Objective naming issues across tags + triggers + variables:
 *   - placeholder/default names ("Untitled…", "Copy of…", "New Tag/Trigger/Variable…", or empty) → 'placeholder-name'
 *   - stray whitespace (leading/trailing, or a run of ≥2 spaces)                                  → 'name-whitespace'
 *  Subjective prefix-consistency is intentionally out of scope for v1. PURE. */
export function findVariableNamingIssues(
  snapshot: ContainerSnapshot,
): Array<{ resource: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string }; checkId: string; issue: string }> {
  const out: Array<{ resource: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string }; checkId: string; issue: string }> = [];
  const check = (kind: 'tag' | 'trigger' | 'variable', id: string, name: string): void => {
    if (id === '') return;
    const raw = name ?? '';
    if (raw === '' || PLACEHOLDER_NAME_RE.test(raw)) {
      out.push({ resource: { kind, id, name: raw }, checkId: 'placeholder-name', issue: raw === '' ? 'has no name' : `uses a placeholder/default name "${raw}"` });
      return; // one naming finding per resource — a placeholder name subsumes whitespace nits
    }
    if (raw !== raw.trim() || /\s{2,}/.test(raw)) {
      out.push({ resource: { kind, id, name: raw }, checkId: 'name-whitespace', issue: `has stray whitespace in its name "${raw}"` });
    }
  };
  for (const t of snapshot.tags) check('tag', t.tagId, t.name);
  for (const tr of snapshot.triggers) check('trigger', tr.triggerId, tr.name);
  for (const v of snapshot.variables) check('variable', v.variableId, v.name);
  return out;
}

/** Diagnostic: explain the orphaned-trigger count by showing how it would change under looser
 *  definitions. `orphanedStrict` is what the audit reports today (not firing/blocking/group, not
 *  built-in). The "…IfXUnused" variants relax one rule, so the gap between strict and a variant is
 *  exactly the triggers that ONLY that rule keeps out of the orphan set — which pinpoints why a
 *  manual count differs. PURE. */
export function triggerUsageBreakdown(s: ContainerSnapshot): {
  total: number;
  orphaned: number;
  orphanedIfBlockingUnused: number;
  orphanedIfPausedFiringUnused: number;
} {
  const firingAny = new Set<string>();
  const firingActive = new Set<string>(); // firing trigger of a NON-paused tag
  const blocking = new Set<string>();
  for (const t of s.tags) {
    for (const id of t.firingTriggerId ?? []) {
      firingAny.add(id);
      if (!t.paused) firingActive.add(id);
    }
    for (const id of t.blockingTriggerId ?? []) blocking.add(id);
  }
  const edges = triggerGroupEdges(s);
  const real = s.triggers.filter((tr) => tr.triggerId !== '' && !isBuiltinTriggerId(tr.triggerId));
  const orphansFor = (seed: Set<string>): number => {
    const used = expandUsedThroughGroups(seed, edges);
    return real.filter((tr) => !used.has(tr.triggerId)).length;
  };
  return {
    total: s.triggers.length,
    // Matches findUnusedTriggers: seed = firing ∪ blocking, expanded through USED groups.
    orphaned: orphansFor(new Set([...firingAny, ...blocking])),
    // Drop blocking from the seed → reveals triggers used ONLY as an exception/blocking trigger.
    orphanedIfBlockingUnused: orphansFor(new Set(firingAny)),
    // Count only firing triggers of UNPAUSED tags → reveals triggers that fire only paused tags.
    orphanedIfPausedFiringUnused: orphansFor(new Set([...firingActive, ...blocking])),
  };
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

  // Tag Sequencing is matched by tag NAME in the GTM API, so resolve setup/teardown
  // references (and their paused state) against the tags actually present.
  const tagByName = new Map(s.tags.map((t) => [t.name, t]));

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

    // Tag Sequencing integrity. Only PROVABLE defects are flagged (no "this tag should be
    // sequenced" guessing): a reference to a tag that does not exist, and a setup/cleanup
    // dependency on a PAUSED tag (so the sequenced step silently does not run).
    for (const seq of [
      ...(t.setupTag ?? []).map((e) => ({ ...e, role: 'setup' as const })),
      ...(t.teardownTag ?? []).map((e) => ({ ...e, role: 'teardown' as const })),
    ]) {
      const ref = tagByName.get(seq.tagName);
      const before = seq.role === 'setup';
      const phrase = before ? 'fires BEFORE it (setup)' : 'fires AFTER it (cleanup)';
      if (!ref) {
        findings.push({
          severity: 'high',
          category: 'sequencing',
          checkId: 'SEQ-DANGLING',
          resource,
          message: `Tag "${t.name}" is sequenced so that "${seq.tagName}" ${phrase}, but no tag named "${seq.tagName}" exists in this workspace — the sequence is broken.`,
          recommendation: `Point the sequence at a real tag (names must match EXACTLY, including spaces and case), or remove the sequencing from "${t.name}".`,
          autoFixable: false,
        });
      } else if (ref.paused) {
        const stopOnFail = before && (seq as { stopOnSetupFailure?: boolean }).stopOnSetupFailure === true;
        findings.push({
          severity: stopOnFail ? 'high' : 'medium',
          category: 'sequencing',
          checkId: 'SEQ-PAUSED-DEP',
          resource,
          message:
            `Tag "${t.name}" sequences the ${before ? 'setup' : 'cleanup'} tag "${seq.tagName}", but that tag is PAUSED, so the ${before ? 'setup' : 'cleanup'} step will not run` +
            (stopOnFail ? ` — and because "Don't fire if the setup tag fails" is on, "${t.name}" may not fire at all.` : '.'),
          recommendation: `Unpause "${seq.tagName}" if the sequence should run, or remove the sequencing from "${t.name}" if the dependency is no longer needed.`,
          autoFixable: false,
        });
      }
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

  // Unused triggers — orphans referenced by no tag (as a FIRING or a BLOCKING/exception trigger)
  // and not a Trigger Group member (findUnusedTriggers also skips reserved built-in ids).
  for (const tr of findUnusedTriggers(s)) {
    findings.push({
      severity: 'low',
      category: 'unused',
      resource: { kind: 'trigger', id: tr.triggerId, name: tr.name },
      message: `Trigger "${tr.name}" isn't used by any tag.`,
      recommendation: 'Delete it if it is not needed — unused triggers add clutter and unnecessary listeners. Use delete_unused_gtm_triggers to remove all unused triggers at once (or a selected subset).',
      autoFixable: true,
      fix: { tool: 'delete_gtm_trigger', args: { triggerId: tr.triggerId, name: tr.name } },
    });
  }

  // Unused variables — referenced by no tag, trigger, or other variable. We scan
  // every {{variable}}-bearing field we capture (tag parameters + consentSettings,
  // all trigger filters + generic parameters, variable parameters). This is
  // ADVISORY ONLY (no auto-fix): the workspace snapshot can't see published
  // versions, and GTM has more variable-bearing fields than we capture, so a
  // "no references found" result is a strong hint — not proof — that a variable
  // is safe to delete. Deleting is left to the user via delete_gtm_variable.
  const refs = collectReferencedVariableNames(s);
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
  for (const v of findUnusedVariables(s)) {
    findings.push({
      severity: 'low',
      category: 'unused',
      checkId: 'unused-variable',
      resource: { kind: 'variable', id: v.variableId, name: v.name },
      message: `Variable "${v.name}" appears unused — no tag, trigger, or variable in this workspace references it.`,
      recommendation:
        'Delete it if it is truly unused — delete_unused_gtm_variables removes all orphans at once (or a selected subset). First confirm it is NOT relied on by a published version or a field this audit cannot inspect (unlike triggers, GTM lets you delete a referenced variable, which silently breaks that reference).',
      autoFixable: true,
      fix: { tool: 'delete_gtm_variable', args: { variableId: v.variableId, name: v.name } },
    });
  }

  // Broken-variable & variable-type inspector — three extensions to the variable audit.
  //
  // (a) Dangling {{references}}: a tag/trigger/variable reads a variable that this workspace does NOT
  //     define and that isn't a GTM built-in → it resolves to undefined at runtime. ADVISORY (Medium /
  //     Likely, no auto-fix): the missing name could be a published-only variable or a built-in not in
  //     our list, so we recommend rather than mutate.
  for (const d of findDanglingVariableReferences(s)) {
    const list = d.missing.map((m) => `{{${m}}}`).join(', ');
    const noun = d.resource.kind;
    findings.push({
      severity: 'medium',
      confidence: 'likely',
      category: 'variable',
      checkId: 'dangling-variable-ref',
      resource: { kind: d.resource.kind, id: d.resource.id, name: d.resource.name },
      message: `${noun.charAt(0).toUpperCase() + noun.slice(1)} "${d.resource.name}" references ${d.missing.length > 1 ? 'variables' : 'a variable'} that no variable in this workspace defines: ${list} — ${d.missing.length > 1 ? 'they' : 'it'} will be undefined at runtime.`,
      recommendation: 'Create the variable or fix the {{reference}} (check it isn\'t a renamed/deleted variable or a disabled built-in).',
      autoFixable: false,
    });
  }

  // (b) Objectively-broken per-type config (Data Layer key / URL query key / cookie name / empty
  //     Lookup table). Certain — provable from the container — so Medium / Certain, no auto-fix.
  for (const c of inspectVariableConfig(s)) {
    findings.push({
      severity: 'medium',
      confidence: 'certain',
      category: 'variable',
      checkId: c.checkId,
      resource: { kind: 'variable', id: c.variable.variableId, name: c.variable.name },
      message: `Variable "${c.variable.name}" ${c.issue}.`,
      recommendation:
        c.checkId === 'variable-config-dlv'
          ? 'Set the Data Layer Variable Name (the dataLayer key this variable should read).'
          : c.checkId === 'variable-config-url'
            ? 'Set the Query Key this URL variable should read (the ?name= parameter).'
            : c.checkId === 'variable-config-cookie'
              ? 'Set the cookie name this 1st-Party Cookie variable should read.'
              : 'Add at least one row to the table, or delete the variable if it is not needed.',
      autoFixable: false,
    });
  }

  // (c) Placeholder / whitespace naming issues across tags + triggers + variables. Low / Certain.
  for (const n of findVariableNamingIssues(s)) {
    findings.push({
      severity: 'low',
      confidence: 'certain',
      category: 'naming',
      checkId: n.checkId,
      resource: { kind: n.resource.kind, id: n.resource.id, name: n.resource.name },
      message: `${n.resource.kind.charAt(0).toUpperCase() + n.resource.kind.slice(1)} "${n.resource.name}" ${n.issue}.`,
      recommendation: 'Rename to a descriptive, convention-consistent name.',
      autoFixable: false,
    });
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
    message: plainDashes(f.message),
    recommendation: plainDashes(f.recommendation),
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


export const AUDIT_SERVER_BOUNDARY =
  'Server-container audit: this proves the server CONFIGURATION (a client to claim requests, server tags with their destination ids, no silent gaps) - NOT that the tagging server is deployed/reachable or that data actually flows. Confirm the live server with verify_server_endpoint, the web container\'s server_container_url, and GTM Preview on the server container.';

export const AUDIT_SERVER_RUNTIME_REQUIRED: string[] = [
  'Server reachable - is the tagging-server host deployed and responding (GET <url>/healthy)?',
  'Web→server flow - is the web Google tag\'s server_container_url pointed at this server, so requests actually arrive?',
  'Client claim - on a live request, does the GA4 client claim it and do the server tags fire (GTM Preview on the server container)?',
];

/** The Google destination server-tag types — each depends on the GA4 (gaaw) client
 *  claiming the incoming gtag/GA4 request, so any of them implies a gaaw_client is needed. */
const GOOGLE_SERVER_TAG_TYPES = new Set(['sgtmgaaw', 'sgtmadsct', 'sgtmadscl', 'sgtmadsremarket']);

/** The string value of a named row inside a CAPI list param ('' when absent), e.g. the Snapchat
 *  serverParameters test_event_code row. PURE. */
function capiListRowValue(t: AuditTag, listKey: string, rowName: string): string {
  const list = (Array.isArray(t.parameter) ? t.parameter : []).find((p) => (p as { key?: string }).key === listKey) as
    | { list?: Array<{ map?: Array<{ key?: string; value?: unknown }> }> } | undefined;
  for (const row of list?.list ?? []) {
    const m = row.map ?? [];
    if (m.find((e) => e.key === 'name')?.value === rowName) {
      const v = m.find((e) => e.key === 'value')?.value;
      return typeof v === 'string' ? v : '';
    }
  }
  return '';
}

/** Does a CAPI tag carry a non-empty row named `rowName` inside its list param `listKey`? Meta stores an
 *  explicit dedup event_id as a serverEventDataList row {name:'event_id'} — an OVERRIDE of the value the
 *  stape template auto-extracts, so its PRESENCE proves an id is sent (its absence proves nothing, because
 *  auto-map may still forward one). Reads the list param directly (serverTagParam only reads
 *  string/template params). PURE. */
function capiListRowSet(t: AuditTag, listKey: string, rowName: string): boolean {
  const list = (Array.isArray(t.parameter) ? t.parameter : []).find((p) => (p as { key?: string }).key === listKey) as
    | { list?: Array<{ map?: Array<{ key?: string; value?: unknown }> }> }
    | undefined;
  for (const row of list?.list ?? []) {
    const m = row.map ?? [];
    const name = m.find((e) => e.key === 'name')?.value;
    const val = m.find((e) => e.key === 'value')?.value;
    if (name === rowName && typeof val === 'string' && val.trim() !== '') return true;
  }
  return false;
}

/** Is a boolean template param EXPLICITLY set to false on the tag? Absent → returns false, mirroring the
 *  stape templates' `hasOwnProperty(x) ? data[x] : true` guard (a MISSING auto-map toggle DEFAULTS ON, so
 *  absence must not read as off). Only a present-and-false toggle proves the auto-extraction path is
 *  disabled. PURE. */
function serverToggleExplicitlyOff(t: AuditTag, key: string): boolean {
  const p = (Array.isArray(t.parameter) ? t.parameter : []).find((x) => (x as { key?: string }).key === key) as { value?: unknown } | undefined;
  if (!p) return false;
  return p.value === false || p.value === 'false';
}

/** Canonical, order-independent signature of a trigger's CONDITIONS (operator + sorted
 *  args across every filter list). Two triggers that fire on the same conditions under
 *  different ids/names share a signature — the key to detecting duplicate GA4 relays whose
 *  triggers are equivalent even though their ids differ. PURE. */
function serverTriggerSignature(tr: AuditTrigger): string {
  const conds: string[] = [];
  const add = (arr?: Array<Record<string, unknown>>): void => {
    for (const f of arr ?? []) {
      const op = String((f as { type?: unknown }).type ?? '');
      const args = (((f as { parameter?: Array<{ key?: string; value?: unknown }> }).parameter) ?? [])
        .map((p) => `${p.key}=${String(p.value ?? '')}`)
        .sort();
      conds.push(`${op}(${args.join('&')})`);
    }
  };
  add(tr.filter);
  add(tr.customEventFilter);
  add(tr.autoEventFilter);
  conds.sort();
  return `${tr.type}|${conds.join(';')}`;
}

/** Normalize a GTM condition operator to a casing-agnostic key. Container EXPORT JSON emits
 *  operators UPPER_SNAKE ("STARTS_WITH"); the LIVE API emits camelCase ("startsWith"). Lowercase
 *  + strip underscores so both map to the same token. PURE. */
function normOp(op: string): string {
  return op.toLowerCase().replace(/_/g, '');
}

/** GTM condition operators that match their value LITERALLY (an event name / URL text), in
 *  normalized form (see normOp). Regex operators are excluded from the URL-encoding scan because
 *  '+' is a legal quantifier there — flagging it would be a false positive. */
const LITERAL_MATCH_OPS = new Set(['equals', 'contains', 'startswith', 'endswith']);

/** URL-encoded text pasted into a literal filter value: a '+' between word chars (encoded
 *  space, e.g. "Sign+Petition+Click") or a %XX escape (%20, %2F, …). GTM matches DECODED
 *  dataLayer event names, so such a value can never match → the filter is dead. PURE. */
function looksUrlEncoded(value: string): boolean {
  return /\w\+\w/.test(value) || /%[0-9A-Fa-f]{2}/.test(value);
}

/** Audit a SERVER container: a client must claim requests, server tags need their
 *  destination id + a firing trigger and shouldn't be paused, and the host should be
 *  provisioned. Returns the same AuditReport shape as the web audit. PURE. */

/** Managed-host DEFAULT domains a tagging server commonly runs on before a custom domain is set
 *  up (Cloud Run, App Engine, Stape's shared domain, workers, PaaS hosts). Cookies set from these
 *  are THIRD-PARTY to the user's site: the FPID/_ga cookies the GA4 client sets ride the server's
 *  domain, ITP caps them, and the first-party benefit of server-side tagging is lost - the exact
 *  problem Stape's custom-subdomain step exists to prevent. */
const SHARED_TAGGING_HOSTS = [
  'run.app',
  'appspot.com',
  'cloudfunctions.net',
  'stape.io',
  'herokuapp.com',
  'azurewebsites.net',
  'vercel.app',
  'netlify.app',
  'workers.dev',
] as const;

/** Warn when a tagging-server URL is a shared managed host rather than a first-party subdomain
 *  of the user's site. Returns the human-readable warning, or null when the URL looks fine (or
 *  is unparseable - the caller's own URL validation should speak to that). PURE. */
export function taggingUrlFirstPartyIssue(serverUrl: string): string | null {
  let host = '';
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = SHARED_TAGGING_HOSTS.find((d) => host === d || host.endsWith(`.${d}`));
  if (!hit) return null;
  return (
    `Tagging server URL host "${host}" is a shared ${hit} domain, not a subdomain of your site. ` +
    'Cookies the server sets (FPID, _ga) will be THIRD-party there, so ITP caps them and the ' +
    'first-party benefit of server-side tagging is lost. Point a custom subdomain of the site ' +
    '(e.g. sgtm.yourdomain.com) at the server host and use that URL instead.'
  );
}


/* ── Template field discovery (ported from the MCP server's templateFields.ts) ──
 * Creating a vendor tag needs two undocumented things: the string that goes in `type`, and the
 * parameter keys that tag expects. Google publishes neither for its ~68 native vendor templates,
 * and every gallery template invents its own field names. GTM accepts a tag with wrong keys and
 * then renders it blank - so these discover both instead of guessing. */

export interface TemplateField {
  /** The key to use in a tag's `parameter` array. */
  name: string;
  /** GTM's field widget type, e.g. TEXT, SELECT, CHECKBOX, SIMPLE_TABLE. */
  type: string;
  /** The label shown in the GTM interface, when the template gives one. */
  displayName?: string;
  /** True when the field must be filled for the tag to validate. */
  required?: boolean;
  /** Allowed values, for SELECT fields. */
  options?: string[];
  /** Column keys, for table fields, since those nest their own parameters. */
  subFields?: string[];
}

/** Pulls the field declarations out of a template's own source: the ___TEMPLATE_PARAMETERS___
 *  block of a .tpl file is the authoritative schema and ships with the template itself. The parse
 *  is deliberately forgiving (trailing commas are common in the wild); an unreadable schema
 *  degrades to null rather than throwing. PURE. */
export function parseTemplateParameters(templateData: string): TemplateField[] | null {
  const src = templateData ?? '';
  const start = src.indexOf('___TEMPLATE_PARAMETERS___');
  if (start < 0) return null;
  const after = src.slice(start + '___TEMPLATE_PARAMETERS___'.length);
  const end = after.search(/\n___[A-Z0-9_]+___/);
  const block = (end >= 0 ? after.slice(0, end) : after).trim();
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    try {
      parsed = JSON.parse(block.replace(/,\s*([\]}])/g, '$1'));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const fields: TemplateField[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = typeof p['name'] === 'string' ? p['name'] : '';
    if (!name) continue;
    const validators = Array.isArray(p['valueValidators']) ? (p['valueValidators'] as Record<string, unknown>[]) : [];
    const required = validators.some((v) => v && v['type'] === 'NON_EMPTY');
    const selectItems = Array.isArray(p['selectItems']) ? (p['selectItems'] as Record<string, unknown>[]) : [];
    const options = selectItems
      .map((sel) => (typeof sel?.['value'] === 'string' ? (sel['value'] as string) : null))
      .filter((v): v is string => Boolean(v));
    const subParams = Array.isArray(p['subParams']) ? (p['subParams'] as Record<string, unknown>[]) : [];
    const subFields = subParams
      .map((sub) => (typeof sub?.['name'] === 'string' ? (sub['name'] as string) : null))
      .filter((v): v is string => Boolean(v));
    fields.push({
      name,
      type: typeof p['type'] === 'string' ? (p['type'] as string) : 'UNKNOWN',
      ...(typeof p['displayName'] === 'string' ? { displayName: p['displayName'] as string } : {}),
      ...(required ? { required: true } : {}),
      ...(options.length ? { options } : {}),
      ...(subFields.length ? { subFields } : {}),
    });
  }
  return fields;
}

export interface TagTypeProfile {
  type: string;
  count: number;
  /** Parameter keys seen on tags of this type, most common first. */
  parameterKeys: string[];
  /** Keys present on EVERY tag of this type, so almost certainly required. */
  alwaysPresent: string[];
  /** A real tag name using this type, to look at in the interface. */
  exampleTagName: string;
}

/** Groups a workspace's tags by type and reports the parameter keys each type actually uses.
 *  A key on EVERY tag of a type (`alwaysPresent`) is as close to a required-field list as an
 *  undocumented native template gets. PURE. */
export function summariseTagTypes(
  tags: { type?: string | null; name?: string | null; parameter?: unknown }[]
): TagTypeProfile[] {
  const byType = new Map<string, { count: number; keys: Map<string, number>; example: string }>();
  for (const tag of tags) {
    const type = (tag?.type ?? '').trim();
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, { count: 0, keys: new Map(), example: tag?.name || '(unnamed)' });
    const entry = byType.get(type)!;
    entry.count++;
    const params = Array.isArray(tag.parameter) ? tag.parameter : tag.parameter ? [tag.parameter] : [];
    const seen = new Set<string>();
    for (const p of params as Record<string, unknown>[]) {
      const key = typeof p?.['key'] === 'string' ? (p['key'] as string) : '';
      if (key) seen.add(key);
    }
    for (const key of seen) entry.keys.set(key, (entry.keys.get(key) ?? 0) + 1);
  }
  return [...byType.entries()]
    .map(([type, e]) => ({
      type,
      count: e.count,
      parameterKeys: [...e.keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      alwaysPresent: [...e.keys.entries()].filter(([, n]) => n === e.count).map(([k]) => k).sort(),
      exampleTagName: e.example,
    }))
    .sort((a, b) => b.count - a.count);
}

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
  } else {
    const fpIssue = s.taggingServerUrls.map(taggingUrlFirstPartyIssue).find((w) => w !== null);
    if (fpIssue) {
      push({
        severity: 'medium',
        confidence: 'likely',
        category: 'ga4',
        message: fpIssue,
        recommendation:
          'Set up a custom subdomain (CNAME to the tagging host), then update it with set_server_container_tagging_url and re-point the web Google tag with set_web_server_container_url.',
        autoFixable: false,
      });
    }
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

  const triggers = s.triggers ?? [];
  const trigById = new Map(triggers.map((tr) => [tr.triggerId, tr]));

  // (1) DUPLICATE GA4 RELAY — 2+ ACTIVE GA4 server tags forwarding the SAME Measurement ID
  //     AS THE SAME outgoing event on equivalent triggers means every event is counted once
  //     PER duplicate in GA4. Group active sgtmgaaw tags by (measurementId + outgoing eventName
  //     override + firing-condition signature): the signature collapses triggers with identical
  //     conditions (or the same all-events relay) even when their ids differ, which is exactly how
  //     the corpus pair double-fired ("GA4 Tag" + "Google Analytics GA4", both on a "Client Name
  //     equals GA4" trigger with no eventName override). Guards against two false positives: a tag
  //     with NO firing trigger never fires (so it can't double-count — already flagged above), and
  //     two relays that stamp DIFFERENT event names are complementary, not duplicates.
  const firingSignature = (t: AuditTag): string =>
    (t.firingTriggerId ?? [])
      .map((id) => {
        const tr = trigById.get(id);
        return tr ? serverTriggerSignature(tr) : `#${id}`;
      })
      .sort()
      .join('||');
  const relayGroups = new Map<string, AuditTag[]>();
  for (const t of s.tags) {
    if (t.type !== 'sgtmgaaw' || t.paused) continue;
    if (!(t.firingTriggerId ?? []).length) continue; // never fires → can't double-count
    const mid = serverTagParam(t, 'measurementId').trim();
    if (!mid) continue; // a blank id is already flagged above
    const eventName = serverTagParam(t, 'eventName').trim(); // '' = forwards each event's own name
    const key = `${mid}\n${eventName}\n${firingSignature(t)}`;
    const arr = relayGroups.get(key) ?? [];
    arr.push(t);
    relayGroups.set(key, arr);
  }
  for (const group of relayGroups.values()) {
    if (group.length < 2) continue;
    const mid = serverTagParam(group[0], 'measurementId').trim();
    const names = group.map((t) => `"${t.name}"`).join(', ');
    const dup = group[group.length - 1];
    push({
      severity: 'critical',
      category: 'ga4',
      resource: { kind: 'tag', id: dup.tagId, name: dup.name },
      message: `${group.length} active GA4 server tags (${names}) all forward Measurement ID ${mid} for the same event on equivalent triggers — every event is counted ${group.length}× in GA4.`,
      recommendation: 'Keep ONE GA4 relay for this Measurement ID; pause or delete the duplicate(s) so each event is sent once.',
      autoFixable: false,
    });
  }

  // (2) URL-ENCODED EVENT-NAME VALUES — a literal (non-regex) condition on the EVENT NAME ({{_event}})
  //     whose value carries URL-encoding ("Sign+Petition+Click", %20, %2F) can never equal/contain a
  //     DECODED dataLayer event name, so the trigger is dead. Scoped to {{_event}} conditions ONLY:
  //     on a URL / page_location variable, '+' and %XX are LEGITIMATE URL characters that the value
  //     genuinely retains and matches (this codebase's own buildServerEventTrigger pageUrlContains makes
  //     `{{ed - page_location}} contains "…"` conditions), so flagging those would be a false positive.
  //     Variable-ref match values + regex ops are also skipped.
  for (const tr of triggers) {
    const bad: string[] = [];
    const scan = (arr?: Array<Record<string, unknown>>): void => {
      for (const f of arr ?? []) {
        const op = String((f as { type?: unknown }).type ?? '');
        if (!LITERAL_MATCH_OPS.has(normOp(op))) continue;
        const cparams = ((f as { parameter?: Array<{ key?: string; value?: unknown }> }).parameter) ?? [];
        // Only the event-name input makes URL-encoding "dead": GTM matches the DECODED {{_event}}.
        const arg0 = cparams.find((p) => p.key === 'arg0');
        if (String((arg0 as { value?: unknown } | undefined)?.value ?? '') !== '{{_event}}') continue;
        const arg1 = cparams.find((p) => p.key === 'arg1');
        const v = typeof (arg1 as { value?: unknown } | undefined)?.value === 'string' ? String((arg1 as { value?: string }).value) : '';
        if (!v || isVariableRef(v)) continue;
        if (looksUrlEncoded(v)) bad.push(v);
      }
    };
    scan(tr.filter);
    scan(tr.customEventFilter);
    scan(tr.autoEventFilter);
    if (bad.length) {
      push({
        severity: 'high',
        category: 'firing',
        resource: { kind: 'trigger', id: tr.triggerId, name: tr.name },
        message: `Trigger "${tr.name}" filters on URL-encoded text (${bad.map((v) => `"${v}"`).join(', ')}) — GTM matches DECODED event names, so this condition never matches and the trigger is dead.`,
        recommendation: 'Replace the encoded value with the real decoded text (e.g. "Sign+Petition+Click" → "Sign Petition Click").',
        autoFixable: false,
      });
    }
  }

  // (3)+(4) SWAPPED CREDENTIAL FIELDS + LEFTOVER TEST EVENT CODE — for each CAPI server template whose
  //     two credential fields have DISTINCTIVE shapes, flag a paste-into-the-wrong-box (the tag can't
  //     authenticate), and flag a test code left on before go-live. Values are NEVER echoed - only their
  //     shape. Covers Meta, Snapchat and Microsoft; TikTok/LinkedIn/Pinterest/Reddit credential fields are
  //     not distinctive enough to check without false positives, so they are left out.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const t of s.tags) {
    const resource = { kind: 'tag' as const, id: t.tagId, name: t.name };
    // Per-platform: the two credential field keys, their human labels, the "swapped" shape test, and how a
    // test event code is stored (Meta: a top-level testId param; Snapchat: a serverParameters row;
    // Microsoft: none). Order matters - Meta is matched first so a shared-key overlap never misroutes.
    let cred:
      | { platform: string; idLabel: string; tokenLabel: string; idVal: string; tokenVal: string;
          swapped: boolean; testValue: string; autoFixParam?: string }
      | null = null;
    if (isMetaCapiServerTag(t)) {
      const idVal = serverTagParam(t, 'pixelId').trim(); const tokenVal = serverTagParam(t, 'accessToken').trim();
      cred = {
        platform: 'Meta', idLabel: 'Pixel ID', tokenLabel: 'Access Token', idVal, tokenVal,
        // Pixel ID is a ~15-digit number; the token is a long "EAA…" string.
        swapped: (!isVariableRef(idVal) && (idVal.startsWith('EAA') || idVal.length > 100)) || (!isVariableRef(tokenVal) && /^\d{14,16}$/.test(tokenVal)),
        testValue: serverTagParam(t, 'testId').trim(), autoFixParam: 'testId',
      };
    } else if (isSnapchatCapiServerTag(t)) {
      const idVal = serverTagParam(t, 'pixelId').trim(); const tokenVal = serverTagParam(t, 'apiAccessToken').trim();
      cred = {
        platform: 'Snapchat', idLabel: 'Pixel ID', tokenLabel: 'API Access Token', idVal, tokenVal,
        // Snap Pixel ID is a UUID; the token is a long opaque string. A UUID in the token field, or a long
        // non-UUID in the pixel field, is a swap.
        swapped: (!isVariableRef(idVal) && !UUID_RE.test(idVal) && idVal.length > 60) || (!isVariableRef(tokenVal) && UUID_RE.test(tokenVal)),
        // Snap stores the test code as a serverParameters row (no top-level testId param), so it is not auto-fixable.
        testValue: capiListRowValue(t, 'serverParameters', 'test_event_code').trim(),
      };
    } else if (isMicrosoftCapiServerTag(t)) {
      const idVal = serverTagParam(t, 'uetTagId').trim(); const tokenVal = serverTagParam(t, 'authToken').trim();
      cred = {
        platform: 'Microsoft Ads', idLabel: 'UET Tag ID', tokenLabel: 'API Token', idVal, tokenVal,
        // UET Tag ID is a short id; authToken is a long token. A long value in the id field or a short
        // numeric in the token field is a swap. Microsoft's template has no test-event-code concept.
        swapped: (!isVariableRef(idVal) && idVal.length > 40) || (!isVariableRef(tokenVal) && /^\d{4,12}$/.test(tokenVal)),
        testValue: '',
      };
    }
    if (!cred) continue;

    if (cred.swapped) {
      push({
        severity: 'high', category: 'security', resource,
        message: `${cred.platform} CAPI tag "${t.name}" looks like its ${cred.idLabel} and ${cred.tokenLabel} are swapped — one field holds a value shaped like the other, so the tag can't authenticate and sends nothing.`,
        recommendation: `Swap them back: the ${cred.idLabel} and the ${cred.tokenLabel} were pasted into the wrong fields.`,
        autoFixable: false,
      });
    }
    if (cred.testValue && !isVariableRef(cred.testValue)) {
      push({
        severity: 'medium', category: 'ga4', resource,
        message: `${cred.platform} CAPI tag "${t.name}" still has a Test Event Code set — its events land in the destination's TEST view, not production reporting.`,
        recommendation: 'Clear the Test Event Code before go-live so events count in production.',
        autoFixable: Boolean(cred.autoFixParam),
        ...(cred.autoFixParam ? { fix: { tool: 'update_gtm_tag', args: { tagId: t.tagId, tag: { parameter: [{ type: 'template', key: cred.autoFixParam, value: '' }] } } } } : {}),
      });
    }
  }

  // (5) CAPI DEDUP event_id NOT GUARANTEED (Meta / TikTok, server-side, CONDITIONAL) — Meta and TikTok
  //     dedupe a browser Pixel event against the server CAPI event by a shared event_id. It is TEMPTING to
  //     flag any CAPI tag that carries no explicit event_id field, but that is a FALSE POSITIVE: both stape
  //     templates AUTO-EXTRACT event_id from the incoming event (getAllEventData → event_id ||
  //     transaction_id) whenever their auto-map toggle is on, and that toggle DEFAULTS ON. So a tag with no
  //     explicit id still forwards one at runtime as long as the (server-invisible) web side sends it. The
  //     ONLY config-visible state that PROVES the tag won't send an id is: the auto-map toggle is
  //     EXPLICITLY off AND no explicit id is mapped. Even then a double-count only happens if a browser
  //     Pixel also fires the same conversion — which this container cannot see — so it is LOW +
  //     runtime-required and phrased as guidance, not a proven defect. Toggle field: Meta
  //     autoMapServerEventData, TikTok autoMapCommonEventData (absent = default on = NOT flagged). Verified
  //     against stape-io/facebook-tag (template.tpl) + stape-io/tiktok-tag (template.js).
  //     LinkedIn (unconditional getAllEventData, NO toggle) and Pinterest (autoMapServerEventDataParameters
  //     default on) are NOT config-checkable — a server-only audit can never prove they omit event_id — so
  //     they are intentionally left OUT of this check (adding a false-positive flag for them is worse than
  //     silence). Skips paused / never-firing tags (they can't double-count).
  for (const t of s.tags) {
    if (t.paused || !(t.firingTriggerId ?? []).length) continue;
    let platform: string | null = null;
    let toggle: string | null = null; // the auto-map toggle field, or null when the template has none (Snap)
    let autoMapOff = false;
    let hasExplicitId = false;
    if (isMetaCapiServerTag(t)) {
      platform = 'Meta'; toggle = 'autoMapServerEventData';
      autoMapOff = serverToggleExplicitlyOff(t, toggle);
      hasExplicitId = capiListRowSet(t, 'serverEventDataList', 'event_id');
    } else if (isTikTokCapiServerTag(t)) {
      platform = 'TikTok'; toggle = 'autoMapCommonEventData';
      autoMapOff = serverToggleExplicitlyOff(t, toggle);
      hasExplicitId = serverTagParam(t, 'eventId').trim() !== '';
    } else if (isMicrosoftCapiServerTag(t)) {
      platform = 'Microsoft'; toggle = 'autoMapServerEventDataParameters';
      autoMapOff = serverToggleExplicitlyOff(t, toggle);
      hasExplicitId = capiListRowSet(t, 'serverEventDataList', 'eventId');
    } else if (isSnapchatCapiServerTag(t)) {
      // The Snapchat template maps serverParameters MANUALLY - it has no auto-extract toggle, so a missing
      // event_id row is a config-provable gap (autoMapOff is effectively always true).
      platform = 'Snapchat'; toggle = null; autoMapOff = true;
      hasExplicitId = capiListRowSet(t, 'serverParameters', 'event_id');
    }
    if (!platform || !autoMapOff || hasExplicitId) continue;
    const cause = toggle
      ? `has auto-map (${toggle}) turned off and maps no explicit event_id`
      : 'maps no explicit event_id and this template does not auto-extract one';
    const remedyToggle = toggle ? `, or re-enable auto-mapping (${toggle}) so the tag forwards the event's own event_id` : '';
    push({
      severity: 'low',
      confidence: 'runtime-required',
      category: 'ga4',
      // Stable id for the browser↔server dedup finding, so consumers (e.g. the unified tracking-status
      // dedup dimension) match on this instead of the finding's prose, which is free to be reworded.
      checkId: 'server_capi_no_event_id',
      resource: { kind: 'tag', id: t.tagId, name: t.name },
      message: `${platform} CAPI server tag "${t.name}" ${cause}, so it only sends one if the incoming event already carries it — which can't be confirmed from the server container. If the same conversion also fires the browser ${platform} Pixel without a shared event_id, the browser and server events can double-count.`,
      recommendation: `Map an explicit event_id on this tag (e.g. {{ed - event_id}}) and send the SAME id from the browser ${platform} Pixel${remedyToggle}. If you run server-only (no Pixel), you can ignore this.`,
      autoFixable: false,
    });
  }

  // ── Meta CAPI present but NO Data Tag -> Data Client enrichment (opportunity, not a defect) ──
  // A CAPI event can only match on the identity the browser sent it. The Stape Data Tag posts
  // first-party identity on EVERY page and the server Data Client persists it, so a conversion that
  // arrives WITHOUT identity still matches - the enrichment that raises Meta Event Match Quality.
  // Detect the Data Client by its own field signature (same as findStapeDataClient, inlined to avoid a
  // server-plan -> gtm-builders import cycle). Config-visible, but the EMQ gain is a runtime outcome.
  const hasMetaCapi = s.tags.some((t) => !t.paused && isMetaCapiServerTag(t));
  const hasDataClient = s.clients.some((c) => {
    const keys = new Set((c.parameter ?? []).map((p) => String((p as { key?: string }).key ?? '')));
    return keys.has('generateClientId') || keys.has('prolongCookies') || keys.has('acceptMultipleEvents') || /data\s*client/i.test(c.name);
  });
  if (hasMetaCapi && !hasDataClient) {
    push({
      severity: 'low',
      confidence: 'runtime-required',
      category: 'ga4',
      checkId: 'server_capi_no_data_enrichment',
      message: 'A Meta CAPI server tag is set up but this container has NO Stape Data Tag -> Data Client enrichment, so the CAPI event only carries the identity the browser sent - Event Match Quality is likely lower than it could be.',
      recommendation: 'Set up the enrichment with create_stape_data_pipeline: a web Data Tag posts first-party identity (em/ph/fbp/fbc/IP/UA) on every page and a server Data Client persists it, so conversions without identity still match. Then build the Meta CAPI tag with mapEmqVariables on.',
      autoFixable: false,
    });
  }

  // ── Clients: legacy UA client + duplicate same-type clients ──
  for (const c of s.clients) {
    if (!/(^|_)ua($|_)/i.test(c.type)) continue;
    push({
      severity: 'low',
      category: 'deprecated',
      message: `Client "${c.name}" is a Universal Analytics client — UA is sunset, so the requests it claims feed a product that no longer reports, and it competes to claim requests ahead of your active clients.`,
      recommendation: 'Delete the UA client (delete_gtm_client) unless something still deliberately depends on its claiming behavior.',
      autoFixable: false,
    });
  }
  const clientsByType = new Map<string, typeof s.clients>();
  for (const c of s.clients) {
    const arr = clientsByType.get(c.type) ?? [];
    arr.push(c);
    clientsByType.set(c.type, arr);
  }
  for (const [type, group] of clientsByType) {
    if (group.length < 2) continue;
    push({
      severity: 'low',
      confidence: 'likely',
      category: 'unused',
      message: `${group.length} clients of the same type "${type}" (${group.map((c) => `"${c.name}"`).join(', ')}) — an incoming request is claimed by ONE client (priority order), so a same-type duplicate usually never claims anything: dead weight or an accidental copy.`,
      recommendation: 'Keep one client per type unless they are deliberately split by path/priority; delete the accidental copy.',
      autoFixable: false,
    });
  }

  // ── Variables: unused + dangling {{references}} — REUSES the web audit's helpers over the server
  // workspace, with client + transformation parameters added to the reference corpus so a variable
  // used only by a client/transformation is never called unused. Server-only built-ins are excluded
  // from the dangling check (the web built-ins list doesn't know them). ──
  if (s.variables?.length || s.tags.length) {
    const pseudo: ContainerSnapshot = { tags: s.tags, triggers, variables: s.variables ?? [] };
    const extraCorpus = JSON.stringify([
      ...s.clients.map((c) => c.parameter ?? []),
      ...s.transformations.map((x) => x.parameter ?? []),
    ]);
    for (const v of findUnusedVariables(pseudo)) {
      if (extraCorpus.includes(`{{${v.name}}}`)) continue; // used by a client/transformation
      push({
        severity: 'low',
        category: 'unused',
        checkId: 'unused-variable',
        resource: { kind: 'variable', id: v.variableId, name: v.name },
        message: `Variable "${v.name}" appears unused — no server tag, trigger, client, transformation, or variable in this workspace references it.`,
        recommendation: 'Delete it if it is truly unused — first confirm it is not relied on by a published version or a field this audit cannot inspect.',
        autoFixable: false,
      });
    }
    const SERVER_BUILTINS = new Set([
      'Event Name', 'Client Name', 'Container ID', 'Container Version', 'Debug Mode', 'Environment Name',
      'Random Number', 'Request Method', 'Request Path', 'Query String', 'Page Location', 'Page Hostname',
      'Page Path', 'Referrer', 'IP Address', 'User Agent', 'Visitor Region',
    ]);
    for (const d of findDanglingVariableReferences(pseudo)) {
      const missing = d.missing.filter((m) => !SERVER_BUILTINS.has(m) && !m.startsWith('_'));
      if (!missing.length) continue;
      const noun = d.resource.kind === 'tag' ? 'Server tag' : d.resource.kind === 'trigger' ? 'Trigger' : 'Variable';
      push({
        severity: 'medium',
        confidence: 'likely',
        category: 'variable',
        resource: d.resource,
        message: `${noun} "${d.resource.name}" references ${missing.map((m) => `{{${m}}}`).join(', ')} which this workspace does not define — the reference resolves to undefined at runtime.`,
        recommendation: 'Create the missing variable (for server containers usually an Event Data variable reading the incoming field), or fix the reference.',
        autoFixable: false,
      });
    }
  }

  // ── PII-named event data → CAPI tags, with ZERO transformations in the workspace. Deliberately
  // LOW + runtime-required: the official/stape CAPI templates hash user data THEMSELVES, so a missing
  // transformation is not proof of raw PII leaving the server - but it is the one config-visible
  // state worth a manual look (a custom template or auto-map-off tag may forward raw values).
  if (s.transformations.length === 0) {
    const PII_VAR = /email|phone|first.?name|last.?name|full.?name|address|zip|postal/i;
    const piiVars = (s.variables ?? []).filter((v) => PII_VAR.test(v.name));
    // Every recognised CAPI template by SHAPE (Meta/TikTok/Snap/Microsoft/LinkedIn/Pinterest/Reddit/
    // Amazon/StackAdapt), plus a name fallback for a vendor template no recogniser knows yet.
    const capiTags = s.tags.filter(
      (t) => !t.paused && (isAnyCapiServerTag(t) || /linkedin|pinterest|snap|reddit|amazon|stackadapt|capi|conversions?\s*api/i.test(t.name)),
    );
    const flowing = piiVars.filter((v) => capiTags.some((t) => JSON.stringify(t.parameter ?? []).includes(`{{${v.name}}}`)));
    if (flowing.length) {
      push({
        severity: 'low',
        confidence: 'runtime-required',
        category: 'security',
        message: `PII-named variable${flowing.length === 1 ? '' : 's'} (${flowing.map((v) => `"${v.name}"`).join(', ')}) flow into CAPI server tags and this workspace has NO transformations. The official/stape CAPI templates hash user data themselves, so this is not proof of a leak - but a custom template or a tag with auto-mapping off may forward the raw values.`,
        recommendation: 'Verify in the vendor Events Manager (Test Events) or sGTM preview that these fields arrive HASHED; if they arrive raw, add a transformation that SHA-256 hashes them before forwarding, or fix the tag template.',
        autoFixable: false,
      });
    }
  }

  // ── P1: Google Ads conversions with no server-side Conversion Linker ───────────────────
  // Without the linker the server never writes the first-party click-id cookie, so conversions
  // fall back to third-party cookies and are recorded then quietly lost, or reattributed to
  // organic/direct. The symptom (conversions that "disappear") looks nothing like the cause.
  const adsConversionTags = s.tags.filter((t) => t.type === 'sgtmadsct' && !t.paused);
  if (adsConversionTags.length > 0 && !s.tags.some((t) => t.type === 'sgtmadscl' && !t.paused)) {
    push({
      severity: 'high',
      confidence: 'certain',
      category: 'firing',
      message: `${adsConversionTags.length} Google Ads conversion server tag(s) exist but there is no active server-side Conversion Linker, so no first-party click-id cookie is written and conversions lose their click attribution.`,
      recommendation: 'Add a Conversion Linker server tag (create_server_tag platform "ads_conversion_linker") and fire it on the same trigger as the GA4 relay, so it runs on every claimed request rather than only on conversions.',
      autoFixable: false,
    });
  }

  // ── P0: consent is not enforced on VENDOR server tags ──────────────────────────────────
  // Ranked the single highest-damage server finding because it is unrecoverable LIABILITY, not a
  // wrong number: a conversion sent for a user who refused cannot be un-sent. Google's own server
  // tags honour Consent Mode natively, but a third-party CAPI tag does NOT - it fires whenever its
  // trigger fires unless the tag itself carries a consent gate.
  //
  // Deliberately NEVER auto-fixable. Loosening or guessing a consent setting is never a safe
  // automatic action, and default-deny is the correct failure state. Aggregated into ONE finding
  // so a container with a dozen CAPI tags produces one clear item rather than a dozen alarms.
  //
  // Escape hatch against false positives: a team can gate consent on the TRIGGER instead of the
  // tag (a condition on a consent variable). When the firing trigger mentions one, this stays
  // silent rather than crying wolf - the same rule the dedup check follows.
  const CONSENT_REF_RE = /consent|gcs\b|gdpr|cmp|ad_storage|analytics_storage|ad_user_data|ad_personalization/i;
  const triggerGatesConsent = (triggerId: string): boolean => {
    const tr = triggers.find((x) => x.triggerId === triggerId);
    if (!tr) return false;
    for (const arr of [tr.customEventFilter, tr.filter, tr.autoEventFilter]) {
      for (const f of arr ?? []) {
        const params = ((f as { parameter?: Array<{ value?: unknown }> }).parameter) ?? [];
        if (params.some((p) => CONSENT_REF_RE.test(String(p.value ?? '')))) return true;
      }
    }
    return false;
  };
  const ungatedVendorTags = s.tags.filter((t) => {
    if (!isAnyCapiServerTag(t)) return false;
    const gate = evaluateConsentGate(t.consentSettings, ['ad_storage']);
    // 'ungated' = no additional consent check at all; 'declared_no_consent' = explicitly declared
    // as needing none. Both mean the tag fires regardless of the visitor's choice.
    if (gate !== 'ungated' && gate !== 'declared_no_consent') return false;
    return !(t.firingTriggerId ?? []).some(triggerGatesConsent);
  });
  if (ungatedVendorTags.length) {
    const shown = ungatedVendorTags.slice(0, 5).map((t) => `"${t.name}"`).join(', ');
    const more = ungatedVendorTags.length > 5 ? ` and ${ungatedVendorTags.length - 5} more` : '';
    push({
      severity: 'critical',
      confidence: 'likely',
      category: 'consent',
      message: `${ungatedVendorTags.length} third-party conversion-API server tag(s) carry no consent gate: ${shown}${more}. Unlike Google's server tags these do not honour Consent Mode on their own, so they send data for visitors who refused.`,
      recommendation: 'Set Consent Settings on each tag to "Require additional consent" with the vendor\'s consent types (ad_storage for advertising vendors, plus ad_user_data / ad_personalization where the vendor requires them), or gate the firing trigger on a consent variable. Decide the correct types deliberately: this is never auto-fixed because the safe default is to send nothing.',
      autoFixable: false,
    });
  }

  // ── P0: the GA4 client will not claim the requests it is there to claim ─────────────────
  // "No client claimed the request" is the most common way a server container silently receives
  // nothing. Two causes are visible in the config alone.
  const ga4ClientCfg = s.clients.find((c) => c.type === 'gaaw_client');
  const clientParamValue = (c: { parameter?: unknown[] } | undefined, key: string): string => {
    for (const p of (c?.parameter ?? []) as Array<{ key?: string; value?: unknown }>) {
      if (p && p.key === key) return String(p.value ?? '');
    }
    return '';
  };
  if (ga4ClientCfg && clientParamValue(ga4ClientCfg, 'activateDefaultPaths').toLowerCase() === 'false') {
    push({
      severity: 'high',
      confidence: 'certain',
      category: 'firing',
      message: `The GA4 client "${ga4ClientCfg.name}" has default paths turned OFF, so it does not claim the standard GA4/gtag request paths - incoming requests go unclaimed and every Google server tag stays idle.`,
      recommendation: 'Turn default paths back on, or confirm a custom path is configured on BOTH this client and the web tag that sends to it.',
      autoFixable: false,
    });
  }
  // A trailing or doubled slash makes the collect path "//g/collect", which no client matches.
  // Trivial, and one of the most frequent real causes of a dead server container.
  for (const u of s.taggingServerUrls) {
    const afterProtocol = String(u).replace(/^https?:\/\//i, '');
    if (afterProtocol.includes('//') || /\/$/.test(afterProtocol)) {
      push({
        severity: 'medium',
        confidence: 'likely',
        category: 'firing',
        message: `The tagging server URL "${u}" has a trailing or doubled slash. Request paths are appended to it, producing a doubled slash that no client matches, so requests arrive and are never claimed.`,
        recommendation: 'Record the URL with no trailing slash (https://sgtm.example.com, not https://sgtm.example.com/).',
        autoFixable: false,
      });
    }
  }

  // ── P1: cookies written by JavaScript instead of by the server ─────────────────────────
  // The main reason to run sGTM at all is a server-set cookie that survives browser cookie
  // capping. Reported, never auto-changed: whether server-managed cookies are correct depends on
  // the tagging domain passing the browser's first-party test and on the migration flag, neither
  // of which can be settled from container config, and flipping it blind resets returning visitors.
  if (ga4ClientCfg) {
    const cookieMode = clientParamValue(ga4ClientCfg, 'cookieManagement').toLowerCase();
    const cookieName = clientParamValue(ga4ClientCfg, 'cookieName');
    if (cookieMode && cookieMode !== 'server') {
      push({
        severity: 'medium',
        confidence: 'likely',
        category: 'ga4',
        message: `The GA4 client "${ga4ClientCfg.name}" leaves client-id cookies to JavaScript, so browsers that cap script-written cookies shorten visitor lifetime to days - the durability server-side tagging is meant to provide is not being gained.`,
        recommendation: 'Consider server-managed cookies, but verify first that the tagging domain is genuinely first-party to the site; switching also needs the JS-client-id migration option on, or returning visitors are counted as new.',
        autoFixable: false,
      });
    } else if (cookieMode === 'server' && !cookieName) {
      push({
        severity: 'high',
        confidence: 'certain',
        category: 'ga4',
        message: `The GA4 client "${ga4ClientCfg.name}" is set to server-managed cookies but has no cookie name, so it writes no cookie at all and every request looks like a new visitor.`,
        recommendation: 'Set the cookie name (FPID is the convention) on the GA4 client.',
        autoFixable: false,
      });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const t of s.tags) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);
  for (const [name, c] of nameCounts) if (c > 1) push({ severity: 'medium', category: 'naming', message: `Duplicate server-tag name "${name}" (${c} tags) — hard to tell them apart.`, recommendation: 'Rename so each tag is uniquely identifiable.', autoFixable: false });

  const cleanFindings = findings.map((f) => ({ ...f, message: plainDashes(f.message), recommendation: plainDashes(f.recommendation) }));
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of cleanFindings) summary[f.severity]++;
  return {
    counts: { tags: s.tags.length, triggers: triggers.length, variables: s.variables?.length ?? 0, clients: s.clients.length, transformations: s.transformations.length, findings: findings.length },
    summary,
    findings: cleanFindings,
    boundary: AUDIT_SERVER_BOUNDARY,
    runtimeRequired: AUDIT_SERVER_RUNTIME_REQUIRED,
    hasGa4Config: hasGa4Client,
  };
}

/* ───────────── Meta CAPI (EMQ) helpers ───────────── */

export function customTemplateType(
  t: { containerId?: string | null; templateId?: string | null; galleryReference?: { galleryTemplateId?: string | null } | null },
  fallbackContainerId: string
): string {
  const gid = t.galleryReference?.galleryTemplateId;
  if (gid) return `cvt_${gid}`;
  return `cvt_${t.containerId ?? fallbackContainerId}_${t.templateId ?? ''}`;
}

const META_WEB_OBJECT_PROP_BINDING: Record<string, string> = {
  value: '{{dlv - ecommerce.value}}',
  currency: '{{dlv - ecommerce.currency}}',
};
/** The auto-fill object properties for a standard event: its recommended properties that have a web
 *  binding, in order. Empty for a custom event (no recommended set). PURE. */
export function metaWebObjectProps(std: string | null): Array<{ name: string; value: string }> {
  const keys = std ? (META_EVENT_OBJECT_PROPERTIES[std] ?? []) : [];
  const out: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k) || !(k in META_WEB_OBJECT_PROP_BINDING)) continue;
    seen.add(k);
    out.push({ name: k, value: META_WEB_OBJECT_PROP_BINDING[k] });
  }
  return out;
}

/** Build a Meta (Facebook) Pixel tag from the imported community template (`type` = its cvt_
 *  code). A Meta STANDARD event sets eventName='standard' + standardEventName=<canonical>;
 *  anything else sets eventName='custom' + customEventName=<the event>. The eventName SELECTOR
 *  must always be set — omitting it (only setting standardEventName) makes the template fall
 *  back to its default (standard/PageView). `objectProperties` (name→value) become the Meta
 *  Object Properties (objectPropertyList). When objectProperties is UNDEFINED (caller passed none)
 *  they are AUTO-FILLED from the event's recommended set (metaWebObjectProps); an explicit array
 *  (even empty) is respected as-is. Field shape corpus-validated (528 Meta tags). PURE. */
/** Facebook Advanced Matching keys the WEB Pixel template's `advancedMatchingList` SELECT accepts —
 *  the web-pixel analog of the CAPI userDataList. NOTE the web SELECT uses the SHORT `cn` for country
 *  (the CAPI/server user_data spec uses the long `country` — a different field name); a caller who
 *  passes either gets `cn` via the alias below. Unknown keys pass through. Advanced matching is the
 *  Meta Pixel's "user properties". */
export const META_PIXEL_ADVANCED_MATCH_KEYS: string[] = ['em', 'fn', 'ln', 'ph', 'ge', 'db', 'ct', 'st', 'zp', 'cn', 'external_id'];
/** Forgiving aliases → the exact web-Pixel SELECT value (the CAPI-style `country` is the common slip). */
const META_PIXEL_ADVANCED_MATCH_ALIAS: Record<string, string> = { country: 'cn' };
const canonMetaAdvancedMatchKey = (name: string): string => {
  const low = name.trim().toLowerCase();
  const aliased = META_PIXEL_ADVANCED_MATCH_ALIAS[low] ?? low;
  return META_PIXEL_ADVANCED_MATCH_KEYS.includes(aliased) ? aliased : name.trim();
};

export function buildMetaPixelTag(
  type: string,
  name: string,
  pixelId: string,
  event: string,
  firingTriggerId?: string[],
  objectProperties?: Array<{ name: string; value: string }>,
  advancedMatching?: Array<{ name: string; value: string }>
): GtmTagResource {
  const std = metaStandardEvent(event);
  const parameter: Param[] = [tpl('pixelId', pixelId), tpl('eventName', std ? 'standard' : 'custom')];
  if (std) parameter.push(tpl('standardEventName', std));
  else parameter.push(tpl('customEventName', event));
  const explicit = (objectProperties ?? []).filter((p) => p.name && p.name.trim() !== '');
  const props = explicit.length ? explicit : (objectProperties === undefined ? metaWebObjectProps(std) : []);
  if (props.length) {
    parameter.push(boolean('objectPropertiesFromVariable', false));
    parameter.push({
      type: 'list',
      key: 'objectPropertyList',
      list: props.map((p) => ({ type: 'map', map: [tpl('name', p.name), tpl('value', p.value)] })),
    });
  }
  // Advanced Matching (the Pixel's user-identity params): a BOOLEAN toggle + a list of {name,value}
  // rows (em/fn/ln/ph/ct/st/zp/country/external_id, …). Only emitted when the caller passes rows —
  // values are usually {{variables}} carrying hashed/raw PII the browser can see.
  const am = (advancedMatching ?? []).filter((p) => p.name && p.name.trim() !== '');
  if (am.length) {
    parameter.push(boolean('advancedMatching', true));
    parameter.push({
      type: 'list',
      key: 'advancedMatchingList',
      list: am.map((p) => ({ type: 'map', map: [tpl('name', canonMetaAdvancedMatchKey(p.name)), tpl('value', p.value)] })),
    });
  }
  return {
    name: sanitizeName(name),
    type,
    ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
    parameter,
  };
}

/** Build a Stape "Facebook Conversion API" SERVER tag (gallery template stape-io/facebook-tag;
 *  `type` = its cvt_ code), tuned for high Event Match Quality: action source = website, Event
 *  Enhancement (the gtmeec cookie) ON, generate _fbp ON. A Meta STANDARD event sets
 *  eventNameStandard with Override (inheritEventName=false); a non-standard event inherits the
 *  incoming event_name. pixelId/accessToken are typically {{variables}}. Field keys
 *  corpus-validated (cvt_5TP8W). The EMQ user-data params come from create_meta_emq_variables. PURE. */
/** The Meta user_data (advanced-matching / EMQ) rows the CAPI tag sends, as [Facebook key → the
 *  `ed - <emq key>` variable that feeds it]. em/ph/external_id ONLY: the Stape template's own
 *  addUserData already extracts fn/ln/ct/zp/country (and the nested GA4 user_data.* shapes) from the
 *  incoming event, and its overrideDataIfNeeded applies explicit rows UNCONDITIONALLY — so an explicit
 *  row for THOSE whose variable resolves undefined would ERASE what the template extracted (lower EMQ).
 *  em/ph carry the top-level email_address/phone_number keys the template misses (their ed variables
 *  fall back to the nested user_data.* path). external_id (a stable user id — Meta's user_id field) is
 *  NOT auto-extracted by the template, so adding it can only ADD matching, never erase; its ed variable
 *  falls back to the GA4 user_id (see buildMetaEmqVariables). fbp/fbc are omitted — the template
 *  generates _fbp and reads _fbc from the cookie itself.
 *
 *  client_ip_address/client_user_agent are ERASE-SAFE additions: their `ed - <key>` variables read the
 *  SAME source the template extracts from (event.ip_override / event.user_agent) AND fall back to a
 *  request header the tagging host forwards (`rh - x-forwarded-for` for IP, `rh - user-agent` for UA) —
 *  so the auto-mapped row is a SUPERSET of what the template would find and can only ADD match signal,
 *  never blank a value the template already had (it resolves empty only when there is no IP/UA anywhere).
 *  Both are sent RAW (Meta does not hash IP/UA — they are do-not-hash context fields). */
/* ───────────── Hotjar (base + identify) ───────────── */

/** Build a Hotjar tracking tag as a Custom HTML tag (type 'html'). The base snippet installs the
 *  hj() queue and loads static.hotjar.com for `siteId` (the Hotjar Site ID / hjid — a number or a
 *  {{variable}}). When `userId` or `userAttributes` are supplied it ALSO emits
 *  hj('identify', <userId>, { <name>: <value>, … }) — Hotjar's user-identity mechanism, the analog of
 *  GA4 user properties. Attribute values are usually {{variables}} (e.g. {{User Email}}); they are
 *  emitted as JS string literals so a resolved {{variable}} lands as a quoted value. Hotjar is a
 *  session-replay/analytics pixel, so gate the created tag on analytics_storage (not the ad_* set).
 *  Delegates to buildCustomHtmlTag so the parameter shape matches every other Custom HTML tag. PURE. */
export function buildHotjarTag(
  name: string,
  siteId: string,
  opts?: { userId?: string; userAttributes?: Array<{ name: string; value: string }>; firingTriggerId?: string[] }
): GtmTagResource {
  const hjid = (siteId ?? '').trim() || '0';
  const base =
    `(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};` +
    `h._hjSettings={hjid:${hjid},hjsv:6};a=o.getElementsByTagName('head')[0];` +
    `r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;` +
    `a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`;
  const attrs = (opts?.userAttributes ?? [])
    .filter((p) => p.name && p.name.trim() !== '')
    .map((p) => `${JSON.stringify(p.name.trim())}: ${JSON.stringify(String(p.value ?? ''))}`);
  const uid = (opts?.userId ?? '').trim();
  const identify = uid || attrs.length ? `\nhj('identify', ${uid ? JSON.stringify(uid) : 'null'}, {${attrs.join(', ')}});` : '';
  const html = `<script>\n${base}${identify}\n</script>`;
  return buildCustomHtmlTag({ name, html, firingTriggerId: opts?.firingTriggerId });
}

/* ───────────── Pinterest (web tag + Enhanced Match) ───────────── */

/** GA4 / free-text event → the Pinterest ws-gtm-template `eventName` SELECT (lowercase). checkout is
 *  Pinterest's purchase event. An exact Pinterest value passes through; anything unmatched becomes a
 *  CUSTOM event (eventName='ADE' + adeEventName). Verified against the live template + the prompt. */
export const PINTEREST_EVENTS: string[] = ['pagevisit', 'viewcategory', 'viewcontent', 'addtocart', 'checkout', 'search', 'signup', 'lead', 'watchvideo', 'custom'];
const GA4_TO_PINTEREST: Record<string, string> = {
  pageview: 'pagevisit',
  pagevisit: 'pagevisit',
  viewitem: 'viewcontent',
  viewcontent: 'viewcontent',
  viewitemlist: 'viewcategory',
  viewcategory: 'viewcategory',
  selectitem: 'viewcategory',
  addtocart: 'addtocart',
  purchase: 'checkout',
  checkout: 'checkout',
  begincheckout: 'checkout',
  search: 'search',
  signup: 'signup',
  generatelead: 'lead',
  lead: 'lead',
};
/** Resolve an event to a Pinterest standard event name, or null (→ ADE custom event). PURE. */
export function pinterestEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return 'pagevisit';
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (PINTEREST_EVENTS.includes(norm) && norm !== 'custom') return norm;
  if (GA4_TO_PINTEREST[norm]) return GA4_TO_PINTEREST[norm];
  return null;
}

/** Build a Pinterest web tag (gallery pinterest/ws-gtm-template; `type` = its cvt_ code). Fields:
 *  tagId + eventName SELECT (a custom event → eventName='ADE' + adeEventName). Enhanced Match — the
 *  Pinterest user-identity param — is the single `em` field (a SHA-256-hashed email, usually a
 *  {{variable}}); pass enhancedMatch.em to set it. Consent-gate the created tag on the ad_* set. PURE. */
export function buildPinterestTag(
  type: string,
  name: string,
  tagId: string,
  event: string,
  firingTriggerId?: string[],
  enhancedMatch?: { em?: string }
): GtmTagResource {
  const std = pinterestEvent(event);
  const parameter: Param[] = [tpl('tagId', tagId)];
  if (std) {
    parameter.push(tpl('eventName', std));
  } else {
    parameter.push(tpl('eventName', 'ADE'), tpl('adeEventName', (event ?? '').trim()));
  }
  const em = enhancedMatch?.em?.trim();
  if (em) parameter.push(tpl('em', em));
  return {
    name: sanitizeName(name),
    type,
    ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── TikTok Pixel (web) ───────────── */

/** Build a TikTok WEB Pixel tag (gallery template tiktok/gtm-template-pixel; `type` = its cvt_ code).
 *  Fields: pixel_code (the TikTok Pixel ID, usually a {{variable}}) + event (the SELECT value —
 *  ViewContent/AddToCart/CompletePayment/Pageview/…). The mapped event is passed straight through (do
 *  NOT custom-encode). firingTriggerId is only attached when the caller passes it; the create flow
 *  attaches via the shared trigger path, so leave it undefined there. PURE. */
export function buildTikTokPixelTag(
  type: string,
  name: string,
  pixelCode: string,
  event: string,
  firingTriggerId?: string[]
): GtmTagResource {
  const parameter: Param[] = [tpl('pixel_code', pixelCode), tpl('event', (event ?? '').trim() || 'Pageview')];
  return {
    name: sanitizeName(name),
    type,
    ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── LinkedIn Insight Tag (web) ───────────── */

/** Build a LinkedIn Insight Tag (gallery template linkedin/linkedin-gtm-community-template; `type` =
 *  its cvt_ code). The single field is partnerId (the LinkedIn Partner ID, usually a {{variable}}) —
 *  LinkedIn's per-event conversions are defined Campaign-Manager-side, so this is the base tag only.
 *  firingTriggerId is only attached when the caller passes it. PURE. */
export function buildLinkedInInsightTag(
  type: string,
  name: string,
  partnerId: string,
  firingTriggerId?: string[]
): GtmTagResource {
  return {
    name: sanitizeName(name),
    type,
    ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
    parameter: [tpl('partnerId', partnerId)],
  };
}

/* ───────────── Reddit Pixel (web, Custom HTML) ───────────── */

/** Build a Reddit Pixel tag as a Custom HTML tag (there is NO gallery template). EVERY Reddit tag is
 *  SELF-CONTAINED: it emits the rdt() bootstrap (guarded by `if(!w.rdt)`, so loading it on more than
 *  one tag is safe) + rdt('init','<pixelId>') (idempotent) + rdt('track','<event>'). The base tag
 *  (base=true) tracks 'PageVisit'; an event tag tracks its own event. This deliberately does NOT rely
 *  on a separate base tag having fired first — an event tag created on its own still initializes rdt,
 *  so a deselected/failed base tag can't turn its events into a silent `rdt is not defined`. The
 *  pixelId is usually a {{variable}} emitted literally into the JS (GTM substitutes at fire time).
 *  Delegates to buildCustomHtmlTag so the parameter shape matches every other Custom HTML tag. PURE. */
export function buildRedditPixelTag(
  name: string,
  pixelId: string,
  event: string,
  opts?: { base?: boolean; firingTriggerId?: string[] }
): GtmTagResource {
  const pid = (pixelId ?? '').trim();
  const ev = opts?.base ? 'PageVisit' : ((event ?? '').trim() || 'PageVisit');
  const bootstrap =
    `!function(w,d){if(!w.rdt){var p=w.rdt=function(){p.sendEvent?p.sendEvent.apply(p,arguments):p.callQueue.push(arguments)};` +
    `p.callQueue=[];var t=d.createElement("script");t.src="https://www.redditstatic.com/ads/pixel.js";t.async=!0;` +
    `var s=d.getElementsByTagName("script")[0];s.parentNode.insertBefore(t,s)}}(window,document);`;
  const html = `<script>\n${bootstrap}\nrdt('init','${pid}');\nrdt('track','${ev}');\n</script>`;
  return buildCustomHtmlTag({ name, html, firingTriggerId: opts?.firingTriggerId });
}

/* ───────────── Snap Pixel (web tag + Advanced Matching) ───────────── */

/** The Snap snapchat-google-tag-manager `event_type` SELECT values (verified against corpus
 *  templateData). macrosInSelect → a {{variable}} is also accepted. */
export const SNAP_EVENT_TYPES: string[] = [
  'PAGE_VIEW', 'ADD_CART', 'SAVE', 'PURCHASE', 'LEVEL_COMPLETE', 'START_CHECKOUT', 'SIGN_UP',
  'APP_INSTALL', 'APP_OPEN', 'ADD_BILLING', 'SEARCH', 'VIEW_CONTENT', 'SUBSCRIBE', 'AD_CLICK',
  'AD_VIEW', 'COMPLETE_TUTORIAL', 'INVITE', 'LOGIN', 'SHARE', 'RESERVE', 'ACHIEVEMENT_UNLOCKED',
  'ADD_TO_WISHLIST', 'SPENT_CREDITS', 'RATE', 'START_TRIAL', 'LIST_VIEW',
  'CUSTOM_EVENT_1', 'CUSTOM_EVENT_2', 'CUSTOM_EVENT_3', 'CUSTOM_EVENT_4', 'CUSTOM_EVENT_5',
];
const GA4_TO_SNAP: Record<string, string> = {
  pageview: 'PAGE_VIEW',
  addtocart: 'ADD_CART',
  purchase: 'PURCHASE',
  begincheckout: 'START_CHECKOUT',
  startcheckout: 'START_CHECKOUT',
  signup: 'SIGN_UP',
  search: 'SEARCH',
  viewitem: 'VIEW_CONTENT',
  viewcontent: 'VIEW_CONTENT',
  subscribe: 'SUBSCRIBE',
  addtowishlist: 'ADD_TO_WISHLIST',
  login: 'LOGIN',
  starttrial: 'START_TRIAL',
  addpaymentinfo: 'ADD_BILLING',
  addbilling: 'ADD_BILLING',
};
/** Resolve an event to a Snap event_type SELECT value; unknown → PAGE_VIEW (the template default). PURE. */
export function snapEventType(event: string): string {
  const raw = (event ?? '').trim();
  if (!raw) return 'PAGE_VIEW';
  const upper = raw.toUpperCase();
  if (SNAP_EVENT_TYPES.includes(upper)) return upper; // exact SELECT value
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  return GA4_TO_SNAP[norm] ?? 'PAGE_VIEW';
}

/** The Snap Advanced-Matching (user-identity) fields — flat TEXT params on the template, each its own
 *  row (NOT a list). Raw user_email/user_phone_number are hashed by Snap on ingest; pre-hashed values
 *  go in the user_hashed_* fields. Order fixed for stable output. */
export const SNAP_ADVANCED_MATCH_KEYS: string[] = [
  'user_email', 'user_hashed_email', 'user_phone_number', 'user_hashed_phone_number',
  'user_mobile_ad_id', 'user_hashed_mobile_ad_id',
];

/** Build a Snap Pixel web tag (gallery Snapchat/snapchat-google-tag-manager; `type` = its cvt_ code).
 *  pixel_id + event_type SELECT. Advanced Matching — the Snap user-identity params — are the six flat
 *  user_email/user_hashed_email/user_phone_number/user_hashed_phone_number/user_mobile_ad_id/
 *  user_hashed_mobile_ad_id fields (each its own param, not a list); pass advancedMatching to set them.
 *  Values usually {{variables}}. Consent-gate the created tag on the ad_* set. PURE. */
export function buildSnapPixelTag(
  type: string,
  name: string,
  pixelId: string,
  event: string,
  firingTriggerId?: string[],
  advancedMatching?: Partial<Record<string, string>>
): GtmTagResource {
  const parameter: Param[] = [tpl('pixel_id', pixelId), tpl('event_type', snapEventType(event))];
  for (const key of SNAP_ADVANCED_MATCH_KEYS) {
    const v = advancedMatching?.[key];
    if (v != null && String(v).trim() !== '') parameter.push(tpl(key, String(v).trim()));
  }
  return {
    name: sanitizeName(name),
    type,
    ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
    parameter,
  };
}


