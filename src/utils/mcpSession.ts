/**
 * Routing decision for a POST /mcp request, kept pure so it can be tested without a live server.
 *
 * The hole this closes: the HTTP transport created a new transport for ANY request that did not carry
 * a known session id, and connected the ONE shared McpServer to it. Two problems followed.
 *
 *   1. An McpServer refuses a second `connect()` ("Already connected to a transport"), so the second
 *      client to arrive threw inside an async Express handler. With no rejection net that took the
 *      process down, and the first client's session with it.
 *   2. A client that cached a session id across a server restart sent a non-initialize request with a
 *      stale id. That minted an orphan transport which never entered the session map (the SDK only
 *      calls `onsessioninitialized` for an actual initialize), so it leaked and could never be reached
 *      again.
 *
 * Only an `initialize` may open a session. Anything else with an unknown id is told to start over.
 */

export type PostRoute =
  /** Known session id: hand the request to that session's existing transport. */
  | { kind: 'resume'; sessionId: string }
  /** An initialize with no (or an unknown) session id: mint a session, with its own server. */
  | { kind: 'create' }
  /** Not an initialize, and the session id is missing or unknown: 404, do not mint anything. */
  | { kind: 'unknown-session' };

/**
 * Does this JSON-RPC body contain an `initialize` call? Batches count if any member is one, which
 * matches how the SDK's transport treats a batch containing an initialize.
 */
export function isInitializeRequest(body: unknown): boolean {
  const one = (b: unknown): boolean =>
    typeof b === 'object' && b !== null && (b as { method?: unknown }).method === 'initialize';
  return Array.isArray(body) ? body.some(one) : one(body);
}

export function decidePostRoute(
  sessionId: string | undefined,
  hasSession: boolean,
  body: unknown
): PostRoute {
  if (sessionId && hasSession) return { kind: 'resume', sessionId };
  if (isInitializeRequest(body)) return { kind: 'create' };
  return { kind: 'unknown-session' };
}

/** Message returned with the 404 for {@link PostRoute} `unknown-session`. */
export const UNKNOWN_SESSION_MESSAGE =
  'Unknown or expired mcp-session-id. Start a new session with an initialize request.';

/** Message returned with the 400 when a GET/DELETE carries no mcp-session-id header at all. */
export const MISSING_SESSION_MESSAGE = 'Bad Request: the mcp-session-id header is required.';

export type SessionAccess =
  /** No mcp-session-id header: a malformed request, 400. */
  | { kind: 'missing-header' }
  /** A session id that names no live session: 404 + -32001, so the client re-initializes. */
  | { kind: 'unknown-session' }
  | { kind: 'ok'; sessionId: string };

/**
 * GET (event stream) and DELETE /mcp only ever address an EXISTING session. GET used to answer 400 for
 * an unknown id while POST answered 404, and DELETE answered a non-JSON-RPC 404 even when the header
 * was missing. The spec has a client re-initialize on 404, so an unknown id is 404 + -32001 on every
 * method, and only a missing header is a 400.
 */
export function decideSessionAccess(sessionId: string | undefined, hasSession: boolean): SessionAccess {
  if (!sessionId) return { kind: 'missing-header' };
  if (!hasSession) return { kind: 'unknown-session' };
  return { kind: 'ok', sessionId };
}

/**
 * May this request's principal use the stored session? Sessions were keyed by mcp-session-id alone,
 * so in multi-user mode any other authenticated member who learned an id (they are logged) could
 * resume it, take over its event stream, or DELETE it. A session now records the principal that
 * initialized it, and a request from anyone else is treated exactly like an unknown id - pass the
 * result as `hasSession` to decidePostRoute / decideSessionAccess - so a 404 never confirms that
 * someone else's session exists.
 */
export function sessionOwnedBy(owner: string | undefined, principal: string): boolean {
  return owner !== undefined && owner === principal;
}

/** Default cap on live HTTP sessions, process-wide. Every session holds its own McpServer (~2 MB with
 *  every tool registered) for up to the idle TTL, so this keeps a 512 MB instance clear of OOM. */
export const DEFAULT_MAX_SESSIONS = 100;
/** Default per-principal cap in multi-user mode: room for one user's several clients plus reconnects. */
export const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 10;

export interface SessionLimits {
  maxTotal: number;
  maxPerPrincipal: number;
}

