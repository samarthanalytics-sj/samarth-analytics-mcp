# Talk to Google Tag Manager

### A 10-minute setup guide for Samarth GTM MCP

Stop clicking through GTM. Connect Claude (Desktop, Code, or Cursor) directly to your containers and ask questions in plain English — with guardrails that make it safe for client work.

---

## What you're setting up

**Samarth GTM MCP** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP-compatible AI client guarded access to the Google Tag Manager API v2 and read-only GA4.

- **107 tools** — tags, triggers, variables, versions, server-side containers, zones, templates, GA4 Admin + reporting
- **Read-only by default** — writes, publishes, and deletes are each behind separate opt-in flags
- **Every mutation requires `confirm: true`** — the AI can't change anything by accident
- **Built-in audits** — including a Consent Mode v2 engine backed by a 170-case test suite

---

## Prerequisites

- **Node.js 18+**
- A **Google Cloud project** with the Tag Manager API enabled
- A Google account with access to your GTM containers
- An MCP client: Claude Desktop, Claude Code, or Cursor

---

## Step 1 — Install & build

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp
npm install
cp .env.example .env
npm run build
```

Create an **OAuth 2.0 Client ID** (type: Desktop app) in Google Cloud Console, then add it to `.env`:

```env
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
```

---

## Step 2 — Authorize with Google (once)

```bash
npm run auth:google
```

This opens your browser, walks you through Google consent, and saves tokens to a local, gitignored file. No copy-pasting tokens. Re-run it any time access expires.

---

## Step 3 — Connect your AI client

**Claude Desktop** — edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/` · Windows: `%APPDATA%\Claude\`):

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

Keep credentials in `.env` (loaded automatically) rather than in the config file. Restart Claude Desktop and you're connected. The same JSON works for **Cursor** (Settings → MCP) and **Claude Code** (`.claude/mcp_config.json`).

---

## Step 4 — Your first prompts

Try these, in order:

1. **"List my GTM accounts and containers."**
   Confirms the connection works.

2. **"Audit container GTM-XXXXXXX for common GA4 implementation issues."**
   The built-in audit inspects the whole workspace in one pass.

3. **"Show me every tag that fires on All Pages, with its triggers and variables."**
   What used to be 40 clicks is now one sentence.

4. **"Export this workspace as JSON."**
   Full structured dump — perfect for documentation or diffing.

5. **"Compare what GA4 is actually collecting against what's configured in GTM."**
   Uses the read-only GA4 reporting tools for intent-vs-reality reconciliation.

---

## The guardrails (read this before client work)

The server ships **read-only**. Nothing can be written, published, or deleted until you explicitly opt in — and each capability has its own flag:

```env
GTM_MCP_ENABLE_WRITES=false    # create/update tags, triggers, variables…
GTM_MCP_ENABLE_PUBLISH=false   # publish container versions
GTM_MCP_ENABLE_DELETES=false   # destructive deletes
DRY_RUN=false                  # simulate writes without calling the API
```

Even with a flag enabled, **every mutation requires `confirm: true` on the individual call** — so the workflow is always: AI proposes, you approve.

Recommended posture for agencies: leave everything `false`, do your reading/auditing with AI, and make changes in the GTM UI — or enable writes with `DRY_RUN=true` first to preview exactly what would change.

---

## Built for real workloads

- **Automatic pagination** — list tools follow every page transparently, with safety bounds
- **Retry with exponential backoff + jitter** on rate limits and transient errors (reads only — mutations never auto-retry)
- **Two transports** — stdio for local clients, Streamable HTTP for team/cloud deployments
- **Zod validation** on every input; detailed Google API errors surfaced to the client

---

## Links

- **GitHub:** https://github.com/samarthanalytics-sj/samarth-analytics-mcp (MIT license)
- **MCP:** https://modelcontextprotocol.io
- **Questions?** Open an issue or connect with us — Samarth Analytics
