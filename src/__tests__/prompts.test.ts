/**
 * The MCP `prompts/list` surface — the "prompts tab" a client shows. Verifies the one guided
 * server-side-setup prompt is registered and its recipe names each ordered piece + resource shape.
 * Pure (no GTM API): registers the prompt on a real McpServer and invokes its callback.
 * Run with: tsx src/__tests__/prompts.test.ts
 */
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerServerSidePrompts } from '../prompts/serverSide.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

console.log('\nMCP prompts:');

const server = new McpServer({ name: 'test', version: '0.0.1' }, { capabilities: { tools: {}, prompts: {} } });
registerServerSidePrompts(server);

// The SDK keeps registered prompts in _registeredPrompts, keyed by name (this is what prompts/list reads).
const prompts = (server as unknown as { _registeredPrompts: Record<string, { callback: (a: Record<string, string>) => { messages: Array<{ role: string; content: { type: string; text: string } }> } }> })._registeredPrompts;

check('the server-side setup prompt is registered (appears in the prompts tab)', !!prompts && Object.keys(prompts).includes('setup_server_side_container'));

const res = prompts['setup_server_side_container'].callback({ accountId: '123', containerName: 'ex.com - Server', measurementId: 'G-ABC123', adsConversionId: 'AW-999' });
const msg = res.messages[0];
check('it returns ONE user message', res.messages.length === 1 && msg.role === 'user' && msg.content.type === 'text');

const text = msg.content.text;
// The recipe must cover every ordered step + the exact resource types the MCP create tools need.
for (const needle of [
  'usageContext', // 1 · server container
  'clientName', 'eventName', // 2 · built-ins
  'gaaw_client', // 3 · GA4 client
  '"ed"', '"c"', '"rh"', // 4 · variables (event data / constant / request header)
  'customEvent', '{{_event}}', '{{Client Name}}', // 5 · per-event trigger
  'sgtmgaaw', // 6 · GA4 server tag
  'taggingServerUrls', 'server_container_url', // 7 · host wiring
]) {
  check(`recipe includes "${needle}"`, text.includes(needle));
}
// Provided args are interpolated.
check('interpolates the GA4 Measurement ID arg', text.includes('G-ABC123'));
check('interpolates the Ads conversion id arg (only when given)', text.includes('AW-999') && text.toLowerCase().includes('sgtmadsct'));
// Omitting the ads arg drops the Ads/Conversion-Linker block.
const noAds = prompts['setup_server_side_container'].callback({}).messages[0].content.text;
check('no Ads conversion id → no server Ads tag block', !noAds.includes('sgtmadsct'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
