/**
 * TagDrishti Tag Verification Engine — public API.
 *
 * verifyPage(rawSpec, opts) is the end-to-end entry: validate spec → capture in
 * a real browser → run the pure assertion engine → build the report. The
 * layers are also exported individually so each can be used/tested alone.
 */

import { validateSpec, specHash } from './spec-schema.js';
import { capture as runBrowserCapture, type VerifyCaptureOptions, type FixtureProvider } from './capture/capture.js';
import { runAssertions } from './assert/engine.js';
import { buildReport } from './report/report.js';
import { DEFAULT_SETTLE } from './capture/settle.js';
import type { CaptureResult, VerifyReport, VerifySpec } from './types.js';

export interface VerifyOptions {
  headless?: boolean;
  navTimeoutMs?: number;
  settleQuietMs?: number;
  settleMaxMs?: number;
  allowlist?: string[];
  /** Test-only offline fixtures. */
  fixtures?: FixtureProvider | null;
}

/** Merge CLI/config overrides with the spec's settle block and engine defaults. */
export function resolveCaptureOptions(spec: VerifySpec, opts: VerifyOptions = {}): VerifyCaptureOptions {
  return {
    headless: opts.headless ?? true,
    navTimeoutMs: opts.navTimeoutMs ?? 30_000,
    settle: {
      quietMs: opts.settleQuietMs ?? spec.settle?.quietMs ?? DEFAULT_SETTLE.quietMs,
      maxMs: opts.settleMaxMs ?? spec.settle?.maxMs ?? DEFAULT_SETTLE.maxMs,
    },
    allowlist: opts.allowlist ?? [],
    fixtures: opts.fixtures ?? null,
  };
}

/** Full pipeline: validate → capture (browser) → assert → report. */
export async function verifyPage(rawSpec: unknown, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const spec = validateSpec(rawSpec);
  const hash = specHash(rawSpec);
  const captureOpts = resolveCaptureOptions(spec, opts);
  const capture = await runBrowserCapture(spec, captureOpts);
  const results = runAssertions(capture, spec);
  return buildReport(spec, hash, capture, results);
}

/** Assemble a report from an already-produced capture (pure; no browser). */
export function reportFromCapture(rawSpec: unknown, capture: CaptureResult): VerifyReport {
  const spec = validateSpec(rawSpec);
  const hash = specHash(rawSpec);
  const results = runAssertions(capture, spec);
  return buildReport(spec, hash, capture, results);
}

export * from './types.js';
export { validateSpec, specHash, SpecValidationError } from './spec-schema.js';
export { runAssertions, runCheck, rollupOverall } from './assert/engine.js';
export { buildReport } from './report/report.js';
export { formatHuman } from './report/human.js';
export { toScorecardInput } from './report/scorecard-adapter.js';
export type { ScorecardInput, ScorecardArea, ScorecardFindingLite } from './report/scorecard-adapter.js';
export { runCapture, capture } from './capture/capture.js';
export type { VerifyCaptureOptions, FixtureProvider, FixtureResponse } from './capture/capture.js';
export { parseCollectRequest, isGa4CollectRequest } from './ga4-hits.js';
export { decodeGcs, decodeGcd } from './consent-signals.js';
export { serverSideVerifier, NotImplementedError } from './server-side.js';
