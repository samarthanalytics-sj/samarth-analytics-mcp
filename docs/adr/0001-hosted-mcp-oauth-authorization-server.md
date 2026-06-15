# ADR-0001: Authorization Server for the multi-user hosted MCP endpoint

**Status:** Accepted
**Date:** 2026-06-15
**Deciders:** Samarth Analytics (product owner)
**Decision:** Option B (managed) — **Stytch Connected Apps** as the Authorization Server.

## Context

The hosted MCP endpoint (`https://mcp.samarthanalytics.com`, Render, Docker)
currently authenticates as a **single Google identity** via one
`GOOGLE_REFRESH_TOKEN`, gated by a shared bearer token
(`GTM_MCP_HTTP_AUTH_TOKEN`). We want the Stape-parity model instead: **many
users, each signing in with their own Google account** in their MCP client, the
server acting on each user's own GTM/GA4 permissions.

Per the MCP Authorization spec, this makes our server an OAuth 2.0 **Resource
Server** that must be fronted by an OAuth 2.1 **Authorization Server (AS)**,
which brokers to **Google as the upstream identity provider**. The MCP spec
requires the AS to implement Dynamic Client Registration (DCR, RFC 7591),
Protected Resource Metadata (RFC 9728), Resource Indicators (RFC 8707), PKCE,
and the discovery `/.well-known/*` endpoints. MCP clients like `mcp-remote`
drive this flow automatically.

Forces at play:
- **Small team, security-critical.** The AS issues and validates tokens that
  guard access to customers' GTM/GA4 — a high-value attack surface.
- **Time to market.** This is the last feature blocking the competitive parity
  story; the rest of distribution is already shipped.
- **Existing assets.** The portal already implements a working per-user Google
  OAuth flow (`apps/portal/api/oauth/` — start/callback/status, HMAC-signed
  sessions, the same `tagmanager.readonly` + `analytics.readonly` scopes). The
  Postgres token-vault schema exists (`apps/portal/shared/`,
  `OAuthConnection` type) but is **not wired** (methods throw
  `StoreNotWiredError`).
- **The MCP server is single-identity by construction.** `buildGoogleAuth()`
  builds one global `OAuth2Client`; the GTM/GA4 clients are module-level
  singletons (`gtmClient.ts`, `ga4Client.ts`); HTTP sessions carry no identity.

### Fixed costs, independent of this decision

1. **Per-request identity refactor (in-house, unavoidable).** Remove the auth
   singletons; resolve a per-session user → per-user `OAuth2Client` → per-user
   GTM/GA4 client; inject identity into tool execution. This is required no
   matter which AS we choose. *(Est: ~3–5 days.)*
2. **Token vault (in-house).** Wire the Postgres store, persist each user's
   Google refresh token **encrypted at rest** (app-level AES-GCM at minimum;
   KMS-backed `tokenRef` ideal), per-user CRUD + revocation. *(Est: ~3–4 days.)*
3. **Google OAuth verification.** `tagmanager.*` and `analytics.readonly` are
   Google **sensitive** scopes (not *restricted* like Gmail/Drive). The path is
   the standard sensitive-scope review: verified brand, privacy policy, domain
   verification, justification (often a demo video). Typically days-to-weeks,
   **no CASA third-party audit, no audit fee.** Must start in parallel, early.
   *(Owner: product; external dependency.)*

The decision below is **only** about who provides the OAuth 2.1 Authorization
Server in front of those fixed pieces.

## Decision

**Accepted: Option B (managed) with Stytch Connected Apps as the Authorization
Server.** Stytch brokers Google as the upstream IdP; our MCP server stays a
Resource Server that validates Stytch-issued tokens and resolves each to the
user's Google identity.

