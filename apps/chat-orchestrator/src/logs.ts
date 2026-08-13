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

/**
 * What part of the system a line came from.
 *
 * One process serves the chat and the tag-suggestions page, so its log interleaves two unrelated
 * stories. Reading it to answer "why was that scan slow" means skipping past chat turns, and a text
 * box only helps someone who already knows which prefixes to type.
 *
 * Classified from the tag the line was written with, and for [req] lines from the PATH, because a
 * request is only identifiable by where it went.
 */
export type LogCategory = 'chat' | 'suggestions' | 'writes' | 'system';

const CHAT_TAGS = new Set(['tools', 'openai', 'snapshot', 'approval', 'memory', 'memories', 'usage', 'audit', 'resources']);
const SUGGESTION_TAGS = new Set(['scan', 'suggestions']);
const SYSTEM_TAGS = new Set(['orchestrator', 'deploy', 'pool', 'identity', 'logs', 'supervisor', 'auth']);
/**
 * A write belongs to whatever asked for it, and the line does not say which.
 *
 * Rather than guess, they get their own category. Filing them under chat would hide the ones a scan
 * made from someone looking for exactly those, and leaving them uncategorised would make the most
 * interesting lines in the file unreachable from every filter.
 */
const WRITE_TAGS = new Set(['write', 'tool']);

export function classifyLine(line: string): LogCategory | undefined {
  // Three shapes appear in this file: "[2026-01-01 00:00:00] [tag] ...", "[supervisor <iso>] ..."
  // (the supervisor stamps its own), and bare child output like "[samarth-gtm-mcp] ...".
  const tag = /\[(?:[\d-]+ [\d:]+\] \[)?([a-z][a-z-]*)[\s\]]/i.exec(line)?.[1]?.toLowerCase();

  if (!tag) {
    // Raw stderr from a crash: a stack frame or a node internal. It belongs with the lifecycle,
    // which is where someone looks after a restart they did not expect.
    // A crash is several lines: the message, the caret, the stack, then the error object's own
    // fields. Catching only the first would put half a crash in System and half nowhere, and the
    // half that names the cause (code: 'EADDRINUSE') is usually the useful half.
    if (
      /^\s+at\s|node:internal|node:events|throw er;/.test(line) ||
      /^\s*(?:[A-Z]\w*Error|Error):/.test(line) ||
      /^\s*(?:code|errno|syscall|address|port):/.test(line) ||
      /emitted 'error' event/i.test(line) ||
      /^\s*\^+\s*$/.test(line)
    ) {
      return 'system';
    }
    return undefined;
  }

  // The MCP children announce themselves by package name.
  if (tag.startsWith('samarth')) return 'system';

  if (tag === 'req') {
    // The path is the only thing that identifies a request.
    if (/\/v1\/suggestions/.test(line)) return 'suggestions';
    if (/\/v1\/(chat|conversations|conversation-groups|commands|approvals|memories|resources|audit)/.test(line)) {
      return 'chat';
    }
    // Everything else hitting this process, including the probes that find a public tunnel and ask
    // for /.aws/credentials. Those are worth being able to see, and they are not chat.
    return 'system';
  }

  if (SUGGESTION_TAGS.has(tag)) return 'suggestions';
  if (WRITE_TAGS.has(tag)) return 'writes';
  if (CHAT_TAGS.has(tag)) return 'chat';
  if (SYSTEM_TAGS.has(tag)) return 'system';
  return undefined;
}

/** Lines worth pulling out whatever they came from: something failed, was refused, or was throttled. */
export function isProblem(line: string): boolean {
  return /\berror\b|\bfailed\b|refused|rate limit|\b[45]\d\d\b(?!ms)|not creating|declined/i.test(line);
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
export function tailLog(
  opts: { lines?: number; filter?: string; category?: LogCategory; problemsOnly?: boolean } = {},
): LogTail | null {
  const file = logFile();
  if (!file) return null;

  const want = Math.min(Math.max(1, Math.trunc(opts.lines ?? DEFAULT_LINES)), MAX_LINES);
  const size = statSync(file).size;
  // ~200 bytes per line, with a floor and a ceiling; a filter needs a bigger haystack than the
  // number of lines it will return, so the window is deliberately generous.
  // A narrowed view needs a far bigger haystack than the number of lines it returns.
  const narrowing = Boolean(opts.filter || opts.category || opts.problemsOnly);
  const window = Math.min(size, Math.max(64 * 1024, want * (narrowing ? 1200 : 400)));

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

  // The filters compose, narrowest last, so "suggestions + problems + 429" answers one question.
  if (opts.category) {
    const wanted = opts.category;
    lines = lines.filter((l) => classifyLine(l) === wanted);
    matched = lines.length;
  }
  if (opts.problemsOnly) {
    lines = lines.filter(isProblem);
    matched = lines.length;
  }
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
