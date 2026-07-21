// Which tools can actually DO anything against the container the chat is pointed at.
//
// Every tool schema is re-sent on every request, so a GTM turn shipped ~26,000 tokens of schemas
// before the system prompt, the memories, the history, or the user's message. On a 30,000 TPM
// OpenAI account a single tag build could not fit at all ("Request too large ... Limit 30000,
// Requested 30792"), and on every other account it is latency and money spent on tools the turn
// could never call.
//
// GTM containers come in kinds, and a tool built for one kind is dead weight in the other: a server
// container has clients, transformations and sgtm* tag types but no gallery pixel templates; a web
// container has gaawe/awct/cvt_ tags but no clients. So the filter is not a guess about intent, it
// is a fact about the target: a Meta CAPI SERVER tag cannot be created in a web container, and
// create_gtm_tracking_tag cannot build anything in a server one.
//
// FAIL-OPEN is the rule. When the kind is unknown (an older saved context, a lookup that failed, or
// an AMP/iOS/Android container this file deliberately does not reason about), NOTHING is filtered.
// A slightly expensive request is always better than a capable model being told a tool it needs does
// not exist.

/** The two container kinds this module filters for. Anything else stays unfiltered. */
export type ContainerKind = 'web' | 'server';

/**
 * Read the container kind off GTM's `usageContext`, or undefined when it is not one of the two
 * kinds we filter for. GTM echoes the value in either case ("server" / "SERVER"), so compare lower.
 */
export function containerKindFromUsageContext(usageContext?: readonly string[] | null): ContainerKind | undefined {
  const ctx = (usageContext ?? []).map((u) => String(u).toLowerCase());
  if (ctx.includes('server')) return 'server';
  if (ctx.includes('web')) return 'web';
  return undefined; // amp / ios / android / empty: not reasoned about, so not filtered
}

/**
 * Tools that write to or read a SERVER container's workspace. In a web container they have nothing
 * to act on: it has no clients, no transformations, and cannot hold an sgtm* tag.
 *
 * Deliberately NOT here, because they are how a web-container user REACHES server-side tagging:
 * bootstrap_server_side_tagging and create_server_container(_from_web) create the server container,
 * set_web_server_container_url writes the WEB container's transport URL, and verify_server_endpoint
 * just pings a URL.
 */
export const SERVER_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Server-side vendor CAPI builders (the single heaviest group of schemas in the registry).
  'create_meta_capi_server_tag',
  'create_tiktok_capi_server_tag',
  'create_linkedin_capi_server_tag',
  'create_pinterest_capi_server_tag',
  'create_reddit_capi_server_tag',
  'create_amazon_capi_server_tag',
  'create_stackadapt_server_tag',
  'create_meta_emq_variables',
  // Server tag/trigger primitives and the server funnel one-shot.
  'create_server_tag',
  'create_server_trigger',
  'setup_server_ecommerce_funnel',
  'add_ga4_server_parameters',
  // Clients and transformations exist ONLY in server containers.
  'create_gtm_client',
  'delete_gtm_client',
  'list_gtm_clients',
  'create_gtm_transformation',
  'list_gtm_transformations',
  // Server container configuration and audit.
  'audit_server_container',
  'set_server_container_tagging_url',
]);

/**
 * Tools that build WEB container resources: web tag types, gallery pixel templates, and the web
 * funnel/consent one-shots. A server container cannot hold any of them.
 */
export const WEB_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'create_gtm_tracking_tag',
  'create_meta_pixel_tag',
  'create_snap_pixel_tag',
  'create_pinterest_tag',
  'create_hotjar_tag',
  'import_gallery_template',
  'detect_meta_web_tags',
  'setup_ecommerce_funnel',
  'setup_consent_mode_defaults',
  'get_form_tracking_recipe',
]);

/** Can this tool do anything against a container of this kind? Unknown kind = yes (fail-open). */
export function toolAllowedForContainer(name: string, kind?: ContainerKind): boolean {
  if (!kind) return true;
  return kind === 'server' ? !WEB_ONLY_TOOLS.has(name) : !SERVER_ONLY_TOOLS.has(name);
}
