/**
 * Secret redaction for anything that reaches a log.
 *
 * The orchestrator logs upstream error text so production failures are diagnosable. That text comes
 * from Google, OpenAI, and Supabase, and none of them promise never to echo a credential back in a
 * message. Logs outlive the request, get shipped to aggregators, and get pasted into issues, so the
 * safe assumption is that anything logged is eventually read by someone who should not see a token.
 *
 * Patterns are deliberately narrow: each matches a credential shape with a distinctive prefix, so
 * ordinary error prose passes through untouched and stays useful.
 */

import { createHash } from 'node:crypto';

const PATTERNS: { re: RegExp; label: string }[] = [
  // Google OAuth access tokens.
  { re: /ya29\.[A-Za-z0-9._-]+/g, label: '[redacted:google-access-token]' },
  // Google OAuth refresh tokens.
  { re: /\b1\/\/[A-Za-z0-9._-]{10,}/g, label: '[redacted:google-refresh-token]' },
  // Google API keys.
  { re: /\bAIza[A-Za-z0-9._-]{10,}/g, label: '[redacted:google-api-key]' },
  // OpenAI keys, including the sk-proj- form.
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: '[redacted:openai-key]' },
  // Any JWT, which covers Supabase access tokens and the anon key.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, label: '[redacted:jwt]' },
  // A bearer credential quoted inside an upstream error message.
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, label: 'Bearer [redacted]' },
  // Cloudflare tunnel credentials and similar long hex secrets are not matched on purpose: too
  // close to ordinary ids, and redacting an id makes an error unreadable for no security gain.
];

/** Replaces credential-shaped substrings. Safe to call on any string, including an empty one. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, label } of PATTERNS) out = out.replace(re, label);
  return out;
}

/**
 * Prepares upstream text for a single log line: redacted, whitespace-collapsed, length-bounded.
 *
 * Bounded because a truncated tool result can be tens of kilobytes, and one such line can bury the
 * rest of a log or blow a per-line limit in a log shipper.
 */
export function forLog(text: string, maxChars = 400): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}...` : flat;
}

/**
 * Shortens a user id for correlation without writing the whole identifier.
 *
 * Enough to follow one user through a log, not enough to be a useful identifier on its own.
 */
export function userRef(userId: string): string {
  return userId.length <= 8 ? userId : userId.slice(0, 8);
}

/**
 * A stable, non-obvious handle for a person, from their email.
 *
 * The log is read by an operator asking "who did this", and a truncated UUID answers that only if
 * they already have the UUID. A hash of the email is stable across sessions and derivable from an
 * address they DO have, so a support question ("what happened for jane@acme.com") becomes a filter.
 *
 * NOT a secret. Email addresses come from a small space and this is a plain digest, so anyone
 * holding a list of addresses can match them. It keeps addresses out of a file that gets copied and
 * pasted; it does not make the reader anonymous, and nothing should be built as though it does.
 *
 * The domain is kept in the clear on purpose: it identifies the tenant, which is what an operator
 * usually needs, and it is not personal on its own.
 */
export function userTag(user: { id?: string; email?: string }): string {
  const email = String(user.email ?? '').trim().toLowerCase();
  if (!email) return `u:${userRef(String(user.id ?? 'anonymous'))}`;
  const [, domain = ''] = email.split('@');
  const digest = createHash('sha256').update(email).digest('hex').slice(0, 10);
  return domain ? `${digest}@${domain}` : digest;
}
