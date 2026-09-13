# Contributing

This guide covers the developer workflow for the **Samarth Analytics MCP**
repo, including making changes with **Claude Code** (Desktop / App / CLI).

Read [`CLAUDE.md`](./CLAUDE.md) first — it has the project guardrails that
apply to every change.

## 1. Clone, install, set up

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp
npm install                 # root deps (MCP server)
npm run portal:install      # portal deps (apps/portal)
```

Configure environment:

```bash
cp .env.example .env        # fill in your own values; never commit .env
```

See `.env.example` for every variable. Key points: self-hosters use the
`GOOGLE_OAUTH_*` vars; the guardrail flags (`GTM_MCP_ENABLE_WRITES`, etc.)
default to read-only and should stay that way unless you intend writes.

## 2. Working with Claude Code

Open Claude Code (Desktop, App, or CLI) **from the repo root** so it picks up
`CLAUDE.md` and the project context. Describe the change you want; Claude will
follow the guardrails in `CLAUDE.md`. Always review the diff and run the checks
below before committing.

## 3. Branch workflow

```bash
git checkout -b feat/short-description     # or fix/..., docs/..., chore/...
# make changes
git add <files>                            # stage specific files, not `git add .`
git commit -m "feat: concise summary"      # Conventional Commits (see §8)
git push -u origin feat/short-description
```

Open a PR against `main`. `main` is release-managed by `semantic-release`.

## 4. Local Google auth

Authenticate once to generate an OAuth token file (written to
`.gtm-mcp-tokens.json`, which is gitignored):

```bash
npm run auth:google         # opens a browser, completes OAuth, writes tokens
# or, to (re)configure the OAuth client interactively:
npm run oauth:setup
```

## 5. MCP server commands

```bash
npm run dev                 # stdio transport, watch mode (Claude Desktop/Cursor/Code)
npm run dev:http            # HTTP+SSE transport, watch mode
npm run build               # compile TypeScript to dist/
npm start                   # run compiled server (stdio)
npm run start:http          # run compiled server (HTTP)
npm run inspector           # MCP Inspector against dist/index.js
```

## 6. Portal commands

```bash
npm run portal:dev          # Express dev server (apps/portal)
npm run portal:build        # production build
npm run portal:check        # type-check the portal (tsc)
npm run portal:start        # run the built portal
```

The portal must stay responsive across mobile, tablet, and desktop.

## 7. Runtime worker commands

The runtime worker captures analytics network hits in headless Chromium. It is
**read-only** and is **not** deployable to Vercel (needs a real browser).

```bash
cd apps/runtime-worker
npm install
npm run postinstall-browser # installs Chromium for Playwright
npm run check               # node --check on server/capture/cli
npm start                   # run the capture worker
npm run capture             # one-off capture
```

## 8. Tests and checks

Root:

```bash
npm run typecheck           # tsc --noEmit
npm run build               # tsc
npm test                    # guardrails + auth + pagination + ga4Admin + consent
npm run test:consent        # Consent Mode v2 suite — must be 170/170
```

Portal (if touched):

```bash
npm run portal:check
npm run portal:build
```

Runtime worker (if touched):

```bash
npm --prefix apps/runtime-worker run check
```

## 9. PR checklist

- [ ] Branch named with a Conventional Commit type prefix.
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] `npm test` passes (incl. consent suite **170/170**).
- [ ] Portal touched → `npm run portal:check` and `npm run portal:build` pass; UI still responsive.
- [ ] Runtime worker touched → `npm --prefix apps/runtime-worker run check` passes.
- [ ] No secrets, `.env`, `*.gtm-mcp-tokens.json`, service-account keys, or `.vercel/` committed.
- [ ] Read-only / guardrail defaults unchanged unless the change is explicitly about that.
- [ ] Commit messages follow Conventional Commits.

## 10. Deploying the portal to Vercel

The portal deploys as a Vite client plus serverless functions
(`apps/portal/api/**`). Config lives in `apps/portal/vercel.json`:

- Framework: `vite`; build: `npm run vercel-build`; output: `dist/public`.
- Every `api/**/*.ts` is a serverless route on the `@vercel/node` runtime.

Set env vars in **Vercel Dashboard → Settings → Environment Variables** (never
in code or images). When editing `apps/portal/api/**`, follow the serverless
safety rules in [`CLAUDE.md`](./CLAUDE.md): only `node:*` and `import type` at
module top level; pull heavy modules in via `await import(...)` **after** auth;
don't place shared helper files inside `api/` (they'd be treated as routes).

## 11. Safety and security rules

- **Read-only by default.** Don't weaken MCP guardrails or add GA4 write access.
- **Never commit secrets.** `.env`, token files, service-account keys, and
  `.vercel/` are gitignored — keep them out of commits.
- **Vercel API discipline.** See §10 and `CLAUDE.md`.
- **Consent suite green.** `npm run test:consent` must stay 170/170.
- **Releases are automated.** Don't hand-edit versions or the changelog;
  `semantic-release` handles them from commits on `main`.
