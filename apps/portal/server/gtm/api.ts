/**
 * Thin Google Tag Manager API v2 client using raw fetch.
 * Read-only — we never POST/PUT/DELETE to GTM from the portal.
 */

const GTM_BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

async function gtmFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${GTM_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GtmApiError(res.status, text);
  }
  return (await res.json()) as T;
}

export class GtmApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GTM API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

// ── Types (subset of GTM v2 responses we use) ────────────────────────────

export interface GtmAccount {
  path?: string;
  accountId: string;
  name?: string;
  shareData?: boolean;
}

export interface GtmContainer {
  path?: string;
  accountId: string;
  containerId: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
  domainName?: string[];
}

export interface GtmWorkspace {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  name?: string;
  description?: string;
}

export interface GtmTag {
  tagId?: string;
  name?: string;
  type?: string;
  paused?: boolean;
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  firingRuleId?: string[];
  parameter?: Array<{ type?: string; key?: string; value?: string }>;
  parentFolderId?: string;
}

export interface GtmTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: unknown[];
  parentFolderId?: string;
}

export interface GtmVariable {
  variableId?: string;
  name?: string;
  type?: string;
  enablingTriggerId?: string[];
  parameter?: Array<{ type?: string; key?: string; value?: string }>;
  parentFolderId?: string;
}

export interface GtmFolder {
  folderId?: string;
  name?: string;
}

export interface GtmBuiltInVariable {
  type?: string;
  name?: string;
}

// ── API methods ──────────────────────────────────────────────────────────

export async function listAccounts(token: string): Promise<GtmAccount[]> {
  const data = await gtmFetch<{ account?: GtmAccount[] }>(token, `/accounts`);
  return data.account ?? [];
}

export async function listContainers(
  token: string,
  accountId: string,
): Promise<GtmContainer[]> {
  const data = await gtmFetch<{ container?: GtmContainer[] }>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/containers`,
  );
  return data.container ?? [];
}

export async function listWorkspaces(
  token: string,
  accountId: string,
  containerId: string,
): Promise<GtmWorkspace[]> {
  const data = await gtmFetch<{ workspace?: GtmWorkspace[] }>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
      containerId,
    )}/workspaces`,
  );
  return data.workspace ?? [];
}

export interface WorkspaceContents {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  folders: GtmFolder[];
  builtInVariables: GtmBuiltInVariable[];
}

export async function fetchWorkspaceContents(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<WorkspaceContents> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const [tagsRes, triggersRes, variablesRes, foldersRes, bivRes] = await Promise.all([
    gtmFetch<{ tag?: GtmTag[] }>(token, `${base}/tags`),
    gtmFetch<{ trigger?: GtmTrigger[] }>(token, `${base}/triggers`),
    gtmFetch<{ variable?: GtmVariable[] }>(token, `${base}/variables`),
    gtmFetch<{ folder?: GtmFolder[] }>(token, `${base}/folders`),
    gtmFetch<{ builtInVariable?: GtmBuiltInVariable[] }>(
      token,
      `${base}/built_in_variables`,
    ),
  ]);
  return {
    tags: tagsRes.tag ?? [],
    triggers: triggersRes.trigger ?? [],
    variables: variablesRes.variable ?? [],
    folders: foldersRes.folder ?? [],
    builtInVariables: bivRes.builtInVariable ?? [],
  };
}
