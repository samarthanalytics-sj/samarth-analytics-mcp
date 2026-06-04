/**
 * Standalone Node test for the async job foundation (../jobs.ts).
 * Run: node apps/portal/shared/__tests__/jobs.node.test.mjs
 *
 * Mirrors the runtime behaviour of apps/portal/shared/jobs.ts without importing
 * TS (kept dependency-free like the other .node.test.mjs files). If the .ts
 * logic changes, update this mirror. Focus: lifecycle transition legality,
 * lease/complete/fail/retry, lease expiry reclaim, cancel, and org-scoped reads.
 *
 * Time is injected (`now`) so the suite is deterministic and never sleeps.
 */

import assert from "node:assert";

// ── transition machine mirror (kept in lockstep with jobs.ts) ────────────────
const WORKER_TRANSITIONS = {
  queued: ["leased", "cancelled"],
  leased: ["succeeded", "failed", "cancelled", "queued"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
const AUDIT_TRANSITIONS = {
  queued: ["running", "cancelled", "failed"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
const WORKER_TERMINAL = ["succeeded", "failed", "cancelled"];

function canTransitionWorker(from, to) {
  return WORKER_TRANSITIONS[from].includes(to);
}
function canTransitionAudit(from, to) {
  return AUDIT_TRANSITIONS[from].includes(to);
}
function assertWorkerTransition(from, to) {
  if (from === to) return;
  if (!canTransitionWorker(from, to)) {
    throw new Error(`illegal worker job transition: ${from} → ${to}`);
  }
}
function isWorkerTerminal(s) {
  return WORKER_TERMINAL.includes(s);
}

const DEFAULT_MAX_ATTEMPTS = 3;

// ── InMemoryJobQueue mirror ──────────────────────────────────────────────────
class InMemoryJobQueue {
  constructor(opts = {}) {
    this.jobs = new Map();
    this.seq = 0;
    this.now = opts.now ?? (() => Date.now());
  }
  async enqueue(input) {
    const t = this.now();
    const job = {
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
  async lease(workerId, leaseSeconds) {
    const t = this.now();
    for (const job of this.jobs.values()) {
      if (job.status === "leased" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= t) {
        this._tx(job, "queued");
        job.leasedBy = null;
        job.leaseExpiresAt = null;
      }
    }
    const next = [...this.jobs.values()]
      .filter((j) => j.status === "queued")
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
    if (!next) return null;
    this._tx(next, "leased");
    next.attempts += 1;
    next.leasedBy = workerId;
    next.leaseExpiresAt = t + leaseSeconds * 1000;
    return { ...next };
  }
  async complete(id, result) {
    const job = this._req(id);
    this._tx(job, "succeeded");
    job.result = result;
    job.leasedBy = null;
    job.leaseExpiresAt = null;
  }
  async fail(id, error) {
    const job = this._req(id);
    job.lastError = error;
    if (job.attempts < job.maxAttempts) {
      this._tx(job, "queued");
    } else {
      this._tx(job, "failed");
    }
    job.leasedBy = null;
    job.leaseExpiresAt = null;
  }
  async cancel(id) {
    const job = this._req(id);
    this._tx(job, "cancelled");
    job.leasedBy = null;
    job.leaseExpiresAt = null;
  }
  async get(orgId, id) {
    const job = this.jobs.get(id);
    if (!job || job.orgId !== orgId) return null;
    return { ...job };
  }
  size() {
    return this.jobs.size;
  }
  _req(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    return job;
  }
  _tx(job, to) {
    assertWorkerTransition(job.status, to);
    job.status = to;
    job.updatedAt = this.now();
  }
}

class NoopJobQueue {
  constructor() {
    this.seq = 0;
  }
  async enqueue(input) {
    const t = Date.now();
    return {
      id: `noop_${++this.seq}`,
      orgId: input.orgId,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      priority: 0,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      leaseExpiresAt: null,
      leasedBy: null,
      lastError: null,
      result: null,
      createdAt: t,
      updatedAt: t,
    };
  }
  async lease() {
    return null;
  }
  async complete() {}
  async fail() {}
  async cancel() {}
  async get() {
    return null;
  }
}

const PAYLOAD = { kind: "runtime_capture", urls: ["https://example.com"] };
let clock = 0;
const now = () => clock;
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok ${name}`);
}

// ── transition legality ──────────────────────────────────────────────────────
await check("worker happy path is legal, terminals are sinks", () => {
  assert.ok(canTransitionWorker("queued", "leased"));
  assert.ok(canTransitionWorker("leased", "succeeded"));
  assert.ok(!canTransitionWorker("succeeded", "queued"));
  assert.ok(!canTransitionWorker("failed", "leased"));
  for (const s of WORKER_TERMINAL) assert.ok(isWorkerTerminal(s));
});

await check("audit happy path is legal, no reviving terminals", () => {
  assert.ok(canTransitionAudit("queued", "running"));
  assert.ok(canTransitionAudit("running", "succeeded"));
  assert.ok(canTransitionAudit("queued", "cancelled"));
  assert.ok(!canTransitionAudit("succeeded", "running"));
  assert.ok(!canTransitionAudit("cancelled", "running"));
});

await check("assertWorkerTransition throws on an illegal flip", () => {
  assert.throws(() => assertWorkerTransition("succeeded", "queued"), /illegal worker job transition/);
  // self-transition is a no-op, not an error
  assert.doesNotThrow(() => assertWorkerTransition("leased", "leased"));
});

// ── enqueue / lease / complete ───────────────────────────────────────────────
await check("enqueue then lease moves queued → leased and sets attempts", async () => {
  clock = 1000;
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "org1", kind: "runtime_capture", payload: PAYLOAD });
  assert.strictEqual(j.status, "queued");
  const leased = await q.lease("w1", 30);
  assert.strictEqual(leased.id, j.id);
  assert.strictEqual(leased.status, "leased");
  assert.strictEqual(leased.attempts, 1);
  assert.strictEqual(leased.leasedBy, "w1");
  assert.strictEqual(leased.leaseExpiresAt, 1000 + 30_000);
});

await check("complete stores result and is terminal", async () => {
  clock = 0;
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "org1", kind: "runtime_capture", payload: PAYLOAD });
  await q.lease("w1", 30);
  await q.complete(j.id, { ok: true, captureId: "cap1", artifactUri: null, schema: "v2" });
  const got = await q.get("org1", j.id);
  assert.strictEqual(got.status, "succeeded");
  assert.deepStrictEqual(got.result, { ok: true, captureId: "cap1", artifactUri: null, schema: "v2" });
});

await check("empty queue leases null", async () => {
  const q = new InMemoryJobQueue({ now });
  assert.strictEqual(await q.lease("w1", 30), null);
});

// ── retry + failure ──────────────────────────────────────────────────────────
await check("fail with attempts remaining requeues for retry", async () => {
  clock = 0;
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "org1", kind: "runtime_capture", payload: PAYLOAD, maxAttempts: 2 });
  await q.lease("w1", 30); // attempts = 1
  await q.fail(j.id, "boom");
  let got = await q.get("org1", j.id);
  assert.strictEqual(got.status, "queued", "should requeue on first failure");
  assert.strictEqual(got.lastError, "boom");
  await q.lease("w2", 30); // attempts = 2 (== maxAttempts)
  await q.fail(j.id, "boom2");
  got = await q.get("org1", j.id);
  assert.strictEqual(got.status, "failed", "should land terminal after max attempts");
});

// ── lease expiry reclaim ─────────────────────────────────────────────────────
await check("expired lease is reclaimed and re-leasable", async () => {
  clock = 0;
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "org1", kind: "runtime_capture", payload: PAYLOAD });
  await q.lease("w1", 30); // lease until 30_000
  clock = 31_000; // lease expired
  const released = await q.lease("w2", 30);
  assert.strictEqual(released.id, j.id, "expired job should be handed to the next worker");
  assert.strictEqual(released.leasedBy, "w2");
  assert.strictEqual(released.attempts, 2, "re-lease increments attempts again");
});

// ── priority ordering ────────────────────────────────────────────────────────
await check("higher priority leases first, FIFO within a priority", async () => {
  clock = 0;
  const q = new InMemoryJobQueue({ now });
  const low = await q.enqueue({ orgId: "o", kind: "runtime_capture", payload: PAYLOAD, priority: 0 });
  clock = 1;
  const high = await q.enqueue({ orgId: "o", kind: "runtime_capture", payload: PAYLOAD, priority: 5 });
  const first = await q.lease("w", 10);
  assert.strictEqual(first.id, high.id, "priority 5 should win");
  const second = await q.lease("w", 10);
  assert.strictEqual(second.id, low.id);
});

// ── cancel ───────────────────────────────────────────────────────────────────
await check("cancel from queued is terminal", async () => {
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "org1", kind: "runtime_capture", payload: PAYLOAD });
  await q.cancel(j.id);
  const got = await q.get("org1", j.id);
  assert.strictEqual(got.status, "cancelled");
});

// ── tenant isolation ─────────────────────────────────────────────────────────
await check("get is org-scoped — another org cannot read the job", async () => {
  const q = new InMemoryJobQueue({ now });
  const j = await q.enqueue({ orgId: "orgA", kind: "runtime_capture", payload: PAYLOAD });
  assert.ok(await q.get("orgA", j.id));
  assert.strictEqual(await q.get("orgB", j.id), null);
});

// ── noop queue ───────────────────────────────────────────────────────────────
await check("NoopJobQueue enqueues but never leases", async () => {
  const q = new NoopJobQueue();
  const j = await q.enqueue({ orgId: "o", kind: "runtime_capture", payload: PAYLOAD });
  assert.strictEqual(j.status, "queued");
  assert.strictEqual(await q.lease("w", 30), null);
  assert.strictEqual(await q.get("o", j.id), null);
});

// eslint-disable-next-line no-console
console.log(`\njobs: ${passed} checks passed.`);
