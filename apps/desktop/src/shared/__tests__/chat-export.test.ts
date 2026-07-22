// Pure tests for the chat-reply export builders (table extraction, CSV, exportability, sheet names).
// Run: tsx src/shared/__tests__/chat-export.test.ts
import { extractReplyTables, replyLooksExportable, replyCsv, sheetNameFor } from '../chat-export';

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

if (failures.length) console.error(failures.join('\n'));
console.log(`chat-export: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
