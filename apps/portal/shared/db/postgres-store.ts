// Postgres adapter skeleton for `ProductionStore`.
//
// FORWARD-LOOKING foundation. This is a PRODUCTION-READY SKELETON, not a live
// implementation: it deliberately does NOT add a `pg`/drizzle/supabase-js
// dependency to keep the portal bundle light and the foundation inert until a
// deployment opts in. Every store method throws `StoreNotWiredError` with a
// pointer to the exact wiring step, so a misconfigured deployment fails loud and
// early instead of silently returning empty data.
//
// HOW TO WIRE (Phase 1 of the scaling roadmap):
//   1. `npm i pg` (or `drizzle-orm` + `postgres`, or `@supabase/supabase-js`).
//   2. In the constructor, create the pool LAZILY from `cfg.connectionString`
//      (this file is only ever imported lazily from `api/**` after auth, so the
//      driver import is fine here — never at an `api/**` module top level).
//   3. Replace each `notWired(...)` body with a parameterized query. Set the
//      tenant GUC per transaction so the RLS policies in 0001_init.sql apply:
//        await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
//   4. Map snake_case columns ↔ the camelCase domain types in production-types.ts.
//
// Until then, `createProductionStore()` returns `null` when no DB is configured,
// and call sites fall back to the current stateless behavior.

import type {
  ApprovalRequest,
  AuditFindingRow,
  AuditRun,
  GtmContainerSnapshot,
  Organization,
  ProductionStore,
  User,
  Uuid,
  WorkerJob,
} from "../production-types";
import type { ApprovalStatus } from "../portal-types";
import type { DbConfig } from "./config";

/** Thrown by every skeleton method until a real driver is wired in. */
export class StoreNotWiredError extends Error {
  constructor(method: string) {
    super(
      `PostgresStore.${method} is not wired. The durable store is a skeleton ` +
        `(no DB driver dependency is installed). See apps/portal/shared/db/` +
        `postgres-store.ts "HOW TO WIRE" to implement, or run without ` +
        `DATABASE_URL to use the stateless signed-cookie path.`,
    );
    this.name = "StoreNotWiredError";
  }
}

/**
 * Skeleton implementation. Holds the resolved config (including the connection
 * string secret) but never connects. A real implementation would lazily create
 * a pool in the constructor and close it in `close()`.
 */
export class PostgresStore implements ProductionStore {
  private readonly cfg: DbConfig;

  constructor(cfg: DbConfig) {
    if (cfg.driver !== "postgres" || !cfg.connectionString) {
      throw new Error(
        "PostgresStore requires a postgres DbConfig with a connectionString.",
      );
    }
    this.cfg = cfg;
  }

  /** Non-secret view of how this store is configured (for diagnostics/tests). */
  describe(): { driver: string; ssl: boolean; poolMax: number } {
    return {
      driver: this.cfg.driver,
      ssl: this.cfg.ssl,
      poolMax: this.cfg.poolMax,
    };
  }

  getOrgBySlug(_slug: string): Promise<Organization | null> {
    return Promise.reject(new StoreNotWiredError("getOrgBySlug"));
  }

  upsertUserByGoogleSub(
    _user: Pick<User, "googleSub" | "email" | "displayName" | "pictureUrl">,
  ): Promise<User> {
    return Promise.reject(new StoreNotWiredError("upsertUserByGoogleSub"));
  }

  listGtmContainers(
    _orgId: Uuid,
    _accountId: string,
  ): Promise<GtmContainerSnapshot[]> {
    return Promise.reject(new StoreNotWiredError("listGtmContainers"));
  }

  upsertGtmContainers(
    _orgId: Uuid,
    _rows: GtmContainerSnapshot[],
  ): Promise<void> {
    return Promise.reject(new StoreNotWiredError("upsertGtmContainers"));
  }

  createAuditRun(
    _run: Omit<AuditRun, "id" | "createdAt" | "startedAt" | "finishedAt">,
  ): Promise<AuditRun> {
    return Promise.reject(new StoreNotWiredError("createAuditRun"));
  }

  getAuditRun(_orgId: Uuid, _id: Uuid): Promise<AuditRun | null> {
    return Promise.reject(new StoreNotWiredError("getAuditRun"));
  }

  listAuditRuns(_orgId: Uuid, _projectId?: Uuid): Promise<AuditRun[]> {
    return Promise.reject(new StoreNotWiredError("listAuditRuns"));
  }

  insertFindings(_orgId: Uuid, _rows: AuditFindingRow[]): Promise<void> {
    return Promise.reject(new StoreNotWiredError("insertFindings"));
  }

  enqueueJob(
    _job: Omit<WorkerJob, "id" | "createdAt" | "updatedAt" | "finishedAt">,
  ): Promise<WorkerJob> {
    return Promise.reject(new StoreNotWiredError("enqueueJob"));
  }

  leaseNextJob(
    _workerId: string,
    _leaseSeconds: number,
  ): Promise<WorkerJob | null> {
    return Promise.reject(new StoreNotWiredError("leaseNextJob"));
  }

  completeJob(_id: Uuid, _captureId: Uuid | null): Promise<void> {
    return Promise.reject(new StoreNotWiredError("completeJob"));
  }

  failJob(_id: Uuid, _error: string): Promise<void> {
    return Promise.reject(new StoreNotWiredError("failJob"));
  }

  listApprovals(
    _orgId: Uuid,
    _status?: ApprovalStatus,
  ): Promise<ApprovalRequest[]> {
    return Promise.reject(new StoreNotWiredError("listApprovals"));
  }

  /** Close any pooled connections. No-op in the skeleton. */
  async close(): Promise<void> {
    /* a real impl closes its pool here */
  }
}
