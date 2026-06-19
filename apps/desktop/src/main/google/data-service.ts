import { tagmanager } from '@googleapis/tagmanager';
import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { OAuth2Client } from 'google-auth-library';
import type { AccountClientManager } from './account-clients';
import type { RegistryService } from '../services/registry-service';
import type { ContainerSnapshot } from './gtm-builders';
import type { Ga4PropertySnapshot } from './ga4-audit';
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
}
