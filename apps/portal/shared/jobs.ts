// Async job foundation — pure, dependency-free.
//
// FORWARD-LOOKING foundation (Workstream B). Defines the lifecycle, the
// payload/result contracts, and a minimal queue *interface* for async audit
// runs and runtime-capture jobs, plus an in-memory dev adapter and a noop
// adapter. Like cache-keys.ts and production-types.ts, this file opens no
// connection and imports no driver — it only describes shapes and the legal
// state machine, so it is safe to import from the Vercel serverless `api/**`
// routes (no heavy top-level import) and from the Node worker.
//
// Wiring this to a durable backend (Postgres `worker_jobs` with SKIP LOCKED, or
// SQS/QStash later) is a separate step: the concrete implementation satisfies
// the `JobQueue` interface so route/worker call sites never change. See
// docs/PRODUCTION_ARCHITECTURE.md §4.2/§4.3 and docs/API_JOBS.md.
//
// Lifecycle enums are re-exported from production-types.ts (which mirrors the
// SQL CHECK constraints) so there is a single source of truth.

import type {
  AuditRunStatus,
  WorkerJobKind,
  WorkerJobStatus,
} from "./production-types";

export type { AuditRunStatus, WorkerJobKind, WorkerJobStatus };

// ── Status machines ──────────────────────────────────────────────────────────

/**
 * Terminal audit-run statuses. Once a run is in one of these it never moves
 * again; a status-poll endpoint may stop polling and the status cache key is
 * deleted on the transition (see cache-keys.ts CACHE_POLICY.audit_run_status).
 */
export const AUDIT_TERMINAL_STATUSES: readonly AuditRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

/**
 * Legal audit-run transitions. `queued → running → (succeeded|failed)` is the
 * happy path; `cancelled` may be requested from `queued` or `running`. Terminal
 * states have no outgoing edges.
 */
const AUDIT_TRANSITIONS: Record<AuditRunStatus, readonly AuditRunStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** Terminal worker-job statuses (see production-types WorkerJobStatus). */
export const WORKER_TERMINAL_STATUSES: readonly WorkerJobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

/**
 * Legal worker-job transitions. A job is `queued`, gets `leased` by a worker,
 * then resolves. A lost lease returns `leased → queued` (the lease expired and
 * the job is retryable); a cancel can land from `queued` or `leased`.
 */
