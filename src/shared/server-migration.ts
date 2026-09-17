// The WEB → SERVER (sGTM) migration surface, shared by the MCP server (src/tools) and the desktop app:
//   - the audit snapshot types the planner and recognisers read (AuditTag / ContainerSnapshot / …);
//   - the native sGTM builders (GA4 relay, Google Ads conversion / linker / remarketing, clients, triggers);
//   - the CAPI server-tag builders, each verified against its vendor template.tpl (Meta, TikTok, LinkedIn,
//     Pinterest, StackAdapt, Reddit, Snapchat, Microsoft, Amazon, X, Quora, AdRoll, Nextdoor, Yelp, Spotify,
//     LINE Yahoo, RTB House) plus the Stape Data Tag / Data Client pair;
//   - the parameter-shape recognisers that identify those server tags in an audit;
//   - planWebToServerMigration, which maps a web container's pixels to the tool that ports each.
// Moved here verbatim from apps/desktop/src/main/google/gtm-builders.ts (E1 of the migration program)
// so the MCP server can expose the same tools; the desktop file re-exports everything from this module.
// PURE: no Electron, no googleapis - only the shared primitives below.

import { tpl, boolean, condition, sanitizeName, buildVariable, type Param, type GtmTagResource, type GtmTriggerResource, type GtmVariableResource } from './gtm-builders.js';
export interface AuditTag {
  tagId: string;
  name: string;
  type: string;
  firingTriggerId: string[];
  /** Exception/blocking triggers — a trigger listed here IS in use. */
  blockingTriggerId?: string[];
  paused: boolean;
  parameter: Array<Record<string, unknown>>;
  /** Tag firing option: 'oncePerEvent' | 'oncePerLoad' | 'unlimited'. Drives the inventory's
   *  "Firing Option" column and the form-tag once-per-load hint. Absent = GTM's default (oncePerEvent). */
  tagFiringOption?: string;
  /** Consent Mode v2 settings, when present on the tag. consentType is a
   *  parameter list that may itself reference {{variables}}. */
  consentSettings?: { consentStatus?: string; consentType?: unknown } | null;
  /** Tag Sequencing "fire a tag BEFORE this one" (setup tags), by tag NAME. Present only
   *  when the tag has sequencing, so its absence means none. stopOnSetupFailure = "don't
   *  fire this tag if the setup tag fails". */
  setupTag?: Array<{ tagName: string; stopOnSetupFailure: boolean }>;
  /** Tag Sequencing "fire a tag AFTER this one" (cleanup tags), by tag NAME. */
  teardownTag?: Array<{ tagName: string; stopTeardownOnFailure: boolean }>;
  /** The workspace folder this tag lives in (workspace-scoped id; resolve to a name to compare
   *  organization across workspaces). Optional/additive — read-path only, never written. */
  parentFolderId?: string;
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
  parentFolderId?: string;
}
export interface AuditVariable {
  variableId: string;
  name: string;
  type: string;
  /** Variable config — scanned for {{variable}} references to other variables. */
  parameter?: Array<Record<string, unknown>>;
  parentFolderId?: string;
}

/**
 * A machine-applicable fix for a finding: call `tool` with `args`. The audit
 * fills the resource id (tagId/triggerId/variableId); the registry injects the
 * workspace ids (accountId/containerId/workspaceId) before returning, so the
 * model can apply the fix in one call once the user approves.
 */

export interface ContainerSnapshot {
  tags: AuditTag[];
  triggers: AuditTrigger[];
  variables: AuditVariable[];
}

export interface ServerContainerSnapshot {
  /** The container's tagging server URL(s) — empty if the host isn't provisioned yet. */
  taggingServerUrls: string[];
  /** parameter is optional (older callers/tests) — carried so client configs join the
   *  {{variable}} reference scan. */
  clients: Array<{ clientId: string; name: string; type: string; parameter?: unknown[] }>;
  tags: AuditTag[];
  /** The server workspace's triggers — needed to compare firing conditions (duplicate
   *  GA4 relays) and to scan filter values (URL-encoded event names). Optional so older
   *  callers/tests that omit it still type-check; treated as [] when absent. */
  triggers?: AuditTrigger[];
  /** The server workspace's variables — enables the unused-variable + dangling-reference
   *  checks. Optional so older callers/tests still type-check. */
  variables?: ContainerSnapshot['variables'];
  transformations: Array<{ transformationId: string; name: string; type: string; parameter?: unknown[] }>;
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
 *  migrated from the JS client id) — the production pattern from the reference export
 *  server container (GTM-REFEXP01) and Stape's recommended setup: the identifier survives
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
 *  reference export: compression + dependency serving ON, geo resolution OFF, and
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

/* ── Server GA4 (sgtmgaaw) "Parameters / Properties to Add / Edit" row shape ── */

/** The map key for a server GA4 (`sgtmgaaw`) "Parameters/Properties to Add / Edit" row's NAME column.
 *  Verified against a real server-container export: the native sgtmgaaw tag keys each add/edit row (AND
 *  each `epToExclude`/`upToExclude` row) by `fieldName` + `value` — NOT `name`. Using `name` left the
 *  parameter name unread, so GTM silently dropped the row. Same constant as the desktop's tag-params.ts
 *  (kept in sync); the MCP package's src/utils/tagParams.ts mirror does not carry the server-GA4 helpers. */
export const SERVER_PARAM_NAME_KEY = 'fieldName';

function serverParamRow(name: string, value: string): Param {
  return { type: 'map', map: [{ type: 'template', key: SERVER_PARAM_NAME_KEY, value: name }, { type: 'template', key: 'value', value }] };
}

/** Build a fresh server GA4 add-list Param — `eventParameters` = "Event Parameters to Add / Edit",
 *  `userProperties` = "User Properties to Add / Edit" — from name/value rows (empty-name rows dropped).
 *  List keys verified against a real sgtmgaaw export (the earlier `epToAdd`/`upToAdd` keys did not exist
 *  on the native tag, so GTM ignored the whole list). PURE. */
export function serverGa4ParamList(listKey: 'eventParameters' | 'userProperties', rows: Array<{ name: string; value: string }>): Param {
  return { type: 'list', key: listKey, list: rows.filter((r) => r.name && r.name.trim() !== '').map((r) => serverParamRow(r.name, r.value)) };
}

/** A server-side GA4 tag (`sgtmgaaw`) — forwards the event the client received on to GA4.
 *  Shape corpus-validated. eventName is OMITTED when not given so GTM inherits the incoming
 *  event's event_name (per Google/Stape docs — a blank Event Name relays whatever arrived;
 *  this also avoids depending on the {{Event Name}} built-in being enabled). Pass a literal
 *  (e.g. "purchase") for a per-event tag. ep/upToIncludeDropdown='all' forwards all event +
 *  user parameters. */
export function buildGa4ServerTag(
  name: string,
  measurementId: string,
  eventName?: string,
  firingTriggerId?: string[],
  opts?: { eventParameters?: Array<{ name: string; value: string }>; userProperties?: Array<{ name: string; value: string }> },
): GtmTagResource {
  const parameter: Param[] = [];
  if (eventName && eventName.trim() !== '') parameter.push(tpl('eventName', eventName));
  parameter.push(tpl('measurementId', measurementId), tpl('epToIncludeDropdown', 'all'), tpl('upToIncludeDropdown', 'all'));
  // Optional "Event Parameters to Add / Edit" (eventParameters) + "User Properties to Add / Edit"
  // (userProperties) — for ENRICHMENT (server-derived values not already on the incoming event; the
  // event's own params flow via epToIncludeDropdown='all'). Row shape via serverGa4ParamList.
  const eps = (opts?.eventParameters ?? []).filter((p) => p.name && p.name.trim() !== '');
  const ups = (opts?.userProperties ?? []).filter((p) => p.name && p.name.trim() !== '');
  if (eps.length) parameter.push(serverGa4ParamList('eventParameters', eps) as Param);
  if (ups.length) parameter.push(serverGa4ParamList('userProperties', ups) as Param);
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
     *  the multi-tenant campaign pattern from the reference export: one event, one page/campaign,
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
 *  conversion value/currency from the event the client received; conversionId is the Ads
 *  account id, conversionLabel the per-conversion label (both may be {{variables}}). The
 *  sgtmadsct template validates conversionId as a POSITIVE INTEGER, so the "AW-" prefix is
 *  stripped (an "AW-12345678" input becomes "12345678"); a {{variable}} is passed through. */
export function buildAdsConversionServerTag(name: string, conversionId: string, conversionLabel: string, firingTriggerId?: string[], productReporting?: boolean): GtmTagResource {
  const parameter: Param[] = [
    tpl('conversionId', normalizeAdsConversionId(conversionId)),
    tpl('conversionLabel', conversionLabel),
    boolean('enableConversionLinker', true),
    boolean('enableProductReporting', productReporting === true),
  ];
  // Product / Shopping (cart-data) reporting only matters for ECOMMERCE conversions, so it is OFF by
  // default — a plain lead/signup conversion shouldn't advertise product reporting with no items to send.
  // Pass productReporting=true for purchase-style conversions to forward the event's product data.
  if (productReporting === true) parameter.push(tpl('productReportingDataSource', 'EVENT'));
  parameter.push(boolean('rdp', false));
  return {
    name: sanitizeName(name),
    type: 'sgtmadsct',
    parameter,
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
 *  Dynamic remarketing reads item data from the event; conversionId is the Ads id (the
 *  "AW-" prefix is stripped to the numeric id the template requires; {{variables}} pass through). */
export function buildAdsRemarketingServerTag(name: string, conversionId: string, firingTriggerId?: string[]): GtmTagResource {
  return {
    name: sanitizeName(name),
    type: 'sgtmadsremarket',
    parameter: [
      tpl('conversionId', normalizeAdsConversionId(conversionId)),
      boolean('enableConversionLinker', true),
      boolean('enableDynamicRemarketing', true),
      tpl('remarketingEventDataSource', 'EVENT_DATA'),
      boolean('rdp', false),
    ],
    ...(firingTriggerId ? { firingTriggerId } : {}),
  };
}

/** The dataLayer event a Custom Event trigger fires on — the arg1 of the {{_event}}
 *  condition in customEventFilter (e.g. "product_view"). '' if not a custom-event trigger. */

/** Read a TEMPLATE param's string value off an audit tag ('' when absent/non-string). PURE. */
export function serverTagParam(t: AuditTag, key: string): string {
  const params = Array.isArray(t.parameter) ? t.parameter : [];
  const p = params.find((x) => (x as { key?: string }).key === key) as { value?: unknown } | undefined;
  return p && typeof p.value === 'string' ? p.value : '';
}

/** A {{variable}} reference resolves at runtime, so its literal shape can't be checked —
 *  credential/field/encoding checks skip these. PURE. */
export function isVariableRef(v: string): boolean {
  return /^\{\{.*\}\}$/.test(v.trim());
}

/** The Stape "Facebook Conversions API" server template stores its destination as
 *  `pixelId` + `accessToken` TEMPLATE params. The TikTok template ALSO uses those keys
 *  (see buildTikTokCapiServerTag), so pixelId+accessToken alone is not enough — we also
 *  require a Facebook-distinctive field (generateFbp / actionSource) that TikTok never emits
 *  (it uses generateTtp / eventSource). This keeps the Meta-only swapped-field and test-code
 *  checks from misfiring on a TikTok tag. PURE. */
export function isMetaCapiServerTag(t: AuditTag): boolean {
  if (!t.type.startsWith('cvt_')) return false;
  const params = Array.isArray(t.parameter) ? t.parameter : [];
  const keys = new Set(params.map((p) => (p as { key?: string }).key));
  if (!(keys.has('pixelId') && keys.has('accessToken'))) return false;
  return keys.has('generateFbp') || keys.has('actionSource');
}

/** The TikTok "Events API" server template ALSO stores pixelId + accessToken, but is distinguished from
 *  Meta by its TikTok-only fields (generateTtp / eventSource, vs Meta's generateFbp / actionSource). PURE. */
export function isTikTokCapiServerTag(t: AuditTag): boolean {
  if (!t.type.startsWith('cvt_')) return false;
  const keys = new Set((Array.isArray(t.parameter) ? t.parameter : []).map((p) => (p as { key?: string }).key));
  if (!(keys.has('pixelId') && keys.has('accessToken'))) return false;
  return keys.has('generateTtp') || keys.has('eventSource');
}

/** The official Snapchat CAPI server template stores its destination as `pixelId` + `apiAccessToken`
 *  (Snap uses `apiAccessToken`, distinct from Meta/TikTok's `accessToken`), so that pair identifies it. PURE. */
export function isSnapchatCapiServerTag(t: AuditTag): boolean {
  if (!t.type.startsWith('cvt_')) return false;
  const keys = new Set((Array.isArray(t.parameter) ? t.parameter : []).map((p) => (p as { key?: string }).key));
  return keys.has('pixelId') && keys.has('apiAccessToken');
}

/** The Stape Microsoft Ads (Bing) UET CAPI server template stores its destination as `uetTagId` +
 *  `authToken` — a pair no other server template uses. PURE. */
export function isMicrosoftCapiServerTag(t: AuditTag): boolean {
  if (!t.type.startsWith('cvt_')) return false;
  const keys = new Set((Array.isArray(t.parameter) ? t.parameter : []).map((p) => (p as { key?: string }).key));
  return keys.has('uetTagId') && keys.has('authToken');
}

/** Parameter-key set of a cvt_ template tag (empty for any other type) — the shape every CAPI
 *  recogniser below reads. PURE. */
function cvtParamKeys(t: AuditTag): Set<string> {
  if (!t.type.startsWith('cvt_')) return new Set();
  return new Set((Array.isArray(t.parameter) ? t.parameter : []).map((p) => (p as { key?: string }).key ?? ''));
}

/** The Stape LinkedIn CAPI server template fires on `conversionRuleUrn` with an `accessToken` — no
 *  other server template carries a conversion-rule URN, so that pair identifies it. PURE. */
export function isLinkedInCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('accessToken') && keys.has('conversionRuleUrn');
}

/** Pinterest's official server template stores `advertiserId` + `apiAccessToken`. Snapchat also uses
 *  `apiAccessToken` but keys on `pixelId`, so `advertiserId` is the discriminator. PURE. */
export function isPinterestCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('advertiserId') && keys.has('apiAccessToken');
}

/** The Stape Reddit CAPI server template stores `accountId` + `accessToken`; Quora's Stape template
 *  uses the same pair, so a Reddit-only field (actionSource / testId / its auto-map toggle) is also
 *  required. PURE. */
export function isRedditCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  if (!(keys.has('accountId') && keys.has('accessToken'))) return false;
  return keys.has('actionSource') || keys.has('testId') || keys.has('autoMapServerEventData');
}

/** The Stape Amazon Ads server template is the only one keyed by an ad `tagRegion` (NA/EU) alongside
 *  its tag-id list / advanced-matching fields. PURE. */
export function isAmazonCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('tagRegion') && (keys.has('tagIdsList') || keys.has('matchId') || keys.has('enableAdvancedMatching'));
}

/** StackAdapt's server pixel template stores `pixelID` (capital ID — distinct from every `pixelId`
 *  template) + `pixelType`. PURE. */
export function isStackAdaptServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('pixelID') && keys.has('pixelType');
}

/** The Stape X (Twitter) CAPI template is keyed by `pixelId` plus its X-only auth fields: either the
 *  Pixel Access Token or the OAuth 1.0a consumer/token quartet (authMethod). PURE. */
export function isXCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('pixelId') && (keys.has('pixelAccessToken') || keys.has('consumerKey') || keys.has('authMethod'));
}

/** Quora's Stape template shares Reddit's `accountId` + `accessToken` pair; its own conversion /
 *  device-event tables are the discriminator (Reddit has neither). PURE. */
export function isQuoraCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('accountId') && keys.has('accessToken') && (keys.has('conversionDataList') || keys.has('deviceEventDataList'));
}

/** AdRoll is the only server template keyed by an `advertisableId` alongside its `pixelId`. PURE. */
export function isAdRollCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('advertisableId') && keys.has('pixelId');
}

