/**
 * Chat memory: durable preferences that shape FUTURE conversations.
 *
 * Different from conversation history in the way that matters. History answers "what did we say in
 * that thread" and is only seen when someone opens it. Memory answers "how does this customer want
 * things done" and is injected into every relevant turn without being asked for.
 *
 * The motivating case, in the user's words: a container has its own tag naming convention. Said
 * once, every tag the assistant builds in that container should follow it from then on.
 *
 * SCOPE IS THE WHOLE DESIGN. A naming convention belongs to ONE container. Applying Acme's
 * convention to Globex's container is worse than forgetting it, because it produces confidently
 * wrong names nobody asked for. So retrieval only ever returns memories whose scope matches the
 * current session, and the store refuses a scoped memory with nothing to scope it to.
 *
 * WHAT IS NOT REMEMBERED, deliberately:
 *   - Anything the user did not state as a durable preference. The model is instructed to record
 *     rules, not facts about the container it can simply read back at any time. Remembering "this
 *     container has 47 tags" produces confident staleness the moment a tag is added.
 *   - Secrets. Everything is redacted on the way in, the same as the audit trail.
 */
import { forLog, redactSecrets } from './redact.js';

export type MemoryScope = 'user' | 'container' | 'property';

/** Orchestrator-owned tool names. Handled in the turn loop; never sent to the MCP server. */
export const REMEMBER_MEMORY = 'remember_memory';
export const FORGET_MEMORY = 'forget_memory';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  content: string;
  source: 'explicit' | 'inferred';
  createdAt: string;
}

/** What the session knows about where it is, which is what decides scope matching. */
export interface MemoryContext {
  containerId?: string;
  propertyId?: string;
}

/** How many memories may be injected into one turn. */
const MAX_INJECTED = 16;
/** Longest single memory. Matches the database check, so a refusal is caught before the round trip. */
const MAX_CONTENT = 500;