const WORKER_TRANSITIONS: Record<WorkerJobStatus, readonly WorkerJobStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["succeeded", "failed", "cancelled", "queued"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isAuditTerminal(status: AuditRunStatus): boolean {
  return AUDIT_TERMINAL_STATUSES.includes(status);
}

export function isWorkerTerminal(status: WorkerJobStatus): boolean {
  return WORKER_TERMINAL_STATUSES.includes(status);
}

export function canTransitionAudit(
  from: AuditRunStatus,
  to: AuditRunStatus,
): boolean {
  return AUDIT_TRANSITIONS[from].includes(to);
}

export function canTransitionWorker(
  from: WorkerJobStatus,
  to: WorkerJobStatus,
): boolean {
  return WORKER_TRANSITIONS[from].includes(to);
}

/**
 * Assert a worker-job transition is legal, throwing a descriptive error
 * otherwise. The in-memory adapter and any durable implementation should route
 * status changes through this so an illegal flip (e.g. reviving a terminal job)
 * fails loudly instead of silently corrupting state.
 */
export function assertWorkerTransition(
  from: WorkerJobStatus,
  to: WorkerJobStatus,
): void {
  if (from === to) return;
  if (!canTransitionWorker(from, to)) {
    throw new Error(`illegal worker job transition: ${from} → ${to}`);
  }
}

export function assertAuditTransition(
  from: AuditRunStatus,
  to: AuditRunStatus,
): void {
  if (from === to) return;
  if (!canTransitionAudit(from, to)) {
    throw new Error(`illegal audit run transition: ${from} → ${to}`);
  }
}

// ── Runtime-capture job payload / result contracts ───────────────────────────

/** One Consent Mode v2 signal state to drive a capture pass under. */
export interface ConsentSignalState {
  ad_storage?: "granted" | "denied";
  analytics_storage?: "granted" | "denied";
  ad_user_data?: "granted" | "denied";
  ad_personalization?: "granted" | "denied";
}

/** The safe, read-only action allow-list mirrored from the worker (`wait`/`scroll`). */
export type RuntimeCaptureAction =
  | { type: "wait"; ms: number }
  | { type: "scroll" };

/**
 * Payload enqueued for a runtime-capture job. This is exactly the input the
 * worker needs to reproduce a capture; it is the typed contract for
 * `WorkerJob.payload` when `kind === "runtime_capture"`. URLs are validated at
 * the API boundary and again by the worker (SSRF allow-list) — this type does
 * not itself enforce host policy.
 */
export interface RuntimeCaptureJobPayload {
  kind: "runtime_capture";
  /** Pages to load (http/https). Bounded by the worker's RUNTIME_WORKER_MAX_URLS. */
  urls: string[];
  /** Single consent state for a v2 capture. Mutually exclusive with `consentStates`. */
  consentState?: ConsentSignalState;
  /** Multiple states for a v3 Consent Mode proof capture (one pass each). */
  consentStates?: ConsentSignalState[];
  /** Optional read-only triggers for lazy tags. */
  actions?: RuntimeCaptureAction[];
  /** Per-page settle time (ms); clamped by the worker. */
  wait?: number;
  /** Navigation timeout (ms); clamped by the worker. */
  timeout?: number;
}

/**
 * Result a worker reports back for a runtime-capture job. The artifact itself
 * is PII-sensitive (see NEVER_CACHE in cache-keys.ts): the queue carries only a
 * pointer (`captureId`/`artifactUri`) plus a non-sensitive summary, never the
 * raw capture body.
 */
export interface RuntimeCaptureJobResult {
  ok: boolean;
  /** runtime_captures row id the worker persisted the artifact under. */
  captureId: string | null;
  /** Object-storage pointer when the artifact is offloaded; else null. */
  artifactUri: string | null;
  /** Capture artifact schema string, e.g. "samarth.runtime-capture/v2". */
  schema: string | null;
  /** Non-sensitive counts the portal can show without the raw artifact. */
  summary?: {
    urls: number;
    consentStates?: number;
    trackerHits?: number;
  };
  /** Present only when ok === false. */
  error?: string;
}

/** Discriminated union of all job payloads. Extend as new job kinds land. */
export type JobPayload = RuntimeCaptureJobPayload;

/** Narrowing guard for the runtime-capture payload. */
export function isRuntimeCapturePayload(
  payload: { kind?: unknown },
): payload is RuntimeCaptureJobPayload {
  return payload?.kind === "runtime_capture";
}

// ── Queue interface ──────────────────────────────────────────────────────────

/** A job as the queue tracks it. Mirrors production-types `WorkerJob` minus DB-only columns. */
export interface QueuedJob {
  id: string;
  orgId: string;
  kind: WorkerJobKind;
  status: WorkerJobStatus;
  payload: JobPayload;
  priority: number;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: number | null;
  leasedBy: string | null;
  lastError: string | null;
  result: RuntimeCaptureJobResult | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields a caller supplies when enqueuing; the queue fills in the rest. */
export interface EnqueueJobInput {
  orgId: string;
  kind: WorkerJobKind;
  payload: JobPayload;
  priority?: number;
  maxAttempts?: number;
}

/**
 * Pure queue contract. A durable implementation (Postgres SKIP LOCKED) or a
 * managed one (QStash/SQS) satisfies this so call sites are backend-agnostic.
 * Every method is org-scoped where it reads a single job, mirroring
 * ProductionStore.
 */
export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<QueuedJob>;
  /**
   * Atomically lease the next runnable job for `workerId`, holding it for
   * `leaseSeconds`. Returns null when the queue is empty. Implementations must
   * not hand the same job to two workers concurrently.
   */
  lease(workerId: string, leaseSeconds: number): Promise<QueuedJob | null>;
  /** Mark a leased job succeeded with its result. */
  complete(id: string, result: RuntimeCaptureJobResult): Promise<void>;
  /**
   * Mark a leased job failed. If attempts remain it returns to `queued` for
   * retry; otherwise it lands in the terminal `failed` state.
   */
  fail(id: string, error: string): Promise<void>;
  /** Request cancellation (from queued or leased). */
  cancel(id: string): Promise<void>;
  /** Read a single job, org-scoped. */
  get(orgId: string, id: string): Promise<QueuedJob | null>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * In-memory `JobQueue` for tests and local dev. Single-process, non-durable —
 * restarting loses all jobs. It models lease expiry and retry so call sites can
 * be exercised without any external service. `now` is injectable for
 * deterministic tests.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, QueuedJob>();
  private seq = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async enqueue(input: EnqueueJobInput): Promise<QueuedJob> {
    const t = this.now();
    const job: QueuedJob = {
      id: `job_${++this.seq}`,
      orgId: input.orgId,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      leaseExpiresAt: null,
      leasedBy: null,
      lastError: null,
      result: null,
      createdAt: t,
      updatedAt: t,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async lease(workerId: string, leaseSeconds: number): Promise<QueuedJob | null> {
    const t = this.now();
    // Reclaim expired leases first so abandoned jobs become runnable again.
    for (const job of this.jobs.values()) {
      if (
        job.status === "leased" &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt <= t
      ) {
        this.applyWorkerTransition(job, "queued");
        job.leasedBy = null;
        job.leaseExpiresAt = null;
      }
    }
    // Highest priority first, then oldest (FIFO) among queued jobs.
    const candidates = [...this.jobs.values()]
      .filter((j) => j.status === "queued")
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    const next = candidates[0];
    if (!next) return null;
    this.applyWorkerTransition(next, "leased");
    next.attempts += 1;
    next.leasedBy = workerId;
    next.leaseExpiresAt = t + leaseSeconds * 1000;
    return { ...next };
  }

  async complete(id: string, result: RuntimeCaptureJobResult): Promise<void> {
    const job = this.require(id);
    this.applyWorkerTransition(job, "succeeded");
    job.result = result;
    job.leasedBy = null;
    job.leaseExpiresAt = null;
  }

  async fail(id: string, error: string): Promise<void> {
    const job = this.require(id);
    job.lastError = error;
    if (job.attempts < job.maxAttempts) {
      // Retry: back to the queue. attempts already incremented on lease.
      this.applyWorkerTransition(job, "queued");
      job.leasedBy = null;
      job.leaseExpiresAt = null;
    } else {
      this.applyWorkerTransition(job, "failed");
      job.leasedBy = null;
      job.leaseExpiresAt = null;
    }
  }

  async cancel(id: string): Promise<void> {
    const job = this.require(id);
    this.applyWorkerTransition(job, "cancelled");
    job.leasedBy = null;
    job.leaseExpiresAt = null;
  }

  async get(orgId: string, id: string): Promise<QueuedJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.orgId !== orgId) return null;
    return { ...job };
  }

  /** Test/diagnostic helper — total jobs currently tracked. */
  size(): number {
    return this.jobs.size;
  }

  private require(id: string): QueuedJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    return job;
  }

  private applyWorkerTransition(job: QueuedJob, to: WorkerJobStatus): void {
    assertWorkerTransition(job.status, to);
    job.status = to;
    job.updatedAt = this.now();
  }
}

