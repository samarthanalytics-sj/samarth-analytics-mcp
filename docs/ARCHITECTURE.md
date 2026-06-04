# Architecture

Developer-facing map of the Samarth Analytics MCP repository: what the pieces
are, how data flows through them, where the structural risks live, and a
prioritized refactor strategy. This document is descriptive — it records the
system as it is, not a change proposal. Guardrails and behavior described here
are load-bearing; see `CLAUDE.md` for the rules that must not be violated.

## 1. Components at a glance

| Area | Path | Runtime | Role |
| --- | --- | --- | --- |
| MCP server | `src/` | Node (stdio or HTTP) | Google Tag Manager API v2 tools + read-only GA4 (Admin + Data) tools, behind write/publish/delete guardrails. |
| Portal client | `apps/portal/client/` | Browser (Vite/React) | White-label customer UI for running GTM / Consent Mode v2 / sGTM audits. |
| Portal API (serverless) | `apps/portal/api/` | Vercel functions | Per-request HTTP handlers: OAuth, session, GTM/GA4 proxy, audit execution. |
| Portal dev server | `apps/portal/server/` | Node/Express (local) | Local mirror of the serverless routes; uses shared helpers the serverless routes deliberately inline. |
| Shared audit engines | `apps/portal/shared/` | Framework-free | Pure Consent Mode v2 engine + types, with a 170-case test suite. |
| Runtime worker | `apps/runtime-worker/` | Node + headless Chromium | Read-only page-capture service feeding runtime evidence into audits. Cannot run on Vercel. |

## 2. MCP server

### 2.1 Entry and transports (`src/index.ts`)

`main()` builds a Google auth client, constructs the MCP server, then connects a
transport selected by `GTM_MCP_TRANSPORT`:

- **stdio** (default) — for Claude Desktop / Cursor / Claude Code. Logs go to
  stderr because stdout is the JSON-RPC channel.
- **http** — an Express app exposing `POST/GET/DELETE /mcp` (stateful sessions
  keyed by `mcp-session-id`), an OAuth callback, and `/health`.

Heavy transport modules (`StreamableHTTPServerTransport`, `express`) are
imported lazily inside the HTTP branch so stdio startups stay lean.

### 2.2 Auth (`src/auth/googleAuth.ts`)

Three-tier credential resolution: service-account key file → OAuth2 with tokens
(env vars or `.gtm-mcp-tokens.json`, with auto-refresh persistence) →
Application Default Credentials. OAuth client credentials are resolved from a
prioritized env-var chain. Token-file writes use mode `0600`. The GA4 read scope
(`analytics.readonly`) is part of the requested scope set so the same
credentials authorize GTM and GA4 reads.

### 2.3 Clients (`src/utils/gtmClient.ts`, `src/utils/ga4Client.ts`)

Thin singleton factories over `googleapis` (`tagmanager_v2`,
`analyticsadmin_v1beta`, `analyticsadmin_v1alpha`, `analyticsdata_v1beta`). Each
caches one client instance; `reset*` helpers exist for tests. GA4 clients are
used for list/get and reporting only — never writes.

### 2.4 Tool registration (`src/tools/index.ts`)

`registerAllTools(server, getClient, getGa4Client, getGa4AlphaClient, getGa4DataClient)`
fans out to one `register<Area>Tools` function per resource file. Each register
function takes the server plus the client getters it needs (1 for GTM, 2 for GA4
Admin). Tools are declared with `server.registerTool(name, { description,
inputSchema }, handler)` using Zod input schemas.

### 2.5 Guardrails (`src/utils/guardrails.ts`)

`getGuardrailConfig()` reads `GTM_MCP_ENABLE_WRITES/PUBLISH/DELETES` and
`DRY_RUN` (all default off). `checkGuardrails(opType, confirm, config)` enforces
that **every** write/delete/publish passes `confirm: true` and that the matching
capability flag is enabled, throwing `McpError` otherwise; it returns
`{ dryRun }` so handlers can short-circuit in dry-run mode. `formatGoogleError`
unwraps `googleapis` error bodies into readable strings. `validateId` /
`buildPath` shape and validate GTM resource paths.

### 2.6 Pagination (`src/utils/pagination.ts`)

`paginate(fetchPage, extract, options)` transparently follows `nextPageToken`
across pages (default ceiling `DEFAULT_MAX_PAGES = 50`), returning
`{ items, pagesFetched, nextPageToken?, truncated }`. `buildListResult(key,
result)` shapes the standard `{ [key]: items, count }` body and only adds
`truncated`/`nextPageToken` when actually truncated. `paginationFields` is a
reusable Zod fragment merged into list-tool schemas.

