/**
 * Reading the orchestrator's own log, for an operator looking at it from the website.
 *
 * This log is CROSS-TENANT. It holds every user's request paths, truncated user ids, tool names,
 * container and property ids, and write payloads. Reading it requires the product's SUPER ADMIN
 * role, checked against the database on every request; an ordinary admin cannot open it.
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where supervise.mjs writes. Kept in step with it by construction: both build it from the package root. */
function logFile(from?: string): string | null {
  let dir = from ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'apps/chat-orchestrator/logs/orchestrator.log');
    if (existsSync(candidate)) return candidate;
    const sibling = path.join(dir, 'logs/orchestrator.log');
    if (existsSync(sibling)) return sibling;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Most lines anyone gets in one request, however many they ask for. */
export const MAX_LINES = 2000;
export const DEFAULT_LINES = 300;

/**
 * Who may read it: a super admin of the product, asked of the database at request time.
 *
 * This was an allowlist in this process's environment, which nothing in the database could grant.
 * The owner chose the role instead, so the boundary now sits where product roles are managed rather
 * than where the process is deployed. That is a real trade and worth naming: anyone who can write a
 * super_admin row into user_roles can read every tenant's activity in this log.
 *
 * Two things keep it as tight as that choice allows.
 *
 * It asks the database's own is_super_admin() rather than reading the table and deciding here, so
 * there is ONE definition of super admin and a change to it takes effect everywhere at once.
 *
 * It asks on EVERY request, with no cache. Revoking the role takes effect on the next line someone
 * loads, not a minute later, and the query is trivial next to the log read it guards.
 */
export interface SupabaseAccess {
  url?: string;
  serviceRoleKey?: string;
}

export async function isSuperAdmin(
  userId: string,
  supabase: SupabaseAccess,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = supabase.url?.trim();
  const key = supabase.serviceRoleKey?.trim();
  // No credentials, no answer, and the answer defaults to no. A deployment that cannot ask must not
  // assume yes, and saying so in the log is how an operator finds out why their tab is empty.
  if (!url || !key || !userId) {
    console.warn('[logs] cannot check super admin: Supabase url or service role key is not configured');
    return false;
  }

  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/rpc/is_super_admin`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _user_id: userId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[logs] super admin check failed: ${res.status}`);
      return false;
    }
    // The function returns a bare boolean. Anything else is treated as a no rather than guessed at.
    return (await res.json()) === true;
  } catch (err) {
    // Fails CLOSED. An unreachable database means nobody reads the log, which is the safe direction
    // for a cross-tenant one: the alternative is that a network problem opens it.
    console.warn(`[logs] super admin check errored: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Anything that looks like a credential, removed on the way out.
 *
 * The log is already written through forLog(), so this is a second net rather than the first one. It
 * exists because the cost of the two disagreeing is a token in a browser tab: a bearer token, a
 * Google access token, or a long JWT that reached the log through a path nobody remembered.
 */
export function redactSecrets(line: string): string {
  return line
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[redacted]')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[jwt redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[google token redacted]')
    .replace(/\b(sk|rk)-[A-Za-z0-9]{20,}/g, '[api key redacted]')
    // The (?!\[) matters: without it this rule re-redacts what the rules above already replaced, and
    // "GOOGLE_ACCESS_TOKEN=[google token redacted]" comes out as
    // "GOOGLE_ACCESS_TOKEN=[redacted] token redacted]", which reads like a bug in the log itself.
    .replace(
      /("?(?:access_token|refresh_token|client_secret|api_key|password)"?\s*[:=]\s*"?)(?!\[)[^",\s]+/gi,
      '$1[redacted]',
    );
}

export interface LogTail {
  lines: string[];
  /** Bytes in the file, so a reader can see it is rotating rather than stalled. */
  bytes: number;
  /** True when the requested count was reached, i.e. there is more above. */
  truncated: boolean;
  /** How many lines matched before the count was applied, when filtering. */
  matched?: number;
}

/**
 * The tail of the log, newest last.
 *
 * Only the last chunk of the file is read, not the whole thing: it rotates at 5MB, and reading 5MB to
 * show 300 lines would make the endpoint a way to make this process do pointless work. The chunk is
 * sized from the line count so a filter still has plenty to search.
 */
export function tailLog(opts: { lines?: number; filter?: string } = {}): LogTail | null {
  const file = logFile();
  if (!file) return null;

  const want = Math.min(Math.max(1, Math.trunc(opts.lines ?? DEFAULT_LINES)), MAX_LINES);
  const size = statSync(file).size;
  // ~200 bytes per line, with a floor and a ceiling; a filter needs a bigger haystack than the
  // number of lines it will return, so the window is deliberately generous.
  const window = Math.min(size, Math.max(64 * 1024, want * (opts.filter ? 1200 : 400)));

  let text: string;
  if (window >= size) {
    text = readFileSync(file, 'utf8');
  } else {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      text = buf.toString('utf8');
      // The first line is almost certainly cut in half by the offset.
      const firstBreak = text.indexOf('\n');
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    } finally {
      closeSync(fd);
    }
  }

  let lines = text.split('\n').filter((l) => l.length > 0);
  let matched: number | undefined;
  const needle = opts.filter?.trim().toLowerCase();
  if (needle) {
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
    matched = lines.length;
  }

  const truncated = lines.length > want;
  return {
    lines: lines.slice(-want).map(redactSecrets),
    bytes: size,
    truncated,
    ...(matched !== undefined ? { matched } : {}),
  };
}
