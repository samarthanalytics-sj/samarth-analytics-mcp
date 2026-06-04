#!/usr/bin/env node
// Samarth runtime capture worker — QUEUE CONSUMER mode (SKELETON).
//
// FORWARD-LOOKING foundation (Workstream B). The worker's default and currently
// supported mode is the read-only HTTP `/capture` endpoint in server.mjs — that
// stays exactly as-is. This module adds an *opt-in* second mode: instead of
// being called over HTTP, the worker pulls runtime-capture jobs from a durable
// queue (Postgres `worker_jobs` SKIP LOCKED, or QStash/SQS later), runs the
// same read-only capture, and reports the result back.
//
// It is a skeleton on purpose:
//   • The queue CLIENT is pluggable (`QueueClient`); no Redis/Postgres driver is
//     imported here and no live credentials are required. A built-in in-memory
//     dev queue lets you exercise the loop end-to-end locally.
//   • The job payload / result shapes mirror
//     apps/portal/shared/jobs.ts (RuntimeCaptureJobPayload / …Result) so the
//     portal-side enqueue and this consumer share one contract.
//   • Capture itself reuses capture.mjs unchanged, so the read-only guarantee
//     and the v2/v3 artifact schemas are identical to HTTP mode.
//
// Run (dev/demo, in-memory queue, no external services):
//   RUNTIME_WORKER_MODE=queue node queue-consumer.mjs --demo
//
// Wiring a real queue is a later step: implement QueueClient against the durable
// store and pass it to runQueueConsumer(). See docs/PRODUCTION_ARCHITECTURE.md
// §4.3 and apps/runtime-worker/README.md "Queue consumer mode".

import {
  capture,
  captureConsentStates,
  summarizeCapture,
  PlaywrightMissingError,
} from "./capture.mjs";

/**
 * @typedef {Object} RuntimeCaptureJobPayload
 * @property {"runtime_capture"} kind
 * @property {string[]} urls
 * @property {Object} [consentState]
 * @property {Object[]} [consentStates]
 * @property {Object[]} [actions]
 * @property {number} [wait]
 * @property {number} [timeout]
 */

/**
 * @typedef {Object} QueuedJob
 * @property {string} id
 * @property {string} orgId
 * @property {RuntimeCaptureJobPayload} payload
 */

/**
 * The contract a real queue backend must satisfy. Intentionally tiny and
 * matched to apps/portal/shared/jobs.ts so the durable Postgres/QStash client
 * drops in without touching the loop below.
 *
 * @typedef {Object} QueueClient
 * @property {(workerId: string, leaseSeconds: number) => Promise<QueuedJob|null>} lease
 * @property {(id: string, result: object) => Promise<void>} complete
 * @property {(id: string, error: string) => Promise<void>} fail
 */

const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_POLL_MS = 2000;

/**
 * Drive one runtime-capture job using the existing read-only capture core.
 * Returns a RuntimeCaptureJobResult-shaped object (see shared/jobs.ts). It never
 * returns the raw artifact — that is PII-sensitive and is persisted out-of-band
 * by the durable layer; here we surface only a pointer-less summary so the
 * skeleton stays safe to log.
 *
 * @param {RuntimeCaptureJobPayload} payload
 * @param {{ wait?: number, timeout?: number }} [clamp]
 */
export async function processCaptureJob(payload, clamp = {}) {
  const wait = Math.min(Number(payload.wait) || 4000, clamp.wait ?? 8000);
  const timeout = Math.min(Number(payload.timeout) || 30000, clamp.timeout ?? 30000);
  const wantsMultiState =
    Array.isArray(payload.consentStates) && payload.consentStates.length > 0;

  const artifact = wantsMultiState
    ? await captureConsentStates(
        { urls: payload.urls, consentStates: payload.consentStates, actions: payload.actions },
        { wait, timeout },
      )
    : await capture(
        { urls: payload.urls, consentState: payload.consentState, actions: payload.actions },
        { wait, timeout },
      );

  const summary = summarizeCapture(artifact);
  const trackerHits = Object.values(summary.groups ?? {}).reduce((a, b) => a + b, 0);
  return {
    ok: true,
    // A real consumer persists `artifact` to runtime_captures and sets these.
    captureId: null,
    artifactUri: null,
    schema: artifact.schema ?? null,
    summary: {
      urls: Array.isArray(payload.urls) ? payload.urls.length : 0,
      consentStates: wantsMultiState ? payload.consentStates.length : undefined,
      trackerHits,
    },
  };
}

