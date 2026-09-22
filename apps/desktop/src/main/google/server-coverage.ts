// Pure engine: WEB GTM ↔ SERVER GTM coverage comparison (config-level, GTM API data only - no
// runtime logs). Answers: is every event the WEB container sends actually HANDLED by the server
// container, per destination?
//
// Honest semantics per platform:
//  - GA4 is all-or-nothing by design: a GA4 client claims EVERY incoming GA4 request and an active
//    relay tag forwards them, so web GA4 events are covered as a group once client + relay exist
//    (per-event server tags are not how sGTM GA4 works).
//  - CAPI destinations (Meta/TikTok/LinkedIn/Pinterest) ARE per-event: a server tag covers a web
//    pixel event only when a firing trigger matches that event name (or the tag fires on every
//    claimed event - an "all events" relay).
//  - A web pixel whose trigger is not a custom event (a click/scroll trigger) has no event NAME to
//    match; it is reported as NOT MATCHABLE rather than guessed, and excluded from the coverage %.
// The config comparison also checks the two things that silently kill a server setup: the web
// Google tag not pointing at the tagging server at all, and web/server GA4 Measurement ID mismatch.

import type { AuditTag, AuditTrigger, ContainerSnapshot, ServerContainerSnapshot } from './gtm-builders';
import {
  serverTagParam, googleTagConfigValue,
  isMetaCapiServerTag, isTikTokCapiServerTag, isSnapchatCapiServerTag, isMicrosoftCapiServerTag,
  isLinkedInCapiServerTag, isPinterestCapiServerTag, isRedditCapiServerTag, isAmazonCapiServerTag, isStackAdaptServerTag,
  isXCapiServerTag, isQuoraCapiServerTag, isAdRollCapiServerTag, isNextdoorCapiServerTag, isYelpCapiServerTag,
  isSpotifyCapiServerTag, isLineYahooCapiServerTag, isRtbHouseServerTag,
} from './gtm-builders';
import { resolveGa4MeasurementIds } from './gtm-ga4-check';

/** Every web-pixel platform the migration planner can port. Kept in step with SERVER_MIGRATION_HEURISTICS
 *  (gtm-builders) so a platform the planner offers is also one coverage can score. */
export type CoveragePlatform =
  | 'ga4' | 'meta' | 'tiktok' | 'linkedin' | 'pinterest'
  | 'snapchat' | 'microsoft' | 'reddit' | 'amazon' | 'stackadapt' | 'x'
  | 'quora' | 'adroll' | 'nextdoor' | 'yelp' | 'spotify' | 'lineyahoo' | 'rtbhouse'
  // Phase C analytics + Phase D affiliates: generic gallery-template migrations (no typed builder).
  | 'mixpanel' | 'matomo' | 'piwikpro' | 'piano' | 'plausible' | 'umami' | 'pirsch' | 'snowplow' | 'klaviyo'
  | 'awin' | 'cj' | 'impact' | 'rakuten' | 'shareasale' | 'tradedoubler' | 'webgains' | 'admitad'
  | 'adtraction' | 'affiliatefuture' | 'effinity' | 'refersion' | 'tapfiliate' | 'everflow' | 'voluum';

export interface ServerCoverageRow {
  platform: CoveragePlatform;
  /** The event name when extractable, else the web tag's name (status not_matchable). */
  event: string;
  webTag: string;
  status: 'covered' | 'missing' | 'not_matchable';
  /** What covers it (server tag / client names). */
  by?: string;
  recommendation?: string;
  /** For a MISSING CAPI event when a same-platform server tag exists: the clone source for the
   *  one-click create (credentials/variable refs come from the template; only the trigger is new). */
  template?: { tagId: string; name: string };
}

/**
 * A problem only visible with BOTH containers side by side.
 *
 * The server audit sees one container, so the worst failure in server-side tagging is invisible to
 * it: the web container still sending straight to a destination that the server is ALSO sending to.
 * Nothing is wrong in either container alone; the damage is in the pair.
 *
 * None of these is auto-fixable. Every remedy is a judgement call about which leg to keep, and
 * getting that wrong deletes real measurement.
 */
