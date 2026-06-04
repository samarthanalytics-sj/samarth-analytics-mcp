-- ============================================================================
-- Samarth Analytics — Production database schema (migration 0001_init)
-- ----------------------------------------------------------------------------
-- Portable PostgreSQL DDL for the durable foundation described in
-- docs/PRODUCTION_ARCHITECTURE.md. Target: managed Postgres (Supabase / Neon /
-- RDS). This file is FORWARD-LOOKING infrastructure — it is NOT wired into the
-- running portal yet (the portal stays signed-cookie + stateless today).
--
-- Design rules honoured here:
--   * Read-only-by-default product: nothing in this schema stores or implies a
--     GTM/GA4 write. It records audit *reads*, capture artifacts, and job state.
--   * NEVER store raw OAuth tokens. `oauth_connections` keeps only metadata and
--     a reference (`token_ref`) to an external secret manager / KMS-encrypted
--     vault. The token bytes live outside Postgres.
--   * Multi-tenant from day one: every tenant-scoped row carries org_id and is
--     isolated by Postgres Row-Level Security (policies are illustrative; wire
--     the JWT/role mapping in the app layer before enabling FORCE RLS).
--   * Idempotent: guarded by `IF NOT EXISTS` so it can be re-applied safely in
--     CI / preview environments.
--
-- Apply with any standard migration runner (drizzle-kit, node-pg-migrate,
-- sqitch, Flyway) or psql:  psql "$DATABASE_URL" -f infra/database/0001_init.sql
-- ============================================================================

BEGIN;

-- UUID generation without an extension dependency where possible. gen_random_uuid()
-- is built in on PostgreSQL 13+ (pgcrypto). Fall back to pgcrypto if needed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerated domains. Kept as CHECK-constrained text rather than native ENUM
-- types so values can be extended via a cheap migration (ALTER TYPE ... ADD
-- VALUE is non-transactional and awkward across branches). The allowed sets
-- mirror apps/portal/shared/portal-types.ts so the app and DB never drift.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- TENANCY
-- ===========================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe tenant handle used in white-label routing (e.g. acme.portal...).
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- Soft tier flag for rate limits / feature gating. Free-form on purpose.
  plan          TEXT NOT NULL DEFAULT 'free',
  -- Non-secret tenant config (branding, feature flags). No credentials here.
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Google subject (sub claim) — stable per Google account. Unique across the
  -- system; a user may belong to multiple orgs via memberships.
  google_sub    TEXT UNIQUE,
  email         TEXT NOT NULL,
  display_name  TEXT,
  picture_url   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Many-to-many user↔org with a role. The membership row is the unit RLS keys on.
CREATE TABLE IF NOT EXISTS memberships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member'
                  CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- ===========================================================================
-- AUTH / TOKEN VAULT METADATA  (NO RAW TOKENS — EVER)
-- ===========================================================================
-- One row per (user, provider, granted-scope-set). The actual access/refresh
-- tokens are NOT stored here. `token_ref` points at an external secret store
-- (e.g. AWS Secrets Manager ARN, GCP Secret Manager resource name, or a row in
-- a KMS-encrypted vault table). Postgres only knows the token EXISTS, when it
-- expires, and what it can read — never the bytes.
CREATE TABLE IF NOT EXISTS oauth_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'google'
                    CHECK (provider IN ('google')),
  -- Opaque reference into the external secret manager. Must be resolvable only
  -- by the backend service identity, never by the browser.
  token_ref       TEXT NOT NULL,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  -- Expiry of the short-lived access token, used to decide refresh timing.
  access_expires_at TIMESTAMPTZ,
  -- Whether a refresh token is present in the vault (drives "reconnect" prompts
  -- without exposing the token itself).
  has_refresh     BOOLEAN NOT NULL DEFAULT false,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, provider)
);

CREATE INDEX IF NOT EXISTS oauth_connections_org_idx ON oauth_connections (org_id);

-- ===========================================================================
-- GTM / GA4 METADATA CACHE (DISCOVERY SNAPSHOTS)
-- ===========================================================================
-- Durable snapshots of the account → container → workspace hierarchy and GA4
-- property/stream lists. These are a WARM cache: source of truth is always the
-- Google API. `fetched_at` + a TTL policy (see caching strategy doc) governs
-- staleness; rows are upserted on each discovery read. Safe to truncate.

