/**
 * Turning GTM's two most misleading write errors into answers.
 *
 * Google reports both of the failures below in terms that name neither the
 * cause nor the fix, and the model reading them cannot recover in one step:
 *
 *   404 "Not found or permission denied."  on a delete
 *   400 "Found entity with duplicate name." on a variable create
 *
 * The first is the worse of the two, because "or permission denied" sends the
 * reader to OAuth scopes and container access when the real cause is usually an
 * id that belongs to a different entity type. GTM numbers tags, triggers and
 * variables in separate spaces, so trigger 3 and tag 3 are unrelated, and a
 * caller holding a list of triggers can delete "3" believing it is a tag. That
 * is not hypothetical: on 2026-08-11 one session listed a workspace, saw no
 * tags, trigger 3 and variable 4, then deleted tagId 3, triggerId 4 and
 * variableId 5 in fourteen seconds. All three 404'd, each after seconds of
 * retries, and the transcript reads like a permissions outage.
 *
 * The second is invisible for a specific reason: enabled built-in variables own
 * their names, but `variables_list` returns only user-defined variables, so a
 * caller that checks for a clash before creating finds nothing and creates
 * "Page URL" anyway. In the same session, `built_in_variables_enable` ran five
 * seconds before the create that collided with it, and the `variables_list`
 * that followed came back empty.
 *
 * Both helpers run ONLY after the API has already refused the write. The
 * success path is untouched and costs nothing extra: no pre-flight list, no
 * added latency on the calls that work. Diagnosis is paid for by the request
 * that already failed.
 */

import type { GtmClient } from './gtmClient.js';
import { paginate } from './pagination.js';
import { formatGoogleError } from './guardrails.js';

export interface WorkspaceScope {
  accountId: string;
  containerId: string;
  workspaceId: string;
}

/** The entity kinds that have their own id space, and therefore this failure mode. */
export type EntityKind = 'tag' | 'trigger' | 'variable';

const KIND_PLURAL: Record<EntityKind, string> = {
  tag: 'tags',
  trigger: 'triggers',
  variable: 'variables',
};

/** How many existing entities to name before summarising the rest. */
const SAMPLE_LIMIT = 8;

interface Entity {
  id: string;
  name: string;
}

const parentOf = (s: WorkspaceScope) =>
  `accounts/${s.accountId}/containers/${s.containerId}/workspaces/${s.workspaceId}`;

/**
 * HTTP status carried by a googleapis error, when it has one.
 *
 * Checked before diagnosing so a network fault or an expired token is not
 * described as a missing entity. Both `code` and `response.status` are read
 * because gaxios populates them inconsistently across error paths.
 */
export function googleErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const anyErr = err as Record<string, unknown>;

  const code = anyErr['code'];
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);

  const response = anyErr['response'] as Record<string, unknown> | undefined;
  const status = response?.['status'];
  if (typeof status === 'number') return status;

  const data = response?.['data'] as Record<string, unknown> | undefined;
  const gErr = data?.['error'] as Record<string, unknown> | undefined;
  const gCode = gErr?.['code'];
  if (typeof gCode === 'number') return gCode;

  return undefined;
}

/** True when Google refused a write because something already owns the name. */
export function isDuplicateNameError(err: unknown): boolean {
  return /duplicate name/i.test(formatGoogleError(err));
}

async function listEntities(client: GtmClient, scope: WorkspaceScope, kind: EntityKind): Promise<Entity[]> {
  const parent = parentOf(scope);
  const ws = client.accounts.containers.workspaces;

  const result = await paginate<Record<string, unknown>, Record<string, unknown>>(
    (pageToken) => {
      const args = { parent, pageToken };
      if (kind === 'tag') return ws.tags.list(args).then((r) => r.data as Record<string, unknown>);
      if (kind === 'trigger') return ws.triggers.list(args).then((r) => r.data as Record<string, unknown>);
      return ws.variables.list(args).then((r) => r.data as Record<string, unknown>);
    },
    (data) => (data[kind] as Record<string, unknown>[] | undefined),
  );

  return result.items.map((item) => ({
    id: String(item[`${kind}Id`] ?? ''),
    name: String(item['name'] ?? '(unnamed)'),
  }));
}

/** Enabled built-in variables, which own their names but never appear in variables_list. */
async function listBuiltInVariables(client: GtmClient, scope: WorkspaceScope): Promise<Entity[]> {
  const result = await paginate<Record<string, unknown>, Record<string, unknown>>(
    (pageToken) =>
      client.accounts.containers.workspaces.built_in_variables
        .list({ parent: parentOf(scope), pageToken })
        .then((r) => r.data as Record<string, unknown>),
    (data) => (data['builtInVariable'] as Record<string, unknown>[] | undefined),
  );

  return result.items.map((item) => ({
    id: String(item['type'] ?? ''),
    name: String(item['name'] ?? '(unnamed)'),
  }));
}

