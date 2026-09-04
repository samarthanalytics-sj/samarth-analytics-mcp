/**
 * TOOL GROUPING / PROGRESSIVE DISCLOSURE.
 *
 * The chat used to send EVERY registered tool definition on EVERY step of the tool loop
 * (GTM: 93 tools, ~93,000 chars, ~23,000 tokens) on top of a ~13,000-token system prompt.
 * That is a ~36,000-token floor per step, re-sent up to 40 times in one turn. On a small
 * per-minute quota (OpenAI Tier 1 is 30,000 TPM for gpt-4o) a SINGLE step is bigger than the
 * whole bucket, so every request 429s and retrying cannot help. Even "list all tags" paid for
 * all 93 definitions.
 *
 * This module is the pure, unit-testable half of the fix: every tool name maps to exactly one
 * GROUP, a minimal CORE group is always sent, and the rest are pulled in on demand.
 *
 * LAYERING. buildToolRegistry() still returns ALL tools, unchanged: which tools EXIST does not
 * change, only which are SENT on a given step. The gating is a FILTER applied where the chat
 * request is built (chat-service), never inside the registry, so the read-only smoke assertions
 * keep covering the FULL surface instead of silently covering a filtered subset.
 *
 * FAIL-OPEN AT RUNTIME, FAIL-LOUD IN TESTS. groupOf() returns undefined for a name nobody has
 * classified, and an unclassified tool is ALWAYS sent (a new tool can never silently vanish from
 * the model's view). The test iterates the REAL registry and fails if any registered name is
 * unclassified, so the scheme cannot rot.
 */

import type { LlmToolDef, ToolExecutor } from '../llm/types';

