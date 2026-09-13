// Pure tests for the chat-reply export builders (table extraction, CSV, exportability, sheet names).
// Run: tsx src/shared/__tests__/chat-export.test.ts
import { extractReplyTables, replyLooksExportable, replyCsv, sheetNameFor, asksForExport, shouldOfferExport, exportReplyFilename, safeFilePart } from '../chat-export';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' - ' + detail : ''}`); }
}

const AUDIT = [
  '## Tag Health Summary',
  '',
  '| Status | Count | Examples |',
  '|---|---|---|',
  '| Healthy | 38 | GA4 Event, Floodlight |',
  '| **Broken** | 3 | Criteo, `Custom HTML #12` |',
  '',
  'Some prose between tables.',
  '',
  '**Critical Issues:**',
  '| Tag | Problem |',
  '| --- | --- |',
  '| Criteo | missing account_id |',
].join('\n');

// ── extractReplyTables ──────────────────────────────────────────────────────────
const tables = extractReplyTables(AUDIT);
check('finds both tables', tables.length === 2, `got ${tables.length}`);
check('table 1 titled by the nearest heading', tables[0]?.title === 'Tag Health Summary', tables[0]?.title);
check('table 2 titled by the bold line (colon stripped)', tables[1]?.title === 'Critical Issues', tables[1]?.title);
check('header parsed', JSON.stringify(tables[0]?.header) === JSON.stringify(['Status', 'Count', 'Examples']));
check('row count', tables[0]?.rows.length === 2);
check('inline markers stripped from cells', tables[0]?.rows[1]?.[0] === 'Broken' && tables[0]?.rows[1]?.[2] === 'Criteo, Custom HTML #12', JSON.stringify(tables[0]?.rows[1]));
check('a heading is claimed by ONE table only', tables[1]?.title !== 'Tag Health Summary');
check('untitled table falls back to Table N', extractReplyTables('| A |\n|---|\n| 1 |')[0]?.title === 'Table 1');
check('unicode dash separator accepted', extractReplyTables('| A | B |\n|——|——|\n| 1 | 2 |').length === 1);
check('no tables in prose', extractReplyTables('just words\nand more words').length === 0);
check('short ragged row pads to header width via csv', extractReplyTables('| A | B |\n|---|---|\n| only |').length === 1);

// ── replyLooksExportable ────────────────────────────────────────────────────────
check('table → exportable', replyLooksExportable('| A |\n|---|\n| 1 |'));
check('long prose → exportable', replyLooksExportable('x'.repeat(500)));
check('short answer → NOT exportable', !replyLooksExportable('Done - the tag was created.'));
check('empty → NOT exportable', !replyLooksExportable('') && !replyLooksExportable('   '));

// ── replyCsv ────────────────────────────────────────────────────────────────────
const csv = replyCsv(AUDIT);
check('csv contains both title rows', csv.includes('Tag Health Summary') && csv.includes('Critical Issues'));
check('csv header row', csv.includes('Status,Count,Examples'));
check('csv blank line between tables', csv.includes('\n\n'));
check('csv quotes cells with commas', csv.includes('"Criteo, Custom HTML #12"'));
check('csv doubles inner quotes', replyCsv('| A |\n|---|\n| say "hi" |').includes('"say ""hi"""'));
check('csv strips em/en dashes (export boundary)', !/[–—]/.test(replyCsv('## T — em\n| A — B |\n|---|\n| x – y |')));
check('csv on tableless reply throws', (() => { try { replyCsv('no tables here'); return false; } catch { return true; } })());
check('missing trailing cells become empty, not undefined', replyCsv('| A | B |\n|---|---|\n| only |').includes('only,'));

// ── sheetNameFor ────────────────────────────────────────────────────────────────
check('sheet name strips forbidden chars', sheetNameFor('A/B:C*D?E[F]', 0) === 'A B C D E F', sheetNameFor('A/B:C*D?E[F]', 0));
check('sheet name capped at 31 chars', sheetNameFor('x'.repeat(50), 0).length <= 31);
check('blank title falls back', sheetNameFor('   ', 4) === 'Table 5');
check('sheet name plain-dashes', sheetNameFor('Alpha — Beta', 0) === 'Alpha - Beta');