export interface CrossContainerFinding {
  severity: 'critical' | 'high' | 'medium';
  /** Stable id for the UI and tests. */
  checkId: 'web_server_ga4_parallel' | 'duplicate_web_ga4_config';
  message: string;
  recommendation: string;
  autoFixable: false;
}

export interface ServerCoverageReport {
  rows: ServerCoverageRow[];
  /** Problems that only exist in the WEB + SERVER pair (see CrossContainerFinding). */
  crossContainer: CrossContainerFinding[];
  /** ACTIVE server tags whose event condition matches no web event (candidates for cleanup). */
  unusedServer: Array<{ tag: string; platform: CoveragePlatform; event: string }>;
  ga4: {
    client: boolean;
    relay: boolean;
    webMeasurementIds: string[];
    serverMeasurementIds: string[];
    /** false when both sides resolved ids and they don't intersect. null = not comparable. */
    idsMatch: boolean | null;
  };
  /** Is the web Google tag pointed at the tagging server? */
  webWiring: { status: 'wired' | 'not_wired' | 'url_mismatch' | 'unknown'; webUrl: string; serverUrls: string[] };
  summary: { webEvents: number; covered: number; missing: number; notMatchable: number; coveragePct: number | null };
  score: {
    /** 100 minus weighted server-audit findings (25 critical / 10 high / 3 medium / 1 low), floored at 0. */
    configuration: number;
    /** The coverage % (null when nothing was matchable). */
    coverage: number | null;
    overall: number;
  };
}

const norm = (s: string): string => s.trim().toLowerCase();

/** First literal event-name condition ({{_event}} equals/contains X) on a trigger; null when none. */
function eventOfTrigger(tr: AuditTrigger | undefined): string | null {
  if (!tr) return null;
  for (const arr of [tr.customEventFilter, tr.filter]) {
    for (const f of arr ?? []) {
      const params = ((f as { parameter?: Array<{ key?: string; value?: unknown }> }).parameter) ?? [];
      const arg0 = String(params.find((p) => p.key === 'arg0')?.value ?? '');
      const arg1 = String(params.find((p) => p.key === 'arg1')?.value ?? '');
      const op = String((f as { type?: unknown }).type ?? '').toLowerCase();
      if (arg0 === '{{_event}}' && arg1 && !arg1.includes('{{') && (op === 'equals' || op === 'contains' || op === 'equalsignorecase')) return arg1;
    }
  }
  return null;
}