/** Nextdoor stores `pixelId` + `clientId` + `accessToken` (the clientId beside a pixelId is unique to it). PURE. */
export function isNextdoorCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('pixelId') && keys.has('clientId') && keys.has('accessToken');
}

/** Yelp's template has no pixel id at all: an `accessToken` with its own `validate` toggle. PURE. */
export function isYelpCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('accessToken') && keys.has('validate') && !keys.has('pixelId');
}

/** Spotify Ads is keyed by `authToken` + `connectionId`. PURE. */
export function isSpotifyCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('authToken') && keys.has('connectionId');
}

/** LINE Yahoo (Yahoo! JAPAN Ads) is keyed by a Yahoo `tagId` + `channelId`. PURE. */
export function isLineYahooCapiServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('tagId') && keys.has('channelId');
}

/** RTB House has no token: its `taggingHash` + `partnerKey` pair identifies the retargeting tag. PURE. */
export function isRtbHouseServerTag(t: AuditTag): boolean {
  const keys = cvtParamKeys(t);
  return keys.has('taggingHash') && keys.has('partnerKey');
}

/** Any recognised CAPI / server-pixel template tag, regardless of vendor. Used where the audit needs
 *  "is this a server destination" without caring which (PII flow, coverage). PURE. */
export function isAnyCapiServerTag(t: AuditTag): boolean {
  return isMetaCapiServerTag(t) || isTikTokCapiServerTag(t) || isSnapchatCapiServerTag(t) || isMicrosoftCapiServerTag(t)
    || isLinkedInCapiServerTag(t) || isPinterestCapiServerTag(t) || isRedditCapiServerTag(t) || isAmazonCapiServerTag(t) || isStackAdaptServerTag(t)
    || isXCapiServerTag(t) || isQuoraCapiServerTag(t) || isAdRollCapiServerTag(t) || isNextdoorCapiServerTag(t) || isYelpCapiServerTag(t)
    || isSpotifyCapiServerTag(t) || isLineYahooCapiServerTag(t) || isRtbHouseServerTag(t);
}


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
  'contents',
  'num_items',
  'email_address',
  'phone_number',
  'external_id',
  'user_id',
  'first_name',
  'last_name',
  'country',
  'city',
  'postal_code',
  'ip_override',
  'user_agent',
];

/** The tag `type` code for a custom template. A GALLERY-imported template is referenced by
 *  `cvt_<galleryTemplateId>` (the id GTM resolves the vendor template by, e.g. cvt_MRQN8) —
 *  NOT cvt_<containerId>_<templateId>, which only applies to locally-authored templates. Using
 *  the wrong one makes tags.create reject the tag ("Unknown entity type"). PURE. */

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

/** Meta Pixel WEB Object Property → dataLayer variable binding, used to AUTO-FILL objectProperties
 *  from META_EVENT_OBJECT_PROPERTIES when the caller passes none, so a created Meta Pixel tag ships
 *  with its conversion value. ONLY value/currency: they map 1:1 to the ecommerce dlv variables. Meta's
 *  content_ids/contents need the GA4 items array RESHAPED (ids / {id,quantity,item_price} objects) — a
 *  raw {{dlv - ecommerce.items}} would send malformed data — so those are left for the user to wire.
 *  Pair with the `dlv - ecommerce.*` variables (buildEcommerceDlvVariables). */

const META_USER_DATA_MAP: Array<[fbKey: string, emqKey: string]> = [
  ['em', 'email_address'],
  ['ph', 'phone_number'],
  ['external_id', 'external_id'],
  ['client_ip_address', 'ip_override'],
  ['client_user_agent', 'user_agent'],
];
const edRefRow = ([fbKey, emqKey]: [string, string]): Param => ({ type: 'map', map: [tpl('name', fbKey), tpl('value', `{{ed - ${emqKey}}}`)] });

/** Keys the Stape facebook-tag `userDataList` (advanced-matching / EMQ) SELECT accepts — verified
 *  against the live template.tpl (defaultValue "em"). Callers may pass an explicit userData row for
 *  any of these to ADD or override the auto-mapped em/ph/external_id. Unknown keys pass through. */
export const META_USER_DATA_KEYS: string[] = [
  'em', 'ph', 'ge', 'db', 'ln', 'fn', 'ct', 'st', 'zp', 'country', 'external_id',
  'client_ip_address', 'client_user_agent', 'fbc', 'fbp', 'subscription_id', 'lead_id',
  'fb_login_id', 'anon_id', 'madid', 'page_id', 'page_scoped_user_id', 'ctwa_clid',
  'ig_account_id', 'ig_sid',
];
const canonMetaUserDataKey = (name: string): string => {
  const low = name.trim().toLowerCase();
  return META_USER_DATA_KEYS.includes(low) ? low : name.trim();
};

/** Meta custom_data fb key → its value source: an `ed - <emq key>` variable, or a LITERAL (content_type
 *  has no clean event key → "product"). Only keys with a binding are auto-mapped; an event's other
 *  recommended object properties (content_name, registration_method, …) are left for the user. */
const META_CUSTOM_DATA_BINDING: Record<string, { ed: string } | { literal: string }> = {
  // contents / content_ids / num_items / content_type are intentionally NOT bound. The Stape template's
  // addEcommerceData BUILDS custom_data.contents (an array of {id,quantity,item_price,…}) from the event's
  // `items` and auto-detects content_type ('product' vs 'product_group'), BEFORE the tag's customDataList
  // override runs — and that override is applied UNCONDITIONALLY (mappedData.custom_data[name] = value with
  // no validity check). A GA4-sourced event has no FLAT `contents` key, so {{ed - contents}} resolves
  // undefined; binding it would overwrite the template's product array with undefined, and cleanupData
  // (isValidValue) then drops it — shipping every ecommerce tag with NO contents and breaking catalog/DPA
  // matching. So we leave these to the template. (content_ids/num_items aren't built by the template and
  // {{ed - …}} resolve undefined for GA4 events too, so binding them only risked the same erase for no gain.)
  value: { ed: 'value' },
  currency: { ed: 'currency' },
  order_id: { ed: 'transaction_id' },
};
/** Event-aware custom_data rows: the recommended object properties for `std` (minus event_id, which
 *  is sent via serverEventDataList) that have a binding, in a stable order. For a custom event
 *  (std null) fall back to the core ecommerce set. value + currency are always included. */
function metaCustomDataRows(std: string | null): Param[] {
  const keys = std ? (META_EVENT_OBJECT_PROPERTIES[std] ?? []) : ['value', 'currency', 'order_id'];
  const rows: Param[] = [];
  const seen = new Set<string>();
  const add = (k: string): void => {
    if (seen.has(k)) return;
    const b = META_CUSTOM_DATA_BINDING[k];
    if (!b) return;
    seen.add(k);
    rows.push({ type: 'map', map: [tpl('name', k), tpl('value', 'ed' in b ? `{{ed - ${b.ed}}}` : b.literal)] });
  };
  for (const k of keys) if (k !== 'event_id') add(k);
  add('value');
  add('currency');
  return rows;
}

export function buildMetaCapiServerTag(
  type: string,
  name: string,
  pixelId: string,
  accessToken: string,
  event: string,
  opts?: {
    actionSource?: string;
    eventEnhancement?: boolean;
    generateFbp?: boolean;
    firingTriggerId?: string[];
    mapEmqVariables?: boolean;
    /** Explicit advanced-matching rows to ADD to (not replace) the auto-mapped em/ph/external_id —
     *  the Meta CAPI analog of GA4 user properties / TikTok userData. name ∈ META_USER_DATA_KEYS
     *  (fbc, fbp, client_ip_address, subscription_id, lead_id, fb_login_id, ge, db, ct, st, zp,
     *  country, fn, ln, …); value usually a {{variable}}. A caller row WINS a name collision with the
     *  auto-map. Emitted even when mapEmqVariables=false, so you can hand-pick the whole user_data set. */
    userData?: Array<{ name: string; value: string }>;
    /** Optional `userDataObject` — a SELECT/variable whose object is merged into user_data. */
    userDataObject?: string;
  }
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
  const mapEmq = opts?.mapEmqVariables !== false;
  // user_data (advanced matching): the auto-mapped em/ph/external_id rows (when mapEmq is on) PLUS any
  // explicit caller rows, keyed by name so a caller row REPLACES an auto row of the same name (override)
  // and new keys append. This only ever ADDS rows the caller asked for beyond the safe auto set, so it
  // preserves the erase-safety invariant (an undefined-resolving explicit row can't blank a value the
  // template extracts itself — see META_USER_DATA_MAP). Emitted whenever it is non-empty, so explicit
  // userData still ships even with mapEmqVariables=false.
  const udByName = new Map<string, Param>();
  if (mapEmq) for (const pair of META_USER_DATA_MAP) udByName.set(pair[0], edRefRow(pair));
  for (const u of opts?.userData ?? []) {
    if (!u.name || u.name.trim() === '') continue;
    const key = canonMetaUserDataKey(u.name);
    udByName.set(key, { type: 'map', map: [tpl('name', key), tpl('value', u.value)] });
  }
  if (udByName.size) parameter.push({ type: 'list', key: 'userDataList', list: [...udByName.values()] });
  if (opts?.userDataObject && opts.userDataObject.trim()) parameter.push(tpl('userDataObject', opts.userDataObject.trim()));
  // custom_data (ecommerce) + event_id follow the auto-map toggle — they are event-derived, not identity.
  if (mapEmq) {
    parameter.push(
      { type: 'list', key: 'customDataList', list: metaCustomDataRows(std) },
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
  // external_id (Meta's stable-user-id field) falls back to the GA4 user_id, so it resolves whether the
  // event carries `external_id` or `user_id`. (A missing referenced variable is a harmless empty string.)
  const SIBLING_FALLBACK: Record<string, string> = { external_id: 'user_id' };
  // Keys whose ed variable falls back to a REQUEST HEADER when the event omits them: `ed - user_agent`
  // defaults to `{{rh - user-agent}}` (the request User-Agent) and `ed - ip_override` to
  // `{{rh - x-forwarded-for}}` (the client IP the tagging host forwards). We also emit each `rh - <header>`
  // request_header variable so the reference isn't dangling. This gives the auto-mapped client_ip_address
  // / client_user_agent rows a real server-side source even when the incoming event carries neither, and
  // means the row only ever resolves empty when there is genuinely no IP/UA anywhere (so it can never
  // downgrade a value the template would otherwise have had).
  const HEADER_FALLBACK: Record<string, string> = { user_agent: 'user-agent', ip_override: 'x-forwarded-for' };
  const out: GtmVariableResource[] = [];
  for (const k of META_EMQ_EVENT_DATA_KEYS) {
    if (NESTED_FALLBACK.has(k)) {
      out.push(buildVariable({ name: `ed - user_data.${k}`, kind: 'event_data', keyPath: `user_data.${k}` }));
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{ed - user_data.${k}}}` }));
    } else if (SIBLING_FALLBACK[k]) {
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{ed - ${SIBLING_FALLBACK[k]}}}` }));
    } else if (HEADER_FALLBACK[k]) {
      const header = HEADER_FALLBACK[k];
      out.push(buildVariable({ name: `rh - ${header}`, kind: 'request_header', headerName: header }));
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{rh - ${header}}}` }));
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
// NOTE: page_url / referrer are intentionally NOT listed. TikTok EAPI 2.0 carries page context in a
// separate `page` object (page.url / page.referrer), which the Stape template auto-populates via
// autoMapPageData (default on) — they are not `properties`, and this builder has no binding for them, so
// listing them here only advertised a field the auto-fill could never emit.
export const TIKTOK_EVENT_PROPERTIES: Record<string, string[]> = {
  ViewContent: ['content_type', 'contents', 'value', 'currency', 'description'],
  Search: ['query'],
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
  ClickButton: ['button_name'],
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

/** Build a Stape DATA TAG (WEB container; gallery template stape-io/data-tag, `type` = its cvt_
 *  code). Field keys verified against the template: gtm_server_domain (the tagging server URL),
 *  request_path (default /data), event_type standard|custom, add_data_layer / add_common /
 *  add_consent_state checkboxes. Defaults: standard page_view event on All Pages, full dataLayer +
 *  common page data + consent state included. PURE. */
export function buildStapeDataTag(type: string, name: string, serverUrl: string, opts?: { requestPath?: string; firingTriggerId?: string[] }): GtmTagResource {
  return {
    name,
    type,
    parameter: [
      { type: 'template', key: 'event_type', value: 'standard' },
      { type: 'template', key: 'event_name_standard', value: 'page_view' },
      { type: 'template', key: 'gtm_server_domain', value: serverUrl },
      { type: 'template', key: 'request_path', value: opts?.requestPath ?? '/data' },
      { type: 'boolean', key: 'add_data_layer', value: 'true' },
      { type: 'boolean', key: 'add_common', value: 'true' },
      { type: 'boolean', key: 'add_consent_state', value: 'true' },
    ],
    // 2147479553 = the web container's built-in All Pages (pageview) trigger id.
    firingTriggerId: opts?.firingTriggerId ?? ['2147479553'],
  } as unknown as GtmTagResource;
}

/** Build a Stape DATA CLIENT (SERVER container; gallery template stape-io/data-client, `type` = its
 *  cvt_ code). It CLAIMS the Data Tag's request path (default /data) and turns each posted payload into a
 *  server event, persisting first-party identity (via a first-party client-id cookie) so a later
 *  conversion that arrives WITHOUT identity still matches - the enrichment that raises CAPI Event Match
 *  Quality. The template's defaults already suit this (generateClientId + prolongCookies on, path /data);
 *  they are set explicitly here, plus acceptMultipleEvents so a batched dataLayer payload is fully
 *  processed. Field keys verified against template.tpl. The default /data path matches buildStapeDataTag's
 *  default request_path, so the pair works with no extra config. PURE. */
export function buildStapeDataClient(type: string, name: string): GtmClientResource {
  return {
    name: sanitizeName(name),
    type,
    parameter: [
      boolean('generateClientId', true),
      boolean('prolongCookies', true),
      boolean('acceptMultipleEvents', true),
    ],
  } as unknown as GtmClientResource;
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
/** The Event Data (`ed - <key>`) variables a TikTok SERVER tag reads off the incoming event to
 *  populate user_data + event properties + event_id — the TikTok analog of META_EMQ_EVENT_DATA_KEYS.
 *  email/phone get a nested `user_data.*` fallback (GA4 enhanced data arrives nested). Created by
 *  create_tiktok_emq_variables so the auto-mapped rows resolve instead of dangling. */
export const TIKTOK_EMQ_EVENT_DATA_KEYS: string[] = [
  'email_address', 'phone_number', 'external_id', 'event_id',
  'value', 'currency', 'contents', 'content_ids', 'content_type',
  'num_items', 'transaction_id', 'search_string', 'description',
  'ip_override', 'user_agent',
];
/** OPT-IN address advanced-matching: TikTok user_data key → the nested GA4 event path it reads. Wired
 *  only when buildTikTokCapiServerTag is called with matchAddress=true. The `ed - address.<field>`
 *  variables are ALWAYS created by buildTikTokEmqVariables so they exist whether or not a tag uses them;
 *  the TikTok template DROPS blank user_data rows at runtime, so a row whose address field is absent from
 *  the event simply isn't sent (no blank overwrite). country reads user_data.address.country (the GA4
 *  region → TikTok state, postal_code → zip_code). */
const TIKTOK_ADDRESS_MATCH: Array<[tiktokKey: string, edSuffix: string, keyPath: string]> = [
  ['first_name', 'address.first_name', 'user_data.address.first_name'],
  ['last_name', 'address.last_name', 'user_data.address.last_name'],
  ['city', 'address.city', 'user_data.address.city'],
  ['state', 'address.region', 'user_data.address.region'],
  ['country', 'address.country', 'user_data.address.country'],
  ['zip_code', 'address.postal_code', 'user_data.address.postal_code'],
];
export function buildTikTokEmqVariables(): GtmVariableResource[] {
  const NESTED_FALLBACK = new Set(['email_address', 'phone_number']);
  // user_agent + ip_override fall back to request headers (same erase-safe superset pattern as Meta):
  // `ed - user_agent` defaults to `{{rh - user-agent}}` and `ed - ip_override` to `{{rh - x-forwarded-for}}`,
  // and we emit each `rh - <header>` variable so the reference resolves — so ip/user_agent are populated
  // from the request even when the incoming event omits them. These variable names are IDENTICAL to Meta's
  // (created idempotently and shared) — intentional.
  const HEADER_FALLBACK: Record<string, string> = { user_agent: 'user-agent', ip_override: 'x-forwarded-for' };
  const out: GtmVariableResource[] = [];
  for (const k of TIKTOK_EMQ_EVENT_DATA_KEYS) {
    if (NESTED_FALLBACK.has(k)) {
      out.push(buildVariable({ name: `ed - user_data.${k}`, kind: 'event_data', keyPath: `user_data.${k}` }));
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{ed - user_data.${k}}}` }));
    } else if (HEADER_FALLBACK[k]) {
      const header = HEADER_FALLBACK[k];
      out.push(buildVariable({ name: `rh - ${header}`, kind: 'request_header', headerName: header }));
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k, defaultValue: `{{rh - ${header}}}` }));
    } else {
      out.push(buildVariable({ name: `ed - ${k}`, kind: 'event_data', keyPath: k }));
    }
  }
  // OPT-IN address advanced-matching variables — always created so they're available; the tag only
  // references them when matchAddress=true.
  for (const [, edSuffix, keyPath] of TIKTOK_ADDRESS_MATCH) {
    out.push(buildVariable({ name: `ed - ${edSuffix}`, kind: 'event_data', keyPath }));
  }
  return out;
}

