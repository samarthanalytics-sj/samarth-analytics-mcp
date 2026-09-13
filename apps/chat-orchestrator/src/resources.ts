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

export type ContainerLookup =
  | { found: true; container: GtmContainer; accountsSearched: number }
  /**
   * `exhaustive` is the honest half. A search that gave up early and one that genuinely covered
   * everything both end with no match, and only one of them means the container does not exist.
   */
  | { found: false; accountsSearched: number; exhaustive: boolean };

/** Past this, the round trips cost more than the user saves over picking from the dropdowns. */
const MAX_ACCOUNTS_SCANNED = 30;

/**
 * Turns whatever the user pasted into something matchable.
 *
 * The GTM interface puts the numeric container id in its own URL, and that URL is what people
 * actually have on the clipboard when they are looking at a container, so it is worth reading.
 */
export function normalizeContainerQuery(
  raw: string,
): { kind: 'publicId' | 'containerId'; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fromUrl = /\/containers\/(\d+)/.exec(trimmed);
  if (fromUrl) return { kind: 'containerId', value: fromUrl[1] };

  if (/^GTM-[A-Z0-9]{4,12}$/i.test(trimmed)) {
    return { kind: 'publicId', value: trimmed.toUpperCase() };
  }
  if (/^\d{1,20}$/.test(trimmed)) return { kind: 'containerId', value: trimmed };

  return null;
}

/**
 * Finds a container by its public GTM-XXXXXXX or numeric id, across every account the user can see.
 *
 * The API's own lookup takes a linked destination id (a GA4 measurement id, an Ads conversion id),
 * not a container id, so it cannot answer this. Scanning is the only route, and it is worth the
 * round trips: someone who already knows the container id should not have to find which of their
 * accounts it lives under first.
 */
export async function findGtmContainer(
  mcp: McpConnection,
  query: { kind: 'publicId' | 'containerId'; value: string },
): Promise<ContainerLookup> {
  const accounts = await listGtmAccounts(mcp);
  const scanning = accounts.items.slice(0, MAX_ACCOUNTS_SCANNED);

  // Anything that stopped a list short means a miss cannot be reported as "does not exist".
  let complete = !accounts.truncated && scanning.length === accounts.items.length;
  let searched = 0;

  for (const account of scanning) {
    let containers;
    try {
      containers = await listGtmContainers(mcp, account.accountId);
    } catch {
      // One account the user cannot read must not fail the whole search, but it does mean the
      // remaining ground was not fully covered.
      complete = false;
      searched++;
      continue;
    }
    searched++;
    if (containers.truncated) complete = false;

    const match = containers.items.find((c) =>
      query.kind === 'publicId'
        ? c.publicId?.toUpperCase() === query.value
        : c.containerId === query.value,
    );
    if (match) return { found: true, container: match, accountsSearched: searched };
  }

  return { found: false, accountsSearched: searched, exhaustive: complete };
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
