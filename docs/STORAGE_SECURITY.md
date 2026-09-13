# Storage, Security, RBAC & Retention Foundation

Workstream A of the production roadmap. This documents the **durable-storage and
security foundation** that sits between the inert Phase-0 scaffolding (schema +
domain types + cache policy, see [`PRODUCTION_ARCHITECTURE.md`](./PRODUCTION_ARCHITECTURE.md))
and a future live deployment.

> **Nothing here wires a live service.** No `pg`/`drizzle`/`supabase-js`
> dependency is added; no secret manager is contacted; no env defaults change.
> The portal continues to run exactly as today (Vercel serverless + signed
> cookies, no database). Every module is pure or inert-by-default and is unit
> tested without credentials.

## Guardrails preserved

- **Read-only by default.** None of these modules can perform or authorize a
  GTM/GA4 write. RBAC intentionally exposes **no portal-grantable publish
  permission** — publishing stays gated by `GTM_MCP_ENABLE_PUBLISH` on the MCP
  server. The strongest portal action is `approval:decide`, which marks an
  approval request approved but does **not** publish.
- **No secrets in repo or DB.** OAuth token *bytes* never land in Postgres, a
  cookie, or this repo. Postgres holds only `oauth_connections.token_ref` (an
  opaque pointer); the bytes live in an external vault.
- **`api/**`-import-safe.** All modules are framework-free and import only
  `import type` + Web Crypto. The (skeleton) DB adapter imports no driver, so it
  stays cheap; a real driver is created lazily inside the adapter, only ever
  reached via `await import()` from a handler **after** auth.
- **No live-credential wiring, no behavior change.** With no `DATABASE_URL`, the
  store factory returns `null` and call sites take the unchanged stateless path.

---

## 1. Durable store abstraction (`apps/portal/shared/db/`)

