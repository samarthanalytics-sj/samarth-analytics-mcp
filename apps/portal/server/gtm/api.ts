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
  // The six server-resource reads are independent — run them concurrently so
  // total latency is one round-trip instead of six. Each still records its own
  // failure (404s skipped) so one failing resource degrades gracefully.
  const pull = async <T>(
    resource: string,
    path: string,
    map: (r: never) => T[],
  ): Promise<T[]> => {
    try {
      return map(await gtmFetch<never>(token, path));
    } catch (e) {
      record(resource, e);
      return [];
    }
  };

  const [clients, transformations, zones, templates, gtagConfig, destinations] =
    await Promise.all([
      pull<NonNullable<SgtmOverviewResult["clients"]>[number]>("clients", `${base}/clients`, (r) =>
        ((r as { client?: ClientRaw[] }).client ?? []).map((c) => ({
          clientId: c.clientId,
          name: c.name ?? "Unnamed client",
          type: c.type,
          priority: c.priority,
          claims: extractServerClaims(c.parameter),
        })),
      ),
      pull<NonNullable<SgtmOverviewResult["transformations"]>[number]>(
        "transformations",
        `${base}/transformations`,
        (r) =>
          (
            (r as {
              transformation?: { transformationId?: string; name?: string; type?: string }[];
            }).transformation ?? []
          ).map((t) => ({
            transformationId: t.transformationId,
            name: t.name ?? "Unnamed transformation",
            type: t.type,
          })),
      ),
      pull<NonNullable<SgtmOverviewResult["zones"]>[number]>("zones", `${base}/zones`, (r) =>
        ((r as { zone?: { zoneId?: string; name?: string }[] }).zone ?? []).map((z) => ({
          zoneId: z.zoneId,
          name: z.name ?? "Unnamed zone",
        })),
      ),
      pull<NonNullable<SgtmOverviewResult["templates"]>[number]>("templates", `${base}/templates`, (r) =>
        (
          (r as {
            template?: { templateId?: string; name?: string; galleryReference?: { name?: string } }[];
          }).template ?? []
        ).map((t) => ({
          templateId: t.templateId,
          name: t.name ?? "Unnamed template",
          gallery: t.galleryReference?.name,
        })),
      ),
      pull<NonNullable<SgtmOverviewResult["gtagConfig"]>[number]>("gtag_config", `${base}/gtag_config`, (r) =>
        (
          (r as {
            gtagConfig?: { gtagConfigId?: string; type?: string; parameter?: GtmParameterNode[] }[];
          }).gtagConfig ?? []
        ).map((g) => ({
          gtagConfigId: g.gtagConfigId,
          type: g.type,
          tagId: g.parameter?.find((p) => p.key === "tagId")?.value,
        })),
      ),
      pull<NonNullable<SgtmOverviewResult["destinations"]>[number]>(
        "destinations",
        `${containerBase}/destinations`,
        (r) =>
          ((r as { destination?: { destinationId?: string; name?: string }[] }).destination ?? []).map(
            (d) => ({
              destinationId: d.destinationId,
              name: d.name,
            }),
          ),
      ),
    ]);

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

export interface ConsentToolFailure {
  resource: string;
  message: string;
  status?: number;
}

export interface ConsentWorkspaceContents {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  toolFailures: ConsentToolFailure[];
}

/**
 * Resilient workspace read for the Consent Mode v2 audit. Each list is fetched
 * independently: a 401/403 (no read access to the container) rethrows to abort
 * the run, but any other per-list failure is recorded in `toolFailures` and
 * yields an empty list so the remaining sources can still be audited instead of
 * the whole audit collapsing to a generic failure.
 */
export async function fetchConsentWorkspaceContents(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<ConsentWorkspaceContents> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const toolFailures: ConsentToolFailure[] = [];

  const pull = async <T>(
    path: string,
    itemKey: string,
    resource: string,
  ): Promise<T[]> => {
    try {
      const data = await gtmFetch<Record<string, T[] | undefined>>(token, path);
      return data[itemKey] ?? [];
    } catch (e) {
      if (e instanceof GtmApiError && (e.status === 401 || e.status === 403)) {
        throw e;
      }
      toolFailures.push({
        resource,
        message: e instanceof GtmApiError ? e.message : String(e),
        status: e instanceof GtmApiError ? e.status : undefined,
      });
      return [];
    }
  };

  const [tags, triggers, variables] = await Promise.all([
    pull<GtmTag>(`${base}/tags`, "tag", "tags"),
    pull<GtmTrigger>(`${base}/triggers`, "trigger", "triggers"),
    pull<GtmVariable>(`${base}/variables`, "variable", "variables"),
  ]);

  return { tags, triggers, variables, toolFailures };
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
