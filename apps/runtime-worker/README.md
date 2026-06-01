# Samarth Runtime Capture Worker

A small, **read-only** HTTP service that loads pages in headless Chromium and
returns the runtime signals the portal audit needs to confirm
*intent-vs-reality*:

- visited URLs (requested + final after redirects)
- analytics network hits grouped by vendor (GA4 `/g/collect`, Meta `/tr`,
  Google Ads / Floodlight, TikTok, LinkedIn, **sGTM endpoint candidates**)
- `dataLayer` snapshots (before app scripts run + after settle) and the event
  names / keys observed
- console errors / warnings and uncaught page errors
- timestamps

The artifact it returns (`schema: "samarth.runtime-capture/v2"`) is exactly what
the portal Audit page imports to turn on the **RUNTIME** audit source.

## Why this is a separate service (NOT Vercel)

A real browser cannot run inside a Vercel serverless function (no browser, hard
execution budget). This worker is therefore deployed separately — Render, Fly,
Railway, or any VPS / container host. The portal stays on Vercel and simply
**imports the JSON** this worker (or the CLI) produces.

## Read-only guarantee

The worker **navigates and observes only**. It never submits forms, clicks
through funnels, types, or mutates anything. The optional `actions` field
supports a tiny safe allow-list (`wait`, `scroll`) used to trigger lazy-loaded
tags — nothing else.

## Run locally

```bash
cd apps/runtime-worker
npm install                 # installs optional playwright
npx playwright install chromium
npm start                   # serves on :8080
```

Capture without the server (writes a file you can upload in the portal):

```bash
node cli.mjs --url https://example.com --output runtime-capture.json
# multiple pages + consent defaults:
node cli.mjs \
  --url https://example.com \
  --url https://example.com/checkout \
  --consent ad_storage=denied,analytics_storage=granted \
  --output runtime-capture.json
```

## HTTP API

### `POST /capture`

Request body:

```json
{
  "urls": ["https://example.com", "https://example.com/checkout"],
  "consentState": { "ad_storage": "denied", "analytics_storage": "granted" },
  "actions": [{ "type": "scroll" }, { "type": "wait", "ms": 2000 }],
  "wait": 4000,
  "timeout": 30000
}
```

`consentState`, `actions`, `wait`, `timeout` are optional. Response is the
capture artifact plus a `summary` block. Save the JSON and upload it on the
portal Audit page, or paste it into the "Import runtime capture" box.

### `GET /health`

Returns `{ ok, playwrightAvailable, authRequired, allowlist }`.

## Security (all opt-in via env)

| Env var | Effect |
| --- | --- |
| `RUNTIME_WORKER_TOKEN` | If set, every request must send `Authorization: Bearer <token>`. **Strongly recommended for any internet-exposed deployment.** |
| `RUNTIME_WORKER_ALLOWLIST` | Comma-separated host suffixes the worker may load (e.g. `example.com,shop.example`). When unset, any public http(s) URL is allowed. |
| `RUNTIME_WORKER_MAX_URLS` | Max URLs per request (default 10, hard cap 25). |
| `RUNTIME_WORKER_MAX_WAIT` | Max per-page settle time, ms (default 8000). |
| `RUNTIME_WORKER_TIMEOUT` | Max navigation timeout, ms (default 30000). |
| `PORT` | Listen port (default 8080). |

Private/loopback/link-local addresses (`localhost`, `127.*`, `10.*`,
`192.168.*`, `169.254.*`, `172.16–31.*`, `::1`) are always rejected to reduce
SSRF risk, regardless of the allowlist. **No secrets are committed** — set
tokens only via the host's environment.

## Deploy

A `Dockerfile` is included (based on the official Playwright image, which ships
Chromium + system deps). Examples:

```bash
# Build & run a container anywhere
docker build -t samarth-runtime-worker .
docker run -p 8080:8080 \
  -e RUNTIME_WORKER_TOKEN=replace-me \
  -e RUNTIME_WORKER_ALLOWLIST=example.com \
  samarth-runtime-worker
```

- **Render / Railway / Fly**: point the service at this directory's
  `Dockerfile`. Set `RUNTIME_WORKER_TOKEN` (and ideally `RUNTIME_WORKER_ALLOWLIST`)
  in the dashboard. Expose the port the platform provides via `PORT`.
- **VPS**: `npm ci && npx playwright install --with-deps chromium && npm start`
  behind a reverse proxy that terminates TLS.

Do **not** deploy this to Vercel — it needs a real browser.