/**
 * Long-running consumer loop: lease → process → complete/fail, sleeping
 * `pollMs` when the queue is empty. Cooperative shutdown via an AbortSignal.
 *
 * @param {QueueClient} queue
 * @param {{ workerId?: string, leaseSeconds?: number, pollMs?: number,
 *           signal?: AbortSignal, clamp?: { wait?: number, timeout?: number },
 *           log?: (msg: string) => void }} [opts]
 */
export async function runQueueConsumer(queue, opts = {}) {
  const workerId = opts.workerId ?? `worker_${process.pid}`;
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const log = opts.log ?? ((m) => console.log(`[queue-consumer] ${m}`));
  const signal = opts.signal;

  log(`starting as ${workerId} (lease ${leaseSeconds}s, poll ${pollMs}ms)`);
  while (!signal?.aborted) {
    let job;
    try {
      job = await queue.lease(workerId, leaseSeconds);
    } catch (e) {
      log(`lease error: ${String(e?.message ?? e)}`);
      await sleep(pollMs, signal);
      continue;
    }
    if (!job) {
      await sleep(pollMs, signal);
      continue;
    }
    log(`leased ${job.id} (${job.payload?.urls?.length ?? 0} urls)`);
    try {
      const result = await processCaptureJob(job.payload, opts.clamp);
      await queue.complete(job.id, result);
      log(`completed ${job.id}`);
    } catch (e) {
      const reason =
        e instanceof PlaywrightMissingError
          ? `playwright_missing: ${e.message}`
          : String(e?.message ?? e).slice(0, 500);
      await queue.fail(job.id, reason);
      log(`failed ${job.id}: ${reason}`);
    }
  }
  log("stopped");
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Minimal in-memory queue for local demos and tests. NOT durable, single
 * process. Mirrors the lease/complete/fail subset of shared/jobs.ts.
 */
export class InMemoryQueueClient {
  constructor() {
    this.jobs = [];
    this.byId = new Map();
    this.seq = 0;
  }
  enqueue(orgId, payload) {
    const job = { id: `job_${++this.seq}`, orgId, payload, status: "queued", result: null };
    this.jobs.push(job);
    this.byId.set(job.id, job);
    return job;
  }
  async lease(workerId) {
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) return null;
    job.status = "leased";
    job.leasedBy = workerId;
    return { id: job.id, orgId: job.orgId, payload: job.payload };
  }
  async complete(id, result) {
    const job = this.byId.get(id);
    if (job) {
      job.status = "succeeded";
      job.result = result;
    }
  }
  async fail(id, error) {
    const job = this.byId.get(id);
    if (job) {
      job.status = "failed";
      job.lastError = error;
    }
  }
}

// ── Demo entrypoint ──────────────────────────────────────────────────────────
// Only runs when invoked directly with RUNTIME_WORKER_MODE=queue. Importing this
// module (e.g. from a test) never starts the loop. The HTTP server (server.mjs)
// is unaffected and remains the default mode.
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("queue-consumer.mjs");

if (invokedDirectly) {
  const mode = (process.env.RUNTIME_WORKER_MODE ?? "").toLowerCase();
  const demo = process.argv.includes("--demo");
  if (mode !== "queue") {
    console.error(
      "[queue-consumer] queue mode is opt-in. Set RUNTIME_WORKER_MODE=queue to run.\n" +
        "[queue-consumer] The default/supported mode is the HTTP server (server.mjs).",
    );
    process.exit(demo ? 0 : 1);
  }
  if (!demo) {
    console.error(
      "[queue-consumer] no durable queue client is wired yet (skeleton).\n" +
        "[queue-consumer] run with --demo to exercise the loop against an in-memory queue,\n" +
        "[queue-consumer] or implement QueueClient against your durable store and call runQueueConsumer().",
    );
    process.exit(1);
  }
  const queue = new InMemoryQueueClient();
  queue.enqueue("demo-org", { kind: "runtime_capture", urls: ["https://example.com"] });
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  // Stop the demo shortly after the single seeded job drains.
  setTimeout(() => controller.abort(), 15000).unref();
  runQueueConsumer(queue, { signal: controller.signal, pollMs: 500 }).then(() => {
    console.log("[queue-consumer] demo finished.");
    process.exit(0);
  });
}
