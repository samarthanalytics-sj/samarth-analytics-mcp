// openInBrowser's spawn allowlist: only an exe that detectBrowsers() found may be launched.
// Run: tsx src/main/services/__tests__/browser-allowlist.test.ts
import assert from 'node:assert/strict';
import { resolveDetectedExe } from '../browser-allowlist';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nbrowser-allowlist:');

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const detected = [
  { id: 'default', name: 'Default browser', exe: '' },
  { id: chrome.toLowerCase(), name: 'Google Chrome', exe: chrome },
  { id: '/applications/firefox.app/contents/macos/firefox', name: 'Firefox', exe: '/Applications/Firefox.app/Contents/MacOS/firefox' },
];

test('a detected browser exe resolves to the detected path', () => {
  assert.equal(resolveDetectedExe(chrome, detected), chrome);
});

test('the match is case-insensitive and returns OUR copy of the path, not the caller string', () => {
  assert.equal(resolveDetectedExe(chrome.toUpperCase(), detected), chrome);
  assert.equal(resolveDetectedExe('/applications/firefox.app/contents/macos/firefox', detected), '/Applications/Firefox.app/Contents/MacOS/firefox');
});

// Regression: openInBrowser spawned ANY renderer-supplied path that existed on disk.
test('an existing but undetected executable is refused', () => {
  assert.equal(resolveDetectedExe('C:\\Windows\\System32\\cmd.exe', detected), null);
  assert.equal(resolveDetectedExe('/bin/sh', detected), null);
  assert.equal(resolveDetectedExe(process.execPath, detected), null);
});

test('a near-miss path (prefix, suffix, extra args) is refused', () => {
  assert.equal(resolveDetectedExe(`${chrome} --remote-debugging-port=9222`, detected), null);
  assert.equal(resolveDetectedExe(chrome.slice(0, -4), detected), null);
  assert.equal(resolveDetectedExe(` ${chrome}`, detected), null);
});

test('the empty "Default browser" entry never matches, and nothing matches an empty list', () => {
  assert.equal(resolveDetectedExe('', detected), null);
  assert.equal(resolveDetectedExe(chrome, []), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
