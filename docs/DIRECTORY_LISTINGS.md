# Directory Listings Kit

Ready-to-paste submissions for every major MCP directory. Work through these
top to bottom — the first two move the needle most. Prerequisite for most:
the package must be live on npm (see "npm publish checklist" at the bottom).

## Canonical copy (reuse everywhere)

**One-liner (≤140 chars):**

> Google Tag Manager + read-only GA4 MCP server with safety guardrails — read-only by default, gated writes, audits incl. Consent Mode v2.

**Short paragraph:**

> Production-grade MCP server for the Google Tag Manager API v2 with read-only
> GA4 (Admin + Data API) tooling. 107 tools covering the full GTM surface,
> including server-side containers. Ships read-only: writes, publishes, and
> deletes are each gated behind separate opt-in flags, every mutation requires
> per-call confirmation, and a dry-run mode simulates changes. Includes
> container audits (incl. a Consent Mode v2 engine validated by a 170-case
> suite), full transparent pagination, retry with exponential backoff + jitter,
> and stdio + Streamable HTTP transports. 400+ test assertions; every tool
> smoke-tested.

**Category/tags:** Marketing · Analytics · Google Tag Manager · GA4 · DevTools

---

## 1. Official MCP Registry (registry.modelcontextprotocol.io)

The `server.json` manifest is already at the repo root. After the npm package
is published (the package.json `mcpName` field is already set, which the
registry uses to verify npm ownership):

```bash
# Install the publisher CLI
brew install mcp-publisher   # or download from github.com/modelcontextprotocol/registry releases

# From the repo root:
mcp-publisher login github   # authenticates the io.github.samarthanalytics-sj namespace
mcp-publisher publish
```

Note: `server.json` carries a `version` that should match the npm version on
each release. Until that's automated, bump it manually when publishing.

## 2. awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers)

Fork → add the line below to the **Marketing** section (alphabetical order) →
open a PR. (Stape's server is listed in the same section.)

```markdown
- [samarthanalytics-sj/samarth-gtm-mcp](https://github.com/samarthanalytics-sj/samarth-analytics-mcp) 📇 🏠 - Google Tag Manager + read-only GA4 server with safety guardrails: read-only by default, separately gated writes/publish/deletes, per-call confirmation, dry-run, container audits incl. Consent Mode v2, automatic pagination, and retry with backoff.
```

(Legend: 📇 = TypeScript, 🏠 = local server. Check the repo's current legend
before submitting in case icons changed.)

## 3. mcpservers.org

Submission is a PR to the site's data repo (linked from the site footer —
currently `wong2/awesome-mcp-servers` powers part of it; the site also has a
"Submit" form). Use the one-liner + short paragraph above.

## 4. Glama (glama.ai/mcp/servers)

Glama auto-indexes public GitHub repos that contain MCP servers. To claim and
enrich the listing: sign in with the GitHub org account → claim the server →
paste the short paragraph. Their quality score rewards: license file (✓ MIT),
tests (✓), README with config examples (✓), npm package (after publish).

## 5. Smithery (smithery.ai)

Sign in with GitHub → "Add server" → point at the repo. Smithery wants a
`smithery.yaml`; their onboarding generates one. Use stdio transport with the
`samarth-gtm-mcp` npm package as the entry.

## 6. PulseMCP (pulsemcp.com)

Submit form on the site. Needs: name, GitHub URL, npm package, one-liner,
category (Marketing/Analytics).

## 7. LobeHub (lobehub.com/mcp)

Auto-indexes from GitHub + the official registry — publishing to #1 usually
gets you listed here without action. Verify after a week and claim the page.

## 8. Cursor Directory (cursor.directory/mcp)

Submit form. Emphasize the Cursor config snippet from the README and note the
short server name (`samarth-gtm`) to stay under client name-length limits.

---

## npm publish checklist (one-time)

The repo is already wired for automated publishing — semantic-release runs on
every push to `main` and now has `npmPublish: true`. To make the first publish
work:

1. Create an npm account (or org) and generate a **granular access token**
   with publish rights.
2. Add it as the `NPM_TOKEN` secret in the GitHub repo
   (Settings → Secrets and variables → Actions).
3. Merge any `feat:`/`fix:` commit to `main` — the release workflow
   typechecks, builds, tests, then publishes `samarth-gtm-mcp` to npm with
   provenance attestation automatically.
4. Verify: `npx -y samarth-gtm-mcp` should boot the server (stdio), and
   `npx -y -p samarth-gtm-mcp samarth-gtm-auth` should start the OAuth
   onboarding flow.

After the first publish, update the README Quick Start to lead with the npx
path instead of git clone.
