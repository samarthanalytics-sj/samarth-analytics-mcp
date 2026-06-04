# Audit Accuracy Model

This document describes how the audit (`apps/portal/api/gtm/audit.ts`, the Consent
Mode v2 engine in `apps/portal/shared/consent-audit.ts`, and the dedicated
`apps/portal/api/gtm/consent-audit.ts`) decides **what it is allowed to claim**.

For a public SaaS the dominant risk is not "too few findings" — it is **false
confidence**: presenting a config-only inspection as if it proved live behaviour.
Every rule in the audit is therefore evidence-scoped. The invariants below are
enforced in code by the pure normalizer `apps/portal/shared/audit-accuracy.ts`
(`normalizeFindingAccuracy`), which every finding passes through, and are guarded
by the regression suite `apps/portal/shared/__tests__/audit-accuracy.node.test.ts`.

## Evidence sources

Each finding declares one or more `sources`. A source is only present when the
caller supplied the matching input **and** at least one read/parse succeeded —
sources are never fabricated.

| Source      | What it proves                                              | Where it comes from                                  |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `CONFIG`    | GTM **configuration intent** (tags/triggers/variables)     | GTM API v2 workspace read (always present)           |
| `RUNTIME`   | **Observed** behaviour on a real page load                 | Uploaded runtime-worker capture (≥1 parsed page)     |
| `SGTM`      | Server container config / clients / transformations        | A selected, readable server container                |
| `GA4_ADMIN` | GA4 property settings (streams, dimensions, retention, …)  | GA4 Admin API (read-only)                            |
| `DATA_API`  | **Reported** event volumes over a window                   | GA4 Data API (read-only)                             |

`CONFIG` is intent, not proof. Only `RUNTIME` proves a tag actually fired,
double-fired, or sent data on a live page.

## Confidence levels

| Confidence | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `high`     | Backed by a proof source (`RUNTIME` / `SGTM` / `GA4_ADMIN`).             |
| `medium`   | Config-only structural fact, or a reported-data signal.                 |
| `low`      | Needs manual review — evidence is incomplete or indirect.               |

Rules enforced by `normalizeFindingAccuracy`:

1. **Evidence-field guarantee** — every finding has non-empty `sources` and a
   defined `confidence`.
2. **CONFIG-only confidence cap** — a finding whose only source is `CONFIG` is
   capped at `medium`. Configuration intent is never "high confidence".
3. **Severity downgrade on incomplete evidence** — a `high`/`critical` finding
   that is CONFIG-only **and** flagged `needsManualReview` is downgraded to
   `medium` with `low` confidence. Multi-source / runtime findings (which carry
   proof) are left untouched.
4. **Runtime-wording guard** — if a finding's text makes a runtime claim
   ("fires", "double-fires", "sends … on every", …) but `RUNTIME` is not among its
   sources, it is forced to `needsManualReview`. This is a drift safety-net; rule
   copy is also written to be evidence-accurate at the source.

The normalizer only ever **tightens** (downgrades). It never invents a higher
severity or stronger confidence than a rule asked for, and it never edits a
finding's id, category, or text — so response shapes stay backward-compatible.

## Coverage states

The coverage matrix reports, per capability, whether the run actually covered it:

- `covered` — every required source was connected and read.
- `partial` — some but not all required sources were connected (honest gap).
- `not_covered` — a required source was absent; the capability was **not** checked.

A missing API/tool produces a **coverage gap**, never an inferred finding. When
`CONFIG` is the only connected source the executive summary carries an explicit
single-source warning: *"A clean result from a single source is not a clean
audit."*

## What stays manual

Some checks cannot be fully proven from any source this product reads:

- **Meta Pixel ↔ CAPI deduplication (eventID)** — even with `RUNTIME` + `SGTM`,
  final dedup proof requires **Meta Events Manager**. These findings stay
  `needsManualReview` and never resolve to high confidence.
- **Tag firing & order, live dataLayer sequence, consent-state matrix, ecommerce
  shape** — require a `RUNTIME` capture; without one they are `not_covered`.

## GA4 Data API zero-activity wording

When a GTM-configured GA4 event reports zero events over the window, the finding
is phrased as **"reported zero events in the last N days"** — a statement about
*reported activity in the selected window*, not a runtime "the tag is not firing"
claim. The event may be rare, seasonal, or recently deployed. The finding carries
`CONFIG` + `DATA_API` and `needsManualReview`.

## Tradeoffs

- **Fewer findings vs lower false positives.** We accept surfacing fewer, better-
  qualified findings rather than inflating the count with runtime guesses drawn
  from config. A config-only audit is explicitly framed as incomplete.
- **Config intent vs runtime reality.** CONFIG tells us how the container is
  *set up*, not what *happens* in a browser. The two are reconciled only when a
  runtime capture is imported; until then runtime claims are withheld.
- **Manual proof needs.** The most consequential marketing checks (Pixel/CAPI
  dedup) require third-party consoles. We mark these manual rather than implying
  we verified them.

## Public-SaaS quality bar

1. Every finding carries its source(s), confidence, and (where applicable) entity,
   parameter, and evidence.
2. Config-only audits never produce runtime claims.
3. Runtime and cross-source claims require runtime artifacts or a second source.
4. A missing source is a coverage gap, not an inferred finding.
5. When in doubt, downgrade to manual review / low confidence rather than assert.
