// Portal API adapter.
//
// Live methods (OAuth status, GTM discovery, audit) hit the portal backend
// implemented in apps/portal/server/routes.ts. Mock methods (containers
// inventory, recommendations, approvals) remain in place for the rest of
// the MVP until those flows are wired up.

import {
  MOCK_APPROVALS,
  MOCK_CONTAINERS,
  MOCK_PLAN_TEMPLATES,
} from "@/data/mock";
import type {
  ApprovalItem,
  ApprovalStatus,
  AuditSummary,
  ChangePlan,
  ContainerRecord,
  Ga4DataStreamSummary,
  Ga4PropertySummary,
  GtmAccountSummary,
  GtmContainerSummary,
  GtmWorkspaceSummary,
  OAuthState,
  RecommendationGoal,
  SgtmOverview,
} from "@shared/portal-types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const FAKE_LATENCY_MS = 120;

function delay<T>(value: T, ms = FAKE_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function parseError(res: Response): Promise<Error & { status?: number; code?: string }> {
  // Read the body exactly once as text, then try to parse it as JSON.
  // Reading via res.json() and then falling back to res.text() on the same
  // Response throws "Failed to execute 'text' on 'Response': body stream
  // already read" — Response bodies are single-use streams.
  let rawBody = "";
  try {
    rawBody = await res.text();
  } catch {
    rawBody = "";
  }

  let message = "";
  let code: string | undefined;
  if (rawBody) {
    try {
      const data = JSON.parse(rawBody);
      if (data && typeof data === "object") {
        message = (data.message as string) || (data.error as string) || "";
        if (typeof data.error === "string") code = data.error;
      }
    } catch {
      message = rawBody.length < 200 ? rawBody : "";
    }
  }

  if (res.status === 401 || code === "not_connected" || code === "unauthorized") {
    message = "Google session expired. Please reconnect Google Tag Manager.";
  } else if (code === "ga4_scope_missing") {
    message =
      message ||
      "GA4 Admin access requires the Google Analytics read-only scope. Reconnect Google to grant it, then retry.";
  } else if (res.status === 403 || code === "forbidden") {
    message =
      message ||
      "Google Tag Manager denied access. Make sure your Google account has access to this container.";
  } else if (code === "oauth_not_configured") {
    message = message || "Google OAuth is not configured on this portal. Ask your administrator.";
  } else if (!message) {
    message = res.statusText || `Request failed (${res.status})`;
  }

  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = res.status;
  err.code = code;
  return err;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { credentials: "include" });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const portalApi = {
  // -------- OAuth (live) --------
  async getOAuthState(): Promise<OAuthState> {
    try {
      return await getJson<OAuthState>("/api/oauth/status");
    } catch {
      return { connected: false, configured: false };
    }
  },

  /**
   * Live OAuth: redirect the browser to the backend start endpoint.
   * The backend redirects to Google. After the round-trip the user lands
   * back on `/?connected=1#/` (query in search so wouter's hash router
   * still sees `/` as the path).
   */
  redirectToGoogleOAuth(): void {
    if (typeof window === "undefined") return;
    window.location.href = `${API_BASE}/api/oauth/start`;
  },

  async disconnectGoogle(): Promise<OAuthState> {
    try {
      return await postJson<OAuthState>("/api/oauth/logout", {});
    } catch {
      return { connected: false };
    }
  },

  // -------- Live GTM discovery --------
  async listGtmAccounts(): Promise<GtmAccountSummary[]> {
    const data = await getJson<{ accounts: GtmAccountSummary[] }>("/api/gtm/accounts");
    return data.accounts ?? [];
  },

  async listGtmContainers(accountId: string): Promise<GtmContainerSummary[]> {
    const data = await getJson<{ containers: GtmContainerSummary[] }>(
      `/api/gtm/accounts/${encodeURIComponent(accountId)}/containers`,
    );
    return data.containers ?? [];
  },

  /**
   * Fetch containers across every supplied account in parallel. Per-account
   * failures are captured rather than rejecting the whole batch, so one
   * account the user lacks access to does not blank out the rest.
   */
  async listAllGtmContainers(
    accounts: GtmAccountSummary[],
  ): Promise<{
    containers: GtmContainerSummary[];
    errors: { accountId: string; message: string }[];
  }> {
    const results = await Promise.all(
      accounts.map(async (a) => {
        try {
          const containers = await portalApi.listGtmContainers(a.accountId);
          return { containers, error: null as null };
        } catch (e) {
          const err = e as Error;
          return {
            containers: [] as GtmContainerSummary[],
            error: { accountId: a.accountId, message: err.message },
          };
        }
      }),
    );
    return {
      containers: results.flatMap((r) => r.containers),
      errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    };
  },

  async listGtmWorkspaces(
    accountId: string,
    containerId: string,
  ): Promise<GtmWorkspaceSummary[]> {
    const data = await getJson<{ workspaces: GtmWorkspaceSummary[] }>(
      `/api/gtm/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
        containerId,
      )}/workspaces`,
    );
    return data.workspaces ?? [];
  },

  // -------- Live GA4 Admin (read-only) --------
  /**
   * List GA4 properties the connected Google account can read. Powers the
   * audit page's optional GA4 property selector / auto-match. Returns an empty
   * list rather than throwing when GA4 is not connected, so the audit page
   * degrades gracefully to CONFIG-only.
   */
  async listGa4Properties(): Promise<Ga4PropertySummary[]> {
    const data = await postJson<{ properties?: Ga4PropertySummary[] }>(
      "/api/ga4/admin",
      { action: "account_summaries" },
    );
    return data.properties ?? [];
  },

  /**
   * List the web/app data streams on a GA4 property. Used to auto-match a GTM
   * GA4 measurement ID to a property when the user has not selected one.
   */
  async listGa4DataStreams(propertyId: string): Promise<Ga4DataStreamSummary[]> {
    const data = await postJson<{
      dataStreams?: {
        name?: string;
        type?: string;
        displayName?: string;
        webStreamData?: { measurementId?: string };
      }[];
    }>("/api/ga4/admin", { action: "data_streams", propertyId });
    return (data.dataStreams ?? []).map((s) => ({
      name: s.name ?? "",
      dataStreamId: (s.name ?? "").split("/").pop() ?? "",
      displayName: s.displayName ?? "",
      type: s.type,
      measurementId: s.webStreamData?.measurementId,
    }));
  },

  /**
   * Live audit. Provide the GTM account/container/workspace ids. Backend
   * pulls the workspace contents via GTM API v2 and runs portal QC rules.
   * Optionally pass a `ga4PropertyId` to enable CONFIG ↔ GA4_ADMIN
   * cross-source reconciliation findings.
   */
  async runLiveAudit(args: {
    accountId: string;
    containerId: string;
    workspaceId: string;
    containerPublicId?: string;
    ga4PropertyId?: string;
  }): Promise<AuditSummary> {
    return postJson<AuditSummary>("/api/gtm/audit", args);
  },

  // -------- Live server-side GTM (sGTM) visibility (read-only) --------
  /**
   * Read the server-side resources of a GTM server container/workspace:
   * clients (with claim paths/criteria), transformations, zones, templates,
   * gtag config and container destinations. Returns `isServer: false` with an
   * explanatory message when the selected container is not server-side, so the
   * Server-side page can degrade gracefully instead of throwing.
   */
  async getServerSideOverview(args: {
    accountId: string;
    containerId: string;
    workspaceId: string;
  }): Promise<SgtmOverview> {
    return postJson<SgtmOverview>("/api/gtm/sgtm", {
      action: "overview",
      ...args,
    });
  },

  // -------- Containers (mixed-source inventory — still mock) --------
  async listContainers(): Promise<ContainerRecord[]> {
    return delay([...MOCK_CONTAINERS]);
  },

  async getContainer(id: string): Promise<ContainerRecord | undefined> {
    return delay(MOCK_CONTAINERS.find((c) => c.id === id));
  },

  // -------- Audits (legacy mock path kept for non-live demo usage) --------
  async runAudit(containerPublicId: string): Promise<AuditSummary> {
    return delay({
      containerId: containerPublicId,
      generatedAt: new Date().toISOString(),
      healthScore: 70,
      counts: { tags: 0, triggers: 0, variables: 0 },
      findings: [],
    });
  },

  // -------- Recommendation builder --------
  async buildPlan(
    goal: RecommendationGoal,
    containerId: string,
  ): Promise<ChangePlan> {
    const tpl = MOCK_PLAN_TEMPLATES[goal];
    if (!tpl) throw new Error(`Unknown goal: ${goal}`);
    return delay({
      ...tpl,
      id: `pl_${Math.random().toString(36).slice(2, 8)}`,
      containerId,
      createdAt: new Date().toISOString(),
    });
  },

  // -------- Approvals --------
  async listApprovals(): Promise<ApprovalItem[]> {
    return delay([...MOCK_APPROVALS]);
  },

  async submitForReview(plan: ChangePlan, client: string): Promise<ApprovalItem> {
    const item: ApprovalItem = {
      id: `ap_${Math.random().toString(36).slice(2, 8)}`,
      planId: plan.id,
      containerId: plan.containerId,
      client,
      title: plan.title,
      goal: plan.goal,
      status: "pending_review",
      submittedBy: "You",
      submittedAt: new Date().toISOString(),
      stepsCount: plan.steps.length,
      riskLevel: plan.steps.some((s) => s.risk === "high")
        ? "high"
        : plan.steps.some((s) => s.risk === "medium")
        ? "medium"
        : "low",
    };
    return delay(item);
  },

  async updateApprovalStatus(
    id: string,
    status: ApprovalStatus,
    note?: string,
  ): Promise<ApprovalItem> {
    const existing = MOCK_APPROVALS.find((a) => a.id === id);
    if (!existing) throw new Error("Approval not found");
    return delay({
      ...existing,
      status,
      reviewer: "Samarth Reviewer",
      reviewedAt: new Date().toISOString(),
      reviewNote: note ?? existing.reviewNote,
    });
  },
};

export type PortalApi = typeof portalApi;
