# Samarth Analytics — GTM Portal

A browser-based, white-label customer portal that sits on top of the
[Samarth GTM MCP server](../../README.md). Customers connect their Google Tag
Manager account, run audits, and prepare implementation plans. Every change
goes through a **Samarth approval queue** before anything is published to GTM.

> **MVP status.** The portal now runs a **live, read-only QC audit** against
> Google Tag Manager via Google OAuth. The Connect button on the landing page
> and the Audit page both hit real GTM API v2 endpoints. The rest of the
> surface (mixed-source container inventory, approval queue, recommendation
> builder) is still mock and is documented in the TODOs below.

---

## Why this exists

The MCP server is great for power users on Claude Desktop, Cursor, or Claude
Code — but most clients can't (and shouldn't) install MCP locally. The portal
exposes the same capabilities via a browser, on any device, with safety rails:

- **No publishes without approval.** Customers can audit and draft change
  plans. Only Samarth reviewers can move a plan from *Approved* to *Published*.
- **One Google sign-in.** Hosted OAuth removes the need for service accounts
  or local credentials on the client side.
- **Mixed-source inventory.** Containers come from Google APIs *and* legacy
  spreadsheets / CSV imports / manual records collected by Samarth over the
  last 15 years.

## Architecture

```
┌──────────────────────┐   ┌────────────────────────┐   ┌────────────────────┐
│  Browser (React/Vite) │──▶│  Portal backend (TBD)  │──▶│  Samarth GTM MCP   │
│  - Audit UI           │   │  - Hosted Google OAuth │   │  (Streamable HTTP) │
│  - Recommendation     │   │  - Token vault         │   │  - audit_workspace │
│  - Approval queue     │   │  - Container index     │   │  - create_tag/etc. │
└──────────────────────┘   └────────────────────────┘   └────────────────────┘
         ▲                            │
         │                            ▼
         │                  ┌────────────────────┐
         │                  │  Mixed-source store │
         │                  │  (Sheets/CSV/SQL)   │
         └──────────────────└────────────────────┘
```

The frontend talks to a single adapter:

```ts
import { portalApi } from "@/lib/portal-api";
```

Today, `portalApi` returns mock data with a small artificial delay. Tomorrow,
each method will hit a thin Express backend that:

1. Validates the customer's session.
2. Looks up their OAuth refresh token in the server-side vault.
3. Either:
   - Reads from the mixed-source container index (`listContainers`,
     `getContainer`), or
   - Forwards the request to the MCP server's HTTP transport
     (`runAudit` → `audit_workspace`, `submitForReview` →
     creates a workspace version, etc.).

## Project layout

```
apps/portal
├── client/                # Vite + React frontend
│   ├── public/favicon.svg
│   └── src/
│       ├── App.tsx              # routes + providers (wouter hash router)
│       ├── components/
│       │   ├── app-shell.tsx    # sidebar + mobile drawer
│       │   ├── brand-logo.tsx   # inline SVG mark
│       │   ├── page-header.tsx
│       │   └── status-chip.tsx
│       ├── data/mock.ts         # sample container + audit + approval data
│       ├── lib/
│       │   ├── portal-api.ts    # ← swap this for live MCP/Sheets calls
│       │   ├── portal-store.tsx # React context store
│       │   └── theme-provider.tsx
│       └── pages/
│           ├── overview.tsx
│           ├── containers.tsx
│           ├── audit.tsx
│           ├── recommend.tsx
│           └── approvals.tsx
├── server/                # Express stub (kept for future API)
├── shared/portal-types.ts # types used by both frontend and future backend
├── package.json
└── README.md (this file)
```

## Routes (hash-based)

| Path             | Page                          |
|------------------|-------------------------------|
| `/#/`            | Landing + KPIs + onboarding   |
| `/#/containers`  | Mixed-source container table  |
| `/#/audit`       | Audit workspace with findings |
| `/#/consent-v2`  | Dedicated Consent Mode v2 audit (consent findings only) |
| `/#/server-side` | sGTM server container visibility |
| `/#/recommend`   | Recommendation builder        |
| `/#/approvals`   | Approval queue (status chips) |

## Run locally

From the repo root:

