import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { portalApi } from "./portal-api";
import { MOCK_APPROVALS } from "@/data/mock";
import type {
  ApprovalItem,
  ApprovalStatus,
  ChangePlan,
  OAuthState,
} from "@shared/portal-types";

interface PortalStore {
  oauth: OAuthState;
  setOAuth: (s: OAuthState) => void;
  approvals: ApprovalItem[];
  addApproval: (a: ApprovalItem) => void;
  updateApproval: (id: string, patch: Partial<ApprovalItem>) => void;
  activePlan: ChangePlan | null;
  setActivePlan: (p: ChangePlan | null) => void;
}

const Ctx = createContext<PortalStore | null>(null);

export function PortalProvider({ children }: { children: React.ReactNode }) {
  const [oauth, setOAuth] = useState<OAuthState>({ connected: false });
  const [approvals, setApprovals] = useState<ApprovalItem[]>(MOCK_APPROVALS);
  const [activePlan, setActivePlan] = useState<ChangePlan | null>(null);

  useEffect(() => {
    portalApi.getOAuthState().then(setOAuth);
  }, []);

  const value = useMemo<PortalStore>(
    () => ({
      oauth,
      setOAuth,
      approvals,
      addApproval: (a) => setApprovals((prev) => [a, ...prev]),
      updateApproval: (id, patch) =>
        setApprovals((prev) =>
          prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        ),
      activePlan,
      setActivePlan,
    }),
    [oauth, approvals, activePlan],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePortal(): PortalStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePortal must be inside PortalProvider");
  return ctx;
}

export function statusLabel(status: ApprovalStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "pending_review":
      return "Pending Samarth review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "published":
      return "Published";
  }
}