| File | Role |
| --- | --- |
| `config.ts` | Pure env parsing → `DbConfig`. Single source of truth for "is a DB configured" (`isDatabaseConfigured`). Recognizes `DATABASE_URL` / `PORTAL_DATABASE_URL`, `DATABASE_SSL`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`. Never opens a socket, never logs the connection string. |
| `postgres-store.ts` | **Production-ready skeleton** implementing `ProductionStore`. No driver dependency: every method throws `StoreNotWiredError` with a pointer to the exact wiring step, so a misconfigured deployment fails **loud**, never returning silent empty data. Contains a `HOW TO WIRE` block (install driver → lazy pool → set `app.current_org_id` GUC per txn for RLS → map columns). |
| `index.ts` | `createProductionStore(cfg?)` — the only place call sites obtain a store. Returns `null` when no DB is configured (stateless fallback) or a `PostgresStore` when configured. Exhaustiveness-guarded over `DbDriver`. |

**Why a skeleton, not a live client?** Keeping `pg`/drizzle out of the bundle
keeps the foundation inert and the portal light until a deployment explicitly
opts in. The seam (`ProductionStore` in `production-types.ts`) lets route/worker
code be written against a stable contract today; dropping in a real driver later
touches only `postgres-store.ts`.

**Tenant isolation in the DB:** `0001_init.sql` enables Row-Level Security on
every tenant-scoped table, keyed on `current_setting('app.current_org_id')`. The
wiring step sets that GUC per transaction from the authenticated principal's
`orgId`, so RLS enforces isolation even if an app-layer check is missed.

---

## 2. Encrypted token vault (`apps/portal/shared/token-vault.ts`)

The seam for moving OAuth token bytes out of the cookie/DB and into a secret
manager (roadmap Phase 2).

- **`TokenVault`** — `store(token) → metadata`, `get(tokenRef) → bytes|null`,
  `delete(tokenRef)` (idempotent). `store` returns only **metadata** (`tokenRef`,
  `scopes`, `accessExpiresAt`, `hasRefresh`) — the bytes never round-trip back to
  the caller's persistence layer. `metadataOf()` derives that view and is tested
  to never include token strings.
- **`newTokenRef()`** — opaque, unguessable reference via Web Crypto (24 random
  bytes, prefixed). No `node:crypto` top-level import, so the module stays
  `api/**`-safe.
- **`InMemoryTokenVault`** — dev/test stub that is **inert by default**.
  Constructing it without `{ allowInMemoryTokens: true }` makes `store()` throw
  `TokenVaultDisabledError` and `get()` resolve `null` — a misconfigured
  production deployment can therefore **never silently hold real tokens in
  process memory**. Tests and local dev opt in explicitly.
- **`detectVaultProvider(env)`** — reads env **presence** only to report the
  intended provider; returns `"none"` today (signed-cookie deployment).

### Recommended providers

| Provider | When | Notes |
| --- | --- | --- |
| **Supabase Vault** | Already on Supabase Postgres | pgsodium-backed, co-located; detected via `SUPABASE_VAULT_URL` / `SUPABASE_SERVICE_ROLE_KEY`. |
| **GCP Secret Manager / Cloud KMS** | Hosted on GCP | IAM-scoped to the backend service identity; `GCP_KMS_KEY` / `GOOGLE_CLOUD_PROJECT`. |
| **AWS Secrets Manager / KMS** | Hosted on AWS | `AWS_SECRETS_MANAGER_REGION` / `AWS_KMS_KEY_ID`. |
| **HashiCorp Vault** | Cloud-agnostic / dynamic secrets | `VAULT_ADDR`. |
| **1Password Secrets Automation** | Small teams | Connect server + service-account token. |

Implementations must hold the invariants documented in the file: refs are
opaque, bytes are never logged/cached/sent to the browser, and `delete` is
idempotent.

---

## 3. Multi-tenant RBAC (`apps/portal/shared/rbac.ts`)

Pure authorization over the `memberships` `(user, org, role)` tuple.

- **Roles** (low→high): `viewer` ⊂ `member` ⊂ `admin` ⊂ `owner`, matching the
  SQL `CHECK` constraint. The matrix is written out explicitly per role (not via
  inheritance) so an auditor reads exactly what each role can do; the test suite
  asserts the **monotonicity** invariant (higher ⊇ lower).
- **`Permission`** — resource-scoped actions for org / member / project / audit /
  capture / connection / approval. `viewer` holds only `:read` permissions.
- **`authorize(principal, permission, targetOrgId)`** — returns a structured
  decision. Denies with `no_principal` / `cross_tenant` / `insufficient_role`.
  **Tenant isolation is checked before role**: a principal scoped to org A acting
  on org B is `cross_tenant` regardless of role (callers should map this to 404
  to avoid leaking existence). `can()` / `assertCan()` wrap it for boolean and
  throwing call sites.
- **`canAssignRole(actor, target)`** — escalation guard: an admin may assign only
  roles strictly below admin (cannot mint admins/owners); an owner may assign any
  role (incl. ownership transfer).

| | viewer | member | admin | owner |
| --- | :-: | :-: | :-: | :-: |
| read (org/project/audit/…) | ✓ | ✓ | ✓ | ✓ |
| run audits, manage projects, request captures, submit approvals | | ✓ | ✓ | ✓ |
| approve, manage members, manage connections, deletes | | | ✓ | ✓ |
| `org:update` / `org:delete` | | | | ✓ |
| **any `*:publish`** | — | — | — | — (not portal-grantable) |

---

## 4. Data retention (`apps/portal/shared/retention.ts`)

Pure cutoff logic resolved against an **injected `now`** (never `Date.now()`),
so the sweep and tests are deterministic.

| Class | Window | Mechanism |
| --- | --- | --- |
| `runtime_capture` | **30 days** | explicit `expires_at` (writer-stamped); PII-sensitive, expires fastest |
| `audit_run` | 365 days | swept on `created_at` (findings cascade via FK) |
| `audit_finding` | 365 days | normally removed by the `audit_runs` cascade |
| `worker_job` | 30 days | terminal jobs only, swept on `finished_at` |
| `log` | 14 days | external sink, same TTL |

- **`cutoffFor(class, now)`** — `now − retentionDays`; rows strictly older are
  deleted.
- **`expiresAtFor(class, createdAt)`** — the `expires_at` a writer stamps for
  explicit-expiry classes; `null` for age-swept classes.
- **`isExpired(class, row, now)`** — fail-safe: a row whose age can't be
  established (null/invalid timestamp) is **never** treated as expired.

The reference SQL sweep (matching these windows to the second) is documented in
`infra/database/0001_init.sql` under the retention section. Schedule it via
`pg_cron`, a Vercel cron route, or the worker.

---

## 5. Tests (no credentials required)

| Suite | Cases | Command |
| --- | --- | --- |
| RBAC role matrix + tenant isolation + escalation | 42 | `npm run test:rbac` |
| Retention policy + cutoff + fail-safe | 21 | `npm run test:retention` |
| Token vault inertness + DB config/factory + skeleton | 24 | `npm run test:storage` |

All three are wired into the root `npm test` chain. They are pure-logic /
in-memory only — no live DB, no real secret manager, no network — and assert the
security invariants directly (metadata carries no bytes; the vault is inert
unless enabled; the store fails loud; `viewer` is read-only; no publish
permission exists).
