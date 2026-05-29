# Samarth GTM MCP Server

[![CI](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/samarthanalytics-sj/samarth-analytics-mcp/actions/workflows/ci.yml)

A production-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the **Google Tag Manager API v2**, built for Samarth Analytics.

Gives Claude Desktop, Cursor, Claude Code, and any MCP-compatible client full, guarded access to GTM — read workspace contents, create/update tags/triggers/variables, audit implementations, publish versions, and more.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Google Cloud OAuth Setup](#google-cloud-oauth-setup)
4. [Service Account Limitations](#service-account-limitations)
5. [Environment Variables Reference](#environment-variables-reference)
6. [Guardrails](#guardrails)
7. [Available Tools](#available-tools)
8. [Claude Desktop Config](#claude-desktop-config)
9. [Cursor Config](#cursor-config)
10. [Claude Code Config](#claude-code-config)
11. [Cloud Deployment](#cloud-deployment)
12. [Security Notes](#security-notes)
13. [Development](#development)
14. [Troubleshooting](#troubleshooting)

---

## Features

- **Full GTM API v2 surface** — accounts, containers, workspaces, tags, triggers, variables, folders, built-in variables, versions, sync, publish, preview
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

### Prerequisites

- Node.js ≥ 18
- A Google Cloud project with the **Tag Manager API** enabled
- A Google account with access to your GTM containers

### Install & Build

```bash
git clone <this-repo>
cd samarth-gtm-mcp
npm install
cp .env.example .env
# Edit .env — at minimum add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
npm run build
```

### One-time OAuth Setup

```bash
npx tsx src/scripts/oauth-setup.ts
# Or after build:
node dist/scripts/oauth-setup.js
```

Follow the prompts:
1. Visit the authorization URL in your browser
2. Authorize the GTM scopes
3. Copy the `code` from the redirect URL and paste it back
4. Copy the printed `GOOGLE_ACCESS_TOKEN` and `GOOGLE_REFRESH_TOKEN` into your `.env`

### Verify it works

```bash
# Test stdio server starts (Ctrl+C to exit)
npm start

# Or use the MCP inspector
npm run inspector
```

---

## Google Cloud OAuth Setup

### Step 1: Enable the GTM API

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select or create a project
3. Navigate to **APIs & Services → Library**
4. Search for **"Tag Manager API"** and click **Enable**

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
5. Add your Google account as a **test user** (while the app is in "testing" mode)

> **Note**: For personal/agency use, keeping the app in "Testing" mode is fine. You will need to re-authorize every 7 days unless you publish the app or get it verified.

### Step 4: Run OAuth Setup

```bash
npx tsx src/scripts/oauth-setup.ts
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
| `GOOGLE_CLIENT_ID` | — | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | — | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/oauth/callback` | OAuth redirect URI |
| `GOOGLE_ACCESS_TOKEN` | — | Current OAuth access token |
| `GOOGLE_REFRESH_TOKEN` | — | OAuth refresh token (long-lived) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | — | Path to service account JSON key (see limitations above) |
| `GTM_MCP_TRANSPORT` | `stdio` | Transport: `stdio` or `http` |
| `GTM_MCP_HTTP_PORT` | `3001` | HTTP server port (http transport only) |
| `GTM_MCP_ENABLE_WRITES` | `false` | Allow create/update operations |
| `GTM_MCP_ENABLE_PUBLISH` | `false` | Allow publish operations |
| `GTM_MCP_ENABLE_DELETES` | `false` | Allow delete operations |
| `DRY_RUN` | `false` | Simulate all writes without calling the API |
| `GTM_DEFAULT_ACCOUNT_ID` | — | Optional default accountId |
| `GTM_DEFAULT_CONTAINER_ID` | — | Optional default containerId |
| `GTM_DEFAULT_WORKSPACE_ID` | — | Optional default workspaceId |

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
| `containers_list` | List containers in an account |
| `containers_get` | Get a specific container |
| `containers_create` | ✏️ Create a new container |

### Workspaces
| Tool | Description |
|---|---|
| `workspaces_list` | List workspaces in a container |
| `workspaces_get` | Get a specific workspace |
| `workspaces_create` | ✏️ Create a new workspace |
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
| `folders_entities` | List entities in a folder |
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

### Analytics & Export
| Tool | Description |
|---|---|
| `audit_container` | Inspect workspace for analytics issues |
| `export_container` | Export workspace as structured JSON |

Legend: ✏️ requires `GTM_MCP_ENABLE_WRITES=true` | 🗑️ requires `GTM_MCP_ENABLE_DELETES=true` | 🚀 requires `GTM_MCP_ENABLE_PUBLISH=true`

All ✏️ 🗑️ 🚀 tools also require `confirm: true` in the tool arguments.

---

## Claude Desktop Config

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "node",
      "args": ["/absolute/path/to/samarth-gtm-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token",
        "GTM_MCP_ENABLE_WRITES": "false",
        "GTM_MCP_ENABLE_PUBLISH": "false",
        "GTM_MCP_ENABLE_DELETES": "false"
      }
    }
  }
}
```

**Tip**: Set the env variables in `.env` and remove them from the config to keep credentials out of version control. The server loads `.env` automatically via `dotenv`.

After editing, restart Claude Desktop.

---

## Cursor Config

In Cursor, go to **Settings → MCP** and add:

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "node",
      "args": ["/absolute/path/to/samarth-gtm-mcp/dist/index.js"]
    }
  }
}
```

Make sure your `.env` file is present in the project root so `dotenv` picks it up.

---

## Claude Code Config

Add to `.claude/mcp_config.json` in your project root:

```json
{
  "mcpServers": {
    "samarth-gtm": {
      "command": "node",
      "args": ["/absolute/path/to/samarth-gtm-mcp/dist/index.js"],
      "env": {
        "GTM_MCP_ENABLE_WRITES": "true"
      }
    }
  }
}
```

---

## Cloud Deployment

### Transport

For cloud deployments, use `GTM_MCP_TRANSPORT=http`. The server exposes:
- `POST /mcp` — Streamable HTTP MCP endpoint
- `GET /mcp` — SSE stream for existing sessions
- `DELETE /mcp` — Session termination
- `GET /health` — Health check
- `GET /oauth/callback` — OAuth redirect handler

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

5. **HTTP transport**: If exposed publicly, add authentication middleware (API key header check, IP allowlist, or OAuth proxy). The current HTTP server has no built-in authentication beyond Google token validation for GTM calls.

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

# Tests
npm test

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
│   │   └── export.ts         # export_container JSON dump
│   ├── utils/
│   │   ├── guardrails.ts     # Guardrail enforcement, error formatting
│   │   └── gtmClient.ts      # googleapis GTM v2 client factory
│   ├── types/
│   │   ├── gtm.ts            # GTM API type definitions
│   │   └── index.ts
│   ├── scripts/
│   │   └── oauth-setup.ts    # Interactive OAuth token helper
│   └── __tests__/
│       ├── guardrails.test.ts
│       └── server.test.ts
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Troubleshooting

### "The caller does not have permission" (403)

- Your Google account may not have access to this GTM account/container
- Service account not added to GTM — see [Service Account Limitations](#service-account-limitations)
- Check your OAuth scopes on the consent screen

### "invalid_grant" or "Token has been expired or revoked"

- Re-run `npx tsx src/scripts/oauth-setup.ts` to get a fresh refresh token
- Make sure `GOOGLE_REFRESH_TOKEN` is set correctly in `.env`

### "Write operations are disabled"

- Set `GTM_MCP_ENABLE_WRITES=true` in your `.env`
- Restart the server / Claude Desktop

### Stdio server shows no output

- The stdio server intentionally writes nothing to stdout (stdout is the JSON-RPC channel)
- Diagnostic output goes to stderr — check your terminal or Claude Desktop logs

### Claude Desktop: MCP server not appearing

- Check `claude_desktop_config.json` for JSON syntax errors
- Ensure the path in `args` is an absolute path to `dist/index.js`
- Make sure `npm run build` has been run
- Restart Claude Desktop completely (not just refresh)

### TypeScript errors on `googleapis` types

- Run `npm install` to ensure all deps are installed
- The `googleapis` package ships its own types — no `@types/googleapis` needed

---

## TODOs / Known Limitations

- `workspace_resolve_conflict`: The GTM API's resolve_conflict endpoint accepts a full entity body — the exact request body schema is complex. The current implementation passes through the user-supplied JSON; validate it against the entity type before calling.
- `containers_create`: The `usageContext` enum values may differ slightly by GTM region/version. Refer to the [GTM API docs](https://developers.google.com/tag-manager/api/v2/reference/accounts/containers/create) for the latest allowed values.
- **Pagination**: Large accounts with many tags/triggers/variables may be paginated. The current implementation returns the first page only. Add `pageToken` iteration for full coverage if needed.
- **User Management**: `accounts.user_permissions` endpoints are not yet implemented. Add `user_permissions_list/create/update/delete` if team management is needed.
- **Environments**: GTM Environments API is not yet implemented.
- **Transformation**: GTM Transformations (server-side containers) are not yet implemented.
- **Rate limiting**: No exponential backoff implemented. The googleapis client has basic retry logic but not full quota management.

---

*Built for Samarth Analytics by TagDrishti — Swapnil Jaykar*
