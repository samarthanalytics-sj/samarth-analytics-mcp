# Samarth Analytics MCP — Project Overview

A single "start here" map of the whole project: what each piece is, the **desktop
app's tabs and features**, the MCP server's tools and slash commands, the
guardrails, and how to **build, run, and test** everything.

For deeper dives, see the sibling docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`GETTING_STARTED_GUIDE.md`](./GETTING_STARTED_GUIDE.md),
[`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md),
[`STORAGE_SECURITY.md`](./STORAGE_SECURITY.md), and the
[`gtm-understanding-guide.md`](./gtm-understanding-guide.md).

---

## 1. What this is

**Samarth Analytics MCP** is a production toolkit for Google Tag Manager (GTM API
v2) and Google Analytics 4 (Admin + Data API), delivered in a few shapes:

- an **MCP server** any MCP client (Claude Desktop, Cursor, …) can connect to,
- a **local desktop app** (Electron) that wraps the same capabilities behind a
  multi-account UI with an AI chat, tag-suggestion, audit, and verification tools,
- a **web-audit MCP** that crawls a live site (Playwright) for forms, consent, and
  tag-firing checks,
- a **customer portal** (Vercel) that runs GTM / Consent Mode v2 audits, and
- a **runtime worker** that captures live pages headlessly.

Everything is **read-only by default**; every mutating action is gated behind an
explicit env flag *and* a `confirm=true`/approval step (see [Guardrails](#8-guardrails-repo-wide)).

---

## 2. Monorepo layout (the five components)

| Path | Package | What it is | Deploys to |
|------|---------|-----------|-----------|
| `src/` | `samarth-gtm-mcp` | The **MCP server** — stdio + Streamable-HTTP transports, ~94 GTM/GA4 tools, 7 prompts (slash commands), guardrails, OAuth. | npm / any MCP host |
| `apps/desktop/` | `samarth-desktop` | The **Electron desktop app** — multi-account UI, AI chat, tag suggestions, audits, tag verification. | packaged Electron app |
| `apps/portal/` | `@samarth/portal` | The **customer portal** — Vite client + Express dev server; GTM / Consent Mode v2 audits. | **Vercel** (serverless `api/**`) |
| `apps/web-audit-mcp/` | `samarth-web-audit-mcp` | A **second MCP server** with a site-audit agent: Playwright crawl, form inventory, CMP interaction, Consent Mode v2 findings, GTM reconciliation, and the operator-driven `verify` engine. | Docker (needs a real browser host) |
| `apps/runtime-worker/` | `samarth-runtime-worker` | **Read-only headless-Chromium capture worker** (page capture / queue consumer). | Render / Fly / Railway / VPS (needs a browser) |

> Not for Vercel: `web-audit-mcp` and `runtime-worker` both need a real Chromium
> host, so they ship as Docker / long-running services, not serverless functions.

---

## 3. The MCP server (`src/`)

The original product: a faithful GTM API v2 wrapper plus read-only GA4 tooling,
exposed over MCP.

- **Transports:** stdio (for local MCP clients) and Streamable HTTP.
- **Bins:** `samarth-gtm-mcp` (the server) and `samarth-gtm-auth` (a Google OAuth
  helper).
- **Tools (~94)**, grouped:
  - **GTM structure** — `accounts_*`, `containers_*` (incl. `containers_lookup`,
    `containers_snippet`, `containers_set_tagging_server_urls`), `workspaces`,
    `versions_*`, `environments_*`, `folders_*`, `user_permissions_*`,
    `export_container`.
  - **GTM resources** — `tags_*` (+ `tags_add_ga4_event_parameters`),
    `triggers_*`, `variables_*`, `built_in_variables_*`, server-side
    `client`/`transformation` creates, `destinations_*`.
  - **GA4 Admin** — `ga4_properties_*`, `ga4_data_streams_list`,
    `ga4_key_events_list`, `ga4_custom_dimensions_list`,
    `ga4_custom_metrics_list`, `ga4_audiences`, `ga4_*_links_list`,
    `ga4_data_retention_*`, `ga4_enhanced_measurement_get`, plus the
    write/delete/archive variants (flag-gated).
  - **GA4 Data (read-only)** — `ga4_run_report`, `ga4_run_realtime_report`.
  - **Audit** — `audit_container` (workspace config findings).
- **Prompts / slash commands (7)** — MCP prompts show up as slash commands in the
  client's prompt menu. Each is an ordered recipe that drives the *existing*
  tools (it never invents tools); read-only by default, writes stay draft-only:
  - `setup_server_side_container` — one guided sGTM build.
  - `setup_ecommerce_funnel` — the full GA4 ecommerce funnel + consent defaults.
  - `/audit` — read-only `audit_container` summary.
  - `/report` — `ga4_run_report` over a range.
  - `/create-tag` — GA4 event tag (event → trigger → tag → params), draft-only.
  - `/debug` — read-only "why isn't this tag firing" diagnosis.
  - `/explain` — explain a concept or a specific resource, read-only.
- **Build/run:** `npm run build` (`tsc`), `npm start` (`node dist/index.js`),
  `npm run dev` (`tsx --watch src/index.ts`), `npm run typecheck` (`tsc --noEmit`).

---

## 4. The desktop app (`apps/desktop`) — tabs & features

The desktop app (`samarth-desktop`) is an **Electron + electron-vite + React**
application with the standard three processes:

- **main** (`src/main/`) — Node side: Google OAuth (loopback), the GTM/GA4 data
  service, the LLM gateway + chat tool registry, secret store (Windows DPAPI),
  IPC handlers.
- **preload** (`src/preload/`) — the typed `window.desktop.*` bridge.
- **renderer** (`src/renderer/`) — the React UI (`App.tsx` + a few components).

**Multi-account:** every connected Google account has its own token, its own LLM
provider/model (key in the OS keychain), and its own GTM/GA4 context. One account
is *active* at a time; it's used across all tabs.

### The five sidebar tabs

The left nav has five views (keyboard shortcuts **Ctrl/Cmd + 1..5**; press **?**
for the shortcuts overlay):

#### 1. 💬 Chat
An AI analyst over your GTM/GA4. The **chat brain** (`chat-service.ts`) has a
product toggle (**GTM** vs **GA4**) that scopes which tools it can call, a large
system prompt encoding the GTM creation methodology + GA4 audit framework, and a
rich tool registry (higher-level than the raw MCP tools — e.g.
`create_gtm_tracking_tag`, `bootstrap_server_side_tagging`, one-shot ecommerce +
pixel/CAPI builders, `run_ga4_report`).
- **Slash commands** — type `/` for an autocomplete menu: `/audit`, `/report`,
  `/create-tag`, `/debug`, `/explain`. The short command shows in your bubble; the
  full instruction is sent to the brain. `/report` auto-switches to GA4 mode.
- **Write safety** — GTM writes land in a **draft workspace**; every write shows a
  confirm card (destructive actions need a two-step confirm). A **Revert** button
  undoes the last query's changes.
- Threads persist per account + product + container.

#### 2. 🗂 GTM Tools — four sub-tabs
- **🏷 Tag suggestions** — scan a site (main-site crawl, single page, or a CSV of
  landing pages) → ranked, creatable **GA4 event tag** suggestions with the right
  trigger + parameters. Each row is inline-editable and one-click "create in GTM"
  (draft). Includes the **measurement installation plan** ("How to install"):
  per-suggestion status chip (Ready / listener-tag / site-code) with a one-click
  "Create listener tag" and check-offs, plus an exportable **install runbook**
  (Markdown / PDF).
- **🔍 Container audit** — audit the container's existing tags for issues
  (no-firing-trigger, paused, broken references, GA4 config, duplicate names,
  broad/unused triggers, …), grouped by severity with the fix for each.
- **✅ Tag verification** — prove the container's tags actually **fire**: create a
  workspace preview (never publishes) and drive each tag's trigger. Results show a
  **scorecard** (Fired / Config-verified / Server-side / Issues / Untested) + a
  **results table** (Status · Tag · Event · Fired via · Signal). The same run also
  finds the site's forms and can **verify a real form submit** (operator-driven).
- **🖥 Server container** — set up / inspect a server-side (sGTM) container.

#### 3. 📊 GA4 Tools — two sub-tabs
- **GA4 Audit** — an evidence-based GA4 **property audit** (config + data quality)
  with interactive trend/channel charts, a fixed report template, and a shareable
  Markdown/PDF export.
- **🔔 GA4 Monitoring** — scheduled, multi-property health checks that post alerts
  (e.g. to Slack); an alert-first dashboard, and a cross-tab banner that surfaces
  new issues on any tab.

#### 4. 📖 Prompts
A searchable library of ready-made prompts; picking one seeds the Chat input (and
switches to the right GTM/GA4 mode).

#### 5. ⚙ Settings
A responsive card layout (masonry): **Appearance** (dark/light), **Google sign-in
(OAuth client)** status, **Accounts** (switch / rename / disconnect / remove /
connect — this is where account management lives), **Active account** detail,
**Language model** (provider + model per account), **Providers (API keys)** (one
key per provider, stored encrypted via DPAPI), and **Diagnostics** (secret-store
health, app + runtime versions).

### Desktop UI system
- **Inter** bundled offline (`@fontsource/inter`); theme via CSS variables
  (`theme.ts`) with dark/light.
- **`global.css`** is the "premium" engine: animations (view transitions, card
  rise-in, skeleton shimmer, chart line-draw), hover/active/focus states for every
  button, an animated nav accent bar, themed scrollbars — all disabled under
  `prefers-reduced-motion`.
- Reusable primitives in `ui.tsx`: `Skeleton*`, `EmptyState`, `ShortcutsOverlay`.

### Build/run
- `npm run dev` → `electron-vite dev` (renderer hot-reloads; **the main process
  does not — fully restart the app after pulling main-side changes**).
- `npm run build` → `electron-vite build`; `npm start` → `electron-vite preview`.
- `npm run typecheck` → node + web TS projects. **After pulling, run
  `npm install` in `apps/desktop`** (e.g. the bundled Inter font must be present).

---

## 5. Portal (`apps/portal`)

A white-label **customer portal**: a Vite client plus an Express dev server,
deployed to **Vercel** as serverless functions under `api/**`. It runs GTM /
Consent Mode v2 audits using the framework-free engines in
`apps/portal/shared/` (including the Consent Mode v2 engine + its test suite).

**Vercel safety rule:** `api/**` files are per-request functions — at module load
they import only `node:*` builtins and `import type`; anything heavier is pulled
in lazily via `await import(...)` *inside* the handler, after auth. Each `.ts`
under `api/` is a route, not a shared helper.

- `npm run dev` (Express dev server), `npm run build`, `npm run check` (`tsc`).
- Deeper: [`ARCHITECTURE.md`](./ARCHITECTURE.md),
  [`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md),
  [`API_JOBS.md`](./API_JOBS.md), [`OBSERVABILITY.md`](./OBSERVABILITY.md).

---

## 6. web-audit MCP (`apps/web-audit-mcp`)

A second MCP server with a **built-in site-audit agent**: Playwright crawl, form
inventory, consent-banner (CMP) interaction, Consent Mode v2 compliance findings,
and optional GTM container reconciliation. Reuses the shared consent engine; SSRF
guard mirrors the runtime worker. Ships a Dockerfile (Playwright base image, HTTP
transport).

- The autonomous agent's **only** permitted page interaction is clicking
  consent-banner controls — it never submits forms.
- **Exception — the `verify` tool** (`src/verify/`, the TagDrishti engine): an
  operator-driven flow that performs the spec-supplied interactions **including
  real form submits** to prove trigger-fired events. **OFF by default**, gated
  behind `WEB_AUDIT_ENABLE_VERIFY=true` (the `samarth-verify` CLI is an explicit
  local invocation and needs no flag). Client-side only.
- `npm run webaudit:check` (typecheck), `npm run test:webaudit` (pure-logic
  suite, no browser).

---

## 7. runtime-worker (`apps/runtime-worker`)

A **read-only headless-Chromium capture worker** (page capture + a queue
consumer). Not for Vercel — it needs a real browser host. Plain `.mjs`; checked
with `npm --prefix apps/runtime-worker run check` (`node --check` on each file).

---

## 8. Guardrails (repo-wide)

These are hard rules — do not relax them:

- **Read-only by default.** GTM writes/publishes/deletes are gated behind
  `GTM_MCP_ENABLE_WRITES` / `GTM_MCP_ENABLE_PUBLISH` / `GTM_MCP_ENABLE_DELETES`;
  GA4 Admin writes behind `GA4_MCP_ENABLE_WRITES` / `GA4_MCP_ENABLE_DELETES` (all
  default `false`) — **plus `confirm=true` on every write**. The GA4 **Data API**
  (reporting) is always read-only.
- **Never commit secrets** — `.env`, `*.gtm-mcp-tokens.json`, service-account
  keys, `.vercel/` are gitignored and stay that way.
- **Consent Mode v2 suite must stay green** — `npm run test:consent` must remain
  170/170 (and fails if fewer than 100 cases run).
- **Portal stays responsive** across mobile/tablet/desktop.

---

## 9. Build, run & test — quick reference

| Package | Dev | Build | Typecheck / check |
|---------|-----|-------|-------------------|
| `src/` (MCP server) | `npm run dev` | `npm run build` | `npm run typecheck` |
| `apps/desktop` | `npm run dev` | `npm run build` | `npm run typecheck` (node + web) |
| `apps/portal` | `npm run dev` | `npm run build` | `npm run portal:check` |
| `apps/web-audit-mcp` | `npm run dev` | `npm run build` | `npm run webaudit:check` |
| `apps/runtime-worker` | `npm run dev` | — | `npm --prefix apps/runtime-worker run check` |

**Root MCP server before finalizing:** `npm run typecheck && npm run build && npm test`.

---

## 10. Testing

`npm test` (root) chains the whole suite:
`test:consent` (Consent Mode v2, must be 170/170), `test:audit`, `test:snapshot`,
`test:rbac`, `test:retention`, `test:storage`, `test:webaudit`, `test:tagsuggest`,
`test:webreport`, `test:verify`, plus the guardrails / auth / pagination /
ga4Admin / prompts unit suites. The desktop app has its own suite
(`npm --prefix apps/desktop test`) covering the chat prompt, tool registry,
tag-template, verify, and shared logic.

---

## 11. Releases

**Conventional Commits** + `semantic-release` on `main` derive the version and
changelog automatically: `feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` →
major. Use `chore(...)`, `docs:`, etc. for non-shipping changes. **Do not
hand-edit** the version in `package.json` or `CHANGELOG.md`.

---

## 12. Feature highlights (what's been added)

A non-exhaustive tour of the bigger additions, in rough order:

- **Measurement installation plan** — tag suggestions became a two-sided plan
  (container-side tag/trigger/variables + site-side listener/dataLayer), with
  DLV-scoped `custom_event` triggers, auto-creatable Custom HTML listener tags, a
  status chip + check-offs, and an exportable install runbook (Markdown + PDF).
- **Tag verification** — prove existing tags fire (preview-driven), a
  scorecard + results table, and container-tag-driven **real form-submit**
  verification.
- **GA4** — evidence-based property audit + data-quality checks, on-screen
  interactive charts, and multi-property **monitoring** with Slack alerts.
- **Server-side (sGTM)** — one-shot server-container bootstrap, server tags /
  triggers / clients / transformations, and Meta / TikTok CAPI server tags.
- **Desktop shell & UX** — accounts moved into Settings, a clearer container
  picker, bundled Inter, a premium animation/skeleton/empty-state/keyboard-
  shortcut layer, a full-width **masonry** Settings grid, and a sticky-header /
  reachable-scrollbar suggestions table.
- **Slash commands** — as **MCP prompts** on the server (for external MCP clients)
  *and* in the **desktop chat** input.
- **Chat quality** — guidance so "when was data last recorded?" finds the actual
  last active day (not an empty 28-day aggregate) and doesn't over-alarm.

For the authoritative history, see `CHANGELOG.md` and the git log.

---

## 13. Where to go next

- New here? [`GETTING_STARTED_GUIDE.md`](./GETTING_STARTED_GUIDE.md).
- System design / production: [`ARCHITECTURE.md`](./ARCHITECTURE.md),
  [`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md),
  [`PRODUCTION_CUTOVER_RUNBOOK.md`](./PRODUCTION_CUTOVER_RUNBOOK.md).
- Security / storage: [`STORAGE_SECURITY.md`](./STORAGE_SECURITY.md).
- GTM concepts + examples: [`gtm-understanding-guide.md`](./gtm-understanding-guide.md),
  [`gtm-other-tag-types.md`](./gtm-other-tag-types.md),
  [`ga4-100-examples.md`](./ga4-100-examples.md).
- Contributing + repo rules: [`../CONTRIBUTING.md`](../CONTRIBUTING.md),
  [`../CLAUDE.md`](../CLAUDE.md).
