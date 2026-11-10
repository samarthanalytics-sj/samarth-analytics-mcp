/**
 * Node test for the server.json version sync (scripts/sync-server-json.mjs).
 *
 * The hole: server.json (the MCP Registry manifest) said 1.19.0 in two places while package.json said
 * 1.497.3. No release step wrote the new version into it, and no test failed when the two drifted
 * apart, so the manifest stayed at an old version.
 *
 * The wiring: @semantic-release/npm runs `npm version <next>` in its prepare step. npm writes
 * package.json and package-lock.json first and then runs the "version" lifecycle script, which is the
 * sync script. @semantic-release/git runs after that and commits server.json with the other release
 * files.
 *
 * Sections 1 and 2 read the real files in the repo, so they fail as soon as the manifest and the
 * package disagree or a part of the wiring is removed. Section 3 is the pure function. Section 4 runs
 * the CLI on copies in a temp directory; it never writes to the real server.json.
 *
 * Imports the SOURCE script (it is plain .mjs, there is no build step for it).
 * Run: node src/__tests__/serverJsonSync.node.test.mjs
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const script = path.join(repoRoot, 'scripts/sync-server-json.mjs');

const read = (file) => readFileSync(path.join(repoRoot, file), 'utf-8');
const pkg = JSON.parse(read('package.json'));
const serverJsonText = read('server.json');
const serverJson = JSON.parse(serverJsonText);
const releaserc = JSON.parse(read('.releaserc.json'));

// Loaded softly so that, before the script exists, the tests fail one by one with a reason instead of
// the whole suite dying on the import.
let syncServerJson;
if (existsSync(script)) {
  ({ syncServerJson } = await import(pathToFileURL(script).href));
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

/** The plugin entry in .releaserc.json, as [name, options]. A bare string entry has no options. */
function plugin(name) {
  const index = releaserc.plugins.findIndex((p) => (Array.isArray(p) ? p[0] : p) === name);
  const entry = releaserc.plugins[index];
  return { index, options: Array.isArray(entry) ? (entry[1] ?? {}) : {} };
}

const npmEntries = (manifest) => (manifest.packages ?? []).filter((p) => p.registryType === 'npm');

// ---------------------------------------------------------------------------
// 1. The committed server.json matches package.json
// ---------------------------------------------------------------------------

console.log('\nserver.json matches package.json');

await test('REGRESSION: the top-level version is the package.json version', () => {
  assert.strictEqual(serverJson.version, pkg.version);
});

await test('REGRESSION: the npm package entry carries the package.json version', () => {
  const entries = npmEntries(serverJson);
  assert.ok(entries.length > 0, 'server.json has no packages[] entry with registryType "npm"');
  for (const entry of entries) assert.strictEqual(entry.version, pkg.version);
});

await test('the server name is the package.json mcpName', () => {
  // The registry reads mcpName from the published npm package to prove who owns the name.
  assert.ok(pkg.mcpName, 'package.json has no mcpName');
  assert.strictEqual(serverJson.name, pkg.mcpName);
});

await test('the npm package identifier is the package.json name', () => {
  const entries = npmEntries(serverJson);
  assert.ok(entries.length > 0, 'server.json has no packages[] entry with registryType "npm"');
  for (const entry of entries) assert.strictEqual(entry.identifier, pkg.name);
});

// ---------------------------------------------------------------------------
// 2. The release keeps it that way
// ---------------------------------------------------------------------------

console.log('\nrelease wiring');

await test('the "version" lifecycle script runs the sync script', () => {
  // `npm version` runs this script after it has written the new version to package.json.
  assert.strictEqual(pkg.scripts.version, 'node scripts/sync-server-json.mjs');
  assert.ok(existsSync(script), 'scripts/sync-server-json.mjs does not exist');
});

await test('the release commit includes server.json', () => {
  const git = plugin('@semantic-release/git');
  assert.ok(git.index >= 0, '@semantic-release/git is not in .releaserc.json');
  assert.ok(
    git.options.assets.includes('server.json'),
    `git assets are ${JSON.stringify(git.options.assets)}`
  );
  // The files npm itself rewrites must stay in the same commit.
  for (const asset of ['CHANGELOG.md', 'package.json', 'package-lock.json']) {
    assert.ok(git.options.assets.includes(asset), `git assets lost ${asset}`);
  }
});

