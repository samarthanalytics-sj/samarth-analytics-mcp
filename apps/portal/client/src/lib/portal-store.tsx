import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { portalApi } from "./portal-api";
import { MOCK_APPROVALS } from "@/data/mock";
import { useToast } from "@/hooks/use-toast";
import type {
  ApprovalItem,
  ApprovalStatus,
  ChangePlan,
  OAuthState,
} from "@shared/portal-types";

function consumeOAuthFlash(): "success" | { error: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  const error = params.get("oauth_error");
  if (!connected && !error) return null;
  params.delete("connected");
  params.delete("oauth_error");
  const search = params.toString();
  const newUrl =
    window.location.pathname +
    (search ? `?${search}` : "") +
    (window.location.hash || "#/");
  window.history.replaceState(null, "", newUrl);
  if (error) return { error };
  if (connected) return "success";
  return null;
}

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
  const { toast } = useToast();

  useEffect(() => {
    portalApi.getOAuthState().then(setOAuth);
    const flash = consumeOAuthFlash();
    if (flash === "success") {
      toast({
        title: "Google connected",
        description: "Your Google Tag Manager account is now linked to the portal.",
      });
    } else if (flash && typeof flash === "object") {
      toast({
        title: "Google sign-in failed",
        description: `Google returned: ${flash.error}. Please try connecting again.`,
        variant: "destructive",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