// ORDER MATTERS (first match wins): linkedin precedes snapchat because a LinkedIn Custom HTML snippet
// loads from snap.licdn.com, which a bare /snap/ would otherwise claim.
const PIXEL_SIGNS: Array<{ platform: Exclude<CoveragePlatform, 'ga4'>; nameRe: RegExp; bodyRe: RegExp }> = [
  { platform: 'meta', nameRe: /\bmeta\b|facebook|fb[\s_-]?pixel/i, bodyRe: /fbq\(|connect\.facebook\.net/i },
  { platform: 'tiktok', nameRe: /tiktok/i, bodyRe: /ttq\.|analytics\.tiktok\.com/i },
  { platform: 'linkedin', nameRe: /linkedin/i, bodyRe: /lintrk|snap\.licdn\.com/i },
  { platform: 'pinterest', nameRe: /pinterest/i, bodyRe: /pintrk/i },
  { platform: 'reddit', nameRe: /reddit/i, bodyRe: /rdt\(|redditstatic\.com/i },
  { platform: 'snapchat', nameRe: /snap(chat)?\b/i, bodyRe: /snaptr\(|sc-static\.net/i },
  { platform: 'microsoft', nameRe: /microsoft|bing|\buet\b/i, bodyRe: /bat\.bing\.com|uetq/i },
  { platform: 'amazon', nameRe: /amazon[\s_-]?(ads?|pixel|tag)/i, bodyRe: /amzn\(|amazon-adsystem/i },
  { platform: 'stackadapt', nameRe: /stackadapt/i, bodyRe: /saq\(|srv\.stackadapt/i },
  { platform: 'x', nameRe: /\btwitter\b|\bx[\s_-]?pixel\b/i, bodyRe: /twq\(|static\.ads-twitter/i },
  { platform: 'quora', nameRe: /quora/i, bodyRe: /\bqp\(|a\.quora\.com/i },
  { platform: 'adroll', nameRe: /adroll/i, bodyRe: /__adroll|s\.adroll\.com|adroll_adv_id/i },
  { platform: 'nextdoor', nameRe: /nextdoor/i, bodyRe: /\bndp\(|ads\.nextdoor\.com/i },
  { platform: 'yelp', nameRe: /\byelp\b/i, bodyRe: /yelp\.com\/ads|yelpads/i },
  { platform: 'spotify', nameRe: /spotify/i, bodyRe: /pixel\.spotify|ads\.spotify|spotify\.com\/pixel/i },
  { platform: 'lineyahoo', nameRe: /line[\s_-]?yahoo|yahoo[\s_-]?(ads|conversion)|\byjtag\b/i, bodyRe: /yjtag|s\.yimg\.jp\/wi\/ytag|yahoo_retargeting_id/i },
  { platform: 'rtbhouse', nameRe: /rtb\s*house|rtbhouse/i, bodyRe: /creativecdn\.com/i },
  // Phase C analytics (generic gallery-template migrations). Piwik PRO precedes Matomo: Matomo's old name is Piwik.
  { platform: 'piwikpro', nameRe: /piwik[\s_-]?pro/i, bodyRe: /containers\.piwik\.pro|piwik\.pro/i },
  { platform: 'matomo', nameRe: /matomo|piwik/i, bodyRe: /matomo|\b_paq\b|piwik\.(js|php)/i },
  { platform: 'mixpanel', nameRe: /mixpanel/i, bodyRe: /mixpanel/i },
  { platform: 'piano', nameRe: /piano\s*analytics|at[\s_-]?internet/i, bodyRe: /pa\.setConfigurations|pa-cd\.com|piano-analytics/i },
  { platform: 'plausible', nameRe: /plausible/i, bodyRe: /plausible\.io|data-domain=/i },
  { platform: 'umami', nameRe: /umami/i, bodyRe: /umami|data-website-id=/i },
  { platform: 'pirsch', nameRe: /pirsch/i, bodyRe: /pirsch\.io/i },
  { platform: 'snowplow', nameRe: /snowplow/i, bodyRe: /snowplow|newTracker\s*\(/i },
  { platform: 'klaviyo', nameRe: /klaviyo/i, bodyRe: /klaviyo\.com/i },
  // Phase D affiliate networks (generic).
  { platform: 'awin', nameRe: /\bawin\b/i, bodyRe: /dwin1\.com|awin1\.com/i },
  { platform: 'cj', nameRe: /commission\s*junction|\bcj\s*(tag|affiliate|pixel)/i, bodyRe: /mczbf\.com|emjcd\.com/i },
  { platform: 'impact', nameRe: /impact\s*radius|\bimpact\s*(affiliate|conversion|tag|pixel)/i, bodyRe: /impactcdn\.com|impactradius/i },
  { platform: 'rakuten', nameRe: /rakuten|linksynergy/i, bodyRe: /linksynergy|ranMID|rm_trans/i },
  { platform: 'shareasale', nameRe: /shareasale/i, bodyRe: /shareasale/i },
  { platform: 'tradedoubler', nameRe: /tradedoubler/i, bodyRe: /tradedoubler/i },
  { platform: 'webgains', nameRe: /webgains/i, bodyRe: /webgains|ITCVRQ/i },
  { platform: 'admitad', nameRe: /admitad/i, bodyRe: /admitad/i },
  { platform: 'adtraction', nameRe: /adtraction/i, bodyRe: /adtraction|ADT\.Tag/i },
  { platform: 'affiliatefuture', nameRe: /affiliate\s*future/i, bodyRe: /affiliatefuture/i },
  { platform: 'effinity', nameRe: /effinity|effiliation/i, bodyRe: /effiliation|effinity/i },
  { platform: 'refersion', nameRe: /refersion/i, bodyRe: /refersion|_rfsn/i },
  { platform: 'tapfiliate', nameRe: /tapfiliate/i, bodyRe: /tapfiliate/i },
  { platform: 'everflow', nameRe: /everflow/i, bodyRe: /everflow|\bEF\.(conversion|click)|_ef_transaction_id/i },
  { platform: 'voluum', nameRe: /voluum/i, bodyRe: /voluum/i },
];

/** Platform of a WEB tag: GA4 event tags by type; the built-in Microsoft UET (baut) and LinkedIn
 *  Insight (bzi) tags by their native type (authoritative); other vendor pixels by name or (for Custom
 *  HTML) body. */
function webPlatformOf(t: AuditTag): CoveragePlatform | null {
  if (t.type === 'gaawe') return 'ga4';
  if (t.type === 'gaawc' || t.type === 'googtag') return null; // config tags aren't events
  if (t.type === 'baut') return 'microsoft';
  if (t.type === 'bzi') return 'linkedin';
  const body = t.type === 'html' ? JSON.stringify(t.parameter ?? []) : '';
  for (const sign of PIXEL_SIGNS) {
    if (sign.nameRe.test(t.name) || (body && sign.bodyRe.test(body))) return sign.platform;
  }
  return null;
}

/** Platform of a SERVER tag: GA4 relay by type, CAPI templates by SHAPE (every recogniser the server
 *  audit has), else by name. */
function serverPlatformOf(t: AuditTag): CoveragePlatform | null {
  if (t.type === 'sgtmgaaw') return 'ga4';
  if (isMetaCapiServerTag(t)) return 'meta';
  if (isTikTokCapiServerTag(t)) return 'tiktok';
  if (isLinkedInCapiServerTag(t)) return 'linkedin';
  if (isPinterestCapiServerTag(t)) return 'pinterest';
  if (isRedditCapiServerTag(t)) return 'reddit';
  if (isSnapchatCapiServerTag(t)) return 'snapchat';
  if (isMicrosoftCapiServerTag(t)) return 'microsoft';
  if (isAmazonCapiServerTag(t)) return 'amazon';
  if (isStackAdaptServerTag(t)) return 'stackadapt';
  if (isXCapiServerTag(t)) return 'x';
  if (isQuoraCapiServerTag(t)) return 'quora';
  if (isAdRollCapiServerTag(t)) return 'adroll';
  if (isNextdoorCapiServerTag(t)) return 'nextdoor'; // before Yelp: both carry eventConversionType, only Nextdoor has pixelId + clientId
  if (isYelpCapiServerTag(t)) return 'yelp';
  if (isSpotifyCapiServerTag(t)) return 'spotify';
  if (isLineYahooCapiServerTag(t)) return 'lineyahoo';
  if (isRtbHouseServerTag(t)) return 'rtbhouse';
  for (const sign of PIXEL_SIGNS) if (sign.nameRe.test(t.name)) return sign.platform;
  return null;
}

/** The chat tool that builds each platform's server tag (every platform now has a typed builder). */
const CAPI_TOOL: Record<Exclude<CoveragePlatform, 'ga4'>, string> = {
  meta: 'create_meta_capi_server_tag',
  tiktok: 'create_tiktok_capi_server_tag',
  linkedin: 'create_linkedin_capi_server_tag',
  pinterest: 'create_pinterest_capi_server_tag',
  reddit: 'create_reddit_capi_server_tag',
  snapchat: 'create_snapchat_capi_server_tag',
  microsoft: 'create_microsoft_capi_server_tag',
  amazon: 'create_amazon_capi_server_tag',
  stackadapt: 'create_stackadapt_server_tag',
  x: 'create_x_capi_server_tag',
  quora: 'create_quora_capi_server_tag',
  adroll: 'create_adroll_capi_server_tag',
  nextdoor: 'create_nextdoor_capi_server_tag',
  yelp: 'create_yelp_capi_server_tag',
  spotify: 'create_spotify_capi_server_tag',
  lineyahoo: 'create_line_yahoo_capi_server_tag',
  rtbhouse: 'create_rtb_house_server_tag',
  // Generic gallery-template migrations (Phase C analytics + Phase D affiliates): no typed builder.
  mixpanel: 'import_gallery_template (stape-io/mixpanel-tag) + create_tag',
  matomo: 'import_gallery_template (stape-io/matomo-advanced-tag) + create_tag',
  piwikpro: 'import_gallery_template (stape-io/piwik-pro-tag) + create_tag',
  piano: 'import_gallery_template (stape-io/piano-tag) + create_tag',
  plausible: 'import_gallery_template (stape-io/plausible-analytics-tag-server) + create_tag',
  umami: 'import_gallery_template (stape-io/umami-tag-server) + create_tag',
  pirsch: 'import_gallery_template (stape-io/pirsch-tag-server) + create_tag',
  snowplow: 'import_gallery_template (stape-io/snowplow-gtm-server-side-tag) + create_tag',
  klaviyo: 'import_gallery_template (stape-io/klaviyo-tag) + create_tag',
  awin: 'import_gallery_template (stape-io/awin-conversion-api-tag) + create_tag',
  cj: 'import_gallery_template (stape-io/cj-tag) + create_tag',
  impact: 'import_gallery_template (stape-io/impact-tag) + create_tag',
  rakuten: 'import_gallery_template (stape-io/rakuten-tag) + create_tag',
  shareasale: 'import_gallery_template (stape-io/shareasale-tag) + create_tag',
  tradedoubler: 'import_gallery_template (stape-io/tradedoubler-tag) + create_tag',
  webgains: 'import_gallery_template (stape-io/webgains-tag) + create_tag',
  admitad: 'import_gallery_template (stape-io/admitad-tag) + create_tag',
  adtraction: 'import_gallery_template (stape-io/adtraction-tag) + create_tag',
  affiliatefuture: 'import_gallery_template (stape-io/affiliate-future-server-tag) + create_tag',
  effinity: 'import_gallery_template (stape-io/effinity-tag) + create_tag',
  refersion: 'import_gallery_template (stape-io/refersion-tag) + create_tag',
  tapfiliate: 'import_gallery_template (stape-io/tapfiliate-tag) + create_tag',
  everflow: 'import_gallery_template (stape-io/everflow-tag) + create_tag',
  voluum: 'import_gallery_template (stape-io/voluum-tag) + create_tag',
};

/** Configuration subscore from audit severity counts - the STATED formula (100 - 25/critical -
 *  10/high - 3/medium - 1/low, floored at 0). Shared with the documentation header. PURE. */
export function configurationScore(sm: { critical: number; high: number; medium: number; low: number }): number {
  return Math.max(0, 100 - 25 * sm.critical - 10 * sm.high - 3 * sm.medium - 1 * sm.low);
}

export function buildServerCoverage(
  web: ContainerSnapshot,
  server: ServerContainerSnapshot,
  serverAuditSummary: { critical: number; high: number; medium: number; low: number },
): ServerCoverageReport {
  const webTrig = new Map(web.triggers.map((t) => [t.triggerId, t]));
  const srvTrig = new Map((server.triggers ?? []).map((t) => [t.triggerId, t]));

  // ── Server capabilities ──
  const hasGa4Client = server.clients.some((c) => c.type === 'gaaw_client');
  const activeServerTags = server.tags.filter((t) => !t.paused && (t.firingTriggerId ?? []).length > 0);
  // A relay with a blank Measurement ID inherits it from the event: that is the recommended setup,
  // not a misconfiguration, so it counts as a relay. Its effective ids are whatever the web sends.
  const relays = activeServerTags.filter((t) => t.type === 'sgtmgaaw');
  const inheritingRelay = relays.some((t) => serverTagParam(t, 'measurementId').trim() === '');
  const ga4Covered = hasGa4Client && relays.length > 0;
  const ga4By = ga4Covered ? `client + relay "${relays[0].name}"` : undefined;

  // Per-platform server handlers: each with the set of event names it fires on ('*' = every claimed event).
  const serverHandlers: Array<{ platform: Exclude<CoveragePlatform, 'ga4'>; tag: string; events: string[] | '*' }> = [];
  for (const t of activeServerTags) {
    const platform = serverPlatformOf(t);
    if (!platform || platform === 'ga4') continue;
    const events = (t.firingTriggerId ?? []).map((id) => eventOfTrigger(srvTrig.get(id)));
    serverHandlers.push({ platform, tag: t.name, events: events.some((e) => e == null) ? '*' : (events.filter(Boolean) as string[]) });
  }
  const handlerFor = (platform: Exclude<CoveragePlatform, 'ga4'>, event: string | null): { tag: string } | 'all' | null => {
    for (const h of serverHandlers) {
      if (h.platform !== platform) continue;
      if (h.events === '*') return 'all';
      if (event && h.events.some((e) => norm(e) === norm(event))) return { tag: h.tag };
    }
    return null;
  };

  // ── Web events → coverage rows ──
  const rows: ServerCoverageRow[] = [];
  const webEventNamesByPlatform = new Map<string, Set<string>>();
  for (const t of web.tags) {
    if (t.paused) continue;
    const platform = webPlatformOf(t);
    if (!platform) continue;
    if (platform === 'ga4') {
      const event = serverTagParam(t, 'eventName').trim() || t.name;
      rows.push({
        platform,
        event,
        webTag: t.name,
        status: ga4Covered ? 'covered' : 'missing',
        ...(ga4Covered ? { by: ga4By } : { recommendation: 'Add a GA4 client + GA4 relay tag to the server container (the Server container tab can create both), then point the web Google tag at the tagging server.' }),
      });
      continue;
    }
    const event = (t.firingTriggerId ?? []).map((id) => eventOfTrigger(webTrig.get(id))).find(Boolean) ?? null;
    if (event) {
      const set = webEventNamesByPlatform.get(platform) ?? new Set<string>();
      set.add(norm(event));
      webEventNamesByPlatform.set(platform, set);
    }
    const hit = handlerFor(platform, event);
    // Clone source for the one-click create: any ACTIVE same-platform server tag (its credentials
    // and variable references carry over; only the firing trigger differs).
    const templateTag = !hit && event ? activeServerTags.find((st) => serverPlatformOf(st) === platform) : undefined;
    rows.push({
      platform,
      event: event ?? t.name,
      webTag: t.name,
      status: hit ? 'covered' : event ? 'missing' : 'not_matchable',
      ...(hit ? { by: hit === 'all' ? 'an all-events server tag' : `server tag "${hit.tag}"` } : {}),
      ...(!hit && event
        ? {
            recommendation: templateTag
              ? `No server tag handles "${event}" for ${platform}. Create one from "${templateTag.name}" (same credentials, new trigger).`
              : `No server tag handles "${event}" for ${platform}, and no ${platform} server tag exists to copy credentials from. Ask the chat: ${CAPI_TOOL[platform]} for this event.`,
          }
        : {}),
      ...(templateTag ? { template: { tagId: templateTag.tagId, name: templateTag.name } } : {}),
      ...(!hit && !event ? { recommendation: 'This pixel fires on a non-custom-event trigger, so there is no event name to match against server triggers - verify it manually (or route it through a named dataLayer event).' } : {}),
    });
  }

  // ── ACTIVE server CAPI tags no web event maps to (cleanup candidates, or server-only by design) ──
  const unusedServer: ServerCoverageReport['unusedServer'] = [];
  for (const h of serverHandlers) {
    if (h.events === '*') continue;
    const webSet = webEventNamesByPlatform.get(h.platform);
    for (const e of h.events) {
      if (!webSet || !webSet.has(norm(e))) unusedServer.push({ tag: h.tag, platform: h.platform, event: e });
    }
  }

  // ── Config comparison: Measurement IDs + web wiring ──
  const webIds = resolveGa4MeasurementIds(web).ids;
  const explicitServerIds = [...new Set(relays.map((t) => serverTagParam(t, 'measurementId').trim()).filter((v) => v && !v.includes('{{')))];
  // An inheriting relay forwards the web's own ids, so they are its effective server ids.
  const serverIds = inheritingRelay ? [...new Set([...explicitServerIds, ...webIds])] : explicitServerIds;
  const idsMatch = webIds.length && serverIds.length ? webIds.some((id) => serverIds.includes(id)) : null;

  const googleTag = web.tags.find((t) => (t.type === 'googtag' || t.type === 'gaawc') && !t.paused);
  const webUrl = googleTag ? googleTagConfigValue(googleTag as unknown as Record<string, unknown>, 'server_container_url').trim() : '';
  const host = (u: string): string => {
    try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
  };
  const serverUrls = server.taggingServerUrls ?? [];
  const wiring: ServerCoverageReport['webWiring'] = {
    status: !googleTag
      ? 'unknown'
      : !webUrl
        ? 'not_wired'
        : serverUrls.length === 0
          ? 'unknown'
          : serverUrls.some((u) => host(u) && host(u) === host(webUrl))
            ? 'wired'
            : 'url_mismatch',
    webUrl,
    serverUrls,
  };

  // ── Cross-container findings: what neither container reveals on its own ──
  const crossContainer: CrossContainerFinding[] = [];
  const sharedIds = webIds.filter((id) => serverIds.includes(id));
  // Google's own migration guidance is explicit that one property must not be fed by both the
  // browser and the server: doing so does not "add resilience", it counts everything twice.
  if (relays.length > 0 && sharedIds.length > 0 && (wiring.status === 'not_wired' || wiring.status === 'url_mismatch')) {
    const why = wiring.status === 'not_wired'
      ? 'the web Google tag has no server container URL, so it still sends straight to Google'
      : `the web Google tag points at ${wiring.webUrl || 'a different host'}, which is not this tagging server, so its hits never reach this container`;
    crossContainer.push({
      severity: 'critical',
      checkId: 'web_server_ga4_parallel',
      message: `The web container and this server container both send GA4 to ${sharedIds.join(', ')}, because ${why}. Every session, user and event in that property is counted twice.`,
      recommendation: 'Pick one sender per property. Either point the web Google tag at this tagging server so its hits flow through the server, or stop the server relay. While migrating, send the server copy to a SEPARATE property until the numbers match, rather than doubling a live one.',
      autoFixable: false,
    });
  }
  // A second Google tag for the same measurement ID re-initialises gtag WITHOUT the transport URL,
  // so a share of traffic silently bypasses the server even when the first tag is wired correctly.
  // This is one of the most common reasons a server container "only gets some of the traffic".
  const webConfigTags = web.tags.filter((t) => (t.type === 'googtag' || t.type === 'gaawc') && !t.paused);
  const byMeasurementId = new Map<string, Array<{ name: string; wired: boolean }>>();
  for (const t of webConfigTags) {
    const raw = t.type === 'googtag' ? serverTagParam(t, 'tagId') : serverTagParam(t, 'measurementId');
    const id = raw.trim();
    if (!id || id.includes('{{') || !/^G-/i.test(id)) continue;
    const wired = googleTagConfigValue(t as unknown as Record<string, unknown>, 'server_container_url').trim() !== '';
    const list = byMeasurementId.get(id) ?? [];
    list.push({ name: t.name, wired });
    byMeasurementId.set(id, list);
  }
  for (const [id, tags] of byMeasurementId) {
    if (tags.length < 2) continue;
    const unwired = tags.filter((t) => !t.wired);
    // Only worth reporting when at least one copy bypasses the server; two identically wired
    // configs are redundant but not a server-side data problem.
    if (unwired.length === 0) continue;
    crossContainer.push({
      severity: 'high',
      checkId: 'duplicate_web_ga4_config',
      message: `The web container has ${tags.length} active Google tag configurations for ${id}, and ${unwired.length} of them (${unwired.map((t) => `"${t.name}"`).join(', ')}) carry no server container URL. Whichever loads last decides where that page's hits go, so traffic bypasses this server container unpredictably.`,
      recommendation: 'Keep ONE Google tag configuration per measurement ID and set the server container URL on it. Delete or pause the duplicates, including any added by a CMS plugin or hard-coded gtag snippet.',
      autoFixable: false,
    });
  }

  // ── Summary + score ──
  const covered = rows.filter((r) => r.status === 'covered').length;
  const missing = rows.filter((r) => r.status === 'missing').length;
  const notMatchable = rows.filter((r) => r.status === 'not_matchable').length;
  const denom = covered + missing;
  const coveragePct = denom > 0 ? Math.round((covered / denom) * 1000) / 10 : null;
  const configuration = configurationScore(serverAuditSummary);
  const parts = [configuration, ...(coveragePct == null ? [] : [coveragePct])];
  const overall = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);

  return {
    rows,
    crossContainer,
    unusedServer,
    ga4: { client: hasGa4Client, relay: relays.length > 0, webMeasurementIds: webIds, serverMeasurementIds: serverIds, idsMatch },
    webWiring: wiring,
    summary: { webEvents: rows.length, covered, missing, notMatchable, coveragePct },
    score: { configuration, coverage: coveragePct, overall },
  };
}
