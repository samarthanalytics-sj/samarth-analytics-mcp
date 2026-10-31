/**
 * Web Audit MCP Server factory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { loadConfig } from './utils/config.js';

export const SERVER_NAME = 'samarth-web-audit-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Ceiling on the combined number of array elements and object members in one tools/call
 * `arguments` payload (GHSA-46jr-4wx8-v453). Without it, one authenticated HTTP request inside the
 * 8mb body limit could carry millions of elements and exhaust the heap during schema validation.
 * The SDK option is off by default, so upgrading alone did not close it. The largest legitimate
 * input is a full GTM container export passed as gtmContainer. At roughly 16 bytes of compact JSON
 * per element, the cap admits an export of about 4 MB, well above what GTM's container size limit
 * allows. A call over it gets an isError result.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 250_000;

export function createWebAuditMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(),
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  );
  registerAllTools(server);
  return server;
}

function buildInstructions(): string {
  const config = loadConfig();
  return [
    'Samarth Analytics — Web Audit MCP Server',
    '',
    'A site-audit agent on top of headless Chromium (Playwright): crawls a website, inventories',
    'forms, interacts with consent banners (CMP), and audits GDPR/ePrivacy + Google Consent Mode v2',
    'compliance using the same engine as the Samarth portal.',
    '',
    'TOOLS:',
    '- consent_compliance_audit — full agent run (crawl → forms → banner scenarios → findings + score).',
    '  Start here; the other tools are for drilling into specifics.',
    '- site_crawl — discover same-site pages (form-heavy pages prioritised).',
    '- forms_scan — per-page form inventory with PII classification and privacy issues.',
    '- consent_banner_detect — identify the CMP vendor and its accept/reject controls (no clicking).',
    '- consent_scenario_capture — capture one page under ignore / accept / reject with hit timing.',
    '',
    'SAFETY MODEL:',
    '- Read-only toward the audited site: forms are never filled or submitted; the ONLY interaction',
    '  is clicking the consent banner accept/reject controls, inside an ephemeral isolated browser',
    '  context that is discarded after the capture.',
    '- SSRF guard: requests to private/loopback/cloud-metadata addresses are blocked, subresources',
    '  included. A page that REDIRECTS to one is reported as blocked and nothing is read from it.',
    '  Set WEB_AUDIT_ALLOWLIST=example.com,client2.com to restrict auditable hosts.',
    '- Budgets: WEB_AUDIT_MAX_PAGES (default 10, cap 25), WEB_AUDIT_MAX_DEPTH (default 2, cap 4),',
    '  WEB_AUDIT_NAV_TIMEOUT, WEB_AUDIT_SETTLE_MS.',
    '- Set WEB_AUDIT_DISABLE_INTERACTION=true to forbid banner clicking (detection still works).',
    '',
    'Current mode: ' +
      (config.interactionEnabled ? 'banner interaction ENABLED' : 'banner interaction DISABLED') +
      (config.allowlist.length > 0 ? `, allowlist: ${config.allowlist.join(', ')}` : ', no host allowlist') +
      '.',
    '',
    'TIP: pair with the samarth-gtm-mcp server for config-vs-reality reconciliation. Run its',
    'export_container tool (format:"full"), then pass the parsed JSON as the gtmContainer argument',
    'to consent_compliance_audit here — coverage escalates from runtime-only to "reconciled".',
  ].join('\n');
}
