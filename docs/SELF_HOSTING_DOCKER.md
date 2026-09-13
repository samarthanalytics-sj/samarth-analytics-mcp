# Self-hosting with Docker

Stand up the Samarth stack on your own box - a VPS, or a desktop exposed over
HTTPS with Cloudflare Tunnel. Because the LLM is a hosted API, **no GPU is
needed**: these containers run the Node MCP servers and headless Chromium only.

The stack (see [`docker-compose.yml`](../docker-compose.yml)):

| Service | What it is | Host port | Health |
|---|---|---|---|
| `mcp` | GTM / GA4 / Ads MCP server, Streamable HTTP | `3001` | `GET /health` |
| `web-audit` | Web-audit MCP (crawl, consent audit, verify) | `8081` → 8080 | `GET /health` |
| `runtime-worker` | Read-only headless-Chromium capture worker | `8082` → 8080 | `GET /health` |

Everything ships **read-only by default** - the GTM/GA4 write guardrails stay
off until you deliberately flip them (see [Enabling writes](#enabling-writes)).

---

## 1. Prerequisites

- **Docker Engine + Compose v2** (`docker compose version` ≥ 2.x). On Windows/macOS
  that means Docker Desktop; on Linux, `docker-ce` + the compose plugin.
- ~4 GB RAM free and ~5 GB disk for the images (the Playwright base image is the
  large one). An i5 / 8 GB box handles a small pilot comfortably.
- A **Google Cloud OAuth client** with the Tag Manager API, GA Admin API, and GA
  Data API enabled.

## 2. Get a Google refresh token

Single-identity mode signs every call as one authorized Google account. Mint a
refresh token locally, once:

```bash
npm install
npm run auth:google
```

This opens a browser, completes the OAuth flow, and writes
`./.gtm-mcp-tokens.json`. Copy the `refresh_token` value out of that file - you
will paste it into `.env.docker` next. (Prefer mounting the file instead? See
[Alternative: mount the token file](#alt-token-file).)

## 3. Configure the environment

```bash
cp .env.docker.example .env.docker
```

Fill in `.env.docker`:

- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` - from your OAuth client.
- `GOOGLE_REFRESH_TOKEN` - from step 2.
- `GTM_MCP_HTTP_AUTH_TOKEN` - a strong secret; clients send it as a bearer token.
  Generate one: `openssl rand -hex 32`.
- `WEB_AUDIT_HTTP_AUTH_TOKEN` - same idea for the web-audit server.
- `WEB_AUDIT_ALLOWLIST` / `RUNTIME_WORKER_ALLOWLIST` - comma-separated host
  suffixes each browser service may visit. **Keep these tight.** An empty
  allowlist means OPEN (any host), which you do not want on a public box.

`.env.docker` is gitignored and excluded from the Docker build context - it
holds secrets, so keep it that way.

## 4. Build and run

```bash
docker compose build
docker compose up -d
docker compose ps
```

All three services should read `healthy` within ~30 s. Tail logs with:

```bash
docker compose logs -f mcp
```

## 5. Verify

Health checks (no auth):

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8082/health
```

MCP handshake (auth required - replace `$TOKEN` with `GTM_MCP_HTTP_AUTH_TOKEN`):

```bash
curl -sS http://localhost:3001/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should get a JSON-RPC list of tools back. Point any MCP client (Claude
Desktop/Code via a Streamable HTTP connector, Cursor, or your own portal) at
`http://<host>:3001/mcp` with that bearer token.

---

## Exposing a home/office box: Cloudflare Tunnel {#cloudflare-tunnel}

A residential connection has a dynamic IP and no open inbound ports. Cloudflare
Tunnel gives you a stable HTTPS hostname with **no port forwarding** and hides
your home IP:

1. Create a tunnel and grab its token - Cloudflare's
   [connect-networks guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
2. In the tunnel's public-hostname config, route your hostname to the internal
   service, e.g. `https://mcp.yourdomain.com` → `http://mcp:3001`.
3. Set `CLOUDFLARE_TUNNEL_TOKEN` in `.env.docker` and **uncomment the
   `cloudflared` service** in `docker-compose.yml`.
4. `docker compose up -d cloudflared`.

TLS is terminated by Cloudflare, so you get HTTPS for free - which OAuth
callbacks and browser clients require.

> This box is a great **pilot/demo host**, not your only production host. A
> single machine has no redundancy and residential internet is not an SLA. When
> real customers depend on uptime, the same images lift onto a VPS or cloud
> (Fly/Render/Cloud Run/Fargate) unchanged.

---

## Enabling writes {#enabling-writes}

The server is read-only until you opt in - matching the repo's guardrails.
To allow GTM changes, set in `.env.docker` and recreate the `mcp` service:

```bash
# in .env.docker
GTM_MCP_ENABLE_WRITES=true      # allow create/update
GTM_MCP_ENABLE_PUBLISH=true     # allow publishing versions   (optional)
GTM_MCP_ENABLE_DELETES=true     # allow deletes               (optional)
# GA4 admin writes are a SEPARATE gate and also need the analytics.edit scope:
GA4_MCP_ENABLE_WRITES=true
```

```bash
docker compose up -d mcp
```

Every write still requires `confirm=true` on the call itself - that guardrail is
not env-configurable and stays on.

---

## Operations

```bash
docker compose logs -f                 # all services
docker compose restart web-audit       # restart one
docker compose pull && docker compose up -d   # not used (local images); rebuild instead:
git pull && docker compose build && docker compose up -d   # update to latest code
docker compose down                    # stop and remove containers
```

**Backups.** The only stateful secret is the Google refresh token, which lives
in `.env.docker` (and `.gtm-mcp-tokens.json` if you mint locally). Back those up
securely; there is no database in this stack yet.

### Alternative: mount the token file instead of pasting the refresh token {#alt-token-file}

If you would rather not paste the refresh token into `.env.docker`, mount the
token file into the `mcp` service and point the server at it. Add to the `mcp`
service in `docker-compose.yml`:

```yaml
    volumes:
      - ./.gtm-mcp-tokens.json:/app/.gtm-mcp-tokens.json:ro
    environment:
      GTM_MCP_TOKEN_FILE: /app/.gtm-mcp-tokens.json
```

Then leave `GOOGLE_REFRESH_TOKEN` blank. Env vars take precedence over the file,
so use one or the other.

---

## Security checklist

- [ ] `GTM_MCP_HTTP_AUTH_TOKEN` and `WEB_AUDIT_HTTP_AUTH_TOKEN` are set to strong
      random values - the servers warn and run open without them.
- [ ] `WEB_AUDIT_ALLOWLIST` and `RUNTIME_WORKER_ALLOWLIST` are set (never left
      empty/OPEN on a reachable host).
- [ ] Write guardrails are off unless you intend writes.
- [ ] `.env.docker` and any `*.gtm-mcp-tokens.json` are never committed (already
      gitignored).
- [ ] Public exposure goes through Cloudflare Tunnel (or a TLS reverse proxy) - 
      not a raw port on the internet.
