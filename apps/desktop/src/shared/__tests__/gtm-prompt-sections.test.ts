// Tests for container-kind scoping of the GTM system prompt. Cutting prompt text is only safe if the
// model keeps every ROUTE to the work it can still do, so most of these assert what SURVIVES.
// Run: tsx src/shared/__tests__/gtm-prompt-sections.test.ts
import {
  gtmPromptSections, SERVER_SIDE_POINTER,
  CAPABILITIES_SECTION, SGTM_SECTION, META_PIXEL_WEB_SECTION, ECOMMERCE_ONESHOT_SECTION,
  PIXEL_IDENTITY_SECTION, COMMUNITY_TEMPLATE_SECTION, PIXEL_CONSENT_SECTION,
  META_CAPI_SECTION, TIKTOK_CAPI_SECTION, ENVIRONMENTS_SECTION,
} from '../gtm-prompt-sections';
import { SERVER_ONLY_TOOLS, WEB_ONLY_TOOLS } from '../tool-scope';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const unscoped = gtmPromptSections(undefined);
const web = gtmPromptSections('web');
const server = gtmPromptSections('server');

// ── Fail-open: an unknown kind is exactly the old behaviour ─────────────────────
check('fail-open: unscoped contains every section', [
  CAPABILITIES_SECTION, SGTM_SECTION, META_PIXEL_WEB_SECTION, ECOMMERCE_ONESHOT_SECTION,
  PIXEL_IDENTITY_SECTION, COMMUNITY_TEMPLATE_SECTION, PIXEL_CONSENT_SECTION,
  META_CAPI_SECTION, TIKTOK_CAPI_SECTION, ENVIRONMENTS_SECTION,
].every((s) => unscoped.includes(s)));
check('fail-open: unscoped is the sections concatenated in order, nothing else', unscoped ===
  CAPABILITIES_SECTION + SGTM_SECTION + META_PIXEL_WEB_SECTION + ECOMMERCE_ONESHOT_SECTION +
  PIXEL_IDENTITY_SECTION + COMMUNITY_TEMPLATE_SECTION + PIXEL_CONSENT_SECTION +
  META_CAPI_SECTION + TIKTOK_CAPI_SECTION + ENVIRONMENTS_SECTION);
check('fail-open: unscoped carries no pointer (it has the real thing)', !unscoped.includes(SERVER_SIDE_POINTER));

// ── Always-sent sections survive every kind ─────────────────────────────────────
for (const [label, s] of [['capabilities', CAPABILITIES_SECTION], ['ecommerce one-shot', ECOMMERCE_ONESHOT_SECTION], ['environments', ENVIRONMENTS_SECTION]] as const) {
  check(`always: ${label} is in web, server and unscoped`, web.includes(s) && server.includes(s) && unscoped.includes(s));
}

// ── Web turn ────────────────────────────────────────────────────────────────────
check('web: the server-side build reference is dropped', !web.includes(SGTM_SECTION));
check('web: Meta CAPI and TikTok CAPI server references are dropped', !web.includes(META_CAPI_SECTION) && !web.includes(TIKTOK_CAPI_SECTION));
check('web: it is REPLACED by the pointer, not simply deleted', web.includes(SERVER_SIDE_POINTER));
check('web: keeps the web pixel guidance', web.includes(PIXEL_IDENTITY_SECTION) && web.includes(COMMUNITY_TEMPLATE_SECTION) && web.includes(PIXEL_CONSENT_SECTION));
// The regression this split exists to prevent: Meta Pixel WEB instructions were buried at the end of
// the sGTM block, so gating that block whole silently removed them from every web turn.
check('web: KEEPS the Meta Pixel web instructions that were buried in the sGTM block', web.includes(META_PIXEL_WEB_SECTION)
  && /create_meta_pixel_tag/.test(web) && /standardEventName/.test(web));

