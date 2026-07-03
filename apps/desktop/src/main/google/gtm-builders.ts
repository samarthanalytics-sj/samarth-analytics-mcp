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
  /** GA4 "Send Ecommerce data" from the dataLayer — forwards the WHOLE ecommerce object (items,
   *  value, currency, transaction_id, …) with no per-param variables. Corpus shape:
   *  sendEcommerceData=true + getEcommerceDataFrom='dataLayer'. Use for funnel event tags. */
  sendEcommerceData?: boolean;
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
    boolean('sendEcommerceData', o.sendEcommerceData === true),
  ];
  if (o.sendEcommerceData === true) parameter.push(tpl('getEcommerceDataFrom', 'dataLayer'));
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
  return { name: sanitizeName(o.name), type: 'googtag', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
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

/** A server-container Client resource (claims incoming requests). */
export interface GtmClientResource {
  name: string;
  type: string;
  parameter?: Param[];
  priority?: number;
}

/** The GA4 client (`gaaw_client`) — claims incoming GA4 / gtag requests on a server container so
 *  server tags can read the event; `activateDefaultPaths` claims the standard /g/collect endpoints.
 *  Shape corpus-validated (3 server containers). By default it also enables SERVER-MANAGED first-party
 *  ID cookies (cookieManagement=server → the httpOnly FPID cookie, 2-year age, auto domain,
 *  migrated from the JS client id) — the production pattern from the Vocal Minority reference
 *  server container (GTM-57RM3QCT) and Stape's recommended setup: the identifier survives
 *  ITP/JS-cookie limits because the server sets it. Pass serverManagedCookies:false for the
 *  plain JS-cookie client. */
export function buildGa4Client(name: string, opts?: { serverManagedCookies?: boolean }): GtmClientResource {
  const parameter: Param[] = [boolean('activateDefaultPaths', true), boolean('activateGtagSupport', true)];
  if (opts?.serverManagedCookies !== false) {
    parameter.push(
      tpl('cookieManagement', 'server'),
      tpl('cookieName', 'FPID'),
      tpl('cookieDomain', 'auto'),
      tpl('cookiePath', '/'),
      tpl('cookieMaxAgeInSec', '63072000'),
      boolean('migrateFromJsClientId', true)
    );
  }
  return {
    name: sanitizeName(name),
    type: 'gaaw_client',
    parameter,
  };
}

/** The server GTM client (`gtm_client`) — lets the tagging server FIRST-PARTY-SERVE gtm.js and
 *  its dependencies for the listed WEB container(s) (the site loads GTM from the owner's domain
 *  instead of googletagmanager.com — ad-blocker/ITP resilience). Shape validated against the
 *  Vocal Minority reference: compression + dependency serving ON, geo resolution OFF, and
 *  allowedContainerIds as a LIST of {containerId} maps holding the web GTM-XXXX public ids. */
export function buildGtmClient(name: string, allowedContainerIds: string[]): GtmClientResource {
  return {
    name: sanitizeName(name),
    type: 'gtm_client',
    parameter: [
      boolean('activateResponseCompression', true),
      boolean('activateGeoResolution', false),
      boolean('activateDependencyServing', true),
      {
        type: 'list',
        key: 'allowedContainerIds',
        list: allowedContainerIds.map((id) => ({ type: 'map', map: [tpl('containerId', id)] })),
      },
    ],
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

/** A server Custom Event trigger that fires on every event ({{_event}} matches `.*`). When
 *  `clientName` is given, it's SCOPED to that client via a `{{Client Name}} equals <name>`
 *  filter (the Google/Stape-recommended pattern — fires only on events the GA4 client
 *  produced; needs the CLIENT_NAME built-in enabled, which bootstrap does). Shape
 *  corpus-validated (server triggers are CUSTOM_EVENT with a customEventFilter on {{_event}}
 *  plus a {{Client Name}} filter). PURE. */
export function buildServerAllEventsTrigger(
  name: string,
  clientName?: string,
  opts?: { pageUrlContains?: string; pageUrlVariable?: string }
): GtmTriggerResource {
  const t: GtmTriggerResource = {
    name: sanitizeName(name),
    type: 'customEvent',
    customEventFilter: [condition('{{_event}}', 'matchRegex', '.*')],
  };
  const filter: Param[] = [];
  if (clientName && clientName.trim() !== '') filter.push(condition('{{Client Name}}', 'equals', clientName));
  if (opts?.pageUrlContains && opts.pageUrlContains.trim() !== '') {
    filter.push(condition(opts.pageUrlVariable?.trim() || '{{ed - page_location}}', 'contains', opts.pageUrlContains.trim()));
  }
  if (filter.length > 0) t.filter = filter;
  return t;
}

/** A server Custom Event trigger that fires on ONE specific event: `{{_event}} equals <eventName>`
 *  (e.g. purchase), optionally scoped to a client via `{{Client Name}} equals <clientName>`. This is
 *  the DOMINANT server trigger pattern in real containers ("event = purchase AND Client Name = GA4"),
 *  used to fire a per-event tag (GA4 Purchase, Ads Purchase conversion) only on that event. The
 *  {{Client Name}} filter needs the CLIENT_NAME built-in enabled. Shape corpus-validated. PURE. */
export function buildServerEventTrigger(
  name: string,
  eventName: string,
  clientName?: string,
  opts?: {
    /** Also scope to pages whose URL CONTAINS this substring (e.g. "/petition/minister-for-children/") —
     *  the multi-tenant campaign pattern from the Vocal Minority reference: one event, one page/campaign,
     *  one destination tag. Reads {{ed - page_location}} (create it via the event_data variable kind,
     *  keyPath "page_location") unless pageUrlVariable overrides. */
    pageUrlContains?: string;
    pageUrlVariable?: string;
  }
): GtmTriggerResource {
  const t: GtmTriggerResource = {
    name: sanitizeName(name),
    type: 'customEvent',
    customEventFilter: [condition('{{_event}}', 'equals', eventName)],
  };
  const filter: ReturnType<typeof condition>[] = [];
  if (clientName && clientName.trim() !== '') filter.push(condition('{{Client Name}}', 'equals', clientName));
  if (opts?.pageUrlContains && opts.pageUrlContains.trim() !== '') {
    filter.push(condition(opts.pageUrlVariable?.trim() || '{{ed - page_location}}', 'contains', opts.pageUrlContains.trim()));
  }
  if (filter.length > 0) t.filter = filter;
  return t;
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

const FILTER_OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex', 'cssSelector', 'greater', 'less']);
// ignoreCase emits GTM's condition-level ignore_case parameter ("matches RegEx (ignore case)") — the
// mechanism real containers use (corpus: 812 conditions across 168/562 files). gtm.js evaluates web
// matchRegex with the browser's JS RegExp, which CANNOT parse an inline (?i) flag (SyntaxError →
// silent no-match), so an inline flag must never be baked into arg1.
function condition(variable: string, op: string, value: string, ignoreCase?: boolean): Param {
  return {
    type: FILTER_OPS.has(op) ? op : 'contains',
    parameter: [tpl('arg0', variable), tpl('arg1', value), ...(ignoreCase ? [boolean('ignore_case', true)] : [])],
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
      if (o.clickUrlValue) filters.push(condition('{{Click URL}}', o.clickUrlOperator ?? 'contains', o.clickUrlValue, o.clickUrlIgnoreCase === true));
      if (o.clickTextValue) filters.push(condition('{{Click Text}}', o.clickTextOperator ?? 'contains', o.clickTextValue, o.clickTextIgnoreCase === true));
      if (o.clickElementValue) filters.push(condition('{{Click Element}}', o.clickElementOperator ?? 'cssSelector', o.clickElementValue));
      // Lookup-table grouping: the condition reads the companion smm variable, not {{Click Text}}.
      if (o.lookupTable?.name) filters.push(condition(`{{${o.lookupTable.name}}}`, 'equals', 'true'));
      // Page-scoped click trigger (e.g. an FAQ accordion tracked only on its page): a second ANDed
      // {{Page Path}} condition, as real containers do ("Click Text ends with ? AND Page Path contains /faq/").
      if (o.pagePathValue) filters.push(condition('{{Page Path}}', o.pagePathOperator ?? 'contains', o.pagePathValue));
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
      // No id/class scope → scope to the form's page via the built-in {{Page Path}}.
      if (!filters.length && o.pagePathValue) filters.push(condition('{{Page Path}}', o.pagePathOperator ?? 'equals', o.pagePathValue));
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
      if (o.pageUrlValue) t.filter = [condition('{{Page URL}}', o.pageUrlOperator ?? 'contains', o.pageUrlValue)];
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

/** Normalize AND REPAIR a Custom Event trigger so the API always accepts it. The model often
 *  hand-builds a customEvent trigger (via the raw create_gtm_trigger tool) with the event name at the
 *  TOP-LEVEL `eventName` field — which is timer-only, so the API rejects `trigger.event_name` — and a
 *  missing/malformed `customEventFilter` ("must have exactly one custom-event filter"). This repairs
 *  both: (1) if a single valid `{{_event}}` condition exists, keep it and snake_case its match value
 *  (the original behavior); (2) if it's missing or duplicated, REBUILD exactly one `{{_event}} equals
 *  <name>` condition — taking the name from the top-level eventName (string or Parameter) or any arg1
 *  already present — while preserving non-event conditions (e.g. a server trigger's {{Client Name}}
 *  filter). A top-level `eventName` is ALWAYS stripped from a customEvent trigger. PURE. */
export function normalizeCustomEventTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const t = trigger as { type?: unknown; eventName?: unknown; customEventFilter?: unknown };
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

  const cefIn = Array.isArray(t.customEventFilter) ? (t.customEventFilter as Array<Record<string, unknown>>) : [];
  const eventConds = cefIn.filter(isEventCond);

  // (1) Exactly one {{_event}} condition → just snake_case its arg1 value; strip the top-level field.
  if (eventConds.length === 1) {
    const cef = cefIn.map((cond) => {
      if (!isEventCond(cond)) return cond;
      const params = (cond as { parameter: Array<Record<string, unknown>> }).parameter;
      return {
        ...cond,
        parameter: params.map((p) => {
          const pp = p as { key?: string; value?: unknown };
          return pp.key === 'arg1' && typeof pp.value === 'string' ? { ...pp, value: normalizeCustomEventName(pp.value) } : p;
        }),
      };
    });
    return stripEventName({ ...trigger, customEventFilter: cef });
  }

  // (2) Missing or duplicated {{_event}} condition → rebuild exactly one, keeping any non-event
  //     conditions. Derive the name from the top-level eventName, else any arg1 already present.
  let arg1 = '';
  for (const cond of cefIn) {
    const params = (cond as { parameter?: unknown }).parameter;
    if (Array.isArray(params)) {
      const a1 = params.find((p) => (p as { key?: string }).key === 'arg1');
      if (a1 && typeof (a1 as { value?: unknown }).value === 'string') { arg1 = (a1 as { value: string }).value; break; }
    }
  }
  const name = normalizeCustomEventName(valueOf(t.eventName) || arg1);
  const nonEventConds = cefIn.filter((cond) => !isEventCond(cond));
  return stripEventName({
    ...trigger,
    type: 'customEvent',
    customEventFilter: [condition('{{_event}}', 'equals', name), ...nonEventConds],
  });
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

/** Built-in variables a trigger needs (so we can auto-enable them). */
export function triggerBuiltInVars(o: TriggerInput): string[] {
  const vars: string[] = [];
  if (o.kind === 'link_click' || o.kind === 'all_clicks') {
    if (o.clickUrlValue) vars.push('clickUrl');
    // A lookup-table trigger reads {{Click Text}} through its companion smm variable.
    if (o.clickTextValue || o.lookupTable?.name) vars.push('clickText');
    if (o.clickElementValue) vars.push('clickElement');
    if (o.pagePathValue) vars.push('pagePath');
  }
  if (o.kind === 'form_submit') {
    if (o.formIdValue) vars.push('formId');
    if (o.formClassesValue) vars.push('formClasses');
    if (!o.formIdValue && !o.formClassesValue && o.pagePathValue) vars.push('pagePath');
  }
  if (o.kind === 'custom_event') {
    if (o.formIdValue) vars.push('formId');
    if (o.pagePathValue) vars.push('pagePath');
    if (o.pageUrlValue) vars.push('pageUrl');
  }
  if (o.kind === 'pageview' && o.pageUrlValue) vars.push('pageUrl');
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
/** A URL variable that reads ONE query-string key: {{URL - <key>}} resolves to the value of ?<key>=…
 *  — the standard way to capture a GA4 search_term from a results URL. Corpus-verified shape (type "u",
 *  component QUERY + queryKey). The name is used verbatim so a {{URL - <key>}} reference resolves to it. */
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

/** Read one setting (e.g. server_container_url) out of a Google tag's configSettingsTable —
 *  the list-of-maps shape upsertGoogleTagConfig writes. */
function googleTagConfigValue(tag: Record<string, unknown>, configKey: string): string {
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

/** Reserved GTM built-in trigger ids (All Pages, Initialization, Consent Initialization, DOM Ready,
 *  Window Loaded) live in the 2147479xxx range and are never user-deletable. triggers.list doesn't
 *  return them, but guard anyway so a cleanup never targets one. PURE. */
function isBuiltinTriggerId(id: string): boolean {
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

  // Unused triggers — orphans referenced by no tag (as a FIRING or a BLOCKING/exception trigger)
  // and not a Trigger Group member (findUnusedTriggers also skips reserved built-in ids).
  for (const tr of findUnusedTriggers(s)) {
    findings.push({
      severity: 'low',
      category: 'unused',
      resource: { kind: 'trigger', id: tr.triggerId, name: tr.name },
      message: `Trigger "${tr.name}" isn't used by any tag.`,
      recommendation: 'Delete it if it is not needed — unused triggers add clutter and unnecessary listeners. Use delete_unused_gtm_triggers to remove all orphans at once (or a selected subset).',
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

/* ───────────── Meta CAPI (EMQ) helpers ───────────── */

/** The standard Meta CAPI "Event Match Quality" event-data keys read off the incoming event,
 *  for the Conversions API tag's Event Parameters + user_data. keyPath === the key (corpus-
 *  validated: server containers store these as `ed - <key>` with keyPath `<key>`). The CAPI
 *  tag hashes the user_data fields itself, so these source the RAW values. */
export const META_EMQ_EVENT_DATA_KEYS: string[] = [
  'fbp',
  'fbc',
  'event_id',
  'value',
  'currency',
  'transaction_id',
  'content_ids',
  'email_address',
  'phone_number',
  'first_name',
  'last_name',
  'country',
  'city',
  'postal_code',
];

/** The tag `type` code for a custom template. A GALLERY-imported template is referenced by
 *  `cvt_<galleryTemplateId>` (the id GTM resolves the vendor template by, e.g. cvt_MRQN8) —
 *  NOT cvt_<containerId>_<templateId>, which only applies to locally-authored templates. Using
 *  the wrong one makes tags.create reject the tag ("Unknown entity type"). PURE. */
export function customTemplateType(
  t: { containerId?: string | null; templateId?: string | null; galleryReference?: { galleryTemplateId?: string | null } | null },
  fallbackContainerId: string
): string {
  const gid = t.galleryReference?.galleryTemplateId;
  if (gid) return `cvt_${gid}`;
  return `cvt_${t.containerId ?? fallbackContainerId}_${t.templateId ?? ''}`;
}

/** Meta's STANDARD events (Pixel + CAPI). Anything else is a CUSTOM event. */
export const META_STANDARD_EVENTS: string[] = [
  'PageView',
  'ViewContent',
  'Search',
  'AddToCart',
  'AddToWishlist',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'Lead',
  'CompleteRegistration',
  'Contact',
  'CustomizeProduct',
  'Donate',
  'FindLocation',
  'Schedule',
  'StartTrial',
  'SubmitApplication',
  'Subscribe',
];

/** Resolve free-text (e.g. "add to cart", "viewcontent", "Donate") to the CANONICAL Meta
 *  standard event, or null if it isn't a standard event (→ treat as custom). PURE. */
export function metaStandardEvent(event: string): string | null {
  const norm = (event ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!norm) return null;
  for (const e of META_STANDARD_EVENTS) if (e.toLowerCase() === norm) return e;
  return null;
}

/** Recommended Meta Object Properties (event parameters) per event — the keys Meta expects for
 *  each event. Covers the standard web events plus common app/custom events. Values are wired by
 *  the caller (variables off the page/dataLayer). */
export const META_EVENT_OBJECT_PROPERTIES: Record<string, string[]> = {
  PageView: ['event_name', 'event_time', 'event_source_url', 'action_source'],
  ViewContent: ['content_ids', 'contents', 'content_type', 'content_name', 'content_category', 'value', 'currency'],
  Search: ['search_string', 'content_ids', 'content_category'],
  AddToCart: ['content_ids', 'contents', 'content_type', 'value', 'currency', 'num_items'],
  AddToWishlist: ['content_ids', 'contents', 'content_type', 'value', 'currency'],
  InitiateCheckout: ['content_ids', 'contents', 'content_type', 'value', 'currency', 'num_items'],
  AddPaymentInfo: ['content_ids', 'contents', 'content_type', 'value', 'currency'],
  Purchase: ['content_ids', 'contents', 'content_type', 'value', 'currency', 'num_items', 'order_id', 'event_id'],
  Lead: ['value', 'currency', 'content_name', 'content_category'],
  CompleteRegistration: ['registration_method', 'content_name', 'status', 'value', 'currency'],
  Contact: ['content_name', 'content_category'],
  CustomizeProduct: ['content_ids', 'contents', 'content_type', 'value', 'currency'],
  Donate: ['value', 'currency'],
  FindLocation: ['location', 'search_string'],
  Schedule: ['content_name', 'value', 'currency'],
  StartTrial: ['value', 'currency', 'predicted_ltv'],
  SubmitApplication: ['content_name', 'content_category'],
  Subscribe: ['value', 'currency', 'predicted_ltv'],
  CompleteTutorial: ['content_name', 'content_category', 'value'],
  LevelAchieved: ['level', 'content_name'],
  AchieveLevel: ['level', 'content_name'],
  UnlockAchievement: ['achievement_id', 'achievement_name'],
  Rate: ['rating_value', 'content_name', 'content_ids'],
  SpendCredits: ['value', 'currency'],
  EarnVirtualCurrency: ['value', 'virtual_currency_name'],
  PurchaseVirtualGoods: ['content_ids', 'contents', 'value', 'currency'],
  JoinGroup: ['group_name', 'group_id'],
  CreateGroup: ['group_name', 'group_category'],
  CompleteLevel: ['level', 'score'],
  Share: ['content_name', 'content_type', 'content_id'],
  Invite: ['method', 'content_name'],
  Login: ['login_method'],
  Logout: ['session_duration'],
  SignUp: ['signup_method', 'plan_type'],
  BookAppointment: ['appointment_type', 'value', 'currency'],
  Download: ['file_name', 'file_type'],
  VideoPlay: ['video_title', 'video_duration', 'percent_viewed'],
};

/** Build a Meta (Facebook) Pixel tag from the imported community template (`type` = its cvt_
 *  code). A Meta STANDARD event sets eventName='standard' + standardEventName=<canonical>;
 *  anything else sets eventName='custom' + customEventName=<the event>. The eventName SELECTOR
 *  must always be set — omitting it (only setting standardEventName) makes the template fall
 *  back to its default (standard/PageView). `objectProperties` (name→value) become the Meta
 *  Object Properties (objectPropertyList). Field shape corpus-validated (528 Meta tags). PURE. */
export function buildMetaPixelTag(
  type: string,
  name: string,
  pixelId: string,
  event: string,
  firingTriggerId?: string[],
  objectProperties?: Array<{ name: string; value: string }>
): GtmTagResource {
  const std = metaStandardEvent(event);
  const parameter: Param[] = [tpl('pixelId', pixelId), tpl('eventName', std ? 'standard' : 'custom')];
  if (std) parameter.push(tpl('standardEventName', std));
  else parameter.push(tpl('customEventName', event));
  const props = (objectProperties ?? []).filter((p) => p.name && p.name.trim() !== '');
  if (props.length) {
    parameter.push(boolean('objectPropertiesFromVariable', false));
    parameter.push({
      type: 'list',
      key: 'objectPropertyList',
      list: props.map((p) => ({ type: 'map', map: [tpl('name', p.name), tpl('value', p.value)] })),
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
 *  `ed - <emq key>` variable that feeds it]. ONLY em/ph: the Stape template's own addUserData already
 *  extracts fn/ln/ct/zp/country (and the nested GA4 user_data.* shapes) from the incoming event, and
 *  its overrideDataIfNeeded applies explicit rows UNCONDITIONALLY — so an explicit row whose variable
 *  resolves undefined would ERASE what the template extracted (lower EMQ). em/ph rows carry the
 *  top-level email_address/phone_number keys the template misses, and their ed variables fall back to
 *  the nested user_data.* path (see buildMetaEmqVariables), so they never blank a found value. fbp/fbc
 *  are omitted — the template generates _fbp and reads _fbc from the cookie itself. */
const META_USER_DATA_MAP: Array<[fbKey: string, emqKey: string]> = [
  ['em', 'email_address'],
  ['ph', 'phone_number'],
];
/** The Meta custom_data (event/object) rows — the ecommerce fields. Corpus `customDataList` maps
 *  content_ids/contents/value/currency; order_id comes from the GA4 transaction_id. */
const META_CUSTOM_DATA_MAP: Array<[fbKey: string, emqKey: string]> = [
  ['content_ids', 'content_ids'],
  ['value', 'value'],
  ['currency', 'currency'],
  ['order_id', 'transaction_id'],
];
const edRefRow = ([fbKey, emqKey]: [string, string]): Param => ({ type: 'map', map: [tpl('name', fbKey), tpl('value', `{{ed - ${emqKey}}}`)] });

export function buildMetaCapiServerTag(
  type: string,
  name: string,
  pixelId: string,
  accessToken: string,
  event: string,
  opts?: { actionSource?: string; eventEnhancement?: boolean; generateFbp?: boolean; firingTriggerId?: string[]; mapEmqVariables?: boolean }
): GtmTagResource {
  const std = metaStandardEvent(event);
  // Event-name fields verified against the live stape-io/facebook-tag template: inheritEventName
  // is a SELECT 'inherit'|'override' (NOT a boolean); under 'override', eventName is a RADIO
  // 'standard'|'custom' choosing eventNameStandard vs eventNameCustom.
  const parameter: Param[] = [
    tpl('pixelId', pixelId),
    tpl('accessToken', accessToken),
    tpl('actionSource', opts?.actionSource && opts.actionSource.trim() ? opts.actionSource : 'website'),
    boolean('generateFbp', opts?.generateFbp ?? true),
    boolean('enableEventEnhancement', opts?.eventEnhancement ?? true),
    tpl('inheritEventName', 'override'),
    tpl('eventName', std ? 'standard' : 'custom'),
  ];
  if (std) parameter.push(tpl('eventNameStandard', std));
  else parameter.push(tpl('eventNameCustom', event));
  // Map the EMQ Event-Data variables into the tag's user_data (Event Match Quality), custom_data
  // (ecommerce), and event_id — so the created tag actually SENDS the fields instead of leaving the
  // "Add property" lists empty. Pair with create_meta_emq_variables (which creates the `ed - <key>`
  // variables these reference). Corpus-verified list shapes.
  if (opts?.mapEmqVariables !== false) {
    parameter.push(
      { type: 'list', key: 'userDataList', list: META_USER_DATA_MAP.map(edRefRow) },
      { type: 'list', key: 'customDataList', list: META_CUSTOM_DATA_MAP.map(edRefRow) },
      { type: 'list', key: 'serverEventDataList', list: [edRefRow(['event_id', 'event_id'])] },
    );
  }
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/** Build the Meta EMQ Event Data variables (`ed - <key>`, type `ed`, keyPath `<key>`). email/phone
 *  get a NESTED fallback: GA4 enhanced user data usually arrives nested (user_data.email_address),
 *  where a flat keyPath resolves undefined — so `ed - email_address` reads the flat key with
 *  defaultValue {{ed - user_data.email_address}} (a companion variable reading the nested path).
 *  Either shape then resolves, and the CAPI tag's explicit em/ph rows never blank a value the
 *  template would have found. PURE. */
export function buildMetaEmqVariables(): GtmVariableResource[] {
  const NESTED_FALLBACK = new Set(['email_address', 'phone_number']);
  const out: GtmVariableResource[] = [];
  for (const k of META_EMQ_EVENT_DATA_KEYS) {
    if (NESTED_FALLBACK.has(k)) {
      out.push(buildVariable({ name: `ed - user_data.${k}`, kind: 'event_data', keyPath: `user_data.${k}` }));
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{ed - user_data.${k}}}` }));
    } else {
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k }));
    }
  }
  return out;
}

/** TikTok Events API STANDARD events — the Stape stape-io/tiktok-tag `eventName` SELECT, verified
 *  field-for-field against the live template.tpl. Anything else is a CUSTOM event. */
export const TIKTOK_STANDARD_EVENTS: string[] = [
  'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'ApplicationApproval', 'CompleteRegistration',
  'Contact', 'CustomizeProduct', 'Download', 'FindLocation', 'InitiateCheckout', 'Lead', 'Pageview',
  'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication', 'Subscribe', 'ViewContent',
  'CompletePayment', 'SubmitForm', 'ClickButton', 'PlaceAnOrder',
];

/** Common GA4 (snake_case) event names → TikTok standard event, ONLY where the normalized names
 *  differ. GA4 `purchase` is intentionally ABSENT so it resolves to the current TikTok `Purchase`
 *  event by direct match — the live template marks CompletePayment "legacy - Use Purchase instead"
 *  (pass 'CompletePayment' explicitly if you truly need the legacy event). Keys are normalized
 *  (lowercased, separators stripped); an exact-case TikTok event bypasses this (see below). */
const GA4_TO_TIKTOK: Record<string, string> = {
  viewitem: 'ViewContent',
  viewitemlist: 'ViewContent',
  begincheckout: 'InitiateCheckout',
  addshippinginfo: 'AddPaymentInfo',
  generatelead: 'SubmitForm',
  signup: 'CompleteRegistration',
  filedownload: 'Download',
};

/** Recommended TikTok Events API event properties per event (required + recommended combined), keyed
 *  by the canonical TikTok event name. These are TOP-LEVEL properties (in-`contents` item keys like
 *  content_id/brand/price are set inside the contents variable, not here). Keys in
 *  TIKTOK_CUSTOM_DATA_KEYS go to `customDataList`; the rest (form_name, registration_method, …) the
 *  builder routes to `additionalEventPropertiesList`. order_id is usually mapped from the GA4
 *  transaction_id. Mirrors META_EVENT_OBJECT_PROPERTIES — the caller wires values from variables. */
export const TIKTOK_EVENT_PROPERTIES: Record<string, string[]> = {
  Pageview: ['page_url', 'referrer'],
  ViewContent: ['content_type', 'contents', 'value', 'currency', 'description'],
  Search: ['query', 'content_type'],
  AddToCart: ['contents', 'content_type', 'value', 'currency'],
  AddToWishlist: ['contents', 'content_type', 'value', 'currency'],
  InitiateCheckout: ['contents', 'content_type', 'value', 'currency', 'num_items'],
  AddPaymentInfo: ['contents', 'content_type', 'value', 'currency'],
  Purchase: ['contents', 'content_type', 'value', 'currency', 'order_id', 'description'],
  CompletePayment: ['contents', 'content_type', 'value', 'currency', 'order_id', 'description'],
  CompleteRegistration: ['registration_method'],
  SubmitForm: ['form_name', 'value'],
  Contact: ['contact_method'],
  Subscribe: ['value', 'currency', 'subscription_type'],
  Download: ['file_name', 'file_type'],
  ClickButton: ['button_name', 'page_url'],
  Login: ['login_method'],
};

/** Keys the TikTok server template's `userDataList` SELECT accepts (advanced matching). */
export const TIKTOK_USER_DATA_KEYS: string[] = [
  'email', 'phone', 'external_id', 'ip', 'user_agent', 'ttclid', 'ttp', 'locale', 'idfa', 'idfv',
  'gaid', 'att_status', 'first_name', 'last_name', 'city', 'state', 'country', 'zip_code',
];

/** Keys the TikTok server template's `customDataList` SELECT accepts (event properties). Anything
 *  else is routed to the free-form `additionalEventPropertiesList` so it isn't rejected. */
export const TIKTOK_CUSTOM_DATA_KEYS: string[] = [
  'contents', 'content_ids', 'content_type', 'num_items', 'currency', 'value', 'description',
  'search_string', 'query', 'order_id', 'shop_id',
];

/** Resolve a free-text/GA4 event to a TikTok STANDARD event, or null (→ custom). An EXACT
 *  (case-sensitive) TikTok event passes through; then a GA4 alias maps (view_item → ViewContent,
 *  generate_lead → SubmitForm); then a case/separator-insensitive match (so GA4 `purchase` →
 *  `Purchase`, NOT the legacy CompletePayment). PURE. */
export function tikTokStandardEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return null;
  if (TIKTOK_STANDARD_EVENTS.includes(raw)) return raw; // exact-case escape hatch
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (GA4_TO_TIKTOK[norm]) return GA4_TO_TIKTOK[norm];
  for (const e of TIKTOK_STANDARD_EVENTS) if (e.toLowerCase() === norm) return e;
  return null;
}

/** Build a Stape "TikTok Events API" SERVER tag (gallery template stape-io/tiktok-tag; `type` = its
 *  cvt_ code), tuned for match quality: Event Enhancement ON, generate _ttp ON. A TikTok STANDARD
 *  event sets eventType='standard' + eventName=<canonical>; anything else sets eventType='custom' +
 *  eventNameCustom=<the event>. `eventName` is a literal SELECT (macrosInSelect=false — never a
 *  {{variable}}). `userData` → the `userDataList` advanced-matching table; `eventProperties` →
 *  `customDataList` for known keys, else `additionalEventPropertiesList`. pixelId/accessToken are
 *  typically {{variables}}. Field keys verified against the live template.tpl. NOTE vs Meta CAPI:
 *  eventType IS the inherit/override control (no inheritEventName), and TikTok uses
 *  generateTtp/eventSource (not generateFbp/actionSource). PURE. */
export function buildTikTokCapiServerTag(
  type: string,
  name: string,
  pixelId: string,
  accessToken: string,
  event: string,
  opts?: {
    eventSource?: string;
    eventId?: string;
    userData?: Array<{ name: string; value: string }>;
    eventProperties?: Array<{ name: string; value: string }>;
    testEventCode?: string;
    generateTtp?: boolean;
    eventEnhancement?: boolean;
    requireConsent?: boolean;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const std = tikTokStandardEvent(event);
  const canon = (keys: string[], n: string): string => {
    const low = n.trim().toLowerCase();
    return keys.includes(low) ? low : n.trim();
  };
  const parameter: Param[] = [
    tpl('eventSource', opts?.eventSource && opts.eventSource.trim() ? opts.eventSource.trim() : 'web'),
    tpl('accessToken', accessToken),
    tpl('pixelId', pixelId),
    tpl('eventType', std ? 'standard' : 'custom'),
    std ? tpl('eventName', std) : tpl('eventNameCustom', event),
    boolean('enableEventEnhancement', opts?.eventEnhancement ?? true),
    boolean('generateTtp', opts?.generateTtp ?? true),
    tpl('adStorageConsent', opts?.requireConsent ? 'required' : 'optional'),
  ];
  if (opts?.eventId && opts.eventId.trim()) parameter.push(tpl('eventId', opts.eventId));
  if (opts?.testEventCode && opts.testEventCode.trim()) parameter.push(tpl('testEventCode', opts.testEventCode));

  const ud = (opts?.userData ?? []).filter((u) => u.name && u.name.trim() !== '');
  if (ud.length) {
    parameter.push({
      type: 'list',
      key: 'userDataList',
      list: ud.map((u) => ({ type: 'map', map: [tpl('name', canon(TIKTOK_USER_DATA_KEYS, u.name)), tpl('value', u.value)] })),
    });
  }

  const props = (opts?.eventProperties ?? []).filter((p) => p.name && p.name.trim() !== '');
  const known = props.filter((p) => TIKTOK_CUSTOM_DATA_KEYS.includes(p.name.trim().toLowerCase()));
  const extra = props.filter((p) => !TIKTOK_CUSTOM_DATA_KEYS.includes(p.name.trim().toLowerCase()));
  if (known.length) {
    parameter.push({
      type: 'list',
      key: 'customDataList',
      list: known.map((p) => ({ type: 'map', map: [tpl('name', p.name.trim().toLowerCase()), tpl('value', p.value)] })),
    });
  }
  if (extra.length) {
    parameter.push({
      type: 'list',
      key: 'additionalEventPropertiesList',
      list: extra.map((p) => ({ type: 'map', map: [tpl('name', p.name.trim()), tpl('value', p.value)] })),
    });
  }

  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

export interface MetaTagDetection {
  metaTags: Array<{ id: string; name: string; type: string; ecommerceEvents: string[] }>;
  hasMetaPixel: boolean;
  hasEcommerce: boolean;
}

/** Detect Meta/Facebook pixel tags in a WEB container snapshot — Custom HTML with the fbq
 *  pixel, or a tag named/typed for Facebook/Meta. Reports any standard ecommerce events
 *  (Purchase, AddToCart, …) referenced, so callers can tell whether Meta ECOMMERCE is in use. PURE. */
export function detectMetaTags(snapshot: ContainerSnapshot): MetaTagDetection {
  const META_RE = /fbq\s*\(|fbevents|connect\.facebook\.net|facebook|meta[\s_-]?pixel|fb[\s_-]?pixel/i;
  const ECOM_RE = /['"](Purchase|AddToCart|InitiateCheckout|AddPaymentInfo|ViewContent|AddToWishlist|Subscribe)['"]/g;
  const metaTags: MetaTagDetection['metaTags'] = [];
  for (const t of snapshot.tags) {
    let html = '';
    for (const p of t.parameter) {
      const pp = p as { key?: string; value?: unknown };
      if (pp.key === 'html') html = String(pp.value ?? '');
    }
    const hay = `${t.name} ${t.type}`;
    if (!META_RE.test(hay) && !META_RE.test(html)) continue;
    const ecommerceEvents = Array.from(new Set([...html.matchAll(ECOM_RE)].map((m) => m[1])));
    metaTags.push({ id: t.tagId, name: t.name, type: t.type, ecommerceEvents });
  }
  return {
    metaTags,
    hasMetaPixel: metaTags.length > 0,
    hasEcommerce: metaTags.some((m) => m.ecommerceEvents.length > 0),
  };
}
