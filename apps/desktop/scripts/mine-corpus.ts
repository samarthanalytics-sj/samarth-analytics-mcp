// Corpus miner (run MANUALLY on the machine that has the raw GTM exports; the repo never contains them):
//   npx tsx scripts/mine-corpus.ts [inputDir] [outputFile]
// Defaults: inputDir = the local GTM_Consolidated folder, outputFile = src/shared/corpus/gtm-pattern-library.json
// Parses every export, mines the anonymized pattern library (see shared/corpus-patterns.ts for the
// anonymization layers), HARD-FAILS on any leak-scan hit, then writes the artifact + prints stats.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { minePatternLibrary, scanForLeaks, type CorpusExport } from '../src/shared/corpus-patterns';

const inputDir = process.argv[2] ?? 'F:\\New folder\\GTM_Consolidated';
const outFile = resolve(process.argv[3] ?? join(__dirname, '..', 'src', 'shared', 'corpus', 'gtm-pattern-library.json'));

if (!existsSync(inputDir)) {
  console.error(`Input directory not found: ${inputDir}`);
  console.error('Usage: npx tsx scripts/mine-corpus.ts [inputDir] [outputFile]');
  process.exit(1);
}

const files = readdirSync(inputDir).filter((f) => f.toLowerCase().endsWith('.json'));
console.log(`Reading ${files.length} export(s) from ${inputDir} ...`);

const exports_: CorpusExport[] = [];
let unreadable = 0;
for (const f of files) {
  try {
    exports_.push(JSON.parse(readFileSync(join(inputDir, f), 'utf8')) as CorpusExport);
  } catch {
    unreadable += 1;
  }
}
if (unreadable) console.warn(`Skipped ${unreadable} unreadable file(s).`);

const minedAt = new Date().toISOString().slice(0, 10); // date only — never a precise timestamp
const lib = minePatternLibrary(exports_, minedAt);

const json = JSON.stringify(lib, null, 1);
const leaks = scanForLeaks(json);
if (leaks.length) {
  console.error('LEAK SCAN FAILED — the artifact was NOT written. Hits:');
  for (const l of leaks) console.error(`  [${l.name}] ...${l.sample}...`);
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, json, 'utf8');

console.log(`\nPattern library written: ${outFile}`);
console.log(`  containers scanned : ${lib.containersScanned}`);
console.log(`  tag patterns       : ${lib.tagPatterns.length}`);
console.log(`  trigger patterns   : ${lib.triggerPatterns.length}`);
console.log(`  variable patterns  : ${lib.variablePatterns.length}`);
console.log(`  vendors            : ${lib.vendorStats.map((v) => `${v.brand}(${v.containers})`).join(' ')}`);
console.log(`  artifact size      : ${(json.length / 1024).toFixed(0)} KB`);
console.log(`  leak scan          : clean`);
console.log('\nTop tag patterns:');
for (const p of lib.tagPatterns.slice(0, 10)) {
  console.log(`  ${String(p.containers).padStart(4)}x  ${p.type}${p.eventName ? ` "${p.eventName}"` : ''}  consent=${p.consent ?? '-'}  fires=[${p.triggerKinds.join(',')}]`);
}
console.log('\nTop trigger patterns:');
for (const p of lib.triggerPatterns.slice(0, 10)) {
  console.log(`  ${String(p.containers).padStart(4)}x  ${p.type}${p.event ? ` "${p.event}"` : ''}  ${p.conditions.join(' AND ') || '(no conditions)'}`);
}
