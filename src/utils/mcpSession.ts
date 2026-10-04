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

/** Status + JSON-RPC error body for a missing (400) or unknown/expired (404) session id. */
export function sessionErrorResponse(kind: 'missing-header' | 'unknown-session'): {
  status: number;
  body: { jsonrpc: '2.0'; error: { code: number; message: string }; id: null };
} {
  return kind === 'missing-header'
    ? { status: 400, body: { jsonrpc: '2.0', error: { code: -32000, message: MISSING_SESSION_MESSAGE }, id: null } }
    : { status: 404, body: { jsonrpc: '2.0', error: { code: -32001, message: UNKNOWN_SESSION_MESSAGE }, id: null } };
}