/** TikTok advanced-matching rows auto-mapped when the caller passes no userData: the TikTok
 *  key → the `ed - <emq key>` variable that feeds it. email/phone use the nested-fallback ed
 *  variables so a GA4-nested payload still resolves. */
const TIKTOK_USER_DATA_AUTO: Array<[tiktokKey: string, emqKey: string]> = [
  ['email', 'email_address'],
  ['phone', 'phone_number'],
  ['external_id', 'external_id'],
  ['ip', 'ip_override'],
  ['user_agent', 'user_agent'],
];
/** TikTok event-property → `ed - <key>` binding, used to auto-fill the recommended properties for an
 *  event (TIKTOK_EVENT_PROPERTIES) when the caller passes none. content_type has no clean event key,
 *  so it is set to the literal "product"; order_id reads the GA4 transaction_id; query reads
 *  search_string. Properties without a binding here are skipped (no dangling reference). */
const TIKTOK_EVENT_PROP_BINDING: Record<string, string> = {
  value: '{{ed - value}}',
  currency: '{{ed - currency}}',
  contents: '{{ed - contents}}',
  content_ids: '{{ed - content_ids}}',
  content_type: 'product',
  num_items: '{{ed - num_items}}',
  order_id: '{{ed - transaction_id}}',
  query: '{{ed - search_string}}',
  description: '{{ed - description}}',
};

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
    /** Auto-fill user_data + event properties + event_id from the `ed - <key>` variables when the
     *  caller passes no explicit rows (default true), so the tag SENDS data instead of shipping empty
     *  lists. Pair with create_tiktok_emq_variables. false = leave the lists to whatever was passed. */
    mapEventData?: boolean;
    /** OPT-IN address advanced-matching (default false): when true AND the auto-map is active AND the
     *  caller passed no explicit userData, APPEND first_name/last_name/city/state/country/zip_code rows
     *  (reading the nested GA4 user_data.address.* via `ed - address.*`) after the identity rows. The
     *  TikTok template drops blank user_data rows at runtime, so an absent address field is simply not
     *  sent (never a blank overwrite). Ignored when userData is explicit (override) or mapEventData=false. */
    matchAddress?: boolean;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const std = tikTokStandardEvent(event);
  const canon = (keys: string[], n: string): string => {
    const low = n.trim().toLowerCase();
    return keys.includes(low) ? low : n.trim();
  };
  // Auto-fill from the incoming event when nothing explicit was passed (default on).
  const autoMap = opts?.mapEventData !== false;
  const hasExplicitUserData = !!(opts?.userData && opts.userData.length);
  let userData = opts?.userData;
  if (autoMap && !hasExplicitUserData) {
    userData = TIKTOK_USER_DATA_AUTO.map(([k, emq]) => ({ name: k, value: `{{ed - ${emq}}}` }));
    // OPT-IN address advanced-matching: append the six address rows AFTER identity/ip/user_agent. Only
    // done for the auto-map path with no explicit userData (explicit rows win — see matchAddress doc).
    if (opts?.matchAddress) {
      for (const [tiktokKey, edSuffix] of TIKTOK_ADDRESS_MATCH) {
        userData.push({ name: tiktokKey, value: `{{ed - ${edSuffix}}}` });
      }
    }
  }
  let eventProperties = opts?.eventProperties;
  if (autoMap && !(eventProperties && eventProperties.length)) {
    const props = std ? (TIKTOK_EVENT_PROPERTIES[std] ?? []) : [];
    eventProperties = props
      .filter((p) => p in TIKTOK_EVENT_PROP_BINDING)
      .map((p) => ({ name: p, value: TIKTOK_EVENT_PROP_BINDING[p] }));
  }
  let eventId = opts?.eventId;
  if (autoMap && !(eventId && eventId.trim())) eventId = '{{ed - event_id}}';
  const parameter: Param[] = [
    tpl('eventSource', opts?.eventSource && opts.eventSource.trim() ? opts.eventSource.trim() : 'web'),
    tpl('accessToken', accessToken),
    tpl('pixelId', pixelId),
    tpl('eventType', std ? 'standard' : 'custom'),
    std ? tpl('eventName', std) : tpl('eventNameCustom', event),
    boolean('enableEventEnhancement', opts?.eventEnhancement ?? true),
    boolean('generateTtp', opts?.generateTtp ?? true),
    tpl('adStorageConsent', opts?.requireConsent ? 'required' : 'optional'),
    // The current stape-io/tiktok-tag template auto-extracts from the incoming event via six automap
    // checkboxes (all default ON). We emit them explicitly so the tag's config is unambiguous, and STILL
    // add our nested-aware `{{ed - …}}` override rows below (they win a key collision, guaranteeing the
    // nested GA4 user_data / header fallbacks the template's flat automap can miss). mapEventData=false
    // turns BOTH off for a fully manual tag.
    boolean('autoMapCommonEventData', autoMap),
    boolean('autoMapUserData', autoMap),
    boolean('autoMapCustomData', autoMap),
    boolean('autoMapPageData', autoMap),
    boolean('autoMapAppData', autoMap),
    boolean('autoMapAdData', autoMap),
  ];
  if (eventId && eventId.trim()) parameter.push(tpl('eventId', eventId));
  if (opts?.testEventCode && opts.testEventCode.trim()) parameter.push(tpl('testEventCode', opts.testEventCode));

  const ud = (userData ?? []).filter((u) => u.name && u.name.trim() !== '');
  if (ud.length) {
    parameter.push({
      type: 'list',
      key: 'userDataList',
      list: ud.map((u) => ({ type: 'map', map: [tpl('name', canon(TIKTOK_USER_DATA_KEYS, u.name)), tpl('value', u.value)] })),
    });
  }

  const props = (eventProperties ?? []).filter((p) => p.name && p.name.trim() !== '');
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

/* ───────────── LinkedIn CAPI (server) ───────────── */

/** The SIMPLE_TABLE `name`-column options the Stape LinkedIn tag accepts (verified against its
 *  template.tpl). userIds = the acceptable match IDs (LinkedIn needs ≥1, or first+last name);
 *  userInfo = additional matching fields; eventData = the conversion event fields. */
export const LINKEDIN_USER_ID_KEYS: string[] = ['email', 'linkedinFirstPartyId', 'acxiomID', 'moatID', 'ipAddress', 'googleAid'];
export const LINKEDIN_USER_INFO_KEYS: string[] = ['firstName', 'lastName', 'jobTitle', 'companyName', 'countryCode'];
export const LINKEDIN_EVENT_DATA_KEYS: string[] = ['conversionHappenedAt', 'currency', 'amount', 'eventId'];

/** Build a Stape "LinkedIn Conversions API" SERVER tag (gallery template stape-io/linkedin-tag;
 *  `type` = its cvt_ code). A CONVERSION tag (type='conversion') needs the LinkedIn `accessToken` +
 *  `conversionRuleUrn` (both usually {{variables}}) — LinkedIn conversions are keyed by a pre-defined
 *  Conversion Rule, so there is no event-name mapping. autoMapEventData/UserIds/UserInfo default ON,
 *  so the template derives currency/amount + the match IDs (hashed email, li_fat_id, …) + user info
 *  from the incoming GA4 event with no explicit rows — the LinkedIn analog of Meta's automap. Pass
 *  explicit userIds/userInfo/eventData rows (name ∈ the LINKEDIN_*_KEYS) to add or override, and
 *  eventId for dedup with the LinkedIn Insight Tag. Field shape verified against the template.tpl. PURE. */
export function buildLinkedInCapiServerTag(
  type: string,
  name: string,
  accessToken: string,
  conversionRuleUrn: string,
  opts?: {
    eventId?: string;
    userIds?: Array<{ name: string; value: string }>;
    userInfo?: Array<{ name: string; value: string }>;
    eventData?: Array<{ name: string; value: string }>;
    autoMap?: boolean;
    optimistic?: boolean;
    requireConsent?: boolean;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const parameter: Param[] = [
    tpl('type', 'conversion'),
    tpl('accessToken', accessToken),
    tpl('conversionRuleUrn', conversionRuleUrn),
    boolean('enablePageViewFromBrowser', false),
    boolean('useOptimisticScenario', opts?.optimistic ?? false),
    boolean('autoMapEventData', auto),
    boolean('autoMapUserIds', auto),
    boolean('autoMapUserInfo', auto),
    boolean('autoMapExternalIds', false),
    tpl('adStorageConsent', opts?.requireConsent ? 'required' : 'optional'),
  ];
  const table = (key: string, rows: Array<{ name: string; value: string }>): void => {
    const clean = rows.filter((r) => r.name && r.name.trim() !== '');
    if (!clean.length) return;
    parameter.push({ type: 'list', key, list: clean.map((r) => ({ type: 'map', map: [tpl('name', r.name.trim()), tpl('value', r.value)] })) });
  };
  // eventId → an eventData row (dedup with the LinkedIn Insight Tag); merged with any explicit rows.
  const eventData = [...(opts?.eventData ?? [])];
  if (opts?.eventId && opts.eventId.trim() !== '' && !eventData.some((r) => r.name === 'eventId')) {
    eventData.push({ name: 'eventId', value: opts.eventId });
  }
  table('eventData', eventData);
  table('userIds', opts?.userIds ?? []);
  table('userInfo', opts?.userInfo ?? []);
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}


/* ───────────── Pinterest Conversions API (server) ───────────── */

/** The Pinterest SERVER template's `eventNameStandard` SELECT values (snake_case — DIFFERENT from the
 *  web ws-gtm-template's concatenated names), verified against ss-gtm-template's template.tpl. */
export const PINTEREST_SERVER_EVENTS: string[] = [
  'add_payment_info', 'add_to_cart', 'add_to_wishlist', 'app_install', 'app_open', 'checkout', 'contact',
  'custom', 'customize_product', 'find_location', 'initiate_checkout', 'lead', 'page_visit', 'schedule',
  'search', 'signup', 'start_trial', 'submit_application', 'subscribe', 'view_category', 'view_content',
  'watch_video',
];
const GA4_TO_PINTEREST_SERVER: Record<string, string> = {
  purchase: 'checkout',
  viewitem: 'view_content',
  viewitemlist: 'view_category',
  selectitem: 'view_category',
  begincheckout: 'initiate_checkout',
  pageview: 'page_visit',
  generatelead: 'lead',
};
/** Resolve an event to a Pinterest SERVER standard event, or null (→ a custom_event). PURE. */
export function pinterestServerEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  for (const e of PINTEREST_SERVER_EVENTS) if (e.replace(/_/g, '') === norm) return e;
  return GA4_TO_PINTEREST_SERVER[norm] ?? null;
}

/** The name-column SELECT sets the Pinterest ss-gtm-template accepts for each override table (verified
 *  against template.tpl). An override row whose name is off these lists is emitted verbatim and then
 *  SILENTLY IGNORED by Pinterest, so we canonicalize common GA4 / plain-language aliases (email→em,
 *  transaction_id→order_id, …) to the real key first. */
export const PINTEREST_USER_DATA_KEYS: string[] = [
  'em', 'ph', 'ge', 'db', 'ln', 'fn', 'ct', 'st', 'zp', 'country',
  'hashed_maids', 'client_ip_address', 'client_user_agent', 'external_id', 'click_id',
];
export const PINTEREST_CUSTOM_DATA_KEYS: string[] = [
  'currency', 'value', 'content_name', 'content_category', 'content_brand', 'content_ids', 'contents',
  'num_items', 'order_id', 'search_string', 'opt_out_type', 'predicted_ltv', 'line_items',
];
export const PINTEREST_SERVER_EVENT_DATA_KEYS: string[] = [
  'action_source', 'event_time', 'event_id', 'event_source_url', 'opt_out', 'partner_name',
  'app_id', 'app_name', 'app_version', 'device_brand', 'device_carrier', 'device_model', 'device_type',
  'os_version', 'wifi', 'language',
];
/** Common GA4 / plain-name aliases → the canonical Pinterest key. Applied only when the alias resolves
 *  to a key in the target table's SELECT set, so it can never turn a valid key into an invalid one. */
const PINTEREST_KEY_ALIAS: Record<string, string> = {
  email: 'em', email_address: 'em', phone: 'ph', phone_number: 'ph', gender: 'ge', date_of_birth: 'db',
  first_name: 'fn', last_name: 'ln', city: 'ct', state: 'st', region: 'st', province: 'st',
  zip: 'zp', zip_code: 'zp', postal_code: 'zp', postalcode: 'zp',
  transaction_id: 'order_id', epik: 'click_id',
};
/** Canonicalize an override row's name to the template's accepted key: lowercase, apply a known alias,
 *  keep it only if it lands in `keys`; otherwise return the trimmed original (unchanged behaviour). */
const canonPinterestKey = (name: string, keys: string[]): string => {
  const low = name.trim().toLowerCase();
  const aliased = PINTEREST_KEY_ALIAS[low] ?? low;
  return keys.includes(aliased) ? aliased : name.trim();
};

/** Build a Pinterest Conversions API SERVER tag (gallery template pinterest/ss-gtm-template; `type` =
 *  its cvt_ code). Needs `advertiserId` (starts 549…) + `apiAccessToken` (both usually {{variables}}).
 *  By default eventName='inherit' + overrideMode=false, so the tag maps the event name AND reads all
 *  event/user/custom data straight from the incoming GA4 event (getAllEventData) — no explicit rows —
 *  the Pinterest analog of Meta CAPI automap. Pass `event` to force a specific Pinterest standard event
 *  (or a custom one → custom_event + adeEventName). Pass override rows (serverEventData/userData/
 *  customData, name ∈ the event's keys) to add/override; testMode routes events to Pinterest test mode.
 *  Field shape verified against the template's template.tpl. PURE. */
