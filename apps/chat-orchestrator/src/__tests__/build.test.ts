/**
 * Build-output guards.
 *
 * These exist because a green typecheck does not mean the compiled service starts. The first
 * deployable build of this service crashed at startup on a module-format mismatch that `tsx` hid
 * in development, so the properties that only appear after `tsc` are asserted here.
 *
 * Run after `npm run build`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(here, '../../dist');

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

if (!existsSync(distRoot)) {
  console.log('build: dist/ not found, run "npm run build" first. Skipping.');
  process.exit(0);
}

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(distRoot);

console.log('build output');

test('the entrypoint the Dockerfile CMD names actually exists', () => {
  // Dockerfile: CMD ["node", "dist/chat-orchestrator/src/index.js"]
  assert.ok(
    existsSync(join(distRoot, 'chat-orchestrator/src/index.js')),
    'dist/chat-orchestrator/src/index.js is missing, so the container would exit immediately',
  );
});

test('every emitted file is ESM, including files pulled in from other apps', () => {
  // A CommonJS file emitted into this "type": "module" package cannot be imported, and the
  // failure only surfaces at startup.
  const cjs = files.filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /^\s*(?:"use strict";\s*)?(?:Object\.defineProperty\(exports|exports\.\w+\s*=)/m.test(src);
  });
  assert.deepEqual(
    cjs.map((f) => f.slice(distRoot.length + 1)),
    [],
    'these files emitted as CommonJS inside an ESM package',
  );
});

test('the shared GTM methodology is present and exports what the prompt imports', () => {
  const shared = join(distRoot, 'desktop/src/shared/gtm-methodology.js');
  assert.ok(existsSync(shared), 'the cross-app methodology import did not emit');
  const src = readFileSync(shared, 'utf8');
  for (const name of ['GA4_EVENT_SELECTION', 'GTM_DECISION_RULES']) {
    assert.match(src, new RegExp(`export const ${name}\\b`), `${name} is not an ESM named export`);
  }
});

test('relative imports carry a .js extension', () => {
  // moduleResolution "Bundler" does not require the extension, but Node does. Without this guard
  // an extensionless import compiles cleanly and throws ERR_MODULE_NOT_FOUND in production.
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      const spec = m[1];
      if (!spec.endsWith('.js') && !spec.endsWith('.json')) {
        offenders.push(`${file.slice(distRoot.length + 1)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'extensionless relative imports will fail at runtime under Node');
});

test('the compiled attachments.js extracts PDF text in its worker under plain node', () => {
  // The worker resolves pdf-parse from attachments.js's own location, so only a run of the compiled
  // file proves that resolution works where the container starts it.
  const attachments = join(distRoot, 'chat-orchestrator/src/attachments.js');
  assert.ok(existsSync(attachments), 'attachments.js did not emit');
  const stream = 'BT /F1 12 Tf 72 700 Td (Compiled worker text) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `xref\n0 6\n0000000000 65535 f \n${rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;

  // A clean `node file.mjs`, as the container runs it: not this tsx process, whose loader flags a
  // worker would inherit, and not `node -e`, whose eval flags it would inherit too.
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-build-'));
  try {
    const runner = join(dir, 'run.mjs');
    writeFileSync(
      runner,
      `const { extractAttachment } = await import(process.argv[2]);\n` +
        `const out = await extractAttachment({ name: 'built.pdf', dataBase64: process.argv[3] });\n` +
        `process.stdout.write(out.text);\n`,
    );
    const run = spawnSync(
      process.execPath,
      [runner, pathToFileURL(attachments).href, Buffer.from(pdf, 'latin1').toString('base64')],
      { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '' } },
    );
    assert.equal(run.status, 0, `compiled PDF extraction failed: ${run.stderr}`);
    assert.match(run.stdout, /Compiled worker text/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} assertions passed`);
