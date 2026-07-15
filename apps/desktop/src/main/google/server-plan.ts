// Pure engine: the SERVER-CONTAINER REMEDIATION PLAN. Audits the target server container (or a
// blank one, when creating fresh) against the web container and produces a categorized, selectable
// list of fixes: each item carries its status (existing / missing), category, dependencies, the
// config values it needs (with what was auto-detected), and whether it is selected by default.
// The executor (data-service.applyServerPlan) applies ONLY the selected items, idempotently.
//
// Honest boundaries: config-plane only (GTM API data). Meta + TikTok CAPI items are fully
// executable (their Stape-template builders auto-provision variables); LinkedIn / Pinterest items
// are PLANNED but marked chat-only (their builders need per-destination fields this form does not
// collect). Deep payload work (parameter mapping, transformations, consent mapping) is out of
// scope here and stays with the audit's findings.

import type { AuditTag, AuditTrigger, ContainerSnapshot, ServerContainerSnapshot } from './gtm-builders';
import { serverTagParam } from './gtm-builders';
import { resolveGa4MeasurementIds } from './gtm-ga4-check';

export type PlanCategory = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type PlanStatus = 'existing' | 'missing';

export interface ServerPlanItem {
  /** Stable id, also the executor's instruction (e.g. 'ga4_client', 'meta_capi:generate_lead'). */
  id: string;
  category: PlanCategory;
  status: PlanStatus;
  kind: 'client' | 'trigger' | 'tag' | 'variable' | 'builtin' | 'config';
  name: string;
  description: string;
  /** Item ids this fix depends on (the UI shows them; the executor orders by them). */
  dependsOn: string[];
  /** Config value keys this item needs (see ServerPlanValues); the UI collects the missing ones. */
  requires: string[];
  /** Pre-checked in the UI. Credential-gated items default OFF. */
  defaultSelected: boolean;
  /** True when the app can execute it; false = planned but done via chat (stated in description). */
  executable: boolean;
}

/** Config values the plan can use; `detected` carries what the audit already found. */
export interface ServerPlanValues {
  measurementId?: string;
  serverUrl?: string;
  metaPixelId?: string;
  metaAccessToken?: string;
  tiktokPixelId?: string;
  tiktokAccessToken?: string;
}

export interface ServerPlan {
  items: ServerPlanItem[];
  detected: { measurementId: string | null; serverUrl: string | null; webWiredUrl: string | null };
  /** The existing-asset inventory (the "what's already there" half of the audit). */
  inventory: {
    clients: Array<{ name: string; type: string }>;
    tags: Array<{ name: string; type: string; paused: boolean }>;
    triggers: Array<{ name: string; type: string }>;
    variables: Array<{ name: string; type: string }>;
    enabledBuiltIns: string[];
  };
}

const norm = (s: string): string => s.trim().toLowerCase();

/** First literal {{_event}} equals/contains condition on a trigger. */
function eventOfTrigger(tr: AuditTrigger | undefined): string | null {
  if (!tr) return null;
  for (const arr of [tr.customEventFilter, tr.filter]) {
    for (const f of arr ?? []) {
      const params = ((f as { parameter?: Array<{ key?: string; value?: unknown }> }).parameter) ?? [];
      const arg0 = String(params.find((p) => p.key === 'arg0')?.value ?? '');
      const arg1 = String(params.find((p) => p.key === 'arg1')?.value ?? '');
      if (arg0 === '{{_event}}' && arg1 && !arg1.includes('{{')) return arg1;
    }
  }
  return null;
}