/**
 * Session caps from GTM_MCP_HTTP_MAX_SESSIONS / GTM_MCP_HTTP_MAX_SESSIONS_PER_PRINCIPAL (positive
 * integers; anything else falls back to the default). Single-identity modes have ONE principal (every
 * holder of the static token), where a separate per-principal cap would only be a smaller global cap,
 * so there it defaults to the global one. It never exceeds the global cap.
 */
export function resolveSessionLimits(env: NodeJS.ProcessEnv, multiUser: boolean): SessionLimits {
  const positive = (name: string): number | undefined => {
    const raw = (env[name] ?? '').trim();
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : undefined;
  };
  const maxTotal = positive('GTM_MCP_HTTP_MAX_SESSIONS') ?? DEFAULT_MAX_SESSIONS;
  const perPrincipal =
    positive('GTM_MCP_HTTP_MAX_SESSIONS_PER_PRINCIPAL') ??
    (multiUser ? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL : maxTotal);
  return { maxTotal, maxPerPrincipal: Math.min(perPrincipal, maxTotal) };
}

export type SessionAdmission =
  | { kind: 'admit' }
  /** Close this (the principal's own least-recently-active idle) session, then admit. */
  | { kind: 'evict'; sessionId: string }
  | { kind: 'reject'; scope: 'principal' | 'global' };

/**
 * May `principal` open another session? Nothing used to bound how many sessions existed: the idle
 * sweep only limits how long one lives, so any authenticated caller looping initialize could mint
 * thousands of ~2 MB servers inside one TTL and take the process (and every user's sessions) down.
 *
 * At the per-principal cap the principal's own least-recently-active session with nothing in flight
 * is replaced (a client that crashed or reconnected left it behind); if all of them are busy the
 * request is refused. At the global cap the request is refused: one caller never evicts another's
 * session. `pending` counts initializes already admitted but not yet in the map, so a concurrent
 * burst cannot overshoot either cap.
 */
export function decideSessionAdmission(
  sessions: Iterable<[string, { principal: string; lastActivity: number; inFlight: number }]>,
  principal: string,
  limits: SessionLimits,
  pending: { total: number; forPrincipal: number } = { total: 0, forPrincipal: 0 }
): SessionAdmission {
  let total = pending.total;
  let own = pending.forPrincipal;
  let oldestIdle: { sessionId: string; lastActivity: number } | undefined;
  for (const [sessionId, s] of sessions) {
    total += 1;
    if (s.principal !== principal) continue;
    own += 1;
    if (s.inFlight === 0 && (!oldestIdle || s.lastActivity < oldestIdle.lastActivity)) {
      oldestIdle = { sessionId, lastActivity: s.lastActivity };
    }
  }
  if (own >= limits.maxPerPrincipal) {
    // Replacing one of the principal's own sessions leaves the total unchanged.
    return oldestIdle ? { kind: 'evict', sessionId: oldestIdle.sessionId } : { kind: 'reject', scope: 'principal' };
  }
  if (total >= limits.maxTotal) return { kind: 'reject', scope: 'global' };
  return { kind: 'admit' };
}

/** Status + JSON-RPC error body for an initialize refused by {@link decideSessionAdmission}. */
export function sessionLimitResponse(
  scope: 'principal' | 'global',
  limits: SessionLimits
): { status: number; body: { jsonrpc: '2.0'; error: { code: number; message: string }; id: null } } {
  const message =
    scope === 'principal'
      ? `Too many open MCP sessions for this caller (limit ${limits.maxPerPrincipal}) and none is idle ` +
        'to replace. Close a session (DELETE /mcp) or retry later.'
      : `This server is at its MCP session limit (${limits.maxTotal}). Retry later.`;
  return {
    status: scope === 'principal' ? 429 : 503,
    body: { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
  };
}

/** A session id shortened for logs: enough to correlate lines, not enough to address the session. */
export function redactSessionId(sid: string): string {
  return sid.length >= 16 ? `${sid.slice(0, 8)}...` : '[redacted]';
}

/** Status + JSON-RPC error body for a missing (400) or unknown/expired (404) session id. */
export function sessionErrorResponse(kind: 'missing-header' | 'unknown-session'): {
  status: number;
  body: { jsonrpc: '2.0'; error: { code: number; message: string }; id: null };
} {
  return kind === 'missing-header'
    ? { status: 400, body: { jsonrpc: '2.0', error: { code: -32000, message: MISSING_SESSION_MESSAGE }, id: null } }
    : { status: 404, body: { jsonrpc: '2.0', error: { code: -32001, message: UNKNOWN_SESSION_MESSAGE }, id: null } };
}
