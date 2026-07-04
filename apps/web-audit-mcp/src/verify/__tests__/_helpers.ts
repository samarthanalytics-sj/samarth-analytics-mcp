/** Shared test harness + factories for the verify suites (tsx + node:assert style). */

import type { CaptureResult, Ga4Hit, TrackerObservation, ActionResult, ConsentEventCapture } from '../types.js';

export interface Harness {
  check: (name: string, cond: boolean, detail?: string) => void;
  done: (minChecks?: number) => void;
}

export function harness(suite: string): Harness {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  return {
    check(name: string, cond: boolean, detail?: string): void {
      if (cond) passed += 1;
      else {
        failed += 1;
        failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
      }
    },
    done(minChecks = 0): void {
      // eslint-disable-next-line no-console
      console.log(`${suite}: ${passed} passed, ${failed} failed`);
      if (failed > 0) {
        for (const f of failures) console.error(f);
        process.exit(1);
      }
      if (passed < minChecks) {
        console.error(`${suite}: expected at least ${minChecks} checks, got ${passed}`);
        process.exit(1);
      }
    },
  };
}

export function hit(partial: Partial<Ga4Hit> = {}): Ga4Hit {
  return {
    en: 'page_view',
    params: {},
    hasItems: false,
    transport: 'GET',
    legacy: false,
    tRelativeMs: 100,
    ...partial,
  };
}

export function tracker(partial: Partial<TrackerObservation> = {}): TrackerObservation {
  return {
    url: 'https://example.test/x',
    domain: 'example.test',
    vendor: 'ga4',
    method: 'GET',
    tRelativeMs: 100,
    ...partial,
  };
}

export function action(partial: Partial<ActionResult> = {}): ActionResult {
  return {
    checkId: 'c1',
    kind: 'click',
    selectorFound: true,
    performed: true,
    atTMs: 500,
    ...partial,
  };
}

export function consentEvent(partial: Partial<ConsentEventCapture> = {}): ConsentEventCapture {
  return { kind: 'default', fields: {}, ...partial };
}

export function capture(partial: Partial<CaptureResult> = {}): CaptureResult {
  return {
    requestedUrl: 'https://example.test/',
    finalUrl: 'https://example.test/',
    httpStatus: 200,
    loaded: true,
    gtmPresent: true,
    settled: true,
    ga4Hits: [],
    trackers: [],
    consentActionTMs: null,
    consentAction: null,
    cookiesPreConsent: [],
    cookiesPostConsent: [],
    dataLayerEvents: [],
    consentEvents: [],
    actions: [],
    notes: [],
    consoleErrors: [],
    pageErrors: [],
    ...partial,
  };
}
