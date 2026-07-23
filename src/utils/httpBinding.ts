/**
 * Where the HTTP transport listens, and whether it is allowed to start at all.
 *
 * The hole this closes: with GTM_MCP_TRANSPORT=http and neither Stytch nor
 * GTM_MCP_HTTP_AUTH_TOKEN configured, the bearer check was skipped entirely
 * (it lived inside `if (staticToken)`), and `app.listen(port)` with no host
 * binds every interface. So the server handed its own Google credentials -
 * full GTM and GA4 access, writes included when those flags are on - to anyone
 * who could reach the port. The only guard was one console warning, and the
 * startup banner said "running on http://localhost:PORT", which reinforced
 * exactly the wrong belief about reachability.
 *
 * Everything else in this codebase is fail-closed (`=== 'true'` on every flag,
 * confirm on every write, deletes behind their own gate). This brings the HTTP
 * transport in line.
 *
 * PURE, so the matrix is unit-testable without binding a socket.
 */

export type AuthMode = 'stytch' | 'static-token' | 'none';

export interface HttpBinding {
  /** Interface to bind. */
  host: string;
  authMode: AuthMode;
  /** Set when the server must NOT start; the string is the operator-facing reason. */
  refuse?: string;
  /** Set when the configuration is allowed but worth saying out loud. */
  warning?: string;
}

/** Loopback covers IPv4; Node also accepts ::1 but 127.0.0.1 is the safer default to print. */
export const LOOPBACK = '127.0.0.1';
export const ALL_INTERFACES = '0.0.0.0';

const flag = (v: string | undefined): boolean => v === 'true';

/**
 * Decide the bind host and whether to start.
 *
 * The rules, in the order they matter:
 *
 *  1. AUTHENTICATED servers are unchanged. Stytch or a static token means the
 *     hosted multi-user deployment, which legitimately listens on every
 *     interface - so the default stays ALL_INTERFACES and existing deployments
 *     keep working. Making them loopback-only would have broken every hosted
 *     install to fix a hole that only exists without auth.
 *
 *  2. UNAUTHENTICATED servers refuse to start. Not a warning: a warning on
 *     stderr competes with retry logs and gets missed, and the failure mode is
 *     handing an operator's advertising and analytics accounts to the network.
 *     GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED=true is the deliberate opt-in, matching
 *     the `=== 'true'` idiom used by every other gate here.
 *
 *  3. An unauthenticated server that IS allowed binds LOOPBACK by default, so
 *     the opt-in covers local development without also publishing the port.
 *     Reaching the network from there takes a second explicit step.
 */
export function resolveHttpBinding(env: NodeJS.ProcessEnv = process.env): HttpBinding {
  const stytch = (env['STYTCH_PROJECT_ID'] ?? '').trim().length > 0;
  const staticToken = (env['GTM_MCP_HTTP_AUTH_TOKEN'] ?? '').trim().length > 0;
  const authMode: AuthMode = stytch ? 'stytch' : staticToken ? 'static-token' : 'none';
  const explicitHost = (env['GTM_MCP_HTTP_HOST'] ?? '').trim();
  const allowOpen = flag(env['GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED']);

  if (authMode === 'none' && !allowOpen) {
    return {
      host: LOOPBACK,
      authMode,
      refuse:
        'HTTP transport refused to start: no authentication is configured, so /mcp would serve this ' +
        "server's Google credentials (GTM + GA4, including writes when those flags are on) to anyone " +
        'who can reach the port. Set GTM_MCP_HTTP_AUTH_TOKEN for a shared-secret server, or ' +
        'STYTCH_PROJECT_ID for per-user OAuth. For local development only, set ' +
        'GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED=true (it then binds ' +
        LOOPBACK +
        ' unless GTM_MCP_HTTP_HOST says otherwise).',
    };
  }

  // Authenticated: unchanged default so hosted deployments keep working.
  const defaultHost = authMode === 'none' ? LOOPBACK : ALL_INTERFACES;
  const host = explicitHost || defaultHost;

  // The genuinely dangerous combination, reachable only by opting in twice.
  if (authMode === 'none' && host !== LOOPBACK && host !== '::1' && host !== 'localhost') {
    return {
      host,
      authMode,
      warning:
        `SERVING UNAUTHENTICATED ON ${host}. Any host that can reach this port has full GTM and GA4 ` +
        "access as this server's Google account. This is only safe behind a proxy that authenticates " +
        'for you.',
    };
  }

  return { host, authMode };
}

/** What to print at startup: the host actually bound, never a hardcoded "localhost". */
export function bindingBanner(b: HttpBinding, port: number): string {
  const shown = b.host === ALL_INTERFACES ? `all interfaces (${ALL_INTERFACES})` : b.host;
  const auth =
    b.authMode === 'stytch'
      ? 'per-user OAuth (Stytch)'
      : b.authMode === 'static-token'
        ? 'shared bearer token'
        : 'NONE';
  return `listening on ${shown}:${port} - authentication: ${auth}`;
}
