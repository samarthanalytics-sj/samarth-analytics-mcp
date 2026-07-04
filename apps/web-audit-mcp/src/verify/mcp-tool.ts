/**
 * Thin MCP wrapper — exposes the verification engine as a single `verify` tool.
 *
 * IMPORTANT: unlike every other tool on this server (which only ever clicks a
 * consent banner and never submits forms), `verify` drives the operator-supplied
 * selectors/actions from the spec, INCLUDING real form submits. It is therefore
 * registered ONLY when WEB_AUDIT_ENABLE_VERIFY=true (default off). The CLI is an
 * explicit local operator invocation and does not need the flag.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult, errorText } from '../utils/toolResponse.js';
import { loadConfig } from '../utils/config.js';
import { urlAllowed } from '../utils/urlGuard.js';

const DESCRIPTION =
  'Verify that GA4/GTM tags actually fire correctly on a page. Loads the URL in real headless ' +
  'Chromium, optionally drives a two-phase consent flow and journey steps (click/submit/navigate), ' +
  'captures the GA4 collect hits (GET + batched POST), dataLayer, and cookies, then compares reality ' +
  'against a declarative spec and returns a deterministic per-check report (Pass/Partial/Fail/Not ' +
  'Verified) with evidence. Client-side only — server-side hits (CAPI/sGTM/Measurement Protocol) are ' +
  'out of scope and never claimed. UNLIKE the other tools here, verify performs the operator-supplied ' +
  'interactions (including real form submits) on the target page; use only on sites you are authorised ' +
  'to test. The `spec` follows the verification spec schema (measurementIds, expectedTrackers, consent, ' +
  'settle, checks[]).';

export function registerVerifyTool(server: McpServer): void {
  server.registerTool(
    'verify',
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        url: z.string().url().optional().describe('Target URL. Overrides spec.url when both are present.'),
        spec: z
          .record(z.string(), z.unknown())
          .describe('The verification spec object (url, measurementIds, expectedTrackers, consent, settle, checks[]).'),
      }),
    },
    async ({ url, spec }) => {
      const rawSpec = { ...(spec as Record<string, unknown>) };
      const targetUrl = url ?? (typeof rawSpec.url === 'string' ? (rawSpec.url as string) : undefined);
      if (!targetUrl) return errorText('verify requires a url (as the "url" arg or spec.url).');
      rawSpec.url = targetUrl;

      const config = loadConfig();
      const verdict = urlAllowed(targetUrl, config.allowlist);
      if (!verdict.ok) return errorText(`URL rejected: ${verdict.reason}`);

      try {
        const { verifyPage } = await import('./index.js');
        const { SpecValidationError } = await import('./spec-schema.js');
        try {
          const report = await verifyPage(rawSpec, {
            headless: config.headless,
            navTimeoutMs: config.navTimeoutMs,
            allowlist: config.allowlist,
            settleQuietMs: config.settleQuietMs,
            settleMaxMs: config.settleMaxMs,
          });
          return jsonResult(report);
        } catch (err) {
          if (err instanceof SpecValidationError) return errorText(err.message);
          throw err;
        }
      } catch (err) {
        return errorResult('verify', err);
      }
    },
  );
}
