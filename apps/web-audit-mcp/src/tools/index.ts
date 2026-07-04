/**
 * Web-audit tool registry.
 *
 * Two interaction surfaces with different guarantees:
 *
 * 1. The AUTONOMOUS AUDIT AGENT (site_crawl, forms_scan, consent_banner_detect,
 *    consent_scenario_capture, gtm_tag_suggestions, consent_compliance_audit) is
 *    read-only toward the audited site's data — the ONLY interaction it ever
 *    performs is clicking consent-banner accept/reject controls inside an
 *    ephemeral, cookie-isolated browser context. Forms are inventoried, never
 *    submitted.
 *
 * 2. The `verify` TOOL (tag verification engine) is OPERATOR-DRIVEN: it performs
 *    exactly the selectors/actions listed in the operator's spec, INCLUDING real
 *    form submits, to prove trigger-fired events. Because that exceeds the
 *    consent-click-only guarantee above, it is registered only when
 *    WEB_AUDIT_ENABLE_VERIFY=true (default off) and is intended for sites the
 *    operator is authorised to test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult, errorText, type ToolResult } from '../utils/toolResponse.js';
import { loadConfig, clampOpt } from '../utils/config.js';
import { urlAllowed } from '../utils/urlGuard.js';
import { registerVerifyTool } from '../verify/mcp-tool.js';

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

  // ── gtm_tag_suggestions ───────────────────────────────────────────────────
  server.registerTool(
    'gtm_tag_suggestions',
    {
      description:
        'Scan a website and suggest the GA4 event tags worth creating in GTM — a "measurement plan from a URL". ' +
        'Crawls same-site pages (read-only), then on each page inventories forms (contact/signup/newsletter → ' +
        'generate_lead/sign_up/newsletter_signup, with the form provider detected: HubSpot, Typeform, Mailchimp, ' +
        'Marketo, Pardot, Gravity Forms, Contact Form 7, WPForms) and trackable elements (mailto → email_click, ' +
        'tel → phone_click, file downloads, outbound links, CTA buttons). Suggestions are deduped site-wide and ' +
        'ranked; each is returned in the tag-payload shape the GTM create_gtm_tracking_tag tool accepts (the caller ' +
        'supplies accountId/containerId/workspaceId), so it can be created draft-only behind approval. Anything GA4 ' +
        'Enhanced Measurement ALREADY auto-tracks (file ' +
        'downloads, outbound clicks) is flagged enhancedMeasurementOverlap:true rather than pushed, so you do not ' +
        'double-track. Read-only and bounded by maxPages/scanPages and a private-network guard; forms are ' +
        'inventoried, never filled or submitted, and no element other than the page itself is ever interacted with.',
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().positive().optional()
          .describe('Crawl page budget (default 10, hard cap 25).'),
        maxDepth: z.number().int().positive().optional()
          .describe('Crawl depth from the start URL (default 2, hard cap 4).'),
        scanPages: z.number().int().positive().optional()
          .describe('How many crawled pages to deep-scan for tags (default = pages crawled, cap 25). Entry page + most form-heavy first.'),
      }),
    },
    async ({ url, maxPages, maxDepth, scanPages }) => {
      const rejected = admit(url);
      if (rejected) return rejected;
      try {
        const { scanSiteForTagSuggestions } = await import('../agent/tag-suggest/scan.js');
        const report = await scanSiteForTagSuggestions(url, { maxPages, maxDepth, scanPages });
        return jsonResult(report);
      } catch (err) {
        return errorResult('gtm_tag_suggestions', err);
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
        'behaviour ("reconciled" coverage) AND get tag-presence reconciliation — configured-but-never-fired, ' +
        'fired-but-not-configured, and GA4 measurement-id mismatches — in report.reconciliation + findings. ' +
        'This is the recommended one-call entry point; use the focused tools to drill in.',
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

  // ── verify (tag verification engine) — operator-driven, off by default ──────
  if (loadConfig().verifyEnabled) {
    registerVerifyTool(server);
  }
}
