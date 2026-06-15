# Phase 3 — Multi-user OAuth broker (Stytch Connected Apps)

Implements per-user Google sign-in on the hosted MCP endpoint. Builds on the
Phase 1 identity seam (`src/auth/identityContext.ts`, `runWithAuth`) and the
ADR-0001 decision (Stytch Connected Apps as the Authorization Server, Google
brokered upstream). The token vault is **not** built — Stytch vaults the Google
refresh token and vends short-lived access tokens (proven by the spike).

## Architecture

```
MCP client (mcp-remote / Claude)
  1. GET/POST /mcp  with no token  → 401 + WWW-Authenticate: Bearer
     resource_metadata="https://mcp.samarthanalytics.com/.well-known/oauth-protected-resource"
  2. reads PRM → finds Stytch as the Authorization Server
  3. DCR + OAuth 2.1 + PKCE against Stytch  (Stytch brokers Google sign-in)
  4. Stytch issues a Connected App ACCESS TOKEN (JWT, signed by Stytch JWKS)
  5. client retries /mcp with  Authorization: Bearer <stytch_jwt>
     ▼
Our MCP server (Resource Server)
  6. validate the Stytch JWT  → claims give organization_id + member_id (sub)
  7. GoogleIdentityResolver(org, member) → Stytch get-google-access-token
     → OAuth2Client(access_token)        [SLICE 1 — DONE, tested]
  8. runWithAuth(googleClient, () => transport.handleRequest(...))   ← Phase 1 hook
```

## Slices

### Slice 1 — Google identity resolver  ✅ (this commit)
`src/auth/googleIdentityResolver.ts`. Given `(organizationId, memberId)`, calls
Stytch `GET /v1/b2b/organizations/{org}/members/{member}/oauth_providers/google`
(Basic auth: project_id:secret) and returns a per-member `OAuth2Client` carrying
the vended Google access token. Caches per member keyed `org:member`, reusing the
same `OAuth2Client` instance across refreshes so the downstream `gtmClient`/
`ga4Client` WeakMaps stay valid. Re-pulls from Stytch when the access token nears
expiry. **Never** requests `include_refresh_token` — that would disable Stytch's
auto-refresh. Endpoint + response shape verified live via `scripts/stytch-spike.mjs`.

### Slice 2 — Token validation + PRM + 401  (next)
- Add the `stytch` Node SDK; construct a client from `STYTCH_PROJECT_ID` +
  `STYTCH_SECRET`.
- `GET /.well-known/oauth-protected-resource` → JSON per RFC 9728 pointing at the
  Stytch authorization-server metadata URL.
- Replace the static bearer gate with: extract `Authorization: Bearer`, validate
  the Stytch Connected App JWT via `idp.introspectTokenLocal(token)` (offline,
  JWKS-cached). On missing/invalid → 401 with
  `WWW-Authenticate: Bearer resource_metadata="<PRM url>"`.
- TO CONFIRM against the live SDK before shipping: exact method name/return
  shape of `introspectTokenLocal`, and which claims carry `organization_id` and
  `member_id` (subject). Don't ship guessed claim paths.

### Slice 3 — Wire validation → resolver → hook
In `startHttpServer`, on each authenticated `/mcp` request:
`const { organizationId, memberId } = validatedClaims;`
`const googleClient = await resolver.resolve(organizationId, memberId);`
`await runWithAuth(googleClient, () => transport.handleRequest(...));`
Mode switch: when `STYTCH_PROJECT_ID` is set → multi-user mode (above); else →
today's single-identity behavior (default `auth` + static bearer gate). Keeps
stdio and single-token HTTP unchanged.

### Slice 4 — Retire shared token for public; docs
Once multi-user is verified end to end, stop using `GTM_MCP_HTTP_AUTH_TOKEN` for
the public endpoint (keep it for private/team deployments). Update README + the
client config (mcp-remote auto-discovers OAuth; no manual bearer needed).

## Env (new for multi-user mode)
- `STYTCH_PROJECT_ID` — enables multi-user mode when set.
- `STYTCH_SECRET` — Stytch secret (server-only).
- `STYTCH_API_BASE` — optional override; else derived from project id
  (`project-live-*` → api.stytch.com, else test.stytch.com).
- `STYTCH_AUTH_SERVER_METADATA_URL` — Stytch AS metadata URL for the PRM doc.

## Security notes
- Google refresh token never touches our server (Stytch holds it).
- Google access tokens cached in memory only, short-lived, per member.
- JWT validation is offline (JWKS) — no per-request call to Stytch for auth;
  the only Stytch call per request is get-google-access-token, itself cached.
- Parallel external dependency: Google sensitive-scope verification (no CASA).