```bash
# one-time
npm run portal:install

# day-to-day
npm run portal:dev      # vite + express on :5000
npm run portal:check    # typecheck
npm run portal:build    # production bundle in apps/portal/dist
```

Or directly inside `apps/portal/`:

```bash
npm install
npm run dev
```

The existing MCP server's scripts (`npm run build`, `npm test`, etc.) are
unchanged.

## Live QC audit flow

The portal now implements a live, browser-driven QC audit:

1. **User clicks "Connect Google Tag Manager"** on the landing page.
2. **Browser redirects to** `/api/oauth/start` (Express), which sends them to
   Google's consent screen with GTM read-only scope.
3. **Google redirects back to** `/api/oauth/callback?code=…`. The portal
   exchanges the code for tokens server-side and stores them in an in-memory
   session keyed by an httpOnly cookie.
4. **The Audit page** uses live GTM API v2 endpoints to populate three
   selectors — Account → Container → Workspace.
5. **"Run QC audit"** posts to `/api/gtm/audit`, which reads tags, triggers,
   variables, folders, and built-in variables, then runs the QC rule set
   in `apps/portal/server/gtm/audit.ts`. Nothing is written back to GTM.

### One-time setup

1. Create an **OAuth client** in
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   - Application type: **Web application**
   - Authorized redirect URI: e.g. `http://localhost:5000/api/oauth/callback`
   - To use `PORTAL_REVOKE_GOOGLE_ON_DISCONNECT` later, create it in a Google
     Cloud project of its own: Google revokes access per project.
2. Copy `apps/portal/.env.example` to `apps/portal/.env` and fill in
   `PORTAL_GOOGLE_OAUTH_CLIENT_ID`, `PORTAL_GOOGLE_OAUTH_CLIENT_SECRET`, and
   `PORTAL_GOOGLE_OAUTH_REDIRECT_URI` (or `PORTAL_PUBLIC_URL` for hosted).
3. Make sure the OAuth consent screen has the Tag Manager API
   (`tagmanager.readonly`) scope enabled.

### Endpoints added in this milestone

| Route                                                                            | Method | Purpose                              |
|----------------------------------------------------------------------------------|--------|--------------------------------------|
| `/api/oauth/status`                                                              | GET    | Whether the session is connected     |
| `/api/oauth/start`                                                               | GET    | Begin Google OAuth                   |
| `/api/oauth/callback`                                                            | GET    | Exchange code for tokens             |
| `/api/oauth/logout`                                                              | POST   | Clear the session; revoke the Google grant if `PORTAL_REVOKE_GOOGLE_ON_DISCONNECT=true` |
| `/api/gtm/accounts`                                                              | GET    | List GTM accounts                    |
| `/api/gtm/accounts/:accountId/containers`                                        | GET    | List containers                      |
| `/api/gtm/accounts/:accountId/containers/:containerId/workspaces`                | GET    | List workspaces                      |
| `/api/gtm/audit`                                                                 | POST   | Run the QC audit on a workspace      |
| `/api/gtm/consent-audit`                                                         | POST   | Run the focused Consent Mode v2 audit (consent findings only, read-only) |
| `/api/gtm/sgtm`                                                                  | POST   | Read a server (sGTM) container (read-only) |
| `/api/ga4/admin`                                                                 | POST   | GA4 Admin reads (account summaries, data streams) |

### Production notes (non-negotiable)

- The OAuth client secret is **only** stored on the portal backend (env var).
  It is never bundled into the client app or committed to the repo.
- Token storage in this MVP is **in-memory** (`apps/portal/server/gtm/oauth.ts`).
  Sessions disappear on process restart and are not shared across instances.
  For production multi-instance, move the session map to Redis or a database.
- All cookies are `HttpOnly` + `SameSite=Lax`, and `Secure` when
  `NODE_ENV=production`. Always serve the production portal over HTTPS.

## Audit sources & coverage

The audit is **capability-aware**: every finding is tagged with the source(s)
that produced it, and the coverage matrix states plainly what could *not* be
checked. A clean single-source audit is **not** a clean audit overall.

