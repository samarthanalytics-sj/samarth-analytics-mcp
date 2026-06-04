/**
 * Workspace-scoped GTM resources that share an identical CRUD(+revert) shape:
 *   - clients         (server containers)
 *   - transformations (server containers)
 *   - zones           (web containers — zone delegation)
 *   - templates       (custom templates / gallery-installed templates)
 *   - gtag_config     (Google tag / gtag configuration; no revert)
 *
 * These resources have rich, deeply-nested bodies (parameters, consent
 * settings, template data, etc.). Rather than model every field in Zod, the
 * create/update tools accept the full resource as a JSON string (`bodyJson`),
 * mirroring the existing workspace_resolve_conflict pattern. List/get/delete
 * use the same guardrails and pagination as the rest of the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';

/** A GTM resource collection that lives directly under a workspace. */
interface WorkspaceResourceApi {
  list: (params: { parent: string; pageToken?: string }) => Promise<{ data: Record<string, unknown> }>;
  get: (params: { path: string }) => Promise<{ data: unknown }>;
  create: (params: { parent: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
  update: (params: { path: string; fingerprint?: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
  delete: (params: { path: string }) => Promise<unknown>;
  revert?: (params: { path: string; fingerprint?: string }) => Promise<{ data: unknown }>;
}

interface ResourceSpec {
  /** Tool name prefix, e.g. "clients". */
  toolPrefix: string;
  /** GTM API path segment, e.g. "clients". */
  pathSegment: string;
  /** Key of the item ID argument, e.g. "clientId". */
  idArg: string;
  /** Response array key on list responses, e.g. "client". */
  listKey: string;
  /** Human label used in descriptions. */
  label: string;
  /** Whether this resource supports revert. */
  hasRevert: boolean;
  /** Selects the API collection off the GTM client for a workspace. */
  select: (client: GtmClient) => WorkspaceResourceApi;
}

const wsBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
  workspaceId: z.string().describe('The GTM workspace ID.'),
});

function parseBody(bodyJson: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(bodyJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function registerResource(server: McpServer, getClient: () => GtmClient, spec: ResourceSpec): void {
  const wsPath = (a: string, c: string, w: string) =>
    `accounts/${a}/containers/${c}/workspaces/${w}`;
  const itemPath = (a: string, c: string, w: string, id: string) =>
    `${wsPath(a, c, w)}/${spec.pathSegment}/${id}`;

  // ── list ──────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_list`,
    {
      description: `List all GTM ${spec.label} in a workspace. Automatically follows pagination.`,
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const api = spec.select(getClient());
        const parent = wsPath(accountId, containerId, workspaceId);
        const result = await paginate<Record<string, unknown>, unknown>(
          (token) => api.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data[spec.listKey] as unknown[] | undefined,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult(spec.toolPrefix, result));
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_list`, err);
      }
    }
  );

  // ── get ─────────────────────────────────────────────────────────────────--
  server.registerTool(
    `${spec.toolPrefix}_get`,
    {
      description: `Get a specific GTM ${spec.label.replace(/s$/, '')}.`,
      inputSchema: wsBase.extend({ [spec.idArg]: z.string().describe(`The ${spec.label} ID.`) }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId } = args as Record<string, string>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const api = spec.select(getClient());
        const res = await api.get({ path: itemPath(accountId, containerId, workspaceId, id) });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_get`, err);
      }
    }
  );

  // ── create ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_create`,
    {
      description:
        `[WRITE] Create a new GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ` +
        `Pass the full resource as a JSON string in bodyJson.`,
      inputSchema: wsBase.extend({
        bodyJson: z.string().describe(`Full ${spec.label} resource as a JSON string (e.g. {"name":"...","type":"..."}).`),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, bodyJson, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create ${spec.label} in workspace ${workspaceId}`);
        }
        const parsed = parseBody(bodyJson);
        if (!parsed.ok) {
          return errorText('bodyJson must be a valid JSON object.');
        }
        const api = spec.select(getClient());
        const res = await api.create({
          parent: wsPath(accountId, containerId, workspaceId),
          requestBody: parsed.value,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_create`, err);
      }
    }
  );