export const TOOL_GROUPS = [
  'core',
  'gtm-write',
  'server-side',
  'pixels',
  'audit-verify',
  'ga4',
  'google-ads',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** Groups the model can ask for. `core` is always present, so it is not requestable. */
export const REQUESTABLE_GROUPS: readonly Exclude<ToolGroup, 'core'>[] = TOOL_GROUPS.filter(
  (g): g is Exclude<ToolGroup, 'core'> => g !== 'core'
);

/** One line per group, shown in the enable_tool_group description and in its result. */
export const GROUP_SUMMARIES: Record<ToolGroup, string> = {
  core: 'Reading the setup (lists and getters), switching the working container/workspace, memory, and house patterns.',
  'gtm-write':
    'Creating and editing GTM: tags, triggers, variables, built-in variables, folders, workspaces, environments, tag consent settings, plus the one-shot ecommerce funnel and Consent Mode default setups.',
  'server-side':
    'Server-side GTM (sGTM): creating server containers, clients, server triggers and server tags, transformations, tagging-server URLs, and the Conversions API server tags (Meta, TikTok, LinkedIn, Pinterest, Reddit, Amazon, StackAdapt).',
  pixels:
    'Web marketing pixels: Meta Pixel, Snap, Pinterest, Hotjar, and importing a community gallery template (TikTok, LinkedIn, Microsoft Clarity, Bing UET and the rest).',
  'audit-verify':
    'Auditing, verifying, scoring and diffing: container and server audits, tracking status, install drift, runtime synthetic tests, tag suggestions from a URL, workspace/version diffs, scorecards and shareable reports, GA4 property audits and data-quality checks.',
  ga4: 'Changing GA4 Admin configuration: key events, custom dimensions and metrics, audiences, data streams, links (Ads, BigQuery, Firebase, AdSense, DV360, SA360), access bindings, properties and data retention.',
  'google-ads':
    'Google Ads: listing accessible accounts, reading conversion actions (their Conversion ID and Label), and creating a conversion action.',
};

/** The always-present tool that lets the model pull in a group it cannot see. */
export const ENABLE_TOOL_GROUP = 'enable_tool_group';

// ---------------------------------------------------------------------------
// The map. Every currently registered tool name is listed EXPLICITLY, so the split is
// auditable in one place. PATTERN_RULES below is only a safety net for future names that
// follow an existing family shape.
// ---------------------------------------------------------------------------

const GROUP_MEMBERS: Record<ToolGroup, readonly string[]> = {
  // ---- CORE: always sent. Deliberately small: reads, context switching, memory, house patterns.
  core: [
    // Site discovery. Core rather than audit-verify (where its sibling suggest_tags_from_url lives)
    // because it is the ENTRY POINT for anything site-wide: gate it behind keywords and the model
    // cannot even begin on "what pages does this site have", which carries no audit vocabulary. It is
    // 251 tokens, the cheapest way to stop a whole class of question failing silently.
    'discover_site_urls',
    // Same reasoning as discover_site_urls: this is the ENTRY POINT for anything per-phone-number.
    // Behind a keyword gate the model cannot even begin on "track the phone numbers on this page".
    'detect_page_phone_numbers',
    'spy_gtag_config',
    // GTM reads
    'list_gtm_accounts',
    'list_gtm_containers',
    'list_gtm_workspaces',
    'list_gtm_folders',
    'list_gtm_tags',
    'list_gtm_triggers',
    'list_gtm_variables',
    'list_gtm_versions',
    'list_gtm_environments',
    'list_gtm_templates',
    'describe_template_fields',
    'profile_tag_types',
    'list_gtm_clients',
    'list_gtm_transformations',
    'list_unused_gtm_triggers',
    'list_unused_gtm_variables',
    // Context: what switches the working container / workspace.
    'set_gtm_container',
    'set_gtm_workspace',
    // Memory + the shipped pattern library. Both are read-only, product-agnostic, and the system
    // prompt tells the model to use them on ordinary turns, so hiding them would make the prompt lie.
    'remember_memory',
    'recall_memories',
    'forget_memory',
    'lookup_corpus_patterns',
    // GA4 reads and reporting. RECLASSIFIED out of the suggested `ga4` group: these are the GA4
    // chat's ordinary question-answering surface ("how many users last month"), and no keyword list
    // can reliably predict them, so gating them would strand the GA4 chat with no tools. They cost
    // nothing in a GTM chat because the registry's product filter drops them there anyway.
    'list_ga4_accounts',
    'list_ga4_properties',
    'list_ga4_data_streams',
    'list_ga4_key_events',
    'list_ga4_audiences',
    'list_ga4_custom_dimensions',
    'list_ga4_custom_metrics',
    'list_ga4_google_ads_links',
    'list_ga4_bigquery_links',
    'list_ga4_firebase_links',
    'list_ga4_measurement_protocol_secrets',
    'get_ga4_attribution_settings',
    'get_ga4_google_signals',
    'get_ga4_property_details',
    'get_ga4_data_retention',
    'get_ga4_enhanced_measurement',
    'run_ga4_report',
    'check_ga4_compatibility',
    'run_ga4_realtime_report',
    'rank_ga4_campaigns',
  ],

  // ---- GTM WRITE: create / edit / delete container resources.
  'gtm-write': [
    'create_gtm_workspace',
    'create_gtm_tag',
    'create_gtm_tag_with_trigger',
    'create_gtm_tracking_tag',
    'update_gtm_tag',
    'set_gtm_tag_paused',
    'set_gtm_tag_consent',
    'delete_gtm_tag',
    'create_gtm_trigger',
    'update_gtm_trigger',
    'delete_gtm_trigger',
    'delete_unused_gtm_triggers',
    'create_gtm_variable',
    'create_gtm_variable_typed',
    'update_gtm_variable',
    'delete_gtm_variable',
    'delete_unused_gtm_variables',
    'batch_delete_gtm_entities',
    'enable_gtm_builtin_variables',
    'create_gtm_folder',
    'rename_gtm_folder',
    'delete_gtm_folder',
    'move_gtm_entities_to_folder',
    'create_gtm_environment',
    'update_gtm_environment',
    'copy_workspace_resources',
    // GTM tag EDITS that carry "ga4" in the name (the registry's GTM_GA4_TAG_TOOLS set): these
    // rewrite GTM tags, they are not GA4 Admin calls.
    'add_ga4_event_parameters',
    'add_ga4_event_parameters_to_all_tags',
    'set_ga4_measurement_id',
    'set_ga4_measurement_id_on_all_tags',
    // One-shot builders. RECLASSIFIED here rather than into audit-verify: they WRITE the container.
    'setup_ecommerce_funnel',
    'setup_consent_mode_defaults',
    // A get_* that exists only to feed a create: it returns the listener tag + GA4 tag to build for
    // an AJAX WordPress form. Useless without the write tools, so it travels with them.
    'get_form_tracking_recipe',
  ],

  // ---- SERVER-SIDE: sGTM containers, clients, server tags/triggers, CAPI relays.
  'server-side': [
    'create_server_container',
    'create_server_container_from_web',
    'create_stape_data_pipeline',
    'bootstrap_server_side_tagging',
    'create_gtm_client',
    'update_gtm_client',
    'delete_gtm_client',
    'create_gtm_transformation',
    'update_gtm_transformation',
    'create_server_trigger',
    'create_server_tag',
    'setup_server_ecommerce_funnel',
    'set_server_container_tagging_url',
    'set_web_server_container_url',
    'add_ga4_server_parameters',
    'create_meta_capi_server_tag',
    'create_meta_emq_variables',
    'create_tiktok_capi_server_tag',
    'create_linkedin_capi_server_tag',
    'create_pinterest_capi_server_tag',
    'create_reddit_capi_server_tag',
    'create_amazon_capi_server_tag',
    'create_snapchat_capi_server_tag',
    'create_microsoft_capi_server_tag',
    'create_stackadapt_server_tag',
  ],

  // ---- PIXELS: the WEB marketing pixel builders and the gallery-template import they depend on.
  pixels: [
    'create_meta_pixel_tag',
    'create_snap_pixel_tag',
    'create_pinterest_tag',
    'create_hotjar_tag',
    'import_gallery_template',
    // Reads the web container for an existing Meta pixel: a pixel question, not an audit finding.
    'detect_meta_web_tags',
  ],

  // ---- AUDIT / VERIFY: everything that judges a setup rather than changing it.
  'audit-verify': [
    'audit_gtm_container',
    'audit_gtm_container_changes',
    'audit_server_container',
    'plan_server_migration_from_web',
    'audit_tracking_status',
    'audit_install_drift',
    'verify_tracking_setup',
    'verify_server_endpoint',
    'runtime_synthetic_test',
    'suggest_tags_from_url',
    'check_gtm_measurement_ids',
    'analytics_scorecard',
    'generate_analytics_report',
    'diff_gtm_workspace_vs_live',
    'diff_gtm_versions',
    'audit_ga4_property',
    'audit_ga4_data_quality',
    'score_ga4_property',
    'generate_ga4_report',
    'monitor_ga4_property',
  ],

  // ---- GA4: Admin CONFIGURATION CHANGES only. The GA4 reads and reports live in core.
  ga4: [
    'create_ga4_key_event',
    'update_ga4_key_event',
    'delete_ga4_key_event',
    'create_ga4_custom_dimension',
    'update_ga4_custom_dimension',
    'archive_ga4_custom_dimension',
    'create_ga4_custom_metric',
    'update_ga4_custom_metric',
    'archive_ga4_custom_metric',
    'create_ga4_data_stream',
    'update_ga4_data_stream',
    'delete_ga4_data_stream',
    'create_ga4_google_ads_link',
    'update_ga4_google_ads_link',
    'delete_ga4_google_ads_link',
    'create_ga4_firebase_link',
    'delete_ga4_firebase_link',
    'create_ga4_measurement_protocol_secret',
    'update_ga4_measurement_protocol_secret',
    'delete_ga4_measurement_protocol_secret',
    'create_ga4_audience',
    'update_ga4_audience',
    'archive_ga4_audience',
    'create_ga4_channel_group',
    'update_ga4_channel_group',
    'delete_ga4_channel_group',
    'create_ga4_calculated_metric',
    'update_ga4_calculated_metric',
    'delete_ga4_calculated_metric',
    'create_ga4_expanded_data_set',
    'update_ga4_expanded_data_set',
    'delete_ga4_expanded_data_set',
    'create_ga4_event_create_rule',
    'update_ga4_event_create_rule',
    'delete_ga4_event_create_rule',
    'create_ga4_display_video_360_advertiser_link',
    'update_ga4_display_video_360_advertiser_link',
    'delete_ga4_display_video_360_advertiser_link',
    'create_ga4_search_ads_360_link',
    'update_ga4_search_ads_360_link',
    'delete_ga4_search_ads_360_link',
    'create_ga4_adsense_link',
    'delete_ga4_adsense_link',
    'create_ga4_subproperty_event_filter',
    'update_ga4_subproperty_event_filter',
    'delete_ga4_subproperty_event_filter',
    'create_ga4_rollup_property_source_link',
    'delete_ga4_rollup_property_source_link',
    'create_ga4_property_access_binding',
    'update_ga4_property_access_binding',
    'delete_ga4_property_access_binding',
    'create_ga4_account_access_binding',
    'update_ga4_account_access_binding',
    'delete_ga4_account_access_binding',
    'create_ga4_property',
    'update_ga4_property',
    'delete_ga4_property',
    'update_ga4_data_retention',
    'update_ga4_enhanced_measurement',
    'update_ga4_data_redaction',
    'update_ga4_attribution_settings',
    'update_ga4_google_signals',
    'update_ga4_account',
    'delete_ga4_account',
  ],

  // ---- GOOGLE ADS. RECLASSIFIED: the two list_* tools would fall in core by the "list_/get_ is a
  // read" rule, but together they cost more than a sixth of the whole core budget and only matter
  // when Google Ads is in play, so the product travels as one group.
  'google-ads': [
    'list_google_ads_accounts',
    'get_google_ads_tracking_setup',
    'list_google_ads_conversion_actions',
    'create_google_ads_conversion_action',
    'create_google_ads_conversion_actions_for_tags',
    'list_google_ads_campaigns',
    'google_ads_campaign_performance',
    'get_google_ads_change_history',
    'get_google_ads_conversion_volume',
    'audit_google_ads_utm_setup',
    'audit_google_ads_conversion_health',
    'audit_google_ads_ga4_link',
    'list_google_ads_audiences',
    'get_google_ads_structure',
    'upload_google_ads_offline_conversions',
    'upload_google_ads_conversion_adjustments',
    'upload_google_ads_customer_match',
    'update_google_ads_conversion_action',
    'set_google_ads_campaign_status',
    'update_google_ads_campaign_budget',
    'add_google_ads_negative_keywords',
    'create_google_ads_user_list',
    'get_google_ads_upload_diagnostics',
    'get_google_ads_budget_pacing',
    'get_google_ads_recommendations',
    // Needs an Ads account AND a GTM container, but its subject is the conversion actions.
    'plan_phone_conversion_tracking',
  ],
};

const NAME_TO_GROUP: ReadonlyMap<string, ToolGroup> = (() => {
  const m = new Map<string, ToolGroup>();
  for (const group of TOOL_GROUPS) {
    for (const name of GROUP_MEMBERS[group]) {
      if (m.has(name)) throw new Error(`tool-groups: "${name}" is listed in two groups (${m.get(name)} and ${group})`);
      m.set(name, group);
    }
  }
  return m;
})();

/**
 * Safety net for FUTURE tool names that follow an existing family shape, so adding a
 * GA4 Admin CRUD tool does not immediately hide it. Consulted only after the explicit map.
 */
const PATTERN_RULES: ReadonlyArray<{ test: RegExp; group: ToolGroup }> = [
  { test: /^(create|update|delete|archive)_ga4_/, group: 'ga4' },
  { test: /^(list|get)_ga4_/, group: 'core' },
  { test: /_capi_server_tag$/, group: 'server-side' },
  { test: /^(create|delete|set)_server_/, group: 'server-side' },
  { test: /^(audit|verify|diff)_/, group: 'audit-verify' },
];

/** The group a tool belongs to, or undefined when nobody has classified it (then it is always sent). */
export function groupOf(name: string): ToolGroup | undefined {
  const explicit = NAME_TO_GROUP.get(name);
  if (explicit) return explicit;
  // The gate's own tool is never filtered, but classify it so callers can reason about it.
  if (name === ENABLE_TOOL_GROUP) return 'core';
  for (const rule of PATTERN_RULES) if (rule.test.test(name)) return rule.group;
  return undefined;
}

/** Every name the explicit map covers. Exported for tests and for reporting the split. */
export function groupMembers(group: ToolGroup): readonly string[] {
  return GROUP_MEMBERS[group];
}

// ---------------------------------------------------------------------------
// Selection signals.
// ---------------------------------------------------------------------------

/**
 * Write-shaped verbs. Shared by gtm-write and ga4 because BOTH groups are pure write surfaces and
 * the registry's product filter means only one of them can ever be non-empty in a given chat, so
 * sharing the list costs nothing and keeps the two honest with each other.
 */
const WRITE_VERBS = [
  'creat',
  'add',
  'make',
  'new',
  'set up',
  'setup',
  'build',
  'install',
  'implement',
  'delet',
  'remov',
  'renam',
  'updat',
  'edit',
  'chang',
  'modif',
  'paus',
  'unpaus',
  'enabl',
  'disabl',
  'fix',
  'mov',
  'duplicat',
  'clone',
  'copy',
  'publish',
  'submit',
  'version',
  'archiv',
  // Ways users ask for a change WITHOUT any of the classic verbs above. Measured against real
  // phrasings ("turn off the pixel", "clean up the orphaned triggers", "swap the measurement id"),
  // each of which selected NOTHING before these were added.
  'turn on',
  'turn off',
  'switch off',
  'stop',
  'clean',
  'get rid',
  'swap',
  'replac',
  'switch',
  'apply',
  'attach',
  'migrat',
  'promote',
  'roll out',
];

/**
 * Keyword STEMS per group, matched case-insensitively at a word boundary over the WHOLE visible
 * history plus the new message (intent carries across turns: "list all tags" then "delete the third
 * one"). Deliberately generous: a false positive costs a few hundred tokens, a false negative means
 * the model cannot do something and may claim it did.
 */
export const GROUP_KEYWORDS: Record<Exclude<ToolGroup, 'core'>, readonly string[]> = {
  'gtm-write': [
    ...WRITE_VERBS,
    'batch',
    'bulk',
    'ecommerce',
    'e-commerce',
    'funnel',
    'consent',
    'folder',
    'workspace',
    'environment',
    'recipe',
    'listener',
    'built-in variable',
    'builtin variable',
    'contact form 7',
    'gravity form',
    'wpform',
    'ninja form',
    'elementor',
    // "track X" is how users ask for a TAG far more often than "create a tag". Without it,
    // "can you track form submissions", "wire up conversion tracking" and "I need a purchase tag"
    // all selected nothing at all.
    'track',
    'wire',
    'hook up',
    'configur',
    // Creation phrasing for a trigger ("a tag that fires on scroll"). Distinct from the
    // audit-verify "why doesn't it fire" sense, and both may match: the signals are ORed.
    'fires on',
    'fire on',
    'orphan',
    'unused',
    // The edit tools whose names never appear in the request: set_ga4_measurement_id and
    // add_ga4_event_parameters.
    'measurement id',
    'parameter',
    // "send user_id with every GA4 event" is an add_ga4_event_parameters request that never says
    // "parameter". In a GTM chat "send" almost always means "make the tag send X".
    'send',
    'ship',
    // "a tag for the contact form", "a tag for my Shopify store": asking for a tag without ever
    // using a verb. Reads phrase it the other way round ("what tags are in ..."), so this is tight.
    'tag for',
    'trigger for',
    'instead',
    // A pasted GA4 measurement id or Ads conversion id is nearly always a request to put it ON a tag.
    'g-',
    'aw-',
  ],
  'server-side': [
    'server',
    'sgtm',
    'ss-gtm',
    'capi',
    'conversions api',
    'conversion api',
    'events api',
    'stape',
    'first-party',
    'first party',
    'transformation',
    'tagging server',
    'cloud run',
    'app engine',
    'emq',
    'event match',
    // These three vendors exist ONLY as server-side tags, so their names must reach this group.
    'reddit',
    'amazon',
    'stackadapt',
    'ssgtm',
    'relay',
    'forward',
    'backend',
  ],
  pixels: [
    'pixel',
    'meta',
    'facebook',
    'fbq',
    'tiktok',
    'snap',
    'pinterest',
    'linkedin',
    'hotjar',
    'clarity',
    'bing',
    'uet',
    'microsoft ads',
    'twitter',
    'gallery template',
    'community template',
    'import template',
    'advanced matching',
    'enhanced match',
    // The group is cheap (about 1,900 tokens in a GTM chat), so it is worth being loose here:
    // "import a template from the gallery" matched none of the phrases above.
    'template',
    'gallery',
    'quora',
    'retarget',
  ],
  'audit-verify': [
    'audit',
    'verif',
    'check',
    'review',
    'health',
    'broken',
    'firing',
    'fire',
    'test',
    'scan',
    'suggest',
    'score',
    'grade',
    'scorecard',
    'report',
    'diff',
    'compar',
    'changed',
    'drift',
    'regress',
    'monitor',
    'issue',
    'problem',
    'wrong',
    'debug',
    'troubleshoot',
    'not working',
    'working',
    'data quality',
    // This is the CHEAPEST large group (about 2,700 tokens in a GTM chat, 800 in a GA4 chat), and
    // "is my setup OK" is asked in a hundred ways, so the list is deliberately loose here. Each of
    // these came from a realistic phrasing that previously selected nothing.
    'qa',
    'sanity',
    'look',
    'summar',
    'overview',
    'improv',
    'recommend',
    'best practice',
    'concern',
    'worry',
    'risk',
    'hygiene',
    'missing',
    'showing',
    'no data',
    'not set',
    'why',
    'correct',
    'assess',
    'evaluat',
    'inspect',
    'validat',
    'status',
    'quality',
    'complian',
    'gdpr',
    'double',
    'measurement id',
    'happen',
  ],
  ga4: [
    ...WRITE_VERBS,
    'grant',
    'revoke',
    'access binding',
    'permission',
    'retention',
    'custom dimension',
    'custom metric',
    'calculated metric',
    'key event',
    'conversion event',
    'audience',
    'data stream',
    'channel group',
    'event create rule',
    'measurement protocol',
    'bigquery',
    'firebase',
    'adsense',
    'subproperty',
    'rollup',
    // "mark purchase as a conversion" is how a GA4 key event is nearly always requested. Bare
    // "conversion" is deliberately NOT here: in a GA4 chat it appears in ordinary reporting
    // questions ("how many conversions last month") and this group costs about 6,800 tokens.
    'mark',
    'as a conversion',
    'as conversion',
    'count as',
    'access',
    'exclude',
    'internal traffic',
    'report on',
    'keep data',
    'months of data',
  ],
  'google-ads': ['ads', 'adword', 'google ads', 'conversion', 'campaign', 'customer id', 'mcc', 'gclid', 'aw-', 'remarketing', 'phone number', 'call tracking', 'tel:'],
};

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A stem matches at a word boundary and tolerates a hyphen or extra space inside a phrase. */
const compile = (kw: string): RegExp => new RegExp(`\\b${escapeRe(kw).replace(/\\?\s+/g, '[\\s-]+')}`, 'i');

const COMPILED_KEYWORDS: ReadonlyArray<{ group: ToolGroup; patterns: RegExp[] }> = REQUESTABLE_GROUPS.map((group) => ({
  group,
  patterns: GROUP_KEYWORDS[group].map(compile),
}));

export interface GroupSelectionInput {
  /** Every visible message this turn: the history plus the new one. */
  messages?: readonly string[];
  /** True when the ACTIVE GTM container is a SERVER container (usageContext includes "server"). */
  serverContainer?: boolean;
  /** Groups already turned on, e.g. by an earlier enable_tool_group call in this turn. */
  enabled?: Iterable<ToolGroup>;
}

/** The groups to send for a turn. Signals are ORed, and `core` is always in the result. */
export function selectToolGroups(input: GroupSelectionInput): Set<ToolGroup> {
  const selected = new Set<ToolGroup>(['core']);
  for (const g of input.enabled ?? []) selected.add(g);
  // Container type is a real signal, not a keyword: server work in a server container needs the
  // server tools even when the user never types the word "server".
  if (input.serverContainer) selected.add('server-side');
  const text = (input.messages ?? []).filter((m) => typeof m === 'string' && m.trim()).join('\n');
  if (text) {
    for (const { group, patterns } of COMPILED_KEYWORDS) {
      if (patterns.some((p) => p.test(text))) selected.add(group);
    }
  }
  return selected;
}

/** Filter tool definitions to the selected groups. An UNCLASSIFIED tool is always kept. */
export function filterToolDefs(all: readonly LlmToolDef[], selected: ReadonlySet<ToolGroup>): LlmToolDef[] {
  return all.filter((t) => {
    const g = groupOf(t.name);
    return g === undefined || selected.has(g);
  });
}

// ---------------------------------------------------------------------------
// The safety net: enable_tool_group.
// ---------------------------------------------------------------------------

/** Short label per group, used in the gate description and in the system-prompt sentence. */
const PROMPT_LABEL: Record<Exclude<ToolGroup, 'core'>, string> = {
  'gtm-write': 'creating and editing GTM resources',
  'server-side': 'server-side / sGTM / Conversions API',
  pixels: 'marketing pixels and gallery templates',
  'audit-verify': 'audits, verification, diffs and reports',
  ga4: 'GA4 Admin configuration changes',
  'google-ads': 'Google Ads accounts, campaigns and conversion actions',
};

/** First sentence of a tool description, so the group listing stays one line per tool. */
export function oneLineSummary(description: string, max = 160): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const dot = flat.search(/\.(\s|$)/);
  const first = dot > 0 ? flat.slice(0, dot + 1) : flat;
  return first.length > max ? `${first.slice(0, max - 3).trimEnd()}...` : first;
}

