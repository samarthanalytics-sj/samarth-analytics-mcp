import { tagmanager } from '@googleapis/tagmanager';
import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { OAuth2Client } from 'google-auth-library';
import type { AccountClientManager } from './account-clients';
import type { RegistryService } from '../services/registry-service';
import type { ContainerSnapshot, ServerContainerSnapshot } from './gtm-builders';
import { applyTriggerWaitDefaults, buildEnvironmentSnippet, normalizeTimerTrigger, normalizeCustomEventTrigger, setCustomEventName, customEventNameOf, buildGa4Client, buildGa4ServerTag, buildServerAllEventsTrigger, buildServerEventTrigger, buildAdsConversionServerTag, buildMetaEmqVariables, buildTikTokEmqVariables, buildEcommerceDlvVariables, buildGa4EventTag, buildTrigger, planTriggerRetarget, type TriggerInput, buildGtmClient, buildVariable, sanitizeName, matchesServerContainer, customTemplateType, upsertGoogleTagConfig, triggerUsageBreakdown, detectMetaTags, evaluateTrackingSetup, GA4_ECOMMERCE_FUNNEL_EVENTS, type TrackingSetupReport, type TrackingSetupCheck } from './gtm-builders';
import { resolveGa4MeasurementIds } from './gtm-ga4-check';
import { withQuotaRetry } from './quota-retry';

import type { Ga4PropertySnapshot } from './ga4-audit';
import type { DataQualityCounts } from './ga4-data-quality';
import { windowDates } from './ga4-data-quality';
import type { Ga4CampaignInput } from './ga4-campaigns';
import type { Ga4EventDeltaInput, Ga4TransactionInput } from './ga4-integrity';
import { planRetentionCohorts, parseRetentionRows, type RetentionCohort } from './ga4-retention';
import { mergeParametersByKey, addEventParameters, addServerGa4Params, setTemplateParam, type GtmParam } from './tag-params';
import { changeJournal, type EntityKind } from './change-journal';
import type { Ga4AccountView, Ga4PropertyListItem, GtmAccountView } from '../../shared/ipc';

// Follows nextPageToken so large containers/accounts return EVERY item, not just
// the first API page. Without this, big workspaces silently truncate (and audits
// under-count).
async function collectPages<P, T>(
  fetchPage: (pageToken?: string) => Promise<P>,
  getItems: (page: P) => T[] | undefined,
  getToken: (page: P) => string | null | undefined
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    out.push(...(getItems(page) ?? []));
    const next = getToken(page);
    token = next ? next : undefined;
  } while (token);
  return out;
}

// Minimal structural shapes of the GTM v2 resource fields the snapshot reads.
// Schema$Tag/Trigger/Variable are structural supertypes of these, so the raw
// API arrays (from list pages OR a published version) assign here directly.
interface RawTag {
  tagId?: string | null;
  name?: string | null;
  type?: string | null;
  firingTriggerId?: string[] | null;
  blockingTriggerId?: string[] | null;
  paused?: boolean | null;
  parameter?: unknown;
  consentSettings?: unknown;
}
interface RawTrigger {
  triggerId?: string | null;
  name?: string | null;
  type?: string | null;
  filter?: unknown;
  autoEventFilter?: unknown;
  customEventFilter?: unknown;
  parameter?: unknown;
}
interface RawVariable {
  variableId?: string | null;
  name?: string | null;
  type?: string | null;
  parameter?: unknown;
}

const asList = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

/** Project a Measurement Protocol secret to the SAFE shape — displayName ONLY.
 *  Exported + pure so the "never return the secret value" guarantee is locked by
 *  a unit test at the layer where it actually executes, not just via a fake. */
export function toSafeMpSecret(s: { displayName?: string | null }): { displayName: string } {
  return { displayName: s.displayName ?? '(unnamed)' };
}

// Single source of truth for the audit/monitor snapshot shape, so the draft
// workspace and the published live version map IDENTICALLY (the drift diff
// depends on byte-for-byte comparable fingerprints).
function toSnapshot(tags: RawTag[], triggers: RawTrigger[], variables: RawVariable[]): ContainerSnapshot {
  return {
    tags: tags.map((t) => ({
      tagId: t.tagId ?? '',
      name: t.name ?? '(unnamed)',
      type: t.type ?? '',
      firingTriggerId: t.firingTriggerId ?? [],
      blockingTriggerId: t.blockingTriggerId ?? [],
      paused: t.paused ?? false,
      parameter: asList(t.parameter),
      consentSettings: (t.consentSettings ?? null) as { consentStatus?: string; consentType?: unknown } | null,
    })),
    triggers: triggers.map((t) => ({
      triggerId: t.triggerId ?? '',
      name: t.name ?? '(unnamed)',
      type: t.type ?? '',
      filter: asList(t.filter),
      autoEventFilter: asList(t.autoEventFilter),
      customEventFilter: asList(t.customEventFilter),
      parameter: asList(t.parameter),
    })),
    variables: variables.map((v) => ({
      variableId: v.variableId ?? '',
      name: v.name ?? '(unnamed)',
      type: v.type ?? '',
      parameter: asList(v.parameter),
    })),
  };
}

export interface GtmContainerView {
  containerId: string;
  name: string;
  publicId: string;
  path: string;
}

export interface Ga4PropertyView {
  property: string;
  displayName: string;
}

/** Traffic baseline for the GA4 audit report — current window vs the immediately-prior window. */
export interface Ga4Baseline {
  startDate: string;
  endDate: string;
  priorStartDate: string;
  priorEndDate: string;
  sessions: number;
  priorSessions: number;
  /** Key-event (conversion) count — window and prior — so growth can be correlated with outcomes. */
  keyEvents: number;
  priorKeyEvents: number;
  /** Total revenue — window and prior — for the same correlation. */
  revenue: number;
  priorRevenue: number;
  /** Engagement (attention) figures for the baseline block: average engagement time per session in
   *  SECONDS (userEngagementDuration/sessions — active foreground time, excludes idle, unlike session
   *  duration), the engaged-session rate (0-1), and engaged sessions per active user. 0 if unavailable. */
  avgEngagementSec: number;
  engagementRate: number;
  engagedSessionsPerUser: number;
  /** % change vs the prior period (rounded); null if the prior period had no sessions. */
  trendPct: number | null;
  /** Highest-session day in the window (GA4 "date" = YYYYMMDD); null if no data. */
  peakDay: { date: string; sessions: number } | null;
  /** Sessions per day across the window, in chronological order — the daily trend line. */
  dailySessions: Array<{ date: string; sessions: number }>;
  /** Channel mix ON the peak day, to attribute a spike to a platform (null if no clear peak). */
  peakDayChannels: Array<{ name: string; sessions: number }> | null;
  /** Top channels' daily sessions, aligned to the dailySessions date axis — the per-channel line chart. */
  channelDaily: Array<{ channel: string; series: Array<{ date: string; sessions: number }> }>;
  devices: Array<{ name: string; sessions: number }>;
  newVsReturning: Array<{ name: string; sessions: number }>;
  topCountries: Array<{ name: string; sessions: number }>;
  /** Per-channel PERFORMANCE (not just session share): sessions, key events, session conversion rate
   *  (0-1), revenue, engagement rate (0-1) — the "which channels actually convert/earn" table. Top by
   *  sessions. Empty if the query failed. */
  channelPerformance: Array<{ channel: string; sessions: number; keyEvents: number; convRate: number; revenue: number; engagementRate: number }>;
  /** Top LANDING PAGES by entry sessions: session conversion rate, revenue, engagement rate (0-1) —
   *  "which entry pages convert and which leak". Uses the `landingPage` dimension (path only — GA4
   *  strips the query string) so entry pages aggregate cleanly instead of fragmenting across ?utm=
   *  variants. Empty if the query failed. */
  landingPages: Array<{ page: string; sessions: number; keyEvents: number; convRate: number; revenue: number; engagementRate: number }>;
  /** Per-DEVICE performance (deviceCategory): sessions, key events, session conversion rate (0-1),
   *  revenue, engagement rate (0-1) — "how each device type converts and spends". Empty if failed. */
  devicePerformance: Array<{ device: string; sessions: number; keyEvents: number; convRate: number; revenue: number; engagementRate: number }>;
  /** Top MARKETS performance (country): same shape — "which geographies convert and spend". Top by
   *  sessions. Empty if the query failed. */
  geoPerformance: Array<{ country: string; sessions: number; keyEvents: number; convRate: number; revenue: number; engagementRate: number }>;
  /** Per-AI/LLM-source referral performance (sessions, key events, session conversion rate (0-1),
   *  revenue, engagement rate (0-1)) — "which AI assistants send traffic that converts and earns".
   *  Matched on exact sessionSource hosts. A systematic undercount (referrer-stripped visits land in
   *  Direct). Empty if the query failed or the site has no AI referrals. */
  llmTraffic: Array<{ source: string; sessions: number; keyEvents: number; convRate: number; revenue: number; engagementRate: number }>;
  /** Ecommerce funnel step reach — distinct USERS who fired each canonical funnel event (view_item →
   *  add_to_cart → begin_checkout → purchase), in order. Queried with a server-side inListFilter, so
   *  `users` is 0 only when that event genuinely has no reach (never a top-N truncation artifact). This
   *  is an event-COVERAGE approximation (each step counts users independently, no order enforced), not a
   *  strict sequential funnel; the report labels it as such and omits it when there is no view_item. */
  funnelSteps: Array<{ event: string; users: number }>;
}

export interface GtmWorkspaceView {
  workspaceId: string;
  name: string;
  path: string;
}

export interface GtmFolderView {
  folderId: string;
  name: string;
  path: string;
}

export interface GtmEnvironmentView {
  environmentId: string;
  name: string;
  type: string;
  /** The gtm_auth token (USER environments). Empty for built-in types that don't expose it. */
  authorizationCode: string;
  url: string;
  /** Ready-to-paste install snippet for this environment (head <script> + body <noscript>). */
  snippet: { head: string; body: string };
}

export interface GtmTagView {
  tagId: string;
  name: string;
  type: string;
}

export interface Ga4DataStreamView {
  name: string;
  displayName: string;
  type: string;
}

export interface Ga4ReportResult {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Array<{ dimensions: string[]; metrics: string[] }>;
}

// Read-only GTM/GA4 fetches for the ACTIVE account, using the small per-API
// @googleapis packages. This proves the vaulted token reaches the real APIs and
// is the seam the GTM/GA4 UI views read from. (The full MCP tool surface is
// wired in Phase 4 with the LLM.)
export class GoogleDataService {
  constructor(
    private readonly registry: RegistryService,
    private readonly clients: AccountClientManager
  ) {}

  private activeAuth(): OAuth2Client {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect a Google account first.');
    if (!active.hasGoogleToken) {
      throw new Error('The active account is not signed in to Google.');
    }
    return this.clients.getClient(active.id);
  }

  async listGtmAccounts(): Promise<GtmAccountView[]> {
    // Cast at the boundary: @googleapis/* bundle their own google-auth-library
    // types, so our OAuth2Client is a structural-but-not-nominal match.
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    try {
      const accounts = await collectPages(
        (pageToken) => gtm.accounts.list({ pageToken }),
        (r) => r.data.account,
        (r) => r.data.nextPageToken
      );
      const views = accounts.map((a) => ({
        accountId: a.accountId ?? '',
        name: a.name ?? '(unnamed)',
        path: a.path ?? '',
      }));
      console.log('[gtm-accounts] %d account(s): %s', views.length, views.map((a) => `${a.name}(${a.accountId})`).join(', ') || '—');
      return views;
    } catch (e) {
      console.error('[gtm-accounts] FAILED: %s', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async listGtmContainers(accountId: string): Promise<GtmContainerView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    try {
      const containers = await collectPages(
        (pageToken) => gtm.accounts.containers.list({ parent: `accounts/${accountId}`, pageToken }),
        (r) => r.data.container,
        (r) => r.data.nextPageToken
      );
      const views = containers.map((c) => ({
        containerId: c.containerId ?? '',
        name: c.name ?? '(unnamed)',
        publicId: c.publicId ?? '',
        path: c.path ?? '',
      }));
      console.log('[gtm-containers] account %s: %d container(s): %s', accountId, views.length, views.map((c) => `${c.name}${c.publicId ? ' ' + c.publicId : ''}`).join(', ') || '—');
      return views;
    } catch (e) {
      console.error('[gtm-containers] account %s FAILED: %s', accountId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async listGa4Accounts(): Promise<Ga4AccountView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const summaries = await collectPages(
      (pageToken) => admin.accountSummaries.list({ pageSize: 200, pageToken }),
      (r) => r.data.accountSummaries,
      (r) => r.data.nextPageToken
    );
    return summaries.map((s) => ({
      account: s.account ?? '',
      displayName: s.displayName ?? '(unnamed)',
      propertyCount: (s.propertySummaries ?? []).length,
    }));
  }

  /** Every GA4 property the active user can reach (id + name + parent-account name), built from
   *  accountSummaries in ONE call — each summary already carries its propertySummaries, so there's
   *  no per-account fan-out. For the GA4 Audit panel's picker. A failure propagates (not swallowed),
   *  so the panel can distinguish "no access" from "no properties". */
  async listGa4PropertySummaries(): Promise<Ga4PropertyListItem[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const summaries = await collectPages(
      (pageToken) => admin.accountSummaries.list({ pageSize: 200, pageToken }),
      (r) => r.data.accountSummaries,
      (r) => r.data.nextPageToken
    );
    return summaries
      .flatMap((s) =>
        (s.propertySummaries ?? []).map((p) => ({
          property: p.property ?? '',
          displayName: p.displayName ?? '(unnamed)',
          accountName: s.displayName ?? '(unnamed)',
        }))
      )
      .filter((p) => p.property);
  }

  async listGa4Properties(account: string): Promise<Ga4PropertyView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const properties = await collectPages(
      (pageToken) => admin.properties.list({ filter: `parent:${account}`, pageToken }),
      (r) => r.data.properties,
      (r) => r.data.nextPageToken
    );
    return properties.map((p) => ({
      property: p.name ?? '',
      displayName: p.displayName ?? '(unnamed)',
    }));
  }

  async listGtmWorkspaces(accountId: string, containerId: string): Promise<GtmWorkspaceView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}`;
    try {
      const workspaces = await collectPages(
        (pageToken) => gtm.accounts.containers.workspaces.list({ parent, pageToken }),
        (r) => r.data.workspace,
        (r) => r.data.nextPageToken
      );
      const views = workspaces.map((w) => ({
        workspaceId: w.workspaceId ?? '',
        name: w.name ?? '(unnamed)',
        path: w.path ?? '',
      }));
      console.log('[gtm-workspaces] account %s container %s: %d workspace(s): %s', accountId, containerId, views.length, views.map((w) => `${w.name}(${w.workspaceId})`).join(', ') || '—');
      return views;
    } catch (e) {
      console.error('[gtm-workspaces] account %s container %s FAILED: %s', accountId, containerId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** List the folders in a workspace. (The GTM API DOES expose this — folders.list.) */
  async listGtmFolders(accountId: string, containerId: string, workspaceId: string): Promise<GtmFolderView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const folders = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.folders.list({ parent, pageToken }),
      (r) => r.data.folder,
      (r) => r.data.nextPageToken
    );
    return folders.map((f) => ({ folderId: f.folderId ?? '', name: f.name ?? '(unnamed)', path: f.path ?? '' }));
  }

  /** The container's public id (GTM-XXXXXX) — needed to build install snippets. */
  async getContainerPublicId(accountId: string, containerId: string): Promise<string> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.get({ path: `accounts/${accountId}/containers/${containerId}` });
    return res.data.publicId ?? '';
  }

  /** List the container's environments (incl. their gtm_auth token + a ready install snippet). */
  async listGtmEnvironments(accountId: string, containerId: string): Promise<GtmEnvironmentView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}`;
    const [publicId, environments] = await Promise.all([
      this.getContainerPublicId(accountId, containerId),
      collectPages(
        (pageToken) => gtm.accounts.containers.environments.list({ parent, pageToken }),
        (r) => r.data.environment,
        (r) => r.data.nextPageToken
      ),
    ]);
    return environments.map((e) => ({
      environmentId: e.environmentId ?? '',
      name: e.name ?? '(unnamed)',
      type: e.type ?? '',
      authorizationCode: e.authorizationCode ?? '',
      url: e.url ?? '',
      snippet: buildEnvironmentSnippet(publicId, e.authorizationCode ?? '', e.environmentId ?? ''),
    }));
  }

  /** Create a USER environment (e.g. "Test") and return it WITH the install snippet. */
  async createGtmEnvironment(
    accountId: string,
    containerId: string,
    name: string,
    opts?: { url?: string; enableDebug?: boolean; description?: string }
  ): Promise<GtmEnvironmentView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const [publicId, res] = await Promise.all([
      this.getContainerPublicId(accountId, containerId),
      gtm.accounts.containers.environments.create({
        parent: `accounts/${accountId}/containers/${containerId}`,
        requestBody: {
          name,
          type: 'user',
          ...(opts?.url ? { url: opts.url } : {}),
          ...(opts?.enableDebug !== undefined ? { enableDebug: opts.enableDebug } : {}),
          ...(opts?.description ? { description: opts.description } : {}),
        },
      }),
    ]);
    let e = res.data;
    // A freshly created environment may come back without its gtm_auth token — generate it
    // so the returned snippet is immediately usable (the whole point of this tool).
    if (!e.authorizationCode && e.environmentId) {
      const re = await gtm.accounts.containers.environments.reauthorize({
        path: `accounts/${accountId}/containers/${containerId}/environments/${e.environmentId}`,
        requestBody: {},
      });
      e = re.data;
    }
    return {
      environmentId: e.environmentId ?? '',
      name: e.name ?? name,
      type: e.type ?? 'user',
      authorizationCode: e.authorizationCode ?? '',
      url: e.url ?? '',
      snippet: buildEnvironmentSnippet(publicId, e.authorizationCode ?? '', e.environmentId ?? ''),
    };
  }