await test('@semantic-release/npm prepares before @semantic-release/git commits', () => {
  // Prepare steps run in plugin order. The other way round, the commit is made before `npm version`
  // has run the hook, and server.json stays one release behind.
  const npm = plugin('@semantic-release/npm');
  const git = plugin('@semantic-release/git');
  assert.ok(npm.index >= 0, '@semantic-release/npm is not in .releaserc.json');
  assert.ok(npm.index < git.index, `npm is plugin ${npm.index}, git is plugin ${git.index}`);
});

await test('nothing turns npm lifecycle scripts off for the release', () => {
  // With ignore-scripts set, `npm version` still bumps package.json but skips the hook without a word.
  // npm 11.21.1 skips it for more than `=true`: also for a bare key, an empty value, "true" in quotes,
  // 1, 0, FALSE and `false x`. So the check goes the other way round: every ignore-scripts setting
  // fails unless its value is a plain false (false, "false" or 'false') and the line ends there. With
  // these three forms npm 11.21.1 keeps the hook on.
  const plainFalse = /^["']?[ \t]*[:= \t][ \t]*(?:false|"false"|'false')[ \t]*$/;
  // `key` finds the key and captures the rest of its line. The result is the settings that are not false.
  const notFalse = (text, key) =>
    [...text.matchAll(key)].filter((m) => !plainFalse.test(m[1])).map((m) => (m[0] + m[1]).trim());

  // .npmrc in the repo root, tracked or not: every line that starts with ignore-scripts. Whitespace
  // before the key is allowed, also a byte order mark or another Unicode space (npm trims them). A
  // comment line starts with ; or #, so it does not count.
  const npmrc = path.join(repoRoot, '.npmrc');
  if (existsSync(npmrc)) {
    const found = notFalse(readFileSync(npmrc, 'utf-8'), /^[^\S\r\n]*["']?ignore-scripts(?=(.*))/gim);
    assert.deepStrictEqual(found, [], `.npmrc sets ignore-scripts: ${JSON.stringify(found)}`);
  }

  // release.yml: every mention, in any spelling and anywhere in the file (NPM_CONFIG_IGNORE_SCRIPTS,
  // `npm config set ignore-scripts true`, --ignore-scripts). A comment counts too, and so does a flag on
  // one command such as `npm ci --ignore-scripts`, which does not reach `npm version`. The check does
  // not tell these apart. It fails on all of them, unless a plain false ends the line, so that a person
  // looks at the line.
  const found = notFalse(read('.github/workflows/release.yml'), /ignore[-_]scripts(?=(.*))/gi);
  assert.deepStrictEqual(found, [], `release.yml mentions ignore-scripts: ${JSON.stringify(found)}`);
});

// ---------------------------------------------------------------------------
// 3. syncServerJson (pure)
// ---------------------------------------------------------------------------

console.log('\nsyncServerJson');

const FIXTURE = {
  $schema: 'https://example.test/server.schema.json',
  name: 'io.github.example/demo',
  description: 'Demo server',
  version: '1.0.0',
  packages: [
    {
      registryType: 'npm',
      identifier: 'demo-mcp',
      version: '1.0.0',
      transport: { type: 'stdio' },
      environmentVariables: [{ name: 'DEMO_KEY', isRequired: true, isSecret: true }],
    },
    { registryType: 'npm', identifier: 'some-other-package', version: '0.3.0', transport: { type: 'stdio' } },
    { registryType: 'oci', identifier: 'demo-mcp', version: '0.9.0', transport: { type: 'stdio' } },
  ],
};
const fixture = () => structuredClone(FIXTURE);

function sync(...args) {
  assert.ok(typeof syncServerJson === 'function', 'syncServerJson is not exported by scripts/sync-server-json.mjs');
  return syncServerJson(...args);
}

await test('sets the top-level version and the version of the matching npm entry', () => {
  const out = sync(fixture(), '2.5.1', 'demo-mcp');
  assert.strictEqual(out.version, '2.5.1');
  assert.strictEqual(out.packages[0].version, '2.5.1');
});

await test('leaves everything else untouched, key order included', () => {
  const out = sync(fixture(), '2.5.1', 'demo-mcp');
  const expected = fixture();
  expected.version = '2.5.1';
  expected.packages[0].version = '2.5.1';
  assert.deepStrictEqual(out, expected);
  // deepStrictEqual does not look at key order, and key order decides the bytes written to disk.
  assert.strictEqual(JSON.stringify(out), JSON.stringify(expected));
});

await test('does not touch an npm entry for another package, or a non-npm entry with the same name', () => {
  const out = sync(fixture(), '2.5.1', 'demo-mcp');
  assert.strictEqual(out.packages[1].version, '0.3.0');
  assert.strictEqual(out.packages[2].version, '0.9.0');
});

await test('updates every matching npm entry, not only the first', () => {
  const input = fixture();
  input.packages.push({ registryType: 'npm', identifier: 'demo-mcp', version: '1.0.0', transport: { type: 'sse' } });
  const out = sync(input, '2.5.1', 'demo-mcp');
  assert.deepStrictEqual(
    out.packages.map((p) => p.version),
    ['2.5.1', '0.3.0', '0.9.0', '2.5.1']
  );
});

await test('does not change the object it was given', () => {
  const input = fixture();
  sync(input, '2.5.1', 'demo-mcp');
  assert.deepStrictEqual(input, FIXTURE);
});

await test('a second pass with the same version changes nothing', () => {
  const once = sync(fixture(), '2.5.1', 'demo-mcp');
  assert.strictEqual(JSON.stringify(sync(once, '2.5.1', 'demo-mcp')), JSON.stringify(once));
});

await test('throws when the top-level version is missing', () => {
  const input = fixture();
  delete input.version;
  assert.throws(() => sync(input, '2.5.1', 'demo-mcp'), /no top-level "version"/);
});

await test('throws when packages is missing', () => {
  const input = fixture();
  delete input.packages;
  assert.throws(() => sync(input, '2.5.1', 'demo-mcp'), /no "packages" array/);
});

await test('throws when no npm entry is for this package', () => {
  assert.throws(() => sync(fixture(), '2.5.1', 'renamed-mcp'), /registryType "npm" and identifier "renamed-mcp"/);
});

await test('throws when the matching npm entry has no version', () => {
  const input = fixture();
  delete input.packages[0].version;
  assert.throws(() => sync(input, '2.5.1', 'demo-mcp'), /packages\[0\].*no "version"/);
});

await test('throws on a version that is not a valid semantic version', () => {
  for (const bad of ['', 'latest', '^2.5.1', 'v2.5.1', '2.5', undefined]) {
    assert.throws(() => sync(fixture(), bad, 'demo-mcp'), /not a valid version/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(sync(fixture(), '3.0.0-beta.1', 'demo-mcp').version, '3.0.0-beta.1');
  // The pre-release and build parts follow semver.org too: a numeric pre-release part has no leading
  // zero, and no dot-separated part is empty.
  for (const bad of ['1.0.0-01', '1.0.0-a..b', '1.0.0+..']) {
    assert.throws(() => sync(fixture(), bad, 'demo-mcp'), /not a valid version/, `accepted ${JSON.stringify(bad)}`);
  }
  for (const good of ['1.0.0--', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0+20130313144700', '1.0.0-alpha+001']) {
    assert.strictEqual(sync(fixture(), good, 'demo-mcp').version, good, `rejected ${JSON.stringify(good)}`);
  }
});

await test('throws when one of the three numbers has a leading zero', () => {
  for (const bad of ['01.2.3', '1.02.3', '1.2.03', '00.0.0']) {
    assert.throws(() => sync(fixture(), bad, 'demo-mcp'), /not a valid version/, `accepted ${JSON.stringify(bad)}`);
  }
  // A zero alone, a zero inside a number, pre-release and build forms, and the real version of this
  // package still pass.
  for (const good of ['0.0.0', '0.1.0', '10.20.30', '1.0.0-rc.1', '1.0.0+build.5', pkg.version]) {
    assert.strictEqual(sync(fixture(), good, 'demo-mcp').version, good, `rejected ${JSON.stringify(good)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The CLI, on copies in a temp directory
// ---------------------------------------------------------------------------

console.log('\nCLI');

/**
 * Writes the given files into a fresh temp dir and hands fn a `run(args)` that runs the CLI there.
 * `text` in the result is server.json as the run left it.
 */
function withCliDir(files, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sync-server-json-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    const run = (args = []) => {
      const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf-8' });
      const text = readFileSync(path.join(dir, 'server.json'), 'utf-8');
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, text };
    };
    return fn(run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cliPackageJson = (version) => JSON.stringify({ name: 'demo-mcp', version }, null, 2) + '\n';
const cliServerJson = (indent = 2, eof = '\n') => JSON.stringify(FIXTURE, null, indent) + eof;

await test('without an argument it takes the version from package.json', () => {
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson() }, (run) => {
    const r = run();
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.text);
    assert.strictEqual(out.version, '4.2.0');
    assert.strictEqual(out.packages[0].version, '4.2.0');
  });
});

await test('a version argument wins over package.json', () => {
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson() }, (run) => {
    const r = run(['9.9.9']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.text);
    assert.strictEqual(out.version, '9.9.9');
    assert.strictEqual(out.packages[0].version, '9.9.9');
  });
});

await test('only the two version strings change in the file', () => {
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson() }, (run) => {
    const r = run();
    assert.strictEqual(r.status, 0, r.stderr);
    const expected = fixture();
    expected.version = '4.2.0';
    expected.packages[0].version = '4.2.0';
    assert.strictEqual(r.text, JSON.stringify(expected, null, 2) + '\n');
  });
});

await test('keeps the indentation and the missing final newline of the file it found', () => {
  for (const [indent, eof] of [[4, ''], ['\t', '\n'], [2, '']]) {
    withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson(indent, eof) }, (run) => {
      const r = run();
      assert.strictEqual(r.status, 0, r.stderr);
      const expected = fixture();
      expected.version = '4.2.0';
      expected.packages[0].version = '4.2.0';
      assert.strictEqual(r.text, JSON.stringify(expected, null, indent) + eof, `indent ${JSON.stringify(indent)}`);
    });
  }
});

await test('a second run changes nothing', () => {
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson() }, (run) => {
    const first = run();
    const second = run();
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(second.text, first.text);
    assert.match(second.stdout, /already/);
  });
});

await test('REGRESSION: on the committed files it is a no-op, byte for byte', () => {
  // The real server.json is in step and in the layout the script writes: a run changes no byte.
  // This does not show who wrote the file. A hand edit in the same layout passes too.
  withCliDir({ 'package.json': read('package.json'), 'server.json': serverJsonText }, (run) => {
    const r = run();
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.text, serverJsonText);
  });
});

await test('a missing field stops it with exit 1, a reason, and the file untouched', () => {
  const broken = fixture();
  delete broken.packages[0].version;
  const text = JSON.stringify(broken, null, 2) + '\n';
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': text }, (run) => {
    const r = run();
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /sync-server-json: .*packages\[0\].*no "version"/);
    assert.strictEqual(r.text, text);
  });
});

await test('a package.json without a version stops it with exit 1', () => {
  const noVersion = JSON.stringify({ name: 'demo-mcp' }, null, 2) + '\n';
  withCliDir({ 'package.json': noVersion, 'server.json': cliServerJson() }, (run) => {
    const r = run();
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /sync-server-json: .*package\.json has no "version"/);
    assert.strictEqual(r.text, cliServerJson());
  });
});

await test('a bad version argument stops it with exit 1 and the file untouched', () => {
  withCliDir({ 'package.json': cliPackageJson('4.2.0'), 'server.json': cliServerJson() }, (run) => {
    const r = run(['--help']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /sync-server-json: .*not a valid version/);
    assert.strictEqual(r.text, cliServerJson());
  });
});

console.log(`\nserverJsonSync: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
