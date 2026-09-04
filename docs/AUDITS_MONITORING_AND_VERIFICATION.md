# Audits, Monitoring, Suggestions & Verification

A deep technical reference for the five measurement-quality features in Samarth
Analytics MCP:

1. [GA4 Property Audit](#1-ga4-property-audit)
2. [GTM Container Audit](#2-gtm-container-audit) (+ Workspace Comparison, sGTM coverage, Consent Mode v2 engine)
3. [GA4 Monitoring](#3-ga4-monitoring) (+ Tag Watch / GA4-Spy)
4. [Tag Suggestions](#4-tag-suggestions) (measurement plan from a URL)
5. [Tag Verification](#5-tag-verification)

Two principles run through every feature and are worth stating once, up front:

- **Read-only by default, honest by construction.** Nothing here changes a GA4
  property or a GTM container as a side effect of auditing or monitoring. Where a
  value cannot be read, the output says "Not Verified" / "Manual Review" rather
  than guessing. Every claim traces to a real field the engine actually observed.
- **Pure engines, thin I/O.** The scoring, diffing, and rule logic is implemented
  as pure, deterministic functions (identical input gives identical output, no
  clock, no randomness, no network). All I/O lives in a small number of
  data-service / driver files. This is what makes the test suites possible and the
  results reproducible.

---

## 1. GA4 Property Audit

**What it is:** a read-only, evidence-graded audit of a single GA4 property's
configuration and reporting data. It produces two headline numbers (a setup
"completeness" score and a reporting "reliability" percentage), a per-area
pass/partial/fail/not-verified matrix, a full findings list with fix guidance,
and a property baseline (channels, devices, geography, funnels, products).

**Where it lives:** almost entirely in the desktop Electron app under
`apps/desktop/src/main/google/` (pure engines + orchestration), with rendering in
`apps/desktop/src/shared/`. It is orchestrated by `runGa4AuditPipeline()` in
`ga4-audit-ipc.ts`, which pulls all data, runs every engine, and assembles the
report. GA4 config is never auto-modified; the optional one-click fix (`ga4:plan`
/ `ga4:applyPlan`) is a separate write feature, not the audit.

> Note: `src/tools/audit.ts` in the MCP server is the **GTM** container audit, not
> this feature. `audit-runner.ts` in the desktop app is also GTM-only.

### 1.1 Audit sections and what each checks

| Engine (file) | Category values | What it checks |
|---|---|---|
| `ga4-audit.ts` (`auditGa4`) | collection, retention, conversions, measurement, privacy, integrations, benchmarking, customdef, attribution | The property-configuration checks (see below). |
| `ga4-data-quality.ts` (`auditGa4DataQuality`) | data_quality | Unassigned channel / "(not set)" source-medium, referral & ghost spam, non-production hostnames, identity fragmentation. |
| `ga4-integrity.ts` | integrity | Per-event drop-to-zero (`auditGa4EventDeltas`) and ecommerce transaction integrity (`auditGa4Transactions`). |
| `ga4-event-hygiene.ts` (`auditGa4EventHygiene`) | hygiene, integrity | Event-name naming violations, high-cardinality name families, key events that never fired. |
| `ga4-param-matrix.ts` (`auditGa4ParamMatrix`) | params | Required / recommended parameters per recommended event, grounded in predefined API signals only. |
| `ga4-dead-dimensions.ts` (`auditGa4DeadDimensions`) | customdef | Registered custom dimensions with no data over 90 days. |
| `ga4-event-coverage.ts` (`auditGa4EventCoverage`) | conversions | Ecommerce properties missing GA4 recommended events. |
| `ga4-growth.ts` (`auditGa4Growth`) | growth | Spike/drop correlated to outcomes (conversions vs traffic). |
| `ga4-trend.ts` (`analyzeGa4Trend`) | - | Traffic-trend shape classification. |
| `ga4-retention.ts` | - | Weekly retention cohort headline. |
| `ga4-campaigns.ts` (`rankGa4Campaigns`) | attribution | Untagged share, top campaign. |
| `ga4-anti-lie.ts` (`antiLieFindings`) | concentration, referral_leakage, invalid_traffic, pii, self_referral, thresholding, attribution_mismatch | Confirmed "don't trust this number" detectors. |

#### Configuration checks (`ga4-audit.ts`), by `checkId`

- **Data collection** - `no_data_streams` (high), `multiple_web_streams` (double
  counting, info), `currency_unset` (info).
- **Data retention** - `retention_360_under` (a 360 property below 50 months),
  `retention_two_months` (a standard property on the 2-month default),
  `retention_no_reset` (`resetOnNewActivity === false`). Service-level aware:
  `is360 = serviceLevel === 'GOOGLE_ANALYTICS_360'`.
- **Key events** - `no_key_events` (nothing marked as a conversion, medium).
- **Enhanced measurement** - `em_master_off` (master toggle off on a web stream),
  `em_subtoggles_off` (master on but `siteSearchEnabled` / `pageChangesEnabled` /
  `formInteractionsEnabled` off).
- **Privacy (PII)** - `pii_custom_dimension` (a custom-dimension name matching
  `PII_RE`: email/phone/first-last-name/street/address/zip/ssn/dob/passport/
  national-id). Deliberately excludes `user_id` and a bare "name".
- **Custom definitions** - `param_naming` (parameter name fails
  `/^[a-z][a-z0-9_]*$/`), `event_dim_slots` (≥45 of 50 event-scoped),
  `user_dim_slots` (≥22 of 25 user-scoped), `no_custom_defs`.
- **Integrations** - `no_ads_links`, `signals_off_with_ads`, `no_bigquery`,
  `bigquery_no_export` (link exists but neither daily nor streaming export on),
  `no_audiences`, `only_default_audiences`.
- **Attribution** - `attribution_last_click` (model is last-click, not
  data-driven), `lookback_short` (`otherLookback` not 90 days).
- **Benchmarking** - `industry_category_unset`.

The configuration audit also emits an **area coverage table** (`Ga4AreaStatus`)
with status `pass | partial | fail | not_verified` across Data collection, Data
retention, Key events, Enhanced measurement, Custom definitions, Attribution,
Privacy (PII), Integrations, and Benchmarking. Two deliberate rules: Data
collection is capped at `partial` when a stream exists (internal-traffic/bot
filters are not API-verifiable), and `not_verified` distinguishes an unreadable
sub-resource from a real zero.

#### Data-integrity and quality highlights

- **Per-event drop-to-zero** - an event with `priorCount ≥ 30` now at `count === 0`
  is **high** if it is a key event (broken tag), medium otherwise. A **partial
  plunge** (`priorCount ≥ 100` and now below 20% of prior) is medium.
- **Duplicate transactions** - a `transactionId` seen on more than one purchase is
  double-counted revenue (high). Missing `transaction_id`: 5% share → medium, 20%
  → high.
- **Referral / ghost spam** - known-bad hosts (`REFERRAL_SPAM_RE`) always flagged,
  plus a zero-engagement heuristic; known-good referrers and mobile-app package
  ids exempted.
- **Non-production hostnames** - localhost, raw IPv4, `*.local`, ngrok, staging/
  dev/qa/uat/preview subdomains, ephemeral Vercel/Netlify/Cloudflare-Pages
  previews. A stable `*.vercel.app` is not flagged.
- **Identity fragmentation** - returning-user share below 2% over ≥14 days with
  ≥500 sessions (Consent Mode / short cookie / no `user_id`); skips properties
  under 30 days old.

### 1.2 What data it pulls, and from which API

All GA4 I/O lives in `data-service.ts` and uses `@googleapis/analyticsadmin` and
`@googleapis/analyticsdata`.

- **Admin API v1beta** - account summaries, property list/get, data-retention
  settings, key events, custom dimensions, custom metrics, data streams, Google
  Ads links, Measurement Protocol secrets.
- **Admin API v1alpha** (best-effort, `.catch(() => null)`) - Google Signals
  settings, enhanced-measurement settings, attribution settings, BigQuery links,
  audiences. (These surfaces are v1alpha-only.)
- **Data API v1beta** (`runReport`, `checkCompatibility`) - ~16 parallel reports
  for the baseline (current + prior totals for sessions / key events / revenue,
  engagement, daily series, device, new-vs-returning, country, channel × date,
  funnel reach, LLM-source referrals, top products), plus data-quality reports,
  event deltas, transactions, custom-dimension usage, present events, parameter
  signals, and weekly retention cohorts.

The reporting window is **full days only, ending yesterday** (today is excluded to
avoid processing-lag deflation), anchored in the property's timezone. Every Data
API call is wrapped in `withQuotaRetry`; an enrichment failure degrades a section
to Not Verified rather than failing the whole audit.

### 1.3 Scoring and grading (`ga4-scorecard.ts` → `buildGa4Scorecard`)

Two headline numbers, both rule-based and deterministic.

**Setup completeness /100 + letter grade.** A weighted scorecard over six
categories: Configuration (18), Event Tracking (20), Key Events (18), Data Quality
(22), Audiences & Attribution (12), Consent & Compliance (10).
`STATUS_SCORE = { pass: 100, partial: 50, fail: 0 }`. A category's subscore is the
mean of its verified members and its status is the **worst** verified member.
Not-Verified categories are excluded and their weight redistributed over the
scored ones (`effectiveWeight`, sums to 1.0). Grade: A ≥90, B ≥80, C ≥70, D ≥60,
else F.

**Reporting reliability %** - from a pass-gated **Data Trust Matrix** over five
quotable metrics: Sessions/users/engagement (weight 30), Conversion counts (25),
Revenue/AOV/ROAS (20), Channel attribution (15), Smart Bidding (10). Each metric
has gates; a metric is **safe** only if every gate passes, `do_not_quote` on any
fail, `unverified` on any not-verified (an unrun check is never "safe"), else
`caution`. Reliability = Σ(weight × gate-pass fraction) over safe/caution metrics.

**Reliability ceiling, caps, bands.** Because the Admin API caps Data collection at
Partial and cannot read Consent Mode, a clean production property tops out near
~60 - that is the High band on this scale. If Conversion counts or Revenue are
unverified/failed, reliability is capped at 44 and `reliabilityCappedBy` names
them. Bands: High ≥55, Medium ≥20, else Low. `reliabilityWhy[]` is an itemized
"points-lost receipt" (biggest loss first), each with a cause and a fix.

Overlapping checks that appear as both a finding and a plan item are resolved to a
single severity via `shared/ga4-check-severity.ts` so the finding and the plan can
never disagree.

### 1.4 Export formats

IPC `ga4:exportReport` supports three formats:

- **md** - raw Markdown (`buildGa4AuditReport`), house-style plain hyphens.
- **doc** - styled HTML with MS-Office namespaces (opens in Word / Google Docs),
  including the exec summary and HTML bar charts but not the inline SVG line charts.
- **pdf** - the same HTML rendered in a hidden sandboxed `BrowserWindow` via
  `printToPDF`, with SVG charts embedded.

The Markdown report is structured as: 1 Executive summary, 2 What is wrong, 3
Outcomes vs traffic, 4 All findings, 5 Area status, 6 Property baseline, 7 Decision
readiness (trust matrix), 8 Not verified, 9 Scope & metadata. The HTML renderers
(`ga4-exec-html.ts`, `ga4-visuals-html.ts`, `ga4-sections-html.ts`) render a
"lab report" template with a severity-accented card per section. Each finding
carries a fix guide (`ga4-fix-guide.ts`, keyed by `checkId`) with a `where`
location (`auto` / `ga4-ui` / `site`), manual steps, an official doc URL, and - 
only where a write tool truly applies - a one-click plan id.

---

## 2. GTM Container Audit

**What it is:** a read-only audit of a GTM workspace (web or server) that flags
misconfigurations, dead config, consent gaps, naming problems, and - for server
containers - CAPI and coverage issues. It also drives Workspace Comparison, sGTM
web↔server coverage scoring, and the Consent Mode v2 engine.

**Where it lives:** in three independent implementations sharing one Consent
engine.

- **Desktop app** - the primary Container Audit view. Engines in
  `apps/desktop/src/main/google/gtm-builders.ts` (`auditContainer` and
  `auditServerContainer`); shared flow in `audit-runner.ts`; IPC in
  `suggestions/gtm-audit-ipc.ts`; renderer in `renderer/src/App.tsx`.
- **MCP server tool** - `audit_container` in `src/tools/audit.ts` (lightweight,
  chat-driven).
- **Portal (Vercel) evidence-based auditor** - `apps/portal/api/gtm/audit.ts`,
  multi-source (config + runtime + sGTM + GA4 Admin + Data API).

The shared flow snapshots the container, runs the pure audit engine, then writes
the validated `accountId/containerId/workspaceId` **last** onto every auto-fixable
finding's `fix.args`, so a fix can never be retargeted at another container.

### 2.1 What it reads and produces

The snapshot carries `tags`, `triggers`, `variables` (plus, for comparison,
folders and enabled built-in variables; for the monitor, versions/environments).
Per tag it reads type, paused state, firing/blocking trigger ids, parameters,
consent settings, and parent folder. The report carries counts, a severity summary
(critical/high/medium/low/info), the findings list, a boundary disclaimer, a
`runtimeRequired` list (checks a config export cannot settle), and `hasGa4Config`.
Each finding has a `confidence` (`certain | likely | runtime-required | guessing`),
a stable `checkId`, a category, a resource, a recommendation, `autoFixable`, and an
optional runnable `fix`.

### 2.2 Web-container checks (`auditContainer`)

Per-tag:

- **Unknown tag type** (security, low) - a type not in the known registry
  (`googtag, gaawc, gaawe, awct, sp, gclidw, html, img, ua, flc, fls, baut, bzi,
  hjtc, awcr`) and not a `cvt_*` custom template is flagged for manual review, not
  skipped silently.
- **No firing trigger** (firing, high) - the tag can never fire.
- **Paused tag** - low, escalated to high for a key tag (Ads conversion or a GA4
  config tag). Auto-fix `set_gtm_tag_paused`.
- **GA4 event tag (`gaawe`)** (ga4, high) - missing Measurement ID; missing event
  name; "Cannot detect the Google tag" (a `{{variable}}` Measurement ID that no
  Google tag in the container declares); or an **Enhanced Measurement double-count**
  (event name is one GA4 already collects automatically, medium).
- **Google tag (`googtag`)** - missing tag id (high).
- **Google Ads conversion (`awct`)** - missing conversion id/label (high).
- **Universal Analytics (`ua`)** - deprecated (medium).
- **Custom HTML (`html`)** - always an `html-review` info finding; `document.write`
  → medium; and the **B6 ad-pixel consent gate** (below).
- **Consent Mode v2 missing** (consent, high) - a consent-relevant tag whose
  `consentStatus` is absent/notset; auto-fix `set_gtm_tag_consent` with the correct
  consent types for the tag type.

The **B6 ad-pixel consent gate** classifies a Custom HTML snippet with
`classifyPixel()` (`pixel-signatures.ts`) as advertising / possible / opaque / not
a pixel. For an advertising pixel it evaluates `evaluateConsentGate()` against the
network's required consent: `partial` → medium; `ungated | wrong_types |
declared_no_consent` → **critical** in EU/UK/AU regions (`RISK_REGIONS`) else high;
possible/opaque → info manual review.

Container-level: multiple GA4 Measurement IDs (medium); **unused/orphaned triggers**
(referenced by no tag and no reached trigger group, excluding built-ins);
**Custom JS variable risk** (a referenced `jsm` variable, medium); **unused
variables** (advisory); **dangling `{{variable}}` references** (a token resolving to
no defined or built-in variable); **objectively broken variable config**
(`variable-config-dlv/url/cookie/lookup`); **naming issues** (`placeholder-name`,
`name-whitespace`); and **duplicate names**.

### 2.3 Server-container checks (`auditServerContainer`)

Reads clients, tags, triggers, variables, transformations, and tagging-server URLs.
Checks: no client (critical); Google server tags but no GA4 client (high); no
tagging server URL (high); per-tag no-trigger / paused / missing GA4 Measurement ID
/ missing Ads conversion id-label / missing Ads remarketing id (high); **duplicate
GA4 relay** (two active relays for the same Measurement ID + event → double count,
critical); URL-encoded event-name filter (a dead trigger, high); **Meta CAPI**
checks (swapped Pixel ID / Access Token - shape only, values never echoed; and a
Test Event Code left set, auto-fix clears it); **CAPI dedup `event_id` not
guaranteed** (low, runtime-required) for Meta/TikTok tags with auto-map explicitly
off and no `event_id` mapped; legacy UA client; duplicate clients; server unused
variables and dangling refs; PII-named variables flowing into CAPI with zero
transformations; and duplicate server-tag names.

### 2.4 Consent Mode v2 engine (`apps/portal/shared/consent-audit.ts`)

A pure, deterministic, dependency-free engine - the single source of truth for
Consent Mode v2, exercised by a **170-case test suite** that must stay green
(`npm run test:consent`). Entry `runConsentAudit(cfg, rt)` returns coverage
(`config_only | runtime_imported | reconciled`), the runtime states seen, state
coverage, and findings. The four canonical signals are `ad_storage`,
`analytics_storage`, `ad_user_data`, `ad_personalization`. Every finding is labelled
by source (CONFIG / RUNTIME / both) and never claims live behaviour without a
runtime artifact.

Three layers:

- **CONFIG** (`runConsentConfigRules`) - no consent signals at all; fields/update
  present but no default state; missing v2 fields (high when the new
  `ad_user_data`/`ad_personalization` are among them); per-tag consent NOT_SET on
  marketing/analytics tags (plus name-hint review for custom-HTML pixels); ordering
  risk (no Consent Initialization trigger and measurement fires on All Pages);
  passthrough/redaction not visible.
- **RUNTIME** (`runConsentRuntimeRules`, needs an imported capture) - GA4 hits
  missing `gcs`/`gcd`; a GA4 hit under denial that carried no signal (should be
  cookieless `gcs=G100`); a vendor hit that fired under ads-denied; analytics
  granted but no hit observed; tracking cookies set before consent; CMP/consent JS
  console errors.
- **CONFIG + RUNTIME reconciliation** (`runConsentReconcileRules`) - declared
  gating vs an observed vendor hit under denial (**critical**); measurement before
  the default consent event (high); an expected consent update never observed
  (medium); config missing fields and every runtime hit lacking a signal (both
  agree, high).

### 2.5 Workspace Comparison (`workspace-diff.ts`)

Compares 2-10 workspaces in the same container. Entities are matched by
**`(kind, name)`**, not by id, because ids differ per workspace (a rename shows as
remove + add). Trigger-id references inside a tag's firing/blocking lists are
resolved to trigger **names** per workspace. Each entity is flattened to a
field-map (tag: type, firesOn, blockedBy, consent, folder, and `param:<key>` for
each parameter; trigger: type, filters, params, folder; variable: type, params,
folder; folder: sorted members), then diffed field-by-field into
`added | removed | changed | unchanged` with explicit before/after values.

Consolidation across all workspaces yields `common` vs `uncommon`, with a
`MergeStatus`: **safe** (identical everywhere it exists), **review** (one resolvable
difference), **conflict** (three or more variants, or a type that differs across
workspaces). The dependency engine (`workspace-dependencies.ts`) builds per-entity
dependency edges and, crucially, finds **cross-workspace missing dependencies** - 
a variable/trigger that resolves in some workspaces but is broken in others holding
the same entity (the classic "copied the tag but forgot the variable it reads"
merge-breaker).

Exports: CSV, PDF (a JS-disabled `printToPDF` render), and a native **XLSX** with
five sheets (Summary, Common items, Uncommon items, Detailed diff, Dependencies),
color-coded by merge status.

### 2.6 sGTM coverage + health score (`server-coverage.ts`)

`buildServerCoverage` answers "is every event the web container sends handled by the
server container, per destination?" for GA4, Meta, TikTok, LinkedIn, Pinterest. GA4
is all-or-nothing (a GA4 client plus an active relay with a Measurement ID); CAPI
destinations are per-event (a server tag's trigger event name matches the web
event). It also checks web wiring (is the web Google tag pointed at the tagging
host) and Measurement-ID match. The **score** combines a configuration score
(`100 − 25·critical − 10·high − 3·medium − 1·low` from the server-audit counts) and
a coverage percentage (`covered / (covered + missing)`), reported as their mean.

### 2.7 Exports and the MCP tool

Container findings export to CSV (`auditToCsv`) and Markdown (`auditToMarkdown`,
sorted worst-first) via `gtm:exportAudit`, and to PDF via `gtm:exportAuditPdf`. The
MCP chat tool `audit_container` is a lighter read-only variant with categories
`missing_trigger, paused_tag, broken_reference, ga4_config, duplicate_name,
broad_trigger, unused_trigger, missing_builtin_variable, empty_folder` and reports
`truncated` when a list hit its page ceiling.

---

## 3. GA4 Monitoring

**What it is:** a scheduled, read-only watch over one or more GA4 properties that
runs a battery of checks each sweep, derives a health score, keeps per-target run
history, and alerts to Slack when new issues appear. The **only outbound write is
the Slack webhook POST.**

**Where it lives:** the pure engine is `ga4-monitor.ts`; the scheduler is
`services/ga4-monitoring-service.ts`; Slack payloads in `services/slack-notify.ts`;
export in `services/ga4-monitor-export.ts`; IPC in `ipc/ga4-monitoring-ipc.ts`; UI
in `renderer/src/Ga4MonitoringPanel.tsx` (a sub-tab of GA4 Tools). The MCP tool is
`monitor_ga4_property`.

### 3.1 What a sweep does

Config is JSON-persisted; the timer is `unref()`'d. Key constants:
`MIN_INTERVAL_MINUTES = 15` (GA4 quota floor), `MAX_TARGETS = 10` per account (each
target ≈ 7 GA4 API calls), `HISTORY_KEEP = 30` run-history rows per target,
issue-log cap 50. Targets are swept **sequentially** so N properties never burst
N×7 calls at once, and one target failing never stops the rest. Per-target data is
gathered best-effort in parallel (property snapshot, data-quality counts, realtime
active users, baseline, event deltas, transactions, prior-window drift data,
campaign performance) - every query is caught individually.

Dedup is per-target, keyed `accountId:propertyId`. Each target keeps a `seenIds`
set of alert ids; only alerts not already seen fire Slack, and on restart `seenIds`
is re-seeded from the still-open issue log so a restart does not re-ping. Beyond
per-run alerts, the scheduler also sends (all per-property, with persisted stamps
so restarts don't double-send) a weekly **digest**, a weekly **audit** (the full
`runGa4AuditPipeline`), and a **monthly** report.

### 3.2 The checks (each sweep)

`data_flow` (data collection outage), `freshness` (processing lag),
`events` (key events stopped/plunged), `trend` (spike/downtrend), `growth`
(conversions not moving with sessions), `data_quality` (Unassigned / "(not set)"),
`consent_drift` (unattributed share rising vs prior), `transactions`
(duplicate/unlabelled purchases), `reconciliation` (campaign vs channel revenue
mismatch), `concentration` (Direct-spike), `untagged` (untagged traffic share),
`invalid_traffic` (engagement bimodality), `referral_hygiene` (self-referral /
referral leakage), `pii` (PII in collected values, value masked), `consent_signal`
(a live headless probe of the site's own GA4 hits for `gcs=`), `channel_shift`
(a channel's session share moving ≥15 points), `bigquery` (export missing or a link
that disappeared), and `access` (a guard that fires when every check had to skip).

Overall health is worst-wins: any critical/high → `critical`; any medium/low →
`warning`; else `healthy`.

### 3.3 Health score, gauge, and history

**Health score** = `100 − Σ penalty(alert.severity)`, clamped to [0, 100], with
`SCORE_PENALTY = { critical: 30, high: 15, medium: 7, low: 3, info: 0 }`. It is a
presentation of the run's own alerts, nothing more - deterministic and unit-tested.
The gauge card shows `score/100`, a hairline bar colored by band (≥85 success, ≥60
warning, else error), and the delta vs the previous run. The checks grid renders
each check as a tile with a status pill (Pass / Warning / Issue / Not run) and a
plain-language explainer. The history table (cap 30 rows, persisted across
restarts) shows timestamp, status, health score, critical count, warning count,
wall-clock duration, and trigger (`manual` vs `scheduled`).

### 3.4 The no-fabrication rule

Every value shown traces to a real field on the monitor run. Missing or failed
inputs degrade a check to **skip** ("No data available on this run"), never a false
alarm. The engine never invents dollar-impact, confidence scores, or percentage
bars. DebugView is only ever mentioned in recommendation text ("verify in
DebugView"), never claimed as something the monitor observed - the only live site
signal it reads is the `gcs=` consent parameter, and "no hit observed" is honestly
skipped. An all-checks-skipped run is treated as unreadable (an `access` fail),
never reported as "healthy".

The MCP tool `monitor_ga4_property` is read-only: inputs `property` (required),
`days` (default 28), `minSeverity` (default medium - the desktop tab passes `info`
to show everything).

### 3.5 Tag Watch / GA4-Spy

A companion feature that monitors the **public** `gtag/js?id=<ID>` loader for any
Measurement/tag id (competitor-capable, no login). `gtag-spy.ts` parses the
embedded config blob into a snapshot: destinations, enhanced-measurement auto-event
toggles, site-search params, key events, first-party user-data settings, email
redaction, Google Signals scope, server-container URL, session duration, linker
domains, and the full set of tag-function names (a change-detection catch-all).

Honesty rules: only fields the blob actually carries are reported; anything
unparseable degrades to `parsed:false` (never a guess), and **request-time values
(serving geo, per-request consent) are excluded** so a scan from a different network
can never fake a change. The differ returns `[]` unless both snapshots parsed, so
every reported change is a real config change.

`tag-watch-core.ts` folds each scan into a timeline (cap 50) with event kinds
`first_scan | changed | unparsed_now | reparsed | scan_error`. A clean no-change
scan advances the baseline but adds no row and no alert. The scheduler
(`tag-watch-service.ts`) supports up to 25 targets (not account-scoped, since the
data is public), scans serially, and posts a Slack alert on a real change or on a
config that stopped parsing - with a footer noting the signal is config-level, read
from public gtag.js, not runtime. The MCP tool is `spy_gtag_config`.

---

## 4. Tag Suggestions

**What it is:** a "measurement plan from a URL" - scan a live site, detect
trackable interactions, and emit ready-to-create GTM tags, each already in the exact
payload shape the create tools accept. It never clicks or submits during the scan
(read-only DOM inspection only).

**Where it lives:** across three packages.

- `apps/web-audit-mcp/` - the Playwright scanner plus the pure suggestion engine
  (`src/agent/tag-suggest/`). Exposed as MCP tools `gtm_tag_suggestions` and
  `site_pages_discover`.
- `apps/chat-orchestrator/` - the hosted-web surface (stores scans, renders rows,
  runs the create path including GA4 config standup).
- `apps/desktop/` - the desktop surface (shares the same create loop, plus its own
  variable provisioning). Also holds `shared/gtm-methodology.ts`, the LLM-facing
  prose rules.

The pipeline is: `crawlSite → (per page) collectPageRaw + scanForms →
buildSuggestInput → buildSuggestions → attachRects → TagSuggestionReport`.

### 4.1 What it detects

An in-browser collector (`collect.ts`, injected into Playwright, scanning the top
document plus same-origin iframes) classifies elements into: `email` (mailto,
including Cloudflare-obfuscated), `phone` (tel), `download` (by extension or
`download` attribute), `outbound`, `social` (follow), `share` (share/intent URLs or
copy-link controls), `cta` (known intent or a prominent styled button that passes a
promptable-text filter), and `address` (maps/directions links). It also reads page
signals: script srcs, iframe srcs, provider selectors, the distinct `dataLayer`
event names the site already pushes, framework, and a capped text sample (for
text-only phone detection).

Forms are scanned separately (`forms.ts`) with a purpose classifier (search / login
/ signup / newsletter / contact / checkout / other) and never read field values.
Form **provider** detection (`providers.ts`) covers ~20 vendors (HubSpot, Typeform,
Mailchimp, Gravity Forms, Contact Form 7, Marketo, Pardot, Salesforce, Calendly,
Jotform, Tally, and more), each matched by several independent signals. Critically,
site-wide tracking scripts are banned as form markers, because a false positive
would flip an ordinary native form from a working trigger to a dead one.

Ecommerce is auto-detected conservatively: any strong signal (add-to-cart CTA,
checkout form, or an ecommerce platform script) OR at least two distinct medium
categories where one is cart-ish. Price plus payment scripts alone (both common on
non-stores) never suffice.

### 4.2 The install plan

Each suggestion carries an **install plan** (`install-plan.ts`) describing exactly
what must exist for the tag to fire. Requirement kinds: `native` (GTM's built-in
trigger fires as-is), `provider-native` (the event is already pushed), `listener-tag`
(an auto-creatable Custom HTML listener), `html-attribute` (recommend a stable form
id), and `site-code` (a developer must add a `dataLayer.push`, with an exact
snippet). The library ships self-contained listener scripts per vendor (HubSpot,
Marketo, Contact Form 7, Gravity Forms, Ninja Forms, WPForms, Elementor, Typeform,
Calendly) plus generic submit/click delegates, and a contract (`LISTENER_DLV_KEY`)
recording which dataLayer key each listener actually pushes.

**DLV custom_event trigger scoping (coherence gating).** For embed/AJAX/JS forms the
tag fires on a custom_event trigger, and because `{{Form ID}}`/`{{Form Classes}}`
do not resolve on a pushed event, the trigger is scoped by a data-layer condition
**only when the paired listener provably pushes that exact key**. The install plan
is built first and is the single source of truth for this scope. Otherwise the
trigger falls back to a page-path scope (recoverable) rather than a condition that
can never fire. Every scope decision that dropped or replaced an identifier is
explained in the suggestion's note.

### 4.3 GA4 configuration standup (before event tags)

The engine emits a `GA4 Configuration` suggestion, and the orchestrator stands the
GA4 config up **before** any event tags: `planGa4Config` builds one Constant
(holding the Measurement ID) plus one Google tag, and points every GA4 event tag at
the Constant, so the id lives in exactly one place. The id source precedence is
entered → read from the container → placeholder. The create order is GA4 config
first, then listener tags, then event tags. And it **never blocks a create for want
of a Measurement ID**: with none entered, a placeholder Constant is created (one
edit fixes everything), so worst case is a clearly-labelled placeholder rather than
a blocked run.

### 4.4 The crawl

`scanSiteForTagSuggestions` crawls with `maxPages` default 10, cap **200**, depth 2,
and a **parallel scan** across four independent browser contexts, with a synchronous
claim guaranteeing exactly-once page assignment. A chosen page list is **not** a
crawl budget: when explicit pages are given, they are resolved (refusing non-URLs,
off-site, and URL-guard failures - all reported, not silently dropped) and scanned
up to a cap of 300, skipping the crawler entirely. A separate `site_pages_discover`
tool lists a site's pages first (from robots.txt / sitemaps, falling back to a
link-crawl) so the operator can choose which to scan. The whole path is read-only
throughout - only navigation and read-only DOM evaluation, never clicks or submits.

### 4.5 What it can create, and trigger scoping

Suggestion platforms include GA4 event, the GA4 Google tag, Meta / TikTok /
LinkedIn / Reddit / Pinterest pixels, Google Ads conversion and remarketing, and the
Conversion Linker. The web surface creates GA4 event and Custom HTML directly; the
desktop registry can create the pixel and Ads platforms too. Per-platform derivers
reuse a shared GA4 source's trigger so a pixel and its GA4 event fire on one
trigger.

The **click-condition ladder** (`trigger-strategy.ts`) picks the most durable signal
first: `{{Click ID}}` (rejecting generated ids), then `{{Click Classes}}` (word-
boundary regex, never equals/contains, rejecting generated/generic/state classes),
then `{{Click URL}}`, then `{{Click Text}}` as a last resort. Two governing facts
are documented in the code: click variables mean different things per trigger type
(so an all-clicks trigger uses `{{Click Element}}` CSS matching, since it reports
the exact node), and an empty result means "no durable signal - say so, don't invent
a condition." Forms follow a parallel scoping ladder (group-uniform Form ID → vendor
durable identity → Form Classes → page path → unscoped with a warning). Suggestions
are de-duped site-wide and ranked by confidence, with Enhanced-Measurement-covered
tags flagged so they can be de-selected but stay visible.

The chat surface's methodology prose lives in `shared/gtm-methodology.ts`
(`GA4_EVENT_SELECTION`, `GTM_CREATION_METHODOLOGY`, `GTM_TRIGGER_VARIABLE_REFERENCE`,
`GTM_DECISION_RULES`), which keeps the LLM aligned with the deterministic engine.

---

## 5. Tag Verification

**What it is:** proof that a container's **existing** tags actually fire - because
writing a tag is not proof it fires. It drives a real browser over a site, exercises
each tag's trigger, and observes whether the tag fired, without ever delivering a
real analytics hit.

**Where it lives:** two distinct subsystems.

- **Desktop "Tag Verification" tab** - verifies a live GTM container's published
  tags by driving Playwright. Files in `apps/desktop/src/main/suggestions/`:
  `container-verify.ts`, `verify-driver.ts`, `verify-routing.ts`, `verify-tags.ts`,
  `ta-driver.ts` / `ta-stream.ts` (Tag Assistant), `tag-monitor.ts` (GTM Monitor).
- **TagDrishti verify engine** - `apps/web-audit-mcp/src/verify/`, a headless,
  spec-driven, deterministic assertion engine with a `samarth-verify` CLI and an MCP
  tool.

### 5.1 The desktop flow and its safety model

**Abort-first.** A request classified as an analytics collector is **captured and
then aborted - never delivered**, so verification never sends a real hit to GA4,
Meta, or the tagging server. Navigations and real form POSTs are neutralised
in-page. Each page is driven in its own browser context; after the container loads,
a per-worker "armed" flag treats every cross-site beacon as a tag firing to
capture + abort.

**Multi-page drive.** Up to 120 pages via a bounded worker pool (concurrency cap 5).
Because GTM click triggers are site-wide with no page notion, `routeTagsToPages`
re-points each click/link tag to the crawled page where its control actually exists
(keeping the homepage when the control is in site chrome).

**Condition-aware custom_event push.** When many tags share one `form_submission`
event split by `{{form_name}}`/`{{form_id}}`, the driver resolves each tag's extra
ANDed conditions into a synthetic dataLayer push that satisfies the right tag. Only
positive equals/contains/startsWith/endsWith conditions on a resolvable Data Layer
Variable are usable; negated/regex/CSS conditions keep the tag inconclusive rather
than wrongly proven.

**Pixel/Meta beacon detection.** A non-GA4 pixel can't be decoded, so a network
beacon to the tag's own vendor host proves firing. Vendor matching is
specific (Meta → facebook.com/tr, plus TikTok, LinkedIn, Reddit, Pinterest,
Snapchat, Hotjar, Google Ads) to prevent cross-crediting. A specific-vendor pixel
with no browser beacon but a first-party sGTM relay is treated as
inconclusive/server-relay, not a failure.

### 5.2 The three capture methods

1. **GTM Monitor `addEventCallback`** (`tag-monitor.ts`) - **the authoritative
   per-tag firing signal**: the same signal Tag Assistant uses, but read in the
   browser we control, with no Tag Assistant UI and no publish. It uses Simo
   Ahava's published "GTM Monitor" community template (imported from the gallery),
   which GET-pixels each event's fired tags to a placeholder endpoint the verify
   driver captures and aborts, then decodes per-tag id / name / status (worst status
   wins). Documented and stable.
2. **Tag Assistant postMessage debug stream** (`ta-driver.ts` / `ta-stream.ts`) - 
   the other authoritative "read from the real container" path: automates the manual
   Tag Assistant flow with zero GTM writes, capturing the undocumented postMessage
   debug frames. Requires a signed-in Google session.
3. **Beacon / network detection** - the fallback for pixels (GA4 decoded by
   `/collect` event name, pixels proven by vendor beacon host).

### 5.3 The TagDrishti verify engine

A headless, fact-producing engine (not scoring) in four separated layers: capture
(headless Chromium, drives consent + journeys, records GA4 hits, dataLayer, cookies,
with a response-based settle window rather than a fixed sleep), a **pure assertion
engine** (a deterministic function of capture + spec - no browser, no I/O, no
clock), a journey runner, and a reporter/CLI.

The **seven checks** (dispatch table in `assert/engine.ts`):

| `type` | Passes when |
|---|---|
| `event_fired` | The event + Measurement ID hit fired with all params matching. |
| `param_validation` | Event fired and its parameters match. |
| `event_on_interaction` | The action ran and produced a matching hit. |
| `consent_mode` | No pre-consent GA4 hit unless `gcs` is denied, and no analytics/ads cookies before consent; states match. |
| `duplicate_event` | Event count is within the allowed number. |
| `tracker_present` | At least one request reached the tracker. |
| `cross_domain_linker` | The `_gl` linker parameter is present on the destination. |

Four statuses - Pass, Partial, Fail, **Not Verified** - and "Not Verified is never a
guessed Pass/Fail." The `samarth-verify` CLI is an explicit local operator
invocation. The MCP `verify` tool performs real form submits, so it is registered
**only when `WEB_AUDIT_ENABLE_VERIFY=true`** (default off). Server-side verification
(Meta CAPI, server-side GTM, Measurement Protocol) is a **documented non-goal** with
an empty stub that throws - nothing in the output ever claims server-side coverage.

### 5.4 Container preflight gate

Before verifying, `container-preflight.ts` detects the live GTM container on the page
(`detectLiveContainers`, SSRF-guarded) and compares it to the selected id
(`preflightDecision` → `match | missing | mismatch`). On **match** it proceeds
straight into verifying the live container. On **missing** or **mismatch** it renders
a Proceed/Cancel gate; on Proceed it injects the selected container into the driven
session only.

### 5.5 Real-submit form verification

Operator-driven: fetch the form's own fields, propose an editable US-default fill
plan (nothing is filled or submitted until the operator approves), then submit for
real and check firing. Its safety model is **deliberately different** - the form's
own POST (to the site/CRM) is allowed through (it creates a real lead, behind an
explicit warning), but analytics collectors, including any GA4 Measurement Protocol
`/g/collect`, are still captured and aborted. A synthetic dataLayer push is flagged
`synthetic` and shows as "Config OK"; form tags are never synthetically driven - 
they are verified only by a real submit. Form↔tag pairing (`form-tag-match.ts`)
matches container form tags to site forms, most-specific-first (form name → tag name
→ event name), using page-path scope as the discriminator when names are generic,
and collapses matched forms into one de-duplicated data-entry set.

### 5.6 Verdicts, the 3-way split, and exports

Verdict buckets: **Fired** (a real fire), **Config OK** (a synthetic push verified
config), **Server-side** (a first-party relay), **Untested** (inconclusive), and
**Issue** (a genuine non-fire). The **3-way inconclusive split** is what keeps a CTA
on another page or an un-submitted form from being mislabelled "not firing": a
not-fired tag is split into fired, inconclusive-because-not-exercised (target not
found / event never happened / form condition not supplied), and a genuine non-fire
with an actionable reason. In the heal flow these become `fixable` (has a suggested
trigger), `untestable` (inconclusive, no suggestion), and `needsYou`.

Results export to CSV (rows only), PDF/DOC (a client-facing numbered list of fired
tags with embedded proof screenshots and a GA4 event-name column), a zero-dependency
DOCX (with real embedded image parts that survive a Google Docs upload), and XLSX
(with proof images anchored into a Proof cell). Proof images are per-tag screenshots
with the driven control ringed. Authoritative runs (via the GTM Monitor path) are
marked as such in the export.

---

## Cross-cutting design notes

- **House style.** No em dashes anywhere - chat, UI, audit output, and every export
  boundary (PDF/CSV/MD/XLSX/DOC) strip them.
- **Guardrails.** The MCP server is read-only by default; GTM writes/publishes/
  deletes and GA4 Admin writes are gated behind environment flags (all default
  `false`) plus `confirm=true`. Auditing, monitoring, suggesting, and verifying
  never require any write flag.
- **Shared engines can't disagree.** The GA4 anti-lie detectors are shared between
  the audit and the monitor; the monitor's weekly audit runs the same
  `runGa4AuditPipeline`; the Consent Mode v2 engine is the single source of truth for
  both the desktop B6 gate and the portal auditor. This is deliberate: one code path
  means the two surfaces can never contradict each other.