export class MemoryStore {
  private readonly enabled: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
  ) {
    this.enabled = Boolean(baseUrl && serviceRoleKey);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, prefer = 'return=representation'): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 200)}`);
    return prefer.includes('return=representation') ? ((await res.json().catch(() => [])) as unknown[]) : [];
  }

  /**
   * The memories that apply to this session.
   *
   * EVERY query filters on user_id explicitly: the service role bypasses RLS, so the ownership
   * check is this code and nothing else. Same reasoning as the audit reads.
   *
   * Returns [] on failure rather than throwing. Memory is an enhancement, and a turn that runs
   * without it is worse than one that runs with it but far better than one that fails.
   */
  async forSession(userId: string, ctx: MemoryContext): Promise<MemoryRecord[]> {
    if (!this.enabled) return [];

    // PostgREST `or` with the scoped clauses. A container-scoped memory only matches when THIS
    // session is in that container.
    const clauses = ['and(scope.eq.user,scope_id.is.null)'];
    if (ctx.containerId) clauses.push(`and(scope.eq.container,scope_id.eq.${encodeURIComponent(ctx.containerId)})`);
    if (ctx.propertyId) clauses.push(`and(scope.eq.property,scope_id.eq.${encodeURIComponent(ctx.propertyId)})`);

    try {
      const rows = (await this.request(
        'GET',
        `chat_memories?user_id=eq.${encodeURIComponent(userId)}&or=(${clauses.join(',')})` +
          `&select=id,scope,scope_id,content,source,created_at&order=created_at.desc&limit=${MAX_INJECTED}`,
      )) as {
        id: string;
        scope: MemoryScope;
        scope_id: string | null;
        content: string;
        source: 'explicit' | 'inferred';
        created_at: string;
      }[];

      return rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        scopeId: r.scope_id,
        content: r.content,
        source: r.source,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.error('[memory] retrieval failed:', forLog(err instanceof Error ? err.message : String(err)));
      return [];
    }
  }

  /**
   * Stores one memory.
   *
   * Throws on refusal, because unlike retrieval this is something the user explicitly asked for:
   * silently not remembering is the worst outcome, since they will rely on it later.
   */
  async remember(
    userId: string,
    input: { content: string; scope: MemoryScope; scopeId?: string | null },
  ): Promise<{ stored: boolean; reason?: string }> {
    if (!this.enabled) return { stored: false, reason: 'Memory is not configured on this deployment.' };

    const content = redactSecrets((input.content ?? '').trim());
    if (content.length < 3) return { stored: false, reason: 'That is too short to store as a memory.' };
    if (content.length > MAX_CONTENT) {
      return { stored: false, reason: `Memories are limited to ${MAX_CONTENT} characters. Store the rule, not the explanation.` };
    }

    const scope = input.scope;
    const scopeId = scope === 'user' ? null : (input.scopeId ?? null);
    if (scope !== 'user' && !scopeId) {
      // The model asked to scope a memory to a container/property the session does not have. Told
      // plainly, so it asks the user to select one rather than silently storing it account-wide,
      // which would apply one customer's rules to another's.
      return {
        stored: false,
        reason: `Cannot store a ${scope}-scoped memory: no ${scope} is selected in this conversation. Ask the user to select one, or store it for the whole account with scope "user".`,
      };
    }

    try {
      await this.request('POST', 'chat_memories', {
        user_id: userId,
        scope,
        scope_id: scopeId,
        content,
        source: 'explicit',
      });
      return { stored: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The unique index. Already knowing something is a success from the user's point of view.
      if (/duplicate key|23505/i.test(msg)) return { stored: true, reason: 'Already remembered.' };
      if (/100 remembered facts/i.test(msg)) {
        return { stored: false, reason: 'This scope already holds 100 memories. Ask the user to remove some first.' };
      }
      console.error('[memory] store failed:', forLog(msg));
      return { stored: false, reason: 'That could not be saved.' };
    }
  }

  /** Removes one memory the caller owns. */
  async forget(userId: string, id: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    try {
      const rows = await this.request(
        'DELETE',
        `chat_memories?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&select=id`,
      );
      return rows.length > 0;
    } catch (err) {
      console.error('[memory] delete failed:', forLog(err instanceof Error ? err.message : String(err)));
      return false;
    }
  }

  /** Everything the user has stored, for the UI that lets them inspect and remove it. */
  async list(userId: string): Promise<MemoryRecord[]> {
    if (!this.enabled) return [];
    const rows = (await this.request(
      'GET',
      `chat_memories?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=id,scope,scope_id,content,source,created_at&order=created_at.desc&limit=200`,
    )) as { id: string; scope: MemoryScope; scope_id: string | null; content: string; source: 'explicit' | 'inferred'; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      scopeId: r.scope_id,
      content: r.content,
      source: r.source,
      createdAt: r.created_at,
    }));
  }

  /** Records that these memories were used, which is what makes the UI's "last used" honest. */
  markUsed(ids: string[]): void {
    if (!this.enabled || ids.length === 0) return;
    const list = ids.map((i) => `"${i}"`).join(',');
    // Fire and forget: bookkeeping must never delay or fail a turn.
    void this.request('PATCH', `chat_memories?id=in.(${list})`, { last_used_at: new Date().toISOString() }, 'return=minimal')
      .catch((err) => console.error('[memory] markUsed failed:', forLog(err instanceof Error ? err.message : String(err))));
  }
}

/**
 * The system-prompt block carrying what is remembered.
 *
 * Framed as the user's standing instructions, and explicitly ranked BELOW live tool output: a
 * memory is what someone said once, and the container is what is true now. When they disagree the
 * container wins, or the assistant starts describing a world that no longer exists.
 */
export function buildMemoryPrompt(memories: readonly MemoryRecord[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => {
    const where = m.scope === 'user' ? 'always' : m.scope === 'container' ? 'this container' : 'this property';
    return `- (${where}) ${m.content}`;
  });
  return (
    'REMEMBERED PREFERENCES. The user has told you these before, in earlier conversations, and ' +
    'expects them applied without being restated. Follow them when building or naming anything:\n' +
    lines.join('\n') +
    '\nThese are standing instructions, not facts about the current setup. Where one conflicts with ' +
    'what a tool actually returns, the TOOL is right and you should say so rather than repeating the ' +
    'remembered version. If the user contradicts one, follow the new instruction and offer to update ' +
    'the memory.'
  );
}

/** The system-prompt sentence telling the model it CAN remember things. */
export const MEMORY_TOOL_RULES =
  'REMEMBERING. When the user states a durable PREFERENCE or house rule (a naming convention, a ' +
  'format they always want, a policy for this container), call remember_memory so it survives into ' +
  'later conversations, and say briefly that you have. Scope it to the container or property when it ' +
  'belongs to that one, and to the user only when it is genuinely account-wide. ' +
  'Do NOT remember facts you can look up again (how many tags exist, what an id is): those go stale ' +
  'and a stale memory is worse than none. Do not remember one-off instructions that only applied to ' +
  'the current request.';
