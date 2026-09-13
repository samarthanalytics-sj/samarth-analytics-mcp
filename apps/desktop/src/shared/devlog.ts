// Dev-only logging bridge: the pure, framework-free half - types + secret redaction + formatting.
//
// The desktop app does almost all of its work in the MAIN process (logs + Google API HTTP), which the
// renderer's DevTools cannot see. The dev-logger (main) captures that activity and ships it to the
// renderer, which re-prints it in the DevTools Console. EVERYTHING that crosses that bridge passes
// through redact() first, so an OAuth token, API key, developer token or Authorization header can
// never reach a console line, a screenshot, or a copied log. This module is pure so the redaction
// rules are unit-tested without Electron.

export type DevLogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

/** One line of activity crossing main -> renderer. `parts` are already redacted and structured-clone
 *  safe (only strings / numbers / booleans / null / plain objects / arrays). */
export interface DevLogEntry {
  /** Epoch ms, stamped in the main process. */
  ts: number;
  /** Origin tag shown as a prefix: 'main' (a console.* call), 'ipc', or 'http'. */
  scope: string;
  level: DevLogLevel;
  parts: unknown[];
}

// Caps: a debug log must never blow up the IPC channel or the console with a megabyte of data.
export const MAX_STRING = 2000;
export const MAX_ARRAY = 100;
export const MAX_DEPTH = 5;
export const MAX_KEYS = 80;

const REDACTED = '[redacted]';

/** Object KEYS whose VALUE is a secret, matched case-insensitively as a whole segment (so "author"
 *  is not mistaken for "auth", but "access_token", "apiKey", "developerToken" are caught). */
const SECRET_KEYS = [
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken', 'id_token', 'idtoken',
  'secret', 'client_secret', 'clientsecret', 'api_key', 'apikey', 'developer_token', 'developertoken',
  'password', 'passwd', 'authorization', 'auth_token', 'authtoken', 'bearer', 'credential', 'credentials',
  'private_key', 'privatekey', 'cookie', 'set-cookie', 'session_token', 'sessiontoken', 'x-goog-api-key',
];

/** True when an object key names a secret. Normalises separators so camelCase / snake_case / kebab all
 *  collapse to the same comparable token. */
export function isSecretKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[\s_-]+/g, '');
  return SECRET_KEYS.some((s) => norm === s.replace(/[\s_-]+/g, ''));
}

/** Scrub secret-shaped substrings out of free text (log messages, URLs, error strings). Conservative:
 *  only patterns that are unambiguously credentials, so ordinary ids/paths are left readable. */
export function redactString(input: string): string {
  let s = input;
  s = s.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]');
  s = s.replace(/\bya29\.[0-9A-Za-z\-_.]+/g, '[redacted-oauth-token]'); // Google OAuth access tokens
  s = s.replace(/\b1\/\/[0-9A-Za-z\-_]+/g, '[redacted-refresh-token]'); // Google refresh tokens
  s = s.replace(/\bAIza[0-9A-Za-z\-_]{20,}/g, '[redacted-api-key]'); // Google API keys
  s = s.replace(/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, '[redacted-jwt]'); // JWTs
  // access_token=... / api_key=... / key=... inside a URL query or form body.
  s = s.replace(/\b(access_token|refresh_token|id_token|api_?key|key|token|client_secret)=[^&\s"']+/gi, '$1=[redacted]');
  return s;
}

const truncate = (s: string): string => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (+${s.length - MAX_STRING} chars)` : s);

/**
 * Deep-clone `value` into a structured-clone-safe, secret-free, size-capped shape suitable for the
 * DevLog IPC channel. Functions, Buffers and class instances become short descriptors; cycles are
 * broken; depth/array/string are capped. NEVER throws - a logger that throws while logging is worse
 * than a lossy log line.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return truncate(redactString(value as string));
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
  if (t === 'symbol') return (value as symbol).toString();
  if (value instanceof Error) {
    return { name: value.name, message: truncate(redactString(value.message)), stack: value.stack ? truncate(redactString(value.stack)) : undefined };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[Buffer ${(value as Buffer).length} bytes]`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[Binary ${(value as { byteLength?: number }).byteLength ?? 0} bytes]`;
  if (t === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[Array depth capped]' : '[Object depth capped]';
    seen.add(value as object);
    try {
      if (Array.isArray(value)) {
        const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
        if (value.length > MAX_ARRAY) out.push(`… (+${value.length - MAX_ARRAY} more)`);
        return out;
      }
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = Object.keys(rec);
      for (const k of keys.slice(0, MAX_KEYS)) {
        if (isSecretKey(k)) { out[k] = REDACTED; continue; }
        // A property may be a getter that throws; a logger must survive that.
        let v: unknown;
        try { v = rec[k]; } catch { out[k] = '[unreadable]'; continue; }
        out[k] = redact(v, depth + 1, seen);
      }
      if (keys.length > MAX_KEYS) out['…'] = `(+${keys.length - MAX_KEYS} more keys)`;
      return out;
    } finally {
      seen.delete(value as object);
    }
  }
  return String(value);
}

/** Redact a whole argument list (what a console.* / IPC call was given). */
export function redactAll(parts: unknown[]): unknown[] {
  return parts.map((p) => redact(p));
}

/** A URL with its query string stripped of secret params, for the http scope. Keeps the path/host so
 *  the call is identifiable; drops the query entirely when it cannot be parsed. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const kept: string[] = [];
    u.searchParams.forEach((v, k) => kept.push(`${k}=${isSecretKey(k) ? REDACTED : v}`));
    u.search = kept.length ? `?${kept.join('&')}` : '';
    return u.toString();
  } catch {
    return redactString(raw.split('?')[0] ?? raw);
  }
}