/**
 * The always-present tool definition, built once per turn so its text never changes mid-loop.
 * `counts` is how many tools the group really has IN THIS registry. It is stated in the menu
 * because the read-only registry can leave a group with a single read tool in it (gtm-write keeps
 * get_form_tracking_recipe, pixels keeps detect_meta_web_tags), and a static summary promising
 * "creating and editing GTM" for a one-tool group is exactly the false-capability claim this
 * whole design has to avoid.
 */
export function enableToolGroupDef(
  available: readonly Exclude<ToolGroup, 'core'>[],
  counts?: ReadonlyMap<ToolGroup, number>
): LlmToolDef {
  const menu = available
    .map((g) => {
      const n = counts?.get(g);
      return `"${g}" (${n === undefined ? '' : `${n} tool${n === 1 ? '' : 's'}: `}${GROUP_SUMMARIES[g]})`;
    })
    .join(' ');
  return {
    name: ENABLE_TOOL_GROUP,
    description:
      'Reveal a hidden group of tools. IMPORTANT: you are only shown a SUBSET of your tools right now (reading the ' +
      'setup, switching container/workspace, memory). Many more exist but are hidden to keep each request small. ' +
      'If the user asks for something you have no tool for (' +
      // Derived, not hardcoded: naming Google Ads in a GA4 chat that has no Ads tools invites the
      // model to promise something it cannot do and then be refused by the enum.
      available.map((g) => PROMPT_LABEL[g]).join(', ') +
      '), call THIS FIRST with the matching group instead of saying you cannot do it or that it must be done in the ' +
      'UI. It returns the tool names in that group and they become callable on your next step. Groups: ' +
      menu,
    inputSchema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          // An empty enum is not valid JSON Schema and some providers reject the whole tool, so a
          // registry with nothing to reveal (in practice: none) falls back to a plain string.
          ...(available.length ? { enum: [...available] } : {}),
          description: 'The group to reveal.',
        },
      },
      required: ['group'],
      additionalProperties: false,
    },
  };
}

