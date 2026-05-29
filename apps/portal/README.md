# Samarth Analytics — GTM Portal

A browser-based, white-label customer portal that sits on top of the
[Samarth GTM MCP server](../../README.md). Customers connect their Google Tag
Manager account, run audits, and prepare implementation plans. Every change
goes through a **Samarth approval queue** before anything is published to GTM.

> **MVP status.** The portal is a polished frontend with realistic mock data
> and a clean adapter boundary (`client/src/lib/portal-api.ts`). It does not
> yet talk to live Google APIs. The TODOs below describe how to wire it up.

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

## Integration TODOs

These are the concrete steps to take the MVP to production:

1. **Hosted OAuth.**
   - Add `/api/oauth/start` and `/api/oauth/callback` routes to
     `apps/portal/server/routes.ts`.
   - Reuse `googleapis` + `google-auth-library` (already deps of the MCP
     server) to mint refresh tokens.
   - Store refresh tokens encrypted, keyed by `userId`. Never expose tokens
     to the browser.
   - On callback, set `OAuthState.connected = true` and redirect to `/#/containers`.

2. **MCP HTTP proxy.**
   - Boot the MCP server with `GTM_MCP_TRANSPORT=http` (see root
     `package.json` → `start:http`).
   - Add a portal-side `POST /api/mcp/call` that forwards
     `{ tool, args }` to the MCP server, injecting the authenticated
     customer's OAuth token via headers.
   - Replace `portalApi.runAudit` to call `audit_workspace`.
   - Wire `portalApi.submitForReview` to create a workspace version via
     MCP, then store the approval row server-side.

3. **Mixed-source container index.**
   - Implement `portalApi.listContainers` against the canonical
     spreadsheet + Google API merge that Samarth already maintains.
   - The `ContainerRecord` shape in `shared/portal-types.ts` is the contract.

4. **Approval guardrails.**
   - On the backend, *reject* any MCP `publish` call unless the originating
     approval row is in state `approved`.
   - Add Slack/email notification when status flips to `pending_review`.

5. **Persistence.**
   - Swap the in-memory store in `portal-store.tsx` for a small SQLite or
     Postgres table (`approvals`, `change_plans`).

6. **Auth / multi-tenancy.**
   - Add a session model (cookie-based). Each customer sees only their own
     containers and approval rows. Samarth staff have a reviewer role.

7. **Secrets handling.**
   - Add `apps/portal/.env.example` once OAuth client ID/secret keys are wired.
   - Never bundle Google credentials into the client bundle.

## Deployment notes

The portal builds to a static bundle (`apps/portal/dist/public/`) plus a
small Express server (`apps/portal/dist/index.cjs`). Static-only deploy is
possible today because no backend logic is needed for the MVP — the
Express server is kept ready for the integration steps above.

Static deploy:

```bash
npm --prefix apps/portal run build
# deploy apps/portal/dist/public as a static site
```