  /**
   * Auto-mint a WORKSPACE-PREVIEW install snippet so a scan can load the workspace's
   * DRAFT tags (for "Verify firing") without the user pasting anything. It:
   *   1. creates a container VERSION from the workspace (a snapshot — NOT published),
   *   2. binds a reusable "Samarth Verify (auto)" user environment to that version
   *      (created + reauthorized once, updated on later runs),
   *   3. returns that environment's preview snippet (carries gtm_auth/gtm_preview).
   * Draft-level writes only; nothing is ever published.
   */
  async mintWorkspacePreview(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ snippet: string; versionId: string; environmentName: string; newWorkspaceId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const containerParent = `accounts/${accountId}/containers/${containerId}`;

    // 1. Snapshot the workspace into a version (not published). This needs the
    //    tagmanager.edit.containerversions scope — which the app DOES request, but a
    //    Google connection saved BEFORE that scope was added carries a token without
    //    it and 403s. Translate that into an actionable "re-connect Google" message
    //    instead of a raw Gaxios stack.
    let cv: { data: { containerVersion?: { containerVersionId?: string | null } | null; compilerError?: unknown; newWorkspacePath?: string | null } } | null = null;
    try {
      cv = await gtm.accounts.containers.workspaces.create_version({
        path: `${containerParent}/workspaces/${workspaceId}`,
        requestBody: { name: 'Samarth Verify (auto)', notes: 'Auto-created to verify tag firing in Preview. Not published.' },
      });
    } catch (err) {
      const code = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
      if (code === 403) {
        throw new Error(
          'Auto preview needs the GTM "edit container versions" permission. The app requests it, but this Google connection was saved before that scope was added, so its token lacks it. Fix: Settings → Disconnect Google, then re-connect and approve the new permission on Google\'s consent screen, then retry. Or paste a GTM Preview / Environment snippet instead (no re-connect needed). If it still fails, your Google account may lack edit rights on this container.'
        );
      }
      const emsg =
        (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ??
        (err as { message?: string }).message ?? String(err);
      // A workspace that has ALREADY been submitted (a version was created from it) can't be versioned
      // again — but its tags are already in the latest version, so we skip create_version and preview
      // that existing version (via the built-in "Latest" environment) instead of hard-failing.
      if (/already submitted/i.test(emsg)) {
        cv = null;
      } else {
        throw err;
      }
    }
    let versionId = '';
    if (cv) {
      versionId = cv.data.containerVersion?.containerVersionId ?? '';
      if (!versionId) {
        throw new Error(
          cv.data.compilerError
            ? 'The workspace has a compiler error, so a preview version could not be created. Fix the container in GTM, then retry.'
            : 'Could not create a container version from the workspace (nothing to version, or a GTM error).'
        );
      }
    }

    // 2. Read the built-in "Latest" preview environment — it auto-tracks the newest
    //    version (the one we just created), and reading it needs only a READ scope.
    //    We deliberately do NOT create/reauthorize an environment: that needs the
    //    publish scope, which this app never requests.
    const [publicId, environments] = await Promise.all([
      this.getContainerPublicId(accountId, containerId),
      collectPages(
        (pageToken) => gtm.accounts.containers.environments.list({ parent: containerParent, pageToken }),
        (r) => r.data.environment,
        (r) => r.data.nextPageToken
      ),
    ]);
    const latest = environments.find((e) => e.type === 'latest' && e.authorizationCode && e.environmentId);
    if (!latest?.authorizationCode || !latest.environmentId) {
      throw new Error(
        'The built-in "Latest" preview environment has no readable auth token (minting one would need the publish scope, which this app never requests). Paste a GTM Preview / Environment snippet instead.'
      );
    }
    // create_version SUBMITS the workspace (it becomes read-only) and GTM auto-creates a fresh editable
    // workspace based on the new version — its path is returned here. Surface its id so the caller can
    // switch the active workspace to it; otherwise the next write fails "already submitted". (Empty in
    // the already-submitted recovery path, where we didn't create a version.)
    const newWorkspaceId = cv ? (cv.data.newWorkspacePath ?? '').split('/').pop() ?? '' : '';
    return {
      snippet: buildEnvironmentSnippet(publicId, latest.authorizationCode, latest.environmentId).head,
      versionId,
      environmentName: latest.name ?? 'Latest',
      newWorkspaceId,
    };
  }

  async listGtmTags(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<GtmTagView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const tags = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.tags.list({ parent, pageToken }),
      (r) => r.data.tag,
      (r) => r.data.nextPageToken
    );
    return tags.map((t) => ({
      tagId: t.tagId ?? '',
      name: t.name ?? '(unnamed)',
      type: t.type ?? '',
    }));
  }