CREATE TABLE IF NOT EXISTS gtm_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,           -- GTM numeric account id
  name          TEXT NOT NULL,
  path          TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id)
);

CREATE TABLE IF NOT EXISTS gtm_containers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  container_id  TEXT NOT NULL,           -- GTM numeric container id
  public_id     TEXT,                    -- GTM-XXXXXXX
  name          TEXT NOT NULL,
  usage_context TEXT[] NOT NULL DEFAULT '{}',  -- e.g. {web} or {server}
  domain_name   TEXT[] NOT NULL DEFAULT '{}',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id, container_id)
);

CREATE INDEX IF NOT EXISTS gtm_containers_org_idx ON gtm_containers (org_id);

CREATE TABLE IF NOT EXISTS gtm_workspaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  container_id  TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id, container_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS ga4_properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id   TEXT NOT NULL,           -- numeric, without "properties/" prefix
  display_name  TEXT NOT NULL,
  account_id    TEXT,
  account_name  TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, property_id)
);

CREATE TABLE IF NOT EXISTS ga4_data_streams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id     TEXT NOT NULL,
  data_stream_id  TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  stream_type     TEXT,
  measurement_id  TEXT,                  -- G-XXXXXXX for web streams
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, property_id, data_stream_id)
);

CREATE INDEX IF NOT EXISTS ga4_streams_measurement_idx
  ON ga4_data_streams (org_id, measurement_id);

-- ===========================================================================
-- PROJECTS  (a saved audit target: a container, optionally a GA4 property)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  client        TEXT,                    -- end-customer label (white-label)
  industry      TEXT,
  account_id    TEXT,
  container_id  TEXT,
  workspace_id  TEXT,
  ga4_property_id TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);

-- ===========================================================================
-- AUDIT RUNS + FINDINGS
-- ===========================================================================
-- An audit_run is one execution of the audit / consent / sgtm engines against a
-- project. It captures the capability flags (which sources were available) and
-- the headline scores; individual findings normalize into audit_findings.
CREATE TABLE IF NOT EXISTS audit_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  -- Which engine produced this run.
  kind            TEXT NOT NULL DEFAULT 'container'
                    CHECK (kind IN ('container', 'consent', 'sgtm')),
  container_id    TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Sources used: subset of {CONFIG, RUNTIME, SGTM, GA4_ADMIN, DATA_API}.
  capability_flags TEXT[] NOT NULL DEFAULT '{}',
  health_score    INTEGER CHECK (health_score BETWEEN 0 AND 100),
  -- Optional reference to the runtime capture that fed RUNTIME-source findings.
  runtime_capture_id UUID,
  -- Denormalized severity tally for fast list rendering.
  severity_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Full engine output for replay / export. Bounded; large blobs may move to
  -- object storage with only a pointer kept here (see scaling roadmap).
  result          JSONB,
  error           TEXT,
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS audit_runs_org_created_idx
  ON audit_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_runs_project_idx ON audit_runs (project_id);
CREATE INDEX IF NOT EXISTS audit_runs_status_idx ON audit_runs (status);

CREATE TABLE IF NOT EXISTS audit_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  audit_run_id    UUID NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  -- Stable engine-emitted finding id (kebab). Unique within a run.
  finding_key     TEXT NOT NULL,
  category        TEXT NOT NULL,         -- AuditCategory (ga4, consent, ...)
  severity        TEXT NOT NULL
                    CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  confidence      TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  sources         TEXT[] NOT NULL DEFAULT '{}',
  title           TEXT NOT NULL,
  why_it_matters  TEXT,
  suggested_fix   TEXT,
  business_impact TEXT,
  effort          TEXT CHECK (effort IN ('S', 'M', 'L')),
  needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  -- Affected entities + parameter + entity ref kept as JSON for fidelity.
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_run_id, finding_key)
);

CREATE INDEX IF NOT EXISTS audit_findings_run_idx ON audit_findings (audit_run_id);
CREATE INDEX IF NOT EXISTS audit_findings_severity_idx
  ON audit_findings (org_id, severity);

