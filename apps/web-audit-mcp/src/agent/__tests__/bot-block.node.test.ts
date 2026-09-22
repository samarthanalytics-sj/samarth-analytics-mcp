// botBlockReason — pure classification of WAF / bot-challenge responses.
// Run: tsx apps/web-audit-mcp/src/agent/__tests__/bot-block.node.test.ts
import { botBlockReason, isBotBlockReason, blockedStartWarning } from '../bot-block.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// The exact headers a Cloudflare-challenged site returned to the scanner (2026-09-17).
const iff = { 'Cf-Mitigated': 'challenge', Server: 'cloudflare', 'CF-RAY': 'a3c6236b2f403f60-BOM' };
check('cloudflare challenge → named challenge', botBlockReason(403, iff) === 'blocked by Cloudflare bot challenge');
check('header keys are case-insensitive', botBlockReason(403, { 'cf-mitigated': 'challenge' }) === 'blocked by Cloudflare bot challenge');
check('cf-mitigated other value → protection, not challenge', botBlockReason(403, { 'cf-mitigated': 'block' }) === 'blocked by Cloudflare bot protection');
check('cloudflare 403 without cf-mitigated → names the CDN, no challenge claim', botBlockReason(403, { server: 'cloudflare', 'cf-ray': 'x' }) === 'blocked by Cloudflare (http 403)');
check('503 challenge counts too', botBlockReason(503, iff) === 'blocked by Cloudflare bot challenge');
check('429 behind cloudflare counts', botBlockReason(429, { 'cf-ray': 'x' }) === 'blocked by Cloudflare (http 429)');

check('akamai sensor cookie (string[] value, Electron shape)', botBlockReason(403, { 'set-cookie': ['_abck=abc; Path=/', 'other=1'] }) === 'blocked by Akamai bot protection');
check('akamai x-akamai-* header', botBlockReason(403, { 'X-Akamai-Transformed': '9' }) === 'blocked by Akamai bot protection');
check('imperva x-iinfo', botBlockReason(403, { 'X-Iinfo': '1-2-3' }) === 'blocked by Imperva bot protection');
check('imperva incap cookie', botBlockReason(403, { 'set-cookie': 'visid_incap_123=abc' }) === 'blocked by Imperva bot protection');
check('datadome', botBlockReason(403, { 'x-datadome': 'protected' }) === 'blocked by DataDome bot protection');
check('perimeterx cookie', botBlockReason(403, { 'set-cookie': '_px3=abc' }) === 'blocked by PerimeterX bot protection');
check('aws waf', botBlockReason(403, { 'x-amzn-waf-action': 'challenge' }) === 'blocked by AWS WAF');

check('a plain 404 is not a block', botBlockReason(404, iff) === null);
check('a 200 is never a block', botBlockReason(200, iff) === null);
check('a 401 is auth, not a bot check', botBlockReason(401, iff) === null);
check('an origin 403 with no WAF markers → null (stays "http 403")', botBlockReason(403, { server: 'nginx', 'content-type': 'text/html' }) === null);
check('null status → null', botBlockReason(null, iff) === null);
check('undefined header values are ignored', botBlockReason(403, { 'cf-mitigated': undefined, server: 'nginx' }) === null);

check('isBotBlockReason recognises the prefix', isBotBlockReason('blocked by Cloudflare bot challenge') && !isBotBlockReason('http 403') && !isBotBlockReason(undefined));
check('blockedStartWarning names the reason and the remedy', /Cloudflare bot challenge/.test(blockedStartWarning('blocked by Cloudflare bot challenge')) && /allowlist/.test(blockedStartWarning('x')) && /not a detection gap/.test(blockedStartWarning('x')));

console.log(`\nbot-block: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
