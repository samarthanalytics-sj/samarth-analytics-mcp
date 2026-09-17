/**
 * The WEB → SERVER (sGTM) migration surface as MCP tools.
 *
 * Until this file existed the MCP server could not migrate a single pixel: the planner and every
 * CAPI server-tag builder lived only in the desktop app. They now live in src/shared/server-migration.ts
 * (E1 of the migration program) and this file registers them here (E2), so the hosted server and
 * Claude Desktop get the same capability the Electron app has.
 *
 *   - plan_server_migration_from_web  READ   which web tags can move, the tool that ports each, the
 *                                            public ids read off the web tag, the secrets still needed.
 *   - create_server_tag               WRITE  the NATIVE server tags: GA4 relay, Google Ads conversion /
 *                                            conversion linker / remarketing.
 *   - create_<vendor>_capi_server_tag WRITE  17 typed CAPI builders. Each imports its official gallery
 *                                            template itself (idempotently) and builds the tag from the
 *                                            template's verified field schema, gated on the platform's
 *                                            own credentials — never on another platform's.
 *
 * Guardrails are the standard ones: every write requires GTM_MCP_ENABLE_WRITES=true and confirm=true,
 * and lands in the DRAFT workspace; nothing here publishes.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { ensureGalleryTemplate } from './serverSide.js';
import type { GtmTagResource } from '../shared/gtm-builders.js';
import {
  planWebToServerMigration,
  type ContainerSnapshot,
  buildGa4ServerTag,
  buildAdsConversionServerTag,
  buildAdsConversionLinkerServerTag,
  buildAdsRemarketingServerTag,
  buildMetaCapiServerTag,
  buildTikTokCapiServerTag,
  buildLinkedInCapiServerTag,
  buildPinterestCapiServerTag,
  buildStackAdaptServerTag,
  buildRedditCapiServerTag,
  buildSnapchatCapiServerTag,
  buildMicrosoftCapiServerTag,
  buildAmazonCapiServerTag,
  buildXCapiServerTag,
  buildQuoraCapiServerTag,
  buildAdRollCapiServerTag,
  buildNextdoorCapiServerTag,
  buildYelpCapiServerTag,
  buildSpotifyCapiServerTag,
  buildLineYahooCapiServerTag,
  buildRtbHouseServerTag,
} from '../shared/server-migration.js';

const wsBase = z.object({
  accountId: z.string().describe('GTM account ID.'),
  containerId: z.string().describe('The SERVER container ID (for the plan tool: the WEB container).'),
  workspaceId: z.string().describe('Workspace ID.'),
});
const rowsSchema = z
  .array(z.object({ name: z.string(), value: z.string() }))
  .optional()
  .describe('Override rows {name, value}; names are the template\'s own field keys.');
const triggerSchema = z
  .array(z.string())
  .optional()
  .describe('SERVER trigger id(s) the tag fires on (triggers_create, type customEvent). Usually one.');

type Args = Record<string, unknown>;
type NV = Array<{ name: string; value: string }>;
const s = (v: unknown): string => (v == null ? '' : String(v));
const b = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const opt = (v: unknown): string | undefined => (v == null ? undefined : s(v));
const rows = (v: unknown): NV | undefined =>
  Array.isArray(v) ? (v as Array<{ name?: unknown; value?: unknown }>).map((r) => ({ name: s(r?.name), value: s(r?.value) })).filter((r) => r.name.trim()) : undefined;
const triggers = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.map(String) : undefined);
const parentOf = (a: Args): string => `accounts/${s(a.accountId)}/containers/${s(a.containerId)}/workspaces/${s(a.workspaceId)}`;

/** The web container as the planner reads it: tags / triggers / variables, every list paginated. */
async function loadContainerSnapshot(client: GtmClient, parent: string): Promise<{ snapshot: ContainerSnapshot; truncated: boolean }> {
  const ws = client.accounts.containers.workspaces;
  const [tagsP, triggersP, variablesP] = await Promise.all([
    paginate((t) => ws.tags.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.tag),
    paginate((t) => ws.triggers.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.trigger),
    paginate((t) => ws.variables.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.variable),
  ]);
  const raw = (x: unknown): Args => (x ?? {}) as Args;
  const params = (x: Args): Array<Record<string, unknown>> => (Array.isArray(x.parameter) ? (x.parameter as Array<Record<string, unknown>>) : []);
  const snapshot: ContainerSnapshot = {
    tags: (tagsP.items as unknown[]).map(raw).map((t) => ({
      tagId: s(t.tagId), name: s(t.name), type: s(t.type),
      firingTriggerId: Array.isArray(t.firingTriggerId) ? (t.firingTriggerId as string[]) : [],
      blockingTriggerId: Array.isArray(t.blockingTriggerId) ? (t.blockingTriggerId as string[]) : [],
      paused: Boolean(t.paused), parameter: params(t),
      ...(t.tagFiringOption ? { tagFiringOption: s(t.tagFiringOption) } : {}),
      consentSettings: (t.consentSettings as ContainerSnapshot['tags'][number]['consentSettings']) ?? null,
    })),
    triggers: (triggersP.items as unknown[]).map(raw).map((t) => ({
      triggerId: s(t.triggerId), name: s(t.name), type: s(t.type),
      filter: (t.filter as Array<Record<string, unknown>>) ?? [], autoEventFilter: (t.autoEventFilter as Array<Record<string, unknown>>) ?? [],
      customEventFilter: (t.customEventFilter as Array<Record<string, unknown>>) ?? [], parameter: params(t),
    })),
    variables: (variablesP.items as unknown[]).map(raw).map((v) => ({ variableId: s(v.variableId), name: s(v.name), type: s(v.type), parameter: params(v) })),
  };
  return { snapshot, truncated: Boolean(tagsP.truncated || triggersP.truncated || variablesP.truncated) };
}

