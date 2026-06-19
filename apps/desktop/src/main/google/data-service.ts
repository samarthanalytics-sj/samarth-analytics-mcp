import { tagmanager } from '@googleapis/tagmanager';
import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { OAuth2Client } from 'google-auth-library';
import type { AccountClientManager } from './account-clients';
import type { RegistryService } from '../services/registry-service';
import type { ContainerSnapshot } from './gtm-builders';
import type { Ga4PropertySnapshot } from './ga4-audit';
import type { DataQualityCounts } from './ga4-data-quality';
import type { Ga4AccountView, GtmAccountView } from '../../shared/ipc';

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

export interface GtmWorkspaceView {
  workspaceId: string;
  name: string;
  path: string;
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
    const accounts = await collectPages(
      (pageToken) => gtm.accounts.list({ pageToken }),
      (r) => r.data.account,
      (r) => r.data.nextPageToken
    );
    return accounts.map((a) => ({
      accountId: a.accountId ?? '',
      name: a.name ?? '(unnamed)',
      path: a.path ?? '',
    }));
  }

  async listGtmContainers(accountId: string): Promise<GtmContainerView[]> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const containers = await collectPages(
      (pageToken) => gtm.accounts.containers.list({ parent: `accounts/${accountId}`, pageToken }),
      (r) => r.data.container,
      (r) => r.data.nextPageToken
    );
    return containers.map((c) => ({
      containerId: c.containerId ?? '',
      name: c.name ?? '(unnamed)',
      publicId: c.publicId ?? '',
      path: c.path ?? '',
    }));
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
    const workspaces = await collectPages(
      (pageToken) => gtm.accounts.containers.workspaces.list({ parent, pageToken }),
      (r) => r.data.workspace,
      (r) => r.data.nextPageToken
    );
    return workspaces.map((w) => ({
      workspaceId: w.workspaceId ?? '',
      name: w.name ?? '(unnamed)',
      path: w.path ?? '',
    }));
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
    const dataStreams = await Promise.all(
      streams.map(async (s) => {
        let enhancedMeasurementEnabled: boolean | null = null;
        if (s.type === 'WEB_DATA_STREAM' && s.name) {
          try {
            const em = await adminAlpha.properties.dataStreams.getEnhancedMeasurementSettings({
              name: `${s.name}/enhancedMeasurementSettings`,
            });
            enhancedMeasurementEnabled = em.data.streamEnabled ?? null;
          } catch {
            enhancedMeasurementEnabled = null;
          }
        }
        return {
          name: s.name ?? '',
          displayName: s.displayName ?? '(unnamed)',
          type: s.type ?? '',
          enhancedMeasurementEnabled,
        };
      })
    );

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
    return { tagId: res.data.tagId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  async updateGtmTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    tag: Record<string, unknown>
  ): Promise<GtmTagView> {
    const auth = this.activeAuth() as unknown as Parameters<typeof tagmanager>[0]['auth'];
    const gtm = tagmanager({ version: 'v2', auth });
    const res = await gtm.accounts.containers.workspaces.tags.update({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
      requestBody: tag,
    });
    return { tagId: res.data.tagId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
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
    const [tags, triggers, variables] = await Promise.all([
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
      collectPages(
        (pageToken) => gtm.accounts.containers.workspaces.variables.list({ parent, pageToken }),
        (r) => r.data.variable,
        (r) => r.data.nextPageToken
      ),
    ]);
    return toSnapshot(tags, triggers, variables);
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
  ): Promise<Array<{ triggerId: string; name: string; type: string }>> {
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
    }));
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
      requestBody: trigger,
    });
    return { triggerId: res.data.triggerId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
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
    return { variableId: res.data.variableId ?? '', name: res.data.name ?? '', type: res.data.type ?? '' };
  }

  async runGa4Report(input: {
    property: string;
    startDate: string;
    endDate: string;
    dimensions: string[];
    metrics: string[];
  }): Promise<Ga4ReportResult> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const res = await data.properties.runReport({
      property: input.property,
      requestBody: {
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
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

  /** Session counts by channel group and by source/medium over the last `days`,
   *  for the pure data-quality engine. Read-only (analytics.readonly via the
   *  Data API). */
  async getGa4DataQuality(property: string, days = 28): Promise<DataQualityCounts> {
    const auth = this.activeAuth() as unknown as Parameters<typeof analyticsdata>[0]['auth'];
    const data = analyticsdata({ version: 'v1beta', auth });
    const startDate = `${days}daysAgo`;
    const run = async (dimension: string, ordered: boolean) => {
      const res = await data.properties.runReport({
        property,
        requestBody: {
          dateRanges: [{ startDate, endDate: 'today' }],
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
    // Channel groups partition all sessions, so their sum is the true total.
    const channelGroups = await run('sessionDefaultChannelGroup', false);
    const sourceMediums = await run('sessionSourceMedium', true);
    const totalSessions = channelGroups.reduce((s, c) => s + c.sessions, 0);
    return { totalSessions, channelGroups, sourceMediums, windowDays: days };
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
}
