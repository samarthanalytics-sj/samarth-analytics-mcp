// Tests for progressive tool disclosure: the group map, the selection signals, the
// enable_tool_group safety net, and the token saving it actually buys.
//
// The point of this file is that the CHEAP default must not cost the model a capability.
// So it checks three things in order of importance:
//   1. the safety net works end to end (a group the model asks for really does show up on the
//      next step, and nothing ever disappears mid-turn),
//   2. every tool the REAL registry registers is classified, so a tool added later cannot
//      silently fall outside the scheme,
//   3. the saving is real and "list all tags" still carries list_gtm_tags.
//
// Run: tsx src/main/tools/__tests__/tool-groups.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOL_GROUPS,
  REQUESTABLE_GROUPS,
  GROUP_KEYWORDS,
  GROUP_SUMMARIES,
  ENABLE_TOOL_GROUP,
  buildToolGroupPrompt,
  groupOf,
  groupMembers,
  selectToolGroups,
  filterToolDefs,
  createGatedExecutor,
  oneLineSummary,
  enableToolGroupDef,
  type ToolGroup,
} from '../tool-groups';
import { buildToolRegistry } from '../registry';
import { AuditHistoryStore } from '../../storage/audit-history';
import { ManifestStore } from '../../storage/manifest-store';
import { MemoryStore } from '../../storage/memory-store';
import type { GoogleDataService } from '../../google/data-service';
import type { GoogleAdsService } from '../../google/ads-service';
import type { LlmClient, LlmToolDef, ToolExecutor } from '../../llm/types';
import { runChat } from '../../llm/gateway';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(`✗ ${name}${detail ? ' - ' + detail : ''}`);
  }
}