// ── asksForExport: the ask ──────────────────────────────────────────────────────
check('asks: table', asksForExport('give me a table of all the tags'));
check('asks: caps table', asksForExport('GIVE ME A TABLE OF THE TRIGGERS'));
check('asks: in a table', asksForExport('list down the form ids in a table'));
check('asks: tabular form', asksForExport('put it in tabular form'));
check('asks: table format', asksForExport('table format please'));
check('asks: export', asksForExport('export this'));
check('asks: download', asksForExport('can I download this'));
check('asks: csv', asksForExport('i want it as csv'));
check('asks: excel', asksForExport('excel sheet please'));
check('asks: pdf', asksForExport('send me the pdf'));
check('asks: save as', asksForExport('save it as xlsx'));
check('asks: report', asksForExport('can you make a report of the container'));
check('asks: summary', asksForExport('i need a summary of the audit'));
check('asks: breakdown', asksForExport('show me a breakdown by trigger type'));
check('asks: as a document', asksForExport('write it up as a document'));

// ── asksForExport: NOT an ask (the whole point of this change) ───────────────────
check('not ask: plain question', !asksForExport('why is my ga4 tag not firing'));
check('not ask: create a tag', !asksForExport('create a google ads conversion tag for the demo form'));
check('not ask: mentions a report', !asksForExport('why does the report show 3 tags?'));
check('not ask: verb AFTER the noun', !asksForExport('the summary says 12 - show the raw numbers'));
check('not ask: statement about a table', !asksForExport('the table is wrong, fix the third row'));
check('not ask: distant verb', !asksForExport('show me the firing tags and then tell me what changed in the container since the last report'));
check('not ask: list without table', !asksForExport('list the triggers in this workspace'));
check('not ask: empty', !asksForExport('') && !asksForExport('   '));

// ── shouldOfferExport: content AND ask ──────────────────────────────────────────
const TABLE = '| Tag | Type |\n|---|---|\n| A | ga4 |';
const LONG = 'x'.repeat(600);
check('bar: asked for a table, got one', shouldOfferExport(TABLE, 'give me a table of the tags', ''));
check('bar: asked for a report, got prose', shouldOfferExport(LONG, 'prepare a report on this container', ''));
check('NO bar: table nobody asked for', !shouldOfferExport(TABLE, 'why is my tag not firing', ''));
check('NO bar: long answer nobody asked for', !shouldOfferExport(LONG, 'why is my tag not firing', ''));
check('NO bar: asked, but the reply is one line', !shouldOfferExport('Done - no tables here.', 'give me a table', ''));
check('NO bar: no neighbouring user turns', !shouldOfferExport(TABLE, '', ''));

// A follow-up pointing back at the reply above it ("download that") lights THAT reply.
check('bar: retro ask below', shouldOfferExport(TABLE, 'why is my tag not firing', 'download that as csv'));
check('bar: retro ask via "the above"', shouldOfferExport(TABLE, 'anything wrong here?', 'export the above as pdf'));
check('NO bar: forward ask is for the NEXT reply', !shouldOfferExport(TABLE, 'why is my tag not firing', 'now give me a table of the triggers'));


// ── Fenced JSON as a table ──────────────────────────────────────────────────────
// "give me in export format" reliably produces a JSON array, not a pipe table, and that was the ONE
// shape the exporter could not read - so CSV and XLSX sat disabled on the most structured data a
// reply can contain.
const FENCE = '`'.repeat(3);
const fenced = (body: string, lang = 'json'): string => [FENCE + lang, body, FENCE].join('\n');
const ROWS = '[{"tagId":"160","name":"cHTML - Apollo Tag","type":"html"},{"tagId":"189","name":"Google Ads - Conversion","type":"awct"}]';

