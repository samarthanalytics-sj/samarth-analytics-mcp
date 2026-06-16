#!/usr/bin/env node
/**
 * Drive the hosted MCP server through mcp-remote and call one tool — without
 * the flaky Inspector UI. Spawns `mcp-remote` (which handles the OAuth with the
 * cached token, or opens a browser if it expired), then sends initialize +
 * tools/call over stdio and prints the result.
 *
 * Usage:
 *   node scripts/gtm-call.mjs                       # calls accounts_list
 *   node scripts/gtm-call.mjs ga4_account_summaries_list
 *   node scripts/gtm-call.mjs accounts_list '{"includeGoogleTags":true}'
 *
 * If a browser opens asking you to sign in, complete it — the script waits.
 */
import { spawn } from 'node:child_process';

const URL = 'https://mcp.samarthanalytics.com/mcp';
const toolName = process.argv[2] || 'accounts_list';
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const isWin = process.platform === 'win32';
const child = isWin
  ? spawn('cmd.exe', ['/c', 'npx.cmd', '-y', 'mcp-remote', URL], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('npx', ['-y', 'mcp-remote', URL], { stdio: ['pipe', 'pipe', 'pipe'] });

let ready = false;
let buf = '';
const pending = new Map();
let nextId = 1;

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 120000);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

// mcp-remote logs to stderr; surface them so OAuth/browser prompts are visible.
child.stderr.on('data', (d) => {
  const s = d.toString();
  process.stderr.write(s);
  if (!ready && /Proxy established successfully|Connected to remote server/.test(s)) {
    ready = true;
    run().catch((e) => { console.error('\nERROR:', e.message); shutdown(1); });
  }
});

// stdout is the JSON-RPC channel proxied from the remote server.
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = pending.get(msg.id);
    if (w) { pending.delete(msg.id); w.resolve(msg); }
  }
});

child.on('exit', (code) => {
  if (!ready) console.error(`\nmcp-remote exited (code ${code}) before connecting.`);
});

async function run() {
  console.error('\n— connected; calling tool —\n');
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gtm-call', version: '1.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const res = await rpc('tools/call', { name: toolName, arguments: toolArgs });
  console.log(`\n===== ${toolName} result =====`);
  const text = res.result?.content?.[0]?.text;
  console.log(text ?? JSON.stringify(res, null, 2));
  console.log('==============================');
  if (res.result?.isError) console.error('(tool returned isError=true — see message above)');
  shutdown(0);
}

function shutdown(code) {
  try { child.kill(); } catch {}
  process.exit(code);
}

// Safety: if mcp-remote never reaches "connected" (e.g. waiting on browser auth),
// the stderr passthrough lets the user see why; hard cap at 5 minutes.
setTimeout(() => { if (!ready) { console.error('\nGave up after 5 min waiting to connect.'); shutdown(1); } }, 300000);