async function main(): Promise<void> {
  // ── The REAL registry, both products, writes ON (the widest possible surface) ────
  const dir = mkdtempSync(join(tmpdir(), 'tool-groups-'));
  const data = {} as unknown as GoogleDataService;
  const ads = {} as unknown as GoogleAdsService;
  const history = new AuditHistoryStore(join(dir, 'h.json'));
  const manifests = new ManifestStore(join(dir, 'm.json'));
  const memory = new MemoryStore(join(dir, 'mem.json'));
  const ctxControl = { current: () => undefined, set: () => {} };
  const memoryCtx = { store: memory, accountId: 'a', scope: () => ({}) } as never;

  const registryFor = (product?: 'gtm' | 'ga4', writes = true): ToolExecutor =>
    buildToolRegistry(data, writes ? async () => ({}) : undefined, product, history, ctxControl, manifests, memoryCtx, ads);

  const gtmReg = registryFor('gtm');
  const ga4Reg = registryFor('ga4');
  const gtmRead = registryFor('gtm', false);
  const everything = registryFor(undefined);

  const cost = (t: LlmToolDef): number => t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  const chars = (list: readonly LlmToolDef[]): number => list.reduce((n, t) => n + cost(t), 0);
  const tokens = (list: readonly LlmToolDef[]): number => Math.round(chars(list) / 4);
  const names = (list: readonly LlmToolDef[]): string[] => list.map((t) => t.name);

  // ── 1. THE SAFETY NET, end to end ───────────────────────────────────────────────
  // Nothing else in this design is safe unless this works: the model must be able to get back a
  // capability it cannot see, and see it on the very next step.

  check('safety net: enable_tool_group is present even on a bare minimal turn', (() => {
    const gated = createGatedExecutor(gtmReg, { messages: ['list all tags'] });
    return names(gated.list()).includes(ENABLE_TOOL_GROUP);
  })());

  check('safety net: its description names every available group and says to call it FIRST', (() => {
    const gated = createGatedExecutor(gtmReg, { messages: ['hello'] });
    const def = gated.list().find((t) => t.name === ENABLE_TOOL_GROUP);
    if (!def) return false;
    const enumerated = ((def.inputSchema as { properties?: { group?: { enum?: string[] } } }).properties?.group?.enum ?? []) as string[];
    const hasAll = ['gtm-write', 'server-side', 'pixels', 'audit-verify', 'google-ads'].every(
      (g) => enumerated.includes(g) && def.description.includes(`"${g}"`)
    );
    return hasAll && /call THIS FIRST/i.test(def.description) && /subset/i.test(def.description);
  })());

  check('safety net: the offered groups are the ones this registry really has', (() => {
    // Read-only GTM: the sGTM builders and the GA4 Admin half do not exist there, so they must not
    // be offered. Offering a group that would come back empty is a dead end for the model.
    const def = createGatedExecutor(gtmRead, { messages: ['hello'] }).list().find((t) => t.name === ENABLE_TOOL_GROUP);
    const enumerated = ((def?.inputSchema as { properties?: { group?: { enum?: string[] } } })?.properties?.group?.enum ?? []) as string[];
    return (
      enumerated.length > 0 &&
      enumerated.includes('audit-verify') &&
      !enumerated.includes('server-side') &&
      !enumerated.includes('ga4')
    );
  })());

  check('safety net: a hidden group is really hidden before the call', (() => {
    const gated = createGatedExecutor(gtmReg, { messages: ['hello'] });
    return !names(gated.list()).includes('create_gtm_tracking_tag');
  })());

  await (async () => {
    // The whole design rests on this: call the tool, then RE-LIST the way the gateway does at the
    // top of the next step, and the newly enabled definitions must be there in full.
    const gated = createGatedExecutor(gtmReg, { messages: ['hello'] });
    const before = names(gated.list());
    const raw = await gated.execute(ENABLE_TOOL_GROUP, { group: 'gtm-write' });
    const res = JSON.parse(raw) as { ok: boolean; group: string; tools: Array<{ name: string; about: string }> };
    const after = names(gated.list());
    check('safety net: enable_tool_group("gtm-write") reports ok + the group name', res.ok === true && res.group === 'gtm-write');
    check(
      'safety net: it returns the group tool names with one-line summaries',
      res.tools.length === groupMembers('gtm-write').filter((n) => names(gtmReg.list()).includes(n)).length &&
        res.tools.every((t) => t.about.length > 0 && t.about.length <= 170),
      `got ${res.tools.length} rows`
    );
    check(
      'safety net: the NEXT step carries the full definitions of the enabled group',
      !before.includes('create_gtm_tracking_tag') &&
        after.includes('create_gtm_tracking_tag') &&
        (gated.list().find((t) => t.name === 'create_gtm_tracking_tag')?.description.length ?? 0) > 200
    );
    check('safety net: enabling one group does NOT drag in the others', !after.includes('create_meta_capi_server_tag'));
    check('safety net: the group is recorded as enabled', gated.enabledGroups().includes('gtm-write'));

    // An unknown group must not silently enable nothing: it has to tell the model what IS available.
    const bad = JSON.parse(await gated.execute(ENABLE_TOOL_GROUP, { group: 'nonsense' })) as {
      ok: boolean;
      available: Array<{ group: string }>;
    };
    check('safety net: an unknown group is refused with the real menu', bad.ok === false && bad.available.length >= 4);
  })();

  await (async () => {
    // Fail-open: a tool the model remembers from earlier in the conversation still executes, and
    // its group comes along so the follow-up call sees the real schema instead of guessing.
    let executed = '';
    const base: ToolExecutor = {
      list: () => gtmReg.list(),
      execute: async (name) => {
        executed = name;
        return '{}';
      },
    };
    const gated = createGatedExecutor(base, { messages: ['hello'] });
    await gated.execute('create_gtm_folder', { name: 'x' });
    check('fail-open: a hidden tool still executes rather than erroring', executed === 'create_gtm_folder');
    check('fail-open: calling it enables its group for the rest of the turn', names(gated.list()).includes('create_gtm_folder'));
  })();

  await (async () => {
    // THE END-TO-END PROOF, through the REAL tool loop: the gateway must re-list the tools on every
    // step, or enable_tool_group can never take effect and the whole design is a trap.
    const perStep: string[][] = [];
    const client: LlmClient = {
      chatStream: async (input) => {
        perStep.push(input.tools.map((t) => t.name));
        if (perStep.length === 1) return { toolCalls: [{ id: '1', name: ENABLE_TOOL_GROUP, args: { group: 'pixels' } }] };
        return { text: 'created it' };
      },
    };
    const gated = createGatedExecutor(gtmReg, { messages: ['hello'] });
    const out = await runChat(client, { system: 's', model: 'm', apiKey: 'k', messages: [{ role: 'user', text: 'hello' }] }, gated);
    check('gateway: the loop ran two steps and finished', out.steps === 2 && out.text === 'created it');
    check('gateway: step 1 sent the minimal set WITHOUT the pixel tools', perStep[0]?.includes(ENABLE_TOOL_GROUP) === true && !perStep[0]?.includes('create_meta_pixel_tag'));
    check('gateway: step 2 sent the pixel tools the model just asked for', perStep[1]?.includes('create_meta_pixel_tag') === true);
    check('gateway: step 2 kept everything step 1 had', (perStep[0] ?? []).every((n) => perStep[1]?.includes(n)));
    check('gateway: the minimal step really is much smaller', (perStep[0]?.length ?? 0) < (perStep[1]?.length ?? 0));
  })();

  check('safety net: the system prompt sentence names the groups and forbids "I cannot"', (() => {
    const p = buildToolGroupPrompt([...REQUESTABLE_GROUPS]);
    const namesAll = REQUESTABLE_GROUPS.every((g) => p.includes(`"${g}"`));
    return namesAll && p.includes(ENABLE_TOOL_GROUP) && /NEVER tell the user a capability does not exist/i.test(p);
  })());

  check('safety net: the prompt sentence names ONLY the groups this chat really has', (() => {
    // A fixed sentence would promise a GA4 chat that it can build pixels and a read-only chat that
    // it can write. The model would then announce a change it can never make.
    const ga4Gate = createGatedExecutor(ga4Reg, { messages: ['hello'] });
    const p = buildToolGroupPrompt(ga4Gate.availableGroups());
    const offered = ga4Gate.availableGroups();
    return (
      offered.includes('ga4') &&
      !offered.includes('pixels') &&
      !offered.includes('server-side') &&
      p.includes('"ga4"') &&
      !p.includes('"pixels"') &&
      !p.includes('"gtm-write"')
    );
  })());

  check('safety net: the prompt tells the model that a named-but-invisible tool is hidden, not missing', (() => {
    // The GTM system prompt names dozens of tools by name (create_gtm_tracking_tag,
    // bootstrap_server_side_tagging, ...) that a minimal turn does not send.
    const p = buildToolGroupPrompt([...REQUESTABLE_GROUPS]);
    return /hidden, not missing/i.test(p) && /do NOT claim you made a change/i.test(p);
  })());

  check('safety net: an empty group list produces no sentence at all', buildToolGroupPrompt([]) === '');

  check('safety net: the menu states how many tools a group really has in THIS registry', (() => {
    // The read-only registry keeps ONE gtm-write-classified tool (get_form_tracking_recipe), so a
    // bare "creating and editing GTM" summary would over-promise. The count keeps it honest.
    const def = createGatedExecutor(gtmRead, { messages: ['hello'] }).list().find((t) => t.name === ENABLE_TOOL_GROUP);
    return /"gtm-write" \(1 tool: /.test(def?.description ?? '');
  })());

  await (async () => {
    // A refused enable call burns a step and invites the model to give up, so obvious near-misses
    // on the group name are accepted rather than rejected.
    const gated = createGatedExecutor(gtmReg, { messages: ['hello'] });
    for (const alias of ['GTM-WRITE', 'gtm_write', 'write', ' pixels ']) {
      const res = JSON.parse(await gated.execute(ENABLE_TOOL_GROUP, { group: alias })) as { ok: boolean };
      check(`safety net: enable_tool_group accepts the near-miss name ${JSON.stringify(alias)}`, res.ok === true);
    }
  })();

  check('safety net: no em or en dash reaches the model from this module', (() => {
    const all = [
      buildToolGroupPrompt([...REQUESTABLE_GROUPS]),
      ...Object.values(GROUP_SUMMARIES),
      enableToolGroupDef([...REQUESTABLE_GROUPS]).description,
    ].join(' ');
    // Built with fromCharCode so this file itself carries neither dash: 8212 = em, 8211 = en.
    const DASHES = new RegExp(`[${String.fromCharCode(8212)}${String.fromCharCode(8211)}]`);
    return !DASHES.test(all);
  })());

  // ── 2. COVERAGE: every registered tool is classified ─────────────────────────────

  for (const [label, reg] of [
    ['gtm (writes on)', gtmReg],
    ['gtm (read-only)', gtmRead],
    ['ga4 (writes on)', ga4Reg],
    ['unfiltered', everything],
  ] as const) {
    const unclassified = names(reg.list()).filter((n) => groupOf(n) === undefined);
    check(
      `coverage: every tool the ${label} registry registers maps to a group`,
      unclassified.length === 0,
      unclassified.join(', ')
    );
  }

  check('coverage: the registry is big enough for this test to mean anything', everything.list().length >= 150, `${everything.list().length} tools`);

  check('coverage: no tool name is claimed by two groups', (() => {
    const seen = new Set<string>();
    for (const g of TOOL_GROUPS) for (const n of groupMembers(g)) {
      if (seen.has(n)) return false;
      seen.add(n);
    }
    return true;
  })());

  check('coverage: every classified name is a tool that really exists', (() => {
    const real = new Set(names(everything.list()));
    const ghosts = TOOL_GROUPS.flatMap((g) => groupMembers(g)).filter((n) => !real.has(n));
    return ghosts.length === 0;
  })(), TOOL_GROUPS.flatMap((g) => groupMembers(g)).filter((n) => !new Set(names(everything.list())).has(n)).join(', '));

  check('coverage: every group actually has tools in the unfiltered registry', (() => {
    const real = new Set(names(everything.list()));
    return TOOL_GROUPS.every((g) => groupMembers(g).some((n) => real.has(n)));
  })());

  check('coverage: a brand new unclassified tool is SENT, not hidden', (() => {
    const sent = filterToolDefs([{ name: 'brand_new_thing', description: 'x', inputSchema: {} }], new Set<ToolGroup>(['core']));
    return sent.length === 1;
  })());

  // ── 3. SELECTION ────────────────────────────────────────────────────────────────

  check('selection: core is always selected, even with no signals at all', selectToolGroups({}).has('core'));
  check('selection: an empty message selects ONLY core', selectToolGroups({ messages: [''] }).size === 1);
  check('selection: a plain read question stays at core', (() => {
    const g = selectToolGroups({ messages: ['list all tags'] });
    return g.size === 1 && g.has('core');
  })());

  for (const group of REQUESTABLE_GROUPS) {
    const missed = GROUP_KEYWORDS[group].filter((kw) => !selectToolGroups({ messages: [`please ${kw}xyz the thing`] }).has(group));
    check(`selection: every ${group} keyword selects ${group}`, missed.length === 0, missed.join(', '));
  }

  check('selection: keywords are case-insensitive', selectToolGroups({ messages: ['AUDIT the container'] }).has('audit-verify'));
  check('selection: stems match inflections', (() => {
    const g = selectToolGroups({ messages: ['I am creating a new trigger'] });
    return g.has('gtm-write');
  })());
  check('selection: hyphens and spaces are interchangeable in a phrase', (() => {
    const a = selectToolGroups({ messages: ['set up server side tagging'] }).has('server-side');
    const b = selectToolGroups({ messages: ['conversions-api please'] }).has('server-side');
    return a && b;
  })());

  check('selection: intent carries across the WHOLE visible history, not just the last message', (() => {
    const lastOnly = selectToolGroups({ messages: ['the third one'] });
    const whole = selectToolGroups({ messages: ['list all tags', 'Here are your tags...', 'now delete the third one'] });
    return !lastOnly.has('gtm-write') && whole.has('gtm-write');
  })());

  check('selection: signals are ORed, not exclusive', (() => {
    const g = selectToolGroups({ messages: ['audit the container then create a meta pixel for the server side setup'] });
    return g.has('audit-verify') && g.has('pixels') && g.has('server-side') && g.has('gtm-write');
  })());

  check('selection: a SERVER container selects server-side with no keywords at all', (() => {
    const g = selectToolGroups({ messages: ['what is in here'], serverContainer: true });
    return g.has('server-side') && g.has('core');
  })());
  check('selection: a web container does NOT select server-side', !selectToolGroups({ messages: ['what is in here'] }).has('server-side'));

  check('selection: already-enabled groups are carried in', selectToolGroups({ messages: ['hi'], enabled: ['pixels'] }).has('pixels'));

  // REGRESSION TABLE. Every row is a phrasing a user really types whose needed tool sits OUTSIDE
  // core, and every row selected NOTHING (or the wrong group) against the first keyword lists.
  // enable_tool_group would still rescue them, at the cost of a step and of trusting the model to
  // ask, so they are pinned here: a keyword list must not quietly regress back past them.
  {
    const wants: Array<[string, Exclude<ToolGroup, 'core'>]> = [
      // gtm-write, phrased without a single classic write verb
      ['can you track form submissions on my site', 'gtm-write'],
      ['I need a purchase tag for my Shopify store', 'gtm-write'],
      ['wire up GA4 for the checkout page', 'gtm-write'],
      ['hook up conversion tracking for the quote request', 'gtm-write'],
      ['I want a tag that fires on scroll depth', 'gtm-write'],
      ['turn off the facebook pixel tag', 'gtm-write'],
      ['stop the meta pixel from firing on the thank you page', 'gtm-write'],
      ['get rid of the old Universal Analytics tags', 'gtm-write'],
      ['clean up the orphaned triggers', 'gtm-write'],
      ['the GA4 tag should use G-ABC123 instead', 'gtm-write'],
      ['send user_id with every GA4 event', 'gtm-write'],
      ['the site now pushes a lead event, please handle the tracking', 'gtm-write'],
      // audit-verify, the cheapest group, so it is deliberately loose
      ['is everything set up correctly?', 'audit-verify'],
      ['QA the container before we launch', 'audit-verify'],
      ['why is my purchase event not showing in GA4', 'audit-verify'],
      ['what needs improvement here', 'audit-verify'],
      ['how does this container look', 'audit-verify'],
      ['anything I should worry about in this container', 'audit-verify'],
      ['give me a client ready summary of this setup', 'audit-verify'],
      ['what would happen if I published right now', 'audit-verify'],
      ['are my measurement ids pointing at a real property', 'audit-verify'],
      // pixels
      ['import a template from the gallery', 'pixels'],
      // server-side
      ['the relay should forward purchases to facebook', 'server-side'],
      // google-ads
      ['what is my conversion id and label', 'google-ads'],
      // ga4 Admin
      ['mark purchase as a conversion', 'ga4'],
      ['give bob viewer access to this property', 'ga4'],
      ['we should keep data for 14 months', 'ga4'],
    ];
    const missed = wants.filter(([msg, group]) => !selectToolGroups({ messages: [msg] }).has(group));
    check(
      'selection: realistic phrasings with no obvious keyword still reach the right group',
      missed.length === 0,
      missed.map(([m, g]) => `${JSON.stringify(m)} -> ${g}`).join('; ')
    );
  }

  check('selection: the cheap default survives the wider keyword lists', (() => {
    // The whole point of the change. These must stay at core, or the saving evaporates.
    // ("which workspace am I in" is knowingly NOT here: it matches the gtm-write keyword
    // "workspace" and always did. A false positive costs tokens, a false negative costs a
    // capability, so that one is left alone.)
    const reads = ['list all tags', 'how many triggers do I have', 'show me the variables', 'what containers can I see', 'what tags are in this container', 'list my accounts'];
    const noisy = reads.filter((m) => selectToolGroups({ messages: [m] }).size !== 1);
    return noisy.length === 0;
  })(), 'read questions that pulled in a group');

  // ── 4. THE SET ONLY EVER GROWS WITHIN A TURN ────────────────────────────────────
  // Tools disappearing mid-loop, or changing between a tool call and its result, confuses the model.

  await (async () => {
    const gated = createGatedExecutor(gtmReg, { messages: ['audit the container'] });
    const snapshots: string[][] = [names(gated.list())];
    const stableWithinStep = JSON.stringify(names(gated.list())) === JSON.stringify(snapshots[0]);
    // The call itself fails against the empty fake data service; that is irrelevant here, the
    // point is that a tool call never shrinks or reshuffles the set.
    try {
      await gated.execute('audit_gtm_container', {});
    } catch {
      /* expected */
    }
    snapshots.push(names(gated.list()));
    await gated.execute(ENABLE_TOOL_GROUP, { group: 'gtm-write' });
    snapshots.push(names(gated.list()));
    await gated.execute(ENABLE_TOOL_GROUP, { group: 'pixels' });
    snapshots.push(names(gated.list()));
    // Re-enabling a group already on is a no-op, not a reshuffle.
    await gated.execute(ENABLE_TOOL_GROUP, { group: 'gtm-write' });
    snapshots.push(names(gated.list()));

    let grows = true;
    for (let i = 1; i < snapshots.length; i++) {
      const prev = new Set(snapshots[i - 1]);
      if (snapshots[i].length < snapshots[i - 1].length) grows = false;
      for (const n of prev) if (!snapshots[i].includes(n)) grows = false;
    }
    check('growth: repeated list() inside one step returns exactly the same set', stableWithinStep);
    check('growth: the sent set never shrinks and never drops a tool across a turn', grows);
    check('growth: it did actually grow', snapshots[snapshots.length - 1].length > snapshots[0].length);
    check('growth: enable_tool_group itself survives every step', snapshots.every((s) => s.includes(ENABLE_TOOL_GROUP)));
  })();

  // ── 5. THE MEASURED SAVING ──────────────────────────────────────────────────────

  const fullList = gtmReg.list();
  const FULL_TOKENS = tokens(fullList);

  const sentFor = (message: string, opts: { serverContainer?: boolean } = {}): LlmToolDef[] =>
    createGatedExecutor(gtmReg, { messages: [message], ...opts }).list();

  check('measure: the full GTM tool set is the expensive baseline it was measured to be', FULL_TOKENS > 15000, `${FULL_TOKENS} tokens`);

  {
    const sent = sentFor('list all tags');
    const t = tokens(sent);
    check('measure: "list all tags" sends dramatically fewer tokens than the full set', t < FULL_TOKENS * 0.25, `${t} vs ${FULL_TOKENS}`);
    check('measure: "list all tags" STILL includes list_gtm_tags', names(sent).includes('list_gtm_tags'));
    check('measure: "list all tags" still includes the context + memory tools', ['set_gtm_container', 'set_gtm_workspace', 'remember_memory'].every((n) => names(sent).includes(n)));
    check('measure: "list all tags" still includes the escape hatch', names(sent).includes(ENABLE_TOOL_GROUP));
  }

  {
    const sent = sentFor('create a GA4 event tag for the contact form');
    check('measure: a create request carries the create tools', names(sent).includes('create_gtm_tracking_tag') && names(sent).includes('create_gtm_trigger'));
    check('measure: a create request still costs less than the full set', tokens(sent) < FULL_TOKENS);
  }

  {
    const sent = sentFor('set up server-side tracking');
    check('measure: a server-side request carries the sGTM tools', ['bootstrap_server_side_tagging', 'create_server_tag', 'create_server_trigger'].every((n) => names(sent).includes(n)));
  }

  {
    const sent = sentFor('how many Google Ads tags are there');
    check('measure: an Ads question carries the Google Ads tools', names(sent).includes('list_google_ads_conversion_actions'));
    check('measure: an Ads question still leaves the sGTM half out', !names(sent).includes('create_meta_capi_server_tag'));
  }

  {
    // The GA4 chat must keep its everyday reporting surface in the always-sent core.
    const sent = createGatedExecutor(ga4Reg, { messages: ['how many users last month'] }).list();
    const has = (n: string): boolean => names(sent).includes(n);
    check('measure: a plain GA4 metrics question keeps run_ga4_report and the config getters', has('run_ga4_report') && has('list_ga4_key_events') && has('get_ga4_data_retention'));
    check('measure: it does NOT carry the 60 GA4 Admin write tools', !has('create_ga4_property') && !has('delete_ga4_account'));
    check('measure: a GA4 write request does carry them', names(createGatedExecutor(ga4Reg, { messages: ['create a key event called purchase'] }).list()).includes('create_ga4_key_event'));
  }

  check('measure: even the widest single-message turn is capped below the full set', (() => {
    const worst = sentFor('audit and verify then create edit and delete a meta tiktok pixel plus server side capi for google ads conversions');
    return tokens(worst) <= FULL_TOKENS + tokens([enableToolGroupDef([...REQUESTABLE_GROUPS])]);
  })());

  // ── 6. HELPERS ──────────────────────────────────────────────────────────────────

  check('helper: oneLineSummary keeps the first sentence', oneLineSummary('Does a thing. Then another thing.') === 'Does a thing.');
  check('helper: oneLineSummary truncates a long unpunctuated description', oneLineSummary('x'.repeat(400)).length <= 160);
  check('helper: every group has a non-empty summary', TOOL_GROUPS.every((g) => GROUP_SUMMARIES[g].length > 20));
  check('helper: groupOf classifies the gate tool itself as core', groupOf(ENABLE_TOOL_GROUP) === 'core');
  check('helper: the pattern fallback catches a future GA4 admin tool', groupOf('create_ga4_brand_new_link') === 'ga4');
  check('helper: the pattern fallback does NOT swallow a future GTM read', groupOf('list_gtm_something_new') === undefined);

  rmSync(dir, { recursive: true, force: true });

  // A floor, so a file that silently stops constructing the registry cannot pass as green.
  const FLOOR = 45;
  console.log(`\ntool-groups: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  if (passed < FLOOR) {
    console.error(`✗ only ${passed} checks ran, expected at least ${FLOOR}`);
    process.exit(1);
  }

}

void main();
