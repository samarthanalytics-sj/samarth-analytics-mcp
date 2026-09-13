/**
 * Log timestamp tests.
 *
 * The log recorded how long a turn took but never when it ran, so dating a request meant finding
 * the nearest supervisor restart and counting forward from it. These check the stamp is there, is
 * parseable, and does not corrupt the payloads that get read and pasted out of this file.
 *
 * The format is tested through the pure timestampPrefix; the console wrapper is tested once,
 * because installing it is a one-way side effect on a global.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTimestampedLogging, timestampPrefix } from '../log-time.js';

const STAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/;

void test('the stamp carries the DATE, not just the clock', () => {
  // This log spans days between restarts, so a bare HH:MM:SS cannot date a turn.
  const s = timestampPrefix(new Date(2026, 7, 12, 19, 52, 31));
  assert.equal(s, '[2026-08-12 19:52:31]');
  assert.match(s, STAMP);
});

void test('single digits are padded, so the column never shifts', () => {
  // An unpadded month or hour makes the log impossible to scan or sort.
  assert.equal(timestampPrefix(new Date(2026, 0, 5, 3, 4, 9)), '[2026-01-05 03:04:09]');
});

void test('the stamp is parseable back into a time', () => {
  const inner = timestampPrefix(new Date(2026, 7, 12, 19, 52, 31)).slice(1, -1);
  assert.equal(Number.isNaN(Date.parse(inner.replace(' ', 'T'))), false, `unparseable: ${inner}`);
});

void test('the console wrapper stamps every level and keeps the message intact', () => {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of ['log', 'error', 'warn'] as const) {
    console[level] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  }
  try {
    installTimestampedLogging();
    console.log('[tools] 40 of 97 tools visible this turn');
    console.error('[openai] 429 rate_limit_exceeded');
    console.warn('[orchestrator] WARNING: audit trail OFF');
    // Multi-line payloads get copied out of the log, so a stamp must not land inside the JSON.
    console.log('result:\n{\n  "tagId": "1146"\n}');
  } finally {
    Object.assign(console, original);
  }

  assert.equal(lines.length, 4);
  for (const line of lines) assert.match(line, STAMP, `unstamped: ${line}`);
  assert.match(lines[0], /\[tools\] 40 of 97 tools visible this turn$/);

  const stampedLines = lines[3].split('\n').filter((l) => STAMP.test(l));
  assert.equal(stampedLines.length, 1, 'a timestamp inside a JSON body would break the paste');
  assert.match(lines[3], /"tagId": "1146"/);
  assert.equal(lines[3].match(/\[\d{4}-\d{2}-\d{2} /g)?.length, 1, 'installing twice must not double-stamp');
});