const sample = (entities: Entity[]): string => {
  const shown = entities.slice(0, SAMPLE_LIMIT).map((e) => `${e.id} (${e.name})`).join(', ');
  const rest = entities.length - SAMPLE_LIMIT;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
};

/**
 * Explain a 404 from a delete, by finding out what the id actually refers to.
 *
 * The cross-type check is the point. Reporting "no tag 3 exists" would be true
 * and would still leave the caller guessing; naming trigger 3 as the thing that
 * does exist turns a repeated failure into a single correction.
 *
 * Falls back to the original error whenever the lookup itself fails, so a
 * genuine permission problem still reads as one rather than being buried under
 * a diagnosis that could not be completed.
 */
export async function explainMissingEntity(
  client: GtmClient,
  scope: WorkspaceScope,
  kind: EntityKind,
  id: string,
  originalError: unknown,
): Promise<string> {
  let own: Entity[];
  let others: { kind: EntityKind; entities: Entity[] }[];
  try {
    const kinds: EntityKind[] = ['tag', 'trigger', 'variable'];
    const all = await Promise.all(kinds.map((k) => listEntities(client, scope, k)));
    const byKind = new Map(kinds.map((k, i) => [k, all[i]]));
    own = byKind.get(kind) ?? [];
    others = kinds.filter((k) => k !== kind).map((k) => ({ kind: k, entities: byKind.get(k) ?? [] }));
  } catch {
    return `${KIND_PLURAL[kind].slice(0, -1)}s_delete failed: ${formatGoogleError(originalError)}`;
  }

  // The id resolves under a different entity type — the actual cause, nearly always.
  const elsewhere = others
    .map(({ kind: k, entities }) => ({ kind: k, hit: entities.find((e) => e.id === id) }))
    .filter((x) => x.hit);

  const lines = [`There is no ${kind} with id ${id} in workspace ${scope.workspaceId}, so nothing was deleted.`];

  if (elsewhere.length > 0) {
    const named = elsewhere.map(({ kind: k, hit }) => `${k} ${id} ("${hit!.name}")`).join(' and ');
    lines.push(
      `That id does exist, but as a different kind of entity: ${named}. GTM numbers ${KIND_PLURAL.tag}, ` +
        `${KIND_PLURAL.trigger} and ${KIND_PLURAL.variable} in separate id spaces, so an id read from one ` +
        `list will not resolve in another. Re-read ${KIND_PLURAL[kind]}_list and use an id from there.`,
    );
  } else if (own.length === 0) {
    lines.push(
      `This workspace has no ${KIND_PLURAL[kind]} at all, so no id would have worked. ` +
        `Check you are pointed at the right container and workspace before retrying.`,
    );
  } else {
    lines.push(`The ${KIND_PLURAL[kind]} that do exist here are: ${sample(own)}.`);
  }

  lines.push('This was not a permissions problem, despite what the API error says.');
  return `${KIND_PLURAL[kind]}_delete failed: ${lines.join(' ')}`;
}

/**
 * Explain a duplicate-name rejection by naming what already holds the name.
 *
 * Built-ins are checked first because they are the invisible case: they own
 * names, and the list a caller would naturally check does not include them.
 */
export async function explainDuplicateName(
  client: GtmClient,
  scope: WorkspaceScope,
  name: string,
  originalError: unknown,
): Promise<string> {
  let builtIns: Entity[];
  let userDefined: Entity[];
  try {
    [builtIns, userDefined] = await Promise.all([
      listBuiltInVariables(client, scope),
      listEntities(client, scope, 'variable'),
    ]);
  } catch {
    return `variables_create failed: ${formatGoogleError(originalError)}`;
  }

  const wanted = name.trim().toLowerCase();
  const builtIn = builtIns.find((v) => v.name.trim().toLowerCase() === wanted);
  const existing = userDefined.find((v) => v.name.trim().toLowerCase() === wanted);

  if (builtIn) {
    return (
      `variables_create failed: the name "${name}" is already taken by an ENABLED BUILT-IN variable ` +
      `(type "${builtIn.id}"), so GTM rejected the new user-defined variable. Built-in variables do not ` +
      `appear in variables_list, which is why checking that list first showed the name as free — ` +
      `built_in_variables_list is where they are. You almost certainly do not need this variable at all: ` +
      `reference the built-in directly as {{${builtIn.name}}}. If you genuinely need a separate one, give ` +
      `it a distinct name.`
    );
  }

  if (existing) {
    return (
      `variables_create failed: a user-defined variable named "${name}" already exists ` +
      `(id ${existing.id}). Use variables_update on id ${existing.id} to change it, or pick another name.`
    );
  }

  // Nothing visible owns it. Say so rather than inventing a cause; a disabled
  // built-in or a name normalisation rule can still collide.
  return (
    `variables_create failed: GTM says the name "${name}" is a duplicate, but no enabled built-in and no ` +
    `user-defined variable in this workspace matches it. Try a clearly different name. ` +
    `Original error: ${formatGoogleError(originalError)}`
  );
}