check('a fenced JSON array becomes a table', extractReplyTables(fenced(ROWS)).length === 1);
check('its header is the object keys, in order', JSON.stringify(extractReplyTables(fenced(ROWS))[0].header) === '["tagId","name","type"]');
check('every element becomes a row', extractReplyTables(fenced(ROWS))[0].rows.length === 2);
check('a BARE fence is tried too (models emit both)', extractReplyTables(fenced(ROWS, ''))[0]?.rows.length === 2);
check('the reply now earns CSV', replyCsv(fenced(ROWS)).includes('tagId,name,type'));
check('and the export bar is offered for it', shouldOfferExport(fenced(ROWS), 'give me in export format', ''));

// Header = UNION of keys, in first-seen order. First-row-only would silently drop later columns.
const RAGGED = '[{"a":1},{"a":2,"b":3}]';
check('a key appearing only in a later row still gets a column', JSON.stringify(extractReplyTables(fenced(RAGGED))[0].header) === '["a","b"]');
// Indexed BY KEY, so a missing field is an empty cell rather than a shifted row.
check('a row missing a field gets an EMPTY cell, not a shifted one', JSON.stringify(extractReplyTables(fenced(RAGGED))[0].rows[0]) === '["1",""]');

check('an array of scalars becomes a single column', JSON.stringify(extractReplyTables(fenced('["a","b"]'))[0].header) === '["value"]');
check('nested values are stringified, never dropped', extractReplyTables(fenced('[{"a":{"b":1}}]'))[0].rows[0][0] === '{"b":1}');
check('null becomes an empty cell', extractReplyTables(fenced('[{"a":null}]'))[0].rows[0][0] === '');
check('booleans and numbers survive as text', JSON.stringify(extractReplyTables(fenced('[{"a":true,"b":0}]'))[0].rows[0]) === '["true","0"]');

// Only arrays convert. A guess here becomes a spreadsheet someone works from.
check('a bare object is NOT a table', extractReplyTables(fenced('{"a":1}')).length === 0);
check('an empty array is NOT a table', extractReplyTables(fenced('[]')).length === 0);
check('a scalar is NOT a table', extractReplyTables(fenced('42')).length === 0);
check('unparseable JSON is NOT a table', extractReplyTables(fenced('{oops')).length === 0);

// Other languages are skipped WHOLE, so a pipe inside code cannot be read as a table row.
check('a JS block is ignored', extractReplyTables(fenced('const a = b | c;', 'js')).length === 0);
check('an HTML block is ignored', extractReplyTables(fenced('<a href="x">y</a>', 'html')).length === 0);
check('a pipe inside a code block never becomes a table',
  extractReplyTables([FENCE + 'js', 'a | b', '--|--', 'c | d', FENCE].join('\n')).length === 0);

