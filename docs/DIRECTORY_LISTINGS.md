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
> container audits (incl. a Consent Mode v2 engine validated by a 188-case
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

Note: `server.json` carries the npm version in two places (the top-level
`version` and the `version` of the npm package entry). The release keeps both
in step. When semantic-release runs `npm version`, the `version` script in
`package.json` runs `scripts/sync-server-json.mjs`, and the release commit
includes `server.json`. Do not edit these numbers by hand.

Publishing to the MCP Registry is still a manual step for the repo owner: run
`mcp-publisher login github`, then `mcp-publisher publish` (the commands
above). This only works for a version that exists on npm, so run it after the
release has reached npm.

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

Publishing is automated. semantic-release runs on every push to `main`
(`.github/workflows/release.yml`) and has `npmPublish: true`. It publishes
with npm Trusted Publishing (OIDC) from GitHub Actions. No `NPM_TOKEN` secret
is used, so do not create an npm token. npm generates a provenance
attestation by default for a trusted publish of a public package from a
public repository, and `publishConfig.provenance` in `package.json` asks for
it too.

The setup is one Trusted Publisher entry on npmjs.com:

1. On npmjs.com, open the package `samarth-gtm-mcp`, then **Settings**, then
   **Trusted publishing**
   (<https://www.npmjs.com/package/samarth-gtm-mcp/access>).
2. Add an entry with exactly these values:

   | Field | Value |
   | --- | --- |
   | Publisher | GitHub Actions |
   | Organization or user | `samarthanalytics-sj` |
   | Repository | `samarth-analytics-mcp` |
   | Workflow filename | `release.yml` |
   | Environment name | leave empty |
   | Allowed actions | allow `npm publish`; leave `npm dist-tag` off |

3. Merge a `feat:` or `fix:` commit to `main` soon after (see the 2-day limit
   below). If `main` already holds unreleased `feat:` or `fix:` commits,
   re-running the failed Release run on the head of `main` is enough (GitHub
   allows a re-run for 30 days; after that a new push to `main` is needed).
   The release workflow typechecks, builds, tests, then publishes
   `samarth-gtm-mcp` to npm with a provenance attestation.
4. Verify: `npx -y samarth-gtm-mcp` should boot the server (stdio), and
   `npx -y -p samarth-gtm-mcp samarth-gtm-auth` should start the OAuth
   onboarding flow.

Open to-do, not part of this setup: the first command in the README Quick
Start is still `git clone`. Decide whether it should lead with the npx path.

### Limits of the Trusted Publisher entry

Source: <https://docs.npmjs.com/trusted-publishers>,
<https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/>
and
<https://github.blog/changelog/2026-10-02-unvalidated-npm-trusted-publishing-configurations-now-expire/>
(checked 2026-11-10).

- **Direct `npm publish` must be allowed.** An entry created after 2026-09-03
  allows only staged publishing unless `npm publish` is allowed too. Without
  it the release would then fail at the publish step, after the git tag is
  pushed. This is reasoned from the release order (tag first, publish
  second); no such run was observed.
- **The main fields cannot be changed.** npm fixes the provider, Organization
  or user, Repository and Workflow filename when the entry is created. To
  change one of them, delete the entry and create a new one (this starts a
  new 2-day window). npm's documentation speaks of enabling an allowed action
  (`npm dist-tag`) on an entry that a workflow already uses. So if only the
  `npm publish` action is wrong, try to change it on the entry first. This
  was not tried on npmjs.com.
- **A new entry expires.** Since 2026-10-02 a new entry expires unless its
  first successful publish happens within 2 days. Create the entry only when
  a release can follow soon.
- **The match can break.** The values must match exactly (npm: all fields are
  case-sensitive), so the entry stops matching if `release.yml` is renamed.
  npm does not say what the next cases do (it says only that the first
  successful publish binds the entry to the repository's immutable
  identity), so treat them as likely, not certain: the entry will probably
  stop matching if the repository is renamed or transferred or if the owner
  name changes, and it may stop matching if the `release` job gets an
  `environment:` while Environment name is empty. If a release then fails
  with the OIDC error below, delete the entry and create a new one. After a
  rename also update `repository.url` in `package.json`; npm requires it to
  match the GitHub repository.

### If the release fails

- When the OIDC token exchange fails, the semantic-release log shows a line
  such as `404 OIDC token exchange error - package not found` (seen in
  Release runs 1028 and 1029; npm does not document which message a
  missing, mismatched or expired entry gives), followed by `ENONPMTOKEN`.
  That line is the cause. `ENONPMTOKEN` only follows from it, and its text
  asks for an `NPM_TOKEN`. Adding a token is not the fix. Check that the
  entry exists, that it has not expired (see "A new entry expires" above;
  npm keeps expired entries visible in the settings), and that every value
  matches the table above. If it has expired or a main field is wrong,
  delete the entry, create a new one, and start a release within 2 days
  (step 3).
- Do not run `npm publish` by hand and do not reuse a version number. npm
  never allows a version to be published twice.
