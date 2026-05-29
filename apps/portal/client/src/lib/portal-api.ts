// Portal API adapter.
//
// All UI calls go through this module. Today every method returns mock data.
// Tomorrow, swap the implementation for calls against the existing
// Samarth GTM MCP server (Streamable HTTP transport) without changing the UI.
//
// Production wiring will look roughly like:
//   - POST /api/mcp/call  -> proxies to MCP server tools (audit_workspace, etc.)
//   - GET  /api/oauth/start -> initiates Google OAuth (hosted)
//   - GET  /api/oauth/callback -> exchanges code, stores refresh token server-side
//   - GET  /api/containers -> reads from mixed sources (Google API + Sheets/CSV imports)
//
// The MCP server's HTTP transport is already exposed at GTM_MCP_TRANSPORT=http
// (see ../../../package.json scripts: `start:http`). The portal backend
// will sit in front of it and inject the authenticated user's OAuth token.

import {
  MOCK_APPROVALS,
  MOCK_AUDITS,
  MOCK_CONTAINERS,
  MOCK_OAUTH,
  MOCK_PLAN_TEMPLATES,
} from "@/data/mock";
import type {
  ApprovalItem,
  ApprovalStatus,
  AuditSummary,
  ChangePlan,
  ContainerRecord,
  OAuthState,
  RecommendationGoal,
} from "@shared/portal-types";

const FAKE_LATENCY_MS = 120;

function delay<T>(value: T, ms = FAKE_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export const portalApi = {
  // -------- OAuth --------
  async getOAuthState(): Promise<OAuthState> {
    return delay({ ...MOCK_OAUTH });
  },

  /**
   * In production this opens the hosted OAuth flow:
   *   window.location.href = "/api/oauth/start";
   * The mock just toggles state locally.
   */
  async connectGoogle(): Promise<OAuthState> {
    return delay({
      connected: true,
      email: "swapnil@samarthanalytics.com",
      scopes: ["tagmanager.readonly", "tagmanager.edit.containers"],
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    });
  },

  async disconnectGoogle(): Promise<OAuthState> {
    return delay({ connected: false });
  },

  // -------- Containers (mixed-source inventory) --------
  async listContainers(): Promise<ContainerRecord[]> {
    return delay([...MOCK_CONTAINERS]);
  },

  async getContainer(id: string): Promise<ContainerRecord | undefined> {
    return delay(MOCK_CONTAINERS.find((c) => c.id === id));
  },

  // -------- Audits --------
  /**
   * Production: calls MCP tool `audit_workspace` with the container's
   * accountId/containerId/workspaceId. The MCP server already implements
   * this tool — we just need a thin proxy.
   */
  async runAudit(containerPublicId: string): Promise<AuditSummary> {
    const found = MOCK_AUDITS[containerPublicId];
    if (found) return delay(found);
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

  /**
   * Frontend-only stub. Production: POST to /api/approvals with the plan,
   * then route it to a Samarth reviewer dashboard.
   */
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