### 2.7 Tool response envelope (`src/utils/toolResponse.ts`)

All tool handlers return the MCP text envelope. These helpers centralize it:

- `jsonResult(data)` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`
- `textResult(text)` → plain-text success (dry-run notices, delete confirmations)
- `errorResult(toolName, err)` → `{ isError: true, content: [{ type:'text', text: `${toolName} failed: ${formatGoogleError(err)}` }] }`
- `errorText(text)` → an `isError` envelope around an already-formatted string
  (used by GA4 tools, whose `formatGa4Error` adds a re-consent hint).

The `ToolResult` interface carries an index signature so it stays assignable to
the MCP SDK's open `CallToolResult` type.

### 2.8 Tool data flow (read example)

```
client → MCP tool (e.g. tags_list)
       → getClient() (cached googleapis client)
       → paginate(fetchPage, extract)  ← follows nextPageToken
       → buildListResult('tags', result)
       → jsonResult(...)  → MCP text envelope → client
```

Write/publish/delete tools insert `checkGuardrails(...)` before any API call and
return `textResult('[DRY RUN] ...')` when `DRY_RUN=true`. `audit_container` and
`export_container` fan out across resource collections with `Promise.all` rather
than serial calls.

## 3. Portal

### 3.1 Client (`apps/portal/client/`)

React + Vite. TanStack Query is the data layer (`queryClient.ts`: `retry:
false`, no refetch-on-focus, infinite staleTime). `lib/portal-api.ts` wraps
`fetch` with `credentials: 'include'`, a single-read error parser that maps known
codes (`401`, `ga4_scope_missing`, `forbidden`, `oauth_not_configured`) to
friendly messages, and `getJson`/`postJson` helpers. `lib/portal-store.tsx` is a
Context store for OAuth state, approvals, and the active plan. Errors surface via
toasts, inline error cards, and a render-time `error-boundary.tsx`.

The audit-style pages (`audit.tsx`, `consent-v2.tsx`, `server-side.tsx`) share a
three-tier account → container → workspace selector with auto-selection effects,
plus runtime-capture JSON paste/file-upload handling.

### 3.2 Serverless API (`apps/portal/api/**`) — Vercel-safe pattern

Each `.ts` under `api/` is an invocable function (`api/**/*.ts` in
`vercel.json`), **not** a helper module. The hard rule (see `CLAUDE.md`): at
module load, import only `node:*` builtins and `import type` (erased at compile
time). Anything heavier — the shared audit engine, `googleapis` — is pulled in
via `await import(...)` **inside the handler, after session/auth validation**.

Consequence: each route inlines its own copy of the session/cookie/OAuth
machinery (cookie parse, HMAC-signed-cookie decode, token refresh, `sendJson`,
`sendGtmError`). This duplication is **intentional and load-bearing** — a prior
attempt to import a shared `api/_lib/*` module caused
`FUNCTION_INVOCATION_FAILED` at cold start. The duplicated blocks are annotated
"keep this section in sync across GTM routes." Do not "DRY up" these into a
top-level shared import; doing so reintroduces the cold-start crash. (A
Vercel-safe consolidation would require a module that itself imports only
`node:*` and is pulled in lazily after auth — a larger, higher-risk change than
the inlining it would replace.)

### 3.3 Session / OAuth lifecycle

Stateless **signed-cookie** sessions: tokens live in the cookie itself, signed
with `PORTAL_SESSION_SECRET` via HMAC-SHA256 (`HttpOnly`, `SameSite=Lax`,
`Secure` in prod, 30-day max-age). `getValidAccessToken` decodes the cookie,
returns the access token if unexpired, otherwise refreshes via Google's token
endpoint and rotates the cookie. The Express dev server (`server/gtm/oauth.ts`)
additionally keeps a legacy in-memory map — fine locally, unsuitable for
Vercel's multi-instance model, which is exactly why production is cookie-based.

The dev server (`server/`) consumes the shared helpers in
`server/gtm/vercel-helpers.ts` and `session-cookie.ts`; the serverless routes do
not (by the inlining rule above). These two layers must be kept behaviorally in
sync by hand.

### 3.4 Audit flows

`api/gtm/audit.ts`, `consent-audit.ts`, and `sgtm.ts` validate the session,
lazily import the relevant engine from `apps/portal/shared/`, run it against
GTM data (and optional runtime-capture evidence), and return JSON. The Consent
Mode v2 engine (`shared/consent-audit.ts`) is framework-free and covered by
`shared/__tests__/consent-audit.node.test.ts` (must stay **170/170**, runner
fails under 100 cases).

## 4. Runtime worker (`apps/runtime-worker/`)

A standalone `node:http` server exposing `POST /capture`. It drives headless
Chromium (Playwright, lazily loaded) to load pages and emit the structured
runtime-capture artifact the portal audits consume. It is deliberately **not**
deployable to Vercel (needs a real browser host: Render/Fly/Railway/VPS).
Security is opt-in via env: bearer-token auth (`RUNTIME_WORKER_TOKEN`,
timing-safe compared), host allowlist, per-request URL cap, and navigation
timeouts. It never writes to GTM/GA4 and never persists captures.

## 5. Release / CI / deploy

- **CI** (`.github/workflows/ci.yml`): on push/PR to `main` — `npm ci`,
  `typecheck`, `build`, `test`. `npm test` chains guardrails + auth + pagination
  + ga4Admin node tests and the Consent v2 suite.
- **Release** (`.github/workflows/release.yml`): on push to `main`,
  `semantic-release` derives the version and changelog from Conventional Commits
  (`feat:`→minor, `fix:`→patch, `BREAKING CHANGE:`→major). `chore:`/`docs:` do
  not ship. Do not hand-edit `version` or `CHANGELOG.md`. Self-made release
  commits carry `[skip ci]`.
- **Portal deploy**: Vite client + serverless `api/**` to Vercel
  (`vercel-build` = `vite build`). Runtime worker deploys separately.

## 6. Risk register

| # | Risk | Where | Severity | Notes |
| --- | --- | --- | --- | --- |
| R1 | Serverless inlining duplication | `apps/portal/api/**` | Medium | Cookie/OAuth/response code copy-pasted per route. Intentional (Vercel cold-start safety) but drifts easily. Mitigate with a lazily-imported, `node:*`-only shared module — non-trivial, defer. |
| R2 | Dev-vs-serverless divergence | `server/` vs `api/` | Medium | Two implementations of the same session logic must be kept in sync by hand. |
| R3 | Client page duplication | `audit.tsx`, `consent-v2.tsx`, `server-side.tsx` | Medium | Triplicated account→container→workspace selector + runtime-input + error-card blocks; large single-file pages. Extract a shared selector hook/component + `useApiError` hook. |
| R4 | No caching / per-call client getter | `src/tools/*` | Low | Each tool call re-fetches from Google; no TTL cache. Acceptable for an MCP tool surface; revisit only if audits get slow. |
| R5 | HTTP MCP session map is in-process | `src/index.ts` | Low | `transports` is a single-process `Map`; fine for single-instance HTTP, not horizontally scalable. |
| R6 | Bundle size | portal client | Low | ~471 kB JS (142 kB gzip). Code-splitting would help first paint. |

## 7. Refactor strategy (prioritized)

1. **Done — MCP tool response envelope.** Extracted `src/utils/toolResponse.ts`
   and adopted it across all 17 tool files, collapsing ~180 inline
   `content: [{ type:'text', text: JSON.stringify(...) }]` / error envelopes
   into `jsonResult` / `textResult` / `errorResult` / `errorText`. Output is
   byte-identical; behavior unchanged. Low risk, high readability win.
2. **Client `useApiError` hook + shared GTM selector** (R3). Normalize the
   duplicated error-card + reconnect logic and the triplicated cascading
   selector. Medium effort, behavior-preserving, well-tested by eye in the UI.
3. **Vercel-safe shared session module** (R1/R2). A single module importing only
   `node:*`, pulled in via `await import()` after auth validation, replacing the
   per-route inlining and the dev/serverless split. Higher risk — must be
   validated against real Vercel cold starts before adoption.
4. **Optional, only if measured**: client code-splitting (R6), MCP read cache
   (R4). Do not pursue speculatively.

### Non-goals / guardrails to preserve in any refactor

- Read-only defaults and the `confirm` + capability-flag gates (§2.5).
- All existing tool names, routes, and response shapes.
- The `node:*`-only top-level import rule for `api/**` (§3.2).
- Consent v2 suite at 170/170.
- Portal mobile/tablet/desktop compatibility.