  async listGa4DataStreams(property: string): Promise<Ga4DataStreamView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const streams = await collectPages(
      (pageToken) => admin.properties.dataStreams.list({ parent: property, pageToken }),
      (r) => r.data.dataStreams,
      (r) => r.data.nextPageToken
    );
    return streams.map((s) => ({
      name: s.name ?? '',
      displayName: s.displayName ?? '(unnamed)',
      type: s.type ?? '',
    }));
  }

  /** Full GA4 property configuration for an audit (read-only): property details,
   *  data-retention, key events, custom dimensions/metrics, data streams (with
   *  per-web-stream enhanced-measurement state), and Google Ads link count.
   *  Optional sub-resources are best-effort so one missing scope/permission
   *  doesn't sink the whole audit; the core property + streams reads propagate. */
  async getGa4PropertySnapshot(property: string): Promise<Ga4PropertySnapshot> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });

    const [prop, retention, keyEvents, customDimensions, customMetrics, streams, adsLinks] = await Promise.all([
      admin.properties.get({ name: property }),
      admin.properties.getDataRetentionSettings({ name: `${property}/dataRetentionSettings` }).catch(() => null),
      // null on catch (not []) so the audit can tell "unreadable" from "zero".
      collectPages(
        (pageToken) => admin.properties.keyEvents.list({ parent: property, pageToken }),
        (r) => r.data.keyEvents,
        (r) => r.data.nextPageToken
      ).catch((): Array<{ eventName?: string | null }> | null => null),
      collectPages(
        (pageToken) => admin.properties.customDimensions.list({ parent: property, pageToken }),
        (r) => r.data.customDimensions,
        (r) => r.data.nextPageToken
      ).catch((): Array<{ parameterName?: string | null; displayName?: string | null; scope?: string | null }> | null => null),
      collectPages(
        (pageToken) => admin.properties.customMetrics.list({ parent: property, pageToken }),
        (r) => r.data.customMetrics,
        (r) => r.data.nextPageToken
      ).catch((): Array<{ parameterName?: string | null; displayName?: string | null }> => []),
      collectPages(
        (pageToken) => admin.properties.dataStreams.list({ parent: property, pageToken }),
        (r) => r.data.dataStreams,
        (r) => r.data.nextPageToken
      ),
      collectPages(
        (pageToken) => admin.properties.googleAdsLinks.list({ parent: property, pageToken }),
        (r) => r.data.googleAdsLinks,
        (r) => r.data.nextPageToken
      ).catch((): unknown[] | null => null),
    ]);

    // Enhanced measurement settings live only on the v1alpha Admin surface, and
    // are a per-web-stream child resource (app streams 404). Same read scope.
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    // Google Signals state (best-effort; v1alpha). null = couldn't read.
    const googleSignals = await adminAlpha.properties
      .getGoogleSignalsSettings({ name: `${property}/googleSignalsSettings` })
      .then((r) => r.data.state ?? null)
      .catch(() => null);
    const dataStreams = await Promise.all(
      streams.map(async (s) => {
        let enhancedMeasurementEnabled: boolean | null = null;
        let enhancedMeasurement: { siteSearchEnabled: boolean; pageChangesEnabled: boolean; formInteractionsEnabled: boolean } | null = null;
        if (s.type === 'WEB_DATA_STREAM' && s.name) {
          try {
            const em = await adminAlpha.properties.dataStreams.getEnhancedMeasurementSettings({
              name: `${s.name}/enhancedMeasurementSettings`,
            });
            enhancedMeasurementEnabled = em.data.streamEnabled ?? null;
            enhancedMeasurement = {
              siteSearchEnabled: em.data.siteSearchEnabled ?? false,
              pageChangesEnabled: em.data.pageChangesEnabled ?? false,
              formInteractionsEnabled: em.data.formInteractionsEnabled ?? false,
            };
          } catch {
            enhancedMeasurementEnabled = null;
          }
        }
        return {
          name: s.name ?? '',
          displayName: s.displayName ?? '(unnamed)',
          type: s.type ?? '',
          defaultUri: s.webStreamData?.defaultUri ?? null,
          enhancedMeasurementEnabled,
          enhancedMeasurement,
        };
      })
    );

    // Attribution + BigQuery + audiences (all v1alpha, best-effort — a failed read → null so the audit
    // reports "not verified" rather than a false zero). These feed the new config findings.
    const [attributionRes, bigQueryRes, audiencesRes] = await Promise.all([
      adminAlpha.properties.getAttributionSettings({ name: `${property}/attributionSettings` }).then((r) => r.data).catch(() => null),
      collectPages(
        (pageToken) => adminAlpha.properties.bigQueryLinks.list({ parent: property, pageToken }),
        (r) => r.data.bigqueryLinks,
        (r) => r.data.nextPageToken
      ).catch((): Array<{ project?: string | null; dailyExportEnabled?: boolean | null; streamingExportEnabled?: boolean | null }> | null => null),
      collectPages(
        (pageToken) => adminAlpha.properties.audiences.list({ parent: property, pageToken }),
        (r) => r.data.audiences,
        (r) => r.data.nextPageToken
      ).catch((): unknown[] | null => null),
    ]);

    return {
      property,
      displayName: prop.data.displayName ?? '',
      timeZone: prop.data.timeZone ?? '',
      currencyCode: prop.data.currencyCode ?? '',
      industryCategory: prop.data.industryCategory ?? '',
      dataRetention: retention
        ? {
            eventDataRetention: retention.data.eventDataRetention ?? '',
            resetOnNewActivity: retention.data.resetUserDataOnNewActivity ?? false,
          }
        : null,
      keyEvents: keyEvents === null ? null : keyEvents.map((k) => ({ eventName: k.eventName ?? '' })),
      customDimensions:
        customDimensions === null
          ? null
          : customDimensions.map((d) => ({
              parameterName: d.parameterName ?? '',
              displayName: d.displayName ?? '',
              scope: d.scope ?? '',
            })),
      customMetrics: customMetrics.map((m) => ({
        parameterName: m.parameterName ?? '',
        displayName: m.displayName ?? '',
      })),
      dataStreams,
      googleAdsLinks: adsLinks === null ? null : adsLinks.length,
      googleSignals,
      serviceLevel: prop.data.serviceLevel ?? '',
      attribution: attributionRes
        ? {
            reportingAttributionModel: attributionRes.reportingAttributionModel ?? '',
            acquisitionLookback: attributionRes.acquisitionConversionEventLookbackWindow ?? '',
            otherLookback: attributionRes.otherConversionEventLookbackWindow ?? '',
          }
        : null,
      bigQueryLinks:
        bigQueryRes === null
          ? null
          : bigQueryRes.map((l) => ({
              project: l.project ?? '',
              dailyExportEnabled: l.dailyExportEnabled ?? false,
              streamingExportEnabled: l.streamingExportEnabled ?? false,
            })),
      audiences: audiencesRes === null ? null : audiencesRes.length,
    };
  }

  // ── Writes (workspace-scoped drafts; never published) ──────────────────────
  // Each is gated upstream by per-change user confirmation in the chat loop.

  async createGtmWorkspace(
    accountId: string,
    containerId: string,
    name: string
  ): Promise<GtmWorkspaceView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.create({
      parent: `accounts/${accountId}/containers/${containerId}`,
      requestBody: { name },
    });
    return {
      workspaceId: res.data.workspaceId ?? '',
      name: res.data.name ?? name,
      path: res.data.path ?? '',
    };
  }

  /** Delete a draft workspace. Draft-level ONLY: a workspace holds unpublished edits, so removing it
   *  never affects the live/published container or any other workspace. */
  async deleteGtmWorkspace(accountId: string, containerId: string, workspaceId: string): Promise<{ deleted: boolean }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.delete({ path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}` });
    return { deleted: true };
  }

  /** Create a folder in a draft workspace (organisational only — no effect on firing). */
  async createGtmFolder(
    accountId: string,
    containerId: string,
    workspaceId: string,
    name: string
  ): Promise<{ folderId: string; name: string; path: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.folders.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: { name },
    });
    return { folderId: res.data.folderId ?? '', name: res.data.name ?? name, path: res.data.path ?? '' };
  }

  /** Move tags / triggers / variables into a folder. Purely organisational — it does NOT
   *  change what fires. Pass the ids to relocate. */
  async moveEntitiesToFolder(
    accountId: string,
    containerId: string,
    workspaceId: string,
    folderId: string,
    ids: { tagIds?: string[]; triggerIds?: string[]; variableIds?: string[] }
  ): Promise<{ folderId: string; moved: { tags: number; triggers: number; variables: number } }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const tagId = ids.tagIds ?? [];
    const triggerId = ids.triggerIds ?? [];
    const variableId = ids.variableIds ?? [];
    // Only send entity-id params that actually have values — an empty `triggerId=` /
    // `variableId=` query param makes the API 500 ("internal error"). The path already
    // identifies the destination folder; the body just echoes it.
    await gtm.accounts.containers.workspaces.folders.move_entities_to_folder({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
      ...(tagId.length ? { tagId } : {}),
      ...(triggerId.length ? { triggerId } : {}),
      ...(variableId.length ? { variableId } : {}),
      requestBody: { folderId },
    });
    return { folderId, moved: { tags: tagId.length, triggers: triggerId.length, variables: variableId.length } };
  }

  /** Rename a folder. Organisational only — does not affect firing. */
  async renameGtmFolder(
    accountId: string,
    containerId: string,
    workspaceId: string,
    folderId: string,
    name: string
  ): Promise<{ folderId: string; name: string; path: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.folders.update({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
      requestBody: { name },
    });
    return { folderId: res.data.folderId ?? folderId, name: res.data.name ?? name, path: res.data.path ?? '' };
  }

  /** Delete a folder (draft). GTM does NOT delete the folder's contents — its tags /
   *  triggers / variables simply become unfiled. Still gated behind a confirm. */
  async deleteGtmFolder(
    accountId: string,
    containerId: string,
    workspaceId: string,
    folderId: string
  ): Promise<{ deleted: true; folderId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.folders.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
    });
    return { deleted: true, folderId };
  }

  async createGtmTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tag: Record<string, unknown>
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.tags.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: tag,
    });
    this.journal('tag', accountId, containerId, workspaceId, res.data.tagId ?? '', `${res.data.name ?? 'tag'} (#${res.data.tagId})`);
    return { tagId: res.data.tagId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Update a tag WITHOUT losing its config. GTM's update replaces the whole
   *  resource, so we fetch the current tag, overlay only the provided fields, and
   *  merge `parameter` BY KEY — a partial update (e.g. just a new name or a couple of
   *  params) no longer wipes eventName / measurementId / measurementIdOverride, which
   *  is what made GTM reject "vendorTemplate.parameter.measurementIdOverride: The value
   *  must not be empty." To ADD GA4 event parameters, use addGa4EventParameters. */
  async updateGtmTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    tag: Record<string, unknown>
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(tag)) {
      if (v === undefined) continue;
      if (k === 'parameter') {
        merged.parameter = mergeParametersByKey(
          (current.parameter as GtmParam[] | undefined) ?? [],
          v as GtmParam[]
        );
      } else {
        merged[k] = v;
      }
    }
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: merged });
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Add GA4 event parameters to an existing GA4 Event tag (type "gaawe") by appending
   *  them to its eventSettingsTable, preserving eventName / measurementId. Rejects
   *  non-gaawe tags. This is the correct path for "add session_id / click_text / … to
   *  all my GA4 tags" — it never wipes the rest of the tag. */
  async addGa4EventParameters(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    parameters: Array<{ name: string; value: string }>
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    console.error(`[gtm] addGa4EventParameters tag=${tagId} type=${current.type} params=[${parameters.map((p) => p.name).join(', ')}]`);
    if (current.type !== 'gaawe') {
      throw new Error(
        `Tag ${tagId} is type "${current.type ?? 'unknown'}", not a GA4 Event tag (gaawe). add_ga4_event_parameters only edits GA4 event tags.`
      );
    }
    const updated = addEventParameters(current as Record<string, unknown>, parameters);
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: updated });
    console.error(`[gtm]   ✓ tag ${tagId} (${res.data.name}) saved`);
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Add event parameters (`eventParameters`) and/or user properties (`userProperties`) to a SERVER
   *  GA4 tag (`sgtmgaaw`) — the "Parameters/Properties to Add / Edit" sections. Read-modify-write, so the
   *  measurementId / eventName / include-all dropdowns / triggers are preserved and a repeated name
   *  updates its value rather than duplicating. Rejects non-sgtmgaaw tags. (For a straight relay the
   *  incoming event's own params already flow via "Include: All" — use this for ENRICHMENT.) */
  async addGa4ServerParameters(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    opts: { eventParameters?: Array<{ name: string; value: string }>; userProperties?: Array<{ name: string; value: string }> }
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    console.error(`[gtm] addGa4ServerParameters tag=${tagId} type=${current.type} ep=[${(opts.eventParameters ?? []).map((p) => p.name).join(', ')}] up=[${(opts.userProperties ?? []).map((p) => p.name).join(', ')}]`);
    if (current.type !== 'sgtmgaaw') {
      throw new Error(
        `Tag ${tagId} is type "${current.type ?? 'unknown'}", not a GA4 SERVER tag (sgtmgaaw). add_ga4_server_parameters only edits GA4 server tags.`
      );
    }
    const updated = addServerGa4Params(current as Record<string, unknown>, opts);
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: updated });
    console.error(`[gtm]   ✓ tag ${tagId} (${res.data.name}) saved`);
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Point a tag's Measurement ID at a value (a G-/AW-/GT- id, or a {{Variable}})
   *  WITHOUT the model hand-building parameter JSON — the source of the "template
   *  key" errors. For a GA4 Event tag (gaawe) it sets `measurementIdOverride`; for a
   *  Google tag (googtag) it sets `tagId`. Read-modify-write, so the rest of the tag
   *  (eventName, event parameters, triggers) is preserved. Rejects other tag types. */
  async setGa4MeasurementId(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    measurementId: string
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    const key =
      current.type === 'gaawe' ? 'measurementIdOverride' : current.type === 'googtag' ? 'tagId' : null;
    console.error(`[gtm] setGa4MeasurementId tag=${tagId} type=${current.type} → ${key ?? '(unsupported)'}=${measurementId}`);
    if (!key) {
      throw new Error(
        `Tag ${tagId} is type "${current.type ?? 'unknown'}", not a GA4 Event tag (gaawe) or Google tag (googtag). set_ga4_measurement_id only edits those.`
      );
    }
    const updated = setTemplateParam(current as Record<string, unknown>, key, measurementId);
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: updated });
    console.error(`[gtm]   ✓ tag ${tagId} (${res.data.name}) saved`);
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Set a tag's Consent Mode v2 settings (read-modify-write, preserving the rest of the
   *  tag). `consentStatus: 'needed'` + consentTypes (ad_storage / analytics_storage /
   *  ad_user_data / ad_personalization) means GTM blocks the tag until those are granted;
   *  `'notNeeded'` declares the tag needs no extra consent (relies on Consent Mode at the
   *  Google-tag level). Resolves the "no Consent Mode v2 settings" audit finding. */
  async setGtmTagConsent(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    consentStatus: string,
    consentTypes: string[]
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    const status = consentStatus === 'notNeeded' ? 'notNeeded' : 'needed';
    const consentSettings =
      status === 'notNeeded'
        ? { consentStatus: 'notNeeded' }
        : {
            consentStatus: 'needed',
            consentType: { type: 'list', list: consentTypes.map((t) => ({ type: 'template', value: t })) },
          };
    const updated = { ...current, consentSettings };
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: updated as typeof current });
    console.error(`[gtm] setGtmTagConsent tag=${tagId} → ${status}${status === 'needed' ? ` [${consentTypes.join(', ')}]` : ''}`);
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Bulk, ONE call: set the Measurement ID on EVERY GA4 tag in the workspace
   *  (gaawe → measurementIdOverride, googtag → tagId). Continues past a per-tag failure
   *  and returns a summary, so one bad tag does not block the rest and the user approves
   *  the whole "all GA4 tags" operation once instead of tag-by-tag. */
  async setGa4MeasurementIdOnAllTags(
    accountId: string,
    containerId: string,
    workspaceId: string,
    measurementId: string
  ): Promise<{ total: number; updated: string[]; failed: Array<{ tag: string; error: string }> }> {
    const allTags = await this.listGtmTags(accountId, containerId, workspaceId);
    const targets = allTags.filter((t) => t.type === 'gaawe' || t.type === 'googtag');
    console.error(
      `[gtm] setGa4MeasurementIdOnAllTags: ${allTags.length} tag(s) in workspace, ${targets.length} GA4 target(s): ${targets.map((t) => `${t.name}#${t.tagId}(${t.type})`).join(' | ') || 'NONE — nothing to update'}`
    );
    const updated: string[] = [];
    const failed: Array<{ tag: string; error: string }> = [];
    for (const t of targets) {
      try {
        await this.setGa4MeasurementId(accountId, containerId, workspaceId, t.tagId, measurementId);
        updated.push(t.name);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failed.push({ tag: t.name, error });
        console.error(`[gtm]   ✗ ${t.name}#${t.tagId}: ${error}`);
      }
    }
    console.error(`[gtm] setGa4MeasurementIdOnAllTags DONE: ${updated.length} updated, ${failed.length} failed`);
    return { total: targets.length, updated, failed };
  }

  /** Bulk, ONE call: append GA4 event parameters to EVERY GA4 Event tag (gaawe) in
   *  the workspace. Continues past a per-tag failure; returns a summary. */
  async addGa4EventParametersToAllTags(
    accountId: string,
    containerId: string,
    workspaceId: string,
    parameters: Array<{ name: string; value: string }>
  ): Promise<{ total: number; updated: string[]; failed: Array<{ tag: string; error: string }> }> {
    const allTags = await this.listGtmTags(accountId, containerId, workspaceId);
    const targets = allTags.filter((t) => t.type === 'gaawe');
    console.error(
      `[gtm] addGa4EventParametersToAllTags: ${allTags.length} tag(s) in workspace, ${targets.length} gaawe target(s): ${targets.map((t) => `${t.name}#${t.tagId}`).join(' | ') || 'NONE — nothing to update'} · params=[${parameters.map((p) => p.name).join(', ')}]`
    );
    const updated: string[] = [];
    const failed: Array<{ tag: string; error: string }> = [];
    for (const t of targets) {
      try {
        await this.addGa4EventParameters(accountId, containerId, workspaceId, t.tagId, parameters);
        updated.push(t.name);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failed.push({ tag: t.name, error });
        console.error(`[gtm]   ✗ ${t.name}#${t.tagId}: ${error}`);
      }
    }
    console.error(`[gtm] addGa4EventParametersToAllTags DONE: ${updated.length} updated, ${failed.length} failed`);
    return { total: targets.length, updated, failed };
  }

  /** What the last chat query changed (deduped) — for the renderer's Revert button. */
  peekLastChanges(): { count: number; labels: string[] } {
    const refs = changeJournal.peekLast();
    return { count: refs?.length ?? 0, labels: (refs ?? []).map((r) => r.label) };
  }

  /** Revert the GTM entities the last chat query wrote to, using GTM's native per-entity
   *  revert (restores each to its last published version). Continues past per-entity
   *  failures and returns a summary. The revert itself is NOT journaled (no undo-of-undo). */
  async revertLastChanges(): Promise<{ reverted: string[]; failed: Array<{ label: string; error: string }> }> {
    const refs = changeJournal.takeLast();
    if (!refs || !refs.length) return { reverted: [], failed: [] };
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const ws = (r: { accountId: string; containerId: string; workspaceId: string }): string =>
      `accounts/${r.accountId}/containers/${r.containerId}/workspaces/${r.workspaceId}`;
    const reverted: string[] = [];
    const failed: Array<{ label: string; error: string }> = [];
    console.error(`[gtm] revertLastChanges: ${refs.length} entity(ies): ${refs.map((r) => r.label).join(' | ')}`);
    for (const r of refs) {
      try {
        const path = `${ws(r)}/${r.kind}s/${r.id}`;
        if (r.kind === 'tag') await gtm.accounts.containers.workspaces.tags.revert({ path });
        else if (r.kind === 'trigger') await gtm.accounts.containers.workspaces.triggers.revert({ path });
        else await gtm.accounts.containers.workspaces.variables.revert({ path });
        reverted.push(r.label);
        console.error(`[gtm]   ✓ reverted ${r.kind} ${r.id}`);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        failed.push({ label: r.label, error });
        console.error(`[gtm]   ✗ revert ${r.kind} ${r.id}: ${error}`);
      }
    }
    console.error(`[gtm] revertLastChanges DONE: ${reverted.length} reverted, ${failed.length} failed`);
    return { reverted, failed };
  }

  /** Record a touched entity into the current chat turn's change journal (for Revert). */
  private journal(kind: EntityKind, accountId: string, containerId: string, workspaceId: string, id: string, label: string): void {
    if (id) changeJournal.record({ kind, accountId, containerId, workspaceId, id, label });
  }

  /** Pause or unpause a tag WITHOUT losing its config: GTM update replaces the
   *  whole resource, so we fetch the current tag, flip `paused`, and write it
   *  back — preserving parameters, triggers, consent settings, etc. */
  async setGtmTagPaused(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    paused: boolean
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = await gtm.accounts.containers.workspaces.tags.get({ path });
    const res = await gtm.accounts.containers.workspaces.tags.update({
      path,
      requestBody: { ...current.data, paused },
    });
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Full tags + triggers + variables for an audit. Tags carry firingTriggerId,
   *  paused, parameters and consentSettings; triggers carry their filters and
   *  variables their parameters, so the audit can detect consent gaps and which
   *  variables are actually referenced. */
  async getGtmContainerSnapshot(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<ContainerSnapshot> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    // Page counters so a "missing items" report can be localized: a count below the GTM UI with
    // pages=1 means the API capped a single response (no nextPageToken); pages>1 with a low count
    // means pagination ran but that workspace genuinely has fewer (e.g. the wrong workspace).
    let tagPages = 0;
    let triggerPages = 0;
    let variablePages = 0;
    const [tags, triggers, variables] = await Promise.all([
      collectPages(
        (pageToken) => {
          tagPages += 1;
          return gtm.accounts.containers.workspaces.tags.list({ parent, pageToken });
        },
        (r) => r.data.tag,
        (r) => r.data.nextPageToken
      ),
      collectPages(
        (pageToken) => {
          triggerPages += 1;
          return gtm.accounts.containers.workspaces.triggers.list({ parent, pageToken });
        },
        (r) => r.data.trigger,
        (r) => r.data.nextPageToken
      ),
      collectPages(
        (pageToken) => {
          variablePages += 1;
          return gtm.accounts.containers.workspaces.variables.list({ parent, pageToken });
        },
        (r) => r.data.variable,
        (r) => r.data.nextPageToken
      ),
    ]);
    const snapshot = toSnapshot(tags, triggers, variables);
    console.error(
      `[gtm-snapshot] ws ${workspaceId}: ${tags.length} tags (${tagPages}p) · ${triggers.length} triggers (${triggerPages}p) · ${variables.length} variables (${variablePages}p)`
    );
    // Breakdown so an orphaned-trigger count that looks "too low" can be explained: the gap between
    // orphaned= and each ifXUnused= is the number of triggers ONLY that rule keeps out of the set.
    const tb = triggerUsageBreakdown(snapshot);
    console.error(
      `[trigger-usage] total=${tb.total} orphaned=${tb.orphaned} | ifBlockingUnused=${tb.orphanedIfBlockingUnused} ifPausedFiringUnused=${tb.orphanedIfPausedFiringUnused}`
    );
    return snapshot;
  }

  /** COPY all tags/triggers/variables from one workspace into another in the SAME container.
   *  GTM has no atomic "move", so this recreates the resources in the destination: variables,
   *  then triggers (non-group first, then trigger GROUPS whose member triggerReferences are
   *  remapped), then tags (whose firingTriggerId/blockingTriggerId — and built-in trigger ids
   *  — are remapped to the destination). Skips any resource whose NAME already exists in the
   *  destination (non-destructive — never overwrites). Variable {{references}} carry over by
   *  name. NOT copied: folders, built-in variables (may need enabling), and tags that use
   *  legacy firing/blocking RULES (reported in `unsupported`). A create that throws is recorded
   *  in `failed` and the copy CONTINUES — so the result is a complete inventory of what landed. */
  async copyWorkspaceResources(
    accountId: string,
    containerId: string,
    fromWorkspaceId: string,
    toWorkspaceId: string
  ): Promise<{
    variables: { created: string[]; skipped: string[] };
    triggers: { created: string[]; skipped: string[] };
    tags: { created: string[]; skipped: string[] };
    unsupported: string[];
    failed: string[];
  }> {
    if (fromWorkspaceId === toWorkspaceId) throw new Error('Source and destination workspaces are the same.');
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const srcParent = `accounts/${accountId}/containers/${containerId}/workspaces/${fromWorkspaceId}`;
    const dstParent = `accounts/${accountId}/containers/${containerId}/workspaces/${toWorkspaceId}`;
    const listAll = async (parent: string): Promise<{ tags: RawTag[]; triggers: RawTrigger[]; variables: RawVariable[] }> => {
      const [tags, triggers, variables] = await Promise.all([
        collectPages((pageToken) => gtm.accounts.containers.workspaces.tags.list({ parent, pageToken }), (r) => r.data.tag, (r) => r.data.nextPageToken),
        collectPages((pageToken) => gtm.accounts.containers.workspaces.triggers.list({ parent, pageToken }), (r) => r.data.trigger, (r) => r.data.nextPageToken),
        collectPages((pageToken) => gtm.accounts.containers.workspaces.variables.list({ parent, pageToken }), (r) => r.data.variable, (r) => r.data.nextPageToken),
      ]);
      return { tags, triggers, variables };
    };
    const [src, dst] = await Promise.all([listAll(srcParent), listAll(dstParent)]);

    // Drop server-assigned / workspace-bound fields so a resource can be re-created cleanly.
    // uniqueTriggerId/parentFolderId are workspace-bound and must not carry over.
    const strip = (o: Record<string, unknown>): Record<string, unknown> => {
      const { tagId, triggerId, variableId, fingerprint, path, accountId: _a, containerId: _c, workspaceId: _w, tagManagerUrl, parentFolderId, uniqueTriggerId, ...rest } = o as Record<string, unknown>;
      void tagId; void triggerId; void variableId; void fingerprint; void path; void _a; void _c; void _w; void tagManagerUrl; void parentFolderId; void uniqueTriggerId;
      return rest;
    };
    const lc = (s2: string | null | undefined): string => (s2 ?? '').trim().toLowerCase();
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    // A bulk copy fires dozens of writes in seconds and predictably trips GTM's low per-minute
    // write quota — retry each create with backoff so the copy completes in ONE run instead of
    // failing partway and needing a manual retry. Generous (6 tries, up to 60s) to outlast a
    // quota-reset window; genuine errors still surface to `failed`.
    const RETRY = { maxRetries: 6, baseDelayMs: 2_000, maxDelayMs: 60_000 };

    const result = {
      variables: { created: [] as string[], skipped: [] as string[] },
      triggers: { created: [] as string[], skipped: [] as string[] },
      tags: { created: [] as string[], skipped: [] as string[] },
      unsupported: [] as string[],
      failed: [] as string[],
    };

    const dstTrigByName = new Map(dst.triggers.map((t) => [lc(t.name), t.triggerId ?? '']));
    const trigIdMap = new Map<string, string>();
    // Rewrite triggerReference parameter VALUES (e.g. a Trigger Group's member list) through the
    // id map; PASS THROUGH unmapped ids (built-in triggers keep the same reserved id). Recurses
    // into list/map params.
    const remapRefs = (param: unknown): unknown => {
      if (!param || typeof param !== 'object') return param;
      if (Array.isArray(param)) return param.map(remapRefs);
      const p = { ...(param as Record<string, unknown>) };
      if (p.type === 'triggerReference' && typeof p.value === 'string') p.value = trigIdMap.get(p.value) ?? p.value;
      if (Array.isArray(p.list)) p.list = p.list.map(remapRefs);
      if (Array.isArray(p.map)) p.map = p.map.map(remapRefs);
      return p;
    };
    const remap = (ids: string[] | null | undefined): string[] | undefined => {
      if (!Array.isArray(ids) || ids.length === 0) return undefined;
      return ids.map((id) => trigIdMap.get(id) ?? id);
    };

    // 1) Variables — referenced by name, so no id remapping needed.
    const dstVarNames = new Set(dst.variables.map((v) => lc(v.name)));
    for (const v of src.variables) {
      if (dstVarNames.has(lc(v.name))) { result.variables.skipped.push(v.name ?? ''); continue; }
      try {
        await withQuotaRetry(() => gtm.accounts.containers.workspaces.variables.create({ parent: dstParent, requestBody: strip(v as Record<string, unknown>) }), RETRY);
        result.variables.created.push(v.name ?? '');
      } catch (e) {
        result.failed.push(`variable "${v.name ?? ''}": ${msg(e)}`);
      }
    }

    // 2) Triggers — NON-group first (so the id map is built), then trigger GROUPS (remap their
    //    member triggerReference params via the now-complete map).
    const isGroup = (t: RawTrigger): boolean => (t.type ?? '') === 'triggerGroup';
    const orderedTriggers = [...src.triggers.filter((t) => !isGroup(t)), ...src.triggers.filter(isGroup)];
    for (const t of orderedTriggers) {
      const existing = dstTrigByName.get(lc(t.name));
      if (existing) { if (t.triggerId) trigIdMap.set(t.triggerId, existing); result.triggers.skipped.push(t.name ?? ''); continue; }
      const body = strip(t as Record<string, unknown>);
      if (isGroup(t) && Array.isArray(body.parameter)) body.parameter = (body.parameter as unknown[]).map(remapRefs);
      try {
        const created = await withQuotaRetry(() => gtm.accounts.containers.workspaces.triggers.create({ parent: dstParent, requestBody: body }), RETRY);
        if (t.triggerId && created.data.triggerId) trigIdMap.set(t.triggerId, created.data.triggerId);
        result.triggers.created.push(t.name ?? '');
      } catch (e) {
        result.failed.push(`trigger "${t.name ?? ''}": ${msg(e)}`);
      }
    }

    // 3) Tags — remap firing/blocking trigger ids; skip tags using legacy RULES (the rules
    //    resource isn't copied, so their references would dangle).
    const dstTagNames = new Set(dst.tags.map((t) => lc(t.name)));
    for (const tag of src.tags) {
      if (dstTagNames.has(lc(tag.name))) { result.tags.skipped.push(tag.name ?? ''); continue; }
      const raw = tag as unknown as Record<string, unknown>;
      const usesRules = (Array.isArray(raw.firingRuleId) && raw.firingRuleId.length > 0) || (Array.isArray(raw.blockingRuleId) && raw.blockingRuleId.length > 0);
      if (usesRules) { result.unsupported.push(`tag "${tag.name ?? ''}" (uses legacy firing rules — recreate manually)`); continue; }
      const body = strip(raw);
      const fires = remap(tag.firingTriggerId);
      const blocks = remap(tag.blockingTriggerId);
      if (fires) body.firingTriggerId = fires; else delete body.firingTriggerId;
      if (blocks) body.blockingTriggerId = blocks; else delete body.blockingTriggerId;
      if (Array.isArray(body.parameter)) body.parameter = (body.parameter as unknown[]).map(remapRefs);
      try {
        await withQuotaRetry(() => gtm.accounts.containers.workspaces.tags.create({ parent: dstParent, requestBody: body }), RETRY);
        result.tags.created.push(tag.name ?? '');
      } catch (e) {
        result.failed.push(`tag "${tag.name ?? ''}": ${msg(e)}`);
      }
    }
    return result;
  }

  /** The PUBLISHED (live) container version as a snapshot, for drift detection
   *  against the draft workspace. Returns null when the container has no
   *  published version yet (a fresh container) — callers treat that as "nothing
   *  live, everything in the workspace is pending". Auth/other errors propagate. */
  async getGtmLiveVersionSnapshot(
    accountId: string,
    containerId: string
  ): Promise<ContainerSnapshot | null> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    try {
      const res = await gtm.accounts.containers.versions.live({
        parent: `accounts/${accountId}/containers/${containerId}`,
      });
      // A live version contains every resource inline (no pagination).
      return toSnapshot(res.data.tag ?? [], res.data.trigger ?? [], res.data.variable ?? []);
    } catch (e) {
      const code = (e as { code?: number; response?: { status?: number } }).code ??
        (e as { response?: { status?: number } }).response?.status;
      if (code === 404) return null; // no published version yet
      throw e;
    }
  }

  /** The container's published version history (newest first), for diffing. */
  async listGtmVersions(
    accountId: string,
    containerId: string
  ): Promise<Array<{ versionId: string; name: string; numTags: number; numTriggers: number; numVariables: number; deleted: boolean }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const headers = await collectPages(
      (pageToken) =>
        gtm.accounts.containers.version_headers.list({
          parent: `accounts/${accountId}/containers/${containerId}`,
          pageToken,
        }),
      (r) => r.data.containerVersionHeader,
      (r) => r.data.nextPageToken
    );
    return headers.map((h) => ({
      versionId: h.containerVersionId ?? '',
      name: h.name ?? '(unnamed)',
      numTags: Number(h.numTags ?? 0),
      numTriggers: Number(h.numTriggers ?? 0),
      numVariables: Number(h.numVariables ?? 0),
      deleted: h.deleted ?? false,
    }));
  }

  /** A specific published container version as a snapshot, for version diffing. */
  async getGtmVersionSnapshot(
    accountId: string,
    containerId: string,
    versionId: string
  ): Promise<ContainerSnapshot> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.versions.get({
      path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
    });
    // A version contains every resource inline (no pagination).
    return toSnapshot(res.data.tag ?? [], res.data.trigger ?? [], res.data.variable ?? []);
  }

  async listGtmTriggers(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<Array<{ triggerId: string; name: string; type: string; customEventName: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const triggers = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.triggers.list({ parent, pageToken }),
      (r) => r.data.trigger,
      (r) => r.data.nextPageToken
    );
    return triggers.map((t) => ({
      triggerId: t.triggerId ?? '',
      name: t.name ?? '(unnamed)',
      type: t.type ?? '',
      // For Custom Event triggers, surface the dataLayer event so callers can detect a
      // duplicate that fires on the same event under a different name.
      customEventName: customEventNameOf(t as unknown as Record<string, unknown>),
    }));
  }

  /** List the variables in a workspace (name + type). */
  async listGtmVariables(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<Array<{ variableId: string; name: string; type: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const variables = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.variables.list({ parent, pageToken }),
      (r) => r.data.variable,
      (r) => r.data.nextPageToken
    );
    return variables.map((v) => ({ variableId: v.variableId ?? '', name: v.name ?? '(unnamed)', type: v.type ?? '' }));
  }

  /* ── Server-side GTM (sGTM) ── */

  /** Create a SERVER container (usageContext 'server'). The actual tagging-server HOST
   *  (Cloud Run / App Engine) must be provisioned separately; taggingServerUrls reflects it. */
  async createServerContainer(
    accountId: string,
    name: string
  ): Promise<{ containerId: string; publicId: string; name: string; taggingServerUrls: string[] }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.create({
      parent: `accounts/${accountId}`,
      requestBody: { name, usageContext: ['server'] },
    });
    return {
      containerId: res.data.containerId ?? '',
      publicId: res.data.publicId ?? '',
      name: res.data.name ?? name,
      taggingServerUrls: res.data.taggingServerUrls ?? [],
    };
  }

  /** The default workspace of a container (named "Default Workspace", else the first). */
  private async defaultWorkspaceId(accountId: string, containerId: string): Promise<string> {
    const wss = await this.listGtmWorkspaces(accountId, containerId);
    const def = wss.find((w) => w.name.toLowerCase() === 'default workspace') ?? wss[0];
    if (!def) throw new Error('New container has no workspace.');
    return def.workspaceId;
  }

  async listGtmClients(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<Array<{ clientId: string; name: string; type: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const clients = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.clients.list({ parent, pageToken }),
      (r) => r.data.client,
      (r) => r.data.nextPageToken
    );
    return clients.map((c) => ({ clientId: c.clientId ?? '', name: c.name ?? '(unnamed)', type: c.type ?? '' }));
  }

  async createGtmClient(
    accountId: string,
    containerId: string,
    workspaceId: string,
    client: Record<string, unknown>
  ): Promise<{ clientId: string; name: string; type: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.clients.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: client,
    });
    return { clientId: res.data.clientId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  async deleteGtmClient(
    accountId: string,
    containerId: string,
    workspaceId: string,
    clientId: string
  ): Promise<{ deleted: boolean; clientId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.clients.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/clients/${clientId}`,
    });
    return { deleted: true, clientId };
  }

  async listGtmTransformations(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<Array<{ transformationId: string; name: string; type: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const xs = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.transformations.list({ parent, pageToken }),
      (r) => r.data.transformation,
      (r) => r.data.nextPageToken
    );
    return xs.map((t) => ({ transformationId: t.transformationId ?? '', name: t.name ?? '(unnamed)', type: t.type ?? '' }));
  }

  async createGtmTransformation(
    accountId: string,
    containerId: string,
    workspaceId: string,
    transformation: Record<string, unknown>
  ): Promise<{ transformationId: string; name: string; type: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.transformations.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: transformation,
    });
    return { transformationId: res.data.transformationId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Snapshot a SERVER container for auditServerContainer: its tagging server URL(s),
   *  clients, server tags (as AuditTags), and transformations. */
  async getServerContainerSnapshot(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<ServerContainerSnapshot> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const [container, rawTags, rawTriggers, clients, transformations] = await Promise.all([
      gtm.accounts.containers.get({ path: `accounts/${accountId}/containers/${containerId}` }),
      collectPages(
        (pageToken) => gtm.accounts.containers.workspaces.tags.list({ parent, pageToken }),
        (r) => r.data.tag,
        (r) => r.data.nextPageToken
      ),
      collectPages(
        (pageToken) => gtm.accounts.containers.workspaces.triggers.list({ parent, pageToken }),
        (r) => r.data.trigger,
        (r) => r.data.nextPageToken
      ),
      this.listGtmClients(accountId, containerId, workspaceId),
      this.listGtmTransformations(accountId, containerId, workspaceId),
    ]);
    const { tags, triggers } = toSnapshot(rawTags, rawTriggers, []);
    return {
      taggingServerUrls: container.data.taggingServerUrls ?? [],
      clients,
      tags,
      triggers,
      transformations,
    };
  }

  /** Runtime check: GET <serverUrl>/healthy on the deployed tagging server (sGTM servers
   *  answer "ok"). https-only, no embedded credentials, and guarded by the shared
   *  SSRF check (requestAllowed) — which RESOLVES named hosts and blocks any that map to a
   *  private/loopback/metadata IP, closing IPv6/IPv4-mapped/decimal-IP/DNS-rebind vectors a
   *  string check misses. 6s timeout, no auth, no redirects followed. Confirms reachability. */
  async verifyServerEndpoint(
    serverUrl: string
  ): Promise<{ url: string; ok: boolean; status: number | null; body?: string; error?: string }> {
    let base: URL;
    try {
      base = new URL(serverUrl);
    } catch {
      return { url: serverUrl, ok: false, status: null, error: 'Not a valid URL.' };
    }
    // A safe label that never echoes embedded userinfo back into the transcript.
    const safeUrl = `${base.protocol}//${base.host}/healthy`;
    if (base.protocol !== 'https:') return { url: safeUrl, ok: false, status: null, error: 'Tagging server URL must be https.' };
    if (base.username || base.password) return { url: safeUrl, ok: false, status: null, error: 'URL must not embed credentials (user:pass@).' };
    const healthy = new URL('/healthy', base).toString(); // userinfo already rejected
    const { requestAllowed } = await import('../suggestions/ssrf');
    if (!(await requestAllowed(healthy))) return { url: safeUrl, ok: false, status: null, error: 'Refusing to probe a private/loopback/metadata host.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(healthy, { method: 'GET', signal: controller.signal, redirect: 'manual' });
      const body = (await res.text().catch(() => '')).slice(0, 200);
      return { url: healthy, ok: res.ok, status: res.status, body };
    } catch (e) {
      return { url: healthy, ok: false, status: null, error: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One-shot: create a SERVER container, then add a GA4 client + a GA4 server tag (relaying
   *  to `measurementId`) in its default workspace. Returns the new ids + taggingServerUrls.
   *  Does NOT deploy the tagging-server host or wire the web container (no URL yet). */
  /** Derive THE GA4 Measurement ID to relay from a WEB container — reads its default
   *  workspace and extracts the literal G-XXXX id its GA4/Google tags send to. Throws a
   *  helpful error if there are none (or only {{variable}} refs) or more than one, so the
   *  caller passes an explicit id instead of us guessing. */
  async deriveWebContainerMeasurementId(accountId: string, webContainerId: string): Promise<string> {
    const workspaceId = await this.defaultWorkspaceId(accountId, webContainerId);
    // resolveGa4MeasurementIds also resolves a {{Constant variable}} measurement-id reference
    // to its literal G- value (the API can read a Constant's value).
    let { ids, unresolvedRefs } = resolveGa4MeasurementIds(await this.getGtmContainerSnapshot(accountId, webContainerId, workspaceId));
    if (ids.length === 0) {
      // The GA4 tag may live in the LIVE published version (or a non-default workspace that
      // was published) rather than the default draft — fall back to it before giving up.
      const live = await this.getGtmLiveVersionSnapshot(accountId, webContainerId).catch(() => null);
      if (live) ({ ids, unresolvedRefs } = resolveGa4MeasurementIds(live));
    }
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) {
      const hint = unresolvedRefs.length ? ` Its GA4 tag(s) reference a {{variable}} that isn't a readable Constant (${unresolvedRefs.join(', ')}).` : '';
      throw new Error(`No GA4 Measurement ID found in web container ${webContainerId} (checked its default workspace + live version, resolving Constant variables).${hint} Pass measurementId explicitly.`);
    }
    throw new Error(`Web container ${webContainerId} has multiple GA4 Measurement IDs (${ids.join(', ')}). Pass the one to relay as measurementId.`);
  }

  async bootstrapServerSideTagging(
    accountId: string,
    name: string,
    measurementId: string
  ): Promise<{
    container: { containerId: string; publicId: string; name: string; taggingServerUrls: string[] };
    workspaceId: string;
    client: { clientId: string; name: string };
    trigger: { triggerId: string; name: string };
    serverTag: { tagId: string; name: string };
  }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const container = await this.q(() => this.createServerContainer(accountId, name));
    const workspaceId = await this.q(() => this.defaultWorkspaceId(accountId, container.containerId));
    const parent = `accounts/${accountId}/containers/${container.containerId}/workspaces/${workspaceId}`;
    const clientRes = await this.q(() => gtm.accounts.containers.workspaces.clients.create({ parent, requestBody: buildGa4Client('GA4') }));
    const clientName = clientRes.data.name ?? 'GA4';
    // Enable the Client Name built-in so the trigger's "{{Client Name}} equals GA4" filter
    // resolves (best-effort — a failure here shouldn't abort the whole bootstrap).
    try {
      await this.q(() => this.enableGtmBuiltInVariables(accountId, container.containerId, workspaceId, ['clientName']));
    } catch {
      /* non-fatal: the trigger still matches all events if the filter can't be scoped */
    }
    // Create the firing trigger FIRST so the GA4 server tag actually fires (a tag with no
    // trigger never runs) — scoped to the GA4 client (Google/Stape pattern). A complete,
    // audit-clean setup in one step.
    const triggerRes = await this.q(() => gtm.accounts.containers.workspaces.triggers.create({
      parent,
      requestBody: buildServerAllEventsTrigger('All Events', clientName) as unknown as Record<string, unknown>,
    }));
    const triggerId = triggerRes.data.triggerId ?? '';
    const tagRes = await this.q(() => gtm.accounts.containers.workspaces.tags.create({
      parent,
      requestBody: buildGa4ServerTag('GA4 - Server', measurementId, undefined, triggerId ? [triggerId] : undefined),
    }));
    return {
      container,
      workspaceId,
      client: { clientId: clientRes.data.clientId ?? '', name: clientRes.data.name ?? 'GA4' },
      trigger: { triggerId, name: triggerRes.data.name ?? 'All Events' },
      serverTag: { tagId: tagRes.data.tagId ?? '', name: tagRes.data.name ?? 'GA4 - Server' },
    };
  }

  /** Find an existing SERVER container by name (case-insensitive) in the account, or null.
   *  Used to make "create server container from web" idempotent — a retry reuses the
   *  container the first (quota-interrupted) attempt already created instead of failing on
   *  "Found entity with duplicate name". */
  private async findServerContainerByName(
    accountId: string,
    name: string
  ): Promise<{ containerId: string; publicId: string; name: string; taggingServerUrls: string[] } | null> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const containers = await this.q(() =>
      collectPages(
        (pageToken) => gtm.accounts.containers.list({ parent: `accounts/${accountId}`, pageToken }),
        (r) => r.data.container,
        (r) => r.data.nextPageToken
      )
    );
    // matchesServerContainer compares name + usageContext case-insensitively (GTM may echo
    // usageContext as "server" or "SERVER"); a strict === would miss the existing container
    // and re-duplicate on retry. Pure + unit-tested in gtm-builders.test.ts.
    const hit = containers.find((c) => matchesServerContainer(c, name));
    return hit
      ? { containerId: hit.containerId ?? '', publicId: hit.publicId ?? '', name: hit.name ?? name, taggingServerUrls: hit.taggingServerUrls ?? [] }
      : null;
  }

  /** Ensure the GA4 server baseline (client + all-events trigger + GA4 relay tag) exists in an
   *  EXISTING server container, creating only the missing pieces (idempotent by name/type). Returns
   *  the same shape as bootstrapServerSideTagging so the from-web orchestrator can resume a
   *  partially-created container after a quota interruption. */
  private async ensureServerBaseline(
    accountId: string,
    container: { containerId: string; publicId: string; name: string; taggingServerUrls: string[] },
    measurementId: string
  ): Promise<{
    container: { containerId: string; publicId: string; name: string; taggingServerUrls: string[] };
    workspaceId: string;
    client: { clientId: string; name: string };
    trigger: { triggerId: string; name: string };
    serverTag: { tagId: string; name: string };
  }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const cid = container.containerId;
    const workspaceId = await this.q(() => this.defaultWorkspaceId(accountId, cid));
    const parent = `accounts/${accountId}/containers/${cid}/workspaces/${workspaceId}`;

    // GA4 client (reuse any existing gaaw_client, else create one named "GA4").
    const clients = await this.q(() => this.listGtmClients(accountId, cid, workspaceId));
    let client = clients.find((c) => c.type === 'gaaw_client');
    if (!client) {
      const cr = await this.q(() => gtm.accounts.containers.workspaces.clients.create({ parent, requestBody: buildGa4Client('GA4') }));
      client = { clientId: cr.data.clientId ?? '', name: cr.data.name ?? 'GA4', type: 'gaaw_client' };
    }
    const clientName = client.name || 'GA4';
    try {
      await this.q(() => this.enableGtmBuiltInVariables(accountId, cid, workspaceId, ['clientName']));
    } catch { /* non-fatal */ }

    // All-events trigger (reuse by name "All Events", else create).
    const triggers = await this.q(() => this.listGtmTriggers(accountId, cid, workspaceId));
    const existingTrig = triggers.find((t) => t.name.trim().toLowerCase() === 'all events');
    let triggerId = existingTrig?.triggerId ?? '';
    let triggerName = existingTrig?.name ?? 'All Events';
    if (!existingTrig) {
      const tr = await this.q(() => gtm.accounts.containers.workspaces.triggers.create({ parent, requestBody: buildServerAllEventsTrigger('All Events', clientName) as unknown as Record<string, unknown> }));
      triggerId = tr.data.triggerId ?? '';
      triggerName = tr.data.name ?? 'All Events';
    }

    // GA4 relay tag (reuse by name "GA4 - Server", else create).
    const tags = await this.q(() => this.listGtmTags(accountId, cid, workspaceId));
    const existingTag = tags.find((t) => t.name.trim().toLowerCase() === 'ga4 - server');
    let tagId = existingTag?.tagId ?? '';
    let tagName = existingTag?.name ?? 'GA4 - Server';
    if (!existingTag) {
      const tg = await this.q(() => gtm.accounts.containers.workspaces.tags.create({ parent, requestBody: buildGa4ServerTag('GA4 - Server', measurementId, undefined, triggerId ? [triggerId] : undefined) }));
      tagId = tg.data.tagId ?? '';
      tagName = tg.data.name ?? 'GA4 - Server';
    }

    return {
      container,
      workspaceId,
      client: { clientId: client.clientId, name: client.name },
      trigger: { triggerId, name: triggerName },
      serverTag: { tagId, name: tagName },
    };
  }

  /** ONE-STEP "server container from THIS web container": derive the web container's GA4 Measurement
   *  ID, bootstrap a SERVER container (container + GA4 client with server-managed FPID cookies +
   *  firing trigger + GA4 relay tag), then add the production pieces the reference architecture
   *  (Vocal Minority web+server pair) builds by hand: a GTM client that FIRST-PARTY-SERVES the web
   *  container (allowedContainerIds = the web GTM-XXXX id) and the standard Event Data variables
   *  server tags read (ed - event_id for Meta/TikTok dedup, ed - page_location for page-scoped
   *  campaign triggers). When a server URL is given, records it on the server container, points the
   *  web Google tag at it, AND wires browser↔server event dedup on the web side (imports Stape's
   *  Unique Event ID variable template and sends event_id on every GA4 hit so CAPI copies dedup
   *  against browser pixels). Also scans the web container for NON-GA4 conversion tags (Google Ads,
   *  Meta) that still need a server-side tag. Every post-bootstrap step is best-effort so a failure
   *  never loses the created server container. */
  async createServerContainerFromWeb(
    accountId: string,
    webContainerId: string,
    name: string,
    serverUrl?: string
  ): Promise<{
    serverContainer: { containerId: string; publicId: string; name: string; taggingServerUrls: string[] };
    workspaceId: string;
    measurementId: string;
    created: { client: string; trigger: string; serverTag: string; gtmClient: string | null; variables: string[] };
    serverUrlSet: boolean;
    webWired: { tagId: string; name: string } | null;
    webDedup: { uniqueEventIdVariable: string; eventIdWired: boolean } | null;
    webNonGa4: Array<{ kind: string; name: string; detail: string }>;
  }> {
    // Read the WEB container once for its name (fallback container name) and its GTM-XXXX public id
    // (the GTM client's allowedContainerIds needs it).
    const auth0 = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm0 = tagmanager({ version: 'v2', auth: auth0 });
    let webPublicId = '';
    let webName = 'Web';
    try {
      const web = await this.q(() => gtm0.accounts.containers.get({ path: `accounts/${accountId}/containers/${webContainerId}` }));
      webPublicId = web.data.publicId ?? '';
      webName = web.data.name ?? 'Web';
    } catch {
      /* non-fatal — the GTM client is skipped below without a public id */
    }
    // No name given → derive it from the WEB container's own name ("<web name> - Server"), so the
    // created container is identifiable (never a bare literal like "Server").
    const containerName = name.trim() || `${webName} - Server`;
    // Quota-retried and BEFORE the idempotency gate: a saturated-quota read here would otherwise
    // propagate out and re-run the whole read-heavy prefix under any outer retry.
    const measurementId = await this.q(() => this.deriveWebContainerMeasurementId(accountId, webContainerId));
    // IDEMPOTENT: if a server container with this name already exists (a prior run created it but
    // hit the quota before finishing), REUSE it and ensure the baseline instead of creating a
    // duplicate ("Found entity with duplicate name"). Combined with per-sub-call quota-retry, the
    // whole flow completes on a retry rather than erroring.
    const existingServer = await this.findServerContainerByName(accountId, containerName);
    const boot = existingServer
      ? await this.ensureServerBaseline(accountId, existingServer, measurementId)
      : await this.bootstrapServerSideTagging(accountId, containerName, measurementId);

    // Production pieces from the reference architecture. List the server workspace's clients +
    // variables first so a RESUME reuses what a prior run already created (instead of firing doomed
    // duplicate-name writes and then mis-reporting them as "not created"). Best-effort + quota-retried.
    const [svClients, svVars] = await Promise.all([
      this.q(() => this.listGtmClients(accountId, boot.container.containerId, boot.workspaceId)).catch(() => []),
      this.q(() => this.listGtmVariables(accountId, boot.container.containerId, boot.workspaceId)).catch(() => []),
    ]);
    let gtmClient: string | null = svClients.find((c) => c.type === 'gtm_client')?.name ?? null;
    if (webPublicId && !gtmClient) {
      try {
        const gc = await this.q(() => this.createGtmClient(accountId, boot.container.containerId, boot.workspaceId, buildGtmClient('GTM Web Container', [webPublicId]) as unknown as Record<string, unknown>));
        gtmClient = gc.name;
      } catch {
        /* non-fatal — first-party serving can be added later with create_gtm_client */
      }
    }
    const svVarNames = new Set(svVars.map((v) => v.name.trim().toLowerCase()));
    const variables: string[] = [];
    for (const v of [
      buildVariable({ name: 'ed - event_id', kind: 'event_data', keyPath: 'event_id' }),
      buildVariable({ name: 'ed - page_location', kind: 'event_data', keyPath: 'page_location' }),
    ]) {
      if (svVarNames.has(v.name.trim().toLowerCase())) { variables.push(v.name); continue; } // already present (resume)
      try {
        await this.q(() => this.createGtmVariable(accountId, boot.container.containerId, boot.workspaceId, v as unknown as Record<string, unknown>));
        variables.push(v.name);
      } catch {
        /* non-fatal — server tags/triggers can reference them once created manually */
      }
    }

    let serverUrlSet = false;
    let webWired: { tagId: string; name: string } | null = null;
    let webDedup: { uniqueEventIdVariable: string; eventIdWired: boolean } | null = null;
    const webNonGa4: Array<{ kind: string; name: string; detail: string }> = [];
    const url = serverUrl?.trim();

    // Record the server URL on the NEW server container — independent of the web-container scan below,
    // so a snapshot failure never drops a URL the user provided. Best-effort (the container is already
    // created; this only records config).
    if (url) {
      try {
        await this.q(() => this.setServerContainerTaggingUrl(accountId, boot.container.containerId, [url]));
        serverUrlSet = true;
      } catch {
        /* non-fatal — the user can set it later with set_server_container_tagging_url */
      }
    }

    // Enumerate the web container to (a) list the non-GA4 conversion tags needing a server-side tag by
    // hand, and (b) find its Google tag to point at the server. Best-effort and separate from the
    // URL-record above.
    try {
      const webWs = await this.q(() => this.defaultWorkspaceId(accountId, webContainerId));
      const snap = await this.q(() => this.getGtmContainerSnapshot(accountId, webContainerId, webWs));
      for (const t of snap.tags) {
        if (t.type === 'awct') {
          const convId = String((t.parameter.find((p) => (p as { key?: string }).key === 'conversionId') as { value?: unknown })?.value ?? '');
          webNonGa4.push({ kind: 'Google Ads conversion', name: t.name, detail: convId ? `conversionId ${convId}` : 'conversion tag' });
        } else if (t.type === 'sp') {
          webNonGa4.push({ kind: 'Floodlight sales', name: t.name, detail: 'Floodlight tag' });
        }
      }
      const meta = detectMetaTags(snap);
      for (const m of meta.metaTags) {
        webNonGa4.push({ kind: 'Meta pixel', name: m.name, detail: m.ecommerceEvents.length ? `events: ${m.ecommerceEvents.join(', ')}` : 'pixel' });
      }
      if (url) {
        const googtag = snap.tags.find((t) => t.type === 'googtag');
        if (googtag) {
          // Browser↔server dedup (reference pattern): a Unique Event ID variable on the web side,
          // sent as event_id on every GA4 hit; the server reads it back (ed - event_id) into CAPI
          // tags so Meta/TikTok dedup the browser-pixel copy. Best-effort — if the gallery import
          // fails we still wire the server URL alone.
          let dedupConfig: Array<{ key: string; value: string }> | undefined;
          try {
            const tpl = await this.q(() => this.importGalleryTemplate(accountId, webContainerId, webWs, 'stape-io', 'unique-event-id-variable'));
            const varName = 'Unique Event ID';
            const existing = snap.variables.find((v) => v.name.trim().toLowerCase() === varName.toLowerCase());
            if (!existing && tpl.type) {
              await this.q(() => this.createGtmVariable(accountId, webContainerId, webWs, { name: varName, type: tpl.type, parameter: [] }));
            }
            dedupConfig = [{ key: 'event_id', value: `{{${varName}}}` }];
            webDedup = { uniqueEventIdVariable: varName, eventIdWired: true };
          } catch {
            webDedup = null;
          }
          const res = await this.q(() => this.setWebServerContainerUrl(accountId, webContainerId, webWs, googtag.tagId, url, dedupConfig));
          webWired = { tagId: res.tagId, name: res.name };
        }
      }
    } catch {
      /* non-fatal: the server container (and its URL) are done; the scan/web-wire is a convenience */
    }

    return {
      serverContainer: boot.container,
      workspaceId: boot.workspaceId,
      measurementId,
      created: { client: boot.client.name, trigger: boot.trigger.name, serverTag: boot.serverTag.name, gtmClient, variables },
      serverUrlSet,
      webWired,
      webDedup,
      webNonGa4,
    };
  }

  /** Generous quota-retry for the BATCH orchestrators (funnel + server setup). A 429 backs off
   *  (2s, 4s, … 60s cap, up to 6 retries) and the SAME sub-call resumes, so the one-shot flows
   *  pace themselves under GTM's ~15 queries/minute limit instead of failing hard. Non-quota
   *  errors throw immediately. Because each sub-call is wrapped individually, backoff never
   *  re-runs already-completed work. */
  private q<T>(fn: () => Promise<T>): Promise<T> {
    return withQuotaRetry(fn, { maxRetries: 6, baseDelayMs: 2_000, maxDelayMs: 60_000 });
  }

  /** ONE-SHOT web GA4 ecommerce funnel: for each funnel event, a Custom Event trigger
   *  ("CE - <event>", reused by name) + a GA4 event tag with the native "Send Ecommerce data" flag
   *  (forwards the WHOLE dataLayer ecommerce object — items/value/currency/transaction_id — no
   *  per-param variables needed). Also creates the ecommerce dataLayer variables (dlv - ecommerce.*)
   *  downstream Ads/Meta tags read. Idempotent: existing same-named tags/triggers/variables are
   *  skipped, so re-running completes a partial setup instead of erroring. Every GTM call is
   *  quota-retried, so the whole funnel completes even when it runs into the per-minute limit. */
  async setupEcommerceFunnel(
    accountId: string,
    containerId: string,
    workspaceId: string,
    measurementId: string,
    events: string[]
  ): Promise<{ created: { variables: string[]; triggers: string[]; tags: string[] }; skipped: string[] }> {
    const [tags, triggers, variables] = await Promise.all([
      this.q(() => this.listGtmTags(accountId, containerId, workspaceId)),
      this.q(() => this.listGtmTriggers(accountId, containerId, workspaceId)),
      this.q(() => this.listGtmVariables(accountId, containerId, workspaceId)),
    ]);
    const tagNames = new Set(tags.map((t) => t.name.trim().toLowerCase()));
    const trigByName = new Map(triggers.map((t) => [t.name.trim().toLowerCase(), t.triggerId]));
    const varNames = new Set(variables.map((v) => v.name.trim().toLowerCase()));
    const created = { variables: [] as string[], triggers: [] as string[], tags: [] as string[] };
    const skipped: string[] = [];
    for (const v of buildEcommerceDlvVariables()) {
      if (varNames.has(v.name.trim().toLowerCase())) { skipped.push(v.name); continue; }
      await this.q(() => this.createGtmVariable(accountId, containerId, workspaceId, v as unknown as Record<string, unknown>));
      created.variables.push(v.name);
    }
    const title = (ev: string): string => ev.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
    for (const ev of events) {
      // Key the skip-check on the SANITIZED name the builder actually stores, so a custom event
      // with ':'/'<'/'>'/double-space can't diverge from the stored name and duplicate on retry.
      const trigName = sanitizeName(`CE - ${ev}`);
      let triggerId = trigByName.get(trigName.toLowerCase());
      if (!triggerId) {
        const tr = await this.q(() => this.createGtmTrigger(accountId, containerId, workspaceId, buildTrigger({ name: trigName, kind: 'custom_event', eventName: ev }) as unknown as Record<string, unknown>));
        triggerId = String((tr as { triggerId?: string }).triggerId ?? '');
        created.triggers.push(trigName);
        trigByName.set(trigName.toLowerCase(), triggerId);
      }
      const tagName = sanitizeName(`GA4 - Event - ${title(ev)} Tag`);
      if (tagNames.has(tagName.toLowerCase())) { skipped.push(tagName); continue; }
      await this.q(() => this.createGtmTag(accountId, containerId, workspaceId, buildGa4EventTag({
        name: tagName, measurementId, eventName: ev, sendEcommerceData: true,
        firingTriggerId: triggerId ? [triggerId] : undefined,
      }) as unknown as Record<string, unknown>));
      created.tags.push(tagName);
    }
    return { created, skipped };
  }

  /** ONE-SHOT server-side ecommerce funnel (on a SERVER container): per event, a per-event server
   *  trigger ("ga4 - <event>", {{_event}} equals + {{Client Name}} = GA4, reused by name) + a GA4
   *  server tag relaying that event; optionally a Google Ads conversion server tag per event that has
   *  a conversion label. Enables the Client Name built-in. Idempotent by name. */
  async setupServerEcommerceFunnel(
    accountId: string,
    containerId: string,
    workspaceId: string,
    measurementId: string,
    events: string[],
    ads?: { conversionId: string; labels: Array<{ event: string; conversionLabel: string }> }
  ): Promise<{ created: { triggers: string[]; tags: string[] }; skipped: string[] }> {
    try {
      await this.q(() => this.enableGtmBuiltInVariables(accountId, containerId, workspaceId, ['clientName']));
    } catch { /* non-fatal — the trigger still matches without the scope resolving */ }
    const [tags, triggers] = await Promise.all([
      this.q(() => this.listGtmTags(accountId, containerId, workspaceId)),
      this.q(() => this.listGtmTriggers(accountId, containerId, workspaceId)),
    ]);
    const tagNames = new Set(tags.map((t) => t.name.trim().toLowerCase()));
    const trigByName = new Map(triggers.map((t) => [t.name.trim().toLowerCase(), t.triggerId]));
    const created = { triggers: [] as string[], tags: [] as string[] };
    const skipped: string[] = [];
    const title = (ev: string): string => ev.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
    const labelFor = new Map((ads?.labels ?? []).map((l) => [l.event, l.conversionLabel]));
    for (const ev of events) {
      // Sanitized skip-keys — see setupEcommerceFunnel; a custom event must not slip past the check.
      const trigName = sanitizeName(`ga4 - ${ev}`);
      let triggerId = trigByName.get(trigName.toLowerCase());
      if (!triggerId) {
        const tr = await this.q(() => this.createGtmTrigger(accountId, containerId, workspaceId, buildServerEventTrigger(trigName, ev, 'GA4') as unknown as Record<string, unknown>));
        triggerId = String((tr as { triggerId?: string }).triggerId ?? '');
        created.triggers.push(trigName);
        trigByName.set(trigName.toLowerCase(), triggerId);
      }
      const ftid = triggerId ? [triggerId] : undefined;
      const ga4Name = sanitizeName(`GA4 - ${title(ev)} Tag (Server)`);
      if (tagNames.has(ga4Name.toLowerCase())) skipped.push(ga4Name);
      else {
        await this.q(() => this.createGtmTag(accountId, containerId, workspaceId, buildGa4ServerTag(ga4Name, measurementId, ev, ftid) as unknown as Record<string, unknown>));
        created.tags.push(ga4Name);
      }
      const label = labelFor.get(ev);
      if (ads?.conversionId && label) {
        const adsName = sanitizeName(`Ads - Conversion - ${title(ev)} (Server)`);
        if (tagNames.has(adsName.toLowerCase())) skipped.push(adsName);
        else {
          await this.q(() => this.createGtmTag(accountId, containerId, workspaceId, buildAdsConversionServerTag(adsName, ads.conversionId, label, ftid) as unknown as Record<string, unknown>));
          created.tags.push(adsName);
        }
      }
    }
    return { created, skipped };
  }

  /** Post-install QA (READ-ONLY): run the tracking-setup checklist on a web container —
   *  and, when server coords are given, on its server container too — then live-check the
   *  tagging server endpoint (/healthy). The pure checklist logic lives in
   *  evaluateTrackingSetup (gtm-builders); this gathers RAW resources and adds the one
   *  check that needs the network. */
  async verifyTrackingSetup(
    accountId: string,
    containerId: string,
    workspaceId: string,
    opts?: {
      events?: string[];
      server?: { accountId: string; containerId: string; workspaceId: string };
    }
  ): Promise<TrackingSetupReport> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const rawTags = async (acct: string, cont: string, ws: string): Promise<Array<Record<string, unknown>>> => {
      const parent = `accounts/${acct}/containers/${cont}/workspaces/${ws}`;
      const tags = await collectPages(
        (pageToken) => gtm.accounts.containers.workspaces.tags.list({ parent, pageToken }),
        (r) => r.data.tag,
        (r) => r.data.nextPageToken
      );
      return tags as unknown as Array<Record<string, unknown>>;
    };
    const events = opts?.events && opts.events.length > 0 ? opts.events : [...GA4_ECOMMERCE_FUNNEL_EVENTS];

    const webTags = await rawTags(accountId, containerId, workspaceId);
    let server: { tags: Array<Record<string, unknown>>; clients: Array<{ name?: string; type?: string }>; taggingServerUrls: string[] } | null = null;
    if (opts?.server) {
      const sv = opts.server;
      const [tags, clients, container] = await Promise.all([
        rawTags(sv.accountId, sv.containerId, sv.workspaceId),
        this.listGtmClients(sv.accountId, sv.containerId, sv.workspaceId),
        gtm.accounts.containers.get({ path: `accounts/${sv.accountId}/containers/${sv.containerId}` }),
      ]);
      server = { tags, clients, taggingServerUrls: (container.data.taggingServerUrls ?? []).map(String) };
    }

    const report = evaluateTrackingSetup(webTags, events, server);

    // The one live check: is the tagging server actually answering?
    const firstUrl = server?.taggingServerUrls.find((u) => u && u.trim());
    if (firstUrl) {
      const health = await this.verifyServerEndpoint(firstUrl);
      const check: TrackingSetupCheck = health.ok
        ? { id: 'server_endpoint', label: 'Server: endpoint health', status: 'pass', detail: `${firstUrl} answered /healthy (HTTP ${health.status}).` }
        : { id: 'server_endpoint', label: 'Server: endpoint health', status: 'fail', detail: `${firstUrl} did not answer /healthy${health.status ? ` (HTTP ${health.status})` : ''}${health.error ? ` — ${health.error}` : ''}. The host may not be deployed.` };
      report.checks.push(check);
      if (check.status === 'pass') report.passed += 1;
      else {
        report.failures += 1;
        report.ok = false;
      }
    }
    return report;
  }

  /** Point a WEB Google tag at a server container (the web→server link): upsert
   *  server_container_url in the tag's configSettingsTable, preserving other settings.
   *  Read-modify-write; only valid on a Google tag (googtag). */
  async setWebServerContainerUrl(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    serverUrl: string,
    extraConfig?: Array<{ key: string; value: string }>
  ): Promise<{ tagId: string; name: string; serverContainerUrl: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
    const current = (await gtm.accounts.containers.workspaces.tags.get({ path })).data;
    if (current.type !== 'googtag') {
      throw new Error(`Tag ${tagId} is type "${current.type}", not a Google tag (googtag) — server_container_url is set on the web Google tag.`);
    }
    // Fold every config row into ONE update (server_container_url + any extras, e.g. the
    // event_id dedup parameter) so the tag is written once.
    const working = { ...current } as Record<string, unknown>;
    working.parameter = upsertGoogleTagConfig(working, 'server_container_url', serverUrl);
    for (const row of extraConfig ?? []) {
      working.parameter = upsertGoogleTagConfig(working, row.key, row.value);
    }
    const res = await gtm.accounts.containers.workspaces.tags.update({ path, requestBody: working });
    this.journal('tag', accountId, containerId, workspaceId, tagId, `${res.data.name ?? 'tag'} (#${tagId})`);
    return { tagId: res.data.tagId ?? tagId, name: res.data.name ?? '', serverContainerUrl: serverUrl };
  }

  /** Set the SERVER container's own Tagging Server URL(s) — the container-level
   *  `taggingServerUrls` field, which the GTM API CAN write (containers.update). Read-modify-
   *  write so the container's other fields (name, usageContext, fingerprint) are preserved.
   *  Records the URL in config only — it does NOT deploy the host at that URL. Rejects a
   *  non-server container (the field is server-only). */
  async setServerContainerTaggingUrl(
    accountId: string,
    containerId: string,
    serverUrls: string[]
  ): Promise<{ containerId: string; name: string; taggingServerUrls: string[] }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}`;
    const current = (await gtm.accounts.containers.get({ path })).data;
    if (!Array.isArray(current.usageContext) || !current.usageContext.some((u) => String(u).toLowerCase() === 'server')) {
      throw new Error(`Container ${containerId} is not a SERVER container (usageContext ${JSON.stringify(current.usageContext ?? [])}) — taggingServerUrls only applies to server containers.`);
    }
    const res = await gtm.accounts.containers.update({ path, requestBody: { ...current, taggingServerUrls: serverUrls } });
    return { containerId: res.data.containerId ?? containerId, name: res.data.name ?? '', taggingServerUrls: res.data.taggingServerUrls ?? [] };
  }

  /** Enable built-in variables (e.g. "clickUrl") in a workspace. Idempotent-ish:
   *  re-enabling an already-enabled one is tolerated by the caller. */
  async enableGtmBuiltInVariables(
    accountId: string,
    containerId: string,
    workspaceId: string,
    types: string[]
  ): Promise<string[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.built_in_variables.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      type: types,
    });
    return (res.data.builtInVariable ?? []).map((v) => v.type ?? '');
  }

  async deleteGtmTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string
  ): Promise<{ deleted: boolean; tagId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.tags.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
    });
    return { deleted: true, tagId };
  }

  async deleteGtmTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    triggerId: string
  ): Promise<{ deleted: boolean; triggerId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.triggers.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
    });
    return { deleted: true, triggerId };
  }

  async deleteGtmVariable(
    accountId: string,
    containerId: string,
    workspaceId: string,
    variableId: string
  ): Promise<{ deleted: boolean; variableId: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    await gtm.accounts.containers.workspaces.variables.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
    });
    return { deleted: true, variableId };
  }

  async createGtmTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    trigger: Record<string, unknown>
  ): Promise<{ triggerId: string; name: string; type: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.triggers.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: normalizeCustomEventTrigger(normalizeTimerTrigger(applyTriggerWaitDefaults(trigger))),
    });
    this.journal('trigger', accountId, containerId, workspaceId, res.data.triggerId ?? '', `${res.data.name ?? 'trigger'} (#${res.data.triggerId})`);
    return { triggerId: res.data.triggerId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** UPDATE a trigger IN PLACE (read-modify-write) — the GTM API supports this; no delete+recreate
   *  is needed, so tags keep referencing it. Sets the display `name` and/or, for a Custom Event
   *  trigger, its Event name (the {{_event}} match value, normalized to snake_case). */
  async updateGtmTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    triggerId: string,
    patch: { name?: string; eventName?: string }
  ): Promise<{ triggerId: string; name: string; type: string; customEventName: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`;
    const current = (await gtm.accounts.containers.workspaces.triggers.get({ path })).data;
    let body: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    if (patch.name && patch.name.trim()) body.name = patch.name.trim();
    if (patch.eventName !== undefined) body = setCustomEventName(body, patch.eventName);
    const res = await gtm.accounts.containers.workspaces.triggers.update({ path, requestBody: body });
    this.journal('trigger', accountId, containerId, workspaceId, res.data.triggerId ?? triggerId, `${res.data.name ?? 'trigger'} (#${triggerId})`);
    return {
      triggerId: res.data.triggerId ?? triggerId,
      name: res.data.name ?? '',
      type: res.data.type ?? '',
      customEventName: customEventNameOf(res.data as unknown as Record<string, unknown>),
    };
  }

  /**
   * Repair a CREATED tag's firing trigger to a corrected shape (the "Verify firing" fix). Snapshots
   * the container, finds the tag by name + its first firing trigger, then either rewrites that
   * trigger's conditions in place (it fires only this tag) or — if the trigger is shared by other
   * tags — creates a corrected trigger and re-binds ONLY this tag to it, leaving siblings alone.
   * Draft-only write; never publishes. `corrected` is a SuggestedTag-style trigger input.
   */
  async retargetTagTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagName: string,
    corrected: TriggerInput
  ): Promise<{ tagName: string; triggerId: string; mode: 'rewrite' | 'rebind'; triggerName: string }> {
    const snap = await this.getGtmContainerSnapshot(accountId, containerId, workspaceId);
    const plan = planTriggerRetarget(snap, tagName, corrected);
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const base = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const built = plan.built as unknown as Record<string, unknown>;

    if (plan.mode === 'rebind') {
      // The trigger fires other tags too — don't mutate it. Create a corrected one + rebind this tag.
      const newName = `${String(built.name ?? plan.tagName)} (verified fix)`;
      const nt = await this.createGtmTrigger(accountId, containerId, workspaceId, { ...built, name: newName });
      const tag = snap.tags.find((t) => t.tagId === plan.tagId);
      const newFiring = (tag?.firingTriggerId ?? []).map((id) => (id === plan.triggerId ? nt.triggerId : id));
      await this.updateGtmTag(accountId, containerId, workspaceId, plan.tagId, { firingTriggerId: newFiring });
      return { tagName: plan.tagName, triggerId: nt.triggerId, mode: 'rebind', triggerName: newName };
    }

    // Rewrite the trigger's scope conditions IN PLACE (read-modify-write) — keep its name/id so the
    // tag keeps firing on the same trigger; only the corrected condition arrays change.
    const path = `${base}/triggers/${plan.triggerId}`;
    const current = (await gtm.accounts.containers.workspaces.triggers.get({ path })).data as Record<string, unknown>;
    const body: Record<string, unknown> = { ...current };
    if (built.type) body.type = built.type;
    body.filter = built.filter ?? [];
    if (built.autoEventFilter !== undefined) body.autoEventFilter = built.autoEventFilter;
    if (built.customEventFilter !== undefined) body.customEventFilter = built.customEventFilter;
    const res = await gtm.accounts.containers.workspaces.triggers.update({ path, requestBody: applyTriggerWaitDefaults(body) });
    this.journal('trigger', accountId, containerId, workspaceId, plan.triggerId, `${res.data.name ?? plan.tagName} (#${plan.triggerId})`);
    return { tagName: plan.tagName, triggerId: plan.triggerId, mode: 'rewrite', triggerName: res.data.name ?? plan.tagName };
  }

  /**
   * Align a GA4 Event tag's Event Name to a value observed during verification (the "align event
   * name" fix — when the trigger fires a hit but under a different event name). Finds the gaawe tag
   * by name and updates its `eventName` template parameter via the RMW updateGtmTag merge, which
   * keeps every other setting. Draft-only; never publishes.
   */
  async setGa4TagEventName(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagName: string,
    eventName: string
  ): Promise<{ tagName: string; eventName: string }> {
    const ev = eventName.trim();
    if (!ev) throw new Error('Provide an event name to set.');
    const snap = await this.getGtmContainerSnapshot(accountId, containerId, workspaceId);
    const want = tagName.trim();
    const tag = snap.tags.find((t) => (t.name ?? '').trim() === want);
    if (!tag) throw new Error(`No tag named "${tagName}" in this workspace.`);
    if (tag.type !== 'gaawe') throw new Error(`"${tagName}" is not a GA4 Event tag (type "${tag.type}"), so it has no Event Name to align.`);
    await this.updateGtmTag(accountId, containerId, workspaceId, tag.tagId, { parameter: [{ type: 'template', key: 'eventName', value: ev }] });
    return { tagName: tag.name, eventName: ev };
  }

  async createGtmVariable(
    accountId: string,
    containerId: string,
    workspaceId: string,
    variable: Record<string, unknown>
  ): Promise<{ variableId: string; name: string; type: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.variables.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: variable,
    });
    this.journal('variable', accountId, containerId, workspaceId, res.data.variableId ?? '', `${res.data.name ?? 'variable'} (#${res.data.variableId})`);
    return { variableId: res.data.variableId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  /** Create the standard Meta CAPI EMQ Event Data variables (`ed - fbp/fbc/event_id/value/…`)
   *  in a SERVER container, so they can be mapped into the Conversions API tag's Event
   *  Parameters. Idempotent — skips any whose name already exists. */
  async createMetaEmqVariables(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ created: string[]; skipped: string[] }> {
    const existing = await this.listGtmVariables(accountId, containerId, workspaceId);
    const existingNames = new Set(existing.map((v) => v.name.trim().toLowerCase()));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const v of buildMetaEmqVariables()) {
      if (existingNames.has(v.name.trim().toLowerCase())) {
        skipped.push(v.name);
        continue;
      }
      await this.createGtmVariable(accountId, containerId, workspaceId, v as unknown as Record<string, unknown>);
      created.push(v.name);
    }
    return { created, skipped };
  }

  /** Idempotently create a set of variables (skip any whose name already exists). Shared by the
   *  EMQ / ecommerce variable-provisioning helpers so an auto-filled tag's references resolve. */
  private async createVariablesIfMissing(
    accountId: string,
    containerId: string,
    workspaceId: string,
    variables: Array<{ name: string }>
  ): Promise<{ created: string[]; skipped: string[] }> {
    const existing = await this.listGtmVariables(accountId, containerId, workspaceId);
    const existingNames = new Set(existing.map((v) => v.name.trim().toLowerCase()));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const v of variables) {
      if (existingNames.has(v.name.trim().toLowerCase())) {
        skipped.push(v.name);
        continue;
      }
      await this.createGtmVariable(accountId, containerId, workspaceId, v as unknown as Record<string, unknown>);
      created.push(v.name);
    }
    return { created, skipped };
  }

  /** Create the TikTok Events API EMQ Event Data variables (`ed - email_address/value/contents/…`)
   *  in a SERVER container, so they can be mapped into the TikTok CAPI tag's user_data + event
   *  properties. Idempotent. */
  async createTikTokEmqVariables(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ created: string[]; skipped: string[] }> {
    return this.createVariablesIfMissing(accountId, containerId, workspaceId, buildTikTokEmqVariables());
  }

  /** Create the ecommerce dataLayer variables (`dlv - ecommerce.value/currency/items/…`) in a WEB
   *  container, so an auto-filled Meta Pixel tag's Object Properties resolve. Idempotent. */
  async createEcommerceDlvVariables(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ created: string[]; skipped: string[] }> {
    return this.createVariablesIfMissing(accountId, containerId, workspaceId, buildEcommerceDlvVariables());
  }

  /** List the CUSTOM (community-gallery) templates imported into a workspace, with the tag TYPE
   *  code to use as a tag's `type` to build a tag from that template. A GALLERY template's type
   *  is `cvt_<galleryTemplateId>` (e.g. cvt_MRQN8); a locally-authored template's is
   *  `cvt_<containerId>_<templateId>`. */
  async listGtmTemplates(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<Array<{ templateId: string; name: string; type: string; galleryOwner: string; galleryRepository: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const tmpls = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.templates.list({ parent, pageToken }),
      (r) => r.data.template,
      (r) => r.data.nextPageToken
    );
    return tmpls.map((t) => ({
      templateId: t.templateId ?? '',
      name: t.name ?? '(unnamed)',
      type: customTemplateType(t, containerId),
      galleryOwner: t.galleryReference?.owner ?? '',
      galleryRepository: t.galleryReference?.repository ?? '',
    }));
  }

  /** Import a community-gallery template into a workspace (e.g. the Meta Pixel template:
   *  owner "facebook", repository "GoogleTagManager-WebTemplate-For-FacebookPixel"). The GTM
   *  API DOES support this (templates.import_from_gallery). Idempotent — if a template from the
   *  same owner/repository is already imported, returns it without re-importing. Returns the
   *  template + its tag TYPE code (use as a tag's `type` to build a tag from it). */
  async importGalleryTemplate(
    accountId: string,
    containerId: string,
    workspaceId: string,
    owner: string,
    repository: string,
    sha?: string
  ): Promise<{ templateId: string; name: string; type: string; imported: boolean }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
    const wantOwner = owner.trim().toLowerCase();
    const wantRepo = repository.trim().toLowerCase();
    const existing = (await this.listGtmTemplates(accountId, containerId, workspaceId)).find(
      (t) => t.galleryOwner.toLowerCase() === wantOwner && t.galleryRepository.toLowerCase() === wantRepo
    );
    if (existing) return { templateId: existing.templateId, name: existing.name, type: existing.type, imported: false };
    const res = await gtm.accounts.containers.workspaces.templates.import_from_gallery({
      parent,
      galleryOwner: owner,
      galleryRepository: repository,
      ...(sha ? { gallerySha: sha } : {}),
      acknowledgePermissions: true,
    });
    return {
      templateId: res.data.templateId ?? '',
      name: res.data.name ?? repository,
      type: customTemplateType(res.data, containerId),
      imported: true,
    };
  }

  /** Traffic baseline for the audit report over [startDate, endDate] (the data-quality window),
   *  compared to the immediately-prior window of the same length. Pulls sessions-by-date (total +
   *  peak day), device split, new-vs-returning, and top countries via the Data API. Read-only. */
  async getGa4Baseline(property: string, startDate: string, endDate: string): Promise<Ga4Baseline> {
    const DAY = 86400000;
    const sd = Date.parse(`${startDate}T00:00:00Z`);
    const ed = Date.parse(`${endDate}T00:00:00Z`);
    const span = Number.isFinite(sd) && Number.isFinite(ed) ? Math.max(1, Math.round((ed - sd) / DAY) + 1) : 1;
    const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const priorEndDate = ymd(sd - DAY);
    const priorStartDate = ymd(sd - span * DAY);
    const n = (v: string): number => Number(v) || 0;
    const pairs = (r: Ga4ReportResult): Array<{ name: string; sessions: number }> =>
      r.rows.map((x) => ({ name: x.dimensions[0] || '(not set)', sessions: n(x.metrics[0]) }));
    // Merge rows that map to the same display name (e.g. a literal "(not set)" AND an empty value
    // both become "(not set)") so they don't appear as duplicate lines downstream.
    const merge = (rows: Array<{ name: string; sessions: number }>): Array<{ name: string; sessions: number }> => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.name, (m.get(r.name) ?? 0) + r.sessions);
      return [...m].map(([name, sessions]) => ({ name, sessions }));
    };
    /** i-th metric of the single row of a no-dimension report (0=sessions, 1=keyEvents, 2=revenue). */
    const oneMetric = (r: Ga4ReportResult, i: number): number => (r.rows[0] ? n(r.rows[0].metrics[i] ?? '0') : 0);
    const byMetricDesc = [{ metric: { metricName: 'sessions' }, desc: true }];
    // Curated exact sessionSource hosts for AI/LLM-assistant referrals. Exact-match (inListFilter), not
    // "contains", to avoid false positives from brand/marketing domains (openai.com, anthropic.com) and
    // general search (bing.com). GA4's native "AI Assistant" channel (May 2026) misses Perplexity/Claude,
    // so this source list is the more complete read. Review quarterly — the set changes fast.
    const LLM_TRAFFIC_SOURCES = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'gemini.google.com', 'bard.google.com', 'copilot.microsoft.com', 'claude.ai', 'grok.com', 'deepseek.com', 'meta.ai', 'you.com', 'poe.com', 'phind.com', 'mistral.ai'];
    const byDateDesc = [{ dimension: { dimensionName: 'date' }, desc: true }];
    // Canonical GA4 recommended-ecommerce funnel, in order. Declared before the Promise.all so the
    // funnel query can filter to exactly these event names server-side.
    const FUNNEL_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
    // Sessions + the outcomes that should move with real growth (current and prior, one row each). Kept
    // to the three RELIABLE core metrics — this totals query is unguarded (its failure legitimately means
    // "baseline unavailable"), so no fragile metric may live here. Engagement is a SEPARATE guarded query
    // below, so an engagement-metric error can never wipe out the whole baseline (and all its tables).
    const TREND_METRICS = ['sessions', 'keyEvents', 'totalRevenue'];

    // Totals come from NO-dimension reports (one exact row each) — never the per-day report, which a
    // 100-row cap would truncate for windows > 100 days. The daily series is the per-day report ordered
    // NEWEST-FIRST at limit 1000, then reversed to chronological — so a custom range longer than the cap
    // keeps the MOST-RECENT days (what spike/trend cares about), not the oldest. Country = top-N (250).
    const emptyResult: Ga4ReportResult = { dimensionHeaders: [], metricHeaders: [], rows: [] };
    const [curTotal, priorTotal, byEngagement, byDate, byDevice, byNvR, byCountry, byChannelDate, byChannelPerf, byLandingPage, byDevicePerf, byGeoPerf, byFunnel, byLlmSource] = await Promise.all([
      this.runGa4Report({ property, startDate, endDate, dimensions: [], metrics: TREND_METRICS }),
      this.runGa4Report({ property, startDate: priorStartDate, endDate: priorEndDate, dimensions: [], metrics: TREND_METRICS }),
      // Engagement totals (0=userEngagementDuration sec, 1=engagementRate 0-1, 2=engagedSessionsPerUser).
      // Its OWN query with a catch: if any engagement metric errors for a property it degrades to 0 —
      // it must NEVER take the baseline (and every Section-6 table) down with it.
      this.runGa4Report({ property, startDate, endDate, dimensions: [], metrics: ['userEngagementDuration', 'engagementRate', 'engagedSessionsPerUser'] }).catch(() => emptyResult),
      // The dimensioned baseline slices are best-effort too — a single dimension failing (device, geo,
      // etc.) degrades that one block to empty, never the whole baseline.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['date'], metrics: ['sessions'], orderBys: byDateDesc, limit: '1000' }).catch(() => emptyResult),
      this.runGa4Report({ property, startDate, endDate, dimensions: ['deviceCategory'], metrics: ['sessions'] }).catch(() => emptyResult),
      this.runGa4Report({ property, startDate, endDate, dimensions: ['newVsReturning'], metrics: ['sessions'] }).catch(() => emptyResult),
      this.runGa4Report({ property, startDate, endDate, dimensions: ['country'], metrics: ['sessions'], orderBys: byMetricDesc, limit: '250' }).catch(() => emptyResult),
      // Per-channel daily sessions for the multi-line chart (newest-first, then aligned to the date axis).
      this.runGa4Report({ property, startDate, endDate, dimensions: ['date', 'sessionDefaultChannelGroup'], metrics: ['sessions'], orderBys: byDateDesc, limit: '5000' }).catch(() => emptyResult),
      // Per-channel PERFORMANCE: sessions + conversion rate + revenue + engagement (top channels by sessions).
      this.runGa4Report({ property, startDate, endDate, dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue', 'engagementRate'], orderBys: byMetricDesc, limit: '15' }).catch(() => emptyResult),
      // Top LANDING PAGES: same metric set, keyed on `landingPage` (path only — GA4 strips the query
      // string) so entry pages aggregate cleanly rather than fragmenting across ?utm= variants.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['landingPage'], metrics: ['sessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue', 'engagementRate'], orderBys: byMetricDesc, limit: '15' }).catch(() => emptyResult),
      // Per-DEVICE performance (deviceCategory): how each device type converts and spends. Dedicated
      // query — the byDevice query above stays session-only for the device-split bars/chart.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['deviceCategory'], metrics: ['sessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue', 'engagementRate'], orderBys: byMetricDesc, limit: '10' }).catch(() => emptyResult),
      // Top MARKETS performance (country): which geographies convert and spend. Dedicated query — the
      // byCountry query above stays session-only for the top-markets share line.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['country'], metrics: ['sessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue', 'engagementRate'], orderBys: byMetricDesc, limit: '15' }).catch(() => emptyResult),
      // Ecommerce funnel step reach: distinct USERS who fired each funnel event. totalUsers (not
      // eventCount, which inflates when a user adds several items). A server-side inListFilter returns
      // EXACTLY the funnel events (never truncated by event-name cardinality — a low-traffic purchase on
      // a 500+-event property still comes back); events with no reach are simply absent => 0 downstream.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['eventName'], metrics: ['totalUsers'], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } } }, limit: '10' }).catch(() => emptyResult),
      // AI/LLM-assistant referral performance: same metric set keyed on sessionSource, filtered to the
      // curated AI host list (exact inListFilter — never a broad contains). Empty on a site with no AI
      // referrals. NOTE: this is a systematic UNDERCOUNT (app/in-app browsers + copied links land in
      // Direct); the report says so.
      this.runGa4Report({ property, startDate, endDate, dimensions: ['sessionSource'], metrics: ['sessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue', 'engagementRate'], dimensionFilter: { filter: { fieldName: 'sessionSource', inListFilter: { values: LLM_TRAFFIC_SOURCES } } }, orderBys: byMetricDesc, limit: '20' }).catch(() => emptyResult),
    ]);
    // Build the per-step user counts. This is an event-COVERAGE funnel (distinct users who fired each
    // event at all in the window), NOT a strict sequential path — GA4's true ordered funnel is
    // UI/v1alpha-only. The report labels it as an approximation.
    const funnelUsers = new Map<string, number>();
    for (const r of byFunnel.rows) funnelUsers.set(r.dimensions[0] ?? '', n(r.metrics[0]));

    const sessions = oneMetric(curTotal, 0);
    const priorSessions = oneMetric(priorTotal, 0);
    const dailySessions = byDate.rows.map((r) => ({ date: r.dimensions[0] ?? '', sessions: n(r.metrics[0]) })).reverse();
    let peakDay: { date: string; sessions: number } | null = null;
    for (const d of dailySessions) if (!peakDay || d.sessions > peakDay.sessions) peakDay = { date: d.date, sessions: d.sessions };

    // Channel mix on the peak day, to attribute a spike to a platform (one extra single-day query).
    let peakDayChannels: Array<{ name: string; sessions: number }> | null = null;
    const pd = peakDay ? /^(\d{4})(\d{2})(\d{2})$/.exec(peakDay.date) : null;
    if (pd) {
      const dayIso = `${pd[1]}-${pd[2]}-${pd[3]}`;
      const chanRes = await this.runGa4Report({ property, startDate: dayIso, endDate: dayIso, dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'], orderBys: byMetricDesc, limit: '50' }).catch(() => null);
      if (chanRes) peakDayChannels = merge(pairs(chanRes)).sort((a, b) => b.sessions - a.sessions);
    }

    // Pivot date × channel into the top-5 channels' daily series, aligned to the dailySessions date axis.
    const chTotals = new Map<string, number>();
    const chByDate = new Map<string, Map<string, number>>();
    const coveredDates = new Set<string>();
    for (const row of byChannelDate.rows) {
      const date = row.dimensions[0] ?? '';
      const ch = row.dimensions[1] || '(not set)';
      const s = n(row.metrics[0]);
      chTotals.set(ch, (chTotals.get(ch) ?? 0) + s);
      coveredDates.add(date);
      let m = chByDate.get(ch);
      if (!m) {
        m = new Map();
        chByDate.set(ch, m);
      }
      m.set(date, (m.get(date) ?? 0) + s);
    }
    // Build the channel chart's axis from the dates the channel query ACTUALLY returned — never
    // fabricate 0s past a truncation point. A custom range longer than the 5000-row channel cap (~600
    // days) is truncated newest-first; when that happens the oldest covered date is partial, so drop it.
    const truncated = byChannelDate.rows.length >= 5000;
    const oldestCovered = truncated && coveredDates.size ? [...coveredDates].sort()[0] : null;
    const channelDateAxis = dailySessions.map((d) => d.date).filter((date) => coveredDates.has(date) && date !== oldestCovered);
    const channelDaily = [...chTotals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ch]) => ({ channel: ch, series: channelDateAxis.map((date) => ({ date, sessions: chByDate.get(ch)?.get(date) ?? 0 })) }));

    return {
      startDate,
      endDate,
      priorStartDate,
      priorEndDate,
      sessions,
      priorSessions,
      keyEvents: oneMetric(curTotal, 1),
      priorKeyEvents: oneMetric(priorTotal, 1),
      revenue: oneMetric(curTotal, 2),
      priorRevenue: oneMetric(priorTotal, 2),
      // "Average engagement time per session" has no direct GA4 metric — it is userEngagementDuration
      // (total engaged seconds, byEngagement idx 0) / sessions. Rate (idx 1) is 0-1; sessions/user is idx 2.
      avgEngagementSec: sessions > 0 ? oneMetric(byEngagement, 0) / sessions : 0,
      engagementRate: oneMetric(byEngagement, 1),
      engagedSessionsPerUser: oneMetric(byEngagement, 2),
      trendPct: priorSessions > 0 ? Math.round(((sessions - priorSessions) / priorSessions) * 100) : null,
      peakDay,
      dailySessions,
      peakDayChannels,
      channelDaily,
      devices: merge(pairs(byDevice)).sort((a, b) => b.sessions - a.sessions),
      newVsReturning: merge(pairs(byNvR)),
      topCountries: merge(pairs(byCountry)).sort((a, b) => b.sessions - a.sessions).slice(0, 5),
      channelPerformance: byChannelPerf.rows.map((r) => ({
        channel: r.dimensions[0] || '(not set)',
        sessions: n(r.metrics[0]),
        keyEvents: n(r.metrics[1]),
        convRate: Number(r.metrics[2]) || 0, // sessionKeyEventRate, 0-1
        revenue: n(r.metrics[3]),
        engagementRate: Number(r.metrics[4]) || 0, // 0-1
      })),
      landingPages: byLandingPage.rows.map((r) => ({
        page: r.dimensions[0] || '(not set)',
        sessions: n(r.metrics[0]),
        keyEvents: n(r.metrics[1]),
        convRate: Number(r.metrics[2]) || 0, // sessionKeyEventRate, 0-1
        revenue: n(r.metrics[3]),
        engagementRate: Number(r.metrics[4]) || 0, // 0-1
      })),
      devicePerformance: byDevicePerf.rows.map((r) => ({
        device: r.dimensions[0] || '(not set)',
        sessions: n(r.metrics[0]),
        keyEvents: n(r.metrics[1]),
        convRate: Number(r.metrics[2]) || 0, // sessionKeyEventRate, 0-1
        revenue: n(r.metrics[3]),
        engagementRate: Number(r.metrics[4]) || 0, // 0-1
      })),
      geoPerformance: byGeoPerf.rows.map((r) => ({
        country: r.dimensions[0] || '(not set)',
        sessions: n(r.metrics[0]),
        keyEvents: n(r.metrics[1]),
        convRate: Number(r.metrics[2]) || 0, // sessionKeyEventRate, 0-1
        revenue: n(r.metrics[3]),
        engagementRate: Number(r.metrics[4]) || 0, // 0-1
      })),
      llmTraffic: byLlmSource.rows.map((r) => ({
        source: r.dimensions[0] || '(not set)',
        sessions: n(r.metrics[0]),
        keyEvents: n(r.metrics[1]),
        convRate: Number(r.metrics[2]) || 0, // sessionKeyEventRate, 0-1
        revenue: n(r.metrics[3]),
        engagementRate: Number(r.metrics[4]) || 0, // 0-1
      })),
      funnelSteps: FUNNEL_EVENTS.map((event) => ({ event, users: funnelUsers.get(event) ?? 0 })),
    };
  }

  /** Weekly user-RETENTION cohorts via the Data API cohortSpec: the last ~8 complete Sun-Sat acquisition
   *  weeks, each followed for 4 forward weeks (cohortActiveUsers). Retention is forward-looking, so this
   *  uses its OWN backward window (NOT the audit window) — cohortSpec also forbids report-level
   *  dateRanges. Returns per-cohort week-0 size + weekly active counts + how many weeks are mature; the
   *  pure engine turns that into an honest headline. Read-only. Returns null on failure (best-effort). */
  async getGa4RetentionCohorts(property: string): Promise<RetentionCohort[] | null> {
    try {
      const plan = planRetentionCohorts(new Date().toISOString().slice(0, 10), 8, 4, 2);
      if (plan.cohorts.length === 0) return null;
      const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
      const data = analyticsdata({ version: 'v1beta', auth });
      const res = await data.properties.runReport({
        property,
        requestBody: {
          dimensions: [{ name: 'cohort' }, { name: 'cohortNthWeek' }],
          metrics: [{ name: 'cohortActiveUsers' }],
          // No report-level dateRanges: each cohort carries its own firstSessionDate range (required by
          // cohortSpec, and mixing the two is an API error). accumulate is omitted (unsupported in
          // runReport, and we want period-by-period active users anyway).
          cohortSpec: {
            cohorts: plan.cohorts.map((c) => ({ name: c.name, dimension: 'firstSessionDate', dateRange: { startDate: c.startDate, endDate: c.endDate } })),
            cohortsRange: { granularity: 'WEEKLY', startOffset: 0, endOffset: plan.forwardWeeks },
          },
        },
      });
      const rows = (res.data.rows ?? []).map((r) => ({
        dimensions: (r.dimensionValues ?? []).map((v) => v.value ?? ''),
        metrics: (r.metricValues ?? []).map((v) => v.value ?? ''),
      }));
      return parseRetentionRows(rows, plan);
    } catch {
      return null;
    }
  }

  /** eventName x eventCount for the window AND the prior equal window — for the per-event regression
   *  engine (a key event silently dropping to 0 = a broken tag). Read-only Data API. */
  async getGa4EventDeltas(property: string, startDate: string, endDate: string): Promise<Ga4EventDeltaInput> {
    const DAY = 86400000;
    const sd = Date.parse(`${startDate}T00:00:00Z`);
    const ed = Date.parse(`${endDate}T00:00:00Z`);
    const span = Number.isFinite(sd) && Number.isFinite(ed) ? Math.max(1, Math.round((ed - sd) / DAY) + 1) : 1;
    const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const priorEndDate = ymd(sd - DAY);
    const priorStartDate = ymd(sd - span * DAY);
    const byEvents = [{ metric: { metricName: 'eventCount' }, desc: true }];
    const [cur, prior] = await Promise.all([
      this.runGa4Report({ property, startDate, endDate, dimensions: ['eventName'], metrics: ['eventCount'], orderBys: byEvents, limit: '500' }),
      this.runGa4Report({ property, startDate: priorStartDate, endDate: priorEndDate, dimensions: ['eventName'], metrics: ['eventCount'], orderBys: byEvents, limit: '500' }),
    ]);
    const priorMap = new Map<string, number>();
    for (const r of prior.rows) priorMap.set(r.dimensions[0] ?? '', Number(r.metrics[0]) || 0);
    const seen = new Set<string>();
    const events: Ga4EventDeltaInput['events'] = cur.rows.map((r) => {
      const name = r.dimensions[0] ?? '';
      seen.add(name);
      return { name, count: Number(r.metrics[0]) || 0, priorCount: priorMap.get(name) ?? 0 };
    });
    // Events present in the prior window but absent now (count 0) — the drop-to-zero case.
    for (const [name, priorCount] of priorMap) if (!seen.has(name)) events.push({ name, count: 0, priorCount });
    return { events };
  }

  /** Ecommerce transaction integrity: the per-transaction purchase counts (top-N, for duplicate
   *  detection) + the TRUE "(not set)" share, whose denominator is a separate no-dimension
   *  ecommercePurchases total (NOT the sum of the capped top-N rows, which would overstate it on a
   *  store with many transaction ids). Read-only Data API. Caller sets hasEcommerce. */
  async getGa4Transactions(property: string, startDate: string, endDate: string): Promise<Omit<Ga4TransactionInput, 'hasEcommerce'>> {
    const [byId, totalRes] = await Promise.all([
      this.runGa4Report({
        property, startDate, endDate,
        dimensions: ['transactionId'], metrics: ['ecommercePurchases'],
        orderBys: [{ metric: { metricName: 'ecommercePurchases' }, desc: true }], limit: '250',
      }),
      this.runGa4Report({ property, startDate, endDate, dimensions: [], metrics: ['ecommercePurchases'] }),
    ]);
    const total = Number(totalRes.rows[0]?.metrics[0] ?? 0) || 0; // true purchase total (no top-N cap)
    let notSet = 0;
    const transactions: Ga4TransactionInput['transactions'] = [];
    for (const r of byId.rows) {
      const id = r.dimensions[0] ?? '';
      const purchases = Number(r.metrics[0]) || 0;
      if (id === '' || /\(not set\)/i.test(id)) notSet += purchases;
      else transactions.push({ id, purchases });
    }
    return { transactions, notSetShare: total > 0 ? Math.min(100, (notSet / total) * 100) : 0 };
  }

  async runGa4Report(input: {
    property: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    metrics: string[];
    /** Row cap (default '100'). Raise it for high-cardinality dimensions (date/country) so the
     *  report isn't silently truncated. */
    limit?: string;
    /** GA4 orderBys passthrough — pair with a small limit to fetch the top-N by a metric. */
    orderBys?: Array<{ metric?: { metricName: string }; dimension?: { dimensionName: string }; desc?: boolean }>;
    /** GA4 dimensionFilter passthrough — restrict rows server-side (e.g. an inListFilter on eventName,
     *  or a notExpression to EXCLUDE values like "(not set)") so an EXACT target set comes back, never
     *  sampled from a truncated top-N. */
    dimensionFilter?: {
      filter?: { fieldName?: string; inListFilter?: { values?: string[]; caseSensitive?: boolean }; stringFilter?: { value?: string } };
      notExpression?: { filter?: { fieldName?: string; inListFilter?: { values?: string[]; caseSensitive?: boolean }; stringFilter?: { value?: string } } };
    };
  }): Promise<Ga4ReportResult> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const res = await data.properties.runReport({
      property: input.property,
      requestBody: {
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        dimensions: input.dimensions.map((name) => ({ name })),
        metrics: input.metrics.map((name) => ({ name })),
        ...(input.orderBys ? { orderBys: input.orderBys } : {}),
        ...(input.dimensionFilter ? { dimensionFilter: input.dimensionFilter } : {}),
        limit: input.limit ?? '100',
      },
    });
    return {
      dimensionHeaders: (res.data.dimensionHeaders ?? []).map((h) => h.name ?? ''),
      metricHeaders: (res.data.metricHeaders ?? []).map((h) => h.name ?? ''),
      rows: (res.data.rows ?? []).map((r) => ({
        dimensions: (r.dimensionValues ?? []).map((v) => v.value ?? ''),
        metrics: (r.metricValues ?? []).map((v) => v.value ?? ''),
      })),
    };
  }

  /** DATA-PRESENCE probe per registered custom dimension, for the dead-custom-dimension audit. One
   *  minimal Data API report per EVENT/USER-scoped dimension over a WIDE 90-day window — GA4 never
   *  backfills, so a short window would falsely flag low-frequency dimensions. `hasData` is true only
   *  when a real (non-"(not set)") value came back with a non-zero metric. ITEM-scoped and unrecognised-
   *  scope dimensions are left `checked:false` (inconclusive — item metrics + non-ecommerce properties
   *  are a false-positive minefield); a query error/throttle is also `checked:false`, NEVER flagged dead.
   *  Batched to stay under GA4's per-property concurrent-request limit. Read-only. */
  async getGa4CustomDimensionUsage(
    property: string,
    dims: Array<{ parameterName: string; displayName: string; scope: string }>
  ): Promise<Array<{ parameterName: string; displayName: string; scope: string; hasData: boolean; checked: boolean }>> {
    // Data API dimension prefix + a scope-COMPATIBLE metric per scope (a scope mismatch errors).
    const SCOPE: Record<string, { prefix: string; metric: string }> = {
      EVENT: { prefix: 'customEvent:', metric: 'eventCount' },
      USER: { prefix: 'customUser:', metric: 'activeUsers' },
    };
    // GA4 caps a standard property at 50 event + 25 user custom dimensions; 100 is generous headroom.
    // Dimensions beyond the cap are returned as `checked:false` (inconclusive) rather than silently
    // dropped, so the engine never treats an unchecked dimension as dead.
    const CAP = 100;
    const toQuery = dims.slice(0, CAP);
    const overflow = dims.slice(CAP).map((d) => ({ ...d, hasData: false, checked: false }));
    const out: Array<{ parameterName: string; displayName: string; scope: string; hasData: boolean; checked: boolean }> = [];
    const BATCH = 6; // well under the 10 concurrent-requests-per-property limit, leaving headroom
    for (let i = 0; i < toQuery.length; i += BATCH) {
      const chunk = toQuery.slice(i, i + BATCH);
      const settled = await Promise.all(
        chunk.map(async (d) => {
          const q = SCOPE[(d.scope || '').toUpperCase()];
          if (!q || !d.parameterName) return { ...d, hasData: false, checked: false };
          const field = `${q.prefix}${d.parameterName}`;
          try {
            // Ask GA4 directly for rows where this dimension holds a REAL value (exclude "(not set)"),
            // so detection never depends on how the dimension's values rank by volume. keepEmptyRows is
            // false by default, so any returned row is a populated value with a non-zero metric => live.
            const res = await this.runGa4Report({
              property,
              startDate: '90daysAgo',
              endDate: 'today',
              dimensions: [field],
              metrics: [q.metric],
              dimensionFilter: { notExpression: { filter: { fieldName: field, inListFilter: { values: ['(not set)'], caseSensitive: false } } } },
              limit: '5',
            });
            const hasData = res.rows.some((r) => (r.dimensions[0] ?? '').trim() !== '');
            return { ...d, hasData, checked: true };
          } catch {
            return { ...d, hasData: false, checked: false };
          }
        })
      );
      out.push(...settled);
    }
    return [...out, ...overflow];
  }

  /** Which of the given event names are actually being sent (present with a non-zero count) over the
   *  window — one Data API report filtered to EXACTLY those names (inListFilter), so it is never
   *  truncated by event-name cardinality. Used for the recommended-events coverage check. Read-only. */
  async getGa4PresentEvents(property: string, startDate: string, endDate: string, eventNames: string[]): Promise<string[]> {
    if (eventNames.length === 0) return [];
    const res = await this.runGa4Report({
      property,
      startDate,
      endDate,
      dimensions: ['eventName'],
      metrics: ['eventCount'],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: eventNames } } },
      limit: '100',
    });
    const present = new Set<string>();
    for (const r of res.rows) {
      const name = (r.dimensions[0] ?? '').trim();
      if (name && (Number(r.metrics[0]) || 0) > 0) present.add(name);
    }
    return [...present];
  }

  /** Session counts by channel group and by source/medium over a window — either the last `days`
   *  (default 28) or an explicit { startDate, endDate } custom range — for the pure data-quality
   *  engine. Read-only (analytics.readonly via the Data API). */
  /** Resolve a data-quality/campaign window to EXPLICIT { startDate, endDate } (YYYY-MM-DD) plus the
   *  inclusive day count. A trailing-N-days number resolves "today" in the PROPERTY's timezone (UTC
   *  fallback) so the window matches GA4's day boundaries; an explicit range is queried verbatim (so the
   *  displayed range == the queried range). Shared by getGa4DataQuality and getGa4CampaignPerformance. */
  private async resolveGa4Window(
    property: string,
    window: number | { startDate: string; endDate: string }
  ): Promise<{ startDate: string; endDate: string; windowDays: number; todayYmd?: string; createdYmd?: string }> {
    if (typeof window === 'object') {
      const startDate = window.startDate;
      const endDate = window.endDate;
      const a = Date.parse(`${startDate}T00:00:00Z`);
      const b = Date.parse(`${endDate}T00:00:00Z`);
      const windowDays = Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, Math.round((b - a) / 86400000) + 1) : 0;
      // Custom range: createTime is left undefined (the new-property fragmentation guard simply doesn't apply).
      return { startDate, endDate, windowDays };
    }
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    // Single admin.properties.get supplies BOTH the timezone (for day boundaries) and createTime (for the
    // brand-new-property fragmentation guard) — no extra API call.
    const prop = await admin.properties.get({ name: property }).then((r) => r.data).catch(() => null);
    const tz = prop?.timeZone || 'UTC';
    const createdYmd = prop?.createTime ? prop.createTime.slice(0, 10) : undefined;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const todayYmd = `${part('year')}-${part('month')}-${part('day')}`;
    const { startDate, endDate } = windowDates(todayYmd, window);
    return { startDate, endDate, windowDays: window, todayYmd, createdYmd };
  }

  async getGa4DataQuality(
    property: string,
    window: number | { startDate: string; endDate: string } = 28
  ): Promise<DataQualityCounts> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const { startDate, endDate, windowDays, todayYmd, createdYmd } = await this.resolveGa4Window(property, window);
    const run = async (dimension: string, ordered: boolean) => {
      const res = await data.properties.runReport({
        property,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: dimension }],
          metrics: [{ name: 'sessions' }],
          // Source/medium can have a long tail — order by sessions so the top
          // (incl. any large "(not set)" bucket) is captured within the limit.
          ...(ordered ? { orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] } : {}),
          limit: '250',
        },
      });
      return (res.data.rows ?? []).map((r) => ({
        name: r.dimensionValues?.[0]?.value ?? '',
        sessions: Number(r.metricValues?.[0]?.value ?? 0),
      }));
    };
    // BEST-EFFORT extra signals for the new detectors (referral/ghost spam, non-production hostnames,
    // identity fragmentation). Each is wrapped so a failure yields `undefined` — the engine skips that
    // check rather than throwing — and none of them can break the core channel/source/total queries.
    const hostnamesQ = this.runGa4Report({
      property,
      startDate,
      endDate,
      dimensions: ['hostName'],
      metrics: ['sessions'],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '100',
    })
      .then((r) => r.rows.map((row) => ({ name: row.dimensions[0] ?? '', sessions: Number(row.metrics[0]) || 0 })))
      .catch(() => undefined);
    const sourcesQ = this.runGa4Report({
      property,
      startDate,
      endDate,
      dimensions: ['sessionSource'],
      metrics: ['sessions', 'engagedSessions'],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '100',
    })
      .then((r) =>
        r.rows.map((row) => ({
          name: row.dimensions[0] ?? '',
          sessions: Number(row.metrics[0]) || 0,
          engagedSessions: Number(row.metrics[1]) || 0,
        }))
      )
      .catch(() => undefined);
    const newVsReturningQ = this.runGa4Report({
      property,
      startDate,
      endDate,
      dimensions: ['newVsReturning'],
      metrics: ['sessions'],
    })
      .then((r) => r.rows.map((row) => ({ name: row.dimensions[0] ?? '', sessions: Number(row.metrics[0]) || 0 })))
      .catch(() => undefined);
    // Use the EXACT total from a no-dimension sessions query — the same query the baseline uses — so
    // the two never disagree in the report. (Summing a dimensioned report can drift from the true
    // total via GA4's metric estimation; fall back to the channel sum only if the total query is empty.)
    const totalResQ = data.properties.runReport({
      property,
      requestBody: { dateRanges: [{ startDate, endDate }], metrics: [{ name: 'sessions' }], limit: '1' },
    });
    const [channelGroups, sourceMediums, totalRes, hostnames, sources, newVsReturning] = await Promise.all([
      run('sessionDefaultChannelGroup', false),
      run('sessionSourceMedium', true),
      totalResQ,
      hostnamesQ,
      sourcesQ,
      newVsReturningQ,
    ]);
    const totalSessions =
      Number(totalRes.data.rows?.[0]?.metricValues?.[0]?.value ?? 0) || channelGroups.reduce((s, c) => s + c.sessions, 0);
    return { totalSessions, channelGroups, sourceMediums, windowDays, startDate, endDate, todayYmd, hostnames, sources, newVsReturning, propertyCreatedYmd: createdYmd };
  }

  /** Per-campaign performance (sessions, key events, revenue, engagement) over a window — either the last
   *  `days` (default 28) or an explicit { startDate, endDate } custom range — for the pure campaign ranker.
   *  totalSessions comes from an exact no-dimension query (falls back to the row sum). Read-only. */
  async getGa4CampaignPerformance(
    property: string,
    window: number | { startDate: string; endDate: string } = 28
  ): Promise<Ga4CampaignInput> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const { startDate, endDate, windowDays } = await this.resolveGa4Window(property, window);
    // The campaign query goes through data.properties.runReport DIRECTLY (not the runGa4Report helper, which
    // drops response metadata) so we can read the property's currencyCode from res.data.metadata and label
    // revenue correctly instead of hardcoding '$'.
    const [campaignRes, totalReport] = await Promise.all([
      data.properties.runReport({
        property,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'sessionCampaignName' }],
          // transactions = real purchase count, fetched alongside keyEvents so the report can show
          // "key events" and "purchases" side by side instead of letting key-event counts read as sales.
          metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }, { name: 'engagementRate' }, { name: 'transactions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: '50',
        },
      }),
      this.runGa4Report({ property, startDate, endDate, dimensions: [], metrics: ['sessions'], limit: '1' }).catch(
        () => null
      ),
    ]);
    const rows = (campaignRes.data.rows ?? []).map((r) => ({
      campaign: r.dimensionValues?.[0]?.value ?? '',
      sessions: Number(r.metricValues?.[0]?.value) || 0,
      keyEvents: Number(r.metricValues?.[1]?.value) || 0,
      revenue: Number(r.metricValues?.[2]?.value) || 0,
      engagementRate: Number(r.metricValues?.[3]?.value) || 0,
      purchases: Number(r.metricValues?.[4]?.value) || 0,
    }));
    const currencyCode = campaignRes.data.metadata?.currencyCode || undefined;
    const totalSessions =
      Number(totalReport?.rows?.[0]?.metrics?.[0] ?? 0) || rows.reduce((s, r) => s + r.sessions, 0);
    return { rows, totalSessions, windowDays, startDate, endDate, currencyCode };
  }

  /** Every GA4 WEB-stream measurement id (G-XXXX) the user can access, with its
   *  property — walks accounts → properties → data streams. Scope to one GA4
   *  account with `account` (e.g. "accounts/123") to bound the calls. Used to
   *  cross-check the ids configured in a GTM container. Read-only. */
  async listGa4MeasurementIds(
    account?: string
  ): Promise<Array<{ measurementId: string; property: string; propertyDisplayName: string; streamDisplayName: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });

    // Paginate the account walk (accountSummaries.list caps at pageSize 200) so
    // a user with many GA4 accounts doesn't get a truncated set — which would
    // make valid measurement ids on dropped accounts cross-check as "not found".
    const accounts = account
      ? [account]
      : (
          await collectPages(
            (pageToken) => admin.accountSummaries.list({ pageSize: 200, pageToken }),
            (r) => r.data.accountSummaries,
            (r) => r.data.nextPageToken
          )
        )
          .map((sx) => sx.account ?? '')
          .filter(Boolean);

    const out: Array<{ measurementId: string; property: string; propertyDisplayName: string; streamDisplayName: string }> = [];
    for (const acct of accounts) {
      const properties = await collectPages(
        (pageToken) => admin.properties.list({ filter: `parent:${acct}`, pageToken }),
        (r) => r.data.properties,
        (r) => r.data.nextPageToken
      );
      for (const p of properties) {
        const propertyName = p.name ?? '';
        if (!propertyName) continue;
        // Per-property isolation: a property the user can list but can't read
        // streams on (or a transient error) skips that property instead of
        // sinking the whole multi-property cross-check.
        const streams = await collectPages(
          (pageToken) => admin.properties.dataStreams.list({ parent: propertyName, pageToken }),
          (r) => r.data.dataStreams,
          (r) => r.data.nextPageToken
        ).catch(() => []);
        for (const stream of streams) {
          const mid = stream.webStreamData?.measurementId;
          if (mid) {
            out.push({
              measurementId: mid,
              property: propertyName,
              propertyDisplayName: p.displayName ?? '(unnamed)',
              streamDisplayName: stream.displayName ?? '(unnamed)',
            });
          }
        }
      }
    }
    return out;
  }

  // ── GA4 read-only config inspection (analytics.readonly scope) ─────────────

  /** Property details: name, time zone, currency, industry, service level. */
  async getGa4PropertyDetails(property: string): Promise<{
    property: string;
    displayName: string;
    timeZone: string;
    currencyCode: string;
    industryCategory: string;
    serviceLevel: string;
    parent: string;
    createTime: string;
  }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.get({ name: property });
    return {
      property,
      displayName: res.data.displayName ?? '',
      timeZone: res.data.timeZone ?? '',
      currencyCode: res.data.currencyCode ?? '',
      industryCategory: res.data.industryCategory ?? '',
      serviceLevel: res.data.serviceLevel ?? '',
      parent: res.data.parent ?? '',
      createTime: res.data.createTime ?? '',
    };
  }

  /** The key events (conversions) configured on a property, by name. */
  async listGa4KeyEvents(
    property: string
  ): Promise<Array<{ eventName: string; countingMethod: string; custom: boolean }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const items = await collectPages(
      (pageToken) => admin.properties.keyEvents.list({ parent: property, pageToken }),
      (r) => r.data.keyEvents,
      (r) => r.data.nextPageToken
    );
    return items.map((k) => ({
      eventName: k.eventName ?? '',
      countingMethod: k.countingMethod ?? '',
      custom: k.custom ?? false,
    }));
  }

  /** Configured audiences (remarketing / segmentation): display name, description,
   *  membership window, ads-personalization flag, and filter-clause count.
   *  Audiences live only on the v1alpha Admin surface. */
  async listGa4Audiences(
    property: string
  ): Promise<
    Array<{
      name: string;
      displayName: string;
      description: string;
      membershipDurationDays: number;
      adsPersonalizationEnabled: boolean;
      filterClauseCount: number;
    }>
  > {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    const items = await collectPages(
      (pageToken) => adminAlpha.properties.audiences.list({ parent: property, pageToken }),
      (r) => r.data.audiences,
      (r) => r.data.nextPageToken
    );
    return items.map((a) => ({
      name: a.name ?? '',
      displayName: a.displayName ?? '(unnamed)',
      description: a.description ?? '',
      membershipDurationDays: Number(a.membershipDurationDays ?? 0),
      adsPersonalizationEnabled: a.adsPersonalizationEnabled ?? false,
      filterClauseCount: (a.filterClauses ?? []).length,
    }));
  }

  /** Reporting attribution model + conversion/Ads lookback windows. v1alpha. */
  async getGa4AttributionSettings(property: string): Promise<{
    reportingAttributionModel: string;
    acquisitionConversionEventLookbackWindow: string;
    otherConversionEventLookbackWindow: string;
    adsWebConversionDataExportScope: string;
  }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    const res = await adminAlpha.properties.getAttributionSettings({ name: `${property}/attributionSettings` });
    return {
      reportingAttributionModel: res.data.reportingAttributionModel ?? '',
      acquisitionConversionEventLookbackWindow: res.data.acquisitionConversionEventLookbackWindow ?? '',
      otherConversionEventLookbackWindow: res.data.otherConversionEventLookbackWindow ?? '',
      adsWebConversionDataExportScope: res.data.adsWebConversionDataExportScope ?? '',
    };
  }

  /** Google Signals state + consent (ads personalization / cross-device). v1alpha. */
  async getGa4GoogleSignals(property: string): Promise<{ state: string; consent: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    const res = await adminAlpha.properties.getGoogleSignalsSettings({ name: `${property}/googleSignalsSettings` });
    return { state: res.data.state ?? '', consent: res.data.consent ?? '' };
  }

  /** Measurement Protocol secrets per data stream — display names ONLY. The
   *  secret VALUE is never read or returned. Best-effort per stream. */
  async listGa4MeasurementProtocolSecrets(
    property: string
  ): Promise<Array<{ stream: string; streamDisplayName: string; secrets: Array<{ displayName: string }> }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const streams = await collectPages(
      (pageToken) => admin.properties.dataStreams.list({ parent: property, pageToken }),
      (r) => r.data.dataStreams,
      (r) => r.data.nextPageToken
    );
    const out: Array<{ stream: string; streamDisplayName: string; secrets: Array<{ displayName: string }> }> = [];
    for (const stream of streams) {
      if (!stream.name) continue;
      // Per-stream isolation so one unreadable stream doesn't sink the list.
      const secrets = await collectPages(
        (pageToken) => admin.properties.dataStreams.measurementProtocolSecrets.list({ parent: stream.name as string, pageToken }),
        (r) => r.data.measurementProtocolSecrets,
        (r) => r.data.nextPageToken
      ).catch(() => []);
      if (secrets.length === 0) continue;
      out.push({
        stream: stream.name,
        streamDisplayName: stream.displayName ?? '(unnamed)',
        // displayName only — secretValue is deliberately omitted (toSafeMpSecret).
        secrets: secrets.map(toSafeMpSecret),
      });
    }
    return out;
  }

  /** BigQuery export links: project + which exports are enabled. v1alpha. */
  async listGa4BigQueryLinks(
    property: string
  ): Promise<Array<{ name: string; project: string; dailyExportEnabled: boolean; streamingExportEnabled: boolean }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    const items = await collectPages(
      (pageToken) => adminAlpha.properties.bigQueryLinks.list({ parent: property, pageToken }),
      (r) => r.data.bigqueryLinks,
      (r) => r.data.nextPageToken
    );
    return items.map((l) => ({
      name: l.name ?? '',
      project: l.project ?? '',
      dailyExportEnabled: l.dailyExportEnabled ?? false,
      streamingExportEnabled: l.streamingExportEnabled ?? false,
    }));
  }

  /** Firebase project links. v1beta. */
  async listGa4FirebaseLinks(property: string): Promise<Array<{ name: string; project: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const items = await collectPages(
      (pageToken) => admin.properties.firebaseLinks.list({ parent: property, pageToken }),
      (r) => r.data.firebaseLinks,
      (r) => r.data.nextPageToken
    );
    return items.map((l) => ({ name: l.name ?? '', project: l.project ?? '' }));
  }

  /** Custom dimensions: parameter name, display name, scope. */
  async listGa4CustomDimensions(
    property: string
  ): Promise<Array<{ parameterName: string; displayName: string; scope: string; description: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const items = await collectPages(
      (pageToken) => admin.properties.customDimensions.list({ parent: property, pageToken }),
      (r) => r.data.customDimensions,
      (r) => r.data.nextPageToken
    );
    return items.map((d) => ({
      parameterName: d.parameterName ?? '',
      displayName: d.displayName ?? '',
      scope: d.scope ?? '',
      description: d.description ?? '',
    }));
  }

  /** Custom metrics: parameter name, display name, measurement unit, scope. */
  async listGa4CustomMetrics(
    property: string
  ): Promise<Array<{ parameterName: string; displayName: string; measurementUnit: string; scope: string; description: string }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const items = await collectPages(
      (pageToken) => admin.properties.customMetrics.list({ parent: property, pageToken }),
      (r) => r.data.customMetrics,
      (r) => r.data.nextPageToken
    );
    return items.map((m) => ({
      parameterName: m.parameterName ?? '',
      displayName: m.displayName ?? '',
      measurementUnit: m.measurementUnit ?? '',
      scope: m.scope ?? '',
      description: m.description ?? '',
    }));
  }

  /** Linked Google Ads accounts. */
  async listGa4GoogleAdsLinks(
    property: string
  ): Promise<Array<{ name: string; customerId: string; adsPersonalizationEnabled: boolean | null; canManageClients: boolean | null }>> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const items = await collectPages(
      (pageToken) => admin.properties.googleAdsLinks.list({ parent: property, pageToken }),
      (r) => r.data.googleAdsLinks,
      (r) => r.data.nextPageToken
    );
    return items.map((l) => ({
      name: l.name ?? '',
      customerId: l.customerId ?? '',
      adsPersonalizationEnabled: l.adsPersonalizationEnabled ?? null,
      canManageClients: l.canManageClients ?? null,
    }));
  }

  /** Data-retention settings (event retention + reset-on-activity). */
  async getGa4DataRetention(
    property: string
  ): Promise<{ eventDataRetention: string; resetUserDataOnNewActivity: boolean }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.getDataRetentionSettings({ name: `${property}/dataRetentionSettings` });
    return {
      eventDataRetention: res.data.eventDataRetention ?? '',
      resetUserDataOnNewActivity: res.data.resetUserDataOnNewActivity ?? false,
    };
  }

  /** Enhanced-measurement settings for ONE web data stream. dataStream is the
   *  full stream resource name (properties/123/dataStreams/456). v1alpha-only. */
  async getGa4EnhancedMeasurement(dataStream: string): Promise<{
    streamEnabled: boolean;
    scrollsEnabled: boolean;
    outboundClicksEnabled: boolean;
    siteSearchEnabled: boolean;
    videoEngagementEnabled: boolean;
    fileDownloadsEnabled: boolean;
    pageChangesEnabled: boolean;
    formInteractionsEnabled: boolean;
  }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const adminAlpha = analyticsadmin({ version: 'v1alpha', auth });
    const res = await adminAlpha.properties.dataStreams.getEnhancedMeasurementSettings({
      name: `${dataStream}/enhancedMeasurementSettings`,
    });
    const d = res.data;
    return {
      streamEnabled: d.streamEnabled ?? false,
      scrollsEnabled: d.scrollsEnabled ?? false,
      outboundClicksEnabled: d.outboundClicksEnabled ?? false,
      siteSearchEnabled: d.siteSearchEnabled ?? false,
      videoEngagementEnabled: d.videoEngagementEnabled ?? false,
      fileDownloadsEnabled: d.fileDownloadsEnabled ?? false,
      pageChangesEnabled: d.pageChangesEnabled ?? false,
      formInteractionsEnabled: d.formInteractionsEnabled ?? false,
    };
  }

  /** Real-time GA4 report (last 30 minutes). */
  async runGa4RealtimeReport(input: {
    property: string;
    dimensions: string[];
    metrics: string[];
  }): Promise<Ga4ReportResult> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const res = await data.properties.runRealtimeReport({
      property: input.property,
      requestBody: {
        dimensions: input.dimensions.map((name) => ({ name })),
        metrics: input.metrics.map((name) => ({ name })),
        limit: '100',
      },
    });
    return {
      dimensionHeaders: (res.data.dimensionHeaders ?? []).map((h) => h.name ?? ''),
      metricHeaders: (res.data.metricHeaders ?? []).map((h) => h.name ?? ''),
      rows: (res.data.rows ?? []).map((r) => ({
        dimensions: (r.dimensionValues ?? []).map((v) => v.value ?? ''),
        metrics: (r.metricValues ?? []).map((v) => v.value ?? ''),
      })),
    };
  }

  // ── GA4 Admin WRITES ───────────────────────────────────────────────────────
  // GA4 config CRUD. GA4 collections are uniform (create/patch/delete/archive),
  // so a generic resolver walks the dotted accessor path (e.g. "properties.keyEvents"
  // or "properties.dataStreams.measurementProtocolSecrets") on the versioned client.
  // Needs the analytics.edit scope (and analytics.manage.users for access bindings) —
  // the desktop grants both; each write is still human-approved (deletes/archives
  // via the two-step card).
  private ga4WriteSub(version: 'v1beta' | 'v1alpha', accessorPath: string): Ga4AdminSubResource {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    // The factory overloads on a LITERAL version, so branch rather than pass a union.
    let node: unknown = version === 'v1alpha' ? analyticsadmin({ version: 'v1alpha', auth }) : analyticsadmin({ version: 'v1beta', auth });
    for (const seg of accessorPath.split('.')) node = (node as Record<string, unknown>)[seg];
    return node as Ga4AdminSubResource;
  }

  async ga4AdminCreate(version: 'v1beta' | 'v1alpha', accessorPath: string, parent: string, requestBody: Record<string, unknown>, query?: Record<string, string>): Promise<unknown> {
    const res = await this.ga4WriteSub(version, accessorPath).create({ parent, requestBody, ...(query ?? {}) });
    return res.data;
  }
  async ga4AdminPatch(version: 'v1beta' | 'v1alpha', accessorPath: string, name: string, updateMask: string, requestBody: Record<string, unknown>): Promise<unknown> {
    const res = await this.ga4WriteSub(version, accessorPath).patch({ name, updateMask, requestBody });
    return res.data;
  }
  async ga4AdminDelete(version: 'v1beta' | 'v1alpha', accessorPath: string, name: string): Promise<{ deleted: boolean; name: string }> {
    await this.ga4WriteSub(version, accessorPath).delete({ name });
    return { deleted: true, name };
  }
  async ga4AdminArchive(version: 'v1beta' | 'v1alpha', accessorPath: string, name: string): Promise<{ archived: boolean; name: string }> {
    await this.ga4WriteSub(version, accessorPath).archive({ name, requestBody: {} });
    return { archived: true, name };
  }

  /** Create a property — parent (account) goes INSIDE the body, not the URL. */
  async ga4CreateProperty(accountName: string, body: Record<string, unknown>): Promise<unknown> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.create({ requestBody: { parent: accountName, propertyType: 'PROPERTY_TYPE_ORDINARY', ...body } });
    return res.data;
  }
  async ga4UpdateProperty(name: string, updateMask: string, body: Record<string, unknown>): Promise<unknown> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.patch({ name, updateMask, requestBody: body });
    return res.data;
  }
  async ga4DeleteProperty(name: string): Promise<unknown> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.delete({ name });
    return res.data;
  }
  async ga4UpdateDataRetention(name: string, updateMask: string, body: Record<string, unknown>): Promise<unknown> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.properties.updateDataRetentionSettings({ name, updateMask, requestBody: body });
    return res.data;
  }
  async ga4UpdateAccount(name: string, displayName: string): Promise<unknown> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const res = await admin.accounts.patch({ name, updateMask: 'displayName', requestBody: { displayName } });
    return res.data;
  }
  async ga4DeleteAccount(name: string): Promise<{ deleted: boolean; name: string }> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsadmin>[0]['auth'];
    const admin = analyticsadmin({ version: 'v1beta', auth });
    await admin.accounts.delete({ name });
    return { deleted: true, name };
  }
}

/** The four uniform mutating methods on a GA4 Admin collection (loose boundary type). */
interface Ga4AdminSubResource {
  create: (p: { parent: string; requestBody: object } & Record<string, unknown>) => Promise<{ data: unknown }>;
  patch: (p: { name: string; updateMask?: string; requestBody: object }) => Promise<{ data: unknown }>;
  delete: (p: { name: string }) => Promise<{ data: unknown }>;
  archive: (p: { name: string; requestBody: object }) => Promise<{ data: unknown }>;
}
