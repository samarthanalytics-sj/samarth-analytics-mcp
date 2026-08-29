# Samarth GTM MCP Server

[![CI](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/actions/workflows/ci.yml)

A production-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the **Google Tag Manager API v2**, built for Samarth Analytics.

Gives Claude Desktop, Cursor, Claude Code, and any MCP-compatible client full, guarded access to GTM — read workspace contents, create/update tags/triggers/variables, audit implementations, publish versions, and more.

> **New: browser portal with live QC audit.** A white-label, browser-based customer experience lives in [`apps/portal/`](./apps/portal/README.md). Customers sign in with Google OAuth, pick a GTM account/container/workspace, and run a live, read-only QC audit. Publishes still require Samarth approval. See the portal README for OAuth setup; run with `npm run portal:dev`.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Friendly Google Auth Options](#friendly-google-auth-options)
4. [Google Cloud OAuth Setup](#google-cloud-oauth-setup)
5. [Service Account Limitations](#service-account-limitations)
6. [Environment Variables Reference](#environment-variables-reference)
7. [Guardrails](#guardrails)
8. [Available Tools](#available-tools)
9. [Claude Desktop Config](#claude-desktop-config)
10. [Cursor Config](#cursor-config)
11. [Claude Code Config](#claude-code-config)
12. [Cloud Deployment](#cloud-deployment)
13. [Security Notes](#security-notes)
14. [Development](#development)
15. [Releases](#releases)
16. [Troubleshooting](#troubleshooting)

---

## Features

- **Full GTM API v2 surface** — accounts, containers, workspaces, tags, triggers, variables, folders, built-in variables, versions, sync, publish, preview
- **Server-side & advanced GTM coverage** — environments, user permissions, destinations, clients, transformations, zones, custom templates, gtag config, plus container snippet/lookup/combine/move-tag-id and workspace change-diff status
- **GA4 coverage** — GA4 Admin tools (`ga4_*`) plus GA4 Data API reporting (`ga4_run_report`, `ga4_run_realtime_report`) for intent-vs-reality reconciliation. Reads and reporting need only `analytics.readonly`; the GA4 Admin **write** tools are off by default behind `GA4_MCP_ENABLE_WRITES` / `GA4_MCP_ENABLE_DELETES` and additionally need `analytics.edit`
- **Automatic pagination** — every paginated list tool transparently follows `nextPageToken` to return all results, with optional `maxPages`/`pageToken` bounds
- **Retry with exponential backoff + jitter** — transient Google API failures (HTTP 408/429/5xx, network errors) on read requests are retried automatically; mutations are never auto-retried (tunable via `GTM_MCP_RETRY_*`)
- **Two transport modes**: stdio (local, for Claude Desktop/Cursor) and Streamable HTTP (cloud/team)
- **Guardrails by default**: read-only unless explicitly enabled; publish and delete gated separately
- **Dry-run mode**: simulate all writes without touching the API
- **`confirm=true` required** on all write/delete/publish operations
- **Audit tool**: inspects workspace for common GA4/GTM implementation issues
- **Export tool**: full workspace dump as structured JSON
- **Zod schema validation** on all inputs
- **Detailed Google API error messages** surfaced to the MCP client

---

## Quick Start

**You need:** Node.js >= 18, and a Google Cloud OAuth client ID + secret with the **Tag Manager API** enabled ([2-minute setup](#google-cloud-oauth-setup)).

No clone and no build - the package is on npm. Pick a folder to hold your credentials and token file, and work from there:

```bash
mkdir samarth-gtm && cd samarth-gtm
```

**1. Add your OAuth client.** Create a file named `.env` in that folder:

```ini
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

**2. Authorize once.** Opens your browser, then writes `.gtm-mcp-tokens.json` (mode `0600`) into this folder:

```bash
npx -y -p samarth-gtm-mcp samarth-gtm-auth
```

**3. Add it to your MCP client.** Use the **absolute** path to the token file - your client sets its own working directory, so a relative path will not be found:

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "npx",
      "args": ["-y", "samarth-gtm-mcp"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "your-client-secret",
        "GTM_MCP_TOKEN_FILE": "/absolute/path/to/samarth-gtm/.gtm-mcp-tokens.json"
      }
    }
  }
}
```

Restart the client and you are done. The server starts **read-only** - see [Guardrails](#guardrails) to enable writes.

> The client id and secret are needed at runtime to refresh the access token, so they live in the client config. That file now holds a secret - keep it out of version control. If your MCP client lets you set a working directory, point it at the folder from step 1 and the server will read `.env` itself via `dotenv`.

### Check it works

```bash
npx -y samarth-gtm-mcp
```

It should start and wait on stdio (Ctrl+C to exit). For an interactive tool browser, run `npx -y @modelcontextprotocol/inspector npx -y samarth-gtm-mcp`.

### From source (contributors)

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp
npm install
cp .env.example .env     # fill in GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET
npm run build
npm run auth:google      # same browser flow as step 2 above
npm start                # or: npm run inspector
```

Prefer pasting the authorization code by hand? `npm run oauth:setup` still does that.

### Desktop app (Electron)

Prefer a chat UI over wiring up an MCP client? **Samarth Desktop** embeds this
MCP server in-process - multi-account Google sign-in, per-account LLM keys
(OpenAI / Anthropic / Gemini), secrets in the OS keychain. No `.env` and no
`npm run auth:google`: the Google OAuth client and LLM key are entered in the
app on first run.

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp/apps/desktop
npm install    # downloads the Electron binary (~100 MB first time)
npm run dev
```

Full guide - Windows/macOS specifics, first-run setup, building a real `.exe`/`.dmg`
installer, and the `Error: Electron uninstall` fix: [apps/desktop/INSTALL.md](apps/desktop/INSTALL.md).

See [Friendly Google Auth Options](#friendly-google-auth-options) for the three supported setup paths (hosted, local dev, advanced).

---

## Friendly Google Auth Options

Google's Tag Manager API requires an OAuth-enabled Google Cloud project — **somebody has to own one**. There is no anonymous, key-free way to call the GTM API. What this MCP can do is hide that complexity behind a hosted backend, while still giving developers and teams the option to run everything themselves.

There are three supported paths. Pick the one that fits your situation.

### 1. Easiest — Samarth-hosted MCP (recommended for non-developers)

> Status: planned. This section documents the intended UX; the hosted endpoint is owned by Samarth Analytics and announced separately.

If you don't want to manage a Google Cloud project at all:

1. Point your MCP client at the Samarth-hosted endpoint (e.g. `https://mcp.samarthanalytics.com/mcp` via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)).
2. Sign in with Google in the browser when prompted.
3. Done — the hosted server uses the **Samarth-owned, Google-verified OAuth app**. The client secret lives only on the hosted backend; nothing sensitive ever ships to your machine.

Trade-off: you trust the Samarth-hosted backend to broker your Google tokens. It only ever requests the GTM scopes listed below.

### 2. Local developer — self-hosted with your own OAuth client

Best if you're comfortable in Google Cloud Console and want full control.

1. Create an **OAuth 2.0 Client ID** (type: **Desktop app** or **Web application**) in your own Google Cloud project. See [Google Cloud OAuth Setup](#google-cloud-oauth-setup) below for the exact steps.
2. Copy the client ID and secret into `.env`:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/oauth/callback
   ```
   (The legacy `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` names still work.)
3. Run the browser-based onboarding flow:
   ```bash
   npm run auth:google
   ```
   It boots a local callback server, opens the consent screen, and writes tokens to `./.gtm-mcp-tokens.json` (gitignored, `0600`). The token file path is configurable via `GTM_MCP_TOKEN_FILE`.
4. Start the MCP server (`npm start` or via Claude Desktop / Cursor / Claude Code). Tokens are picked up from the file automatically — no need to paste anything into `.env`.

Trade-off: you maintain your own Google Cloud project and re-authorise every 7 days while the OAuth app is in "Testing" mode (or publish + verify it for permanent tokens).

### 3. Advanced / team — Samarth-owned OAuth on your own infra

Best for agencies and teams that want a hosted server with their own auth/IAM in front of it.

1. Deploy the MCP HTTP server (Render, Fly.io, Docker — see [Cloud Deployment](#cloud-deployment)).
2. Set the Samarth-owned (or your team-owned) OAuth client on the **server only**:
   ```env
   SAMARTH_GOOGLE_OAUTH_CLIENT_ID=public-client-id
   SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET=secret-injected-from-secret-manager
   ```
   The secret **must** come from your platform's secret manager (Render Secrets, Fly Secrets, Vault, etc.). It is never committed to this repo and never shipped to client machines.
3. Authenticate `/mcp`: set `GTM_MCP_HTTP_AUTH_TOKEN` for a shared bearer token, or `STYTCH_PROJECT_ID` for per-user OAuth (multi-user mode). The transport refuses to start with neither — see [Security Notes](#security-notes).
4. Users connect with their MCP client and never see Google Cloud Console.

Trade-off: you own the operational burden (Google API quota, OAuth app verification, secret rotation, user provisioning) in exchange for a friendly UX.

### Why we can't ship a "no-setup" client secret

Public OAuth clients distributed in source form (or pre-baked into an installer) are not secure: anyone can extract the secret and impersonate the app, leading to Google revoking it. This repo therefore:

- **Never** hardcodes a client secret.
- Treats `SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET` as runtime-injected on the hosted backend only.
- Defaults the local flow (option 2) to your own OAuth client, which keeps the secret on your machine.

Scopes requested in every path:

```
https://www.googleapis.com/auth/tagmanager.readonly
https://www.googleapis.com/auth/tagmanager.edit.containers
https://www.googleapis.com/auth/tagmanager.edit.containerversions
https://www.googleapis.com/auth/tagmanager.manage.accounts
https://www.googleapis.com/auth/tagmanager.manage.users
https://www.googleapis.com/auth/tagmanager.publish
https://www.googleapis.com/auth/analytics.readonly
https://www.googleapis.com/auth/analytics.edit
https://www.googleapis.com/auth/analytics.manage.users
```

These are the least-privilege scopes needed to cover the server's full tool surface. `analytics.readonly` powers both the **read-only GA4 Admin tools** (`ga4_*_list` / `ga4_*_get`) and the **read-only GA4 Data API reporting tools** (`ga4_run_report`, `ga4_run_realtime_report`). `analytics.edit` powers the **GA4 Admin write tools** (`ga4_create_*` / `ga4_update_*` / `ga4_delete_*` / `ga4_archive_*`), and `analytics.manage.users` the **access-binding** (user-permission) write tools — but those tools do nothing until you also opt in via `GA4_MCP_ENABLE_WRITES` / `GA4_MCP_ENABLE_DELETES` (default off) and pass `confirm=true`; the GA4 Data API stays read-only. Read-only deployments can re-run `npm run auth:google` after removing the `edit.*`, `manage.*`, `publish`, `analytics.edit`, and `analytics.manage.users` scopes from your OAuth consent screen; keep `tagmanager.readonly` and `analytics.readonly` for full read coverage.

---

## Google Cloud OAuth Setup

### Step 1: Enable the GTM API

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select or create a project
3. Navigate to **APIs & Services → Library**
4. Search for **"Tag Manager API"** and click **Enable**
5. Search for **"Google Analytics Admin API"** and click **Enable** (required for the read-only `ga4_*` Admin tools)
6. Search for **"Google Analytics Data API"** and click **Enable** (required for `ga4_run_report` / `ga4_run_realtime_report`)

### Step 2: Create OAuth 2.0 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Choose application type:
   - **Desktop app** — simplest for local stdio use (no redirect URI needed)
   - **Web application** — for the HTTP server (add your redirect URI)
4. Download the JSON or copy the **Client ID** and **Client Secret**
5. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:3001/oauth/callback
   ```

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** (or Internal if you have Google Workspace)
3. Fill in App name, support email
4. Add scopes:
   - `https://www.googleapis.com/auth/tagmanager.readonly`
   - `https://www.googleapis.com/auth/tagmanager.edit.containers`
   - `https://www.googleapis.com/auth/tagmanager.edit.containerversions`
   - `https://www.googleapis.com/auth/tagmanager.manage.accounts`
   - `https://www.googleapis.com/auth/tagmanager.manage.users`
   - `https://www.googleapis.com/auth/tagmanager.publish`
   - `https://www.googleapis.com/auth/analytics.readonly` (read-only GA4 Admin **and** Data API tools)
   - `https://www.googleapis.com/auth/analytics.edit` (GA4 Admin write tools — gated by `GA4_MCP_ENABLE_WRITES`)
   - `https://www.googleapis.com/auth/analytics.manage.users` (GA4 access-binding write tools)
5. Add your Google account as a **test user** (while the app is in "testing" mode)

> **Note**: For personal/agency use, keeping the app in "Testing" mode is fine. You will need to re-authorize every 7 days unless you publish the app or get it verified.

### Step 4: Run OAuth Setup

```bash
npm run auth:google
```

Or, if you prefer the older paste-the-code helper:

```bash
npm run oauth:setup
```

---

## Service Account Limitations

> **Short version**: Service accounts do NOT work with GTM by default. Use OAuth 2.0.

The Google Tag Manager API is a **user-data API** — it manages resources owned by individual Google accounts. Service accounts are not Google users and are not automatically granted access to GTM containers.

### Option A: Add the service account as a GTM user (simplest)

If you still want to use a service account:

1. Get the service account email (e.g., `my-sa@project.iam.gserviceaccount.com`)
2. In GTM, go to **Admin → User Management** at the account or container level
3. Add the service account email with the appropriate role (Read, Edit, Approve, Publish)
4. Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json` in `.env`

**Caveats**: This only works if the GTM container is associated with a Google account, not a Google Workspace that restricts external sharing.

### Option B: Domain-Wide Delegation (Google Workspace only)

For Google Workspace organizations:

1. Create a service account with a JSON key
2. Enable **Domain-Wide Delegation** on the service account in Google Cloud Console
3. In **Google Workspace Admin Console → Security → API Controls → Domain-wide Delegation**:
   - Add the service account client ID
   - Add scopes: `https://www.googleapis.com/auth/tagmanager.edit.containers` (and others as needed)
4. In `.env`, set:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json
   ```
5. The server will impersonate the user automatically if you set a subject in `buildGoogleAuth()`

**Caveats**: Requires a paid Google Workspace account. Only available for your own domain.

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | — | OAuth client ID (preferred). Falls back to `GOOGLE_CLIENT_ID`. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | OAuth client secret (preferred). Falls back to `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_OAUTH_REDIRECT_URI` | `http://localhost:3001/oauth/callback` | OAuth redirect URI. Falls back to `GOOGLE_REDIRECT_URI`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | — | Legacy names, still supported. |
| `SAMARTH_GOOGLE_OAUTH_CLIENT_ID` | — | **Hosted-only.** Samarth-owned public OAuth client. Takes precedence over the self-hosted vars when set. |
| `SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET` | — | **Hosted-only.** Inject from your platform secret manager. Never commit. |
| `GOOGLE_ACCESS_TOKEN` | — | Current OAuth access token. Env vars take precedence over the token file. |
| `GOOGLE_REFRESH_TOKEN` | — | OAuth refresh token (long-lived). Env vars take precedence over the token file. |
| `GTM_MCP_TOKEN_FILE` | `./.gtm-mcp-tokens.json` | Path to the local OAuth token file written by `npm run auth:google` (gitignored). |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | — | Path to service account JSON key (see limitations above) |
| `GTM_MCP_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `GTM_MCP_HTTP_PORT` | `3001` | HTTP server port (http transport only; falls back to `PORT`) |
| `GTM_MCP_HTTP_AUTH_TOKEN` | — | Bearer token gating `/mcp` (http transport). With neither this nor `STYTCH_PROJECT_ID` set, the HTTP transport **refuses to start**. |
| `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Local-dev opt-in to start without auth. Binds loopback only unless `GTM_MCP_HTTP_HOST` overrides. |
| `GTM_MCP_HTTP_HOST` | — | Bind host. Defaults to loopback when unauthenticated, all interfaces when authenticated. |
| `STYTCH_PROJECT_ID` | — | Setting this switches the HTTP transport to **multi-user mode**: each `/mcp` request carries a Stytch JWT resolved to that user's own Google identity. Unset = single-identity mode. Pin `STYTCH_JWT_ISSUER` / `STYTCH_JWT_AUDIENCE` in production (see `.env.example`). |
| `STYTCH_SECRET` | — | Stytch project secret (server-only). Required when `STYTCH_PROJECT_ID` is set — the server exits without it. |
| `STYTCH_PUBLIC_TOKEN` | — | Publishable token powering the `/oauth/authorize` page. Not a secret. |
| `GTM_MCP_PUBLIC_URL` | `http://localhost:<port>` | This server's public origin, advertised in the OAuth Protected Resource Metadata document. |
| `GTM_MCP_ENABLE_WRITES` | `false` | Allow create/update operations |
| `GTM_MCP_ENABLE_PUBLISH` | `false` | Allow publish operations |
| `GTM_MCP_ENABLE_DELETES` | `false` | Allow delete operations |
| `DRY_RUN` | `false` | Simulate all writes without calling the API |
| `GTM_MCP_RETRY_MAX` | `3` | Retry attempts for transient read failures (408/429/5xx, network). `0` disables retries. Mutations are never auto-retried. |
| `GTM_MCP_RETRY_MAX_DELAY_MS` | `30000` | Cap on a single backoff sleep (exponential backoff with jitter) |
| `GTM_MCP_RETRY_TOTAL_TIMEOUT_MS` | `60000` | Cap on total wall time from first request to last retry |

---

## Guardrails

The server enforces three independent guardrails in addition to the `confirm=true` requirement:

| Guardrail | Env Variable | What it gates |
|---|---|---|
| **Write guard** | `GTM_MCP_ENABLE_WRITES=true` | All `create` and `update` operations |
| **Delete guard** | `GTM_MCP_ENABLE_DELETES=true` | All `delete` operations |
| **Publish guard** | `GTM_MCP_ENABLE_PUBLISH=true` | All version publish operations |
| **Dry run** | `DRY_RUN=true` | Simulate without API calls (overrides all) |

**`confirm=true` is always required** on write/delete/publish tools regardless of env settings. This prevents accidental modifications even when guardrails are enabled.

### Recommended Configurations

**Read-only exploration** (default — safe for sharing with team):
```env
GTM_MCP_ENABLE_WRITES=false
GTM_MCP_ENABLE_PUBLISH=false
GTM_MCP_ENABLE_DELETES=false
```

**Development workspace edits** (no publishing):
```env
GTM_MCP_ENABLE_WRITES=true
GTM_MCP_ENABLE_PUBLISH=false
GTM_MCP_ENABLE_DELETES=false
```

**Full access** (use with care):
```env
GTM_MCP_ENABLE_WRITES=true
GTM_MCP_ENABLE_PUBLISH=true
GTM_MCP_ENABLE_DELETES=true
```

---

## Available Tools

### Accounts
| Tool | Description |
|---|---|
| `accounts_list` | List all accessible GTM accounts |
| `accounts_get` | Get a specific account |

### Containers
| Tool | Description |
|---|---|
| `containers_list` | List containers in an account (auto-paginated) |
| `containers_get` | Get a specific container |
| `containers_create` | ✏️ Create a new container |
| `containers_snippet` | Get the GTM installation snippet for a container |
| `containers_lookup` | Look up a container by linked destination/tag ID (e.g. `G-XXXX`) |
| `containers_combine` | ✏️ Combine (merge) another container into this one |
| `containers_move_tag_id` | ✏️ Move a Tag ID out into a new container |

### Destinations
| Tool | Description |
|---|---|
| `destinations_list` | List linked destinations (Google tags / GA4) for a container |
| `destinations_get` | Get a specific destination |
| `destinations_link` | ✏️ Link a destination to a container |

### Workspaces
| Tool | Description |
|---|---|
| `workspaces_list` | List workspaces in a container (auto-paginated) |
| `workspaces_get` | Get a specific workspace |
| `workspaces_create` | ✏️ Create a new workspace |
| `workspace_get_status` | Review the change diff (changed entities + merge conflicts) before versioning |
| `workspace_sync` | ✏️ Sync workspace to latest container version |
| `workspace_resolve_conflict` | ✏️ Resolve a merge conflict |
| `workspace_quick_preview` | Generate a preview link (read-safe) |
| `workspace_create_version_and_publish` | 🚀 Create version + publish in one step |

### Tags
| Tool | Description |
|---|---|
| `tags_list` | List all tags in a workspace |
| `tags_get` | Get a specific tag |
| `tags_create` | ✏️ Create a tag |
| `tags_update` | ✏️ Update a tag |
| `tags_delete` | 🗑️ Delete a tag |

### Triggers
| Tool | Description |
|---|---|
| `triggers_list` | List all triggers |
| `triggers_get` | Get a specific trigger |
| `triggers_create` | ✏️ Create a trigger |
| `triggers_update` | ✏️ Update a trigger |
| `triggers_delete` | 🗑️ Delete a trigger |

### Variables
| Tool | Description |
|---|---|
| `variables_list` | List all user-defined variables |
| `variables_get` | Get a specific variable |
| `variables_create` | ✏️ Create a variable |
| `variables_update` | ✏️ Update a variable |
| `variables_delete` | 🗑️ Delete a variable |

### Folders
| Tool | Description |
|---|---|
| `folders_list` | List all folders |
| `folders_get` | Get a specific folder |
| `folders_entities` | List entities in a folder (auto-paginated) |
| `folders_create` | ✏️ Create a folder |
| `folders_update` | ✏️ Update a folder |
| `folders_delete` | 🗑️ Delete a folder |
| `folders_move_entities` | ✏️ Move entities into a folder |

### Built-In Variables
| Tool | Description |
|---|---|
| `built_in_variables_list` | List enabled built-in variables |
| `built_in_variables_enable` | ✏️ Enable built-in variables |
| `built_in_variables_disable` | 🗑️ Disable built-in variables |
| `built_in_variables_revert` | ✏️ Revert a built-in variable to base version |

### Versions
| Tool | Description |
|---|---|
| `versions_list` | List version headers |
| `versions_get` | Get a version (pass "live" for current live version) |
| `versions_create` | ✏️ Create a checkpoint version from workspace |
| `versions_set_latest` | ✏️ Set a version as latest |
| `versions_publish` | 🚀 Publish a specific version |
| `versions_undelete` | ✏️ Undelete a version |
| `versions_delete` | 🗑️ Delete a version |

### Environments
| Tool | Description |
|---|---|
| `environments_list` | List environments in a container (auto-paginated) |
| `environments_get` | Get a specific environment |
| `environments_create` | ✏️ Create an environment |
| `environments_update` | ✏️ Update an environment |
| `environments_reauthorize` | 🚀 Re-generate the environment authorization token (high-impact) |
| `environments_delete` | 🗑️ Delete an environment |

### User Permissions (account-level)
| Tool | Description |
|---|---|
| `user_permissions_list` | List user permissions for an account (auto-paginated) |
| `user_permissions_get` | Get a specific user permission |
| `user_permissions_create` | ✏️ Grant a user account/container access |
| `user_permissions_update` | ✏️ Update a user's access levels |
| `user_permissions_delete` | 🗑️ Revoke a user's access |

### Server-Side & Advanced Container Resources

These are workspace-scoped resources from GTM API v2. Create/update accept the full
resource as a JSON string (`bodyJson`) since their bodies are deeply nested. Each
supports `*_list` (auto-paginated), `*_get`, `*_create` ✏️, `*_update` ✏️, `*_delete` 🗑️,
and (except `gtag_config`) `*_revert` ✏️.

| Resource | Tools | Notes |
|---|---|---|
| Clients | `clients_*` | Server container request clients |
| Transformations | `transformations_*` | Server container event transformations |
| Zones | `zones_*` | Zone delegation |
| Templates | `templates_*` | Custom / gallery-installed templates |
| Gtag Config | `gtag_config_*` | Google tag (gtag) configuration — no `revert` |

### Analytics & Export
| Tool | Description |
|---|---|
| `audit_container` | Inspect workspace for analytics issues |
| `export_container` | Export workspace as structured JSON |

### GA4 Admin (read-only)

Read-only wrappers over the **Google Analytics Admin API** (v1beta, with a single
v1alpha call for enhanced measurement). These never write, update, or delete GA4
resources and require no `confirm` flag. They power the senior audit framework's
GA4_ADMIN checks (custom dimensions/metrics, data streams & measurement IDs, data
retention, enhanced measurement, key events, Google Ads links).

Requires the `https://www.googleapis.com/auth/analytics.readonly` scope and the
**Google Analytics Admin API** enabled in your Google Cloud project. A 403 mentioning
scope means you should re-run `npm run auth:google`.

| Tool | Description |
|---|---|
| `ga4_account_summaries_list` | List GA4 accounts + their property summaries (best discovery entry point) |
| `ga4_properties_list` | List properties under a parent account (display name, time zone, currency, service level) |
| `ga4_property_get` | Get a single property by ID |
| `ga4_data_streams_list` | List data streams (web/Android/iOS) incl. web **measurement IDs** |
| `ga4_enhanced_measurement_get` | Get enhanced measurement settings for a web data stream (v1alpha) |
| `ga4_custom_dimensions_list` | List custom dimensions (parameter, scope) |
| `ga4_custom_metrics_list` | List custom metrics (parameter, unit, scope) |
| `ga4_data_retention_get` | Get event data-retention settings |
| `ga4_key_events_list` | List key events (formerly "conversion events" — current Admin naming) |
| `ga4_google_ads_links_list` | List Google Ads links (customer ID, auto-tagging/ads-personalization flags) |

Accepts either a bare numeric ID (`123456789`) or the fully-qualified form
(`properties/123456789`, `accounts/123456`) wherever a property/account is required.

**Documented limitations** (not exposed by the GA4 Admin API v1beta, so intentionally
**not** implemented rather than faked):

- Internal-traffic / unwanted-referral **data filters** — no public `dataFilters` collection; configured per data stream.
- **Referral exclusions** — no dedicated Admin API resource.
- **Channel groups** and **audiences** — exist only on the v1alpha surface and are out of scope for this read-only v1beta set.

### GA4 Data API (read-only reporting)

Read-only wrappers over the **Google Analytics Data API** (v1beta). They never
write and require no `confirm` flag. Use them to reconcile *intent vs. reality* —
comparing the events a container is configured to send against the events GA4
actually reports (zero reported activity for a configured event is a red flag).

These use the **same** `https://www.googleapis.com/auth/analytics.readonly` scope
as the GA4 Admin tools, so no extra consent is needed. Enable the **Google
Analytics Data API** in your Google Cloud project.

| Tool | Description |
|---|---|
| `ga4_run_report` | Run a report over a date range (dimensions + metrics, e.g. `eventCount` by `eventName`); supports `limit`, `offset`, and ordering |
| `ga4_run_realtime_report` | Run a Realtime report (events in roughly the last 30 minutes) for live QA |

**Documented gaps** (intentionally not exposed rather than faked): pivot reports,
cohorts, and funnels.

### Pagination

All list tools backed by paginated GTM endpoints (`accounts_*`-scoped containers,
workspaces, tags, triggers, variables, folders, folder entities, environments,
user permissions, clients, transformations, zones, templates, gtag configs)
**auto-follow pagination and return all results by default**. Optional arguments:

- `maxPages` — cap the number of API pages fetched (default 50). If more pages remain,
  the response includes `"truncated": true` and a `nextPageToken`.
- `pageToken` — resume from a previous truncated result.

Non-truncated responses keep the original `{ <key>: [...], count }` shape unchanged.

Two tools differ, because one list key does not describe what they return:

- `folders_entities` returns three parallel collections (`tag`, `trigger`, `variable`, always
  present, empty when the folder has none) plus a `counts` object, and adds `truncated` /
  `nextPageToken` only when the page ceiling was hit.
- `export_container` pages five collections independently, so it takes `maxPages` (applied per
  collection) but no `pageToken`. A short export is marked `incomplete: true` with
  `truncatedCollections`, per-collection `nextPageTokens` and a `warning` — in every format,
  including the default `summary`.

Legend: ✏️ requires `GTM_MCP_ENABLE_WRITES=true` | 🗑️ requires `GTM_MCP_ENABLE_DELETES=true` | 🚀 requires `GTM_MCP_ENABLE_PUBLISH=true`

All ✏️ 🗑️ 🚀 tools also require `confirm: true` in the tool arguments.

---

## Claude Desktop Config

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "npx",
      "args": ["-y", "samarth-gtm-mcp"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "your-client-secret",
        "GTM_MCP_TOKEN_FILE": "/absolute/path/to/samarth-gtm/.gtm-mcp-tokens.json"
      }
    }
  }
}
```

Running from a clone instead? Swap the first two lines for `"command": "node", "args": ["/absolute/path/to/samarth-analytics-mcp/dist/index.js"]` and keep the same `env`.

`GTM_MCP_TOKEN_FILE` must be **absolute**. Claude Desktop launches the server with its own working directory, so a relative path - and any `.env` sitting next to your clone - will not be found.

After editing, restart Claude Desktop.

---

## Cursor Config

In Cursor, go to **Settings -> MCP** and add:

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "npx",
      "args": ["-y", "samarth-gtm-mcp"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "your-client-secret",
        "GTM_MCP_TOKEN_FILE": "/absolute/path/to/samarth-gtm/.gtm-mcp-tokens.json"
      }
    }
  }
}
```

---

## Claude Code Config

One command, from the folder you set up in the [Quick Start](#quick-start):

```bash
claude mcp add samarth-gtm --env GTM_MCP_TOKEN_FILE=$PWD/.gtm-mcp-tokens.json -- npx -y samarth-gtm-mcp
```

Or add it by hand to `.claude/mcp_config.json` in your project root:

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "npx",
      "args": ["-y", "samarth-gtm-mcp"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "your-client-secret",
        "GTM_MCP_TOKEN_FILE": "/absolute/path/to/samarth-gtm/.gtm-mcp-tokens.json"
      }
    }
  }
}
```

The server is read-only until you add `"GTM_MCP_ENABLE_WRITES": "true"` - and every write still needs `confirm=true`. See [Guardrails](#guardrails) before turning it on.

---

## Cloud Deployment

### Transport

For cloud deployments, use `GTM_MCP_TRANSPORT=http`. The server exposes:
- `POST /mcp` — Streamable HTTP MCP endpoint
- `GET /mcp` — SSE stream for existing sessions
- `DELETE /mcp` — Session termination
- `GET /health` — Health check

There is no `/oauth/callback` route on this server. `npm run auth:google` runs its own short-lived listener on `127.0.0.1:3001` for the redirect; an unauthenticated callback on the hosted transport could overwrite the server's stored Google credentials, so it was removed.

### Connecting Remote Clients

Clients that support Streamable HTTP can connect directly to the `/mcp` endpoint. For clients that only support stdio (like Claude Desktop), use [mcp-remote](https://www.npmjs.com/package/mcp-remote) as a proxy:

```json
{
  "mcpServers": {
    "samarth-gtm-remote": {
      "command": "npx",
      "args": ["mcp-remote@next", "https://your-server.com/mcp"]
    }
  }
}
```

### Vercel

> **Limitation**: Vercel Serverless Functions have a 10-second timeout (hobby) / 60-second (pro). Stateful SSE sessions require persistent connections which Vercel does not support well. Use Vercel only for **stateless** MCP interactions. Recommended alternative: Vercel + external session store (Redis/Upstash), or use Render/Fly.io instead.

For Vercel, export the Express app as a serverless handler:
```ts
// api/mcp.ts
export default app; // where app is the Express instance
```

Set env vars in Vercel Dashboard → Settings → Environment Variables.

### Render

1. Create a new **Web Service** in [Render](https://render.com)
2. Connect your GitHub repo
3. Build command: `npm install && npm run build`
4. Start command: `GTM_MCP_TRANSPORT=http node dist/index.js`
5. Add environment variables in Render Dashboard
6. **Important**: Set `RENDER=true` env var and ensure your health check hits `/health`

Render supports persistent long-lived connections — recommended for SSE/streaming.

### Fly.io

```bash
fly launch
fly secrets set GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx GOOGLE_REFRESH_TOKEN=xxx
fly secrets set GTM_MCP_TRANSPORT=http GTM_MCP_HTTP_PORT=3001
fly deploy
```

Fly.io has no request timeout limitations and supports persistent WebSocket/SSE connections. Recommended for production.

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
ENV GTM_MCP_TRANSPORT=http
ENV GTM_MCP_HTTP_PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

---

## Security Notes

1. **Never commit `.env`** — it contains OAuth tokens. `.env` is already in `.gitignore`.

2. **Rotate tokens regularly** — OAuth refresh tokens are long-lived but can be revoked. Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

3. **Minimum scopes** — If you only need read access, revoke write scopes by removing them from the OAuth consent screen and re-authorizing. The server reads fine with `tagmanager.readonly` only.

4. **Cloud deployment**: Store secrets in your platform's secret manager (Render Secrets, Fly.io Secrets, Vercel Env Vars), never in code or Docker images.

5. **HTTP transport**: `/mcp` has two built-in auth modes — `GTM_MCP_HTTP_AUTH_TOKEN` (one shared bearer token, identifies the deployment) and `STYTCH_PROJECT_ID` (per-user OAuth, each request resolved to that user's own Google grant). With neither set the transport refuses to start; `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED=true` overrides that for local development and binds loopback only.

6. **Publish guard**: Keep `GTM_MCP_ENABLE_PUBLISH=false` unless you explicitly intend to publish from an AI client. Publishing incorrect tags to production is the highest-risk operation.

7. **Audit logs**: The server logs all session events to stderr. Pipe to a logging service in production.

---

## Development

```bash
# Install dependencies
npm install

# TypeScript type check (no emit)
npm run typecheck

# Build
npm run build

# Watch mode
npm run build:watch

# Run dev server (stdio, with hot-reload)
npm run dev

# Run HTTP dev server
npm run dev:http

# Tests (run `npm run build` first — some suites test the compiled dist)
npm test

# Smoke test: server boots and answers tools/list
npm run smoke -- --mcp dist/index.js

# Full-surface smoke test: invokes ALL registered tools with a sanitized,
# credential-free env — every handler must respond cleanly (no crash/hang)
npm run smoke:all

# MCP Inspector (interactive tool debugging)
npm run inspector
```

### Project Structure

```
samarth-gtm-mcp/
├── src/
│   ├── index.ts              # Entry point — stdio/HTTP transport setup
│   ├── server.ts             # MCP server factory + tool registration
│   ├── auth/
│   │   └── googleAuth.ts     # OAuth2 / service account auth
│   ├── tools/
│   │   ├── index.ts          # Tool registration aggregator
│   │   ├── accounts.ts       # accounts/list, accounts/get
│   │   ├── containers.ts     # containers/list/get/create
│   │   ├── workspaces.ts     # workspaces + sync/resolve_conflict
│   │   ├── tags.ts           # tags CRUD
│   │   ├── triggers.ts       # triggers CRUD
│   │   ├── variables.ts      # variables CRUD
│   │   ├── folders.ts        # folders CRUD + move_entities
│   │   ├── builtInVariables.ts # enable/disable/revert built-ins
│   │   ├── versions.ts       # versions list/get/create/publish/delete
│   │   ├── publish.ts        # quick_preview, versions_publish, create+publish
│   │   ├── audit.ts          # audit_container analytics checks
│   │   ├── export.ts         # export_container JSON dump
│   │   ├── environments.ts   # environments CRUD + reauthorize
│   │   ├── userPermissions.ts # account-level user permissions
│   │   ├── serverSide.ts     # clients, transformations, zones, templates, gtag config
│   │   ├── ga4Admin.ts       # read-only GA4 Admin tools (ga4_*)
│   │   └── ga4Data.ts        # read-only GA4 Data API reporting
│   ├── utils/
│   │   ├── guardrails.ts     # Guardrail enforcement, error formatting
│   │   ├── gtmClient.ts      # googleapis GTM v2 client factory
│   │   ├── ga4Client.ts      # GA4 Admin/Data client factories
│   │   ├── apiRetry.ts       # retry/backoff config (429/5xx, reads only)
│   │   ├── pagination.ts     # transparent nextPageToken following
│   │   ├── schemas.ts        # shared Zod input schemas
│   │   └── toolResponse.ts   # standard tool result shaping
│   ├── types/
│   │   ├── gtm.ts            # GTM API type definitions
│   │   └── index.ts
│   ├── scripts/
│   │   ├── auth-google.ts    # Browser-based OAuth onboarding (`npm run auth:google`)
│   │   └── oauth-setup.ts    # Interactive OAuth token helper (legacy paste-the-code flow)
│   └── __tests__/
│       ├── guardrails.node.test.mjs  # guardrails + buildPath
│       ├── auth.node.test.mjs        # env/auth resolution + token file paths
│       ├── pagination.node.test.mjs  # paginate/buildListResult
│       ├── ga4Admin.node.test.mjs    # GA4 tool registration (tests compiled dist)
│       └── apiRetry.node.test.mjs    # retry/backoff config (tests compiled dist)
├── scripts/
│   ├── smoke-test.mjs        # health probe: portal endpoints + MCP tools/list
│   └── smoke-all-tools.mjs   # invokes all tools with sanitized env
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Releases

Releases are fully automated via [semantic-release](https://semantic-release.gitbook.io/) and GitHub Actions. Every push to `main` triggers the [`release.yml`](.github/workflows/release.yml) workflow, which:

1. Installs dependencies, type-checks, builds, and runs tests.
2. Inspects commits since the last tag using the [Conventional Commits](https://www.conventionalcommits.org/) spec.
3. Determines the next semantic version (`MAJOR.MINOR.PATCH`).
4. Updates `CHANGELOG.md` and bumps the `version` in `package.json` / `package-lock.json`.
5. Commits those files back to `main` with `chore(release): x.y.z [skip ci]` (the `[skip ci]` marker prevents an infinite release loop).
6. Creates a Git tag (`vX.Y.Z`) and a GitHub Release with auto-generated notes.

The workflow uses the built-in `GITHUB_TOKEN` and requires no additional secrets. `npm publish` is disabled — this package is distributed as a binary via the GitHub repo and releases, not via the npm registry.

### Conventional Commit Examples

Commit messages drive the version bump:

| Commit prefix       | Effect                  | Example                                                    |
| ------------------- | ----------------------- | ---------------------------------------------------------- |
| `fix:`              | Patch release (`x.y.Z`) | `fix: handle empty workspace in audit tool`                |
| `feat:`             | Minor release (`x.Y.0`) | `feat: add bulk tag import tool`                           |
| `perf:`             | Patch release           | `perf: cache GTM client between tool calls`                |
| `docs:` / `chore:` / `refactor:` / `test:` / `style:` / `ci:` / `build:` | No release | `docs: clarify OAuth setup steps` |
| `BREAKING CHANGE:` footer or `!` after type | Major release (`X.0.0`) | see below                            |

#### Breaking change examples

```
feat!: drop support for Node.js 18

BREAKING CHANGE: minimum required Node version is now 20.
```

or:

```
refactor(auth): rename GOOGLE_REFRESH_TOKEN env var

BREAKING CHANGE: GOOGLE_REFRESH_TOKEN is now GTM_GOOGLE_REFRESH_TOKEN.
Update your .env file accordingly.
```

### Dry run locally

To preview what the next release would look like without publishing:

```bash
GITHUB_TOKEN=<a-token-with-no-perms-is-fine-for-dry-run> \
  npx semantic-release --dry-run --no-ci
```

### Manual release skip

To intentionally land a commit without triggering a release, use a non-releasing type (`chore:`, `docs:`, etc.) or append `[skip ci]` to the commit subject.

---

## Troubleshooting

### "The caller does not have permission" (403)

- Your Google account may not have access to this GTM account/container
- Service account not added to GTM — see [Service Account Limitations](#service-account-limitations)
- Check your OAuth scopes on the consent screen

### "invalid_grant" or "Token has been expired or revoked"

- Re-run `npm run auth:google` to refresh the token file
- Or set `GOOGLE_REFRESH_TOKEN` directly in `.env` if you prefer env-managed tokens
- If you're stuck in a loop where Google won't return a `refresh_token`, revoke prior access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run the auth script

### "Write operations are disabled"

- Set `GTM_MCP_ENABLE_WRITES=true` in your `.env`
- Restart the server / Claude Desktop

### Stdio server shows no output

- The stdio server intentionally writes nothing to stdout (stdout is the JSON-RPC channel)
- Diagnostic output goes to stderr — check your terminal or Claude Desktop logs

### Claude Desktop: MCP server not appearing

- Check `claude_desktop_config.json` for JSON syntax errors
- With the npx config, make sure `npx` is on Claude Desktop's PATH (install Node.js system-wide, not only in a version manager shell)
- Ensure `GTM_MCP_TOKEN_FILE` is an **absolute** path and the file exists (run the auth step again if not)
- Running from a clone: the `args` path must be absolute to `dist/index.js`, and `npm run build` must have been run
- Restart Claude Desktop completely (not just refresh)

### TypeScript errors on `googleapis` types

- Run `npm install` to ensure all deps are installed
- The `googleapis` package ships its own types — no `@types/googleapis` needed

---

## TODOs / Known Limitations

- `workspace_resolve_conflict`: The GTM API's resolve_conflict endpoint accepts a full entity body — the exact request body schema is complex. The current implementation passes through the user-supplied JSON; validate it against the entity type before calling.
- `containers_create`: The `usageContext` enum values may differ slightly by GTM region/version. Refer to the [GTM API docs](https://developers.google.com/tag-manager/api/v2/reference/accounts/containers/create) for the latest allowed values.
- **Single-identity HTTP auth is a shared secret**: `GTM_MCP_HTTP_AUTH_TOKEN` gates `/mcp` with one bearer token for every client, so it identifies the deployment, not the caller. For per-user identity, set `STYTCH_PROJECT_ID` to enable multi-user mode — see [Security Notes](#security-notes).
- **HTTP sessions are in-memory**: sessions live in the server process, so horizontal scaling requires sticky sessions. Fine for a single team instance; not yet built for multi-instance load balancing.
- **Single OAuth identity per deployment — single-identity mode only**: without `STYTCH_PROJECT_ID`, all requests share one Google identity and therefore one Google API quota pool. Heavy multi-user load through one deployment will exhaust it; retries with backoff soften this but don't remove the quota ceiling. Multi-user mode sidesteps it — each member uses their own Google grant and quota.

---

*Built for Samarth Analytics by TagDrishti — Swapnil Jaykar*
