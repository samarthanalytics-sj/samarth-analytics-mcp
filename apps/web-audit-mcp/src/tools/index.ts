/**
 * Web-audit tool registry. All tools are read-only with respect to the
 * audited site's data — the only interaction the agent ever performs is
 * clicking consent-banner accept/reject controls inside an ephemeral,
 * cookie-isolated browser context. Forms are inventoried, never submitted.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult, errorText, type ToolResult } from '../utils/toolResponse.js';
import { loadConfig, clampOpt } from '../utils/config.js';
import { urlAllowed } from '../utils/urlGuard.js';

const urlField = z
  .string()
  .url()
  .describe('Absolute http(s) URL of the page/site to audit, e.g. "https://www.example.com".');

/** Admission check shared by every tool: allowlist + SSRF guard. */
function admit(url: string): ToolResult | null {
  const config = loadConfig();
  const verdict = urlAllowed(url, config.allowlist);
  if (!verdict.ok) return errorText(`URL rejected: ${verdict.reason}`);
  return null;
}

async function withBrowser<T>(fn: (browser: import('../agent/browser.js').PwBrowser) => Promise<T>): Promise<T> {
  const { loadPlaywright, PlaywrightMissingError } = await import('../agent/browser.js');
  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightMissingError();
  const browser = await pw.chromium.launch({ headless: loadConfig().headless });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

export function registerAllTools(server: McpServer): void {
  // ── site_crawl ────────────────────────────────────────────────────────────
  server.registerTool(
    'site_crawl',
    {
      description:
        'Crawl a website starting from a URL (same-site BFS, form-heavy pages prioritised). ' +
        'Returns each visited page with title, HTTP status, form count, link count, and whether a ' +
        'consent banner was spotted. Read-only; bounded by maxPages/maxDepth and a private-network guard.',
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().positive().optional()
          .describe('Page budget (default 10, hard cap 25).'),
        maxDepth: z.number().int().positive().optional()
          .describe('Link depth from the start URL (default 2, hard cap 4).'),
      }),
    },
    async ({ url, maxPages, maxDepth }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      try {
        const config = loadConfig();
        const { crawlSite } = await import('../agent/crawler.js');
        const result = await withBrowser((browser) =>
          crawlSite(browser, url, {
            maxPages: clampOpt(maxPages, config.maxPages, config.maxPagesCap),
            maxDepth: clampOpt(maxDepth, config.maxDepth, config.maxDepthCap),
            navTimeoutMs: config.navTimeoutMs,
            allowlist: config.allowlist,
          }),
        );
        return jsonResult(result);
      } catch (err) {
        return errorResult('site_crawl', err);
      }
    },
  );

  // ── forms_scan ────────────────────────────────────────────────────────────
  server.registerTool(
    'forms_scan',
    {
      description:
        'Visit one page and inventory every form: fields with labels/types, detected PII categories ' +
        '(email, phone, name, address, DOB, government ID, payment), marketing opt-in checkboxes and their ' +
        'default state, consent/privacy indicators — plus privacy issues (pre-ticked opt-ins, PII without ' +
        'notice, third-party or insecure form actions). Forms are inspected only, never filled or submitted.',
      inputSchema: z.object({ url: urlField }),
    },
    async ({ url }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      try {
        const config = loadConfig();
        const { captureScenario } = await import('../agent/capture.js');
        const capture = await withBrowser((browser) =>
          captureScenario(browser, url, 'ignore', {
            navTimeoutMs: config.navTimeoutMs,
            settleMs: config.settleMs,
            scanForms: true,
          }),
        );
        return jsonResult({
          url: capture.finalUrl ?? url,
          httpStatus: capture.httpStatus,
          formsFound: capture.forms?.length ?? 0,
          forms: capture.forms ?? [],
          notes: capture.notes,
        });
      } catch (err) {
        return errorResult('forms_scan', err);
      }
    },
  );

  // ── consent_banner_detect ─────────────────────────────────────────────────
  server.registerTool(
    'consent_banner_detect',
    {
      description:
        'Detect the consent banner (CMP) on a page without touching it. Identifies the vendor ' +
        '(OneTrust, Cookiebot, Usercentrics, Didomi, Quantcast/TCF, TrustArc, Complianz, CookieYes, ' +
        'Iubenda, Osano, Termly and more, plus a generic heuristic for custom banners), the ' +
        'accept/reject/settings controls, and whether Reject is available on the first layer. ' +
        'Also reports trackers and tracking cookies observed pre-consent.',
      inputSchema: z.object({ url: urlField }),
    },
    async ({ url }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      try {
        const config = loadConfig();
        const { captureScenario } = await import('../agent/capture.js');
        const capture = await withBrowser((browser) =>
          captureScenario(browser, url, 'ignore', {
            navTimeoutMs: config.navTimeoutMs,
            settleMs: config.settleMs,
          }),
        );
        return jsonResult({
          url: capture.finalUrl ?? url,
          httpStatus: capture.httpStatus,
          cmp: capture.cmp,
          preConsent: {
            trackerHits: capture.trackerHits.length,
            consentEvents: capture.consentEvents,
            cookies: capture.cookiesPreInteraction,
          },
          notes: capture.notes,
        });
      } catch (err) {
        return errorResult('consent_banner_detect', err);
      }
    },
  );

  // ── consent_scenario_capture ──────────────────────────────────────────────
  server.registerTool(
    'consent_scenario_capture',
    {
      description:
        'Load a page under one consent scenario and capture the evidence: "ignore" (never touch the ' +
        'banner), "accept" (click accept-all) or "reject" (click reject-all). Returns tracker hits with ' +
        'millisecond timing relative to the banner click, Consent Mode v2 default/update events, cookies ' +
        'before/after interaction, and console/page errors. Each capture runs in a fresh, isolated ' +
        'browser context. Clicking is limited strictly to the consent banner.',
      inputSchema: z.object({
        url: urlField,
        scenario: z.enum(['ignore', 'accept', 'reject'])
          .describe('Consent scenario to exercise.'),
      }),
    },
    async ({ url, scenario }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      const config = loadConfig();
      if (scenario !== 'ignore' && !config.interactionEnabled) {
        return errorText(
          'Banner interaction is disabled (WEB_AUDIT_DISABLE_INTERACTION=true). Only the "ignore" scenario is available.',
        );
      }
      try {
        const { captureScenario } = await import('../agent/capture.js');
        const capture = await withBrowser((browser) =>
          captureScenario(browser, url, scenario, {
            navTimeoutMs: config.navTimeoutMs,
            settleMs: config.settleMs,
          }),
        );
        return jsonResult(capture);
      } catch (err) {
        return errorResult('consent_scenario_capture', err);
      }
    },
  );

  // ── consent_compliance_audit ──────────────────────────────────────────────
  server.registerTool(
    'consent_compliance_audit',
    {
      description:
        'Run the full audit agent against a website: crawls same-site pages, inventories forms, ' +
        'detects the consent banner, exercises it under ignore/reject/accept scenarios in isolated ' +
        'browser contexts, and produces a compliance report with a 0–100 score. Findings combine ' +
        'banner-behaviour rules (tags firing before consent, tags firing after Reject, tracking cookies ' +
        'pre-consent, missing first-layer Reject), form privacy rules, and the shared Consent Mode v2 ' +
        'engine. Pass gtmContainer to reconcile the configured GTM container against observed runtime ' +
        'behaviour ("reconciled" coverage). This is the recommended one-call entry point; use the focused ' +
        'tools to drill in.',
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().positive().optional()
          .describe('Crawl page budget (default 10, hard cap 25).'),
        maxDepth: z.number().int().positive().optional()
          .describe('Crawl depth (default 2, hard cap 4).'),
        capturePages: z.number().int().positive().optional()
          .describe('How many crawled pages also get a deep pre-consent capture + form scan (default 3, cap 8).'),
        scenarios: z.array(z.enum(['ignore', 'accept', 'reject'])).optional()
          .describe('Consent scenarios to exercise on the entry page (default: all three).'),
        gtmContainer: z.record(z.string(), z.unknown()).optional()
          .describe(
            'Optional GTM container export from the samarth-gtm-mcp `export_container` tool with ' +
            'format:"full" (the parsed JSON object, with tags/triggers/variables arrays). When ' +
            'supplied, the consent engine reconciles configured consent intent against the live ' +
            'capture — upgrading coverage from runtime-only to "reconciled". A "summary"/"names_only" ' +
            'export is rejected with a note (parameters are stripped there).',
          ),
      }),
    },
    async ({ url, maxPages, maxDepth, capturePages, scenarios, gtmContainer }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      try {
        const { runComplianceAudit } = await import('../agent/compliance.js');
        const report = await runComplianceAudit(url, { maxPages, maxDepth, capturePages, scenarios, gtmContainer });
        return jsonResult(report);
      } catch (err) {
        return errorResult('consent_compliance_audit', err);
      }
    },
  );
}