// Mixed content still finds both kinds.
check('a JSON block and a pipe table coexist',
  extractReplyTables([fenced(ROWS), '', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')).length === 2);
check('a heading titles the JSON table', extractReplyTables(['## Tags', fenced(ROWS)].join('\n'))[0].title === 'Tags');

// ── exportReplyFilename ─────────────────────────────────────────────────────────
// The default save name should describe what the file CONTAINS - the reply's title, else the user's
// request - not a generic "chat report".
const efn = (reply: string, ask: string): string => exportReplyFilename(reply, ask, 'gtm', '2026-07-27');
check('names the file after a reply heading', efn('## Custom Event Triggers\n\n| A |\n|---|\n| x |', 'anything') === 'GTM - Custom Event Triggers 2026-07-27');
check('falls back to the user request when the reply has no title',
  efn('"GA4 - Event - A Tag","form_submission"\n"GA4 - Event - B Tag","form_submission"', 'list down all the custom-event triggers and there customEventName')
    === 'GTM - custom-event triggers and there customEventName 2026-07-27');
check('strips a trailing "export as csv" from the request', efn('"a","b"\n"c","d"', 'give me the trigger names as a csv') === 'GTM - trigger names 2026-07-27');
check('generic fallback when neither a title nor a usable request exists', efn('| A |\n|---|\n| x |', '') === 'GTM chat report 2026-07-27');
check('forbidden filename characters are stripped', !/[\\/:*?"<>|]/.test(efn('## Tags: A/B * C?', 'x')));
check('a non-generic table title beats the request', efn('**Trigger Inventory**\n| A | B |\n|---|---|\n| 1 | 2 |', 'export it') === 'GTM - Trigger Inventory 2026-07-27');
check('safeFilePart drops forbidden chars and trailing dots', safeFilePart('a/b:c*d.') === 'a b c d');

// ── CSV blocks ──────────────────────────────────────────────────────────────────
// A model asked for CSV emits comma-quoted rows (often in a fence), which the exporter could not read
// - so the CSV button sat disabled on a reply that was ALREADY csv data.
const CSV_BODY = ['name,form', '"GA4 - Event - A Tag","A"', '"GA4 - Event - B Tag","B"'].join('\n');
check('a ```csv fence becomes a table', extractReplyTables(fenced(CSV_BODY, 'csv')).length === 1);
check('the CSV header is the first row', JSON.stringify(extractReplyTables(fenced(CSV_BODY, 'csv'))[0].header) === '["name","form"]');
check('CSV data rows are parsed', extractReplyTables(fenced(CSV_BODY, 'csv'))[0].rows.length === 2);
check('a quoted comma stays inside its cell', extractReplyTables(fenced('a,b\n"x,1","y"', 'csv'))[0].rows[0][0] === 'x,1');
check('doubled quotes unescape', extractReplyTables(fenced('a,b\n"say ""hi""","y"', 'csv'))[0].rows[0][0] === 'say "hi"');
check('a BARE fence of CSV is tried too (models emit both)', extractReplyTables(fenced(CSV_BODY, ''))[0]?.rows.length === 2);
check('a CSV reply now earns a CSV export', replyCsv(fenced(CSV_BODY, 'csv')).includes('name,form'));
check('a one-column / one-row block is NOT a CSV table', extractReplyTables(fenced('just one column\nno commas here', 'csv')).length === 0);
check('a JS fence with a comma is NOT read as CSV', extractReplyTables(fenced('const a = 1, b = 2;', 'js')).length === 0);

// Header synthesis: a HEADERLESS data dump (row 0 fits the same series as the rest) gets Column N
// headers, and its first row is kept as DATA - not silently promoted to a header.
const HEADERLESS = [
  '"GA4 - Event - PLP Shell Testing Tag","PLP Shell Testing"',
  '"GA4 - Event - Clover POS Tag","Clover POS"',
  '"GA4 - Event - Toast POS Tag","Toast POS"',
].join('\n');
const hl = extractReplyTables(fenced(HEADERLESS, 'csv'));
check('a headerless CSV dump still becomes a table', hl.length === 1);
check('synthetic Column N headers are used when none is detected', JSON.stringify(hl[0].header) === '["Column 1","Column 2"]');
check('the first row is kept as DATA, not promoted to a header', hl[0].rows.length === 3 && hl[0].rows[0][1] === 'PLP Shell Testing');
check('a real header is NOT replaced by synthetic ones', JSON.stringify(extractReplyTables(fenced(CSV_BODY, 'csv'))[0].header) === '["name","form"]');
check('a numeric first row is treated as data (headers are not numbers)', JSON.stringify(extractReplyTables(fenced('1,2\n3,4\n5,6', 'csv'))[0].header) === '["Column 1","Column 2"]');
check('duplicate first-row labels are treated as data', extractReplyTables(fenced('x,x\na,b\nc,d', 'csv'))[0].header[0] === 'Column 1');

// ── pipe tables WITHOUT a separator (matches the chat renderer) ──────────────────
check('a pipe table missing its |---| separator is still extracted', extractReplyTables('| A | B |\n| 1 | 2 |\n| 3 | 4 |').length === 1);
check('that table has both data rows', extractReplyTables('| A | B |\n| 1 | 2 |\n| 3 | 4 |')[0].rows.length === 2);
check('a lone pipe-pair (no separator, <2 rows) is NOT a table', extractReplyTables('a | b\nc | d').length === 0);

if (failures.length) console.error(failures.join('\n'));
console.log(`chat-export: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
