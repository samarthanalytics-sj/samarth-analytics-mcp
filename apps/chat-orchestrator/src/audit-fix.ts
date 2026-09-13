/**
 * Turning an audit finding into the write that fixes it.
 *
 * PURE. No MCP connection, no config, so the whole mapping is testable without spawning anything.
 *
 * The important half of this module is what it REFUSES. Four of the eight categories the audit
 * emits have no safe automatic fix, and offering a button for them would be worse than offering
 * nothing: a duplicate name needs a name only the user can choose, a tag with no firing trigger
 * needs a trigger only the user can pick, and a broken reference or an over-broad trigger needs a
 * judgement about what the container is supposed to do. Guessing at any of those produces a
 * confident, wrong change in somebody's container.
 *
 * So `planFix` returns a refusal with a reason, and the UI shows that reason instead of a button.
 */

export interface AuditFinding {
  severity: 'error' | 'warning' | 'info';
  category: string;
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
}

export interface WorkspaceRef {
  accountId: string;
  containerId: string;
  workspaceId: string;
}

export type FixPlan =
  | {
      fixable: true;
      tool: string;
      args: Record<string, unknown>;
      /** What the button says, and what gets written to the audit trail. */
      label: string;
      /**
       * A removal. Applies the same rule as the chat: nothing in this toolset reverts one, so it
       * takes a typed confirmation rather than a click.
       */
      destructive: boolean;
      confirmWord?: string;
    }
  | { fixable: false; reason: string };

/**
 * The variable type lives only in the message prose.
 *
 * The finding records entityId as the CONTAINER and entityName as "Container", so the one field
 * that identifies what to enable is the quoted name inside the sentence. Recovering it from text is
 * not something to be relaxed about: an unanchored match could pull a word out of a reworded
 * message and enable the wrong built-in variable. The pattern is therefore exact, and anything it
 * does not match is refused rather than guessed.
 */
export function builtInVariableType(message: string): string | null {
  const m = /^Built-in variable "([A-Za-z][A-Za-z0-9]*)" is not enabled\b/.exec(message);
  return m ? m[1] : null;
}

export function planFix(finding: AuditFinding, ws: WorkspaceRef): FixPlan {
  const base = {
    accountId: ws.accountId,
    containerId: ws.containerId,
    workspaceId: ws.workspaceId,
  };

  switch (finding.category) {
    case 'paused_tag':
      if (!finding.entityId) return { fixable: false, reason: 'This finding carries no tag id.' };
      return {
        fixable: true,
        tool: 'tags_update',
        // Only `paused` is sent. tags_update is read-modify-write and merges by key, so everything
        // else on the tag is preserved rather than blanked by an update that omits it.
        args: { ...base, tagId: finding.entityId, paused: false },
        label: `Unpause "${finding.entityName}"`,
        destructive: false,
      };

    case 'missing_builtin_variable': {
      const type = builtInVariableType(finding.message);
      if (!type) {
        return {
          fixable: false,
          reason: 'Could not tell which built-in variable this refers to from the finding text.',
        };
      }
      return {
        fixable: true,
        tool: 'built_in_variables_enable',
        args: { ...base, types: [type] },
        label: `Enable built-in variable "${type}"`,
        destructive: false,
      };
    }

    case 'empty_folder':
      if (!finding.entityId) return { fixable: false, reason: 'This finding carries no folder id.' };
      return {
        fixable: true,
        tool: 'folders_delete',
        args: { ...base, folderId: finding.entityId },
        label: `Delete empty folder "${finding.entityName}"`,
        destructive: true,
        confirmWord: 'DELETE',
      };

    case 'unused_trigger':
      if (!finding.entityId) return { fixable: false, reason: 'This finding carries no trigger id.' };
      return {
        fixable: true,
        tool: 'triggers_delete',
        args: { ...base, triggerId: finding.entityId },
        label: `Delete unused trigger "${finding.entityName}"`,
        destructive: true,
        confirmWord: 'DELETE',
      };

    // ── Deliberately not fixable ────────────────────────────────────────────
    case 'duplicate_name':
      return {
        fixable: false,
        reason:
          'Renaming needs a name only you can choose, and picking one automatically would make the ' +
          'container harder to read rather than easier.',
      };

    case 'missing_trigger':
      return {
        fixable: false,
        reason:
          'A tag with no firing trigger needs a trigger chosen for it. Attaching one automatically ' +
          'would decide when this tag fires on your site.',
      };

    case 'broken_reference':
      return {
        fixable: false,
        reason:
          'The reference points at something that does not exist. Whether to recreate the missing ' +
          'entity or remove the reference depends on what the container is meant to do.',
      };

    case 'broad_trigger':
      return {
        fixable: false,
        reason:
          'Whether firing on all pages is wrong depends on what the tag is for. Narrowing it ' +
          'automatically would stop it firing where it may be needed.',
      };

    default:
      return { fixable: false, reason: `No automatic fix is defined for "${finding.category}".` };
  }
}

/** Categories with an automatic fix, for the UI to advertise before anything is run. */
export const FIXABLE_CATEGORIES = [
  'paused_tag',
  'missing_builtin_variable',
  'empty_folder',
  'unused_trigger',
] as const;