-- ===========================================================================
-- RUNTIME CAPTURES + WORKER JOBS
-- ===========================================================================
-- A worker_job is a queued unit of work for the headless-Chromium capture
-- worker (apps/runtime-worker). The orchestration model: API enqueues a job →
-- worker leases it (lease_expires_at, attempts) → worker uploads the capture →
-- job marked succeeded and linked to runtime_captures. This table is the
-- durable mirror of whatever queue transport is used (Postgres SKIP LOCKED
-- queue to start; swap to SQS/QStash later without schema change).
CREATE TABLE IF NOT EXISTS worker_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'runtime_capture'
                    CHECK (kind IN ('runtime_capture')),
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  -- Job input (target URLs, consent scenarios, host allowlist). No secrets.
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority        INTEGER NOT NULL DEFAULT 100,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  -- Visibility-timeout style lease for SKIP LOCKED dequeue.
  lease_expires_at TIMESTAMPTZ,
  leased_by       TEXT,
  last_error      TEXT,
  audit_run_id    UUID REFERENCES audit_runs(id) ON DELETE SET NULL,
  requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

-- Partial index powering the dequeue hot path: only rows still claimable.
CREATE INDEX IF NOT EXISTS worker_jobs_queue_idx
  ON worker_jobs (priority, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS runtime_captures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  worker_job_id   UUID REFERENCES worker_jobs(id) ON DELETE SET NULL,
  -- Capture artifact schema version emitted by the worker (e.g. "v2", "v3").
  schema_version  TEXT,
  captured_at     TIMESTAMPTZ,
  requested_urls  TEXT[] NOT NULL DEFAULT '{}',
  -- The structured capture. PII RISK: raw captures may contain dataLayer values
  -- with user data. Store ONLY in a retention-policed, access-controlled column
  -- (or move the blob to encrypted object storage and keep a pointer). Never
  -- expose to the browser without redaction. See caching-strategy doc §"what
  -- not to cache".
  artifact        JSONB,
  -- Pointer for the object-storage variant (s3://... / gs://...).
  artifact_uri    TEXT,
  -- Hard delete-after timestamp enforced by a retention job.
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_captures_org_idx ON runtime_captures (org_id);
CREATE INDEX IF NOT EXISTS runtime_captures_expiry_idx ON runtime_captures (expires_at);

-- Late FK now that runtime_captures exists (audit_runs references it).
ALTER TABLE audit_runs
  DROP CONSTRAINT IF EXISTS audit_runs_runtime_capture_fk;
ALTER TABLE audit_runs
  ADD CONSTRAINT audit_runs_runtime_capture_fk
  FOREIGN KEY (runtime_capture_id) REFERENCES runtime_captures(id) ON DELETE SET NULL;

-- ===========================================================================
-- APPROVAL QUEUE  (change plans awaiting Samarth review before any publish)
-- ===========================================================================
-- Mirrors the ApprovalItem / ChangePlan shapes in portal-types.ts. Storing an
-- approval request does NOT grant write access — publishing remains gated by
-- the MCP server's GTM_MCP_ENABLE_PUBLISH guardrail. This is workflow state.
CREATE TABLE IF NOT EXISTS approval_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  container_id    TEXT,
  title           TEXT NOT NULL,
  goal            TEXT,                  -- RecommendationGoal
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected', 'published')),
  risk_level      TEXT CHECK (risk_level IN ('low', 'medium', 'high')),
  -- The full change plan (steps[]) as authored. Read-only artifact.
  plan            JSONB NOT NULL DEFAULT '{}'::jsonb,
  steps_count     INTEGER NOT NULL DEFAULT 0,
  submitted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  submitted_at    TIMESTAMPTZ,
  reviewer        UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_requests_org_status_idx
  ON approval_requests (org_id, status);

-- ===========================================================================
-- ROW-LEVEL SECURITY (illustrative — enable after wiring app role/JWT mapping)
-- ===========================================================================
-- The app should SET app.current_org_id per transaction (or use a Postgres role
-- per tenant). These policies restrict every tenant-scoped table to the active
-- org. They are created but NOT forced here; turn on with `FORCE ROW LEVEL
-- SECURITY` once the app reliably sets the GUC, to avoid locking out migrations.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','oauth_connections','gtm_accounts','gtm_containers',
    'gtm_workspaces','ga4_properties','ga4_data_streams','projects',
    'audit_runs','audit_findings','worker_jobs','runtime_captures',
    'approval_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY %1$s_org_isolation ON %1$I
      USING (org_id::text = current_setting('app.current_org_id', true));
    $f$, t);
  EXCEPTION WHEN duplicate_object THEN
    -- Policy already exists; ignore on re-apply.
    NULL;
  END LOOP;
END $$;

COMMIT;