async function createTag(client: GtmClient, parent: string, tag: GtmTagResource): Promise<unknown> {
  const res = await client.accounts.containers.workspaces.tags.create({ parent, requestBody: tag as unknown as Record<string, unknown> });
  return res.data;
}

/** One typed CAPI tool = its gallery template + the fields its builder needs + how to call the builder. */
interface CapiSpec {
  name: string;
  defaultTagName: string;
  gallery: [owner: string, repository: string];
  description: string;
  fields: z.ZodRawShape;
  /** Returns a refusal message when a required credential is missing, else null. */
  validate: (a: Args) => string | null;
  build: (type: string, name: string, a: Args, firingTriggerId?: string[]) => GtmTagResource;
}

const tokenDoc = (what: string): string => `${what}, usually a {{variable}} so it is not stored in plain text on the tag.`;
const need = (a: Args, key: string, what: string): string | null => (s(a[key]).trim() ? null : `${key} is required (${what}).`);
const firstMissing = (...checks: Array<string | null>): string | null => checks.find((c) => c != null) ?? null;

const CAPI_TOOLS: CapiSpec[] = [
  {
    name: 'create_meta_capi_server_tag', defaultTagName: 'Meta CAPI Tag', gallery: ['stape-io', 'facebook-tag'],
    description: 'Create a Meta Conversions API SERVER tag from the Stape template (stape-io/facebook-tag), imported automatically: the server counterpart of the Meta Pixel. pixelId is the Pixel ID (public, on the web pixel), accessToken the CAPI system-user token. `event` is the Meta event the tag sends (Purchase, Lead, a GA4 name is mapped, or a custom name). The template auto-maps user data (em/ph/external_id) and the event_id dedup key from the incoming event.',
    fields: { pixelId: z.string(), accessToken: z.string().describe(tokenDoc('Meta CAPI access token')), event: z.string().describe('Meta event, e.g. "Purchase" / "Lead", or a GA4 name.') },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the Meta Pixel ID'), need(a, 'accessToken', 'the CAPI access token'), need(a, 'event', 'the event to send')),
    build: (type, name, a, firingTriggerId) => buildMetaCapiServerTag(type, name, s(a.pixelId), s(a.accessToken), s(a.event), { firingTriggerId }),
  },
  {
    name: 'create_tiktok_capi_server_tag', defaultTagName: 'TikTok CAPI Tag', gallery: ['stape-io', 'tiktok-tag'],
    description: 'Create a TikTok Events API SERVER tag from the Stape template (stape-io/tiktok-tag), imported automatically. pixelId is the TikTok Pixel Code (public), accessToken the Events API token. `event` is the TikTok event (CompletePayment, SubmitForm, a GA4 name is mapped). User data, event properties and the event_id dedup key are auto-mapped from the incoming event.',
    fields: { pixelId: z.string().describe('TikTok Pixel Code.'), accessToken: z.string().describe(tokenDoc('TikTok Events API access token')), event: z.string() },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the TikTok Pixel Code'), need(a, 'accessToken', 'the Events API token'), need(a, 'event', 'the event to send')),
    build: (type, name, a, firingTriggerId) => buildTikTokCapiServerTag(type, name, s(a.pixelId), s(a.accessToken), s(a.event), { firingTriggerId }),
  },
  {
    name: 'create_linkedin_capi_server_tag', defaultTagName: 'LinkedIn CAPI Tag', gallery: ['stape-io', 'linkedin-tag'],
    description: 'Create a LinkedIn Conversions API SERVER tag from the Stape template (stape-io/linkedin-tag), imported automatically. LinkedIn CAPI fires on a CONVERSION RULE URN (urn:lla:llaPartnerConversion:…) from Campaign Manager, NOT the web Partner ID; the tag auto-maps user ids / user info / event data. eventId dedups against the Insight Tag.',
    fields: { accessToken: z.string().describe(tokenDoc('LinkedIn API access token')), conversionRuleUrn: z.string().describe('urn:lla:llaPartnerConversion:<id>'), eventId: z.string().optional(), userIds: rowsSchema, userInfo: rowsSchema, eventData: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'accessToken', 'the LinkedIn access token'), need(a, 'conversionRuleUrn', 'the conversion rule URN')),
    build: (type, name, a, firingTriggerId) => buildLinkedInCapiServerTag(type, name, s(a.accessToken), s(a.conversionRuleUrn), { eventId: opt(a.eventId), userIds: rows(a.userIds), userInfo: rows(a.userInfo), eventData: rows(a.eventData), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_pinterest_capi_server_tag', defaultTagName: 'Pinterest CAPI Tag', gallery: ['pinterest', 'ss-gtm-template'],
    description: 'Create a Pinterest Conversions API SERVER tag from the official template (pinterest/ss-gtm-template), imported automatically. advertiserId is the Pinterest Ad Account / tag id (public), apiAccessToken the Conversions API token. Omit `event` to inherit the incoming event name (auto-mapped); pass a Pinterest standard event (checkout, lead, signup, …) or a GA4 name to force one.',
    fields: { advertiserId: z.string(), apiAccessToken: z.string().describe(tokenDoc('Pinterest Conversions API token')), event: z.string().optional(), testMode: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'advertiserId', 'the Pinterest advertiser id'), need(a, 'apiAccessToken', 'the API access token')),
    build: (type, name, a, firingTriggerId) => buildPinterestCapiServerTag(type, name, s(a.advertiserId), s(a.apiAccessToken), { event: opt(a.event), testMode: b(a.testMode), firingTriggerId }),
  },
  {
    name: 'create_stackadapt_server_tag', defaultTagName: 'StackAdapt Server Tag', gallery: ['StackAdapt', 'stackadapt-gtm-server-side-pixel'],
    description: 'Create a StackAdapt SERVER pixel tag from the official template (StackAdapt/stackadapt-gtm-server-side-pixel), imported automatically. Not a CAPI: an id-only pixel (pixelID + pixelType rt/lal/conv/universal, default conv) with optional commonProperties (email/order_id/revenue/action…) and customProperties. No token, no event_id dedup.',
    fields: { pixelID: z.string(), pixelType: z.string().optional().describe('rt | lal | conv (default) | universal'), action: z.string().optional(), commonProperties: rowsSchema, customProperties: rowsSchema },
    validate: (a) => need(a, 'pixelID', 'the StackAdapt pixel id'),
    build: (type, name, a, firingTriggerId) => buildStackAdaptServerTag(type, name, s(a.pixelID), s(a.pixelType).trim() || 'conv', { action: opt(a.action), commonProperties: rows(a.commonProperties), customProperties: rows(a.customProperties), firingTriggerId }),
  },
  {
    name: 'create_reddit_capi_server_tag', defaultTagName: 'Reddit CAPI Tag', gallery: ['stape-io', 'reddit-tag'],
    description: 'Create a Reddit Conversions API SERVER tag from the Stape template (stape-io/reddit-tag), imported automatically. pixelId is the Reddit Pixel/Advertiser id (t2_/a2_, public), accessToken the Conversions Access Token. Omit `event` to inherit; pass a Reddit standard event (PAGE_VISIT/VIEW_CONTENT/SEARCH/ADD_TO_CART/ADD_TO_WISHLIST/PURCHASE/LEAD/SIGN_UP), a GA4 name, or a custom name. eventId is the conversion_id dedup row.',
    fields: { pixelId: z.string(), accessToken: z.string().describe(tokenDoc('Reddit Conversions access token')), event: z.string().optional(), eventId: z.string().optional(), testId: z.string().optional(), userData: rowsSchema, serverEventData: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the Reddit Pixel/Advertiser id'), need(a, 'accessToken', 'the Conversions access token')),
    build: (type, name, a, firingTriggerId) => buildRedditCapiServerTag(type, name, s(a.pixelId), s(a.accessToken), { event: opt(a.event), eventId: opt(a.eventId), testId: opt(a.testId), userData: rows(a.userData), serverEventData: rows(a.serverEventData), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_snapchat_capi_server_tag', defaultTagName: 'Snapchat CAPI Tag', gallery: ['Snapchat', 'capi-google-tag-manager-serverside-tag'],
    description: 'Create a Snapchat Conversions API SERVER tag from the official template (Snapchat/capi-google-tag-manager-serverside-tag), imported automatically. pixelId is the Snap Pixel ID (public), apiAccessToken the CAPI token. `event` is the Snap event (PURCHASE, SIGN_UP, a GA4 name is mapped). eventId dedups against the Snap Pixel.',
    fields: { pixelId: z.string(), apiAccessToken: z.string().describe(tokenDoc('Snapchat CAPI access token')), event: z.string(), eventId: z.string().optional(), actionSource: z.string().optional(), testId: z.string().optional(), userData: rowsSchema, customData: rowsSchema, serverData: rowsSchema },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the Snap Pixel ID'), need(a, 'apiAccessToken', 'the CAPI access token'), need(a, 'event', 'the event to send')),
    build: (type, name, a, firingTriggerId) => buildSnapchatCapiServerTag(type, name, s(a.pixelId), s(a.apiAccessToken), s(a.event), { eventId: opt(a.eventId), actionSource: opt(a.actionSource), testId: opt(a.testId), userData: rows(a.userData), customData: rows(a.customData), serverData: rows(a.serverData), firingTriggerId }),
  },
  {
    name: 'create_microsoft_capi_server_tag', defaultTagName: 'Microsoft Ads CAPI Tag', gallery: ['stape-io', 'microsoft-capi-tag'],
    description: 'Create a Microsoft Ads (Bing) UET Conversions API SERVER tag from the Stape template (stape-io/microsoft-capi-tag), imported automatically. uetTagId is the UET Tag ID (public; the built-in web tag stores it as tagId), authToken the API token. `event` is the conversion goal / GA4 name. REQUIRES the MSCLKID to be forwarded from the web side for attribution.',
    fields: { uetTagId: z.string(), authToken: z.string().describe(tokenDoc('Microsoft Ads CAPI API token')), event: z.string(), eventId: z.string().optional(), userData: rowsSchema, eventData: rowsSchema, serverData: rowsSchema, autoMap: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'uetTagId', 'the UET Tag ID'), need(a, 'authToken', 'the API token'), need(a, 'event', 'the event to send')),
    build: (type, name, a, firingTriggerId) => buildMicrosoftCapiServerTag(type, name, s(a.uetTagId), s(a.authToken), s(a.event), { eventId: opt(a.eventId), userData: rows(a.userData), eventData: rows(a.eventData), serverData: rows(a.serverData), autoMap: b(a.autoMap), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_amazon_capi_server_tag', defaultTagName: 'Amazon Ads CAPI Tag', gallery: ['stape-io', 'amazon-tag'],
    description: 'Create an Amazon Ads Conversions API SERVER tag from the Stape template (stape-io/amazon-tag), imported automatically. No token: the only credential is tagIds (the Amazon Ads Tag UUIDs) plus tagRegion (NA | EU). Omit `event` to inherit; pass an Amazon standard event (Off-AmazonPurchases, Lead, …) or a GA4 name. eventId is the clientDedupeId dedup row.',
    fields: { tagIds: z.array(z.string()).describe('Amazon Ads Tag ID(s), UUIDs.'), tagRegion: z.string().optional().describe('NA (default) | EU'), event: z.string().optional(), eventId: z.string().optional(), enableAdvancedMatching: z.boolean().optional(), userData: rowsSchema, customAttributes: rowsSchema },
    validate: (a) => (Array.isArray(a.tagIds) && (a.tagIds as unknown[]).some((t) => s(t).trim()) ? null : 'tagIds is required (at least one Amazon Ads Tag ID).'),
    build: (type, name, a, firingTriggerId) => buildAmazonCapiServerTag(type, name, (a.tagIds as unknown[]).map(String).filter((t) => t.trim()), s(a.tagRegion).trim() || 'NA', { event: opt(a.event), eventId: opt(a.eventId), enableAdvancedMatching: b(a.enableAdvancedMatching), userData: rows(a.userData), customAttributes: rows(a.customAttributes), firingTriggerId }),
  },
  {
    name: 'create_x_capi_server_tag', defaultTagName: 'X CAPI Tag', gallery: ['stape-io', 'twitter-tag'],
    description: 'Create an X (Twitter) Conversion API SERVER tag from the Stape template (stape-io/twitter-tag), imported automatically. The template has NO event-name field: eventId is the per-conversion X "Event ID" (tw-…) from X Ads > Events Manager, so one tag = one X conversion event and the server trigger decides when it fires. Auth is EITHER pixelAccessToken OR the OAuth 1.0a quartet. conversionId is the dedup row against the X Pixel.',
    fields: { pixelId: z.string().describe('X Pixel ID (public).'), eventId: z.string().describe('X conversion Event ID (tw-…).'), pixelAccessToken: z.string().optional(), consumerKey: z.string().optional(), consumerSecret: z.string().optional(), oauthToken: z.string().optional(), oauthTokenSecret: z.string().optional(), conversionId: z.string().optional(), serverEventData: rowsSchema, userData: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => {
      const base = firstMissing(need(a, 'pixelId', 'the X Pixel ID'), need(a, 'eventId', 'the X conversion Event ID, tw-…'));
      if (base) return base;
      const oauth = ['consumerKey', 'consumerSecret', 'oauthToken', 'oauthTokenSecret'].every((k) => s(a[k]).trim());
      return s(a.pixelAccessToken).trim() || oauth ? null : 'Auth is required: pass pixelAccessToken, OR all four of consumerKey/consumerSecret/oauthToken/oauthTokenSecret.';
    },
    build: (type, name, a, firingTriggerId) => buildXCapiServerTag(type, name, s(a.pixelId), s(a.eventId), { pixelAccessToken: opt(a.pixelAccessToken), consumerKey: opt(a.consumerKey), consumerSecret: opt(a.consumerSecret), oauthToken: opt(a.oauthToken), oauthTokenSecret: opt(a.oauthTokenSecret) }, { conversionId: opt(a.conversionId), serverEventData: rows(a.serverEventData), userData: rows(a.userData), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_quora_capi_server_tag', defaultTagName: 'Quora CAPI Tag', gallery: ['stape-io', 'quora-tag'],
    description: 'Create a Quora Conversion API SERVER tag from the Stape template (stape-io/quora-tag), imported automatically. pixelId is the Quora Pixel ID (stored in the template\'s accountId field), accessToken the Quora API token. Omit `event` to inherit; Quora has NO custom event, so an unknown name becomes Generic. eventId is the dedup row.',
    fields: { pixelId: z.string(), accessToken: z.string().describe(tokenDoc('Quora API access token')), event: z.string().optional(), eventId: z.string().optional(), conversionData: rowsSchema, deviceEventData: rowsSchema, userData: rowsSchema, optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the Quora Pixel ID'), need(a, 'accessToken', 'the Quora API token')),
    build: (type, name, a, firingTriggerId) => buildQuoraCapiServerTag(type, name, s(a.pixelId), s(a.accessToken), { event: opt(a.event), eventId: opt(a.eventId), conversionData: rows(a.conversionData), deviceEventData: rows(a.deviceEventData), userData: rows(a.userData), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_adroll_capi_server_tag', defaultTagName: 'AdRoll CAPI Tag', gallery: ['stape-io', 'adroll-tag'],
    description: 'Create an AdRoll SERVER tag from the Stape template (stape-io/adroll-tag), imported automatically. Needs advertisableId AND pixelId (both public, on the web snippet as adroll_adv_id / adroll_pix_id) plus an accessToken. Omit `event` to inherit; pageView/productSearch/addToCart/purchase or a GA4 name are standard, anything else is a custom event.',
    fields: { advertisableId: z.string(), pixelId: z.string(), accessToken: z.string().describe(tokenDoc('AdRoll access token')), event: z.string().optional(), testMode: z.boolean().optional(), serverData: rowsSchema, userData: rowsSchema, customData: rowsSchema, optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'advertisableId', 'adroll_adv_id'), need(a, 'pixelId', 'adroll_pix_id'), need(a, 'accessToken', 'the AdRoll access token')),
    build: (type, name, a, firingTriggerId) => buildAdRollCapiServerTag(type, name, s(a.advertisableId), s(a.pixelId), s(a.accessToken), { event: opt(a.event), testMode: b(a.testMode), serverData: rows(a.serverData), userData: rows(a.userData), customData: rows(a.customData), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_nextdoor_capi_server_tag', defaultTagName: 'Nextdoor CAPI Tag', gallery: ['stape-io', 'nextdoor-tag'],
    description: 'Create a Nextdoor Conversion API SERVER tag from the Stape template (stape-io/nextdoor-tag), imported automatically. Needs pixelId (public) plus clientId and accessToken from Nextdoor Ads. Omit `event` to inherit; conversion/lead/purchase/sign_up/custom_conversion_1..10 or a GA4 name are standard. eventId is the dedup row.',
    fields: { pixelId: z.string(), clientId: z.string(), accessToken: z.string().describe(tokenDoc('Nextdoor access token')), event: z.string().optional(), eventId: z.string().optional(), conversionType: z.string().optional(), appId: z.string().optional(), testEvent: z.string().optional(), serverData: rowsSchema, userData: rowsSchema, customData: rowsSchema, optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'pixelId', 'the Nextdoor Pixel ID'), need(a, 'clientId', 'the Nextdoor Client ID'), need(a, 'accessToken', 'the Nextdoor access token')),
    build: (type, name, a, firingTriggerId) => buildNextdoorCapiServerTag(type, name, s(a.pixelId), s(a.clientId), s(a.accessToken), { event: opt(a.event), eventId: opt(a.eventId), conversionType: opt(a.conversionType), appId: opt(a.appId), testEvent: opt(a.testEvent), serverData: rows(a.serverData), userData: rows(a.userData), customData: rows(a.customData), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_yelp_capi_server_tag', defaultTagName: 'Yelp CAPI Tag', gallery: ['stape-io', 'yelp-tag'],
    description: 'Create a Yelp Conversion API SERVER tag from the Stape template (stape-io/yelp-tag), imported automatically. Yelp has no pixel id: only the accessToken from Yelp Ads. Omit `event` to inherit; purchase/add_to_cart/checkout/lead/view_content/signup/… or a GA4 name are standard. eventId is the dedup row; validate runs Yelp\'s payload validation.',
    fields: { accessToken: z.string().describe(tokenDoc('Yelp Ads access token')), event: z.string().optional(), eventId: z.string().optional(), conversionType: z.string().optional(), validate: z.boolean().optional(), serverData: rowsSchema, userData: rowsSchema, customData: rowsSchema, optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => need(a, 'accessToken', 'the Yelp Ads access token'),
    build: (type, name, a, firingTriggerId) => buildYelpCapiServerTag(type, name, s(a.accessToken), { event: opt(a.event), eventId: opt(a.eventId), conversionType: opt(a.conversionType), validate: b(a.validate), serverData: rows(a.serverData), userData: rows(a.userData), customData: rows(a.customData), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_spotify_capi_server_tag', defaultTagName: 'Spotify CAPI Tag', gallery: ['stape-io', 'spotify-tag'],
    description: 'Create a Spotify Ads Conversion API SERVER tag from the Stape template (stape-io/spotify-tag), imported automatically. Needs authToken and connectionId. Omit `event` to inherit; Page_View/Sign_Up/Lead/View_Product/Add_Cart/Start_Checkout/Purchase or a GA4 name are standard, custom_event_1..5 are the only custom slots (anything else inherits). eventId is the dedup row.',
    fields: { authToken: z.string().describe(tokenDoc('Spotify Ads authentication token')), connectionId: z.string(), event: z.string().optional(), eventId: z.string().optional(), actionSource: z.string().optional(), optOutTargeting: z.boolean().optional(), serverEventData: rowsSchema, eventDetails: rowsSchema, userData: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'authToken', 'the Spotify Ads auth token'), need(a, 'connectionId', 'the Spotify Ads Connection ID')),
    build: (type, name, a, firingTriggerId) => buildSpotifyCapiServerTag(type, name, s(a.authToken), s(a.connectionId), { event: opt(a.event), eventId: opt(a.eventId), actionSource: opt(a.actionSource), optOutTargeting: b(a.optOutTargeting), serverEventData: rows(a.serverEventData), eventDetails: rows(a.eventDetails), userData: rows(a.userData), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_line_yahoo_capi_server_tag', defaultTagName: 'LINE Yahoo CAPI Tag', gallery: ['stape-io', 'line-yahoo-tag'],
    description: 'Create a LINE Yahoo (Yahoo! JAPAN Ads) Conversion API SERVER tag from the Stape template (stape-io/line-yahoo-tag), imported automatically. Needs the Yahoo tagId (public), accessToken and channelId. Omit `event` to inherit; Yahoo has NO custom events (unknown names inherit). Every event other than page_view needs its own eventSnippetId from Yahoo Ads. transactionId is the dedup row.',
    fields: { tagId: z.string(), accessToken: z.string().describe(tokenDoc('Yahoo Ads tag access token')), channelId: z.string(), event: z.string().optional(), eventSnippetId: z.string().optional(), transactionId: z.string().optional(), testMode: z.boolean().optional(), serverEventData: rowsSchema, userIdentifiers: rowsSchema, webParameters: rowsSchema, eventParameters: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'tagId', 'the Yahoo Tag ID'), need(a, 'accessToken', 'the Yahoo Ads access token'), need(a, 'channelId', 'the Yahoo Ads Channel ID')),
    build: (type, name, a, firingTriggerId) => buildLineYahooCapiServerTag(type, name, s(a.tagId), s(a.accessToken), s(a.channelId), { event: opt(a.event), eventSnippetId: opt(a.eventSnippetId), transactionId: opt(a.transactionId), testMode: b(a.testMode), serverEventData: rows(a.serverEventData), userIdentifiers: rows(a.userIdentifiers), webParameters: rows(a.webParameters), eventParameters: rows(a.eventParameters), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
  {
    name: 'create_rtb_house_server_tag', defaultTagName: 'RTB House Server Tag', gallery: ['stape-io', 'rtb-house-tag'],
    description: 'Create an RTB House SERVER tag from the Stape template (stape-io/rtb-house-tag), imported automatically. A retargeting tag with NO token: needs the taggingHash (public, the id in the creativecdn.com pixel URL) and the partnerKey. Its events are PAGE TYPES, so `event` is required: home/listing/offer/wishlist/basketadd/basketstatus/startorder/conversion_order/conversion or a GA4 name (page_view→home, view_item→offer, add_to_cart→basketadd, purchase→conversion_order, …).',
    fields: { taggingHash: z.string(), partnerKey: z.string().describe(tokenDoc('RTB House partner key')), event: z.string(), region: z.string().optional().describe('us (default) | ams | asia'), orderId: z.string().optional(), orderValue: z.string().optional(), productIds: z.string().optional(), categoryId: z.string().optional(), conversionId: z.string().optional(), conversionValue: z.string().optional(), serverEventData: rowsSchema, autoMap: z.boolean().optional(), optimistic: z.boolean().optional(), requireConsent: z.boolean().optional() },
    validate: (a) => firstMissing(need(a, 'taggingHash', 'the RTB House tagging hash'), need(a, 'partnerKey', 'the RTB House partner key'), need(a, 'event', 'a page type or GA4 name')),
    build: (type, name, a, firingTriggerId) => buildRtbHouseServerTag(type, name, s(a.taggingHash), s(a.partnerKey), { event: s(a.event), region: opt(a.region), orderId: opt(a.orderId), orderValue: opt(a.orderValue), productIds: opt(a.productIds), categoryId: opt(a.categoryId), conversionId: opt(a.conversionId), conversionValue: opt(a.conversionValue), serverEventData: rows(a.serverEventData), autoMap: b(a.autoMap), optimistic: b(a.optimistic), requireConsent: b(a.requireConsent), firingTriggerId }),
  },
];

export function registerServerMigrationTools(server: McpServer, getClient: () => GtmClient): void {
  // ── The plan: READ-ONLY ──
  server.registerTool(
    'plan_server_migration_from_web',
    {
      description:
        'READ-ONLY: given a WEB container, list every tag that can move to a SERVER container and the plan to port each: ' +
        'which server tool builds it (the create_*_capi_server_tag / create_server_tag tools here), the public ids read off the ' +
        'web tag (`derived` - Pixel IDs from template params or the fbq/ttq/pintrk/rdt/snaptr/uet/twq init calls, so the server ' +
        'tag is created pre-filled), and the secrets you must still ask the user for (`requires` - CAPI access tokens are never in ' +
        'a web container). Creates NOTHING. GA4 is reported once in `ga4` (port it with create_server_tag platform "ga4" as the ' +
        'relay, or the setup_server_side_container prompt); Google Ads conversion (awct) / remarketing (sp) -> create_server_tag; ' +
        'Meta/TikTok/LinkedIn/Pinterest/Reddit/Snapchat/Microsoft/Amazon/StackAdapt/X/Quora/AdRoll/Nextdoor/Yelp/Spotify/' +
        'LINE Yahoo/RTB House pixels -> their typed tool (native Microsoft UET `baut` and LinkedIn Insight `bzi` tags are ' +
        'recognised by type); Floodlight (flc) -> generic import path; Google Ads call conversion has no sGTM equivalent; ' +
        'Conversion Linker (gclidw) needs no server tag. Returns { ga4, items[], summary, truncated }.',
      inputSchema: wsBase,
    },
    async (args) => {
      try {
        const client = getClient();
        const { snapshot, truncated } = await loadContainerSnapshot(client, parentOf(args as Args));
        const plan = planWebToServerMigration(snapshot);
        return jsonResult({
          ...plan,
          truncated,
          ...(truncated ? { warning: 'One of the workspace lists hit the page ceiling; the plan may be incomplete.' } : {}),
          note: 'Every server tag needs a SERVER trigger: create it with triggers_create (type customEvent, {{_event}} equals <event>) and pass its id as firingTriggerId.',
        });
      } catch (err) {
        return errorResult('plan_server_migration_from_web', err);
      }
    },
  );

  // ── Native Google server tags ──
  server.registerTool(
    'create_server_tag',
    {
      description:
        '[WRITE] Create a NATIVE Google server tag in a SERVER container workspace, built with the correct shape: platform "ga4" = the ' +
        'GA4 relay (sgtmgaaw; omit eventName to relay every incoming event, pass one for a per-event tag; optional eventParameters / ' +
        'userProperties enrichment rows), "ads_conversion" = Google Ads conversion (sgtmadsct; conversionId + conversionLabel), ' +
        '"ads_conversion_linker" = the server Conversion Linker (sgtmadscl), "ads_remarketing" = Google Ads remarketing (sgtmadsremarket; ' +
        'conversionId). Pass the SERVER trigger id(s) as firingTriggerId. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Tag name.'),
        platform: z.enum(['ga4', 'ads_conversion', 'ads_conversion_linker', 'ads_remarketing']),
        measurementId: z.string().optional().describe('For ga4: the G- Measurement ID or a {{variable}}.'),
        eventName: z.string().optional().describe('For ga4: a literal event name for a per-event tag; omit to relay every event.'),
        conversionId: z.string().optional().describe('For ads_conversion / ads_remarketing: the Ads Conversion ID (AW- prefix is stripped).'),
        conversionLabel: z.string().optional().describe('For ads_conversion: the Conversion Label.'),
        productReporting: z.boolean().optional().describe('For ads_conversion: enable product reporting (ecommerce only).'),
        eventParameters: rowsSchema,
        userProperties: rowsSchema,
        firingTriggerId: triggerSchema,
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async (args) => {
      const a = args as Args;
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', Boolean(a.confirm), config);
        const name = s(a.name).trim();
        const platform = s(a.platform);
        const firing = triggers(a.firingTriggerId);
        let tag: GtmTagResource;
        if (platform === 'ga4') {
          if (!s(a.measurementId).trim()) return textResult(`Not creating "${name}": platform "ga4" needs measurementId.`);
          tag = buildGa4ServerTag(name, s(a.measurementId), opt(a.eventName), firing, { eventParameters: rows(a.eventParameters), userProperties: rows(a.userProperties) });
        } else if (platform === 'ads_conversion') {
          if (!s(a.conversionId).trim() || !s(a.conversionLabel).trim()) return textResult(`Not creating "${name}": platform "ads_conversion" needs conversionId AND conversionLabel.`);
          tag = buildAdsConversionServerTag(name, s(a.conversionId), s(a.conversionLabel), firing, b(a.productReporting));
        } else if (platform === 'ads_conversion_linker') {
          tag = buildAdsConversionLinkerServerTag(name, firing);
        } else {
          if (!s(a.conversionId).trim()) return textResult(`Not creating "${name}": platform "ads_remarketing" needs conversionId.`);
          tag = buildAdsRemarketingServerTag(name, s(a.conversionId), firing);
        }
        if (dryRun) return jsonResult({ dryRun: true, wouldCreate: tag });
        const created = await createTag(getClient(), parentOf(a), tag);
        return jsonResult({ created, note: 'Created in the DRAFT workspace; not published.' });
      } catch (err) {
        return errorResult('create_server_tag', err);
      }
    },
  );

  // ── The typed CAPI tools, one per vendor, all the same flow ──
  for (const spec of CAPI_TOOLS) {
    server.registerTool(
      spec.name,
      {
        description: `[WRITE] ${spec.description} containerId must be the SERVER container. Needs a SERVER trigger (triggers_create) passed as firingTriggerId. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: wsBase.extend({
          name: z.string().optional().describe(`Tag name; defaults to "${spec.defaultTagName}".`),
          ...spec.fields,
          firingTriggerId: triggerSchema,
          confirm: z.boolean().describe('Must be true to confirm this write operation.'),
        }),
      },
      async (args) => {
        const a = args as Args;
        try {
          const config = getGuardrailConfig();
          const { dryRun } = checkGuardrails('write', Boolean(a.confirm), config);
          const refusal = spec.validate(a);
          const name = s(a.name).trim() || spec.defaultTagName;
          if (refusal) return textResult(`Not creating "${name}": ${refusal}`);
          const [owner, repository] = spec.gallery;
          if (dryRun) {
            return jsonResult({ dryRun: true, wouldImportTemplate: `${owner}/${repository}`, wouldCreate: spec.build('cvt_<template>', name, a, triggers(a.firingTriggerId)) });
          }
          const client = getClient();
          const parent = parentOf(a);
          const { tagType, imported } = await ensureGalleryTemplate(client, parent, s(a.containerId), owner, repository);
          const tag = spec.build(tagType, name, a, triggers(a.firingTriggerId));
          const created = await createTag(client, parent, tag);
          return jsonResult({
            created,
            template: { gallery: `${owner}/${repository}`, tagType, imported },
            note: 'Created in the DRAFT workspace; not published. Verify with the server container\'s Preview.',
          });
        } catch (err) {
          return errorResult(spec.name, err);
        }
      },
    );
  }
}

/** The tool names this module registers (for the contract / count tests). */
export const SERVER_MIGRATION_TOOL_NAMES: readonly string[] = ['plan_server_migration_from_web', 'create_server_tag', ...CAPI_TOOLS.map((t) => t.name)];
