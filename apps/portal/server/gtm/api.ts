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

// ── Server-side (sGTM) overview ───────────────────────────────────────────
// Read-only inspection of a GTM server container. Mirrors the Vercel route at
// apps/portal/api/gtm/sgtm.ts; per-resource failures are recorded (404s skipped
// as "unsupported") so the panel reports honest coverage instead of assuming a
// clean state.

interface GtmParameterNode {
  key?: string;
  value?: string;
  list?: GtmParameterNode[];
  map?: GtmParameterNode[];
}

export interface SgtmOverviewResult {
  isServer: boolean;
  container: {
    containerId?: string;
    name?: string;
    publicId?: string;
    usageContext: string[];
  };
  message?: string;
  clients?: {
    clientId?: string;
    name: string;
    type?: string;
    priority?: number;
    claims: { key: string; value: string }[];
  }[];
  transformations?: { transformationId?: string; name: string; type?: string }[];
  zones?: { zoneId?: string; name: string }[];
  templates?: { templateId?: string; name: string; gallery?: string }[];
  gtagConfig?: { gtagConfigId?: string; type?: string; tagId?: string }[];
  destinations?: { destinationId?: string; name?: string }[];
  failures?: { resource: string; message: string; status?: number }[];
  ok?: boolean;
}

function extractServerClaims(
  parameter: GtmParameterNode[] | undefined,
): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const CLAIM_HINT =
    /path|claim|criteria|activation|prefix|priority|cookie|measurement|param/i;
  const walk = (p?: GtmParameterNode) => {
    if (!p) return;
    if (
      p.key &&
      typeof p.value === "string" &&
      p.value.length > 0 &&
      CLAIM_HINT.test(p.key)
    ) {
      out.push({ key: p.key, value: p.value });
    }
    for (const c of p.list ?? []) walk(c);
    for (const c of p.map ?? []) walk(c);
  };
  for (const p of parameter ?? []) walk(p);
  return out.slice(0, 12);
}

export async function fetchServerOverview(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<SgtmOverviewResult> {
  const containerBase = `/accounts/${encodeURIComponent(
    accountId,
  )}/containers/${encodeURIComponent(containerId)}`;
  const base = `${containerBase}/workspaces/${encodeURIComponent(workspaceId)}`;

  const container = await gtmFetch<GtmContainer>(token, containerBase);
  const isServer = (container.usageContext ?? []).some(
    (u) => u.toLowerCase() === "server",
  );
  const containerInfo = {
    containerId: container.containerId,
    name: container.name,
    publicId: container.publicId,
    usageContext: container.usageContext ?? [],
  };
  if (!isServer) {
    return {
      isServer: false,
      container: containerInfo,
      message:
        "This container is not a server-side container. sGTM visibility requires selecting a server container and workspace.",
    };
  }

  const failures: { resource: string; message: string; status?: number }[] = [];
  const record = (resource: string, e: unknown) => {
    if (e instanceof GtmApiError && e.status === 404) return;
    failures.push({
      resource,
      message: e instanceof GtmApiError ? e.message : String(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  };

  type ClientRaw = {
    clientId?: string;
    name?: string;
    type?: string;
    priority?: number;
    parameter?: GtmParameterNode[];
  };
  let clients: SgtmOverviewResult["clients"] = [];
  try {
    const r = await gtmFetch<{ client?: ClientRaw[] }>(token, `${base}/clients`);
    clients = (r.client ?? []).map((c) => ({
      clientId: c.clientId,
      name: c.name ?? "Unnamed client",
      type: c.type,
      priority: c.priority,
      claims: extractServerClaims(c.parameter),
    }));
  } catch (e) {
    record("clients", e);
  }

  let transformations: SgtmOverviewResult["transformations"] = [];
  try {
    const r = await gtmFetch<{
      transformation?: { transformationId?: string; name?: string; type?: string }[];
    }>(token, `${base}/transformations`);
    transformations = (r.transformation ?? []).map((t) => ({
      transformationId: t.transformationId,
      name: t.name ?? "Unnamed transformation",
      type: t.type,
    }));
  } catch (e) {
    record("transformations", e);
  }

  let zones: SgtmOverviewResult["zones"] = [];
  try {
    const r = await gtmFetch<{ zone?: { zoneId?: string; name?: string }[] }>(
      token,
      `${base}/zones`,
    );
    zones = (r.zone ?? []).map((z) => ({ zoneId: z.zoneId, name: z.name ?? "Unnamed zone" }));
  } catch (e) {
    record("zones", e);
  }

  let templates: SgtmOverviewResult["templates"] = [];
  try {
    const r = await gtmFetch<{
      template?: { templateId?: string; name?: string; galleryReference?: { name?: string } }[];
    }>(token, `${base}/templates`);
    templates = (r.template ?? []).map((t) => ({
      templateId: t.templateId,
      name: t.name ?? "Unnamed template",
      gallery: t.galleryReference?.name,
    }));
  } catch (e) {
    record("templates", e);
  }

  let gtagConfig: SgtmOverviewResult["gtagConfig"] = [];
  try {
    const r = await gtmFetch<{
      gtagConfig?: { gtagConfigId?: string; type?: string; parameter?: GtmParameterNode[] }[];
    }>(token, `${base}/gtag_config`);
    gtagConfig = (r.gtagConfig ?? []).map((g) => ({
      gtagConfigId: g.gtagConfigId,
      type: g.type,
      tagId: g.parameter?.find((p) => p.key === "tagId")?.value,
    }));
  } catch (e) {
    record("gtag_config", e);
  }

  let destinations: SgtmOverviewResult["destinations"] = [];
  try {
    const r = await gtmFetch<{ destination?: { destinationId?: string; name?: string }[] }>(
      token,
      `${containerBase}/destinations`,
    );
    destinations = (r.destination ?? []).map((d) => ({
      destinationId: d.destinationId,
      name: d.name,
    }));
  } catch (e) {
    record("destinations", e);
  }

  const total =
    (clients?.length ?? 0) +
    (transformations?.length ?? 0) +
    (zones?.length ?? 0) +
    (templates?.length ?? 0) +
    (gtagConfig?.length ?? 0) +
    (destinations?.length ?? 0);

  return {
    isServer: true,
    container: containerInfo,
    clients,
    transformations,
    zones,
    templates,
    gtagConfig,
    destinations,
    failures,
    ok: total > 0 || failures.length === 0,
  };
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
