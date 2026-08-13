/**
 * Reading the orchestrator's own log, for an operator looking at it from the website.
 *
 * This log is CROSS-TENANT. It holds every user's request paths, truncated user ids, tool names,
 * container and property ids, and write payloads. Nobody reaches it because they are signed in; they
 * reach it because this process was configured to let them, which is why the allowlist lives in the
 * orchestrator's own environment and not in a table. A compromised admin row in the database must
 * not be able to open a window onto other customers' activity.
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
 * Who may read it, from the orchestrator's environment.
 *
 * Matched against both the user id and the email, because whoever configures this knows one or the
 * other and should not have to look up a UUID. Empty means nobody: the endpoint is off unless it has
 * been deliberately turned on, so a fresh deployment does not quietly expose its log.
 */
export function logAdmins(): Set<string> {
  const raw = process.env.ORCHESTRATOR_LOG_ADMINS ?? '';
  return new Set(
    raw
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isLogAdmin(user: { id?: string; email?: string }): boolean {
  const admins = logAdmins();
  if (admins.size === 0) return false;
  return admins.has(String(user.id ?? '').toLowerCase()) || admins.has(String(user.email ?? '').toLowerCase());
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
