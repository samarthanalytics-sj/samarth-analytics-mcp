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
import { serverTagParam, isMetaCapiServerTag, isTikTokCapiServerTag, googleTagConfigValue } from './gtm-builders';
import { resolveGa4MeasurementIds } from './gtm-ga4-check';

export type CoveragePlatform = 'ga4' | 'meta' | 'tiktok' | 'linkedin' | 'pinterest';

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

export interface ServerCoverageReport {
  rows: ServerCoverageRow[];
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

const PIXEL_SIGNS: Array<{ platform: Exclude<CoveragePlatform, 'ga4'>; nameRe: RegExp; bodyRe: RegExp }> = [
  { platform: 'meta', nameRe: /\bmeta\b|facebook|fb[\s_-]?pixel/i, bodyRe: /fbq\(|connect\.facebook\.net/i },
  { platform: 'tiktok', nameRe: /tiktok/i, bodyRe: /ttq\.|analytics\.tiktok\.com/i },
  { platform: 'linkedin', nameRe: /linkedin/i, bodyRe: /lintrk|snap\.licdn\.com/i },
  { platform: 'pinterest', nameRe: /pinterest/i, bodyRe: /pintrk/i },
];

/** Platform of a WEB tag: GA4 event tags by type; vendor pixels by name or (for Custom HTML) body. */
function webPlatformOf(t: AuditTag): CoveragePlatform | null {
  if (t.type === 'gaawe') return 'ga4';
  if (t.type === 'gaawc' || t.type === 'googtag') return null; // config tags aren't events
  const body = t.type === 'html' ? JSON.stringify(t.parameter ?? []) : '';
  for (const sign of PIXEL_SIGNS) {
    if (sign.nameRe.test(t.name) || (body && sign.bodyRe.test(body))) return sign.platform;
  }
  return null;
}

/** Platform of a SERVER tag: GA4 relay by type, CAPI templates by shape, else by name. */
function serverPlatformOf(t: AuditTag): CoveragePlatform | null {
  if (t.type === 'sgtmgaaw') return 'ga4';
  if (isMetaCapiServerTag(t)) return 'meta';
  if (isTikTokCapiServerTag(t)) return 'tiktok';
  for (const sign of PIXEL_SIGNS) if (sign.nameRe.test(t.name)) return sign.platform;
  return null;
}

const CAPI_TOOL: Record<Exclude<CoveragePlatform, 'ga4'>, string> = {
  meta: 'create_meta_capi_server_tag',
  tiktok: 'create_tiktok_capi_server_tag',
  linkedin: 'create_linkedin_capi_server_tag',
  pinterest: 'create_pinterest_capi_server_tag',
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
  const relays = activeServerTags.filter((t) => t.type === 'sgtmgaaw' && serverTagParam(t, 'measurementId').trim() !== '');
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
  const serverIds = [...new Set(relays.map((t) => serverTagParam(t, 'measurementId').trim()).filter((v) => v && !v.includes('{{')))];
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
    unusedServer,
    ga4: { client: hasGa4Client, relay: relays.length > 0, webMeasurementIds: webIds, serverMeasurementIds: serverIds, idsMatch },
    webWiring: wiring,
    summary: { webEvents: rows.length, covered, missing, notMatchable, coveragePct },
    score: { configuration, coverage: coveragePct, overall },
  };
}
