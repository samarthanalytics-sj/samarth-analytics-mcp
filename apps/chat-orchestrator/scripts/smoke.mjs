#!/usr/bin/env node
/**
 * End-to-end smoke test against a running orchestrator.
 *
 * Sends one real chat turn and prints the SSE event trace, so you can see whether the model
 * actually reached the MCP and what it called.
 *
 *   node scripts/smoke.mjs "list my GTM accounts"
 */
import 'dotenv/config';

const url = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:8787';
const token = process.env.SMOKE_ACCESS_TOKEN || '';
const product = process.env.SMOKE_PRODUCT || 'gtm';
const message = process.argv.slice(2).join(' ') || 'List the GTM accounts I have access to.';

const health = await fetch(`${url}/health`).then((r) => r.json());
console.log('health:', health);

const res = await fetch(`${url}/v1/chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    messages: [{ role: 'user', content: message }],
    context: { product },
  }),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}:`, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = '';
const toolsCalled = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5).trim());
    switch (event.type) {
      case 'ready':
        console.log(`\nready: model=${event.model} product=${event.product} tools=${event.toolCount}`);
        break;
      case 'token':
        answer += event.text;
        process.stdout.write(event.text);
        break;
      case 'tool_call':
        toolsCalled.push(event.name);
        console.log(`\n  -> tool ${event.name}(${JSON.stringify(event.args)})`);
        break;
      case 'tool_result':
        console.log(`  <- ${event.ok ? 'ok' : 'FAILED'} ${event.name}: ${event.summary}`);
        break;
      case 'usage':
        console.log(
          `\n[usage] prompt=${event.promptTokens} (cached ${event.cachedTokens}) completion=${event.completionTokens}`,
        );
        break;
      case 'error':
        console.error(`\n[error ${event.code}] ${event.message}`);
        break;
      case 'done':
        console.log(`\n[done: ${event.reason}]`);
        break;
    }
  }
}

console.log(`\n\nTools called: ${toolsCalled.length ? toolsCalled.join(', ') : '(none)'}`);
console.log(`Answer length: ${answer.length} chars`);
process.exit(answer.length > 0 ? 0 : 1);