export interface GatedExecutor extends ToolExecutor {
  /** The groups currently sent, for tests and logging. Only ever grows within a turn. */
  enabledGroups(): ToolGroup[];
  /** The groups this registry can actually reveal. Feed it to buildToolGroupPrompt so the system
   *  prompt never advertises a group the chat does not have (a GA4 chat has no "pixels"). */
  availableGroups(): Exclude<ToolGroup, 'core'>[];
}

export interface ToolGateOptions extends GroupSelectionInput {
  /** Fired when a group is turned on mid-turn (by the model, or by a fail-open call). */
  onEnable?: (group: ToolGroup, reason: 'requested' | 'called') => void;
}

/**
 * Wrap a full ToolExecutor so `list()` returns only the enabled groups plus enable_tool_group,
 * while `execute()` still reaches EVERY registered tool. Two deliberate properties:
 *
 *  - The enabled set only ever GROWS within a turn, so a tool the model has already seen (or
 *    already called) never disappears from under it.
 *  - Executing a hidden tool is allowed and quietly enables its group (fail-open). The model
 *    may remember a name from earlier in the conversation, and answering the call is strictly
 *    better than an "unknown tool" error. Every write guardrail still lives in the registry.
 */
export function createGatedExecutor(base: ToolExecutor, options: ToolGateOptions = {}): GatedExecutor {
  const all = base.list();
  // Only offer groups that actually have a tool in THIS registry (product filter, write gating).
  const counts = new Map<ToolGroup, number>();
  for (const t of all) {
    const g = groupOf(t.name);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const present = new Set<ToolGroup>(counts.keys());
  const available = REQUESTABLE_GROUPS.filter((g) => present.has(g));
  const gateDef = enableToolGroupDef(available, counts);

  // A group with no tools in THIS registry (the product filter drops the other product's half) is
  // dropped from the selection: it would cost nothing either way, but keeping it would make the
  // logged/reported group list claim capabilities this chat does not have.
  const enabled = new Set<ToolGroup>([...selectToolGroups(options)].filter((g) => g === 'core' || present.has(g)));
  const enable = (group: ToolGroup, reason: 'requested' | 'called'): void => {
    if (enabled.has(group)) return;
    enabled.add(group);
    options.onEnable?.(group, reason);
  };

  return {
    enabledGroups: () => [...enabled],
    availableGroups: () => [...available],
    // enable_tool_group is a control tool, never a write; everything else defers to the base registry.
    isWrite: (name: string): boolean => name !== ENABLE_TOOL_GROUP && Boolean(base.isWrite?.(name)),
    list: (): LlmToolDef[] => [...filterToolDefs(all, enabled), gateDef],
    execute: async (name, args): Promise<string> => {
      if (name === ENABLE_TOOL_GROUP) {
        const raw = String((args as { group?: unknown })?.group ?? '').trim();
        // A refused call costs a whole step and risks the model concluding the capability is gone,
        // so near-misses on the group NAME are accepted: case, underscores for hyphens, spaces,
        // and the obvious synonyms a model reaches for.
        const norm = raw.toLowerCase().replace(/[\s_]+/g, '-');
        const ALIASES: Record<string, Exclude<ToolGroup, 'core'>> = {
          write: 'gtm-write',
          gtm: 'gtm-write',
          'gtm-writes': 'gtm-write',
          server: 'server-side',
          sgtm: 'server-side',
          serverside: 'server-side',
          capi: 'server-side',
          pixel: 'pixels',
          audit: 'audit-verify',
          verify: 'audit-verify',
          'audit-and-verify': 'audit-verify',
          ga4admin: 'ga4',
          'ga4-admin': 'ga4',
          ads: 'google-ads',
          'google-ads-conversions': 'google-ads',
        };
        const guess = ALIASES[norm];
        const group = available.find((g) => g === norm) ?? (guess && available.includes(guess) ? guess : undefined);
        if (!group) {
          return JSON.stringify({
            ok: false,
            error: `Unknown tool group "${raw}".`,
            available: available.map((g) => ({ group: g, about: GROUP_SUMMARIES[g] })),
          });
        }
        enable(group, 'requested');
        const tools = all
          .filter((t) => groupOf(t.name) === group)
          .map((t) => ({ name: t.name, about: oneLineSummary(t.description) }));
        return JSON.stringify({
          ok: true,
          group,
          about: GROUP_SUMMARIES[group],
          enabled: true,
          tools,
          note: 'These tools are now available with their full schemas. Call the one you need on your next step; do not guess arguments from the summary.',
        });
      }
      // Fail open: a tool outside the sent set is still executable, and its group comes along for
      // the rest of the turn so any follow-up call sees the real schema.
      const g = groupOf(name);
      if (g) enable(g, 'called');
      return base.execute(name, args);
    },
  };
}

/**
 * The sentence the system prompt must carry. Without it the model concludes a capability does not
 * exist instead of asking for it, which is the single biggest risk in this design.
 *
 * It takes the groups this chat can ACTUALLY reveal (GatedExecutor.availableGroups()). A fixed
 * string would promise a GA4 chat that it can build pixels and a read-only chat that it can write,
 * which is the same false-capability claim in the opposite direction: the model would announce a
 * change it can never make.
 */
export function buildToolGroupPrompt(available: readonly Exclude<ToolGroup, 'core'>[]): string {
  if (!available.length) return '';
  const menu = available.map((g) => `${PROMPT_LABEL[g]} (group "${g}")`).join(', ');
  return (
    'YOUR TOOL LIST IS A SUBSET. To keep each request small you are shown only some of your tools (reading the setup, ' +
    'switching container/workspace, memory). You HAVE more, hidden behind enable_tool_group: ' +
    menu +
    '. If the user asks for something you have no tool for, call enable_tool_group with the matching group FIRST, ' +
    'then use the tools it returns on your next step. NEVER tell the user a capability does not exist, and never say ' +
    'a change must be made by hand in the GTM or GA4 UI, just because the tool is not in the list you can currently ' +
    'see. Equally, do NOT claim you made a change you have not actually called a tool for. ' +
    'Wherever these instructions name a tool you cannot see, that tool is hidden, not missing: reveal its group first. '
  );
}
