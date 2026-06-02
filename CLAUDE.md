# CLAUDE.md

Project-specific guidance for working in this repo with Claude Code (Desktop / App / CLI).
These instructions override default behavior — follow them.

## What this repo is

**Samarth Analytics MCP** — a production MCP server for the Google Tag Manager
API v2, plus read-only GA4 (Admin + Data API) tooling, and a white-label
customer **portal** that runs GTM/Consent Mode v2 audits.

Layout:

- `src/` — the MCP server (stdio + HTTP transports, tools, guardrails, auth).
- `apps/portal/` — the customer portal. Vite client + Express dev server,
  deployed to Vercel as serverless functions under `apps/portal/api/`.
- `apps/portal/shared/` — framework-free audit engines (incl. the Consent
  Mode v2 engine and its test suite).
- `apps/runtime-worker/` — read-only headless-Chromium capture worker. **Not
  for Vercel** — needs a real browser host (Render/Fly/Railway/VPS).

## Guardrails — do not violate

### Read-only by default
The MCP server ships read-only. Writes/publishes/deletes are gated behind
`GTM_MCP_ENABLE_WRITES`, `GTM_MCP_ENABLE_PUBLISH`, `GTM_MCP_ENABLE_DELETES`
(all default `false`). Never relax these defaults or weaken a guardrail check
to make something work. GA4 access is read-only by design — do not add GA4
write scopes or calls.

### Never commit secrets
Never commit `.env`, any `*.gtm-mcp-tokens.json`, service-account keys, or
`.vercel/` artifacts. These are gitignored — keep it that way. The hosted
OAuth client secret lives only on the hosted backend; never put it in the repo.

### Vercel serverless API safety (`apps/portal/api/**`)
These files are bundled and evaluated per-request by Vercel. Follow the pattern
already used in `apps/portal/api/gtm/audit.ts`:

- **No unsafe top-level imports.** At module load, import only `node:*` builtins
  and `import type` (types are erased). Anything heavier (the shared audit
  engine, googleapis, etc.) must be pulled in lazily via `await import(...)`
  **inside the handler, after session/auth validation**. This guarantees
  unauthenticated probes get a clean 401 before heavy modules evaluate, and any
  import failure surfaces as JSON instead of `FUNCTION_INVOCATION_FAILED`.
- **Each file under `api/` is a route, not a helper.** Every `.ts` there is
  treated as an invocable function (`api/**/*.ts` in `vercel.json`). Do not drop
  shared helper modules inside `api/` — put shared code in `apps/portal/shared/`
  or `apps/portal/server/` and import it lazily.

### Consent Mode v2 test suite must stay green
`npm run test:consent` runs `apps/portal/shared/__tests__/consent-audit.node.test.ts`
and must remain **170/170 passing**. The runner also fails if fewer than 100
cases run. If you change the consent engine, update/extend the tests and keep
them all passing.

### Portal must stay responsive
The portal UI must remain usable on mobile, tablet, and desktop. Don't ship
layout changes that break smaller breakpoints.

## Commands to run before finalizing

Root (MCP server):

```bash
npm run typecheck      # tsc --noEmit
npm run build          # tsc
npm test               # guardrails + auth + pagination + ga4Admin + consent
```

Consent suite alone (fast, must be 170/170):

```bash
npm run test:consent
```

Portal (run if you touched `apps/portal/`):

```bash
npm run portal:check   # tsc for the portal
npm run portal:build
```

Runtime worker (run if you touched `apps/runtime-worker/`):

```bash
npm --prefix apps/runtime-worker run check   # node --check on server/capture/cli
```

## Releases

This repo uses **Conventional Commits**; `semantic-release` derives versions
and the changelog from commit messages on `main` (`feat:` → minor, `fix:` →
patch, `BREAKING CHANGE:` → major). Do not hand-edit the version in
`package.json` or `CHANGELOG.md` — let the release pipeline do it. Use
`chore(...)`, `docs:`, etc. for non-shipping changes.
