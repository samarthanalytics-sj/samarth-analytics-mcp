// Pure tests for the desktop-chat slash commands (parse → expand → menu). Run:
// tsx src/shared/__tests__/chat-commands.test.ts
import { CHAT_SLASH_COMMANDS, parseSlashCommand, resolveChatInput, slashMenuMatches } from '../chat-commands';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── parseSlashCommand ──────────────────────────────────────────────────────────
check('parses "/audit" with empty args', (() => { const p = parseSlashCommand('/audit'); return p?.command.name === 'audit' && p.args === ''; })());
check('parses "/report last 7 days" args', (() => { const p = parseSlashCommand('/report last 7 days'); return p?.command.name === 'report' && p.args === 'last 7 days'; })());
check('parses the hyphenated "/create-tag …"', (() => { const p = parseSlashCommand('/create-tag contact form submit'); return p?.command.name === 'create-tag' && p.args === 'contact form submit'; })());
check('trims leading/trailing whitespace before matching', parseSlashCommand('  /debug Purchase Tag  ')?.command.name === 'debug');
check('an unknown "/foo" is NOT a command (null)', parseSlashCommand('/foo bar') === null);
check('a plain message is NOT a command', parseSlashCommand('list my GTM accounts') === null);
check('a path like "/etc/passwd" is NOT a command (no misfire)', parseSlashCommand('/etc/passwd is a file') === null);
check('every registered command parses back to itself', CHAT_SLASH_COMMANDS.every((c) => parseSlashCommand(`/${c.name}`)?.command.name === c.name));

// ── resolveChatInput (display vs sent vs product) ──────────────────────────────
const plain = resolveChatInput('hello there', 'gtm');
check('plain message: sent === display, product unchanged', plain.sent === 'hello there' && plain.display === 'hello there' && plain.product === 'gtm');

const audit = resolveChatInput('/audit', 'gtm');
check('/audit: display keeps the short command', audit.display === '/audit');
check('/audit: sent is the expanded read-only audit instruction', audit.sent.length > 40 && /read-only/i.test(audit.sent) && /audit/i.test(audit.sent) && audit.sent !== '/audit');
check('/audit: stays in gtm product', audit.product === 'gtm');

// /report flips the product to ga4 (its tools live there) even when the chat is currently in gtm.
const report = resolveChatInput('/report last 7 days', 'gtm');
check('/report: flips product to ga4', report.product === 'ga4');
check('/report: expansion interpolates the range + is read-only', report.sent.includes('last 7 days') && /read-only/i.test(report.sent) && /GA4 report/i.test(report.sent));

// /create-tag keeps the draft/never-publish guardrail.
const ct = resolveChatInput('/create-tag add to cart button', 'gtm');
check('/create-tag: draft-only, never publish, in gtm', /draft/i.test(ct.sent) && /never publish/i.test(ct.sent) && ct.product === 'gtm' && ct.sent.includes('add to cart button'));

// /debug read-only + carries the tag.
const dbg = resolveChatInput('/debug Newsletter Tag', 'gtm');
check('/debug: read-only + carries the tag name', /read-only/i.test(dbg.sent) && dbg.sent.includes('Newsletter Tag'));

// /explain has NO product → runs in whatever mode the chat is in.
check('/explain: product is unchanged (ga4 stays ga4)', resolveChatInput('/explain Consent Mode v2', 'ga4').product === 'ga4');
check('/explain: interpolates the topic', resolveChatInput('/explain Consent Mode v2', 'gtm').sent.includes('Consent Mode v2'));
check('/explain with no topic asks the user', /ask me/i.test(resolveChatInput('/explain', 'gtm').sent));

// ── slashMenuMatches (autocomplete) ────────────────────────────────────────────
check('menu: "/" lists all commands', slashMenuMatches('/').length === CHAT_SLASH_COMMANDS.length);
check('menu: "/re" narrows to report', slashMenuMatches('/re').map((c) => c.name).join(',') === 'report');
check('menu: "/c" narrows to create-tag', slashMenuMatches('/c').map((c) => c.name).join(',') === 'create-tag');
check('menu: closes once a space/args are typed', slashMenuMatches('/report ').length === 0 && slashMenuMatches('/report last').length === 0);
check('menu: a plain message shows nothing', slashMenuMatches('hello').length === 0);
check('menu: "/zzz" (no match) shows nothing', slashMenuMatches('/zzz').length === 0);

console.log(`\nchat-commands: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
