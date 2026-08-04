/**
 * GTM's reserved built-in trigger ids.
 *
 * These live in the 2147479xxx range, are never user-deletable, and - the part that matters here -
 * `triggers.list` does NOT return them. So a tag whose `firingTriggerId` is `["2147479553"]` (the
 * overwhelmingly common case: every GA4 config tag fires on All Pages) references an id that appears
 * in no listed trigger, and any "does this trigger exist?" check that only consults the list will
 * call it a broken reference.
 *
 * PURE. Mirrors `isBuiltinTriggerId` in apps/desktop/src/main/google/gtm-builders.ts, which learned
 * this first; the MCP server cannot import from the desktop app, hence the second copy.
 */

/** The web container's built-in All Pages (pageview) trigger. */
export const BUILTIN_ALL_PAGES_TRIGGER_ID = '2147479553';

/** Built-in Consent Initialization - All Pages. */
export const BUILTIN_CONSENT_INIT_TRIGGER_ID = '2147479572';

/** Built-in Initialization - All Pages. */
export const BUILTIN_INIT_TRIGGER_ID = '2147479573';

/** Display names for the built-ins we can name, so a finding can say what a bare id means. */
const BUILTIN_TRIGGER_NAMES: Record<string, string> = {
  [BUILTIN_ALL_PAGES_TRIGGER_ID]: 'All Pages',
  [BUILTIN_CONSENT_INIT_TRIGGER_ID]: 'Consent Initialization - All Pages',
  [BUILTIN_INIT_TRIGGER_ID]: 'Initialization - All Pages',
};

/**
 * Is this a reserved GTM built-in trigger id? Matched by range rather than by an exact list: GTM has
 * more built-ins than the three named above (DOM Ready, Window Loaded, ...) and only ever mints them
 * in this band, so a range test stays correct as the set grows.
 */
export function isBuiltinTriggerId(id: string): boolean {
  return /^2147479\d{3}$/.test(id);
}

/** Human-readable name for a built-in id, or undefined when it is not a built-in we can name. */
export function builtinTriggerName(id: string): string | undefined {
  return BUILTIN_TRIGGER_NAMES[id];
}