const PIXEL_SIGNS: Array<{ platform: 'meta' | 'tiktok' | 'linkedin' | 'pinterest'; nameRe: RegExp; bodyRe: RegExp }> = [
  { platform: 'meta', nameRe: /\bmeta\b|facebook|fb[\s_-]?pixel/i, bodyRe: /fbq\(|connect\.facebook\.net/i },
  { platform: 'tiktok', nameRe: /tiktok/i, bodyRe: /ttq\.|analytics\.tiktok\.com/i },
  { platform: 'linkedin', nameRe: /linkedin/i, bodyRe: /lintrk|snap\.licdn\.com/i },
  { platform: 'pinterest', nameRe: /pinterest/i, bodyRe: /pintrk/i },
];

function webPixelPlatform(t: AuditTag): 'meta' | 'tiktok' | 'linkedin' | 'pinterest' | null {
  if (t.type === 'gaawe' || t.type === 'gaawc' || t.type === 'googtag') return null;
  const body = t.type === 'html' ? JSON.stringify(t.parameter ?? []) : '';
  for (const sign of PIXEL_SIGNS) if (sign.nameRe.test(t.name) || (body && sign.bodyRe.test(body))) return sign.platform;
  return null;
}

export interface ServerPlanInput {
  /** The web container snapshot (events, pixels, Google-tag wiring); null when unreadable. */
  web: ContainerSnapshot | null;
  /** The target server container; null = creating a brand-new one. */
  server: ServerContainerSnapshot | null;
  /** Enabled built-in variable TYPES in the server workspace (e.g. 'clientName'). */
  enabledBuiltIns: string[];
  /** The web container's derived GA4 Measurement ID (null = not derivable, ask the user). */
  derivedMeasurementId: string | null;
  /** server_container_url currently on the web Google tag ('' = none). */
  webGoogleTagServerUrl: string;
}

export function buildServerPlan(input: ServerPlanInput): ServerPlan {
  const s = input.server;
  const items: ServerPlanItem[] = [];
  const push = (i: ServerPlanItem): void => {
    items.push(i);
  };

  const clients = s?.clients ?? [];
  const tags = s?.tags ?? [];
  const triggers = s?.triggers ?? [];
  const variables = s?.variables ?? [];
  const hasGa4Client = clients.some((c) => c.type === 'gaaw_client');
  const hasGtmClient = clients.some((c) => c.type === 'gtm_client');
  const allEventsTrigger = triggers.find((t) => norm(t.name) === 'all events');
  const relay = tags.find((t) => t.type === 'sgtmgaaw' && !t.paused && serverTagParam(t, 'measurementId').trim() !== '');
  const hasVar = (name: string): boolean => variables.some((v) => norm(v.name) === norm(name));
  const clientNameEnabled = input.enabledBuiltIns.some((b) => norm(b) === 'clientname' || norm(b) === 'client name');
  const taggingUrls = s?.taggingServerUrls ?? [];

  // ── Baseline (the pieces a working sGTM setup cannot function without) ──
  push({
    id: 'ga4_client',
    category: hasGa4Client ? 'info' : 'critical',
    status: hasGa4Client ? 'existing' : 'missing',
    kind: 'client',
    name: 'GA4 client',
    description: hasGa4Client
      ? `Exists ("${clients.find((c) => c.type === 'gaaw_client')!.name}") - claims incoming GA4 requests.`
      : 'No GA4 client - nothing claims incoming requests, so no server tag can ever run.',
    dependsOn: [],
    requires: [],
    defaultSelected: !hasGa4Client,
    executable: true,
  });
  push({
    id: 'all_events_trigger',
    category: allEventsTrigger ? 'info' : 'high',
    status: allEventsTrigger ? 'existing' : 'missing',
    kind: 'trigger',
    name: 'All Events trigger',
    description: allEventsTrigger ? `Exists ("${allEventsTrigger.name}").` : 'Fires the GA4 relay on every event the GA4 client claims.',
    dependsOn: ['ga4_client'],
    requires: [],
    defaultSelected: !allEventsTrigger,
    executable: true,
  });
  push({
    id: 'ga4_relay',
    category: relay ? 'info' : 'high',
    status: relay ? 'existing' : 'missing',
    kind: 'tag',
    name: 'GA4 relay tag',
    description: relay
      ? `Exists ("${relay.name}" -> ${serverTagParam(relay, 'measurementId').trim()}).`
      : `Forwards claimed events to GA4${input.derivedMeasurementId ? ` (${input.derivedMeasurementId}, derived from the web container)` : ' - Measurement ID needed'}.`,
    dependsOn: ['ga4_client', 'all_events_trigger'],
    requires: input.derivedMeasurementId ? [] : ['measurementId'],
    defaultSelected: !relay,
    executable: true,
  });
  push({
    id: 'gtm_client',
    category: hasGtmClient ? 'info' : 'medium',
    status: hasGtmClient ? 'existing' : 'missing',
    kind: 'client',
    name: 'First-party GTM client',
    description: hasGtmClient
      ? `Exists ("${clients.find((c) => c.type === 'gtm_client')!.name}").`
      : 'Serves the web container FIRST-PARTY from your own domain (ad-blocker resilience).',
    dependsOn: [],
    requires: [],
    defaultSelected: !hasGtmClient,
    executable: true,
  });
  for (const v of ['ed - event_id', 'ed - page_location']) {
    const exists = hasVar(v);
    push({
      id: `var:${v}`,
      category: exists ? 'info' : 'low',
      status: exists ? 'existing' : 'missing',
      kind: 'variable',
      name: v,
      description: exists
        ? 'Exists.'
        : v === 'ed - event_id'
          ? 'Event Data variable - browser/server dedup id for CAPI destinations.'
          : 'Event Data variable - page-scoped conditions on server triggers.',
      dependsOn: [],
      requires: [],
      defaultSelected: !exists,
      executable: true,
    });
  }
  push({
    id: 'builtin_client_name',
    category: clientNameEnabled ? 'info' : 'low',
    status: clientNameEnabled ? 'existing' : 'missing',
    kind: 'builtin',
    name: 'Client Name built-in variable',
    description: clientNameEnabled ? 'Enabled.' : 'Needed by "{{Client Name}} equals GA4" trigger conditions.',
    dependsOn: [],
    requires: [],
    defaultSelected: !clientNameEnabled,
    executable: true,
  });
  const urlSet = taggingUrls.length > 0;
  push({
    id: 'tagging_url',
    category: urlSet ? 'info' : 'high',
    status: urlSet ? 'existing' : 'missing',
    kind: 'config',
    name: 'Tagging server URL',
    description: urlSet ? `Set (${taggingUrls.join(', ')}).` : 'Record the deployed host URL on the container (GTM does not deploy the host itself).',
    dependsOn: [],
    requires: urlSet ? [] : ['serverUrl'],
    defaultSelected: !urlSet,
    executable: true,
  });
  const wired = Boolean(input.webGoogleTagServerUrl);
  push({
    id: 'web_wiring',
    category: wired ? 'info' : 'high',
    status: wired ? 'existing' : 'missing',
    kind: 'config',
    name: 'Point the web Google tag at the server',
    description: wired
      ? `The web Google tag already sends to ${input.webGoogleTagServerUrl}.`
      : 'Sets server_container_url on the web Google tag so hits flow through your server.',
    dependsOn: ['tagging_url'],
    requires: wired ? [] : ['serverUrl'],
    defaultSelected: !wired,
    executable: true,
  });

  // ── CAPI destinations: one item per WEB pixel EVENT, per platform ──
  const webTrig = new Map((input.web?.triggers ?? []).map((t) => [t.triggerId, t]));
  const srvHandled = new Map<string, Set<string>>(); // platform -> covered event names
  for (const t of tags) {
    if (t.paused || !(t.firingTriggerId ?? []).length) continue;
    const platform = PIXEL_SIGNS.find((p) => p.nameRe.test(t.name))?.platform;
    if (!platform) continue;
    const set = srvHandled.get(platform) ?? new Set<string>();
    for (const id of t.firingTriggerId ?? []) {
      const ev = eventOfTrigger(triggers.find((x) => x.triggerId === id));
      if (ev) set.add(norm(ev));
    }
    srvHandled.set(platform, set);
  }
  const seen = new Set<string>();
  for (const t of input.web?.tags ?? []) {
    if (t.paused) continue;
    const platform = webPixelPlatform(t);
    if (!platform) continue;
    const event = (t.firingTriggerId ?? []).map((id) => eventOfTrigger(webTrig.get(id))).find(Boolean);
    if (!event) continue; // no event name to plan against (the coverage page explains these)
    const key = `${platform}:${norm(event)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const covered = srvHandled.get(platform)?.has(norm(event)) ?? false;
    const executable = platform === 'meta' || platform === 'tiktok';
    const requires = platform === 'meta' ? ['metaPixelId', 'metaAccessToken'] : platform === 'tiktok' ? ['tiktokPixelId', 'tiktokAccessToken'] : [];
    const label = platform === 'meta' ? 'Meta CAPI' : platform === 'tiktok' ? 'TikTok Events API' : platform === 'linkedin' ? 'LinkedIn CAPI' : 'Pinterest CAPI';
    push({
      id: `${platform}_capi:${event}`,
      category: covered ? 'info' : 'medium',
      status: covered ? 'existing' : 'missing',
      kind: 'tag',
      name: `${label} - ${event}`,
      description: covered
        ? 'A server tag already handles this event.'
        : executable
          ? `Server-side ${label} tag for "${event}" (web tag: "${t.name}"). Auto-provisions its match-quality variables.`
          : `Server-side ${label} tag for "${event}" - created via the chat (${platform === 'linkedin' ? 'create_linkedin_capi_server_tag' : 'create_pinterest_capi_server_tag'}), which collects this destination's own fields.`,
      dependsOn: ['ga4_client'],
      requires: covered ? [] : requires,
      defaultSelected: false, // credential-gated: never pre-checked
      executable: executable && !covered,
    });
  }

  // ── Detected values ──
  const webIds = input.web ? resolveGa4MeasurementIds(input.web).ids : [];
  return {
    items,
    detected: {
      measurementId: input.derivedMeasurementId ?? (webIds.length === 1 ? webIds[0] : null),
      serverUrl: taggingUrls[0] ?? null,
      webWiredUrl: input.webGoogleTagServerUrl || null,
    },
    inventory: {
      clients: clients.map((c) => ({ name: c.name, type: c.type })),
      tags: tags.map((t) => ({ name: t.name, type: t.type, paused: t.paused })),
      triggers: triggers.map((t) => ({ name: t.name, type: t.type })),
      variables: variables.map((v) => ({ name: v.name, type: v.type })),
      enabledBuiltIns: input.enabledBuiltIns,
    },
  };
}

/** Dependency readiness for the UI: which selected items still miss a dependency or a value. */
export function planReadiness(
  items: ServerPlanItem[],
  selected: Set<string>,
  values: ServerPlanValues,
): Array<{ id: string; missingDeps: string[]; missingValues: string[] }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const satisfied = (depId: string): boolean => {
    const dep = byId.get(depId);
    if (!dep) return true;
    return dep.status === 'existing' || selected.has(depId);
  };
  const out: Array<{ id: string; missingDeps: string[]; missingValues: string[] }> = [];
  for (const id of selected) {
    const item = byId.get(id);
    if (!item || item.status === 'existing') continue;
    const missingDeps = item.dependsOn.filter((d) => !satisfied(d));
    const missingValues = item.requires.filter((k) => !String((values as Record<string, unknown>)[k] ?? '').trim());
    if (missingDeps.length || missingValues.length) out.push({ id, missingDeps, missingValues });
  }
  return out;
}
