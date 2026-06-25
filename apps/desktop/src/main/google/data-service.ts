import { tagmanager } from '@googleapis/tagmanager';
import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { OAuth2Client } from 'google-auth-library';
import type { AccountClientManager } from './account-clients';
import type { RegistryService } from '../services/registry-service';
import type { ContainerSnapshot } from './gtm-builders';
import { applyTriggerWaitDefaults, buildEnvironmentSnippet, normalizeTimerTrigger } from './gtm-builders';
import type { Ga4PropertySnapshot } from './ga4-audit';
import type { DataQualityCounts } from './ga4-data-quality';
import { windowDates } from './ga4-data-quality';
import { mergeParametersByKey, addEventParameters, setTemplateParam, type GtmParam } from './tag-params';
import { changeJournal, type EntityKind } from './change-journal';
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
  private async getContainerPublicId(accountId: string, containerId: string): Promise<string> {
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
      googleSignals,
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

  /** Bulk, ONE approval: set the Measurement ID on EVERY GA4 tag in the workspace
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

  /** Bulk, ONE approval: append GA4 event parameters to EVERY GA4 Event tag (gaawe) in
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
      requestBody: normalizeTimerTrigger(applyTriggerWaitDefaults(trigger)),
    });
    this.journal('trigger', accountId, containerId, workspaceId, res.data.triggerId ?? '', `${res.data.name ?? 'trigger'} (#${res.data.triggerId})`);
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
    this.journal('variable', accountId, containerId, workspaceId, res.data.variableId ?? '', `${res.data.name ?? 'variable'} (#${res.data.variableId})`);
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
    // Resolve the window in the PROPERTY's timezone (UTC fallback) so "today"
    // matches GA4's day boundaries, then query EXPLICIT dates for exactly `days`
    // inclusive days. Explicit bounds mean the displayed range == the queried
    // range (no relative-token / local-clock drift).
    const admin = analyticsadmin({ version: 'v1beta', auth });
    const tz = await admin.properties
      .get({ name: property })
      .then((r) => r.data.timeZone || 'UTC')
      .catch(() => 'UTC');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const { startDate, endDate } = windowDates(`${part('year')}-${part('month')}-${part('day')}`, days);
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
    // Channel groups partition all sessions, so their sum is the true total.
    const channelGroups = await run('sessionDefaultChannelGroup', false);
    const sourceMediums = await run('sessionSourceMedium', true);
    const totalSessions = channelGroups.reduce((s, c) => s + c.sessions, 0);
    return { totalSessions, channelGroups, sourceMediums, windowDays: days, startDate, endDate };
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
}
