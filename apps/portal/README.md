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
| `/api/oauth/logout`                                                              | POST   | Clear the session                    |
| `/api/gtm/accounts`                                                              | GET    | List GTM accounts                    |
| `/api/gtm/accounts/:accountId/containers`                                        | GET    | List containers                      |
| `/api/gtm/accounts/:accountId/containers/:containerId/workspaces`                | GET    | List workspaces                      |
| `/api/gtm/audit`                                                                 | POST   | Run the QC audit on a workspace      |

### Production notes (non-negotiable)

- The OAuth client secret is **only** stored on the portal backend (env var).
  It is never bundled into the client app or committed to the repo.
- Token storage in this MVP is **in-memory** (`apps/portal/server/gtm/oauth.ts`).
  Sessions disappear on process restart and are not shared across instances.
  For production multi-instance, move the session map to Redis or a database.
- All cookies are `HttpOnly` + `SameSite=Lax`, and `Secure` when
  `NODE_ENV=production`. Always serve the production portal over HTTPS.

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