// ── Server turn ─────────────────────────────────────────────────────────────────
check('server: keeps the full server-side reference', server.includes(SGTM_SECTION));
check('server: keeps both CAPI references', server.includes(META_CAPI_SECTION) && server.includes(TIKTOK_CAPI_SECTION));
check('server: drops the web pixel guidance a server container cannot use', !server.includes(PIXEL_IDENTITY_SECTION)
  && !server.includes(COMMUNITY_TEMPLATE_SECTION) && !server.includes(PIXEL_CONSENT_SECTION) && !server.includes(META_PIXEL_WEB_SECTION));
check('server: no pointer (it already has the real reference)', !server.includes(SERVER_SIDE_POINTER));

// ── The pointer must keep server-side tagging REACHABLE from a web container ────
const ROUTES = ['bootstrap_server_side_tagging', 'create_server_container_from_web',
  'set_server_container_tagging_url', 'set_web_server_container_url', 'verify_server_endpoint', 'set_gtm_container'];
for (const tool of ROUTES) {
  check(`pointer: names ${tool}`, SERVER_SIDE_POINTER.includes(tool));
}
// Cross-module invariant: the pointer must never advertise a tool the web turn withholds, or the
// model is told to call something it cannot see.
for (const tool of ROUTES) {
  check(`pointer: ${tool} is actually SENT in a web turn`, !SERVER_ONLY_TOOLS.has(tool),
    'listed in SERVER_ONLY_TOOLS but advertised to web');
}
check('pointer: tells the model to switch containers for the rest', /switch the active container/i.test(SERVER_SIDE_POINTER));
check('pointer: forbids claiming server-side is out of scope here', /never tell the user it is out of scope/i.test(SERVER_SIDE_POINTER));
check('pointer: is a fraction of the reference it replaces', SERVER_SIDE_POINTER.length < SGTM_SECTION.length / 2,
  `${SERVER_SIDE_POINTER.length} vs ${SGTM_SECTION.length}`);

// ── The saving is the whole point ───────────────────────────────────────────────
check('web scoping actually shrinks the prompt', web.length < unscoped.length - 5000, `${unscoped.length - web.length} chars saved`);
check('server scoping actually shrinks the prompt', server.length < unscoped.length - 4000, `${unscoped.length - server.length} chars saved`);

// ── The two scopes must tell the same story ────────────────────────────────────
// A KIND-SPECIFIC section must not advertise the other kind's tools: that prose only ships when its
// kind is active, so naming a tool that kind never receives is a dead instruction.
//
// The ALWAYS-sent sections (capabilities, the ecommerce one-shot) are exempt by design: they span
// both worlds and name tools from both. That is safe because withholding a tool never disables it,
// so a model that follows one of those instructions still gets real behaviour (asserted in
// registry.test.ts).
const SERVER_TOPIC = SGTM_SECTION + META_CAPI_SECTION + TIKTOK_CAPI_SECTION;
const WEB_TOPIC = META_PIXEL_WEB_SECTION + PIXEL_IDENTITY_SECTION + COMMUNITY_TEMPLATE_SECTION + PIXEL_CONSENT_SECTION;
check('server-topic prose advertises no tool a server turn withholds',
  [...WEB_ONLY_TOOLS].filter((t) => SERVER_TOPIC.includes(t)).length === 0,
  [...WEB_ONLY_TOOLS].filter((t) => SERVER_TOPIC.includes(t)).join(', '));
// One documented exception, listed rather than ignored: the web identity section ends with a
// contrastive pointer ("for Meta CAPI use create_meta_capi_server_tag ..."). It describes the
// SERVER counterpart of the web tool rather than instructing a web turn to call it, and creating a
// CAPI server tag genuinely needs a server container. Anything NEW appearing here is a real defect.
const CONTRASTIVE_MENTIONS = new Set(['create_meta_capi_server_tag']);
check('web-topic prose advertises no tool a web turn withholds',
  [...SERVER_ONLY_TOOLS].filter((t) => WEB_TOPIC.includes(t) && !CONTRASTIVE_MENTIONS.has(t)).length === 0,
  [...SERVER_ONLY_TOOLS].filter((t) => WEB_TOPIC.includes(t) && !CONTRASTIVE_MENTIONS.has(t)).join(', '));

console.log(`\ngtm-prompt-sections: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
