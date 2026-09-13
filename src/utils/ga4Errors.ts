/**
 * Shared GA4 error formatting and identifier normalization.
 *
 * `formatGa4Error` and `toPropertyName` were duplicated byte-for-byte in the
 * ga4Admin and ga4Data tool modules. They are extracted here unchanged so the
 * `"<tool> failed: <message>"` text and the scope hint stay identical to the
 * previous inline form.
 */

import { formatGoogleError } from './guardrails.js';
import { GA4_ADMIN_READONLY_SCOPE } from '../auth/googleAuth.js';

/**
 * Format a GA4 Admin error. When the failure is a missing-scope / permission
 * problem, append a hint pointing at the read-only analytics scope so users
 * know to re-consent rather than chasing a GA4 permissions red herring.
 */
export function formatGa4Error(toolName: string, err: unknown): string {
  const base = formatGoogleError(err);
  const lower = base.toLowerCase();
  const looksLikeScopeIssue =
    lower.includes('insufficient') ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied') ||
    lower.includes('403') ||
    lower.includes('scope') ||
    lower.includes('access_token_scope_insufficient');
  const hint = looksLikeScopeIssue
    ? `\nHint: this often means the GA4 read scope is missing. Re-run "npm run auth:google" ` +
      `to grant ${GA4_ADMIN_READONLY_SCOPE}, or confirm the account has GA4 access.`
    : '';
  return `${toolName} failed: ${base}${hint}`;
}

/** Normalize a property identifier into the API's `properties/{id}` form. */
export function toPropertyName(property: string): string {
  const trimmed = property.trim();
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}