Rationale: Stytch Connected Apps is the most MCP-native option (purpose-built
for agents/MCP, native DCR), and its free tier — **10,000 MAU/month + 1,000 M2M
tokens + 5 SSO connections, no feature gating** — covers launch and validation
at $0. A "MAU" is a user/agent authorizing in a given month (not per request),
so a small user base stays free regardless of usage volume. Connected Apps draws
from the standard MAU pool (no separate billing). Open question for the spike:
whether Stytch vaults the upstream Google refresh token and vends fresh Google
access tokens to us — if so, our own token vault (fixed-cost item #2 below)
becomes unnecessary.

## Options Considered

### Option A: Build the Authorization Server in-house

Implement OAuth 2.1 + DCR + RFC 9728/8707 + PKCE + `/.well-known/*` + `/authorize`
+ `/token` + Google upstream brokering inside the existing Express server (or via
a library such as Cloudflare's `workers-oauth-provider` / an MCP SDK provider
helper). Issue and sign our own MCP access/refresh tokens; store Google tokens
in our vault keyed to our session.

| Dimension | Assessment |
|-----------|------------|
| Complexity | **High** — we own DCR, token issuance/rotation, JWT signing & key rotation, replay/PKCE, spec-conformance with evolving MCP clients |
| Cost | $0 vendor; high engineering + ongoing maintenance/security cost |
| Scalability | Fine (stateless tokens + our DB); we own the scaling |
| Team familiarity | Low — OAuth-AS internals are easy to get subtly, dangerously wrong |
| Time to first login | **Slowest** — weeks on the AS alone, on top of the fixed costs |
| Control / data | **Maximum** — no third party sees tokens or user identity |

**Pros:** Total control; no vendor lock-in, fees, or third-party trust; tokens
never leave our infra; can deeply customize tool-level authorization.
**Cons:** Largest, riskiest build; we carry the full security burden of a
token-issuing AS forever; must track MCP-spec churn ourselves; slowest launch.

### Option B: Managed MCP-auth provider

Delegate the AS to a provider purpose-built for MCP OAuth — **Stytch Connected
Apps**, **WorkOS AuthKit**, or **Scalekit** (also Auth0, Cloudflare). They
implement DCR/PKCE/metadata/token issuance and broker to Google as upstream IdP;
we validate their access tokens at `/mcp` and map them to a user identity.

| Dimension | Assessment |
|-----------|------------|
| Complexity | **Low–Med** — integrate an SDK + validate tokens; provider owns the AS |
| Cost | Vendor fee (generous free tiers exist; scales with MAU) |
| Scalability | Provider-grade; not our problem |
| Team familiarity | Med — standard "validate a JWT / introspect" integration |
| Time to first login | **Fastest** — days, not weeks |
| Control / data | Provider sees auth metadata / brokers tokens (trust + lock-in) |

**Pros:** Fastest to launch; shrinks our security/audit surface dramatically;
spec-conformance + MCP-client churn handled by the vendor; several offer
tool-level FGA, SSO/SCIM, and audit logs we'd otherwise build.
**Cons:** Vendor fee at scale; lock-in to their token model; a third party sits
in the auth path (still brokers to Google — Google tokens can remain in our
vault depending on integration mode); less customization.

#### Provider shortlist (June 2026)
- **Stytch Connected Apps** — purpose-built for the OAuth-provider/MCP use case,
  explicit MCP + DCR support, B2C & B2B SKUs. (Now part of Twilio.)
- **WorkOS AuthKit** — MCP-compatible OAuth without replacing a user DB; adds
  FGA (tool-level scoping), SSO/SCIM, audit logs; strong free tier.
- **Scalekit** — B2B-focused; recently added MCP client-registration support.

## Trade-off Analysis

The crux is **security ownership vs. control**, weighted by team size and
launch urgency.

- A token-issuing Authorization Server is the single most security-sensitive
  component we could build, and we are a small team. Option A means owning that
  surface — and keeping pace with a still-moving MCP spec — indefinitely. The
  failure modes (token confusion, missing audience binding, weak PKCE, key
  rotation gaps) are exactly the bugs that leak customers' GTM access.
- Option B externalizes that surface to vendors whose core business is getting
  it right, and cuts time-to-launch from weeks to days. We keep the parts that
  are genuinely ours — the per-request identity refactor and tool execution —
  and can still hold Google refresh tokens in our own vault.
- Lock-in is real but bounded: the AS sits behind our `/mcp` Resource Server
  and the MCP discovery layer, so swapping providers later (or migrating to
  in-house once the product is proven) is a contained change, not a rewrite.
- The earlier worry about Google verification cost is largely moot: sensitive
  (not restricted) scopes mean no CASA audit, so neither option carries an
  audit fee — it doesn't differentiate A vs B.

**Recommendation: Option B (managed) for launch.** Lead candidates: **WorkOS
AuthKit** (FGA + audit logs are a bonus for the agency/team angle) or **Stytch
Connected Apps** (most MCP-native). Pick on pricing and B2B needs after a
half-day spike on each. Revisit in-house (Option A) only if vendor cost,
data-residency, or customization later justifies owning the AS.

## Consequences

**Easier:** Ship multi-user sign-in in days; smaller security/audit surface;
vendor absorbs MCP-spec churn; get FGA/SSO/audit logs as a side benefit.
**Harder:** A vendor dependency + fee in the auth path; an integration to learn;
provider's token model constrains some choices.
**Revisit when:** MAU-based fees become material, a customer demands no
third-party in the auth path / data residency, or we need authorization
customization the vendor can't express — then migrate the AS in-house (the
Resource Server and vault we built stay; only the AS swaps).

## Action Items

1. [ ] **Phase 1 — per-request identity refactor (in-house, start now):**
       de-singleton `gtmClient`/`ga4Client`; thread a per-session `OAuth2Client`
       through `createGtmMcpServer`/tool closures; attach identity to HTTP
       sessions. Needed regardless of A/B.
2. [ ] **Phase 2 — token vault:** wire `apps/portal/shared` Postgres store;
       persist Google refresh tokens encrypted at rest; per-user CRUD + revoke.
3. [ ] **Spike (½ day each):** WorkOS AuthKit vs. Stytch Connected Apps —
       Google-upstream brokering, token-validation shape, pricing, free-tier
       limits. Pick one.
4. [ ] **Phase 3 — integrate the managed AS:** add `/.well-known/*` (or proxy to
       provider), validate provider tokens at `/mcp`, map token → user → vault.
5. [ ] **Phase 4 — wire to transport:** extract token → resolve user → inject
       identity into tool execution; per-user Google token refresh.
6. [ ] **In parallel from day 1:** submit the Google OAuth app for
       **sensitive-scope** verification (brand, privacy policy, domain
       verification, justification/demo). No CASA needed for GTM/GA scopes.
7. [ ] Retire the shared `GTM_MCP_HTTP_AUTH_TOKEN` single-identity mode for the
       public endpoint once multi-user is live (keep it for private/team use).
