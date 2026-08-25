# Self-hosted deployment

Deploying the chat orchestrator onto your own server. Everything here is CPU-only; nothing in this
stack needs a GPU, because inference happens at OpenAI.

## Running it locally first

Do this before committing a server to it. Same image, none of the production scaffolding:

```bash
cp apps/chat-orchestrator/.env.example apps/chat-orchestrator/.env
# fill in OPENAI_API_KEY, then:
docker compose -f apps/chat-orchestrator/compose.local.yaml up --build
```

Then:

```bash
curl -s http://127.0.0.1:8787/health
```

The local compose differs from production in four ways, all deliberate. There is no nginx and no
certbot, so no certificate is needed to start. The port is published, but bound to `127.0.0.1` only,
so it never reaches your network. `NODE_ENV=development`, which re-enables the single-identity modes
that the production guards refuse. And the pool is capped at 3 sessions, because a laptop is not a
server.

For a first run, leave `GOOGLE_IDENTITY_MODE=inherit` and run `npm run auth:google` at the repo root
to authorize one Google account, then uncomment the token-file volume in `compose.local.yaml`. That
proves the whole chain end to end with your own account before any per-user plumbing is involved.

To point the website's dev server at it, set `VITE_ORCHESTRATOR_URL=http://127.0.0.1:8787` in the
website's `.env.local`. The orchestrator's default `ALLOWED_ORIGINS` already includes
`http://localhost:8080`.

Do not expose this to anything. It is for proving the pipeline works.

## What you are deploying

One container running two processes: the orchestrator (HTTP + SSE) and, per signed-in user, an MCP
child process holding only that user's Google access token. nginx terminates TLS in front of it.
Nothing else is exposed.

```
browser ──HTTPS──> nginx :443 ──> orchestrator :8787 ──> MCP child (per user) ──> Google APIs
                                        │
                                        └──> OpenAI API
```

## Sizing

The variable cost is the MCP child pool: roughly **150-300 MB per concurrently active user**, held
for 15 minutes after their last message.

| Concurrent chat users | `MCP_POOL_MAX_SESSIONS` | Container memory | vCPU |
|---|---|---|---|
| up to 10 | 10 | 4 GB | 2 |
| up to 25 | 25 | 8 GB | 2-4 |
| up to 60 | 60 | 20 GB | 4-8 |

Keep `mem_limit` in `compose.yaml` and `MCP_POOL_MAX_SESSIONS` in `.env` in agreement. If the pool
cap is higher than the memory can hold, the OOM killer enforces the real limit and takes the whole
container with it.

CPU is close to idle: the orchestrator is I/O bound on OpenAI and Google. Disk stays small because
this host stores nothing durable of its own: conversations, memories and the audit trail all live
in Supabase Postgres. Allow 5 GB for images and logs.

## Where to run it

**Memory is the binding constraint, not CPU.** The pool holds one MCP child per active user at
roughly 150-300 MB, for 15 minutes after their last message; the orchestrator itself is I/O bound
on OpenAI and Google and barely touches the processor. That rules out the cheap end of most
platform tiers: 512 MB to 1 GB will OOM at three or four concurrent users, and the OOM killer takes
the whole container with it rather than one session.

| Option | Rough cost at 4 GB | Trade |
|---|---|---|
| Hetzner / DigitalOcean VPS | 6-24 EUR/month | Exactly what this document describes. You patch the OS. |
| Render / Railway | ~25 USD/month | TLS, restarts and deploys handled; skip the nginx and certbot steps. Confirm the request timeout covers a 120s agentic turn, or long answers will be cut off mid-stream. |
| GCP Compute Engine | ~25 USD/month | Same as a VPS, inside the project the OAuth client already lives in. |

A 4 GB VPS with `MCP_POOL_MAX_SESSIONS=10` is the straightforward starting point, and the compose
files here assume it.

## Prerequisites

