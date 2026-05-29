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
  GtmAccountSummary,
  GtmContainerSummary,
  GtmWorkspaceSummary,
  OAuthState,
  RecommendationGoal,
} from "@shared/portal-types";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const FAKE_LATENCY_MS = 120;

function delay<T>(value: T, ms = FAKE_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function parseError(res: Response): Promise<Error & { status?: number }> {
  let message: string;
  try {
    const data = await res.json();
    message = data?.message || data?.error || res.statusText;
  } catch {
    message = (await res.text()) || res.statusText;
  }
  const err = new Error(`${res.status}: ${message}`) as Error & { status?: number };
  err.status = res.status;
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

  /**
   * Live audit. Provide the GTM account/container/workspace ids. Backend
   * pulls the workspace contents via GTM API v2 and runs portal QC rules.
   */
  async runLiveAudit(args: {
    accountId: string;
    containerId: string;
    workspaceId: string;
    containerPublicId?: string;
  }): Promise<AuditSummary> {
    return postJson<AuditSummary>("/api/gtm/audit", args);
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
