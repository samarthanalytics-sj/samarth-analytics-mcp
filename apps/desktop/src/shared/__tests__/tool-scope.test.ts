// Tests for container-kind tool scoping. The invariant that matters is FAIL-OPEN: filtering exists
// only to shrink the request, so anything uncertain must send the full list rather than hide a tool.
// Run: tsx src/shared/__tests__/tool-scope.test.ts
import {
  containerKindFromUsageContext, toolAllowedForContainer,
  SERVER_ONLY_TOOLS, WEB_ONLY_TOOLS,
} from '../tool-scope';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Reading the kind off GTM's usageContext ──────────────────────────────────────
check('kind: web', containerKindFromUsageContext(['web']) === 'web');
check('kind: server', containerKindFromUsageContext(['server']) === 'server');
check('kind: GTM may echo the value uppercased', containerKindFromUsageContext(['SERVER']) === 'server');
check('kind: server wins when a container claims both', containerKindFromUsageContext(['web', 'server']) === 'server');
// Everything below must be UNDEFINED so the caller sends every tool.
check('kind: amp is not reasoned about', containerKindFromUsageContext(['amp']) === undefined);
check('kind: mobile is not reasoned about', containerKindFromUsageContext(['ios']) === undefined && containerKindFromUsageContext(['android']) === undefined);
check('kind: empty / missing / null', containerKindFromUsageContext([]) === undefined
  && containerKindFromUsageContext(undefined) === undefined
  && containerKindFromUsageContext(null) === undefined);

// ── Fail-open ────────────────────────────────────────────────────────────────────
check('fail-open: an unknown kind hides NOTHING', [...SERVER_ONLY_TOOLS, ...WEB_ONLY_TOOLS]
  .every((n) => toolAllowedForContainer(n, undefined)));
check('fail-open: a tool in neither list is always allowed', toolAllowedForContainer('list_gtm_tags', 'web')
  && toolAllowedForContainer('list_gtm_tags', 'server')
  && toolAllowedForContainer('audit_gtm_container', 'web'));

// ── The actual filtering ─────────────────────────────────────────────────────────
check('web: server-side CAPI builders are withheld', !toolAllowedForContainer('create_meta_capi_server_tag', 'web')
  && !toolAllowedForContainer('create_amazon_capi_server_tag', 'web'));
check('web: clients and transformations are withheld (a web container has neither)',
  !toolAllowedForContainer('create_gtm_client', 'web') && !toolAllowedForContainer('list_gtm_transformations', 'web'));
check('server: web tag/pixel builders are withheld', !toolAllowedForContainer('create_gtm_tracking_tag', 'server')
  && !toolAllowedForContainer('create_meta_pixel_tag', 'server'));
check('server: gallery import survives (the gallery holds server templates too, e.g. Stape CAPI)',
  toolAllowedForContainer('import_gallery_template', 'server'));
check('the two lists never overlap (a tool cannot be both)', [...SERVER_ONLY_TOOLS].every((n) => !WEB_ONLY_TOOLS.has(n)));

// ── The routes INTO server-side tagging must survive in a web container ─────────
// Removing these would make server-side tagging unreachable for the user who needs it most.
for (const n of ['bootstrap_server_side_tagging', 'create_server_container', 'create_server_container_from_web',
  'set_web_server_container_url', 'verify_server_endpoint']) {
  check(`web: ${n} stays available (it is how a web user reaches server-side)`, toolAllowedForContainer(n, 'web'));
}
// And the everyday primitives must survive in BOTH.
for (const n of ['list_gtm_tags', 'create_gtm_tag', 'create_gtm_trigger', 'create_gtm_variable_typed',
  'set_gtm_tag_consent', 'audit_gtm_container', 'list_gtm_workspaces']) {
  check(`both: ${n} is never scoped away`, toolAllowedForContainer(n, 'web') && toolAllowedForContainer(n, 'server'));
}

console.log(`\ntool-scope: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