/**
 * No-op queue. `enqueue` succeeds and returns a synthetic queued job, but
 * nothing is ever leased — useful as the default when async work is disabled so
 * the synchronous path stays the only thing that actually runs. Selecting this
 * vs. the in-memory queue is a deployment choice (see selectJobQueue).
 */
export class NoopJobQueue implements JobQueue {
  private seq = 0;

  async enqueue(input: EnqueueJobInput): Promise<QueuedJob> {
    const t = Date.now();
    return {
      id: `noop_${++this.seq}`,
      orgId: input.orgId,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      leaseExpiresAt: null,
      leasedBy: null,
      lastError: null,
      result: null,
      createdAt: t,
      updatedAt: t,
    };
  }

  async lease(): Promise<QueuedJob | null> {
    return null;
  }
  async complete(): Promise<void> {}
  async fail(): Promise<void> {}
  async cancel(): Promise<void> {}
  async get(): Promise<QueuedJob | null> {
    return null;
  }
}

/**
 * Pick a dev/test queue adapter from env, defaulting to noop so nothing async
 * runs unless explicitly turned on. A durable Postgres/QStash queue is wired in
 * a later phase and is NOT constructed here (no driver import at module load).
 *
 *   GTM_PORTAL_JOB_QUEUE = "memory" → InMemoryJobQueue
 *   anything else / unset           → NoopJobQueue
 */
export function selectDevJobQueue(
  env: Record<string, string | undefined> = process.env,
): JobQueue {
  return env.GTM_PORTAL_JOB_QUEUE === "memory"
    ? new InMemoryJobQueue()
    : new NoopJobQueue();
}
