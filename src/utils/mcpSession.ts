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
