# Chat Orchestrator

The service that lets the AI Tag Manager website talk to the Samarth GTM MCP server.

## Why this exists

The browser cannot call the MCP server directly, for three independent reasons found in the MCP's
own code:

1. Its HTTP transport sets no CORS headers, so a browser request is blocked and the
   `mcp-session-id` response header is unreadable.
2. Its sessions live in an in-process `Map`, one MCP server instance per session. A stateless,
   horizontally replicated function host has nowhere to keep that.
3. An agentic turn is a loop of model call, tool call, model call, often running 30 to 90 seconds
   with a stream held open. That is the opposite of the serverless execution model.

So this is the only tier the browser reaches. It verifies the user, scopes which tools the model may
see, runs the tool loop, and streams the result back.

```
browser (aitagmanager.com)
    |  HTTPS + Supabase JWT, SSE response
    v
chat-orchestrator   <---- OpenAI (streaming, tool calling)
    |  stdio or internal HTTP
    v
samarth-gtm-mcp  ----> Google GTM API v2 + GA4 APIs
```

## Quick start

```bash
cd apps/chat-orchestrator
npm install
cp .env.example .env
```

Build the MCP server once from the repo root, since this service spawns it:

```bash
npm run build
```

Authorize a Google account for the MCP to act as (single-identity mode, correct for a proof of
concept):

```bash
npm run auth:google
```

Confirm which model ids your OpenAI key can actually use, then set `OPENAI_MODEL` in `.env`:

```bash
npm --prefix apps/chat-orchestrator run models
```

Run it:

```bash
npm --prefix apps/chat-orchestrator run dev
```

On startup it prints the tool inventory it found, which is the fastest way to confirm the MCP link
is live:

```
[orchestrator] MCP connected: 173 tools (52 read, 121 write-gated), 7 prompts
[orchestrator] visible to model: GTM 40, GA4 15 (read-only)
[orchestrator] listening on http://127.0.0.1:8787
```

Send a real turn through it:

