import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { portalApi } from "@/lib/portal-api";
import type {
  GtmAccountSummary,
  GtmContainerSummary,
  GtmWorkspaceSummary,
} from "@shared/portal-types";

export interface GtmSelection {
  accountId: string;
  containerId: string;
  workspaceId: string;
  setAccountId: (id: string) => void;
  setContainerId: (id: string) => void;
  setWorkspaceId: (id: string) => void;
  /** Set the account and clear the downstream container/workspace tiers. */
  selectAccount: (id: string) => void;
  /** Set the container and clear the downstream workspace tier. */
  selectContainer: (id: string) => void;

  accountsQuery: ReturnType<typeof useQuery<GtmAccountSummary[]>>;
  containersQuery: ReturnType<typeof useQuery<GtmContainerSummary[]>>;
  workspacesQuery: ReturnType<typeof useQuery<GtmWorkspaceSummary[]>>;

  accounts: GtmAccountSummary[];
  containers: GtmContainerSummary[];
  workspaces: GtmWorkspaceSummary[];

  /** The selected container's public id, falling back to the raw id. */
  containerPublicId: string;
  /** Whether all three tiers are chosen. */
  canRun: boolean;
}

/**
 * The account → container → workspace cascade shared by the audit, consent-v2,
 * and server-side pages: three dependent TanStack queries plus the auto-select
 * effects that pick the first available option at each tier and clear a stale
 * selection when the upstream list changes.
 *
 * `preferContainer` lets a page bias the auto-selected container (server-side
 * prefers a server container). It only affects which option is auto-picked when
 * none is selected — explicit user choices always win.
 */
export function useGtmSelection(options?: {
  enabled?: boolean;
  preferContainer?: (containers: GtmContainerSummary[]) => GtmContainerSummary | undefined;
}): GtmSelection {
  const enabled = options?.enabled ?? false;
  const preferContainer = options?.preferContainer;

  const [accountId, setAccountId] = useState<string>("");
  const [containerId, setContainerId] = useState<string>("");
  const [workspaceId, setWorkspaceId] = useState<string>("");

  const accountsQuery = useQuery({
    queryKey: ["/api/gtm/accounts"],
    queryFn: () => portalApi.listGtmAccounts(),
    enabled,
    retry: false,
  });

  const containersQuery = useQuery({
    queryKey: ["/api/gtm/containers", accountId],
    queryFn: () => portalApi.listGtmContainers(accountId),
    enabled: enabled && Boolean(accountId),
    retry: false,
  });

  const workspacesQuery = useQuery({
    queryKey: ["/api/gtm/workspaces", accountId, containerId],
    queryFn: () => portalApi.listGtmWorkspaces(accountId, containerId),
    enabled: enabled && Boolean(accountId && containerId),
    retry: false,
  });

  useEffect(() => {
    const list = accountsQuery.data ?? [];
    if (!accountId && list.length > 0) setAccountId(list[0].accountId);
  }, [accountsQuery.data, accountId]);

  useEffect(() => {
    const list = containersQuery.data ?? [];
    if (containerId && !list.some((c) => c.containerId === containerId)) {
      setContainerId("");
    }
    if (!containerId && list.length > 0) {
      const preferred = preferContainer?.(list);
      setContainerId((preferred ?? list[0]).containerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containersQuery.data, containerId]);

  useEffect(() => {
    const list = workspacesQuery.data ?? [];
    if (workspaceId && !list.some((w) => w.workspaceId === workspaceId)) {
      setWorkspaceId("");
    }
    if (!workspaceId && list.length > 0) setWorkspaceId(list[0].workspaceId);
  }, [workspacesQuery.data, workspaceId]);

  const containers = containersQuery.data ?? [];
  const containerPublicId = useMemo(() => {
    const c = containers.find((c) => c.containerId === containerId);
    return c?.publicId ?? containerId;
  }, [containers, containerId]);

  const selectAccount = (id: string) => {
    setAccountId(id);
    setContainerId("");
    setWorkspaceId("");
  };
  const selectContainer = (id: string) => {
    setContainerId(id);
    setWorkspaceId("");
  };

  return {
    accountId,
    containerId,
    workspaceId,
    setAccountId,
    setContainerId,
    setWorkspaceId,
    selectAccount,
    selectContainer,
    accountsQuery,
    containersQuery,
    workspacesQuery,
    accounts: accountsQuery.data ?? [],
    containers,
    workspaces: workspacesQuery.data ?? [],
    containerPublicId,
    canRun: Boolean(accountId && containerId && workspaceId),
  };
}
