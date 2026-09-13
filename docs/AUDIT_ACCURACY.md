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

## Structured evidence (`evidence[]`)

Every finding carries a structured `evidence: EvidenceItem[]` array, produced by
`normalizeFindingAccuracy`. Each row restates the finding's *provenance* as a
short, source-scoped fact rather than a prose claim:

```ts
interface EvidenceItem {
  source: AuditSourceFlag;   // CONFIG | RUNTIME | SGTM | GA4_ADMIN | DATA_API
  label: string;             // e.g. "Tag", "Parameter", "Source"
  value?: string;            // short value (truncated to ≤160 chars)
  entityPath?: string;       // e.g. tag/trigger path or captured page path
  parameter?: string;        // the GTM parameter key in question
  confidence?: AuditConfidence;
}
```

Guarantees:

- **Always present.** If a rule supplies explicit evidence it is preserved;
  otherwise the normalizer derives an evidence floor from the finding's
  `sources` / `entity` / `parameter` so `evidence[]` is never empty.
- **Short and safe.** Values are truncated (`shortValue`, ≤160 chars). We never
  dump raw container JSON, full hit bodies, or PII into evidence.
- **Source-scoped.** Each row names the source it came from, so a reader can see
  *why* a finding is `CONFIG`-only vs proof-backed at a glance. In a CONFIG-only
  run, every evidence row is itself `CONFIG`-sourced.

The full-audit route (`audit.ts`) and the consent route (`consent-audit.ts`) both
emit `evidence[]`; the consent route also keeps its legacy `evidence?: string[]`
snippets for backward compatibility under a separate `evidenceItems` field.

## Surfacing accuracy adjustments in the UI

When the normalizer tightens a finding it records *why*, so the portal can show
the reader that a number was deliberately conservative (never inflated):

- `confidenceDowngraded: boolean` — set only when the caller-supplied confidence
  was actively lowered (e.g. a CONFIG-only finding that asked for `high`). The
  audit and Consent Mode v2 pages render the confidence badge with a `↓` marker,
  amber styling, and a tooltip explaining the cap.
- `accuracyNotes: string[]` — plain-language notes (e.g. *"Config-only finding:
  capped at medium confidence"*, *"Wording implies runtime behaviour but no
  capture backs it — flagged for manual review"*). Rendered by the shared
  `AccuracyNotes` component as an amber-bordered note box beneath the finding.

These are presentational only — they describe tightening the normalizer already
applied. They never change the stored severity/confidence a second time.

## Coverage states

The coverage matrix reports, per capability, whether the run actually covered it:

- `covered` — every required source was connected and read.
- `partial` — some but not all required sources were connected (honest gap).
- `not_covered` — a required source was absent; the capability was **not** checked.

A missing API/tool produces a **coverage gap**, never an inferred finding. When
`CONFIG` is the only connected source the executive summary carries an explicit
single-source warning: *"A clean result from a single source is not a clean
audit."*

Each non-`covered` coverage row carries a `whyNotCovered` string written in
positive-action language: *what evidence would close the gap and why it matters*
(e.g. *"Import a runtime capture to observe live tag firing order — config alone
shows intent, not sequence."*). The portal renders this beneath any `partial` /
`not_covered` row so the gap reads as an actionable next step, not a dead end.

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

## Golden fixtures & snapshot tests

The accuracy invariants are locked end-to-end by a golden suite
(`apps/portal/shared/__tests__/audit-snapshot.node.test.ts`, run via
`npm run test:snapshot`, also chained into `npm test`).

- **Synthetic fixtures only.** The fixtures in
  `apps/portal/shared/__tests__/fixtures/anonymized-containers.ts` are
  hand-authored to mirror the *shapes* of real GTM exports (tag types, parameter
  keys, trigger ids, consent settings) **without reproducing any real account's
  contents**. Public ids use the reserved `GTM-XXXXXXX` / `G-XXXXXXX` placeholder
  forms and all names are generic. **No real client data is ever committed.**
- **Real cores, not mocks.** Fixtures are fed through the actual shared engine
  (`runConsentAudit`) and the actual normalizer (`normalizeFindingAccuracy`) —
  the same pure cores the production routes call — so the test exercises real
  behaviour, not a stubbed approximation.
- **Invariant assertions, not brittle blobs.** Rather than committing a raw
  response snapshot (which churns on timestamps and ordering), the suite asserts
  a normalized projection and the load-bearing invariants: findings are
  source-scoped, a CONFIG-only run caps confidence at `medium` and makes no
  observed-runtime headline claims (unless flagged for manual review), structured
  `evidence[]` is always present and short/safe, high confidence requires a
  `RUNTIME` source, and normalization is idempotent (stable output).

## Public-SaaS quality bar

1. Every finding carries its source(s), confidence, and (where applicable) entity,
   parameter, and evidence.
2. Config-only audits never produce runtime claims.
3. Runtime and cross-source claims require runtime artifacts or a second source.
4. A missing source is a coverage gap, not an inferred finding.
5. When in doubt, downgrade to manual review / low confidence rather than assert.
