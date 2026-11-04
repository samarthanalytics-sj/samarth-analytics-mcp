/**
 * Shared GA4 error formatting and identifier normalization.
 *
 * `formatGa4Error` and `toPropertyName` were duplicated byte-for-byte in the
 * ga4Admin and ga4Data tool modules. They are extracted here unchanged so the
 * `"<tool> failed: <message>"` text and the scope hint stay identical to the
 * previous inline form.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatGoogleError } from './guardrails.js';
import { GA4_ADMIN_READONLY_SCOPE } from '../auth/googleAuth.js';
import { GA4_ACCOUNT_PATTERN, GA4_DATA_STREAM_PATTERN, GA4_PROPERTY_PATTERN } from './schemas.js';

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

/**
 * Refuse an identifier that is not exactly the shape it claims to be, before it is pasted into a
 * resource name. googleapis expands `{+name}` / `{+parent}` / `{+property}` as RESERVED strings,
 * so ':verb', '?', '#' and '..' in an id reach the URL raw and retarget the request (see
 * utils/schemas.ts). The schemas already refuse these; this is the same check where the name is
 * built, so a handler reached without schema validation cannot be steered either.
 */
export function requireGa4Identifier(value: unknown, pattern: RegExp, what: string, expected: string): string {
  const s = typeof value === 'string' ? value : String(value);
  if (!pattern.test(s)) {
    throw new McpError(ErrorCode.InvalidParams, `${what} ${JSON.stringify(s)} is not valid: expected ${expected}.`);
  }
  return s.trim();
}

/** Normalize a property identifier into the API's `properties/{id}` form. */
export function toPropertyName(property: string): string {
  const trimmed = requireGa4Identifier(property, GA4_PROPERTY_PATTERN, 'property', '"123456789" or "properties/123456789"');
  return trimmed.startsWith('properties/') ? trimmed : `properties/${trimmed}`;
}

/** Normalize an account identifier into the API's `accounts/{id}` form. */
export function toAccountName(account: string): string {
  const trimmed = requireGa4Identifier(account, GA4_ACCOUNT_PATTERN, 'accountId', '"123456" or "accounts/123456"');
  return trimmed.startsWith('accounts/') ? trimmed : `accounts/${trimmed}`;
}

/** Build a `properties/{id}/dataStreams/{streamId}` name. */
export function toDataStreamName(property: string, dataStreamId: string): string {
  const s = requireGa4Identifier(dataStreamId, GA4_DATA_STREAM_PATTERN, 'dataStreamId', '"987654" or "dataStreams/987654"');
  const suffix = s.startsWith('dataStreams/') ? s : `dataStreams/${s}`;
  return `${toPropertyName(property)}/${suffix}`;
}
