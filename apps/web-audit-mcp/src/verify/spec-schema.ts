/**
 * Verification spec schema + validation + deterministic hash.
 *
 * The spec is validated on load; an invalid spec is rejected with a precise
 * message and JSON path (never a silent partial run). specHash is the sha256 of
 * the spec canonicalised with stable key ordering, so it is stable across key
 * reorderings and underpins the determinism guarantee.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { VerifySpec } from './types.js';

export class SpecValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid verification spec:\n  - ${issues.join('\n  - ')}`);
    this.name = 'SpecValidationError';
    this.issues = issues;
  }
}

const consentValue = z.enum(['granted', 'denied', 'unknown']);

const consentStateSchema = z
  .object({
    ad_storage: consentValue.optional(),
    analytics_storage: consentValue.optional(),
    ad_user_data: consentValue.optional(),
    ad_personalization: consentValue.optional(),
  })
  .strict();

const paramAssertion = z.union([z.string(), z.number(), z.boolean()]);

const CHECK_TYPES = [
  'event_fired',
  'event_on_interaction',
  'param_validation',
  'consent_mode',
  'duplicate_event',
  'tracker_present',
  'cross_domain_linker',
] as const;

const actionSchema = z
  .object({
    click: z.string().min(1).optional(),
    submit: z.string().min(1).optional(),
    navigate: z.string().url().optional(),
  })
  .strict();

const checkSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(CHECK_TYPES),
    tracker: z.string().optional(),
    event: z.string().optional(),
    tid: z.string().optional(),
    phase: z.enum(['pre_consent', 'post_consent']).optional(),
    params: z.record(paramAssertion).optional(),
    action: actionSchema.optional(),
    allowedCount: z.number().int().nonnegative().optional(),
    keyParams: z.array(z.string()).optional(),
    expectedDomains: z.array(z.string().min(1)).optional(),
    expectedDefault: consentStateSchema.optional(),
    expectedUpdate: consentStateSchema.optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    const need = (cond: boolean, msg: string): void => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
    };
    switch (check.type) {
      case 'event_fired':
      case 'duplicate_event':
        need(Boolean(check.event), `${check.type} requires "event"`);
        break;
      case 'param_validation':
        need(Boolean(check.event), 'param_validation requires "event"');
        need(Boolean(check.params && Object.keys(check.params).length > 0), 'param_validation requires a non-empty "params" map');
        break;
      case 'event_on_interaction':
        need(Boolean(check.event), 'event_on_interaction requires "event"');
        need(
          Boolean(check.action && (check.action.click || check.action.submit || check.action.navigate)),
          'event_on_interaction requires an "action" with click, submit, or navigate',
        );
        break;
      case 'tracker_present':
        need(Boolean(check.tracker), 'tracker_present requires "tracker"');
        break;
      case 'cross_domain_linker':
        need(Boolean(check.expectedDomains && check.expectedDomains.length > 0), 'cross_domain_linker requires a non-empty "expectedDomains"');
        break;
      case 'consent_mode':
        // No hard-required field; works off the consent flow + gcs/gcd + dataLayer.
        break;
    }
  });

const specSchema = z
  .object({
    url: z.string().url(),
    measurementIds: z.array(z.string()).optional(),
    expectedTrackers: z.array(z.string()).optional(),
    consent: z
      .object({
        acceptSelector: z.string().min(1).optional(),
        rejectSelector: z.string().min(1).optional(),
        mode: z.enum(['accept', 'reject']).optional(),
        checkPreConsent: z.boolean().optional(),
      })
      .strict()
      .optional(),
    settle: z
      .object({
        quietMs: z.number().int().positive().optional(),
        maxMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    checks: z.array(checkSchema).min(1, 'at least one check is required'),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    spec.checks.forEach((c, i) => {
      if (ids.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checks', i, 'id'], message: `duplicate check id "${c.id}"` });
      }
      ids.add(c.id);
    });
  });

/** Validate + normalize a spec. Throws SpecValidationError with clear paths. */
export function validateSpec(input: unknown): VerifySpec {
  const result = specSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    });
    throw new SpecValidationError(issues);
  }
  return result.data as VerifySpec;
}

/**
 * Recursively stable-stringify (sorted object keys) so the hash is
 * order-independent. Object keys whose value is `undefined` are omitted (as
 * JSON.stringify does), so a spec with an optional field set to `undefined`
 * hashes identically to one that omits the field — both validate to the same
 * VerifySpec, so their specHash must match.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 of the spec, canonicalised with stable key ordering. */
export function specHash(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}
