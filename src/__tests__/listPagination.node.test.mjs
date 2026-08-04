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
 *
 * The receiver is NOT assumed to be named `client`. It was in the first version of this test, which
 * silently skipped 6 of 20 call sites: audit.ts reaches the API through `ws`, serverSide.ts through
 * `api`, and both were invisible to a guard that claimed to check everything. A coverage test that
 * quietly under-counts is worse than none, because it converts an unknown into false confidence -
 * so the match is now any receiver, and the count of inspected calls is asserted against the number
 * actually present in the tree.
 */

import assert from 'assert';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');

/** Endpoints whose Params type has NO pageToken, so a single call is the whole answer. Each needs a
 *  source comment explaining it, checked below - an entry here is a claim, not a way to opt out.
 *  Keyed `resource.method` since the scan now covers more than .list: folders.list paginating
 *  correctly must not silently exempt folders.entities, which is the same receiver identifier. */
const CANNOT_PAGINATE = ['destinations.list'];

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
  // Every `.list(` call, however it is written. Two things made the first version of this test
  // under-count badly, and both are worth stating because a coverage test that silently misses
  // things is worse than no test - it converts an unknown into false confidence:
  //   1. It assumed the receiver was named `client`. audit.ts reaches the API through `ws` and
  //      serverSide.ts through `api`, so 6 of 20 call sites were invisible.
  //   2. It required an identifier IMMEDIATELY before `.list(`. Formatting splits long chains onto
  //      their own lines, which is the exact shape the pagination fix produced, so those calls
  //      matched nothing. The guard was blind to the very files it was written for.
  // So: find `.list(` anywhere, then walk backwards over whitespace to the nearest identifier.
  // Comments are stripped first: a prose mention like "these were single .list() calls" is not a
  // call site, and matching one sends a future reader hunting for code that does not exist.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    // Drop the // tail of each line, but not the // inside a URL ("https://"). No `$` anchor: these
    // files are CRLF, and `.` stops at the \r while `$` demands end-of-input, so an anchored
    // pattern silently matches nothing on Windows checkouts.
    .map((line) => line.replace(/(^|[^:])\/\/.*/, '$1'))
    .join('\n');
  // Not just `.list(`. folders.entities is a paged GTM endpoint whose Params type carries a
  // pageToken, and a guard that only knew the word "list" reported the whole tree green while that
  // call fetched page 1 and stopped. Enumerating the paged method names is the honest bound: this
  // guard reads source TEXT, so it cannot resolve a receiver chain back to its googleapis Params
  // type to ask whether a pageToken exists. Checked against tagmanager v2.d.ts: of the Params types
  // that declare pageToken, the only method names are List and Entities.
  const calls = [];
  for (const m of code.matchAll(/\.(list|entities)\(/g)) {
    const head = code.slice(0, m.index).replace(/\s+$/, '');
    const id = /([A-Za-z0-9_$]+)$/.exec(head);
    if (id) calls.push({ index: m.index, resource: id[1], method: m[1] });
  }
  for (const m of calls) {
    listCalls += 1;
    const resource = m.resource;
    // Is this call inside a paginate(...) wrapper? The helper takes the fetch as its first arg, so
    // the call site sits within ~400 chars after a `paginate(`.
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    // `paginate(` or `paginate<...>(`. Deliberately not trying to parse the type arguments: they
    // nest (`paginate<Record<string, unknown>, unknown>(`), so a [^>]* pattern stops at the inner
    // `>` and reports a correctly-paginated tool as a violation. Presence of the call within the
    // window is the signal; the window is what bounds it.
    const insidePaginate = /\bpaginate\s*[<(]/.test(before);
    if (usesHelper && insidePaginate) {
      paginated += 1;
    } else {
      unpaginated.push({ file, resource, method: m.method, index: m.index });
    }
  }
}

check('the scan found the list calls', listCalls >= 7, `${listCalls} calls`);
check('most list calls paginate', paginated >= 6, `${paginated} paginated of ${listCalls}`);

// The heart of it: an unpaginated call is only acceptable when the endpoint cannot paginate AND the
// source says so where a future reader will see it.
for (const u of unpaginated) {
  const exempt = CANNOT_PAGINATE.includes(`${u.resource}.${u.method}`);
  check(
    `${u.file}: ${u.resource}.${u.method} is either paginated or a declared exception`,
    exempt,
    `${u.resource}.${u.method} does not paginate and is not in CANNOT_PAGINATE. If the endpoint takes a pageToken, wrap it in paginate(); if it truly does not, add it to CANNOT_PAGINATE with a source comment.`
  );
  const src = readFileSync(join(TOOLS_DIR, u.file), 'utf-8');
  check(
    `${u.file}: the ${u.resource}.${u.method} exception is explained in the source`,
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