| Source       | What it reads                                              | Status (hosted/Vercel) |
|--------------|------------------------------------------------------------|------------------------|
| `CONFIG`     | GTM workspace: tags, triggers, variables, versions         | Covered                |
| `GA4_ADMIN`  | GA4 Admin API: properties, data streams, dimensions        | Covered when a GA4 property is selected and reads succeed |
| `SGTM`       | Server container: clients, transformations, transport match | Covered when a **server container** is selected under *Cross-source inputs* and reads succeed; otherwise **Not Covered** |
| `RUNTIME`    | Live browser: network hits, dataLayer, console, tag order  | Covered when a runtime-capture artifact is uploaded/pasted under *Cross-source inputs*; otherwise **Not Covered** |
| `DATA_API`   | GA4 Data API: reported event counts over the last 7 days   | Covered when a GA4 property is selected **and** the reported-events toggle is on; otherwise **Not Covered** |

### Cross-source inputs (opt-in, on the Audit page)

The Audit page exposes a **Cross-source inputs** card. Each input is strictly
opt-in and the audit never claims a source it could not actually read:

- **Runtime capture** — paste or upload a runtime-worker / CLI artifact (see
  below) to enable `RUNTIME`. Findings are derived **only** from observed data
  (per-URL GA4 page_view hit counts, console errors, dataLayer event names,
  missing consent signals on GA4 hits). Absence on a captured page is reported
  as page-scoped, never as a site-wide claim.
- **Server container** — pick a GTM **server** account/container/workspace to
  enable `SGTM`. Reconciles web GA4 `transport_url` / `server_container_url`
  against the selected server domain, lists server clients (GA4 client
  presence), and flags transformations touching PII/ecommerce/GA4 for manual
  review. A non-server container leaves `SGTM` Not Covered.
- **GA4 reported events** — when a GA4 property is selected, toggle this to run
  a read-only GA4 Data API report (last 7 days) and flag GTM-configured GA4
  events with **zero** reported activity (`DATA_API` source, not `RUNTIME`).

### Server-side (sGTM) visibility

The **Server-side** page (`/#/server-side`, backed by `POST /api/gtm/sgtm`)
reads a GTM **server** container's resources using the connected session:

- clients (with extracted claim paths / criteria parameters)
- transformations, zones, templates
- gtag config and container-level (Google tag) destinations

It is strictly **read-only** (list/get only; no create/update/delete/publish).
When the selected container is not a server container it returns an explanatory
state instead of fabricating coverage, and per-resource read failures are
surfaced verbatim so gaps show as Partial / failures rather than a false clean.

The Server-side panel is still available for free-form exploration of a server
container. In addition, selecting a server container under the Audit page's
**Cross-source inputs** now folds those reads into the audit run itself and
turns on the `SGTM` source (transport-match, client presence, transformation
review). Without a server container selected, the audit's `sgtm-clients`
coverage row stays **Not Covered** (no faked parity).

### Dedicated Consent Mode v2 audit

The **Consent v2** page (`/#/consent-v2`, backed by `POST /api/gtm/consent-audit`)
is a focused, read-only sibling of the full Audit page. It runs **only** the
Consent Mode v2 rules from the shared engine (`shared/consent-audit.ts`) — no
GA4 architecture, sGTM, naming, or general QC findings appear here. Findings are
split into three layers: **Config** (consent intent declared in GTM), **Runtime**
(observed in an imported capture), and **Config + Runtime reconciliation**. As on
the Audit page, runtime/reconciliation layers stay empty until a runtime capture
is imported — coverage is never fabricated. Use the full Audit page for
everything else.

### Runtime capture (RUNTIME)

`RUNTIME` confirmation (does the tag actually fire? what hits the network? what
does the dataLayer look like?) cannot run in Vercel — serverless functions have
no browser and a hard time budget. Produce a capture artifact out-of-band, then
upload/paste it under **Cross-source inputs** on the Audit page.

**Option 1 — hosted runtime worker** (recommended; see
[`apps/runtime-worker/`](../runtime-worker/README.md)). A small read-only
Playwright HTTP service you deploy to Render / Fly / Railway / a VPS (NOT
Vercel). `POST /capture` with `{ urls, consentState?, actions? }` and save the
returned JSON.

**Option 2 — local CLI harness**:

```bash
# one-time (optional dependency — kept out of the serverless bundle)
npm i -D playwright
npx playwright install chromium

# capture a page (read-only: it navigates and observes, nothing more)
npm run runtime:capture -- --url https://example.com --output runtime-capture.json
```

Both produce the same `samarth.runtime-capture/v2` artifact: page URL,
console/page errors, analytics network hits (GA4 `/g/collect`, Meta `/tr`,
Google Ads / Floodlight, sGTM endpoint candidates, and more), a network request
count, and dataLayer snapshots/event names before/after load. Playwright is
loaded via dynamic import — if it is not installed the tooling prints install
instructions and exits non-zero rather than emitting an empty/fake capture.

Until a capture artifact is uploaded/pasted on the Audit page, the audit reports
`RUNTIME` as **Not Covered**.

## Other integration TODOs

These are the steps still left to take the MVP to production:

1. **MCP HTTP proxy.**
   - Boot the MCP server with `GTM_MCP_TRANSPORT=http` (root
     `package.json` → `start:http`).
   - Add a portal-side `POST /api/mcp/call` that forwards `{ tool, args }` to
     the MCP server, injecting the authenticated customer's OAuth token via
     headers.
   - Wire `portalApi.submitForReview` to create a workspace version via MCP
     and store the approval row server-side.

2. **Mixed-source container index.**
   - Implement `portalApi.listContainers` against the canonical
     spreadsheet + Google API merge that Samarth already maintains.

3. **Approval guardrails.**
   - On the backend, reject any MCP `publish` call unless the originating
     approval row is in state `approved`.

4. **Persistence + multi-tenancy.**
   - Replace the in-memory session map with Redis / Postgres for
     multi-instance production deployments.
   - Each customer should only see their own containers and approval rows.

## Deployment notes

The portal now requires a **backend deployment** — static-only is no longer
sufficient because OAuth + GTM API calls all run on the Express server.

### Option A — single Express process (self-hosted, EC2/Render/Fly/etc.)

```bash
# from repo root
npm run portal:install
npm run portal:build
npm --prefix apps/portal start
```

Bundle layout:
- `apps/portal/dist/index.cjs` — Express server (serves API + static files)
- `apps/portal/dist/public/` — built React app

Default port is `5000` (override with `PORT`). Set the OAuth env vars
before starting, and serve over HTTPS in production.

### Option B — Vercel (serverless functions + static site)

The repo ships Vercel-compatible serverless handlers in `apps/portal/api/`.
They reuse the same GTM client and audit logic as the Express routes, but
swap the in-memory session map for a **stateless, encrypted cookie**
(AES-256-GCM, keyed from `PORTAL_SESSION_SECRET`) so the OAuth tokens
survive across cold starts and different function instances.

**Project root in Vercel:** `apps/portal` (the repo is a monorepo and the
portal lives in a subfolder — point Vercel at it via *Project Settings →
General → Root Directory*).

**Project settings:**
- Framework Preset: **Other** (the included `vercel.json` overrides build
  + output)
- Root Directory: `apps/portal`
- Build Command: *inherited from `vercel.json`* → `npm run vercel-build`
- Output Directory: *inherited from `vercel.json`* → `dist/public`
- Install Command: *default* (`npm install`)
- Node.js Version: 22.x, pinned by `engines.node` in `apps/portal/package.json` (this overrides the value under *Project → Settings*)

**Required environment variables (Project → Settings → Environment
Variables):**

| Name | Value |
|------|-------|
| `PORTAL_GOOGLE_OAUTH_CLIENT_ID` | OAuth client id from Google Cloud |
| `PORTAL_GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret |
| `PORTAL_GOOGLE_OAUTH_REDIRECT_URI` | `https://<your-vercel-domain>/api/oauth/callback` |
| `PORTAL_SESSION_SECRET` | 32+ char random hex (generate with `openssl rand -hex 32`) |

Optional: `PORTAL_REVOKE_GOOGLE_ON_DISCONNECT=true` makes "Disconnect Google"
revoke the user's Google grant. Set it only when this OAuth client lives in a
Google Cloud project no other app signs users in with (see Limitations below).