- Linux host with Docker and the Compose plugin.
- DNS: `chat.aitagmanager.com` A record pointing at the server.
- Ports 80 and 443 reachable from the internet (80 is needed for certificate issuance).
- An OpenAI API key, ideally on its own project with a monthly cap.
- The website's Google OAuth client id and secret, used to refresh expired user tokens. It must be
  the SAME client the website signs users in with. A mismatch is not obvious: sign-in keeps working
  (that is Supabase Auth's own client) and then every token refresh fails an hour later, because a
  refresh token can only be exchanged by the client that issued it.
- The Supabase service-role key. See the note in step 1: without it the audit trail, chat memory
  and usage metering are all off, and all three fail quietly.

## First deploy

**1. Get the code and configure.**

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp/apps/chat-orchestrator
cp .env.example .env
```

Edit `.env`. The values that must change from the example:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=                      # run `npm run models` to see what your key can use
GOOGLE_IDENTITY_MODE=supabase
SUPABASE_FUNCTIONS_URL=https://aujpsdjoomykwklvtcza.supabase.co/functions/v1
SUPABASE_ANON_KEY=                 # the public anon key already in the website bundle
GOOGLE_OAUTH_CLIENT_ID=            # same OAuth client the website signs users in with
GOOGLE_OAUTH_CLIENT_SECRET=
SUPABASE_JWKS_URL=https://aujpsdjoomykwklvtcza.supabase.co/auth/v1/.well-known/jwks.json
SUPABASE_JWT_ISSUER=https://aujpsdjoomykwklvtcza.supabase.co/auth/v1
SUPABASE_SERVICE_ROLE_KEY=   # Project Settings > API > service_role
ALLOWED_ORIGINS=https://aitagmanager.com,https://www.aitagmanager.com
MCP_POOL_MAX_SESSIONS=25
```

**`SUPABASE_SERVICE_ROLE_KEY` is not optional in practice.** Three features read it, and all three
fail SILENTLY without it: the audit trail (what the assistant changed, and who asked), usage
metering (per-plan message counts), and chat memory (preferences carried into future
conversations). Each logs a warning at boot and then simply does nothing, so a deployment missing
it looks healthy while keeping no record of its own writes. Check the banner (below) rather than
assuming.

That key bypasses RLS. Treat it as root: never expose it to a browser, and never put it in the
website bundle.

**Writes.** `ORCHESTRATOR_ENABLE_WRITE_TOOLS=true` is the normal setting now. The approval flow it
used to wait for exists: writes are tiered by where they land (a GTM workspace draft applies
directly; anything live asks first), and deletes are stopped and require the user to type a word.
Setting it false gives a read-only chat that can answer questions and change nothing, which is a
reasonable choice for a first deploy but is no longer the only safe one.

Deletes additionally need `ORCHESTRATOR_ENABLE_DELETE_TOOLS=true`; they are refused without it even
when writes are on. `GTM_MCP_ENABLE_PUBLISH` should stay false: publishing is the one action with
no draft step and no undo.

`chmod 600 .env`. It holds an API key, an OAuth client secret, and the service-role key.

**2. Issue the certificate.** nginx will not start without one, so obtain it first with a temporary
HTTP-only server:

```bash
docker run --rm -p 80:80 \
  -v chat-orchestrator_letsencrypt:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  -d chat.aitagmanager.com --agree-tos -m you@example.com --no-eff-email
```

**3. Start it.**

```bash
cd ../..                                          # repo root: the build needs both apps
docker compose -f apps/chat-orchestrator/compose.yaml up -d --build
docker compose -f apps/chat-orchestrator/compose.yaml logs -f orchestrator
```

Read the banner it prints before going further: every feature that can be silently missing
announces itself there. See **Check the boot banner** below for what it should say and what each
warning means.

**4. Verify from outside.**

```bash
curl -s https://chat.aitagmanager.com/health | jq
```

Expect `googleIdentityMode: "supabase"`, `authRequired: true`, a non-zero `mcpTools`, and
`writeToolsVisible` matching what you set in step 1 (`true` on a normal deploy).

**5. Point the website at it.** In Vercel, set `VITE_ORCHESTRATOR_URL=https://chat.aitagmanager.com`
and redeploy. The CSP already allows that origin. The AI Chat tab stops showing its setup notice.

## Check the boot banner

The first thing to read after starting, because everything that can be silently absent says so
here:

```bash
docker compose logs orchestrator | head -30
```

Expected on a correctly configured host:

```
[orchestrator] lifecycle events ON (orchestrator_events); Slack ON; times in Asia/Kolkata
[orchestrator] Google identity mode: supabase
[orchestrator] MCP connected: 179 tools (53 read, 126 write-gated), 7 prompts
[orchestrator] visible to model: GTM 94, GA4 84 (writes ENABLED, deletes ENABLED)
[orchestrator] audit trail ON (chat_conversations, chat_messages, chat_tool_events)
[orchestrator] chat memory ON (chat_memories: durable preferences applied to future turns)
[orchestrator] usage metering ON (user_plans.current_usage_chat / current_usage_tokens)
```

Any `WARNING` line is a feature that will not work. The three worth knowing:

- `audit trail OFF` / `chat memory OFF` / `usage metering OFF` -- `SUPABASE_SERVICE_ROLE_KEY` is
  missing or wrong.
- `every user shares one Google account` -- `GOOGLE_IDENTITY_MODE` is not `supabase`. Do not put
  that in front of real users.
- `cross-platform allowlist entr(ies) match no registered tool` -- a tool was renamed in the MCP
  server and `integrations.ts` was not updated. That write is withheld while the prompt still
  offers it.

## Certificate renewal

Let's Encrypt certificates last 90 days. Add to root's crontab:

```
0 3 * * * cd /path/to/samarth-analytics-mcp && docker compose -f apps/chat-orchestrator/compose.yaml run --rm certbot renew --quiet --webroot -w /var/www/certbot && docker compose -f apps/chat-orchestrator/compose.yaml exec nginx nginx -s reload
```

## Updating

```bash
git pull
docker compose -f apps/chat-orchestrator/compose.yaml up -d --build
```

`stop_grace_period: 45s` lets in-flight turns finish. Users mid-answer see their stream complete;
users who send during the swap get one failed request and can retry.

## Rollback

Images are rebuilt from git, so rollback is a checkout:

```bash
git checkout <previous-sha>
docker compose -f apps/chat-orchestrator/compose.yaml up -d --build
```

Nothing persists yet, so there is no data to migrate back.

## Operating notes

**Firewall.** Only 80, 443, and your SSH port should be open. The orchestrator is not published to
the host by design; `docker compose ps` showing no host port on it is correct.

**Logs.** `docker compose logs -f orchestrator`. Capped at 20 MB x 5 files. Tokens are never logged.

**Health.** `/health` reports live pool state (`mcpSessions`, `mcpSessionsBusy`). If `mcpSessions`
sits at `MCP_POOL_MAX_SESSIONS` and requests start failing with `mcp_unavailable`, the pool is
saturated: raise the cap and the memory limit together, or add a second host.

**Memory.** `docker stats` is the number to watch. Steady growth with idle users means the sweeper
is not evicting; check `MCP_POOL_IDLE_TTL_MS`.

**Cost.** OpenAI spend is the dominant line and is not capped by anything in this stack yet. Set a
monthly budget limit on the OpenAI project until per-plan metering exists.

## Known gaps at this stage

Deliberate, and listed so nobody discovers them in production:

1. **Rate limiting is per-process.** Correct for one container, wrong the moment you run two.
   Moving it to Redis is the first thing to do before scaling horizontally.
2. **Single host.** No failover, so a host loss is a chat outage. Conversations, memories and the
   audit trail live in Postgres and survive it; only in-flight turns and parked approvals are lost.
3. **OpenAI spend is uncapped by this stack.** Per-plan message limits are enforced, but a single
   expensive conversation is not. Keep a monthly budget limit on the OpenAI project.
4. **Attachments are processed in-process.** A 20 MB upload is decoded and parsed on the same
   container serving chat; several at once compete with turns for CPU.

Previously listed here and now shipped, so do not plan around them: conversation persistence and
resume (`chat_conversations` / `chat_messages`, with history and replay endpoints), and usage
metering with per-plan caps (`user_plans`).
