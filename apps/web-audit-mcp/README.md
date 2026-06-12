# Samarth Web Audit MCP

An MCP server with a **site-audit agent inside**: point it at a website and it
crawls the pages with headless Chromium (Playwright), inventories every form,
finds and **interacts with the consent banner (CMP)**, and produces a
GDPR/ePrivacy + Google Consent Mode v2 compliance report — using the same
consent engine (`apps/portal/shared/consent-audit.ts`) that powers the Samarth
portal and its 170-case test suite.

Think "Playwright MCP", but instead of generic browser remote-control it ships
an opinionated audit agent: one tool call → crawl → forms → banner scenarios →
scored findings.

## Tools

| Tool | What it does |
| --- | --- |
| `consent_compliance_audit` | **The agent.** Crawl → form scan → banner detection → `ignore`/`reject`/`accept` scenarios in isolated contexts → merged findings + 0–100 score. Start here. |
| `site_crawl` | Same-site BFS crawl (form-heavy pages prioritised); titles, statuses, form counts, CMP hints. |
| `forms_scan` | Per-page form inventory: fields + labels, PII categories (email/phone/name/address/DOB/gov-ID/payment), marketing opt-ins and their default state, privacy issues. |
| `consent_banner_detect` | Identify the CMP (OneTrust, Cookiebot, Usercentrics, Didomi, Quantcast/TCF, TrustArc, Complianz, CookieYes, Iubenda, Osano, Termly, consentmanager, Borlabs, Klaro, tarteaucitron + generic heuristic) and its accept/reject/settings controls — without clicking. |
| `consent_scenario_capture` | Load one page under `ignore` / `accept` / `reject` and capture tracker hits (ms-timed vs. the banner click), Consent Mode v2 events, cookies before/after, console errors. |

### What the findings catch

- **Tags firing before any consent choice** (critical) — with GA4 "advanced
  consent mode" cookieless pings (`gcs=G1xx` denied) correctly downgraded to info.
- **Tags firing after an explicit Reject** (critical).
- **Tracking cookies set pre-consent or surviving a reject** (high).
- **No CMP at all while trackers fire** (high).
- **No "Reject all" on the first banner layer** (medium — EDPB/CNIL dark-pattern guidance).
- **CMP not wired to Consent Mode v2** (no default/update events; medium).
- **Form issues**: pre-ticked marketing opt-ins (high), PII collection without a
  privacy notice/consent control (medium), forms posting PII to third-party
  domains or over plain HTTP.
- Everything the shared Consent Mode v2 **runtime engine** flags on the capture.

## Safety model

- **Read-only toward the audited site.** Forms are inspected, never filled or
  submitted. The *only* interaction the agent performs is clicking the consent
  banner's accept/reject controls, inside an ephemeral browser context that is
  discarded afterwards.
- **SSRF guard** (same rules as the runtime worker): loopback, RFC-1918,
  CGNAT, link-local/cloud-metadata and encoded-IP forms are always blocked —
  for the start URL, every redirect, and every subresource.
- **Budgets**: hard caps on pages (25), depth (4), timeouts and settle times.

## Setup

```bash
# from the repo root (uses the root node_modules for SDK/zod/tsx)
npm --prefix apps/web-audit-mcp run build

# Playwright is an optional dependency — install once for browser-backed tools:
npm i playwright
npx playwright install chromium
```

Claude Desktop / CLI config (stdio):

```json
{
  "mcpServers": {
    "samarth-web-audit": {
      "command": "node",
      "args": ["F:/samarth-analytics-mcp-main/apps/web-audit-mcp/dist/web-audit-mcp/src/index.js"],
      "env": { "WEB_AUDIT_ALLOWLIST": "yourclient.com" }
    }
  }
}
```

> Like the runtime worker, this needs a real browser host (local machine,
> Render/Fly/Railway/VPS). **Not deployable to Vercel serverless.**

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_AUDIT_ALLOWLIST` | *(unset = any public host)* | Comma-separated host suffixes the server may audit. |
| `WEB_AUDIT_MAX_PAGES` | `10` (cap 25) | Crawl page budget. |
| `WEB_AUDIT_MAX_DEPTH` | `2` (cap 4) | Crawl depth. |
| `WEB_AUDIT_NAV_TIMEOUT` | `30000` (cap 60000) | Per-page navigation timeout (ms). |
| `WEB_AUDIT_SETTLE_MS` | `3000` (cap 10000) | Post-load wait for tags to fire (ms). |
| `WEB_AUDIT_DISABLE_INTERACTION` | `false` | `true` forbids banner clicking (detection still works). |
| `WEB_AUDIT_HEADED` | `false` | `true` runs a visible browser (local debugging). |

## Development

```bash
npm run webaudit:check    # typecheck (from repo root)
npm run test:webaudit     # pure-logic test suite — no browser needed
```

Tip: pair with the GTM MCP server (`samarth-gtm-mcp`) — export the container
config there, audit the live site here, and reconcile configured consent
settings against observed runtime behaviour.