`PORTAL_GOOGLE_OAUTH_REDIRECT_URI` must also be added as an authorized
redirect URI on the Google OAuth client. For preview deployments add the
preview-URL callback too, or pin a stable alias.

**Deploy from the repository root of a fresh clone:**

With the project's Root Directory set to `apps/portal`, run the Vercel CLI
from the repository root, not from `apps/portal`. The CLI joins the folder
you run it in with the Root Directory, so `vercel` (or
`vercel --cwd apps/portal`) inside `apps/portal` looks for
`apps/portal/apps/portal` and stops with "The provided path … does not
exist".

```bash
# one-time
npm i -g vercel
vercel login

# a fresh clone holds only committed files (see the note below)
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git portal-deploy
cd portal-deploy

# link the repository root to the portal project (writes .vercel/ here)
vercel link

# deploy a preview build
vercel

# deploy to production
vercel --prod
```

Use a fresh clone, not your working copy. From the repository root the CLI
uploads every file except its built-in list (`node_modules`, `.git`,
`.vercel`, `.env.local` and a few others) and a `.vercelignore` at the
repository root, which this repo does not have. It does not read
`.gitignore`, so a local `.env`, `.gtm-mcp-tokens.json` or
`apps/portal/data.db` in a working copy would be uploaded.

`apps/portal/.vercelignore` is then applied at build time, not at upload: the
build reads the `.vercelignore` in the Root Directory, while the CLI upload
reads only the one at the top of the folder it uploads.

**Limitations on Vercel:**
- OAuth tokens live in an encrypted cookie on the user's browser, not in a
  server-side store. The browser cannot read or alter them, and the cookie is
  HttpOnly + Secure. Access tokens expire after ~1 hour and are refreshed on
  demand (rotating the cookie).
- Sessions end 30 days after sign-in, enforced on the server; refreshing does
  not extend them. "Disconnect Google" clears the cookie. By default a copy of
  it taken earlier keeps working until its 30 days are up, unless you rotate
  `PORTAL_SESSION_SECRET` or the user removes the app's access in their Google
  account. Rotating `PORTAL_SESSION_SECRET` (or the cookie-format change to
  `v1e`) signs everyone out once.
- Set `PORTAL_REVOKE_GOOGLE_ON_DISCONNECT=true` to also revoke the user's
  Google grant on Disconnect, which ends every copy of the cookie once Google
  confirms. Only do that when `PORTAL_GOOGLE_OAUTH_CLIENT_ID` (with its own
  `PORTAL_GOOGLE_OAUTH_CLIENT_SECRET`) lives in a Google Cloud project that no
  other app signs users in with. Google revokes a grant per user and
  **project**: every OAuth client in that project loses the user's tokens. If
  the MCP server uses a client in the same project, even a different client
  ID, a portal Disconnect signs the user out of the MCP server too, and the
  portal cannot see the MCP server's settings to check. What the portal does
  check:
  - It refuses when `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_CLIENT_ID` or
    `SAMARTH_GOOGLE_OAUTH_CLIENT_ID` in its environment names the same client
    or a client in the same project (client IDs start with the project
    number).
  - It refreshes the session's token with its own client before revoking, so a
    session signed in before you moved the portal to its own client is left
    alone.
  - It revokes only on a same-origin POST, which is what the portal's own
    buttons send.

  Revoking signs the user out of the portal everywhere, including other
  devices, because they all share the grant. "Connect a different Google
  account" disconnects first, so it revokes too. When Google refuses or times
  out, the user is still signed out and the function logs a warning (never the
  token).
- There is **no shared server-side state** — anything currently using the
  in-memory `Map` in `server/gtm/oauth.ts` (the session map and CSRF
  state map) is replaced by cookies in the Vercel handlers: the encrypted
  session cookie and a short-lived signed OAuth-state cookie.
  If you add features that require a shared cache, plug a Redis / Upstash
  store into `apps/portal/server/gtm/vercel-helpers.ts`.
- The SQLite `data.db` used by `server/storage.ts` is **not** writable on
  Vercel. The current `users` table is unused; if/when persistence is
  added, swap it for a hosted Postgres (Neon, Supabase, etc.).
- Function cold starts add ~150-300ms to the first request after idle.
