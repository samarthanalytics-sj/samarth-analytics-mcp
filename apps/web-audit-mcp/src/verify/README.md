# TagDrishti Tag Verification Engine

A headless engine that proves whether GA4/GTM tags **actually fire** — and fire
correctly — after they've been written into a container. Writing a tag is not
proof it fires; this loads the real site in Chromium, drives consent + user
journeys, captures what actually happened (GA4 hits, dataLayer, cookies), and
returns a **deterministic per-check verdict** with evidence.

It is **fact-producing, not scoring**. The output is structured so the GA4
scoring engine (`audit_brain`) *could* consume it later (see
`report/scorecard-adapter.ts`), but this engine never imports or couples to it.

## Usage (CLI)

```bash
# from the repo root (uses the root tsx), or the installed bin `samarth-verify`
tsx apps/web-audit-mcp/src/verify/cli.ts --spec spec.json [--url https://site.com] \
    [--headed] [--out report.json] [--settle-quiet 2000] [--settle-max 10000] \
    [--allowlist example.com]
```

- JSON report → `--out` file, or stdout.
- Human-readable summary → stderr.
- Exit code `1` when `overall` is `Fail`, else `0` (`2` bad args/spec, `3` Playwright missing).

Playwright + Chromium are required for a live run:
`npm i playwright && npx playwright install chromium`.

## Usage (MCP tool)

The engine is also exposed as a single `verify(url, spec)` MCP tool on the
web-audit server, **gated behind `WEB_AUDIT_ENABLE_VERIFY=true`** (off by
default — see the safety note below).

## Spec format

```jsonc
{
  "url": "https://example.com",
  "measurementIds": ["G-XXXXXXX"],          // optional tid constraint for ga4 checks
  "expectedTrackers": ["ga4", "meta_pixel", "clarity"],
  "consent": {                               // optional two-phase consent flow
    "acceptSelector": "#cmp-accept",
    "rejectSelector": "#cmp-reject",
    "mode": "accept",                        // which control to click (default accept)
    "checkPreConsent": true
  },
  "settle": { "quietMs": 2000, "maxMs": 10000 },  // optional settle-window overrides
  "checks": [
    { "id": "ga4_pageview", "type": "event_fired", "tracker": "ga4",
      "event": "page_view", "phase": "post_consent", "params": { "ep.page_type": "home" } },
    { "id": "cta_click", "type": "event_on_interaction", "event": "cta_click",
      "action": { "click": "#hero-cta" } },
    { "id": "purchase_value", "type": "param_validation", "event": "purchase",
      "params": { "epn.value": 9.99, "ep.currency": "USD" } },
    { "id": "consent", "type": "consent_mode",
      "expectedDefault": { "analytics_storage": "denied" },
      "expectedUpdate":  { "analytics_storage": "granted" } },
    { "id": "no_dupe_purchase", "type": "duplicate_event", "event": "purchase",
      "allowedCount": 1, "keyParams": ["ep.transaction_id"] },
    { "id": "clarity_present", "type": "tracker_present", "tracker": "clarity" },
    { "id": "linker", "type": "cross_domain_linker", "expectedDomains": ["shop.example.com"] }
  ]
}
```

The spec is validated on load (Zod); an invalid spec is rejected with the exact
JSON path and reason. `specHash` in the report is the sha256 of the spec
canonicalised with stable key ordering.

Param assertion values: a **string/number** means exact match (`epn.*`/`upn.*`
are compared numerically), and **`true`** means "present with any value".

### The seven checks

| type | Pass | Partial | Fail | Not Verified |
|---|---|---|---|---|
| `event_fired` | event+tid hit, all params match | hit but params wrong/missing | no matching hit | page/tag-manager didn't load |
| `event_on_interaction` | action ran → matching hit | hit but params wrong | selector missing / no hit | step not run / page didn't load |
| `param_validation` | event fired + params match | event fired, params wrong | event never fired | page didn't load |
| `consent_mode` | pre-consent denied + states match | — | pre-consent firing / cookies / state mismatch | ambiguous consent timing |
| `duplicate_event` | count ≤ allowed | — | count > allowed | page didn't load |
| `tracker_present` | ≥1 request to the tracker | — | tracker never loaded | page didn't load |
| `cross_domain_linker` | `_gl` on destination | — | `_gl` absent | no testable link found |