  // ── update ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_update`,
    {
      description:
        `[WRITE] Update an existing GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ` +
        `Pass the full resource as a JSON string in bodyJson.`,
      inputSchema: wsBase.extend({
        [spec.idArg]: z.string().describe(`The ${spec.label} ID to update.`),
        bodyJson: z.string().describe(`Full ${spec.label} resource as a JSON string.`),
        fingerprint: z.string().optional().describe('Current fingerprint (for optimistic locking).'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId, bodyJson, fingerprint, confirm } = args as Record<string, unknown>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm as boolean | undefined, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update ${spec.label} ${id} in workspace ${workspaceId}`);
        }
        const parsed = parseBody(bodyJson as string);
        if (!parsed.ok) {
          return errorText('bodyJson must be a valid JSON object.');
        }
        const api = spec.select(getClient());
        const res = await api.update({
          path: itemPath(accountId as string, containerId as string, workspaceId as string, id),
          ...(fingerprint ? { fingerprint: fingerprint as string } : {}),
          requestBody: parsed.value,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_update`, err);
      }
    }
  );

  // ── delete ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_delete`,
    {
      description:
        `[DELETE] Delete a GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.`,
      inputSchema: wsBase.extend({
        [spec.idArg]: z.string().describe(`The ${spec.label} ID to delete.`),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId, confirm } = args as Record<string, unknown>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm as boolean | undefined, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete ${spec.label} ${id} from workspace ${workspaceId}`);
        }
        const api = spec.select(getClient());
        await api.delete({ path: itemPath(accountId as string, containerId as string, workspaceId as string, id) });
        return textResult(`${spec.label.replace(/s$/, '')} ${id} deleted from workspace ${workspaceId}.`);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_delete`, err);
      }
    }
  );

  // ── revert ─────────────────────────────────────────────────────────────────
  if (spec.hasRevert) {
    server.registerTool(
      `${spec.toolPrefix}_revert`,
      {
        description:
          `[WRITE] Revert workspace changes to a GTM ${spec.label.replace(/s$/, '')} back to its last container-version state. ` +
          `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: wsBase.extend({
          [spec.idArg]: z.string().describe(`The ${spec.label} ID to revert.`),
          fingerprint: z.string().optional().describe('Current fingerprint (for optimistic locking).'),
          confirm: z.boolean().describe('Must be true to confirm this write operation.'),
        }),
      },
      async (args) => {
        const { accountId, containerId, workspaceId, fingerprint, confirm } = args as Record<string, unknown>;
        const id = (args as Record<string, string>)[spec.idArg];
        try {
          const config = getGuardrailConfig();
          const { dryRun } = checkGuardrails('write', confirm as boolean | undefined, config);
          if (dryRun) {
            return textResult(`[DRY RUN] Would revert ${spec.label} ${id} in workspace ${workspaceId}`);
          }
          const api = spec.select(getClient());
          if (!api.revert) {
            return errorText(`${spec.toolPrefix}_revert is not supported by the API.`);
          }
          const res = await api.revert({
            path: itemPath(accountId as string, containerId as string, workspaceId as string, id),
            ...(fingerprint ? { fingerprint: fingerprint as string } : {}),
          });
          return jsonResult(res.data);
        } catch (err) {
          return errorResult(`${spec.toolPrefix}_revert`, err);
        }
      }
    );
  }
}

export function registerServerSideTools(server: McpServer, getClient: () => GtmClient): void {
  const specs: ResourceSpec[] = [
    {
      toolPrefix: 'clients', pathSegment: 'clients', idArg: 'clientId', listKey: 'client',
      label: 'clients', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.clients as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'transformations', pathSegment: 'transformations', idArg: 'transformationId', listKey: 'transformation',
      label: 'transformations', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.transformations as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'zones', pathSegment: 'zones', idArg: 'zoneId', listKey: 'zone',
      label: 'zones', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.zones as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'templates', pathSegment: 'templates', idArg: 'templateId', listKey: 'template',
      label: 'templates', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.templates as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'gtag_config', pathSegment: 'gtag_config', idArg: 'gtagConfigId', listKey: 'gtagConfig',
      label: 'gtag configs', hasRevert: false,
      select: (c) => c.accounts.containers.workspaces.gtag_config as unknown as WorkspaceResourceApi,
    },
  ];

  for (const spec of specs) registerResource(server, getClient, spec);
}
