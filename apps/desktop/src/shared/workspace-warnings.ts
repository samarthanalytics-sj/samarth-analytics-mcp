// User-facing warnings about GTM's workspace lifecycle.
//
// The one rule worth stating up front: creating a container VERSION from a workspace permanently
// submits it. GTM then drops that workspace from the container's workspace list and mints a fresh
// replacement, usually carrying the SAME name. Anything still pointed at the old id fails with
// "Workspace is already submitted" on its next write.
//
// The app does this to itself on purpose: "Auto-verify & heal" has to version the workspace, because
// GTM's built-in "Latest" preview environment can only serve a version. There is no way to preview a
// workspace's unsaved changes without consuming the workspace, so the honest fix is to say so BEFORE
// the click, not to explain it afterwards when a later write fails.
//
// Pure and exported so the wording is unit-tested (house style forbids em dashes on every output
// surface, and this is one).

/** Fallback when the active workspace has no readable name. */
const UNNAMED_WORKSPACE = 'the current workspace';

/**
 * The confirmation shown before "Auto-verify & heal" mints its first preview.
 *
 * Says what is about to happen, what survives it, and what the user has to do afterwards. Names the
 * workspace, because GTM's replacement usually reuses the name and an unnamed warning reads as
 * generic boilerplate people click through.
 */
export function autoHealConfirmMessage(workspaceName?: string): string {
  const ws = (workspaceName ?? '').trim() || UNNAMED_WORKSPACE;
  return [
    `Auto-verify & heal has to create a container version from "${ws}" to load your draft tags in a preview.`,
    '',
    'GTM makes a workspace read-only once a version is created from it, and replaces it with a fresh workspace of its own. So:',
    `  - "${ws}" becomes read-only and will disappear from the workspace list.`,
    '  - The app switches you to the replacement GTM hands back, and your draft tags carry over.',
    '  - Nothing is published. The version is a snapshot, not a live release.',
    '',
    'This repeats on each heal round. Continue?',
  ].join('\n');
}
