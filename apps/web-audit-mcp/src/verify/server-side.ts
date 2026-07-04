/**
 * Server-side verification — EXPLICIT NON-GOAL for v1, left as an empty,
 * clearly-separated interface so a future verifier can plug in without
 * reshaping the engine.
 *
 * v1 is client-side / browser-observable ONLY. Server-to-server hits (Meta CAPI,
 * server-side GTM, Measurement Protocol /mp/collect) cannot be seen from a
 * browser and are NOT covered here — nothing in this engine's output ever claims
 * server-side coverage. A future implementation would ingest Stape (or similar)
 * request logs, or platform test-event codes, and return CheckResult[] in the
 * same shape the client-side engine produces.
 */

import type { CheckResult, VerifySpec } from './types.js';

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface ServerSideVerifier {
  /** Verify server-side hits for a spec. NOT implemented in v1. */
  verify(spec: VerifySpec): Promise<CheckResult[]>;
}

/** Placeholder that refuses rather than fabricating server-side coverage. */
export const serverSideVerifier: ServerSideVerifier = {
  async verify(): Promise<CheckResult[]> {
    throw new NotImplementedError(
      'Server-side verification (CAPI / sGTM / Measurement Protocol) is not implemented in v1 — client-side only. ' +
        'This interface is a stub for a future Stape-log / test-event-code verifier.',
    );
  },
};
