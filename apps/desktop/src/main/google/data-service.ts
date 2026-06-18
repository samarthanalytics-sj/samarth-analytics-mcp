import { tagmanager } from '@googleapis/tagmanager';
import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { OAuth2Client } from 'google-auth-library';
import type { AccountClientManager } from './account-clients';
import type { RegistryService } from '../services/registry-service';
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

  /** Full tags + triggers + variables for an audit (tags include firingTriggerId,
   *  paused, and parameters). */
  async getGtmContainerSnapshot(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{
    tags: Array<{ tagId: string; name: string; type: string; firingTriggerId: string[]; paused: boolean; parameter: Array<Record<string, unknown>> }>;
    triggers: Array<{ triggerId: string; name: string; type: string }>;
    variables: Array<{ variableId: string; name: string; type: string }>;
  }> {
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
    return {
      tags: tags.map((t) => ({
        tagId: t.tagId ?? '',
        name: t.name ?? '(unnamed)',
        type: t.type ?? '',
        firingTriggerId: t.firingTriggerId ?? [],
        paused: t.paused ?? false,
        parameter: (t.parameter ?? []) as Array<Record<string, unknown>>,
      })),
      triggers: triggers.map((t) => ({
        triggerId: t.triggerId ?? '',
        name: t.name ?? '(unnamed)',
        type: t.type ?? '',
      })),
      variables: variables.map((v) => ({
        variableId: v.variableId ?? '',
        name: v.name ?? '(unnamed)',
        type: v.type ?? '',
      })),
    };
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
