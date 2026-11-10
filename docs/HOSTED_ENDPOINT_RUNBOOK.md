# Hosted endpoint runbook

How to check, restore, roll back and retire the hosted MCP endpoint
(`https://mcp.samarthanalytics.com/mcp`). The endpoint runs on Render as the
web service `samarth-gtm-mcp`, defined in [`render.yaml`](../render.yaml).

This runbook is for the person who operates the endpoint. You need access to
the Render dashboard and to the DNS zone. For per-user sign-in you also need
access to the Stytch dashboard.

Rules for this document and for your own notes:

- A placeholder is written like `<service>`. Replace it with your own value.
- Never paste a secret value into a command, a ticket, a chat or this repo.
  No command in this runbook needs a secret.
- This repo is public. Do not add service ids, dashboard links, IP addresses or
  incident details to this file.

For the first deploy, see [Render in the README](../README.md#render). To run
the same server on your own machine, see
[`SELF_HOSTING_DOCKER.md`](./SELF_HOSTING_DOCKER.md).

---

## 1. How the endpoint is built

```
MCP client (Claude, mcp-remote, ...)
   |
   |  DNS: CNAME  mcp  ->  <service>.onrender.com
   v
Render web service "samarth-gtm-mcp"        (render.yaml, runtime: docker)
   |
   |  Docker image built from ./Dockerfile, runs: node dist/index.js
   v
MCP server, HTTP transport                  (/mcp, /health, /.well-known/*, /oauth/authorize)
   |
   |  per-user mode: Stytch checks the user and holds the user's Google grant
   v
Google APIs                                 (Tag Manager, GA4 Admin, GA4 Data)
```

| Part | Where it is defined | What you see when it is missing or wrong |
|---|---|---|
| DNS record | The DNS zone. Not in this repo. | The name does not resolve. No client can connect. |
| Render web service | [`render.yaml`](../render.yaml) and the Render dashboard | A suspended service answers `503`. |
| Docker image | [`Dockerfile`](../Dockerfile) | The build fails and the deploy does not go live. |
| Server settings | Render dashboard, **Environment** tab | The server does not start, or it starts in the wrong auth mode. |
| Stytch project (per-user mode) | Stytch dashboard | `/health` is fine, but sign-in fails. |
| Google | The user's Google account and its GTM / GA4 access | Sign-in fails, or a tool call returns a Google permission error. |

Why Stytch was chosen is recorded in
[ADR-0001](./adr/0001-hosted-mcp-oauth-authorization-server.md).

## 2. The two auth modes

The server protects `/mcp` in one of two ways. The environment variables decide
which one.

| | Per-user OAuth | Shared token |
|---|---|---|
| Turned on by | `STYTCH_PROJECT_ID` is set | `GTM_MCP_HTTP_AUTH_TOKEN` is set and `STYTCH_PROJECT_ID` is not set |
| Google calls run as | Each user's own Google account | One Google account for every client |
| The client sends | A token it gets from the sign-in flow | `Authorization: Bearer <shared token>` |
| Start-up log line ends with | `authentication: per-user OAuth (Stytch)` | `authentication: shared bearer token` |

- If both variables are set, the server uses per-user mode and ignores the
  shared token.
- If neither is set, the server refuses to start.
- A public endpoint should use per-user mode. Shared-token mode is for a
  private or team endpoint.

## 3. Environment variables on the host

Names only. The values live in the Render dashboard (service → **Environment**).

Both modes:

| Variable | Value | Note |
|---|---|---|
| `GTM_MCP_TRANSPORT` | `http` | Set by `render.yaml`. Without it the image starts in stdio mode and serves no HTTP. |
| `GTM_MCP_ENABLE_WRITES`, `GTM_MCP_ENABLE_PUBLISH`, `GTM_MCP_ENABLE_DELETES` | `false` | Set by `render.yaml`. |
| `GA4_MCP_ENABLE_WRITES`, `GA4_MCP_ENABLE_DELETES` | `false`, or not set | Not in `render.yaml`. Not set means off. |

Per-user mode:

| Variable | Value | Note |
|---|---|---|
| `STYTCH_PROJECT_ID` | The Stytch project id | Turns per-user mode on. |
| `STYTCH_SECRET` | Secret | The server exits at start-up when this is missing. |
| `STYTCH_PUBLIC_TOKEN` | The Stytch public token | Used by the sign-in page at `/oauth/authorize`. Not a secret. |
| `GTM_MCP_PUBLIC_URL` | `https://mcp.samarthanalytics.com` | The public origin only. See below. |

Shared-token mode:

| Variable | Value | Note |
|---|---|---|
| `GTM_MCP_HTTP_AUTH_TOKEN` | Secret | `render.yaml` asks Render to generate it. |
| `GOOGLE_OAUTH_CLIENT_ID` | The Google OAuth client id | |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret | |
| `GOOGLE_REFRESH_TOKEN` | Secret | The one Google account that every client uses. |
| `STYTCH_PROJECT_ID` | Must not be set | If it is set, the server switches to per-user mode. |

Details that matter:

- **`GTM_MCP_PUBLIC_URL` is the origin only**: `https://` and the hostname. Do
  not add `/mcp` or any other path. The server removes a slash at the end, but
  it does not remove a path. When the variable is not set, the server uses
  `http://localhost:<port>`, and sign-in cannot start.
- **A guardrail flag is on only when its value is exactly `true`.** Any other
  value (`1`, `yes`, `TRUE`, empty) keeps it off. On a public host all five
  flags stay off.
- **Never set `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED` on a public host.** It lets
  the server start with no auth at all.
- **Do not set a port or a host.** Render sets `PORT`. The server reads
  `GTM_MCP_HTTP_PORT` first, then `PORT`, then uses `3001`. With one of the two
  auth modes on, the server listens on all interfaces, as Render needs. Leave
  `GTM_MCP_HTTP_HOST` unset.
- In per-user mode, requests to `/mcp` do not use the `GOOGLE_*` variables.
  Stytch holds each user's Google grant.

## 4. Healthy checks

Run these after every deploy, every settings change and every restore. They
need no token. Set the hostname once:

```bash
MCP_HOST=mcp.samarthanalytics.com
```

The expected output below is for this hostname. With another hostname, the
same text shows your hostname.

### Check 1: the server is up and read-only

```bash
curl -sS "https://$MCP_HOST/health"
```

Expected: this JSON on one line. `activeSessions` changes with use.

```json
{"status":"ok","server":"samarth-gtm-mcp","transport":"http","activeSessions":0,"guardrails":{"writesEnabled":false,"publishEnabled":false,"deletesEnabled":false,"ga4WritesEnabled":false,"ga4DeletesEnabled":false,"dryRun":false,"readOnly":true}}
```

`"readOnly":true` means all five write flags are off. If it is `false`, one of
the `...Enabled` fields is `true`. Find that flag in the **Environment** tab and
turn it off.

### Check 2: a request with no token is refused

```bash
curl -sS -i -X POST "https://$MCP_HOST/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"runbook-check","version":"0"}}}'
```

The output has many header lines. Read three things: the status line, the
`www-authenticate` header and the last line (the body).

Expected in per-user mode:

```
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://mcp.samarthanalytics.com/.well-known/oauth-protected-resource"

{"error":"Missing bearer token."}
```

Expected in shared-token mode (there is no `www-authenticate` header):

```
HTTP/2 401

{"error":"Unauthorized. Provide Authorization: Bearer <token>."}
```

> **A `200` here is a security failure.** The endpoint is open to everybody.
> Stop. Suspend the service first, also when no DNS record points at it. Do
> not add the DNS record. Then follow rule 1 in
> [section 10](#10-security-rules).

### Check 3: the protected-resource document

```bash
curl -sS "https://$MCP_HOST/.well-known/oauth-protected-resource"
```

Expected in per-user mode:

```json
{"resource":"https://mcp.samarthanalytics.com","authorization_servers":["https://mcp.samarthanalytics.com"]}
```

In shared-token mode the list is empty: `"authorization_servers":[]`.

In shared-token mode `resource` is `http://localhost:<port>` unless
`GTM_MCP_PUBLIC_URL` is set. That is not a fault in that mode: the server does
not use this value when it checks the shared token.

### Check 4: the authorization-server document

```bash
curl -sS "https://$MCP_HOST/.well-known/oauth-authorization-server"
```

Expected in per-user mode: status `200` and a JSON document. Check these two
fields:

```
"issuer":"https://mcp.samarthanalytics.com"
"authorization_endpoint":"https://mcp.samarthanalytics.com/oauth/authorize"
```

The fields `token_endpoint`, `registration_endpoint` and `jwks_uri` point to
Stytch. That is correct.

In shared-token mode the answer is status `404` with
`{"error":"authorization server not configured"}`. That is correct for that
mode.

### Check 5: the sign-in page is served (per-user mode)

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "https://$MCP_HOST/oauth/authorize/"
```

Expected: the line starts with `200 text/html`. A `404` means the image does
not contain the sign-in page.

### What a wrong result means

| You see | Meaning | Fix |
|---|---|---|
| `localhost` in check 2, 3 or 4 in per-user mode | `GTM_MCP_PUBLIC_URL` is not set | Set it to `https://<host>` and redeploy. |
| `/mcp` inside a URL in check 2, 3 or 4, for example `"resource":"https://<host>/mcp"` | `GTM_MCP_PUBLIC_URL` has `/mcp` at the end | Remove the path. Keep the origin only. |
| Another hostname in check 2, 3 or 4 | `GTM_MCP_PUBLIC_URL` names another host | Set it to the public hostname. |
| Check 2 has no `www-authenticate` header, check 3 has an empty list, check 4 is `404` | The server runs in shared-token mode | For per-user mode, set the three `STYTCH_*` variables. |
| Check 2 is `200` | The server runs with no auth | Stop. See the warning under check 2. |
| `"readOnly":false` in check 1 | A write flag is on | Turn the flag off in the **Environment** tab. |
| `503` and a page named "Service Suspended" | The Render service is suspended | See [section 6](#6-two-ways-the-endpoint-goes-down). |
| `curl: (6) Could not resolve host` | The DNS record is missing | See [section 6](#6-two-ways-the-endpoint-goes-down). |

HTTP/2 shows header names in lower case (`www-authenticate`). A direct HTTP/1.1
connection to the server shows `WWW-Authenticate`. Both are the same header.

## 5. What the checks cannot prove

All five checks can pass while no user can sign in. The checks do not touch
Stytch or Google.

The checks do not prove:

- that the Stytch project accepts the sign-in. The Stytch project stores the
  address of the sign-in page. It must be `https://<host>/oauth/authorize`;
- that `STYTCH_SECRET` and `STYTCH_PUBLIC_TOKEN` are correct. The server
  accepts any text at start-up and uses the values only when a user signs in;
- that Google gives the user access to GTM or GA4;
- that the name resolves for other people. Your resolver and theirs can hold
  different cached answers.

So after every restore, and after every change to a `STYTCH_*` variable or to
`GTM_MCP_PUBLIC_URL`, do these two things by hand:

1. **One real sign-in.** Connect an MCP client to `https://<host>/mcp` and
   sign in with a Google account.
2. **One read-only tool call.** For example `accounts_list`. It must return the
   GTM accounts of the account you signed in with.

Do not use a refused write as proof of read-only mode. Every write tool needs
`confirm=true`, so a write is refused for more than one reason. The proof of
read-only mode is `"readOnly":true` in check 1.

Answers a signed-in client can get from `/mcp` in per-user mode:

| Status | Body says | Meaning |
|---|---|---|
| `401` | `Invalid or expired token.` | The token is not a valid token of this Stytch project. The client must sign in again. |
| `403` | `The signed-in Google account did not grant any scope this server needs ...` | The user did not grant the GTM or GA4 scope at Google. The user must sign in again and accept the scopes. |
| `502` | `Could not resolve your Google identity ...` | Stytch did not return a Google token for this user. Check `STYTCH_SECRET` and the Stytch status. |
| `503` with `Retry-After: 30` | `Authorization server keys are temporarily unavailable ...` | The server cannot fetch the signing keys from Stytch. Wait and retry. |

The real cause of each of these is in the Render logs of the service.

## 6. Two ways the endpoint goes down

There are two separate failures. Both can be true at the same time.

### A. The DNS name does not resolve

```bash
curl -sS "https://$MCP_HOST/health"
```

```
curl: (6) Could not resolve host: mcp.samarthanalytics.com
```

Confirm it with a public resolver:

```bash
curl -sS -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=$MCP_HOST&type=CNAME"
```

`"Status":3` means the name does not exist: the CNAME record is missing.
`"Status":0` with an `Answer` list means the record exists.

### B. The Render service is suspended

Render answers in place of the server:

```
HTTP/2 503
x-render-routing: suspend
```

The body is a small HTML page with the title "Service Suspended".

### Look at the service when DNS is missing

When the name does not resolve, a normal request cannot show you failure B.
Ask Render directly instead. This sends the request for the public hostname to
Render's address, and it does not need the DNS record. In the first line, set
`SERVICE` to the `onrender.com` name of the service.

```bash
SERVICE='<service>.onrender.com'

EDGE=$(curl -sS -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=$SERVICE&type=A" \
  | python3 -c 'import sys,json; print([a["data"] for a in json.load(sys.stdin).get("Answer",[]) if a["type"]==1][0])')

curl -sS -i --resolve "$MCP_HOST:443:$EDGE" "https://$MCP_HOST/health"
```

`$EDGE` must hold one IPv4 address. If it is empty, the lookup failed: run the
lookup alone and read the error. Without `python3`, this gives an address from
your local resolver: `EDGE=$(dig +short A "$SERVICE" | tail -n 1)`.

| Answer | Meaning | Next step |
|---|---|---|
| `200` and the JSON from check 1 | The service is running. Only DNS is missing. | Run checks 2 to 5 the same way, then add the DNS record ([section 8](#8-the-dns-record)). |
| `503` with `x-render-routing: suspend` | The service is suspended. | Follow [section 7](#7-restore-order): check the variables while the service is still suspended, then resume it. Do not add the DNS record yet. |
| `404` with `x-render-routing: no-server`, or a TLS handshake error | Render has no service for this hostname. | Check that the custom domain is still attached to the service (**Settings** → **Custom Domains**). |

To run any check from section 4 this way, add
`--resolve "$MCP_HOST:443:$EDGE"` to its `curl` command.

Two things that look like a problem and are not:

- A request to `https://<service>.onrender.com` itself answers `404` when the
  `onrender.com` address is turned off for the service in Render's settings.
  The answer may carry the header
  `x-render-routing: blocked-render-subdomain`; Render's documents name the
  `404` only. This does not affect the custom hostname. Always test with the
  custom hostname as shown above.
- A Render answer can carry the response header `server: cloudflare`. It does
  not mean that your DNS record is proxied.

## 7. Restore order

Restore the service first. Check it. Then add DNS.

Why: when you add the DNS record while the service is suspended, your own
domain shows Render's "Service Suspended" page to everybody.

1. **Check the variable names** in the **Environment** tab against
   [section 3](#3-environment-variables-on-the-host) while the service is
   still suspended. Check names and the non-secret values only. Do not copy a
   secret anywhere. If `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED` is set, or no auth
   mode is set, follow rule 1 in [section 10](#10-security-rules) in place of
   step 2, then continue with step 3.
2. **Resume the service** in the Render dashboard. If Render starts a new
   deploy, watch the build log until the deploy is live
   (see [section 11](#11-deploys-and-rollback)).
3. **Check the service before DNS exists.** Use the `--resolve` commands from
   [section 6](#6-two-ways-the-endpoint-goes-down) and run checks 1 to 5.
   If check 2 answers `200`, stop here and suspend the service again. Then
   follow rule 1 in [section 10](#10-security-rules).
4. **Add the DNS record** ([section 8](#8-the-dns-record)).
5. **Wait for the name.** After a time without the record, resolvers can keep
   the answer "this name does not exist" for up to 30 minutes.
6. **Check the certificate** ([section 9](#9-the-certificate)).
7. **Run checks 1 to 5 again**, now without `--resolve`.
8. **Do one real sign-in and one read-only tool call**
   ([section 5](#5-what-the-checks-cannot-prove)).
9. **Remove the README note.** If the hosted row of the
   [README](../README.md) carries a "Temporarily unavailable" note, remove it.
   Use a commit with a `docs:` subject, not a plain `git revert`, because the
   release tooling reads a revert commit as a patch release.

Only after step 9 is the restore complete.

## 8. The DNS record

The zone is on Cloudflare. One record:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `mcp` |
| Target | `<service>.onrender.com` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

- **Keep the record on DNS only.** Render's Cloudflare guide asks for DNS only,
  so that Render can verify the domain and issue the certificate. The guide
  allows the proxy after the certificate is issued. This runbook still keeps
  DNS only: a proxied record puts Cloudflare's proxy in front of the MCP event
  stream (`GET /mcp`), which stays open for a long time, and this service has
  not been tested behind the proxy.
- **Do not add an `AAAA` record for this name.** Render's guide says to remove
  `AAAA` records.
- **If the zone has `CAA` records**, they must allow `letsencrypt.org` and
  `pki.goog`. Render gets its certificates from these two authorities.
- **The 30 minutes in section 7** come from the zone. The last number of the
  SOA record is the time a resolver may keep a "does not exist" answer:
  `dig +short SOA samarthanalytics.com` ends with `1800` (seconds).

The custom domain must also exist on the Render side: service → **Settings** →
**Custom Domains**. After the record is in place, that page shows the domain
as verified and the certificate as issued. If it does not, select **Verify**
there.

## 9. The certificate

Render issues the certificate for the custom domain and renews it before it
expires. You do nothing while the CNAME record is in place.

Render verifies the domain through the DNS record before it issues a
certificate. Render's documents do not say what happens to a renewal while the
record is missing. So after a long time without the record, do not assume that
the certificate is still valid. Check its dates with the commands below. If it
is expired, clients fail with a certificate error until Render has issued a
new one. In that case add the record, select **Verify** under
**Custom Domains**, and wait for the certificate before you tell users that
the endpoint is back.

Read the dates of the certificate:

```bash
echo | openssl s_client -connect "$MCP_HOST:443" -servername "$MCP_HOST" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate
```

Before the DNS record exists, read the certificate that Render holds for the
hostname. Set `$EDGE` as in [section 6](#6-two-ways-the-endpoint-goes-down):

```bash
echo | openssl s_client -connect "$EDGE:443" -servername "$MCP_HOST" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate
```

`notAfter=` is the last valid day. `subject=` must name the public hostname.

## 10. Security rules

These must be true at all times. Check them after every deploy and every
settings change.

1. **No token, no access.** Check 2 answers `401`. A `200` means the endpoint
   is open. An open endpoint that answers through Render also means
   `GTM_MCP_HTTP_HOST` is set to a non-loopback value: with no auth mode the
   server binds `127.0.0.1` unless that variable says otherwise, and Render
   cannot reach a loopback address. The start-up logs then show
   `WARNING: SERVING UNAUTHENTICATED ON <host>`. That host value is fine once
   an auth mode is set, so the steps below leave it alone
   ([section 3](#3-environment-variables-on-the-host) still says to leave it
   unset, so you can remove it in a later deploy). Suspend the service first. Removing the DNS record does not close
   the endpoint: Render still answers for the hostname
   ([section 6](#6-two-ways-the-endpoint-goes-down)) and, unless that address
   is turned off, for the `onrender.com` name. Then do the next four steps in
   this order. Set the auth mode before you remove the flag, because with no
   auth mode and without `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED` the server
   refuses to start.
   1. Set one auth mode in the **Environment** tab: `GTM_MCP_HTTP_AUTH_TOKEN`,
      or the `STYTCH_*` variables
      ([section 3](#3-environment-variables-on-the-host)).
   2. Remove `GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED`. Save the changes with
      **Save and deploy**, not **Save only**. Render's documents say that
      after **Save only** the service does not use the new values until its
      next deploy. They do not say what a suspended service does with a
      saved change.
   3. Resume the service. In the service logs, find the newest start-up line
      from [section 2](#2-the-two-auth-modes). It must end with
      `authentication: shared bearer token` or
      `authentication: per-user OAuth (Stytch)`, not `authentication: NONE`.
   4. Run check 2 with the `--resolve` command from
      [section 6](#6-two-ways-the-endpoint-goes-down). It must answer `401`.
      If it still answers `200`, suspend the service again. The running
      instance has no auth mode: it does not use the new values yet, or the
      values are wrong. If the DNS record is missing, add it only after
      check 2 answers `401`.
2. **`GTM_MCP_HTTP_ALLOW_UNAUTHENTICATED` is never set** on a public host.
3. **The endpoint is read-only.** Check 1 shows `"readOnly":true`. The five
   flags `GTM_MCP_ENABLE_WRITES`, `GTM_MCP_ENABLE_PUBLISH`,
   `GTM_MCP_ENABLE_DELETES`, `GA4_MCP_ENABLE_WRITES` and
   `GA4_MCP_ENABLE_DELETES` stay off. A private host that needs writes is a
   separate deployment (see
   [Enabling writes](./SELF_HOSTING_DOCKER.md#enabling-writes)).
4. **Secrets live only in the Render dashboard.** `STYTCH_SECRET`,
   `GTM_MCP_HTTP_AUTH_TOKEN`, `GOOGLE_OAUTH_CLIENT_SECRET` and
   `GOOGLE_REFRESH_TOKEN` are never written to `render.yaml`, this repo, a
   ticket or a chat.
5. **`GTM_MCP_PUBLIC_URL` is the `https://` origin of the public hostname.**
   Checks 3 and 4 show it.
6. **The server has no `/oauth/callback` route.** Do not add a proxy rule or a
   redirect for that path.
7. **`STYTCH_DEBUG_CLAIMS` is not set.** It is for first set-up only and
   writes the decoded claims of user tokens to the logs.

## 11. Deploys and rollback

How a deploy happens:

- `render.yaml` has `autoDeployTrigger: commit` (the current name for the
  deprecated `autoDeploy: true`). Every new commit on the deployed branch
  starts a deploy. `render.yaml` has no `branch` key, so the deployed
  branch is the one that was selected when the Blueprint was created.
- Render builds the Docker image from [`Dockerfile`](../Dockerfile) on every
  deploy.
- The `docker` job in `.github/workflows/ci.yml` builds this image on every
  pull request to `main` and every push to `main`. It starts the image and
  checks three things: `/health` reports read-only, a request without a token
  gets `401`, and an `initialize` request with the token gets `200` with
  `serverInfo` in the answer. The job is not a required check, and it does
  not run on Render. So after a change to
  `Dockerfile`, to `package-lock.json` or to `apps/mcp-authorize/`, still
  **watch the Render build log.**
- Render calls `/health` on the new instance. The deploy goes live only when
  the answer is `2xx` or `3xx` within five seconds. If the new instance does
  not become healthy within 15 minutes, Render cancels the deploy and the old
  instance keeps serving.

After each deploy, run the checks in [section 4](#4-healthy-checks).

Rollback:

1. In the Render dashboard open the service, then **Deploys**.
2. Find the last deploy that worked and select **Rollback**.
3. Run the checks in [section 4](#4-healthy-checks), then do the sign-in and
   the tool call from [section 5](#5-what-the-checks-cannot-prove).

A rollback in the dashboard has two side effects:

- **Render turns auto-deploy off.** Turn it on again in the service settings
  (**Auto-Deploy**) after the fix is merged. Until then, new commits are not
  deployed.
- **The rolled-back instance runs with the environment variables of that
  deploy.** The **Environment** tab still shows the current values, and the
  next normal deploy uses them again. Do not rely on the tab after a rollback:
  run checks 1 and 2 from [section 4](#4-healthy-checks).

If Render cannot be used at all, run the same image on your own machine with
[`docker-compose.yml`](../docker-compose.yml) and
[`SELF_HOSTING_DOCKER.md`](./SELF_HOSTING_DOCKER.md). That guide sets up
shared-token mode and reaches the machine through a
[Cloudflare Tunnel](./SELF_HOSTING_DOCKER.md#cloudflare-tunnel). That guide
does not cover per-user mode. Per-user mode needs the variables from
[section 3](#3-environment-variables-on-the-host) in `.env.docker` and the same
public hostname. This path has not been tested.

## 12. Retiring the endpoint

Remove the DNS record first, or together with the Render change. Never leave
it for later.

Why: a CNAME record that points to an `onrender.com` name which no service
owns any more is dangerous. Another Render customer may be able to claim that
name or add your hostname to their own service. Their content then appears on
your domain.

Order:

1. **Delete the CNAME record** `mcp` in the DNS zone.
2. **Remove the custom domain** from the service (**Settings** →
   **Custom Domains**).
3. **Suspend or delete the service.**
4. **Make the secrets useless.** Rotate `STYTCH_SECRET` in Stytch. For
   shared-token mode, also revoke the Google refresh token (in the Google
   account, under third-party access) and remove `GTM_MCP_HTTP_AUTH_TOKEN`
   from the service.
5. **Remove the public address** from the places that publish it: the hosted
   row at the top of the [README](../README.md) and any directory listing.

Suspending the service is not retiring it. A suspended service with the DNS
record still in place shows the "Service Suspended" page on your domain
(see [section 6](#6-two-ways-the-endpoint-goes-down)).
