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

CPU is close to idle: the orchestrator is I/O bound on OpenAI and Google. Disk is small (no
database yet); allow 5 GB for images and logs.

## Prerequisites

- Linux host with Docker and the Compose plugin.
- DNS: `chat.aitagmanager.com` A record pointing at the server.
- Ports 80 and 443 reachable from the internet (80 is needed for certificate issuance).
- An OpenAI API key, ideally on its own project with a monthly cap.
- The website's Google OAuth client id and secret, used to refresh expired user tokens.

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
ALLOWED_ORIGINS=https://aitagmanager.com,https://www.aitagmanager.com
MCP_POOL_MAX_SESSIONS=25
```

Leave `ORCHESTRATOR_ENABLE_WRITE_TOOLS=false` and every `*_ENABLE_WRITES` flag false. The chat is
read-only until the approval flow exists.

`chmod 600 .env`. It holds an API key and an OAuth client secret.

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

A healthy start looks like this. If the tool count is missing, the MCP link is broken:

```
[orchestrator] Google identity mode: supabase
[orchestrator] probing MCP server...
[orchestrator] MCP connected: 173 tools (52 read, 121 write-gated), 7 prompts
[orchestrator] visible to model: GTM 40, GA4 15 (read-only)
[orchestrator] listening on http://0.0.0.0:8787
```

**4. Verify from outside.**

```bash
curl -s https://chat.aitagmanager.com/health | jq
```

Expect `googleIdentityMode: "supabase"`, `authRequired: true`, `writeToolsVisible: false`, and a
non-zero `mcpTools`.

**5. Point the website at it.** In Vercel, set `VITE_ORCHESTRATOR_URL=https://chat.aitagmanager.com`
and redeploy. The CSP already allows that origin. The AI Chat tab stops showing its setup notice.

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

1. **No conversation persistence.** History lives in the browser tab; a refresh loses the thread.
2. **No usage metering or per-plan caps.** Every user can send until the global rate limit stops
   them. On a paid tier that is a margin question; on a free tier it is an uncapped cost.
3. **Rate limiting is per-process.** Correct for one container, wrong the moment you run two. Moving
   it to Redis is the first thing to do before scaling horizontally.
4. **Single host.** No failover. A host loss is a chat outage, not data loss, since nothing is
   stored yet.