export function buildPinterestCapiServerTag(
  type: string,
  name: string,
  advertiserId: string,
  apiAccessToken: string,
  opts?: {
    event?: string;
    testMode?: boolean;
    log?: boolean;
    override?: {
      serverEventData?: Array<{ name: string; value: string }>;
      userData?: Array<{ name: string; value: string }>;
      customData?: Array<{ name: string; value: string }>;
    };
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const parameter: Param[] = [tpl('advertiserId', advertiserId), tpl('apiAccessToken', apiAccessToken)];
  // Event name: inherit from the client (default, recommended) OR force a specific Pinterest event.
  const event = opts?.event?.trim();
  if (event) {
    const std = pinterestServerEvent(event);
    parameter.push(tpl('eventName', 'pinterestEventName'));
    if (std) parameter.push(tpl('eventNameStandard', std));
    else {
      // The template validates the custom name (adeEventName) against ^[a-zA-Z_]+$ (letters + underscores
      // only), so coerce digits/spaces/hyphens to underscores — otherwise a forced custom event fails at
      // create. Empty after cleaning → 'custom_event'.
      const custom = event.replace(/[^a-zA-Z_]+/g, '_').replace(/^_+|_+$/g, '') || 'custom_event';
      parameter.push(tpl('eventNameStandard', 'custom_event'), tpl('adeEventName', custom));
    }
  } else {
    parameter.push(tpl('eventName', 'inherit'));
  }
  // Override tables — only when explicit rows are passed (else overrideMode off → auto getAllEventData).
  const ov = opts?.override;
  // Drop rows with a blank name OR a blank value. Under overrideMode the template applies each override
  // row UNCONDITIONALLY over what getAllEventData already extracted, so a row whose value resolves empty
  // would BLANK a template-extracted field (erase-safety). Only forward rows that carry a value.
  const rows = (arr?: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> =>
    (arr ?? []).filter((r) => r.name && r.name.trim() !== '' && r.value != null && String(r.value).trim() !== '');
  const sed = rows(ov?.serverEventData);
  const ud = rows(ov?.userData);
  const cd = rows(ov?.customData);
  const hasOverride = sed.length > 0 || ud.length > 0 || cd.length > 0;
  parameter.push(boolean('overrideMode', hasOverride));
  // Canonicalize each row's name to the template's accepted key (email→em, transaction_id→order_id, …)
  // so a mis-keyed override lands instead of being silently ignored by Pinterest.
  const table = (key: string, r: Array<{ name: string; value: string }>, keys: string[]): void => {
    if (r.length) parameter.push({ type: 'list', key, list: r.map((x) => ({ type: 'map', map: [tpl('name', canonPinterestKey(x.name, keys)), tpl('value', x.value)] })) });
  };
  table('serverEventDataList', sed, PINTEREST_SERVER_EVENT_DATA_KEYS);
  table('userDataList', ud, PINTEREST_USER_DATA_KEYS);
  table('customDataList', cd, PINTEREST_CUSTOM_DATA_KEYS);
  parameter.push(boolean('testMode', opts?.testMode ?? false));
  parameter.push(tpl('logMode', opts?.log ? 'log' : 'donotlog'));
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── StackAdapt (server pixel) ───────────── */

/** A blank-name/blank-value-safe SIMPLE_TABLE param (list of {name,value} maps). Stape/vendor server
 *  templates store their override tables this way, with the two columns keyed literally "name" and
 *  "value". Rows with an empty name OR value are dropped so an unresolved {{variable}} can never blank a
 *  field the template extracts itself. PURE. */
function nameValueTable(key: string, rows: Array<{ name: string; value: string }>): Param | null {
  const clean = rows.filter((r) => r.name && r.name.trim() !== '' && r.value != null && String(r.value).trim() !== '');
  if (!clean.length) return null;
  return { type: 'list', key, list: clean.map((r) => ({ type: 'map', map: [tpl('name', r.name.trim()), tpl('value', r.value)] })) };
}

/** StackAdapt server pixel type (endpoint + id semantics). Verified against StackAdapt/
 *  stackadapt-gtm-server-side-pixel template.tpl (pixelType SELECT). */
export const STACKADAPT_PIXEL_TYPES: string[] = ['rt', 'lal', 'conv', 'universal'];
/** commonProperties name-column SELECT set (verified). Off-list names are silently ignored by StackAdapt. */
export const STACKADAPT_COMMON_KEYS: string[] = [
  'email', 'first_name', 'last_name', 'phone', 'order_id', 'revenue',
  'product_id', 'product_name', 'product_price', 'product_category', 'action',
];

/** Build a StackAdapt SERVER pixel tag (StackAdapt/stackadapt-gtm-server-side-pixel; `type` = its cvt_
 *  code). UNLIKE the CAPI tags this template is ID-ONLY over HTTPS GET: its ONLY config is `pixelID` (the
 *  audience/conversion/universal id, sent as sid=/cid=/uid= depending on `pixelType`) + `pixelType`
 *  (rt=retargeting audience, lal=lookalike, conv=conversion event, universal=universal event). There is
 *  NO access token and NO browser↔server event_id dedup field (identity is cookie-based, sa-userid /
 *  sa-postbackid, handled by the template at runtime). The semantic action name for a conversion is a
 *  `commonProperties` row named "action" — pass `action` to set it. Extra standard fields go in
 *  `commonProperties` (name ∈ STACKADAPT_COMMON_KEYS), arbitrary ones in `customProperties`. Both tables
 *  use columns "name"/"value". Field shape verified against template.tpl. PURE. */
export function buildStackAdaptServerTag(
  type: string,
  name: string,
  pixelID: string,
  pixelType: string,
  opts?: {
    action?: string;
    commonProperties?: Array<{ name: string; value: string }>;
    customProperties?: Array<{ name: string; value: string }>;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const pt = STACKADAPT_PIXEL_TYPES.includes(pixelType) ? pixelType : 'conv';
  const parameter: Param[] = [tpl('pixelID', pixelID), tpl('pixelType', pt)];
  const common = [...(opts?.commonProperties ?? [])];
  const action = opts?.action?.trim();
  if (action && !common.some((r) => r.name === 'action')) common.push({ name: 'action', value: action });
  const commonTable = nameValueTable('commonProperties', common);
  if (commonTable) parameter.push(commonTable);
  const customTable = nameValueTable('customProperties', opts?.customProperties ?? []);
  if (customTable) parameter.push(customTable);
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── Reddit Conversions API (server) ───────────── */

/** Reddit SERVER standard events (UPPER_SNAKE, from stape-io/reddit-tag eventName SELECT). */
export const REDDIT_SERVER_EVENTS: string[] = [
  'PAGE_VISIT', 'VIEW_CONTENT', 'SEARCH', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'PURCHASE', 'LEAD', 'SIGN_UP',
];
const GA4_TO_REDDIT: Record<string, string> = {
  pageview: 'PAGE_VISIT', pagevisit: 'PAGE_VISIT',
  viewitem: 'VIEW_CONTENT', viewcontent: 'VIEW_CONTENT', viewitemlist: 'VIEW_CONTENT',
  search: 'SEARCH', viewsearchresults: 'SEARCH',
  addtocart: 'ADD_TO_CART', addtowishlist: 'ADD_TO_WISHLIST',
  purchase: 'PURCHASE', generatelead: 'LEAD', lead: 'LEAD', signup: 'SIGN_UP',
};
/** Resolve an event to a Reddit SERVER standard event, or null (→ a custom event). PURE. */
export function redditServerEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  for (const e of REDDIT_SERVER_EVENTS) if (e.replace(/_/g, '').toLowerCase() === norm) return e;
  return GA4_TO_REDDIT[norm] ?? null;
}
/** serverEventDataList / userDataList name-column SELECT sets (verified against template.tpl). */
export const REDDIT_SERVER_EVENT_DATA_KEYS: string[] = ['conversion_id', 'currency', 'item_count', 'products', 'value', 'value_decimal'];
export const REDDIT_USER_DATA_KEYS: string[] = [
  'email', 'phone_number', 'external_id', 'idfa', 'aaid', 'ip_address', 'user_agent',
  'screen_dimensions', 'uuid', 'opt_out', 'data_processing_options.country', 'data_processing_options.region',
];

/** Build a Reddit Conversions API SERVER tag (stape-io/reddit-tag; `type` = its cvt_ code). Needs
 *  `accountId` (Reddit Pixel/Advertiser id, t2_/a2_) + `accessToken` (Conversion Access Token) — both
 *  usually {{variables}}. By default the event name is INHERITED from the incoming client event; pass
 *  `event` to force a Reddit standard event (PAGE_VISIT/VIEW_CONTENT/ADD_TO_CART/PURCHASE/… or a GA4
 *  name) or a custom name. autoMap (default true) turns on autoMapCommonEventData/ServerEventData/UserData
 *  so the tag derives the conversion_id (from the incoming event's event_id || transaction_id), currency,
 *  value and match keys with no explicit rows. Pass `eventId` for dedup with the Reddit Pixel — it lands
 *  as the `conversion_id` override row in serverEventDataList (overriding the auto value). Optional
 *  override rows: serverEventData (name ∈ REDDIT_SERVER_EVENT_DATA_KEYS) + userData (name ∈
 *  REDDIT_USER_DATA_KEYS). Optional testId (Reddit Event Testing), clickId (rdt_cid), eventSourceUrl,
 *  optimistic (useOptimisticScenario), requireConsent (adStorageConsent). Field shape verified against
 *  template.tpl. PURE. */
export function buildRedditCapiServerTag(
  type: string,
  name: string,
  accountId: string,
  accessToken: string,
  opts?: {
    event?: string;
    eventId?: string;
    testId?: string;
    clickId?: string;
    eventSourceUrl?: string;
    actionSource?: string;
    userData?: Array<{ name: string; value: string }>;
    serverEventData?: Array<{ name: string; value: string }>;
    autoMap?: boolean;
    optimistic?: boolean;
    requireConsent?: boolean;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const parameter: Param[] = [];
  // Event name: eventType RADIO (standard | inherit | custom) + exactly one of eventName / eventNameCustom.
  const event = opts?.event?.trim();
  if (!event) {
    parameter.push(tpl('eventType', 'inherit'));
  } else {
    const std = redditServerEvent(event);
    if (std) parameter.push(tpl('eventType', 'standard'), tpl('eventName', std));
    else parameter.push(tpl('eventType', 'custom'), tpl('eventNameCustom', event));
  }
  parameter.push(tpl('accountId', accountId), tpl('accessToken', accessToken));
  parameter.push(tpl('actionSource', (opts?.actionSource ?? '').trim() || 'WEBSITE'));
  if (opts?.testId && opts.testId.trim()) parameter.push(tpl('testId', opts.testId.trim()));
  parameter.push(boolean('useOptimisticScenario', opts?.optimistic ?? false));
  parameter.push(boolean('autoMapCommonEventData', auto));
  if (opts?.clickId && opts.clickId.trim()) parameter.push(tpl('clickId', opts.clickId.trim()));
  if (opts?.eventSourceUrl && opts.eventSourceUrl.trim()) parameter.push(tpl('eventSourceUrl', opts.eventSourceUrl.trim()));
  parameter.push(boolean('autoMapServerEventData', auto));
  parameter.push(boolean('autoMapUserData', auto));
  parameter.push(tpl('adStorageConsent', opts?.requireConsent ? 'required' : 'optional'));
  // eventId → the conversion_id override row (dedup with the Reddit Pixel); merged with explicit rows.
  const sed = [...(opts?.serverEventData ?? [])];
  if (opts?.eventId && opts.eventId.trim() !== '' && !sed.some((r) => r.name === 'conversion_id')) {
    sed.push({ name: 'conversion_id', value: opts.eventId });
  }
  const sedTable = nameValueTable('serverEventDataList', sed);
  if (sedTable) parameter.push(sedTable);
  const udTable = nameValueTable('userDataList', opts?.userData ?? []);
  if (udTable) parameter.push(udTable);
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── Snapchat Conversions API (server) ───────────── */

/** Snap SERVER standard events (eventNameStandard SELECT in the official
 *  Snapchat/capi-google-tag-manager-serverside-tag template.tpl). */
export const SNAP_SERVER_EVENTS: string[] = [
  'PAGE_VIEW', 'ADD_CART', 'PURCHASE', 'SIGN_UP', 'VIEW_CONTENT', 'SEARCH', 'SAVE', 'START_CHECKOUT',
  'LOGIN', 'LIST_VIEW', 'SUBSCRIBE', 'ADD_BILLING', 'ADD_TO_WISHLIST', 'START_TRIAL', 'SHARE', 'RESERVE',
  'AD_CLICK', 'AD_VIEW', 'COMPLETE_TUTORIAL', 'LEVEL_COMPLETE', 'INVITE', 'RATE', 'SPENT_CREDITS',
  'ACHIEVEMENT_UNLOCKED', 'APP_INSTALL', 'APP_OPEN',
];
const GA4_TO_SNAP_SERVER: Record<string, string> = {
  pageview: 'PAGE_VIEW', gtmdom: 'PAGE_VIEW', addtocart: 'ADD_CART', purchase: 'PURCHASE',
  signup: 'SIGN_UP', viewitem: 'VIEW_CONTENT', viewcontent: 'VIEW_CONTENT', search: 'SEARCH',
  viewsearchresults: 'SEARCH', begincheckout: 'START_CHECKOUT', checkout: 'START_CHECKOUT',
  subscribe: 'SUBSCRIBE', addpaymentinfo: 'ADD_BILLING', addbillinginfo: 'ADD_BILLING',
  addtowishlist: 'ADD_TO_WISHLIST', starttrial: 'START_TRIAL', login: 'LOGIN', share: 'SHARE',
};
/** Resolve an event to a Snap SERVER standard event, or null (→ a custom event). PURE. */
export function snapServerEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  for (const e of SNAP_SERVER_EVENTS) if (e.replace(/[\s_-]/g, '').toLowerCase() === norm) return e;
  return GA4_TO_SNAP_SERVER[norm] ?? null;
}
/** Snap userDataParameters `name` (SELECT) → the `ed - <emqKey>` EMQ variable it reads. Reuses the Meta
 *  EMQ variables (create_meta_emq_variables), so identity resolves from the incoming event with the same
 *  nested/header fallbacks. Snap keys with no ed source (ge/st/madid/sc_click_id/sc_cookie1) are left to
 *  explicit userData rows. Verified against template.tpl's userDataParameters SELECT. */
export const SNAP_USER_DATA_MAP: ReadonlyArray<readonly [string, string]> = [
  ['em', 'email_address'], ['ph', 'phone_number'], ['fn', 'first_name'], ['ln', 'last_name'],
  ['ct', 'city'], ['zp', 'postal_code'], ['country', 'country'], ['external_id', 'external_id'],
  ['client_ip_address', 'ip_override'], ['client_user_agent', 'user_agent'],
];

/** Build a Snapchat Conversions API SERVER tag (Snapchat/capi-google-tag-manager-serverside-tag; `type` =
 *  its cvt_ code). Event-name control (verified against template.tpl): inheritEventName SELECT
 *  'inherit'|'override'; under 'override', eventName RADIO 'standard'|'custom' picks eventNameStandard vs
 *  eventNameCustom. Identity maps into userDataParameters, dedup event_id into serverParameters,
 *  ecommerce into the free-form customDataParameters. PURE. */
export function buildSnapchatCapiServerTag(
  type: string,
  name: string,
  pixelId: string,
  apiAccessToken: string,
  event: string,
  opts?: {
    actionSource?: string;
    eventId?: string;
    testId?: string;
    mapEmqVariables?: boolean;
    userData?: Array<{ name: string; value: string }>;
    customData?: Array<{ name: string; value: string }>;
    serverData?: Array<{ name: string; value: string }>;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const parameter: Param[] = [
    tpl('pixelId', pixelId),
    tpl('apiAccessToken', apiAccessToken),
    tpl('actionSource', opts?.actionSource && opts.actionSource.trim() ? opts.actionSource : 'WEB'),
  ];
  const ev = event?.trim();
  if (!ev) {
    parameter.push(tpl('inheritEventName', 'inherit'));
  } else {
    const std = snapServerEvent(ev);
    parameter.push(tpl('inheritEventName', 'override'), tpl('eventName', std ? 'standard' : 'custom'));
    parameter.push(std ? tpl('eventNameStandard', std) : tpl('eventNameCustom', ev));
  }
  const mapEmq = opts?.mapEmqVariables !== false;
  // userDataParameters: auto-mapped identity rows referencing the ed - EMQ variables PLUS explicit caller
  // rows, keyed by name so a caller row REPLACES an auto row of the same name and new keys append.
  const udByName = new Map<string, { name: string; value: string }>();
  if (mapEmq) for (const [snapKey, emqKey] of SNAP_USER_DATA_MAP) udByName.set(snapKey, { name: snapKey, value: `{{ed - ${emqKey}}}` });
  for (const u of opts?.userData ?? []) if (u.name && u.name.trim()) udByName.set(u.name.trim(), { name: u.name.trim(), value: u.value });
  const udTable = nameValueTable('userDataParameters', [...udByName.values()]);
  if (udTable) parameter.push(udTable);
  // serverParameters: event_id (dedup with the Snap Pixel) + test_event_code + explicit rows.
  const sp = [...(opts?.serverData ?? [])];
  const eventIdVal = opts?.eventId && opts.eventId.trim() ? opts.eventId.trim() : (mapEmq ? '{{ed - event_id}}' : '');
  if (eventIdVal && !sp.some((r) => r.name === 'event_id')) sp.push({ name: 'event_id', value: eventIdVal });
  if (opts?.testId && opts.testId.trim() && !sp.some((r) => r.name === 'test_event_code')) sp.push({ name: 'test_event_code', value: opts.testId.trim() });
  const spTable = nameValueTable('serverParameters', sp);
  if (spTable) parameter.push(spTable);
  const cdTable = nameValueTable('customDataParameters', opts?.customData ?? []);
  if (cdTable) parameter.push(cdTable);
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── Microsoft Ads (Bing) UET Conversions API (server) ───────────── */

/** Microsoft UET has only page-load + custom events, so an event resolves to the eventType SELECT
 *  'pageLoad' (a pageview) or 'custom' (everything else, carrying customEventEventName). PURE. */
export function microsoftServerEventType(event: string): { eventType: 'pageLoad' | 'custom'; custom?: string } {
  const raw = (event ?? '').trim();
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (norm === '' || norm === 'pageview' || norm === 'pageload' || norm === 'gtmdom') return { eventType: 'pageLoad' };
  return { eventType: 'custom', custom: raw };
}

/** Build a Microsoft Ads (Bing) UET Conversions API SERVER tag (stape-io/microsoft-capi-tag; `type` = its
 *  cvt_ code). Unlike the other CAPI builders the template AUTO-EXTRACTS msclkid/em/ph, event data and
 *  server event data from the incoming event (autoMap* SELECTs), so no ed - variables are needed - one
 *  call yields a working tag as long as the web side forwards MSCLKID. Field keys verified against
 *  template.tpl. PURE. */
export function buildMicrosoftCapiServerTag(
  type: string,
  name: string,
  uetTagId: string,
  authToken: string,
  event: string,
  opts?: {
    autoMap?: boolean;
    eventId?: string;
    requireConsent?: boolean;
    userData?: Array<{ name: string; value: string }>;
    eventData?: Array<{ name: string; value: string }>;
    serverData?: Array<{ name: string; value: string }>;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const parameter: Param[] = [];
  // eventTypeSetupMethod RADIO 'standard'|'inherit'. Default INHERIT (map from the incoming GA4 event);
  // pass `event` to force standard pageLoad or a custom event.
  const ev = event?.trim();
  if (!ev) {
    parameter.push(tpl('eventTypeSetupMethod', 'inherit'));
  } else {
    const et = microsoftServerEventType(ev);
    parameter.push(tpl('eventTypeSetupMethod', 'standard'), tpl('eventType', et.eventType));
    if (et.eventType === 'custom') parameter.push(tpl('customEventEventName', et.custom ?? ev));
  }
  parameter.push(tpl('uetTagId', uetTagId), tpl('authToken', authToken));
  // The autoMap* fields are SELECTs whose values are the literal strings 'true'/'false'.
  parameter.push(
    tpl('autoMapUserDataParameters', auto ? 'true' : 'false'),
    tpl('autoMapServerEventDataParameters', auto ? 'true' : 'false'),
    tpl('autoMapEventParameters', auto ? 'true' : 'false'),
  );
  parameter.push(tpl('adStorageConsent', opts?.requireConsent ? 'required' : 'optional'));
  // Optional explicit override rows on top of the auto-map.
  const sed = [...(opts?.serverData ?? [])];
  if (opts?.eventId && opts.eventId.trim() && !sed.some((r) => r.name === 'eventId')) sed.push({ name: 'eventId', value: opts.eventId.trim() });
  const sedTable = nameValueTable('serverEventDataList', sed);
  if (sedTable) parameter.push(sedTable);
  const udTable = nameValueTable('userDataParametersList', opts?.userData ?? []);
  if (udTable) parameter.push(udTable);
  const edTable = nameValueTable('eventParametersList', opts?.eventData ?? []);
  if (edTable) parameter.push(edTable);
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── Amazon Ads Conversions API (server) ───────────── */

/** Amazon SERVER standard events (from stape-io/amazon-tag eventNameStandard SELECT). Keep the hyphen in
 *  "Off-AmazonPurchases" (the purchase event) verbatim. */
export const AMAZON_SERVER_EVENTS: string[] = [
  'AddToShoppingCart', 'Contact', 'Checkout', 'PageView', 'Search', 'Signup',
  'Application', 'Subscribe', 'Other', 'Lead', 'Off-AmazonPurchases',
];
const GA4_TO_AMAZON: Record<string, string> = {
  pageview: 'PageView', gtmdom: 'PageView', signup: 'Signup', generatelead: 'Lead', lead: 'Lead',
  search: 'Search', viewsearchresults: 'Search', addtocart: 'AddToShoppingCart',
  begincheckout: 'Checkout', checkout: 'Checkout', purchase: 'Off-AmazonPurchases',
  contact: 'Contact', subscribe: 'Subscribe',
};
/** Resolve an event to an Amazon SERVER standard event, or null (→ a custom event). PURE. */
export function amazonServerEvent(event: string): string | null {
  const raw = (event ?? '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase().replace(/[\s_-]/g, '');
  for (const e of AMAZON_SERVER_EVENTS) if (e.replace(/[\s_-]/g, '').toLowerCase() === norm) return e;
  return GA4_TO_AMAZON[norm] ?? null;
}
/** defaultAttributesList / offAmazonPurchasesAttributesList / userDataAttributesList name-column SELECT
 *  sets (verified against template.tpl). */
export const AMAZON_DEFAULT_ATTR_KEYS: string[] = [
  'clientDedupeId', 'value', 'brand', 'category', 'productId',
  'attr1', 'attr2', 'attr3', 'attr4', 'attr5', 'attr6', 'attr7', 'attr8', 'attr9', 'attr10',
];
export const AMAZON_PURCHASE_ATTR_KEYS: string[] = ['currencyCode', 'unitsSold'];
export const AMAZON_USER_DATA_KEYS: string[] = ['email', 'phonenumber'];

/** Build an Amazon Ads Conversions API SERVER tag (stape-io/amazon-tag; `type` = its cvt_ code). Amazon
 *  has NO api key / OAuth here: the only "credential" is `tagIds` — one or more Amazon Ads Tag IDs (UUIDs
 *  from Events Manager → View Tag Code), each a row in the tagIdsList table (single "value" column); the
 *  event is sent to every id. `tagRegion` is 'NA' or 'EU'. By default the event name is INHERITED from
 *  the incoming event; pass `event` to force an Amazon standard event (PageView/AddToShoppingCart/
 *  Checkout/Off-AmazonPurchases/… or a GA4 name) or a custom name. Pass `eventId` for dedup — it lands as
 *  the `clientDedupeId` row in defaultAttributesList (Amazon otherwise auto-derives it from the incoming
 *  event's event_id || transaction_id). Optional matchId (default reads eventData.user_id), ipAddress,
 *  countryCode; enableAdvancedMatching + userData (name ∈ email/phonenumber, hashed by Amazon); override
 *  tables defaultAttributes (name ∈ AMAZON_DEFAULT_ATTR_KEYS), purchaseAttributes (currencyCode/
 *  unitsSold), customAttributes (free-form). All tables use columns "name"/"value" except tagIdsList
 *  ("value" only). Field shape verified against template.tpl. PURE. */
export function buildAmazonCapiServerTag(
  type: string,
  name: string,
  tagIds: string[],
  tagRegion: string,
  opts?: {
    event?: string;
    eventId?: string;
    matchId?: string;
    ipAddress?: string;
    countryCode?: string;
    enableAdvancedMatching?: boolean;
    userData?: Array<{ name: string; value: string }>;
    defaultAttributes?: Array<{ name: string; value: string }>;
    purchaseAttributes?: Array<{ name: string; value: string }>;
    customAttributes?: Array<{ name: string; value: string }>;
    firingTriggerId?: string[];
  }
): GtmTagResource {
  const region = tagRegion === 'EU' ? 'EU' : 'NA';
  const parameter: Param[] = [];
  // Event name: eventType RADIO (standard | inherit | custom) + eventNameStandard / eventNameCustom.
  const event = opts?.event?.trim();
  if (!event) {
    parameter.push(tpl('eventType', 'inherit'));
  } else {
    const std = amazonServerEvent(event);
    if (std) parameter.push(tpl('eventType', 'standard'), tpl('eventNameStandard', std));
    else parameter.push(tpl('eventType', 'custom'), tpl('eventNameCustom', event));
  }
  parameter.push(tpl('tagRegion', region));
  // tagIdsList: SIMPLE_TABLE with a SINGLE column keyed "value" (NOT name/value).
  const ids = tagIds.map((v) => (v ?? '').trim()).filter((v) => v !== '');
  if (ids.length) parameter.push({ type: 'list', key: 'tagIdsList', list: ids.map((v) => ({ type: 'map', map: [tpl('value', v)] })) });
  if (opts?.matchId && opts.matchId.trim()) parameter.push(tpl('matchId', opts.matchId.trim()));
  if (opts?.ipAddress && opts.ipAddress.trim()) parameter.push(tpl('ipAddress', opts.ipAddress.trim()));
  if (opts?.countryCode && opts.countryCode.trim()) parameter.push(tpl('countryCode', opts.countryCode.trim()));
  const advanced = opts?.enableAdvancedMatching ?? false;
  parameter.push(boolean('enableAdvancedMatching', advanced));
  // eventId → the clientDedupeId override row in defaultAttributesList (dedup with the Amazon pixel).
  const def = [...(opts?.defaultAttributes ?? [])];
  if (opts?.eventId && opts.eventId.trim() !== '' && !def.some((r) => r.name === 'clientDedupeId')) {
    def.push({ name: 'clientDedupeId', value: opts.eventId });
  }
  const defTable = nameValueTable('defaultAttributesList', def);
  if (defTable) parameter.push(defTable);
  const purchaseTable = nameValueTable('offAmazonPurchasesAttributesList', opts?.purchaseAttributes ?? []);
  if (purchaseTable) parameter.push(purchaseTable);
  const customTable = nameValueTable('eventCustomAttributesList', opts?.customAttributes ?? []);
  if (customTable) parameter.push(customTable);
  // userDataAttributesList only applies when advanced matching is on (the template hides it otherwise).
  if (advanced) {
    const udTable = nameValueTable('userDataAttributesList', opts?.userData ?? []);
    if (udTable) parameter.push(udTable);
  }
  return {
    name: sanitizeName(name),
    type,
    ...(opts?.firingTriggerId && opts.firingTriggerId.length ? { firingTriggerId: opts.firingTriggerId } : {}),
    parameter,
  };
}

/* ───────────── Tier-1 CAPI server tags (X / Quora / AdRoll / Nextdoor / Yelp / Spotify / LINE Yahoo / RTB House) ─────────────
 * Every field shape below was read from the vendor's Stape template.tpl (___TEMPLATE_PARAMETERS___), not
 * guessed. Shared conventions: the event is INHERITED from the incoming client event unless `event` is
 * given; a GA4 name is mapped to the platform's standard event where one exists; an unknown name becomes
 * the platform's custom event when the template has one, else falls back to inherit (never invented).
 * Auto-map toggles default ON so the template derives user/event data itself; explicit rows only override. */

const normEvent = (e: string): string => (e ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
/** Resolve `event` against a standard list (case/underscore-insensitive) or a GA4→platform alias map. */
function resolveStd(event: string, standard: readonly string[], aliases: Record<string, string>): string | null {
  const n = normEvent(event);
  if (!n) return null;
  for (const s of standard) if (normEvent(s) === n) return s;
  return aliases[n] ?? null;
}
const consentParam = (required?: boolean): Param => tpl('adStorageConsent', required ? 'required' : 'optional');
type NV = Array<{ name: string; value: string }>;
/** Merge a dedup row (`key` = `value`) into explicit rows unless the caller already set that key. */
function withDedupRow(rows: NV | undefined, key: string, value: string | undefined): NV {
  const out = [...(rows ?? [])];
  const v = (value ?? '').trim();
  if (v && !out.some((r) => r.name === key)) out.push({ name: key, value: v });
  return out;
}
const pushTable = (parameter: Param[], key: string, rows: NV | undefined): void => {
  const t = nameValueTable(key, rows ?? []);
  if (t) parameter.push(t);
};
const finish = (name: string, type: string, parameter: Param[], firingTriggerId?: string[]): GtmTagResource => ({
  name: sanitizeName(name),
  type,
  ...(firingTriggerId && firingTriggerId.length ? { firingTriggerId } : {}),
  parameter,
});

// ── X (Twitter) Conversion API — stape-io/twitter-tag ──
/** serverEventDataList / userDataList name-column SELECT sets (template.tpl). */
export const X_SERVER_EVENT_DATA_KEYS: string[] = ['conversion_time', 'conversion_timestamp', 'number_items', 'price_currency', 'value', 'conversion_id', 'description', 'contents', 'search_string'];
export const X_USER_DATA_KEYS: string[] = ['hashed_email', 'hashed_phone_number', 'twclid', 'ip_address', 'user_agent'];
/** X auth: the Pixel Access Token, OR the OAuth 1.0a quartet. The template's authMethod SELECT picks one. */
export interface XCapiAuth { pixelAccessToken?: string; consumerKey?: string; consumerSecret?: string; oauthToken?: string; oauthTokenSecret?: string }
/** Build an X (Twitter) Conversion API SERVER tag. The template has NO event-name field: `eventId` is the
 *  per-conversion X "Event ID" (tw-…) from X Ads Events Manager, so one tag = one X conversion event and
 *  the server trigger decides when it fires. Dedup with the X Pixel = the `conversion_id` row
 *  (opts.conversionId). PURE. */
export function buildXCapiServerTag(
  type: string, name: string, pixelId: string, eventId: string, auth: XCapiAuth,
  opts?: { conversionId?: string; serverEventData?: NV; userData?: NV; autoMap?: boolean; optimistic?: boolean; httpOnlyCookie?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const p: Param[] = [tpl('pixelId', pixelId), tpl('eventId', eventId)];
  if ((auth.pixelAccessToken ?? '').trim()) {
    p.push(tpl('authMethod', 'accessToken'), tpl('pixelAccessToken', auth.pixelAccessToken!.trim()));
  } else {
    p.push(tpl('authMethod', 'oAuth'), tpl('consumerKey', auth.consumerKey ?? ''), tpl('consumerSecret', auth.consumerSecret ?? ''), tpl('oauthToken', auth.oauthToken ?? ''), tpl('oauthTokenSecret', auth.oauthTokenSecret ?? ''));
  }
  p.push(boolean('useHttpOnlyCookie', opts?.httpOnlyCookie ?? false), boolean('useOptimisticScenario', opts?.optimistic ?? false));
  p.push(boolean('autoMapServerEventData', auto));
  pushTable(p, 'serverEventDataList', withDedupRow(opts?.serverEventData, 'conversion_id', opts?.conversionId));
  p.push(boolean('autoMapUserData', auto));
  pushTable(p, 'userDataList', opts?.userData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── Quora Conversion API — stape-io/quora-tag ──
export const QUORA_SERVER_EVENTS: string[] = ['Generic', 'Search', 'AddToCart', 'Purchase', 'GenerateLead', 'CompleteRegistration', 'AddToWishlist', 'AppInstall', 'InitiateCheckout'];
const GA4_TO_QUORA: Record<string, string> = { viewsearchresults: 'Search', addtocart: 'AddToCart', purchase: 'Purchase', generatelead: 'GenerateLead', lead: 'GenerateLead', signup: 'CompleteRegistration', addtowishlist: 'AddToWishlist', begincheckout: 'InitiateCheckout', checkout: 'InitiateCheckout' };
/** Quora standard event for `event`, else 'Generic' (the template has no custom event). PURE. */
export function quoraServerEvent(event: string): string { return resolveStd(event, QUORA_SERVER_EVENTS, GA4_TO_QUORA) ?? 'Generic'; }
export const QUORA_CONVERSION_DATA_KEYS: string[] = ['event_id', 'click_id', 'value', 'timestamp'];
export const QUORA_USER_DATA_KEYS: string[] = ['ip', 'email', 'phone_number', 'country', 'region', 'city', 'postal_code', 'company_name', 'job_title', 'date_of_birth'];
/** Build a Quora Conversion API SERVER tag: `accountId` (Quora pixel id) + `accessToken`. Event inherited
 *  unless `event` is given (mapped to a Quora standard event, unknown → Generic). Dedup = `event_id` row. PURE. */
export function buildQuoraCapiServerTag(
  type: string, name: string, accountId: string, accessToken: string,
  opts?: { event?: string; eventId?: string; conversionData?: NV; deviceEventData?: NV; userData?: NV; optimistic?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const p: Param[] = [];
  const ev = opts?.event?.trim();
  if (!ev) p.push(tpl('eventType', 'inherit'));
  else p.push(tpl('eventType', 'standard'), tpl('eventName', quoraServerEvent(ev)));
  p.push(tpl('accountId', accountId), tpl('accessToken', accessToken), boolean('useOptimisticScenario', opts?.optimistic ?? false));
  pushTable(p, 'conversionDataList', withDedupRow(opts?.conversionData, 'event_id', opts?.eventId));
  pushTable(p, 'deviceEventDataList', opts?.deviceEventData);
  pushTable(p, 'userDataList', opts?.userData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── AdRoll — stape-io/adroll-tag ──
export const ADROLL_SERVER_EVENTS: string[] = ['pageView', 'productSearch', 'addToCart', 'purchase'];
const GA4_TO_ADROLL: Record<string, string> = { pageview: 'pageView', search: 'productSearch', viewsearchresults: 'productSearch', addtocart: 'addToCart', purchase: 'purchase' };
export function adrollServerEvent(event: string): string | null { return resolveStd(event, ADROLL_SERVER_EVENTS, GA4_TO_ADROLL); }
export const ADROLL_USER_DATA_KEYS: string[] = ['email', 'email_sha256', 'email_md5', 'device_id', 'first_party_cookie', 'adct', 'user_id', 'ip', 'user_agent'];
export const ADROLL_CUSTOM_DATA_KEYS: string[] = ['conversion_value', 'currency', 'order_id', 'products', 'keywords', 'external_data'];
/** Build an AdRoll SERVER tag: `advertisableId` + `pixelId` (both public, on the web snippet) + `accessToken`.
 *  Event inherited unless given (standard pageView/productSearch/addToCart/purchase, else custom). PURE. */
export function buildAdRollCapiServerTag(
  type: string, name: string, advertisableId: string, pixelId: string, accessToken: string,
  opts?: { event?: string; itemIdKey?: string; testMode?: boolean; cookieDomain?: string; serverData?: NV; userData?: NV; customData?: NV; optimistic?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const p: Param[] = [];
  const ev = opts?.event?.trim();
  if (!ev) p.push(tpl('eventType', 'inherit'));
  else { const std = adrollServerEvent(ev); if (std) p.push(tpl('eventType', 'standard'), tpl('eventNameStandard', std)); else p.push(tpl('eventType', 'custom'), tpl('eventNameCustom', ev)); }
  p.push(tpl('advertisableId', advertisableId), tpl('pixelId', pixelId), tpl('accessToken', accessToken));
  if (opts?.itemIdKey?.trim()) p.push(tpl('itemIdKey', opts.itemIdKey.trim()));
  p.push(tpl('testMode', opts?.testMode ? 'true' : 'false'), boolean('useOptimisticScenario', opts?.optimistic ?? false));
  if (opts?.cookieDomain?.trim()) p.push(boolean('overrideCookieDomain', true), tpl('overridenCookieDomain', opts.cookieDomain.trim()));
  pushTable(p, 'serverDataList', opts?.serverData);
  pushTable(p, 'userDataList', opts?.userData);
  pushTable(p, 'customDataList', opts?.customData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── Nextdoor Conversion API — stape-io/nextdoor-tag ──
export const NEXTDOOR_SERVER_EVENTS: string[] = ['conversion', 'lead', 'purchase', 'sign_up', ...Array.from({ length: 10 }, (_, i) => `custom_conversion_${i + 1}`)];
const GA4_TO_NEXTDOOR: Record<string, string> = { generatelead: 'lead', purchase: 'purchase', signup: 'sign_up', conversion: 'conversion' };
export function nextdoorServerEvent(event: string): string | null { return resolveStd(event, NEXTDOOR_SERVER_EVENTS, GA4_TO_NEXTDOOR); }
export const NEXTDOOR_USER_DATA_KEYS: string[] = ['email', 'phone_number', 'client_ip_address', 'client_user_agent', 'click_id', 'external_id', 'first_name', 'last_name', 'city', 'state', 'zip_code', 'country', 'street_address', 'date_of_birth', 'gender'];
/** Build a Nextdoor Conversion API SERVER tag: `pixelId` (public) + `clientId` + `accessToken`.
 *  conversionType defaults to website (appId only for app). Dedup = `event_id` row in serverDataList. PURE. */
export function buildNextdoorCapiServerTag(
  type: string, name: string, pixelId: string, clientId: string, accessToken: string,
  opts?: { event?: string; eventId?: string; conversionType?: string; appId?: string; testEvent?: string; serverData?: NV; userData?: NV; customData?: NV; optimistic?: boolean; httpOnlyCookie?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const p: Param[] = [];
  const ev = opts?.event?.trim();
  if (!ev) p.push(tpl('eventType', 'inherit'));
  else { const std = nextdoorServerEvent(ev); if (std) p.push(tpl('eventType', 'standard'), tpl('eventNameStandard', std)); else p.push(tpl('eventType', 'custom'), tpl('eventNameCustom', ev)); }
  const ct = (opts?.conversionType ?? '').trim() || 'website';
  p.push(tpl('eventConversionType', ct), tpl('pixelId', pixelId), tpl('clientId', clientId));
  if (ct === 'app' && opts?.appId?.trim()) p.push(tpl('appId', opts.appId.trim()));
  p.push(tpl('accessToken', accessToken));
  if (opts?.testEvent?.trim()) p.push(tpl('testEvent', opts.testEvent.trim()));
  p.push(boolean('useHttpOnlyCookie', opts?.httpOnlyCookie ?? false), boolean('useOptimisticScenario', opts?.optimistic ?? false), boolean('notSetClickID', false));
  pushTable(p, 'serverDataList', withDedupRow(opts?.serverData, 'event_id', opts?.eventId));
  pushTable(p, 'userDataList', opts?.userData);
  pushTable(p, 'customDataList', opts?.customData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── Yelp Conversion API — stape-io/yelp-tag ──
export const YELP_SERVER_EVENTS: string[] = ['purchase', 'add_payment_info', 'add_to_cart', 'add_to_wishlist', 'search', 'checkout', 'lead', 'view_content', 'view_category', 'signup', 'watch_video'];
const GA4_TO_YELP: Record<string, string> = { begincheckout: 'checkout', generatelead: 'lead', signup: 'signup', viewitem: 'view_content', viewitemlist: 'view_category', viewsearchresults: 'search' };
export function yelpServerEvent(event: string): string | null { return resolveStd(event, YELP_SERVER_EVENTS, GA4_TO_YELP); }
export const YELP_USER_DATA_KEYS: string[] = ['em', 'ph', 'client_ip_address', 'madid', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id', 'lead_id', 'client_user_agent', 'db', 'ge'];
/** Build a Yelp Conversion API SERVER tag. Yelp has no pixel id: only the `accessToken`. Dedup = `event_id`
 *  row in serverDataList; `validate` runs Yelp's payload validation. PURE. */
export function buildYelpCapiServerTag(
  type: string, name: string, accessToken: string,
  opts?: { event?: string; eventId?: string; conversionType?: string; validate?: boolean; serverData?: NV; userData?: NV; customData?: NV; optimistic?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const p: Param[] = [];
  const ev = opts?.event?.trim();
  if (!ev) p.push(tpl('eventType', 'inherit'));
  else { const std = yelpServerEvent(ev); if (std) p.push(tpl('eventType', 'standard'), tpl('eventNameStandard', std)); else p.push(tpl('eventType', 'custom'), tpl('eventNameCustom', ev)); }
  p.push(tpl('eventConversionType', (opts?.conversionType ?? '').trim() || 'website'), tpl('accessToken', accessToken));
  p.push(boolean('useOptimisticScenario', opts?.optimistic ?? false), boolean('validate', opts?.validate ?? false));
  pushTable(p, 'serverDataList', withDedupRow(opts?.serverData, 'event_id', opts?.eventId));
  pushTable(p, 'userDataList', opts?.userData);
  pushTable(p, 'customDataList', opts?.customData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── Spotify Ads Conversion API — stape-io/spotify-tag ──
export const SPOTIFY_SERVER_EVENTS: string[] = ['Page_View', 'Sign_Up', 'Lead', 'View_Product', 'Add_Cart', 'Start_Checkout', 'Purchase', 'Alias'];
const GA4_TO_SPOTIFY: Record<string, string> = { pageview: 'Page_View', signup: 'Sign_Up', generatelead: 'Lead', lead: 'Lead', viewitem: 'View_Product', addtocart: 'Add_Cart', begincheckout: 'Start_Checkout', checkout: 'Start_Checkout', purchase: 'Purchase' };
/** Spotify standard event, a `Custom_Event_N` (1-5) custom slot, or null (→ inherit; the template has no free-text event). PURE. */
export function spotifyServerEvent(event: string): { kind: 'standard' | 'custom'; value: string } | null {
  const std = resolveStd(event, SPOTIFY_SERVER_EVENTS, GA4_TO_SPOTIFY);
  if (std) return { kind: 'standard', value: std };
  const m = /^custom[\s_-]?event[\s_-]?([1-5])$/i.exec((event ?? '').trim());
  return m ? { kind: 'custom', value: `Custom_Event_${m[1]}` } : null;
}
export const SPOTIFY_EVENT_DETAILS_KEYS: string[] = ['amount', 'currency', 'content_name', 'content_category'];
export const SPOTIFY_USER_DATA_KEYS: string[] = ['ip_address', 'device_id', 'hashed_emails', 'hashed_phone_number'];
/** Build a Spotify Ads Conversion API SERVER tag: `authToken` + `connectionId`. Note the template's
 *  optimistic / opt-out / device-cookie switches are SELECTs ('true'|'false'), not checkboxes. PURE. */
export function buildSpotifyCapiServerTag(
  type: string, name: string, authToken: string, connectionId: string,
  opts?: { event?: string; eventId?: string; actionSource?: string; optOutTargeting?: boolean; serverEventData?: NV; eventDetails?: NV; userData?: NV; autoMap?: boolean; optimistic?: boolean; generateDeviceIdCookie?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const p: Param[] = [];
  const r = opts?.event?.trim() ? spotifyServerEvent(opts.event) : null;
  if (!r) p.push(tpl('eventType', 'inherit'));
  else if (r.kind === 'standard') p.push(tpl('eventType', 'standard'), tpl('eventNameStandard', r.value));
  else p.push(tpl('eventType', 'custom'), tpl('eventNameCustom', r.value));
  p.push(tpl('authToken', authToken), tpl('connectionId', connectionId), tpl('actionSource', (opts?.actionSource ?? '').trim() || 'WEB'));
  p.push(tpl('optOutTargeting', opts?.optOutTargeting ? 'true' : 'false'), tpl('useOptimisticScenario', opts?.optimistic ? 'true' : 'false'));
  p.push(boolean('autoMapServerEventData', auto));
  pushTable(p, 'serverEventDataList', withDedupRow(opts?.serverEventData, 'event_id', opts?.eventId));
  p.push(boolean('autoMapEventDetailsParameters', auto));
  pushTable(p, 'eventDetailsParametersList', opts?.eventDetails);
  p.push(tpl('generateDeviceIdCookie', opts?.generateDeviceIdCookie === false ? 'false' : 'true'));
  p.push(boolean('autoMapUserData', auto));
  pushTable(p, 'userDataParametersList', opts?.userData);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── LINE Yahoo (Yahoo! JAPAN Ads) Conversion API — stape-io/line-yahoo-tag ──
export const LINE_YAHOO_SERVER_EVENTS: string[] = ['add_cart', 'add_wishlist', 'check_out', 'generate_lead', 'login', 'page_view', 'payment_info', 'purchase', 'reservation', 'search', 'sign_up', 'view_cart', 'view_listing', 'view_product'];
const GA4_TO_LINE_YAHOO: Record<string, string> = { addtocart: 'add_cart', addtowishlist: 'add_wishlist', begincheckout: 'check_out', checkout: 'check_out', addpaymentinfo: 'payment_info', viewitem: 'view_product', viewitemlist: 'view_listing', viewsearchresults: 'search', lead: 'generate_lead' };
/** LINE Yahoo standard event or null (→ inherit; the template has NO custom event). PURE. */
export function lineYahooServerEvent(event: string): string | null { return resolveStd(event, LINE_YAHOO_SERVER_EVENTS, GA4_TO_LINE_YAHOO); }
export const LINE_YAHOO_USER_IDENTIFIER_KEYS: string[] = ['hashed_email', 'hashed_phone_number', 'ly_su', 'ly_c', 'ly_r', 'ifa', 'line_uid'];
/** Build a LINE Yahoo Conversion API SERVER tag: Yahoo `tagId` (public) + `accessToken` + `channelId`.
 *  Every event other than page_view needs its own Event Snippet ID from Yahoo (`eventSnippetId`). Dedup =
 *  `transaction_id` row in serverEventDataList. PURE. */
export function buildLineYahooCapiServerTag(
  type: string, name: string, tagId: string, accessToken: string, channelId: string,
  opts?: { event?: string; eventSnippetId?: string; transactionId?: string; testMode?: boolean; itemIdKey?: string; serverEventData?: NV; userIdentifiers?: NV; webParameters?: NV; eventParameters?: NV; autoMap?: boolean; optimistic?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const p: Param[] = [];
  const std = opts?.event?.trim() ? lineYahooServerEvent(opts.event) : null;
  if (!std) p.push(tpl('eventType', 'inherit'));
  else p.push(tpl('eventType', 'standard'), tpl('eventTypeStandard', std));
  p.push(tpl('tagId', tagId), tpl('accessToken', accessToken), tpl('channelId', channelId), tpl('actionSource', 'web'));
  if (opts?.eventSnippetId?.trim()) p.push(tpl('eventSnippetId', opts.eventSnippetId.trim()));
  p.push(tpl('testFlag', opts?.testMode ? 'true' : 'false'), boolean('useOptimisticScenario', opts?.optimistic ?? false));
  p.push(boolean('setAnonymousIdCookie', true), boolean('setClickIdCookie', true), boolean('setComplementaryClickIdCookie', true));
  p.push(boolean('autoMapServerEventDataParameters', auto));
  pushTable(p, 'serverEventDataList', withDedupRow(opts?.serverEventData, 'transaction_id', opts?.transactionId));
  p.push(boolean('autoMapUserIdentifiersParameters', auto));
  pushTable(p, 'userIdentifiersParametersList', opts?.userIdentifiers);
  p.push(boolean('autoMapWebParameters', auto));
  pushTable(p, 'webParametersList', opts?.webParameters);
  p.push(boolean('autoMapEventParameters', auto));
  if (opts?.itemIdKey?.trim()) p.push(tpl('itemIdKey', opts.itemIdKey.trim()));
  pushTable(p, 'eventParametersList', opts?.eventParameters);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
}

// ── RTB House — stape-io/rtb-house-tag ──
/** RTB House events are PAGE TYPES, not conversions: home / listing / offer / basket / order. */
export const RTB_HOUSE_SERVER_EVENTS: string[] = ['home', 'category2', 'sales', 'newoffers', 'offer', 'wishlist', 'size', 'offlinecheck', 'listing', 'basketadd', 'basket', 'basketstatus', 'startorder', 'conversion_order', 'conversion', 'placebo', 'cnst_ads_0'];
const GA4_TO_RTB_HOUSE: Record<string, string> = { pageview: 'home', viewitemlist: 'listing', viewitem: 'offer', addtowishlist: 'wishlist', addtocart: 'basketadd', viewcart: 'basketstatus', begincheckout: 'startorder', checkout: 'startorder', purchase: 'conversion_order', generatelead: 'conversion', lead: 'conversion', signup: 'conversion' };
export function rtbHouseServerEvent(event: string): string | null { return resolveStd(event, RTB_HOUSE_SERVER_EVENTS, GA4_TO_RTB_HOUSE); }
/** Build an RTB House SERVER tag: `taggingHash` (public — it is the id in the pixel URL) + `partnerKey`.
 *  No token. `event` maps a GA4 name to an RTB House page type (unknown → the template's custom event);
 *  it defaults to `home`, so callers should pass the event for anything but a homepage view. Per-event
 *  fields (orderId/orderValue for conversion_order, productIds, categoryId, conversionId/Value) are only
 *  emitted when given; auto-map derives them from the event otherwise. PURE. */
export function buildRtbHouseServerTag(
  type: string, name: string, taggingHash: string, partnerKey: string,
  opts?: { event?: string; customEventValue?: string; region?: string; identifierType?: string; identifierValue?: string; itemIdKey?: string; categoryId?: string; productIds?: string; orderId?: string; orderValue?: string; orderSubclass?: string; conversionId?: string; conversionValue?: string; conversionProductIds?: string; conversionClass?: string; serverEventData?: NV; autoMap?: boolean; optimistic?: boolean; requireConsent?: boolean; firingTriggerId?: string[] },
): GtmTagResource {
  const auto = opts?.autoMap !== false;
  const p: Param[] = [];
  const ev = opts?.event?.trim() || 'home';
  const std = rtbHouseServerEvent(ev);
  if (std) p.push(tpl('eventNameSetup', 'standard'), tpl('eventNameStandard', std));
  else { p.push(tpl('eventNameSetup', 'custom'), tpl('eventNameCustom', ev)); if (opts?.customEventValue?.trim()) p.push(tpl('customEventValue', opts.customEventValue.trim())); }
  p.push(tpl('taggingHash', taggingHash), tpl('partnerKey', partnerKey), tpl('region', (opts?.region ?? '').trim() || 'us'));
  const idType = (opts?.identifierType ?? '').trim() || 'aid';
  p.push(tpl('identifierType', idType), boolean('autoMapIdentifierType', auto));
  if (opts?.identifierValue?.trim()) p.push(tpl('identifierValue', opts.identifierValue.trim()));
  if (idType === 'aid') p.push(boolean('setAnonymousIdCookie', true));
  p.push(boolean('useOptimisticScenario', opts?.optimistic ?? false), boolean('autoMapServerEventDataParameters', auto));
  pushTable(p, 'serverEventDataParametersList', opts?.serverEventData);
  p.push(boolean('autoMapEventParameters', auto));
  if (opts?.itemIdKey?.trim()) p.push(tpl('itemIdKey', opts.itemIdKey.trim()));
  const optTpl = (key: string, v?: string): void => { if (v?.trim()) p.push(tpl(key, v.trim())); };
  optTpl('categoryId', opts?.categoryId); optTpl('productIds', opts?.productIds);
  optTpl('orderId', opts?.orderId); optTpl('orderValue', opts?.orderValue); optTpl('orderSubclass', opts?.orderSubclass);
  optTpl('conversionId', opts?.conversionId); optTpl('conversionValue', opts?.conversionValue); optTpl('conversionProductIds', opts?.conversionProductIds); optTpl('conversionClass', opts?.conversionClass);
  p.push(consentParam(opts?.requireConsent));
  return finish(name, type, p, opts?.firingTriggerId);
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

/* ───────────── Web → server migration planner ───────────── */

export interface ServerMigrationItem {
  /** The web tag this maps from. */
  webTag: string;
  /** Marketing destination, e.g. "GA4", "Google Ads conversion", "Meta". */
  destination: string;
  /** How it was recognised: a native GTM type code (high confidence) or a name/snippet heuristic. */
  detectedBy: 'native-type' | 'name';
  /** The desktop tool to run to create the server tag, or null when there is no server equivalent. */
  serverTool: string | null;
  /** Fields read straight off the web tag (destination ids). */
  derived: Record<string, string>;
  /** Secrets/ids the caller must supply that are NOT in the web container (e.g. a CAPI access token). */
  requires: string[];
  /** One-line guidance. */
  note: string;
  /** Disposition: auto = ported by create_server_container_from_web; typed-tool = a create_*_server tool;
   *  generic = import-template + tags_create; skip = no server tag needed; manual = no server equivalent. */
  status: 'auto' | 'typed-tool' | 'generic' | 'skip' | 'manual';
}

export interface ServerMigrationPlan {
  ga4: { present: boolean; measurementIds: string[] };
  items: ServerMigrationItem[];
  summary: { total: number; auto: number; typedTool: number; generic: number; manual: number; skipped: number };
}

/** Name/snippet heuristics for template-based (cvt_) or Custom HTML pixels, mapped to their typed
 *  server CAPI tool. Access tokens are never in the web container, so they are listed in `requires`.
 *
 *  `derivedKey` is the SERVER field the web pixel's public id feeds, `idKeys` the gallery-template
 *  params that hold it (our own web builders' keys, e.g. TikTok `pixel_code`, Snap `pixel_id`) and
 *  `snippetRe` its position inside the vendor's Custom HTML init call. When the id is found the plan
 *  carries it in `derived`, so the server tag is created pre-filled and only the secret is left to type.
 *
 *  ORDER MATTERS (first hit wins): LinkedIn precedes Snapchat because a LinkedIn Custom HTML snippet
 *  loads from snap.licdn.com, which `/snap/` would otherwise claim. */
const SERVER_MIGRATION_HEURISTICS: ReadonlyArray<{
  re: RegExp; destination: string; serverTool: string; requires: string[]; note: string;
  /** Omitted for a platform whose web tag carries no public id (Yelp, Spotify): nothing to derive. */
  derivedKey?: string; idKeys?: string[]; snippetRe?: RegExp;
  /** Further ids read off the snippet (AdRoll carries advertiser AND pixel ids). */
  extra?: Array<{ key: string; re: RegExp }>;
  status?: ServerMigrationItem['status'];
}> = [
  { re: /tiktok|ttq\s*\(/i, destination: 'TikTok', serverTool: 'create_tiktok_capi_server_tag', requires: ['accessToken'], note: 'TikTok Events API server tag.',
    derivedKey: 'pixelId', idKeys: ['pixel_code', 'pixelCode', 'pixelId'], snippetRe: /ttq\.load\s*\(\s*['"]([^'"]+)['"]/i },
  { re: /linkedin|_linkedin_partner_id|lintrk|licdn\.com/i, destination: 'LinkedIn', serverTool: 'create_linkedin_capi_server_tag', requires: ['accessToken', 'conversionRuleUrn'],
    note: 'LinkedIn CAPI server tag. The web Partner ID is informational: the server tag fires on a Conversion Rule URN, which the caller must supply.',
    derivedKey: 'partnerId', idKeys: ['partnerId', 'id'], snippetRe: /_linkedin_partner_id\s*=\s*['"]([^'"]+)['"]/i },
  { re: /pinterest|pintrk\s*\(/i, destination: 'Pinterest', serverTool: 'create_pinterest_capi_server_tag', requires: ['apiAccessToken'], note: 'Pinterest CAPI server tag.',
    derivedKey: 'advertiserId', idKeys: ['tagId', 'advertiserId'], snippetRe: /pintrk\s*\(\s*['"]load['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /reddit|rdt\s*\(/i, destination: 'Reddit', serverTool: 'create_reddit_capi_server_tag', requires: ['accessToken'], note: 'Reddit CAPI server tag.',
    derivedKey: 'accountId', idKeys: ['accountId', 'pixelId'], snippetRe: /rdt\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /snap(chat)?|snaptr\s*\(/i, destination: 'Snapchat', serverTool: 'create_snapchat_capi_server_tag', requires: ['apiAccessToken'], note: 'Snapchat CAPI server tag.',
    derivedKey: 'pixelId', idKeys: ['pixel_id', 'pixelId'], snippetRe: /snaptr\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /microsoft|bing|\buet\b|uetq/i, destination: 'Microsoft Ads', serverTool: 'create_microsoft_capi_server_tag', requires: ['authToken'], note: 'Microsoft Ads CAPI; REQUIRES MSCLKID forwarded from the web side.',
    derivedKey: 'uetTagId', idKeys: ['tagId', 'uetTagId'], snippetRe: /\bti\s*:\s*['"]([^'"]+)['"]/i },
  // Builders + typed tools already exist for these two; they were simply never planned.
  { re: /amazon[\s_-]?(ads?|pixel|tag)|amzn\s*\(|amazon-adsystem/i, destination: 'Amazon Ads', serverTool: 'create_amazon_capi_server_tag', requires: [], note: 'Amazon Ads CAPI server tag (region defaults to NA; pass tagRegion for EU).',
    derivedKey: 'tagId', idKeys: ['tagId'], snippetRe: /amzn\s*\(\s*['"]addTag['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /stackadapt|\bsaq\s*\(|srv\.stackadapt/i, destination: 'StackAdapt', serverTool: 'create_stackadapt_server_tag', requires: [], note: 'StackAdapt server-side pixel.',
    derivedKey: 'pixelID', idKeys: ['pixelID', 'pixelId'], snippetRe: /saq\s*\(\s*['"]ts['"]\s*,\s*['"]([^'"]+)['"]/i },
  // X (Twitter): the server tag needs the per-conversion X "Event ID" (tw-…) from X Ads Events Manager
  // — a different thing from a dedup id — plus a Pixel Access Token (or OAuth 1.0a keys). Neither is
  // on the web tag; only the Pixel ID is.
  { re: /\btwitter\b|\bx[\s_-]?pixel\b|twq\s*\(|static\.ads-twitter/i, destination: 'X (Twitter)', serverTool: 'create_x_capi_server_tag', requires: ['eventId', 'pixelAccessToken'],
    note: 'X Conversion API server tag (stape-io/twitter-tag). eventId = the X conversion Event ID (tw-…), one per conversion event.',
    derivedKey: 'pixelId', idKeys: ['pixelId'], snippetRe: /twq\s*\(\s*['"]config['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /quora|\bqp\s*\(/i, destination: 'Quora', serverTool: 'create_quora_capi_server_tag', requires: ['accessToken'], note: 'Quora Conversion API server tag (stape-io/quora-tag).',
    derivedKey: 'accountId', idKeys: ['accountId', 'pixelId'], snippetRe: /qp\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /adroll|__adroll|adroll_adv_id/i, destination: 'AdRoll', serverTool: 'create_adroll_capi_server_tag', requires: ['accessToken'], note: 'AdRoll server tag (stape-io/adroll-tag); needs the advertisable id AND the pixel id, both public.',
    derivedKey: 'advertisableId', idKeys: ['advertisableId'], snippetRe: /adroll_adv_id\s*=\s*['"]([^'"]+)['"]/i,
    extra: [{ key: 'pixelId', re: /adroll_pix_id\s*=\s*['"]([^'"]+)['"]/i }] },
  { re: /nextdoor|\bndp\s*\(/i, destination: 'Nextdoor', serverTool: 'create_nextdoor_capi_server_tag', requires: ['clientId', 'accessToken'], note: 'Nextdoor Conversion API server tag (stape-io/nextdoor-tag).',
    derivedKey: 'pixelId', idKeys: ['pixelId'], snippetRe: /ndp\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/i },
  // Yelp and Spotify web tags carry no public id: only the secret(s) are needed.
  { re: /\byelp\b/i, destination: 'Yelp', serverTool: 'create_yelp_capi_server_tag', requires: ['accessToken'], note: 'Yelp Conversion API server tag (stape-io/yelp-tag).' },
  { re: /spotify/i, destination: 'Spotify Ads', serverTool: 'create_spotify_capi_server_tag', requires: ['authToken', 'connectionId'], note: 'Spotify Ads Conversion API server tag (stape-io/spotify-tag).' },
  { re: /line[\s_-]?yahoo|yahoo[\s_-]?(ads|conversion|retargeting)|\byjtag\b|s\.yimg\.jp/i, destination: 'LINE Yahoo', serverTool: 'create_line_yahoo_capi_server_tag', requires: ['accessToken', 'channelId', 'eventSnippetId'],
    note: 'LINE Yahoo (Yahoo! JAPAN Ads) Conversion API server tag (stape-io/line-yahoo-tag); every non-page_view event needs its own Event Snippet ID.',
    derivedKey: 'tagId', idKeys: ['tagId'], snippetRe: /yahoo_retargeting_id\s*[:=]\s*['"]([^'"]+)['"]/i },
  // RTB House is a retargeting tag with no token: the tagging hash (public, in the pixel URL) + partner key.
  { re: /rtb\s*house|rtbhouse|creativecdn\.com/i, destination: 'RTB House', serverTool: 'create_rtb_house_server_tag', requires: ['partnerKey'], note: 'RTB House server tag (stape-io/rtb-house-tag); events are page types (home/offer/basket/order), mapped from GA4 names.',
    derivedKey: 'taggingHash', idKeys: ['taggingHash'], snippetRe: /creativecdn\.com\/tags\?id=([A-Za-z0-9_-]+)/i },

  // ── Phase C: analytics destinations (GENERIC path — import the Stape template + tags_create) ──
  // No typed builder: the item names the template (stape-io/<repo>), the fields it needs (`requires`
  // = the template's own keys, read from its template.tpl) and any public id the web snippet carries.
  // Listed AFTER the ad-platform entries so an existing match keeps precedence (first hit wins).
  { re: /piwik[\s_-]?pro|containers\.piwik\.pro|piwik\.pro/i, destination: 'Piwik PRO', serverTool: 'templates_import_from_gallery (stape-io/piwik-pro-tag) + tags_create', requires: ['trackingUrl', 'tokenAuth'], status: 'generic',
    note: 'Piwik PRO server tag; fields trackingUrl (your instance), siteId, tokenAuth (Auth Token), eventType/eventName. The web container id is the siteId.',
    derivedKey: 'siteId', snippetRe: /containers\/([0-9a-f-]{36})\.js/i },
  { re: /matomo|\b_paq\b|piwik\.(js|php)/i, destination: 'Matomo', serverTool: 'templates_import_from_gallery (stape-io/matomo-advanced-tag) + tags_create', requires: ['tokenAuth'], status: 'generic',
    note: 'Matomo server tag; fields trackingUrl, siteId, tokenAuth (an API auth token - never on the web tag), eventType/eventName.',
    derivedKey: 'siteId', snippetRe: /setSiteId['"]?\s*,\s*['"]?(\d+)/i, extra: [{ key: 'trackingUrl', re: /(?:var\s+u\s*=\s*|setTrackerUrl['"]?\s*,\s*)['"](https?:\/\/[^'"]+)['"]/i }] },
  { re: /mixpanel/i, destination: 'Mixpanel', serverTool: 'templates_import_from_gallery (stape-io/mixpanel-tag) + tags_create', requires: [], status: 'generic',
    note: 'Mixpanel server tag; fields token (Project Token - public, on the web init), type (track/identify/alias/...), trackName (event).',
    derivedKey: 'token', snippetRe: /mixpanel\.init\s*\(\s*['"]([^'"]+)['"]/i },
  { re: /piano\s*analytics|pa\.setConfigurations|pa-cd\.com|at[\s_-]?internet/i, destination: 'Piano Analytics', serverTool: 'templates_import_from_gallery (stape-io/piano-tag) + tags_create', requires: [], status: 'generic',
    note: 'Piano Analytics server tag; fields collectionDomain (your pa-cd collect domain), siteId, eventType/eventName. Both ids are public, on the web config.',
    derivedKey: 'siteId', snippetRe: /site\s*:\s*['"]?(\d+)/i, extra: [{ key: 'collectionDomain', re: /collectDomain\s*:\s*['"](https?:\/\/[^'"]+)['"]/i }] },
  { re: /plausible/i, destination: 'Plausible', serverTool: 'templates_import_from_gallery (stape-io/plausible-analytics-tag-server) + tags_create', requires: [], status: 'generic',
    note: 'Plausible server tag; fields endpointUrl (defaults to plausible.io/api/event; set your self-hosted URL), domain (the data-domain of the web script), setEventVar for custom events.',
    derivedKey: 'domain', snippetRe: /data-domain\s*=\s*['"]([^'"]+)['"]/i },
  { re: /umami/i, destination: 'Umami', serverTool: 'templates_import_from_gallery (stape-io/umami-tag-server) + tags_create', requires: [], status: 'generic',
    note: 'Umami server tag; fields endpointUrl (defaults to Umami Cloud; set your self-hosted /api/send), websiteId (the data-website-id of the web script), domain.',
    derivedKey: 'websiteId', snippetRe: /data-website-id\s*=\s*['"]([^'"]+)['"]/i },
  { re: /pirsch/i, destination: 'Pirsch', serverTool: 'templates_import_from_gallery (stape-io/pirsch-tag-server) + tags_create', requires: ['token'], status: 'generic',
    note: 'Pirsch server tag; fields endpointUrl (api.pirsch.io/api/v1 by default), token (a Pirsch ACCESS token - not the web identification code), setUrlVar/setEventVar.' },
  { re: /snowplow|newTracker\s*\(/i, destination: 'Snowplow', serverTool: 'templates_import_from_gallery (stape-io/snowplow-gtm-server-side-tag) + tags_create', requires: [], status: 'generic',
    note: 'Snowplow server tag; fields collectorUrl (the collector the web tracker posts to), the event/context schema mapping.',
    derivedKey: 'collectorUrl', snippetRe: /newTracker['"]?\s*[,(]\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/i },
  { re: /klaviyo/i, destination: 'Klaviyo', serverTool: 'templates_import_from_gallery (stape-io/klaviyo-tag) + tags_create', requires: ['apiKey'], status: 'generic',
    note: 'Klaviyo server tag; fields apiKey (a PRIVATE API key - the web script\'s company_id is the public key and will not work), type (event/identify), event, email/phone/klaviyoUserId.' },

  // ── Phase D: affiliate networks (GENERIC path). Most are click-id cookie + conversion postback tags:
  // the server tag stores the network's click id on landing (type pageView) and reports the order on
  // conversion (type conversion) - so plan TWO tags per network when the web tag is a conversion pixel.
  { re: /\bawin\b|dwin1\.com|awin1\.com/i, destination: 'Awin', serverTool: 'templates_import_from_gallery (stape-io/awin-conversion-api-tag) + tags_create', requires: ['apiKey'], status: 'generic',
    note: 'Awin Conversion API server tag; fields advertiserId (public, in the dwin1.com/<id>.js MasterTag URL), apiKey (Awin API key), type pageView (stores the publisher click) then conversion.',
    derivedKey: 'advertiserId', snippetRe: /dwin1\.com\/(\d+)\.js/i },
  { re: /commission\s*junction|\bcj\s*(tag|affiliate|pixel)|mczbf\.com|emjcd\.com/i, destination: 'CJ', serverTool: 'templates_import_from_gallery (stape-io/cj-tag) + tags_create', requires: ['cid', 'actionId'], status: 'generic',
    note: 'CJ (Commission Junction) server tag; fields cid (Enterprise ID), actionId, then order fields (orderId, amount, currencyCode, items) for the conversion type; cjevent click id is stored on page_view.',
    derivedKey: 'cid', snippetRe: /enterpriseId\s*[:=]\s*['"]?(\d+)/i },
  { re: /impact\s*radius|impactcdn\.com|impact\.com|\bimpact\s*(affiliate|conversion|tag|pixel)/i, destination: 'Impact', serverTool: 'templates_import_from_gallery (stape-io/impact-tag) + tags_create', requires: ['accountSID', 'authToken', 'eventTypeId', 'campaignId'], status: 'generic',
    note: 'Impact server tag; fields accountSID + authToken (API credentials, never on the web tag), campaignId, eventTypeId, orderId/productArray for conversions; im_ref click id stored on page_view.' },
  { re: /rakuten|linksynergy|ranMID|rm_trans/i, destination: 'Rakuten Advertising', serverTool: 'templates_import_from_gallery (stape-io/rakuten-tag) + tags_create', requires: ['affiliateKey'], status: 'generic',
    note: 'Rakuten server tag; fields mid (merchant id, public), affiliateKey (secret), orderId/currency/items for conversions.',
    derivedKey: 'mid', snippetRe: /(?:ranMID=|\bmid\s*[:=]\s*['"]?)(\d+)/i },
  { re: /shareasale/i, destination: 'ShareASale', serverTool: 'templates_import_from_gallery (stape-io/shareasale-tag) + tags_create', requires: [], status: 'generic',
    note: 'ShareASale server tag; fields merchantID (public), transtype (sale), amount; sscid click id stored on page_view.',
    derivedKey: 'merchantID', snippetRe: /merchantID\s*[=:]\s*['"]?(\d+)/i },
  { re: /tradedoubler/i, destination: 'Tradedoubler', serverTool: 'templates_import_from_gallery (stape-io/tradedoubler-tag) + tags_create', requires: ['programId'], status: 'generic',
    note: 'Tradedoubler server tag; fields organizationId (public, in the tbs.tradedoubler.com report URL), programId, conversionType sales|leads; tduid click id stored on pageView.',
    derivedKey: 'organizationId', snippetRe: /organization=(\d+)/i },
  { re: /webgains|ITCVRQ/i, destination: 'Webgains', serverTool: 'templates_import_from_gallery (stape-io/webgains-tag) + tags_create', requires: [], status: 'generic',
    note: 'Webgains server tag; fields programId (public), eventId, orderReference/currency/items for conversions; wgu click id stored on page_view.',
    derivedKey: 'programId', snippetRe: /cvr\.programId['"]?\s*,\s*['"]?(\d+)/i },
  { re: /admitad/i, destination: 'Admitad', serverTool: 'templates_import_from_gallery (stape-io/admitad-tag) + tags_create', requires: ['postbackKey', 'actionCode'], status: 'generic',
    note: 'Admitad server tag; fields campaignCode (public), postbackKey (secret), actionCode, tariffCode, paymentType; admitad_uid click id stored on page_view.',
    derivedKey: 'campaignCode', snippetRe: /campaign_code\s*[:=]\s*['"]([^'"]+)['"]/i },
  { re: /adtraction|ADT\.Tag/i, destination: 'Adtraction', serverTool: 'templates_import_from_gallery (stape-io/adtraction-tag) + tags_create', requires: ['programId'], status: 'generic',
    note: 'Adtraction server tag; fields programId, transactionTypeId (ADT.Tag.tp on the web tag), currency/orderReference/orderValue for conversions; at_gd click id stored on pageView.',
    derivedKey: 'transactionTypeId', snippetRe: /ADT\.Tag\.tp\s*=\s*(\d+)/i },
  { re: /affiliate\s*future|affiliatefuture/i, destination: 'Affiliate Future', serverTool: 'templates_import_from_gallery (stape-io/affiliate-future-server-tag) + tags_create', requires: ['merchantId'], status: 'generic',
    note: 'Affiliate Future server tag; fields merchantId, orderId/orderValue/currency/products for conversions; affc click id stored on pageView.' },
  { re: /effinity|effiliation/i, destination: 'Effinity', serverTool: 'templates_import_from_gallery (stape-io/effinity-tag) + tags_create', requires: ['idCompteur'], status: 'generic',
    note: 'Effinity server tag; fields effinityId (public, effi_id in the tracking URL), idCompteur, conversionType sale|lead, orderOrLeadId.',
    derivedKey: 'effinityId', snippetRe: /effi_id=([A-Za-z0-9_-]+)/i },
  { re: /refersion|_rfsn/i, destination: 'Refersion', serverTool: 'templates_import_from_gallery (stape-io/refersion-tag) + tags_create', requires: ['secretKey'], status: 'generic',
    note: 'Refersion server tag; fields publicKey (pub_..., public, in the tracker script URL), secretKey (secret), orderId/currencyCode/items for conversions.',
    derivedKey: 'publicKey', snippetRe: /(pub_[A-Za-z0-9]+)/ },
  { re: /tapfiliate|\btap\s*\(\s*['"]create['"]/i, destination: 'Tapfiliate', serverTool: 'templates_import_from_gallery (stape-io/tapfiliate-tag) + tags_create', requires: ['apiKey'], status: 'generic',
    note: 'Tapfiliate server tag; fields apiKey (the web tap(\'create\', ...) account id is NOT it), referralCodeKey (ref), customerId/customerStatus.' },
  { re: /everflow|\bEF\.(conversion|click)|_ef_transaction_id/i, destination: 'Everflow', serverTool: 'templates_import_from_gallery (stape-io/everflow-tag) + tags_create', requires: ['postbackUrl'], status: 'generic',
    note: 'Everflow server tag; fields postbackUrl (your Everflow conversion postback, offer/affiliate ids inside it), clickId (_ef_transaction_id stored on landing).' },
  { re: /voluum/i, destination: 'Voluum', serverTool: 'templates_import_from_gallery (stape-io/voluum-tag) + tags_create', requires: ['postbackDomain', 'clickIdKey'], status: 'generic',
    note: 'Voluum server tag; fields postbackDomain (your tracking domain), clickIdKey (the landing-page click id parameter), clickId; autoMap derives the conversion payload.' },
];

/** Meta's public Pixel ID on the web side: the gallery template's `pixelId` param, or the id inside
 *  fbq('init', '<id>') in a Custom HTML snippet. '' when absent. PURE. */
const META_INIT_RE = /fbq\s*\(\s*['"]init['"]\s*,\s*['"]([^'"]+)['"]/i;

/**
 * Plan the port of a WEB container's conversion tags to a SERVER container: for each recognised
 * destination, which server tool builds it, the ids read off the web tag, and the secrets the caller
 * must still provide. PURE and READ-ONLY - it creates nothing. GA4 is reported separately because it is
 * ported once as the relay by create_server_container_from_web, not per tag.
 */
export function planWebToServerMigration(snapshot: ContainerSnapshot): ServerMigrationPlan {
  const pv = (t: ContainerSnapshot['tags'][number], key: string): string => {
    for (const p of t.parameter) { const pp = p as { key?: string; value?: unknown }; if (pp.key === key) return String(pp.value ?? '').trim(); }
    return '';
  };
  const meta = detectMetaTags(snapshot);
  const metaIds = new Set(meta.metaTags.map((m) => m.id));
  const measurementIds = new Set<string>();
  const items: ServerMigrationItem[] = [];

  for (const t of snapshot.tags) {
    const type = String(t.type ?? '');
    // GA4: aggregated into the relay, collect the measurement id.
    if ((type === 'googtag' && /^G-/i.test(pv(t, 'tagId'))) || type === 'gaawe') {
      const mid = pv(t, 'tagId') || pv(t, 'measurementIdOverride') || pv(t, 'measurementId');
      if (/^G-/i.test(mid)) measurementIds.add(mid);
      continue;
    }
    // Meta (detected by fbq/name/snippet) → Meta CAPI. The Pixel ID is public and on the web tag
    // (template param or fbq('init', …)), so carry it; only the access token is left to supply.
    if (metaIds.has(t.tagId)) {
      const pixelId = pv(t, 'pixelId') || (META_INIT_RE.exec(pv(t, 'html'))?.[1] ?? '').trim();
      items.push({
        webTag: t.name, destination: 'Meta', detectedBy: 'name', serverTool: 'create_meta_capi_server_tag',
        derived: pixelId ? { pixelId } : {}, requires: pixelId ? ['accessToken'] : ['pixelId', 'accessToken'],
        note: 'Meta Conversions API server tag; auto-imports stape-io/facebook-tag.', status: 'typed-tool',
      });
      continue;
    }
    // Native Google/Floodlight conversion types (authoritative).
    if (type === 'awct') {
      items.push({ webTag: t.name, destination: 'Google Ads conversion', detectedBy: 'native-type', serverTool: 'create_server_tag (platform: ads_conversion)', derived: { conversionId: pv(t, 'conversionId'), conversionLabel: pv(t, 'conversionLabel') }, requires: [], note: 'Fire on a per-event server trigger; set productReporting for ecommerce.', status: 'typed-tool' });
      continue;
    }
    if (type === 'sp') {
      items.push({ webTag: t.name, destination: 'Google Ads remarketing', detectedBy: 'native-type', serverTool: 'create_server_tag (platform: ads_remarketing)', derived: { conversionId: pv(t, 'conversionId') }, requires: [], note: 'Server-side remarketing audience tag.', status: 'typed-tool' });
      continue;
    }
    if (type === 'awcc') {
      items.push({ webTag: t.name, destination: 'Google Ads call conversion', detectedBy: 'native-type', serverTool: null, derived: { conversionId: pv(t, 'conversionId') }, requires: [], note: 'No standard sGTM call-conversion tag; keep it client-side or use Google Ads call reporting.', status: 'manual' });
      continue;
    }
    if (type === 'flc') {
      items.push({ webTag: t.name, destination: 'Floodlight', detectedBy: 'native-type', serverTool: 'templates_import_from_gallery + tags_create', derived: { advertiserId: pv(t, 'advertiserId'), groupTag: pv(t, 'groupTag'), activityTag: pv(t, 'activityTag') }, requires: [], note: 'No typed server Floodlight builder; use a server Floodlight template via the generic path.', status: 'generic' });
      continue;
    }
    if (type === 'gclidw') {
      items.push({ webTag: t.name, destination: 'Conversion Linker', detectedBy: 'native-type', serverTool: null, derived: {}, requires: [], note: 'Not needed server-side: the server GA4 client + FPID cookies handle linking.', status: 'skip' });
      continue;
    }
    // Native vendor types (authoritative — no name guessing). GTM's built-in Microsoft UET tag stores
    // the UET id as `tagId`; the built-in LinkedIn Insight tag stores the Partner ID as `id` (both
    // verified against the 562-container corpus). The same server tools apply as for the pixels'
    // template/Custom-HTML forms below.
    if (type === 'baut') {
      const uetTagId = pv(t, 'tagId');
      items.push({ webTag: t.name, destination: 'Microsoft Ads', detectedBy: 'native-type', serverTool: 'create_microsoft_capi_server_tag', derived: uetTagId ? { uetTagId } : {}, requires: ['authToken'], note: 'Microsoft Ads CAPI; REQUIRES MSCLKID forwarded from the web side.', status: 'typed-tool' });
      continue;
    }
    if (type === 'bzi') {
      const partnerId = pv(t, 'id');
      items.push({ webTag: t.name, destination: 'LinkedIn', detectedBy: 'native-type', serverTool: 'create_linkedin_capi_server_tag', derived: partnerId ? { partnerId } : {}, requires: ['accessToken', 'conversionRuleUrn'], note: 'LinkedIn CAPI server tag. The web Partner ID is informational: the server tag fires on a Conversion Rule URN, which the caller must supply.', status: 'typed-tool' });
      continue;
    }
    // Template/Custom-HTML pixels by name or snippet. The vendor's public id is read off the template
    // param (idKeys) or the init call in the snippet (snippetRe) and carried as `derived`, so the server
    // tag is created pre-filled; it is never a secret, so it is never in `requires`.
    const html = pv(t, 'html');
    const hay = `${t.name} ${type} ${html}`;
    const hit = SERVER_MIGRATION_HEURISTICS.find((h) => h.re.test(hay));
    if (hit) {
      const derived: Record<string, string> = {};
      if (hit.derivedKey) {
        const id = (hit.idKeys ?? []).map((k) => pv(t, k)).find(Boolean) || (hit.snippetRe?.exec(html)?.[1] ?? '').trim();
        if (id) derived[hit.derivedKey] = id;
      }
      for (const x of hit.extra ?? []) {
        const v = (x.re.exec(html)?.[1] ?? '').trim();
        if (v) derived[x.key] = v;
      }
      items.push({ webTag: t.name, destination: hit.destination, detectedBy: 'name', serverTool: hit.serverTool, derived, requires: hit.requires, note: hit.note, status: hit.status ?? 'typed-tool' });
    }
  }

  const count = (s: ServerMigrationItem['status']): number => items.filter((i) => i.status === s).length;
  return {
    ga4: { present: measurementIds.size > 0, measurementIds: [...measurementIds] },
    items,
    summary: { total: items.length, auto: measurementIds.size > 0 ? 1 : 0, typedTool: count('typed-tool'), generic: count('generic'), manual: count('manual'), skipped: count('skip') },
  };
}