`consent_mode` runs the two pre-consent sub-checks: (a) no GA4 hit fires before
the consent action unless its `gcs` shows analytics storage denied; (b) no
analytics/ads cookies (`_ga`, `_gid`, `_fbp`, …) are set pre-consent.

## The four statuses

`Pass` · `Partial` · `Fail` · `Not Verified`. Every `Fail`/`Partial` carries a
`reason`; evidence embeds the actual captured hits. `overall` = `Fail` if any
check Fails; else `Partial` if any Partial; else `Not Verified` only when
nothing could be verified; otherwise `Pass`.

**Not Verified is never a guessed Pass/Fail.** When the tool can't get a stable
read (navigation failure, tag manager absent, capture never settled, ambiguous
consent timing) it returns Not Verified rather than guessing.

## Determinism

No fixed sleeps as the primary wait — capture stops when no new GA4 collect
arrives for `quietMs` (default 2000) or a hard cap `maxMs` (default 10000) is
reached. Every hit carries a monotonic ms offset from navigation start. The same
`engineVersion` + spec + site state yields identical per-check verdicts; raw
timestamps are informational and excluded from that guarantee.

**Headless caveat:** Chromium runs in the new headless mode. Some sites detect
headless and some tags gate on visibility, so `--headed` results can differ from
headless. Prefer headless for reproducibility; use `--headed` for debugging.

## Scope & non-goals (do not fake these)

**In scope (v1, client-side / browser-observable only):** GA4 hit capture +
param validation, Consent Mode v2 + pre-consent firing, duplicate events,
event-on-interaction (trigger verification), missing-tracker detection,
cross-domain linker.

**Explicit non-goals:**
- **Server-side hit verification** (Meta CAPI, server-side GTM, Measurement
  Protocol `/mp/collect`). These are server-to-server and cannot be seen from a
  browser. `server-side.ts` is a clearly-separated, unimplemented interface for a
  future verifier (Stape log ingestion / platform test-event codes). **Nothing in
  the output ever claims server-side coverage.**
- **Interactive element picker / visual tagging** — a different product surface.
- **Scoring / renormalisation** — that is `audit_brain`'s job.

## Architecture (four separated layers)

1. **Capture** (`capture/`) — launches Chromium, drives consent + journeys,
   records GA4 hits (GET + batched POST), dataLayer, cookies. Knows nothing about
   checks.
2. **Assertion engine** (`assert/`) — a **pure** function of `(CaptureResult,
   spec)`. No browser. This is what makes determinism testable.
3. **Journey runner** (`capture/journey.ts`) — click / submit / navigate /
   consent steps.
4. **Reporter + CLI** (`report/`, `cli.ts`) — JSON + human summary; the MCP
   wrapper (`mcp-tool.ts`) is the thin fifth layer.

Reuses web-audit-mcp's Playwright launch, SSRF guard, CMP-click, and dataLayer
hook rather than duplicating them; the POST-body capture, settle window, full
per-hit param parse, `gcs`/`gcd` decode, `_gl` linker, and `clarity.ms`
detection are new here.

## ⚠️ Interaction safety

Unlike the rest of the web-audit server (which only ever clicks a consent
banner and never submits forms), the `verify` engine performs the operator's
spec-supplied interactions **including real form submits**. The MCP `verify`
tool is therefore off by default behind `WEB_AUDIT_ENABLE_VERIFY=true`; the CLI
is an explicit local operator invocation. Only run it against sites you are
authorised to test.

## Tests

- Pure, offline (in root `npm test` via `test:verify`): `ga4-hits`,
  `consent-signals`, `spec-schema`, `assert-engine` (positive + negative for all
  seven checks), `report`, `determinism` (5× identical verdicts).
- Browser-backed (needs Chromium; self-skips otherwise):
  `npm --prefix apps/web-audit-mcp run test:verify:browser` — end-to-end against
  offline HTML fixtures.
- Live smoke (env-gated): `VERIFY_LIVE_URL=… tsx …/live-smoke.browser.test.ts`.
