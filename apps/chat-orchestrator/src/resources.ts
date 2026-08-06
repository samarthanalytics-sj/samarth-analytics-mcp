/**
 * Selectable resources for the UI's account, container, and property pickers.
 *
 * These call the same MCP read tools the model would call, just directly. Doing the lookup here
 * rather than leaving it to the model turns a two-turn negotiation ("which container?" ... "that
 * one") into a dropdown, removes two tool calls from the front of every conversation, and means the
 * ids in the prompt were chosen by the user rather than guessed from a name match.
 *
 * Truncation is carried through rather than smoothed over. The MCP caps how many pages it will
 * follow, and a picker that silently shows the first page tells a user their container does not
 * exist.
 */
import type { McpConnection } from './mcp-client.js';

export class ResourceError extends Error {
  constructor(
    message: string,
    readonly code: string = 'resource_failed',
  ) {
    super(message);
    this.name = 'ResourceError';
  }
}

export interface ResourceList<T> {
  items: T[];
  /** True when the MCP stopped paginating before the end. The UI must say so. */
  truncated: boolean;
}

export interface GtmAccount {
  accountId: string;
  name: string;
}

export interface GtmContainer {
  accountId: string;
  containerId: string;
  name: string;
  /** The GTM-XXXXXXX the user recognises. The numeric containerId is what the API needs. */
  publicId?: string;
  /** web, server, amp, ios, android. A server container is a different thing to reason about. */
  usageContext?: string[];
}

export interface GtmWorkspace {
  workspaceId: string;
  name: string;
  description?: string;
}

export interface Ga4Property {
  propertyId: string;
  displayName: string;
  accountName: string;
}

/**
 * Runs a list tool and unwraps the MCP's list envelope.
 *
 * A tool-level failure is raised rather than returned as an empty list: an empty dropdown and a
 * dropdown that failed to load look identical to a user, and only one of them is worth retrying.
 */
async function listVia<T>(
  mcp: McpConnection,
  tool: string,
  args: Record<string, unknown>,
  key: string,
): Promise<ResourceList<T>> {
  const { ok, text } = await mcp.callTool(tool, args);
  if (!ok) throw new ResourceError(text, 'tool_failed');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ResourceError(`${tool} returned a result that was not JSON.`, 'bad_result');
  }

  const raw = body[key];
  return {
    items: Array.isArray(raw) ? (raw as T[]) : [],
    truncated: body.truncated === true,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export async function listGtmAccounts(mcp: McpConnection): Promise<ResourceList<GtmAccount>> {
  const raw = await listVia<Record<string, unknown>>(mcp, 'accounts_list', {}, 'accounts');
  return {
    truncated: raw.truncated,
    items: raw.items.flatMap((a) => {
      const accountId = str(a.accountId);
      if (!accountId) return [];
      return [{ accountId, name: str(a.name) ?? `Account ${accountId}` }];
    }),
  };
}

export async function listGtmContainers(
  mcp: McpConnection,
  accountId: string,
): Promise<ResourceList<GtmContainer>> {
  const raw = await listVia<Record<string, unknown>>(
    mcp,
    'containers_list',
    { accountId },
    'containers',
  );
  return {
    truncated: raw.truncated,
    items: raw.items.flatMap((c) => {
      const containerId = str(c.containerId);
      if (!containerId) return [];
      const usage = Array.isArray(c.usageContext)
        ? c.usageContext.filter((u): u is string => typeof u === 'string')
        : undefined;
      return [
        {
          accountId: str(c.accountId) ?? accountId,
          containerId,
          name: str(c.name) ?? `Container ${containerId}`,
          publicId: str(c.publicId),
          usageContext: usage?.length ? usage : undefined,
        },
      ];
    }),
  };
}

export async function listGtmWorkspaces(
  mcp: McpConnection,
  accountId: string,
  containerId: string,
): Promise<ResourceList<GtmWorkspace>> {
  const raw = await listVia<Record<string, unknown>>(
    mcp,
    'workspaces_list',
    { accountId, containerId },
    'workspaces',
  );
  return {
    truncated: raw.truncated,
    items: raw.items.flatMap((w) => {
      const workspaceId = str(w.workspaceId);
      if (!workspaceId) return [];
      return [
        {
          workspaceId,
          name: str(w.name) ?? `Workspace ${workspaceId}`,
          description: str(w.description),
        },
      ];
    }),
  };
}

/**
 * GA4 properties, flattened out of the account summaries.
 *
 * One call returns every account with its properties nested, so the picker costs a single round
 * trip instead of one per account. The account name is kept because property display names repeat
 * across accounts often enough that the list is ambiguous without it.
 */
export async function listGa4Properties(mcp: McpConnection): Promise<ResourceList<Ga4Property>> {
  const raw = await listVia<Record<string, unknown>>(
    mcp,
    'ga4_account_summaries_list',
    {},
    'accountSummaries',
  );

  const items: Ga4Property[] = [];
  for (const summary of raw.items) {
    const accountName = str(summary.displayName) ?? str(summary.account) ?? 'Unnamed account';
    const properties = Array.isArray(summary.propertySummaries) ? summary.propertySummaries : [];
    for (const entry of properties) {
      if (!entry || typeof entry !== 'object') continue;
      const p = entry as Record<string, unknown>;
      // The API returns "properties/123456789"; every GA4 tool in this MCP takes the bare id.
      const propertyId = str(p.property)?.replace(/^properties\//, '');
      if (!propertyId) continue;
      items.push({
        propertyId,
        displayName: str(p.displayName) ?? `Property ${propertyId}`,
        accountName,
      });
    }
  }

  return { items, truncated: raw.truncated };
}