```bash
npm --prefix apps/chat-orchestrator run smoke -- "list my GTM accounts"
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness plus the current model, tool count, and whether writes are visible |
| POST | `/v1/chat` | One chat turn. Responds with an SSE stream |
| GET | `/v1/commands` | The MCP server's registered prompts, for slash commands in the UI |
| POST | `/v1/commands/:name` | Expands a prompt into the message text that starts a turn |
| GET | `/v1/logs` | Tail of the process log. Super admin only |
| GET | `/v1/events` | The lifecycle record (starts, stops, task outcomes, health). Super admin only |
| POST | `/v1/events/test-slack` | Sends one test message down the real notification path. Super admin only |
| POST | `/v1/orchestrator/pause`, `/resume` | Refuse chat turns (503 `paused`) without stopping the process. Super admin only |

## Lifecycle events and Slack

Every start, stop, pause, resume, failure, recovery, health change and task outcome is recorded
three ways (`src/events.ts`): a `[event]` line in the log, a row in `orchestrator_events` (written
with the service role key, readable by admins on the website), and, when switched on, a Slack
message in the shape:

```
Orchestrator Stopped
Orchestrator: AI Tag Manager Chat Orchestrator
Time: 25 Aug 2026, 02:15 PM IST
Status: Stopped
Reason: Manual stop
Details: Received SIGINT
Duration: 45 minutes
```

The webhook is stored in **Supabase Vault** and set from the website under **Admin > Orchestrator >
Slack notifications**; this process reads it through an RPC only the service role may call and picks
up a change within a minute, so rotating it needs no shell here and no restart.
`ORCHESTRATOR_SLACK_WEBHOOK_URL` in this host's `.env` still works and takes precedence over the
stored one. Which events post is decided on the same screen, stored in `system_settings`
(`orchestrator.slack`) and re-read every minute. Critical events (an unexpected shutdown, a failed
start) post whenever notifications are on at all; per-tool-call detail posts only under "detailed".

Two rate limits, because they catch different floods. More than 20 messages in 10 minutes are held
with one line saying so, and critical events are exempt from that budget. But the *same* critical
event posts at most 3 times in that window before it too is held with a "has now happened N times"
line: a crash loop restarts every 60 seconds and each attempt is critical, so without that cap one
outage becomes forty pages. A different critical event is never held by either rule.

On this Windows host an external stop is `TerminateProcess`, so the process cannot record its own
stop. The supervisor writes `logs/last-exit.json` and the next run reports it as
*Orchestrator Stopped* (planned, via `npm run restart`) or *Unexpected Shutdown*, followed by
*Orchestrator Recovered*. Uncaught errors are recorded and flushed before the exit that the
supervisor then restarts; the dying process leaves a marker so the next run does not report the
same stop a second time.

`POST /v1/chat` request body:

```json
{
  "messages": [{ "role": "user", "content": "why is my purchase tag not firing?" }],
  "context": { "product": "gtm", "accountId": "123", "containerId": "456", "workspaceId": "7" }
}
```

SSE event types: `ready`, `token`, `tool_call`, `tool_result`, `usage`, `error`, `done`.

## How the website reaches the MCP

Four hops, each with one job:

**1. Browser to orchestrator.** The React chat tab already has a Supabase session, so it sends that
access token and opens an SSE response:

```
POST https://chat.aitagmanager.com/v1/chat
Authorization: Bearer <supabase access token>
{ "messages": [...], "context": { "product": "gtm", "containerId": "456" } }
```

The orchestrator verifies the token offline against Supabase's JWKS, with the algorithm pinned to
the RSA/ECDSA family, `exp` required, and issuer and audience checked. User identity comes from the
verified claims only; anything in the request body is treated as untrusted input.

**2. Orchestrator to Google identity.** It calls the platform's `secure-token-manager` function,
forwarding the *user's own* JWT. That function derives the target user from the verified token and
ignores any id in the body, so a caller can only ever decrypt their own Google token. The
orchestrator never sees the encryption key and never stores a token.

**3. Orchestrator to MCP.** It acquires an MCP child process bound to that user's access token (see
below), lists tools once, scopes them by product and read/write, and hands the schemas to OpenAI.
When the model emits a tool call, the orchestrator executes it through that child.

**4. MCP to Google.** The MCP calls the GTM and GA4 APIs as that user, applies its own guardrails,
paginates, retries reads on quota errors, and returns a structured result. The orchestrator caps
oversized results, marks them incomplete, feeds them back to the model, and streams the answer to
the browser.

## Per-user Google identity

Each user gets their own MCP child process, holding only their own Google access token.

```
user A turn ──> MCP child A (GOOGLE_ACCESS_TOKEN = A's token) ──> A's GTM containers
user B turn ──> MCP child B (GOOGLE_ACCESS_TOKEN = B's token) ──> B's GTM containers
```

**Why a process per user rather than one shared process.** The MCP resolves Google credentials from
its own environment, and its per-request identity path is built around a different identity provider
than this platform uses. More importantly, its identity resolution falls back to the process-global
credentials whenever a request-scoped identity is absent. On a shared process that fallback is a
cross-tenant read waiting to happen. Giving each user a process removes the failure mode instead of
guarding against it: the process running A's tool call has no credential that could reach B's data.

**What is withheld from a per-user child** (`buildChildEnv` in `mcp-client.ts`, asserted by
`identity.test.ts`): `GOOGLE_REFRESH_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, and
`GTM_MCP_TOKEN_FILE`. If the user's token is rejected, the child fails with an auth error, which is
the correct outcome. Guardrail flags and non-credential config still pass through.

**Pooling.** A child is roughly 150-300 MB, so children are reused across turns, evicted after 15
minutes idle, capped at `MCP_POOL_MAX_SESSIONS` (default 25, about 4-7 GB at the ceiling), and
evicted least-recently-used when the cap is hit. A child serving an in-flight turn is never evicted.
Concurrent first requests from one user collapse onto a single spawn.

**Token expiry.** Google access tokens last about an hour, and `secure-token-manager` returns a
token with no expiry attached, so expiry is discovered rather than predicted: when a call fails with
a Google auth error mid-turn, the orchestrator refreshes once, replaces the child, and retries that
one call. A second failure is reported as a real authorization problem rather than retried.

The refresh itself happens here, because `secure-token-manager` exposes only
`store | retrieve | delete | get_token | check_permission` and has no refresh action. The
orchestrator retrieves the user's refresh token, exchanges it at Google's token endpoint with the
website's OAuth client, and writes the new access token back through the same function so the rest
of the product benefits. The refresh token exists in this process only for that exchange: never
logged, never persisted here, never passed into a child. An `invalid_grant` response means the user
revoked access, so it is surfaced as "reconnect your Google account" rather than retried, and a user
who has no stored refresh token at all (the signup path that omitted offline access) gets the same
reconnect prompt.

A cleaner long-term shape is to add a `refresh` action to `secure-token-manager` so the refresh
token never leaves the platform. That is a one-function change on the platform side, and this
provider can then drop its Google exchange.

**Modes.** `GOOGLE_IDENTITY_MODE` selects `supabase` (per-user, the only mode allowed when
`NODE_ENV=production`), `static` (one token for everyone, local testing), or `inherit` (the child
resolves credentials itself, single-identity development). Startup refuses the unsafe combinations:
a non-`supabase` mode in production, `supabase` mode together with disabled JWT verification, and
`supabase` mode without the platform URL and key.

## Design decisions worth knowing

**Tool scoping is the main cost control.** Advertising all 173 tools would cost roughly 25k tokens
of schema on every request. Tools are filtered by product (`ga4_`-prefixed tools are GA4, the rest
are GTM) and by read/write, which takes the visible surface to 40 for GTM and 15 for GA4, about
5.5k and 2.8k tokens. Account and container discovery stay available in both scopes because a GA4
question often needs them.

**Read and write are told apart by the schema, not by a name list.** Every guarded mutation in this
MCP takes a `confirm` argument and no read tool does, so `mcp-client.ts` derives `isWrite` from the
schema itself. There is no list to keep in sync as tools are added.

**Two independent write gates.** `ORCHESTRATOR_ENABLE_WRITE_TOOLS` controls whether the model can
even see write tools. The MCP's own `GTM_MCP_ENABLE_WRITES` family controls whether they execute.
Both default to false, and the MCP's gate stays authoritative: it refuses at call time regardless of
anything decided here.

**Static prompt first, session context last.** The system prompt is split into a fixed half that is
byte-identical for every user on a product and a volatile half carrying the date, the signed-in
user, and the selected ids. That ordering is what makes OpenAI's prompt cache hit; moving the
session context higher would quietly cost most of the cached-input discount.

**Truncation is never silent.** An oversized tool result is cut and labelled INCOMPLETE in text the
model reads, so it cannot present a partial container as the whole one.

**Budgets, not hope.** A turn stops at 12 tool calls or 120 seconds and says so, rather than looping
on a failing tool at full price per iteration.

## Shipping the chat feature: the order to build it

Each step is independently testable, and each one leaves the product working.

**Step 1. Prove the link (done).** `npm run chat:dev` prints the tool inventory; `npm run chat:smoke`
sends a real turn and prints the tool trace. If those work, the hard part is proven.

**Step 2. Per-user identity (done).** Set `GOOGLE_IDENTITY_MODE=supabase` with the platform URL and
anon key. Verify by signing in as two different users and confirming each sees only their own
containers. This is the step that must be right before anyone else uses it.

**Step 3. Put the tab in the website.** Copy the two files in `web-client/`, add the route, set
`VITE_ORCHESTRATOR_URL`, and add the orchestrator origin to the CSP `connect-src` in `vercel.json`.
Details in `web-client/README.md`. At this point the feature is usable and read-only.

**Step 4. Persist conversations.** Add `conversations`, `messages`, and `tool_events` tables with
row-level security, and write to them from the orchestrator. Until this lands, a page refresh loses
the thread, which is the single most obvious gap a user will notice.

**Step 5. Meter usage.** Append idempotent `usage_events` rows keyed by request id, and enforce a
per-plan turn cap server-side. Do this before opening the feature to a free tier, not after: every
free-tier turn is otherwise an uncapped cost.

**Step 6. Add writes behind approval.** Turn on `ORCHESTRATOR_ENABLE_WRITE_TOOLS`, emit an
`approval_required` event instead of executing, render the parsed arguments in an editable card, and
execute only on an explicit user decision. Keep the MCP's publish and delete flags off.

**Step 7. Harden for scale.** Move rate limiting and approval state to Redis (the current limiter is
per-process, which is right for one node and wrong for two), add structured logging with request and
conversation ids, and export the metrics in Section 13 of the feasibility report.

## Not built yet

Steps 4 through 7 above. Also deliberately absent: conversation summarization for long threads,
semantic retrieval over the recipe library, and the corpus pattern lookup. All three are worth
adding once the basics are in production and you can see what people actually ask.
