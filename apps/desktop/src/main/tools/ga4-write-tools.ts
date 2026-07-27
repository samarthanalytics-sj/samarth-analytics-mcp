/**
 * GA4 Admin WRITE tools for the desktop chat (create / update / delete / archive).
 *
 * The GA4 chat is read-only by default; these become available only when the GA4
 * product is given a confirm function (see chat-service). Approvals are
 * delete-only: creates/updates apply directly to GA4, deletes AND archives show
 * the two-step approval card (archive is effectively permanent).
 *
 * GA4 Admin collections are uniform, so a data-driven catalog maps each resource
 * to a dotted accessor path (resolved on the versioned client in data-service).
 * High-frequency resources expose typed fields; every create/update also accepts
 * a raw `body` object merged over them for nested/advanced shapes.
 */

import type { GoogleDataService } from '../google/data-service';
import type { Tool } from './registry';

const s = (v: unknown): string => String(v ?? '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const prop = (a: string): string => (a.startsWith('accounts/') ? a : `accounts/${a}`);
const propy = (p: string): string => (p.startsWith('properties/') ? p : `properties/${p}`);
const streamName = (p: string, ds: string): string => `${propy(p)}/${ds.startsWith('dataStreams/') ? ds : `dataStreams/${ds}`}`;

type Parent = 'property' | 'dataStream' | 'account';
type Ver = 'v1beta' | 'v1alpha';

interface JsonProp { type: string; description?: string; enum?: string[]; items?: JsonProp }
interface Desc {
  key: string;
  plural: string;
  version: Ver;
  parent: Parent;
  accessor: string; // dotted path on the client, e.g. 'properties.keyEvents'
  rawBody?: boolean;
  // Sensitive creates/updates that grant real-world power to a third party (access bindings grant a
  // live person account/property permissions). They ARE revertible (a delete tool revokes the grant),
  // but a silent auto-apply would let a prompt injection hand out access, so they get a SINGLE approval
  // card the user must approve (like a live Ads create - not the two-step "type delete" path, whose
  // wording would be wrong for a grant). The ordinary config creates (key events, dimensions, links)
  // stay one-click with no card.
  sensitive?: boolean;
  // toBody, when present, REPLACES the flat pick(bodyKeys) mapping — use it when
  // the request body needs nesting the flat args can't express (e.g. a WEB data
  // stream's defaultUri lives under webStreamData, not at the top level).
  create?: { props: Record<string, JsonProp>; required?: string[]; bodyKeys: string[]; toBody?: (a: Record<string, unknown>) => Record<string, unknown>; queryKeys?: string[]; validate?: (body: Record<string, unknown>) => void; desc: string };
  update?: { props: Record<string, JsonProp>; bodyKeys: string[]; toBody?: (a: Record<string, unknown>) => Record<string, unknown>; validate?: (body: Record<string, unknown>) => void; desc: string };
  del?: { desc: string };
  archive?: { desc: string };
}

const parentSchema = (p: Parent): { props: Record<string, JsonProp>; required: string[]; build: (a: Record<string, unknown>) => string } => {
  if (p === 'property') return { props: { property: { type: 'string', description: 'GA4 property id ("123" or "properties/123").' } }, required: ['property'], build: (a) => propy(s(a.property)) };
  if (p === 'dataStream') return { props: { property: { type: 'string' }, dataStreamId: { type: 'string', description: 'Data stream id ("9" or "dataStreams/9").' } }, required: ['property', 'dataStreamId'], build: (a) => streamName(s(a.property), s(a.dataStreamId)) };
  return { props: { accountId: { type: 'string', description: 'GA4 account id ("123" or "accounts/123").' } }, required: ['accountId'], build: (a) => prop(s(a.accountId)) };
};

const pick = (a: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
};

const bodyArgProp: JsonProp = { type: 'object', description: 'Raw request-body object merged OVER the typed fields — for nested/advanced GA4 fields.' };

/** The GA4 Admin API's DataStream has very few writable fields. Everything people REACH for here
 *  (cross-domain domains, unwanted referrals, internal traffic, session timeout) lives in the
 *  GOOGLE TAG settings, which the Admin API does not expose at all - so reject those up front
 *  with directions instead of letting Google return "Unknown name ... Cannot find field". */
export function validateDataStreamBody(body: Record<string, unknown>, forCreate: boolean): void {
  const allowedTop = new Set(forCreate ? ['type', 'displayName', 'webStreamData', 'androidAppStreamData', 'iosAppStreamData'] : ['displayName', 'webStreamData']);
  const badTop = Object.keys(body).filter((k) => !allowedTop.has(k));
  const web = body.webStreamData;
  const badWeb = web && typeof web === 'object' ? Object.keys(web as Record<string, unknown>).filter((k) => k !== 'defaultUri') : [];
  if (badTop.length === 0 && badWeb.length === 0) return;
  const bad = [...badTop, ...badWeb.map((k) => `webStreamData.${k}`)].join(', ');
  throw new Error(
    `These are not GA4 Admin API data-stream fields: ${bad}. Cross-domain domains, unwanted referrals, ` +
      'internal traffic and session settings are GOOGLE TAG settings - no API can change them; set them in ' +
      'GA4: Admin > Data streams > (your stream) > Configure tag settings. ' +
      `API-writable stream fields: displayName, webStreamData.defaultUri${forCreate ? ', type, packageName, bundleId' : ''}.`
  );
}


const CATALOG: Desc[] = [
  {
    key: 'key_event', plural: 'key events', version: 'v1beta', parent: 'property', accessor: 'properties.keyEvents', rawBody: true,
    create: { props: { eventName: { type: 'string', description: 'Event to mark as a key event (e.g. "purchase").' }, countingMethod: { type: 'string', enum: ['ONCE_PER_EVENT', 'ONCE_PER_SESSION'] } }, required: ['eventName'], bodyKeys: ['eventName', 'countingMethod'], desc: 'Create a key event (conversion).' },
    update: { props: { countingMethod: { type: 'string', enum: ['ONCE_PER_EVENT', 'ONCE_PER_SESSION'] } }, bodyKeys: ['countingMethod'], desc: 'Update a key event.' },
    del: { desc: 'Delete a key event.' },
  },
  {
    key: 'custom_dimension', plural: 'custom dimensions', version: 'v1beta', parent: 'property', accessor: 'properties.customDimensions',
    create: { props: { parameterName: { type: 'string' }, displayName: { type: 'string' }, scope: { type: 'string', enum: ['EVENT', 'USER', 'ITEM'] }, description: { type: 'string' }, disallowAdsPersonalization: { type: 'boolean' } }, required: ['parameterName', 'displayName', 'scope'], bodyKeys: ['parameterName', 'displayName', 'scope', 'description', 'disallowAdsPersonalization'], desc: 'Create a custom dimension.' },
    update: { props: { displayName: { type: 'string' }, description: { type: 'string' }, disallowAdsPersonalization: { type: 'boolean' } }, bodyKeys: ['displayName', 'description', 'disallowAdsPersonalization'], desc: 'Update a custom dimension (parameterName/scope immutable).' },
    archive: { desc: 'Archive a custom dimension (no hard delete).' },
  },
  {
    key: 'custom_metric', plural: 'custom metrics', version: 'v1beta', parent: 'property', accessor: 'properties.customMetrics',
    create: { props: { parameterName: { type: 'string' }, displayName: { type: 'string' }, measurementUnit: { type: 'string', enum: ['STANDARD', 'CURRENCY', 'FEET', 'METERS', 'KILOMETERS', 'MILES', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS'] }, scope: { type: 'string', enum: ['EVENT'] }, description: { type: 'string' } }, required: ['parameterName', 'displayName', 'measurementUnit', 'scope'], bodyKeys: ['parameterName', 'displayName', 'measurementUnit', 'scope', 'description'], desc: 'Create a custom metric.' },
    update: { props: { displayName: { type: 'string' }, description: { type: 'string' }, measurementUnit: { type: 'string' } }, bodyKeys: ['displayName', 'description', 'measurementUnit'], desc: 'Update a custom metric.' },
    archive: { desc: 'Archive a custom metric (no hard delete).' },
  },
  {
    key: 'data_stream', plural: 'data streams', version: 'v1beta', parent: 'property', accessor: 'properties.dataStreams', rawBody: true,
    create: {
      props: { type: { type: 'string', enum: ['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'] }, displayName: { type: 'string' }, defaultUri: { type: 'string', description: 'WEB stream site URL (nested under webStreamData).' }, packageName: { type: 'string', description: 'ANDROID app package name.' }, bundleId: { type: 'string', description: 'IOS app bundle id.' } },
      required: ['type', 'displayName'], bodyKeys: ['type', 'displayName'],
      // Stream-specific fields must nest under webStreamData/androidAppStreamData/iosAppStreamData.
      toBody: (a) => ({
        type: a.type, displayName: a.displayName,
        ...(a.defaultUri ? { webStreamData: { defaultUri: a.defaultUri } } : {}),
        ...(a.packageName ? { androidAppStreamData: { packageName: a.packageName } } : {}),
        ...(a.bundleId ? { iosAppStreamData: { bundleId: a.bundleId } } : {}),
      }),
      validate: (b) => validateDataStreamBody(b, true),
      desc: 'Create a data stream (web / Android / iOS).',
    },
    update: {
      props: { displayName: { type: 'string' }, defaultUri: { type: 'string', description: 'New site URL for a WEB stream (webStreamData.defaultUri).' } },
      bodyKeys: ['displayName'],
      toBody: (a) => ({
        ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
        ...(a.defaultUri ? { webStreamData: { defaultUri: a.defaultUri } } : {}),
      }),
      validate: (b) => validateDataStreamBody(b, false),
      desc: 'Update a data stream: displayName and (web) defaultUri ONLY. Cross-domain domains, unwanted referrals, internal traffic and session settings are Google tag settings with NO Admin API fields - never attempt them; tell the user to change them in GA4 Admin > Data streams > Configure tag settings.',
    },
    del: { desc: 'Delete a data stream.' },
  },
  {
    key: 'google_ads_link', plural: 'Google Ads links', version: 'v1beta', parent: 'property', accessor: 'properties.googleAdsLinks',
    create: { props: { customerId: { type: 'string', description: 'Ads customer id (digits).' }, adsPersonalizationEnabled: { type: 'boolean' } }, required: ['customerId'], bodyKeys: ['customerId', 'adsPersonalizationEnabled'], desc: 'Create a Google Ads link.' },
    update: { props: { adsPersonalizationEnabled: { type: 'boolean' } }, bodyKeys: ['adsPersonalizationEnabled'], desc: 'Update a Google Ads link.' },
    del: { desc: 'Delete a Google Ads link.' },
  },
  {
    key: 'firebase_link', plural: 'Firebase links', version: 'v1beta', parent: 'property', accessor: 'properties.firebaseLinks',
    create: { props: { project: { type: 'string', description: 'Firebase project id/number.' } }, required: ['project'], bodyKeys: ['project'], desc: 'Create a Firebase link.' },
    del: { desc: 'Delete a Firebase link.' },
  },
  {
    key: 'measurement_protocol_secret', plural: 'Measurement Protocol secrets', version: 'v1beta', parent: 'dataStream', accessor: 'properties.dataStreams.measurementProtocolSecrets',
    create: { props: { displayName: { type: 'string' } }, required: ['displayName'], bodyKeys: ['displayName'], desc: 'Create a Measurement Protocol secret (response includes the secret value).' },
    update: { props: { displayName: { type: 'string' } }, bodyKeys: ['displayName'], desc: 'Rename a Measurement Protocol secret.' },
    del: { desc: 'Delete a Measurement Protocol secret.' },
  },
  {
    key: 'audience', plural: 'audiences', version: 'v1alpha', parent: 'property', accessor: 'properties.audiences', rawBody: true,
    create: { props: { displayName: { type: 'string' }, description: { type: 'string' }, membershipDurationDays: { type: 'number' } }, bodyKeys: ['displayName', 'description', 'membershipDurationDays'], desc: 'Create an audience (pass filterClauses via body).' },
    update: { props: { displayName: { type: 'string' }, description: { type: 'string' } }, bodyKeys: ['displayName', 'description'], desc: 'Update an audience (name/description only).' },
    archive: { desc: 'Archive an audience (effectively permanent).' },
  },
  {
    key: 'channel_group', plural: 'channel groups', version: 'v1alpha', parent: 'property', accessor: 'properties.channelGroups', rawBody: true,
    create: { props: { displayName: { type: 'string' }, description: { type: 'string' } }, bodyKeys: ['displayName', 'description'], desc: 'Create a custom channel group (groupingRule[] via body).' },
    update: { props: {}, bodyKeys: [], desc: 'Update a channel group (via body).' },
    del: { desc: 'Delete a channel group.' },
  },
  {
    key: 'calculated_metric', plural: 'calculated metrics', version: 'v1alpha', parent: 'property', accessor: 'properties.calculatedMetrics', rawBody: true,
    create: { props: { calculatedMetricId: { type: 'string', description: 'Reporting id for the metric.' }, displayName: { type: 'string' }, metricUnit: { type: 'string' }, formula: { type: 'string' } }, required: ['calculatedMetricId'], bodyKeys: ['displayName', 'metricUnit', 'formula'], queryKeys: ['calculatedMetricId'], desc: 'Create a calculated metric.' },
    update: { props: { displayName: { type: 'string' }, formula: { type: 'string' }, metricUnit: { type: 'string' } }, bodyKeys: ['displayName', 'formula', 'metricUnit'], desc: 'Update a calculated metric.' },
    del: { desc: 'Delete a calculated metric.' },
  },
  {
    key: 'expanded_data_set', plural: 'expanded data sets', version: 'v1alpha', parent: 'property', accessor: 'properties.expandedDataSets', rawBody: true,
    create: { props: { displayName: { type: 'string' }, description: { type: 'string' } }, bodyKeys: ['displayName', 'description'], desc: 'Create an expanded data set (360; dimensionNames/metricNames via body).' },
    update: { props: {}, bodyKeys: [], desc: 'Update an expanded data set (360).' },
    del: { desc: 'Delete an expanded data set (360).' },
  },
  {
    key: 'event_create_rule', plural: 'event create rules', version: 'v1alpha', parent: 'dataStream', accessor: 'properties.dataStreams.eventCreateRules', rawBody: true,
    create: { props: { destinationEvent: { type: 'string' } }, bodyKeys: ['destinationEvent'], desc: 'Create an event-create rule (eventConditions/parameterMutations via body).' },
    update: { props: {}, bodyKeys: [], desc: 'Update an event-create rule (via body).' },
    del: { desc: 'Delete an event-create rule.' },
  },
  {
    key: 'display_video_360_advertiser_link', plural: 'Display & Video 360 links', version: 'v1alpha', parent: 'property', accessor: 'properties.displayVideo360AdvertiserLinks', rawBody: true,
    create: { props: { advertiserId: { type: 'string' } }, bodyKeys: ['advertiserId'], desc: 'Create a Display & Video 360 advertiser link.' },
    update: { props: {}, bodyKeys: [], desc: 'Update a DV360 link (via body).' },
    del: { desc: 'Delete a DV360 link.' },
  },
  {
    key: 'search_ads_360_link', plural: 'Search Ads 360 links', version: 'v1alpha', parent: 'property', accessor: 'properties.searchAds360Links', rawBody: true,
    create: { props: { advertiserId: { type: 'string' } }, bodyKeys: ['advertiserId'], desc: 'Create a Search Ads 360 link.' },
    update: { props: {}, bodyKeys: [], desc: 'Update a Search Ads 360 link (via body).' },
    del: { desc: 'Delete a Search Ads 360 link.' },
  },
  {
    key: 'adsense_link', plural: 'AdSense links', version: 'v1alpha', parent: 'property', accessor: 'properties.adSenseLinks', rawBody: true,
    create: { props: { adClientCode: { type: 'string', description: 'e.g. "ca-pub-…".' } }, bodyKeys: ['adClientCode'], desc: 'Create an AdSense link.' },
    del: { desc: 'Delete an AdSense link.' },
  },
  {
    key: 'subproperty_event_filter', plural: 'subproperty event filters', version: 'v1alpha', parent: 'property', accessor: 'properties.subpropertyEventFilters', rawBody: true,
    create: { props: {}, bodyKeys: [], desc: 'Create a subproperty event filter (360; applyToProperty + filterClauses via body).' },
    update: { props: {}, bodyKeys: [], desc: 'Update a subproperty event filter (360).' },
    del: { desc: 'Delete a subproperty event filter (360).' },
  },
  {
    key: 'rollup_property_source_link', plural: 'rollup property source links', version: 'v1alpha', parent: 'property', accessor: 'properties.rollupPropertySourceLinks', rawBody: true,
    create: { props: { sourceProperty: { type: 'string' } }, bodyKeys: ['sourceProperty'], desc: 'Add a source property to a rollup (360).' },
    del: { desc: 'Remove a source property from a rollup (360).' },
  },
  {
    key: 'property_access_binding', plural: 'property access bindings', version: 'v1alpha', parent: 'property', accessor: 'properties.accessBindings', sensitive: true,
    create: { props: { user: { type: 'string', description: 'User email to grant access.' }, roles: { type: 'array', items: { type: 'string' }, description: 'e.g. ["predefinedRoles/analyst"].' } }, required: ['user', 'roles'], bodyKeys: ['user', 'roles'], desc: "Grant a user access to a property (needs manage.users)." },
    update: { props: { roles: { type: 'array', items: { type: 'string' } } }, bodyKeys: ['roles'], desc: "Change a user's property roles." },
    del: { desc: "Revoke a user's property access." },
  },
  {
    key: 'account_access_binding', plural: 'account access bindings', version: 'v1alpha', parent: 'account', accessor: 'accounts.accessBindings', sensitive: true,
    create: { props: { user: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } } }, required: ['user', 'roles'], bodyKeys: ['user', 'roles'], desc: 'Grant a user access to an account (needs manage.users).' },
    update: { props: { roles: { type: 'array', items: { type: 'string' } } }, bodyKeys: ['roles'], desc: "Change a user's account roles." },
    del: { desc: "Revoke a user's account access." },
  },
];

const nameProp = (plural: string): Record<string, JsonProp> => ({ name: { type: 'string', description: `Full resource name of the ${plural.replace(/s$/, '')} (e.g. "properties/123/…/456").` } });

/** Build the GA4 Admin write Tool[] for the desktop registry (spread into writeTools). */
export function buildGa4WriteTools(data: GoogleDataService): Tool[] {
  const tools: Tool[] = [];

  for (const d of CATALOG) {
    const P = parentSchema(d.parent);
    if (d.create) {
      const c = d.create;
      tools.push({
        name: `create_ga4_${d.key}`,
        description: `[GA4] ${c.desc} ${d.sensitive ? 'Grants a real person live access - shows a one-click approval card (approve or edit it once).' : 'Applies directly to GA4 (no approval card; GA4 config change).'}`,
        inputSchema: { type: 'object', properties: { ...P.props, ...c.props, ...(d.rawBody ? { body: bodyArgProp } : {}) }, required: [...P.required, ...(c.required ?? [])], additionalProperties: false },
        write: true,
        ...(d.sensitive ? { approval: true as const } : {}),
        summarize: (a) => `Grant ${d.plural} on ${P.build(a)}`,
        handler: (a) => {
          const body = { ...(c.toBody ? c.toBody(a) : pick(a, c.bodyKeys)), ...obj(a.body) };
          c.validate?.(body);
          const query = c.queryKeys ? (pick(a, c.queryKeys) as Record<string, string>) : undefined;
          return data.ga4AdminCreate(d.version, d.accessor, P.build(a), body, query && Object.keys(query).length ? query : undefined);
        },
      });
    }
    if (d.update) {
      const u = d.update;
      tools.push({
        name: `update_ga4_${d.key}`,
        description: `[GA4] ${u.desc} Pass only the fields to change (updateMask derived from them). ${d.sensitive ? 'Changes live access for a real person - shows a one-click approval card.' : 'Applies directly to GA4.'}`,
        inputSchema: { type: 'object', properties: { ...nameProp(d.plural), ...u.props, ...(d.rawBody ? { body: bodyArgProp } : {}), updateMask: { type: 'string', description: 'Comma-separated field paths; omit to derive from supplied fields.' } }, required: ['name'], additionalProperties: false },
        write: true,
        ...(d.sensitive ? { approval: true as const } : {}),
        summarize: (a) => `Update ${d.plural} ${s(a.name)}`,
        handler: (a) => {
          const body = { ...(u.toBody ? u.toBody(a) : pick(a, u.bodyKeys)), ...obj(a.body) };
          u.validate?.(body);
          const mask = s(a.updateMask).trim() || Object.keys(body).join(',');
          if (!mask) throw new Error(`update_ga4_${d.key}: supply at least one field or updateMask.`);
          return data.ga4AdminPatch(d.version, d.accessor, s(a.name), mask, body);
        },
      });
    }
    if (d.del) {
      tools.push({
        name: `delete_ga4_${d.key}`,
        description: `[GA4] ${d.del.desc} Destructive — shows a two-step approval.`,
        inputSchema: { type: 'object', properties: nameProp(d.plural), required: ['name'], additionalProperties: false },
        write: true,
        destructive: true,
        summarize: (a) => `Delete ${d.plural.replace(/s$/, '')} ${s(a.name)}`,
        handler: (a) => data.ga4AdminDelete(d.version, d.accessor, s(a.name)),
      });
    }
    if (d.archive) {
      tools.push({
        name: `archive_ga4_${d.key}`,
        description: `[GA4] ${d.archive.desc} Effectively permanent — shows a two-step approval.`,
        inputSchema: { type: 'object', properties: nameProp(d.plural), required: ['name'], additionalProperties: false },
        write: true,
        destructive: true,
        summarize: (a) => `Archive ${d.plural.replace(/s$/, '')} ${s(a.name)}`,
        handler: (a) => data.ga4AdminArchive(d.version, d.accessor, s(a.name)),
      });
    }
  }

  // ── Bespoke lifecycle + settings ────────────────────────────────────────────
  tools.push(
    {
      name: 'create_ga4_property',
      description: '[GA4] Create a new GA4 property under an account. Applies directly to GA4.',
      inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, displayName: { type: 'string' }, timeZone: { type: 'string', description: 'IANA tz, e.g. "America/New_York".' }, currencyCode: { type: 'string', description: 'ISO 4217, e.g. "USD".' }, industryCategory: { type: 'string' } }, required: ['accountId', 'displayName', 'timeZone', 'currencyCode'], additionalProperties: false },
      write: true,
      summarize: (a) => `Create GA4 property "${s(a.displayName)}" under account ${s(a.accountId)}`,
      handler: (a) => data.ga4CreateProperty(prop(s(a.accountId)), { displayName: s(a.displayName), timeZone: s(a.timeZone), currencyCode: s(a.currencyCode), ...(s(a.industryCategory).trim() ? { industryCategory: s(a.industryCategory) } : {}) }),
    },
    {
      name: 'update_ga4_property',
      description: '[GA4] Update a GA4 property (displayName / timeZone / currencyCode / industryCategory). Applies directly.',
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, displayName: { type: 'string' }, timeZone: { type: 'string' }, currencyCode: { type: 'string' }, industryCategory: { type: 'string' } }, required: ['property'], additionalProperties: false },
      write: true,
      summarize: (a) => `Update GA4 property ${propy(s(a.property))}`,
      handler: (a) => {
        const body = pick(a, ['displayName', 'timeZone', 'currencyCode', 'industryCategory']);
        const mask = Object.keys(body).join(',');
        if (!mask) throw new Error('update_ga4_property: supply at least one field to update.');
        return data.ga4UpdateProperty(propy(s(a.property)), mask, body);
      },
    },
    {
      name: 'delete_ga4_property',
      description: '[GA4] Soft-delete (trash) a GA4 property — recoverable for a limited time. Destructive — two-step approval.',
      inputSchema: { type: 'object', properties: { property: { type: 'string' } }, required: ['property'], additionalProperties: false },
      write: true, destructive: true,
      summarize: (a) => `Trash GA4 property ${propy(s(a.property))}`,
      handler: (a) => data.ga4DeleteProperty(propy(s(a.property))),
    },
    {
      name: 'update_ga4_data_retention',
      description: '[GA4] Update a property\'s event data retention (2/14/26/38/50 months; longer options are 360-only) and reset-on-new-activity. Applies directly.',
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, eventDataRetention: { type: 'string', enum: ['TWO_MONTHS', 'FOURTEEN_MONTHS', 'TWENTY_SIX_MONTHS', 'THIRTY_EIGHT_MONTHS', 'FIFTY_MONTHS'] }, resetUserDataOnNewActivity: { type: 'boolean' } }, required: ['property'], additionalProperties: false },
      write: true,
      summarize: (a) => `Update data retention on ${propy(s(a.property))}`,
      handler: (a) => {
        const body = pick(a, ['eventDataRetention', 'resetUserDataOnNewActivity']);
        const mask = Object.keys(body).join(',');
        if (!mask) throw new Error('update_ga4_data_retention: supply eventDataRetention and/or resetUserDataOnNewActivity.');
        return data.ga4UpdateDataRetention(`${propy(s(a.property))}/dataRetentionSettings`, mask, body);
      },
    },
    {
      name: 'update_ga4_enhanced_measurement',
      description: "[GA4] Update a WEB data stream's Enhanced Measurement: master streamEnabled plus per-signal toggles (scrolls, outbound clicks, site search + query params, video engagement, file downloads, form interactions, SPA page changes). Applies directly.",
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, dataStreamId: { type: 'string' }, streamEnabled: { type: 'boolean' }, scrollsEnabled: { type: 'boolean' }, outboundClicksEnabled: { type: 'boolean' }, siteSearchEnabled: { type: 'boolean' }, videoEngagementEnabled: { type: 'boolean' }, fileDownloadsEnabled: { type: 'boolean' }, formInteractionsEnabled: { type: 'boolean' }, pageChangesEnabled: { type: 'boolean' }, searchQueryParameter: { type: 'string', description: 'Comma-separated site-search query params, e.g. "q,s,search".' }, uriQueryParameter: { type: 'string', description: 'Extra URL query params to include in page paths.' } }, required: ['property', 'dataStreamId'], additionalProperties: false },
      write: true,
      summarize: (a) => `Update enhanced measurement on ${streamName(s(a.property), s(a.dataStreamId))}`,
      handler: (a) => {
        const body = pick(a, ['streamEnabled', 'scrollsEnabled', 'outboundClicksEnabled', 'siteSearchEnabled', 'videoEngagementEnabled', 'fileDownloadsEnabled', 'formInteractionsEnabled', 'pageChangesEnabled', 'searchQueryParameter', 'uriQueryParameter']);
        const mask = Object.keys(body).join(',');
        if (!mask) throw new Error('update_ga4_enhanced_measurement: supply at least one setting to change.');
        return data.ga4UpdateEnhancedMeasurement(`${streamName(s(a.property), s(a.dataStreamId))}/enhancedMeasurementSettings`, mask, body);
      },
    },
    {
      name: 'update_ga4_data_redaction',
      description: "[GA4] Update a WEB data stream's client-side data redaction: email redaction and URL query-parameter redaction (with the parameter key list). Applies directly.",
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, dataStreamId: { type: 'string' }, emailRedactionEnabled: { type: 'boolean' }, queryParameterRedactionEnabled: { type: 'boolean' }, queryParameterKeys: { type: 'array', items: { type: 'string' }, description: 'Query params to redact, e.g. ["email", "phone"].' } }, required: ['property', 'dataStreamId'], additionalProperties: false },
      write: true,
      summarize: (a) => `Update data redaction on ${streamName(s(a.property), s(a.dataStreamId))}`,
      handler: (a) => {
        const body = pick(a, ['emailRedactionEnabled', 'queryParameterRedactionEnabled', 'queryParameterKeys']);
        const mask = Object.keys(body).join(',');
        if (!mask) throw new Error('update_ga4_data_redaction: supply at least one setting to change.');
        return data.ga4UpdateDataRedaction(`${streamName(s(a.property), s(a.dataStreamId))}/dataRedactionSettings`, mask, body);
      },
    },
    {
      name: 'update_ga4_attribution_settings',
      description: "[GA4] Update a property's attribution: reporting model, acquisition/other conversion lookback windows, and the Ads web-conversion export scope. Applies directly.",
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, reportingAttributionModel: { type: 'string', enum: ['PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN', 'PAID_AND_ORGANIC_CHANNELS_LAST_CLICK', 'GOOGLE_PAID_CHANNELS_LAST_CLICK'] }, acquisitionConversionEventLookbackWindow: { type: 'string', enum: ['ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS', 'ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS'] }, otherConversionEventLookbackWindow: { type: 'string', enum: ['OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS', 'OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_60_DAYS', 'OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS'] }, adsWebConversionDataExportScope: { type: 'string', enum: ['NOT_SELECTED_YET', 'PAID_AND_ORGANIC_CHANNELS', 'GOOGLE_PAID_CHANNELS'] } }, required: ['property'], additionalProperties: false },
      write: true,
      summarize: (a) => `Update attribution settings on ${propy(s(a.property))}`,
      handler: (a) => {
        const body = pick(a, ['reportingAttributionModel', 'acquisitionConversionEventLookbackWindow', 'otherConversionEventLookbackWindow', 'adsWebConversionDataExportScope']);
        const mask = Object.keys(body).join(',');
        if (!mask) throw new Error('update_ga4_attribution_settings: supply at least one setting to change.');
        return data.ga4UpdateAttribution(`${propy(s(a.property))}/attributionSettings`, mask, body);
      },
    },
    {
      name: 'update_ga4_google_signals',
      description: '[GA4] Turn Google Signals on or off for a property. Enabling activates cross-device + demographics data collection - the user must confirm their privacy disclosures cover it. Applies directly.',
      inputSchema: { type: 'object', properties: { property: { type: 'string' }, state: { type: 'string', enum: ['GOOGLE_SIGNALS_ENABLED', 'GOOGLE_SIGNALS_DISABLED'] } }, required: ['property', 'state'], additionalProperties: false },
      write: true,
      summarize: (a) => `Set Google Signals ${s(a.state) === 'GOOGLE_SIGNALS_ENABLED' ? 'ON' : 'OFF'} for ${propy(s(a.property))}`,
      handler: (a) => data.ga4UpdateGoogleSignals(`${propy(s(a.property))}/googleSignalsSettings`, 'state', { state: s(a.state) }),
    },
    {
      name: 'update_ga4_account',
      description: '[GA4] Rename a GA4 account (displayName). Applies directly.',
      inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, displayName: { type: 'string' } }, required: ['accountId', 'displayName'], additionalProperties: false },
      write: true,
      summarize: (a) => `Rename GA4 account ${prop(s(a.accountId))} to "${s(a.displayName)}"`,
      handler: (a) => data.ga4UpdateAccount(prop(s(a.accountId)), s(a.displayName)),
    },
    {
      name: 'delete_ga4_account',
      description: '[GA4] Soft-delete (trash) an entire GA4 account and all its properties. High blast radius. Destructive — two-step approval.',
      inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'], additionalProperties: false },
      write: true, destructive: true,
      summarize: (a) => `Trash GA4 account ${prop(s(a.accountId))} and ALL its properties`,
      handler: (a) => data.ga4DeleteAccount(prop(s(a.accountId))),
    }
  );

  return tools;
}
