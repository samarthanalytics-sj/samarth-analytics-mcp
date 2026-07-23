/**
 * Every GTM list tool must either paginate or say why it does not.
 * Run: node src/__tests__/listPagination.node.test.mjs
 *
 * pagination.node.test.mjs already proves the `paginate` HELPER walks tokens correctly. That is a
 * different thing from proving the TOOLS call it, and the gap between the two is where this bug
 * lived: accounts_list and versions_list each made a single .list() call and reported
 * `count: items.length` as though it were the total, while six sibling tools paginated properly.
 * A helper nobody calls protects nothing.
 *
 * So this reads the actual source and holds every `.list(` call to one of two states: it goes
 * through `paginate`, or the endpoint genuinely cannot paginate and the source says so. The second
 * case is real - destinations.list accepts only `parent`, with no pageToken - and it has to be
 * expressible, or the honest answer would be indistinguishable from the bug.
 */

import assert from 'assert';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');

/** Endpoints whose Params type has NO pageToken, so a single call is the whole answer. Each needs a
 *  source comment explaining it, checked below - an entry here is a claim, not a way to opt out. */
const CANNOT_PAGINATE = ['destinations'];

let passed = 0;
const check = (name, cond, detail) => {
  assert.ok(cond, `${name}${detail ? ' - ' + detail : ''}`);
  passed += 1;
  console.log(`  ok   ${name}`);
};

const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
check('there are tool files to inspect', files.length > 0, `${files.length}`);

let listCalls = 0;
let paginated = 0;
const unpaginated = [];

for (const file of files) {
  const src = readFileSync(join(TOOLS_DIR, file), 'utf-8');
  const usesHelper = src.includes("from '../utils/pagination.js'");
  // Every `.list(` on a googleapis client resource in this file.
  const calls = [...src.matchAll(/client\.[A-Za-z0-9_.]*\.([A-Za-z0-9_]+)\.list\(/g)];
  for (const m of calls) {
    listCalls += 1;
    const resource = m[1];
    // Is this call inside a paginate(...) wrapper? The helper takes the fetch as its first arg, so
    // the call site sits within ~400 chars after a `paginate(`.
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const insidePaginate = /paginate\(\s*$|paginate\(\s*\n\s*\(token\)[^)]*$/.test(before) || /paginate\(/.test(before);
    if (usesHelper && insidePaginate) {
      paginated += 1;
    } else {
      unpaginated.push({ file, resource, index: m.index });
    }
  }
}

check('the scan found the list calls', listCalls >= 7, `${listCalls} calls`);
check('most list calls paginate', paginated >= 6, `${paginated} paginated of ${listCalls}`);

// The heart of it: an unpaginated call is only acceptable when the endpoint cannot paginate AND the
// source says so where a future reader will see it.
for (const u of unpaginated) {
  const exempt = CANNOT_PAGINATE.includes(u.resource);
  check(
    `${u.file}: ${u.resource}.list is either paginated or a declared exception`,
    exempt,
    `${u.resource}.list does not paginate and is not in CANNOT_PAGINATE. If the endpoint takes a pageToken, wrap it in paginate(); if it truly does not, add it to CANNOT_PAGINATE with a source comment.`
  );
  const src = readFileSync(join(TOOLS_DIR, u.file), 'utf-8');
  check(
    `${u.file}: the ${u.resource} exception is explained in the source`,
    /no pageToken|cannot paginate|NOT paginated/i.test(src),
    'an exemption with no explanation is indistinguishable from an oversight'
  );
}

// The two tools this fixed. Named explicitly so a revert fails loudly rather than quietly.
const accounts = readFileSync(join(TOOLS_DIR, 'accounts.ts'), 'utf-8');
check('accounts_list paginates', accounts.includes('paginate(') && accounts.includes('buildListResult'));
check('accounts_list no longer hand-rolls its count', !/count: accounts\.length/.test(accounts));

const versions = readFileSync(join(TOOLS_DIR, 'versions.ts'), 'utf-8');
check('versions_list paginates', versions.includes('paginate(') && versions.includes('buildListResult'));
check('versions_list no longer hand-rolls its count', !/count: versions\.length/.test(versions));

// buildListResult only adds nextPageToken when actually truncated, so a complete answer is
// byte-identical to what callers saw before. Worth pinning: the fix must not change clean results.
const pag = readFileSync(join(TOOLS_DIR, '..', 'utils', 'pagination.ts'), 'utf-8');
check('a non-truncated result gains no pagination noise', /if \(result\.truncated\)/.test(pag));

console.log(`\nlistPagination: ${passed} checks passed`);
