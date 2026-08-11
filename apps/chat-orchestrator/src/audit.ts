/**
 * Audit trail: what the assistant did, to whose container, and whether anyone approved it.
 *
 * The approval card used to be the record. It no longer is: a tag create, a GA4 property update and
 * a permission grant all apply the moment the model calls the tool, and without this the only trace
 * is a line in a log file on whichever host happened to be running. "Who changed this tag and when"
 * has to have an answer that is not "let me check my laptop".
 *
 * Written against PostgREST with the service role key rather than through @supabase/supabase-js.
 * This service has four dependencies and none of them are heavy; adding a client library to make
 * three POSTs would be the largest thing in the tree.
 *
 * TWO RULES, and they pull in opposite directions:
 *
 * 1. A failure here must never break a user's turn. Losing an audit row is bad; failing a container
 *    audit because a logging table was unreachable is worse, and would make the whole feature
 *    something an operator switches off.
 * 2. A failure here must never be silent. An audit trail that quietly stopped recording six weeks
 *    ago is worse than none, because everyone believes it. So every failure logs, and the count is
 *    on /health where a monitor can see it.
 */
import { forLog, redactSecrets, userRef } from './redact.js';
import type { ChatContext } from './types.js';

export interface AuditTarget {
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  propertyId?: string;
}

export interface ToolEventRecord extends AuditTarget {
  toolName: string;
  product: 'gtm' | 'ga4';
  surface?: 'gtm_draft' | 'gtm_live' | 'ga4_live';
  isWrite: boolean;
  isDelete: boolean;
  approval: 'not_required' | 'approved' | 'declined' | 'timeout' | 'aborted';
  args: Record<string, unknown>;
  ok: boolean;
  resultSummary: string;
  durationMs: number;
}

export interface AssistantTurnRecord {
  content: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  model: string;
  stopReason: string;
}

/**
 * Strips credentials from a value that is about to be stored.
 *
 * Round-tripping through JSON applies the same redaction to every nested string without walking the
 * object by hand. The replacement labels are plain text with no quotes or backslashes, so the
 * redacted document is still valid JSON; the catch is there because a value this important should
 * degrade to something rather than throw.
 */
export function redactValue(value: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value ?? null)));
  } catch {
    return { unserializable: true };
  }
}

/** Keeps a title short enough to list without being useless. */
function titleFrom(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

export class AuditRecorder {
  private failureCount = 0;
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

  stats(): { enabled: boolean; failures: number } {
    return { enabled: this.enabled, failures: this.failureCount };
  }

  private async request(
    method: 'POST' | 'PATCH' | 'GET',
    path: string,
    body?: unknown,
    prefer = 'return=minimal',
  ): Promise<unknown[] | null> {
    const res = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A slow audit write must not hold a turn open. The row is lost; the turn is not.
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 200)}`);
    }
    if (prefer.includes('return=representation')) {
      return (await res.json().catch(() => [])) as unknown[];
    }
    return null;
  }

  private fail(what: string, err: unknown): void {
    this.failureCount++;
    console.error(
      `[audit] ${what} failed (${this.failureCount} total): ${forLog(err instanceof Error ? err.message : String(err))}`,
    );
  }

  /**
   * Opens or resumes a conversation, returning the id everything else attaches to.
   *
   * A client-supplied id is checked against the caller before it is used. Without that check,
   * passing somebody else's conversation id would append your messages to their history, and the
   * service role key bypasses the RLS that would otherwise have stopped it. An id that is not
   * theirs quietly starts a new conversation rather than failing the turn.
   *
   * Returns null when auditing is off or the write failed, and the caller then records nothing for
   * this turn rather than treating it as fatal.
   */
  async beginConversation(
    userId: string,
    context: ChatContext,
    firstUserMessage: string,
    existingId?: string,
  ): Promise<string | null> {
    if (!this.enabled) return null;

    const target: AuditTarget = {
      accountId: context.accountId,
      containerId: context.containerId,
      workspaceId: context.workspaceId,
      propertyId: context.propertyId,
    };

    try {
      if (existingId) {
        const rows = await this.request(
          'PATCH',
          `chat_conversations?id=eq.${encodeURIComponent(existingId)}&user_id=eq.${encodeURIComponent(userId)}`,
          {
            updated_at: new Date().toISOString(),
            account_id: target.accountId ?? null,
            container_id: target.containerId ?? null,
            workspace_id: target.workspaceId ?? null,
            property_id: target.propertyId ?? null,
          },
          'return=representation',
        );
        if (rows && rows.length > 0) return existingId;
        console.warn(
          `[audit] conversation ${existingId} is not owned by user ${userRef(userId)}; starting a new one`,
        );
      }

      const created = await this.request(
        'POST',
        'chat_conversations',
        {
          user_id: userId,
          product: context.product,
          title: titleFrom(firstUserMessage),
          account_id: target.accountId ?? null,
          container_id: target.containerId ?? null,
          workspace_id: target.workspaceId ?? null,
          property_id: target.propertyId ?? null,
        },
        'return=representation',
      );
      const row = created?.[0] as { id?: string } | undefined;
      return row?.id ?? null;
    } catch (err) {
      this.fail('beginConversation', err);
      return null;
    }
  }

  /** Records what the user said. Fire and forget. */
  recordUserMessage(conversationId: string | null, userId: string, content: string): void {
    if (!this.enabled || !conversationId) return;
    void this.request('POST', 'chat_messages', {
      conversation_id: conversationId,
      user_id: userId,
      role: 'user',
      content: redactSecrets(content),
    }).catch((err) => this.fail('recordUserMessage', err));
  }

  /**
   * Records the assistant's reply and what the turn cost.
   *
   * The token counts live here rather than in their own table because metering and history want the
   * same rows, and separating them would mean a join to answer "what did this user spend".
   */
  recordAssistantTurn(
    conversationId: string | null,
    userId: string,
    turn: AssistantTurnRecord,
  ): void {
    if (!this.enabled || !conversationId) return;
    void this.request('POST', 'chat_messages', {
      conversation_id: conversationId,
      user_id: userId,
      role: 'assistant',
      content: redactSecrets(turn.content),
      prompt_tokens: turn.promptTokens,
      completion_tokens: turn.completionTokens,
      cached_tokens: turn.cachedTokens,
      model: turn.model,
      stop_reason: turn.stopReason,
    })
      .then(() => this.touch(conversationId))
      .catch((err) => this.fail('recordAssistantTurn', err));
  }

  /** The row that answers "what changed in this container, and who did it". Fire and forget. */
  recordToolEvent(
    conversationId: string | null,
    userId: string,
    event: ToolEventRecord,
  ): void {
    if (!this.enabled || !conversationId) return;
    void this.request('POST', 'chat_tool_events', {
      conversation_id: conversationId,
      user_id: userId,
      tool_name: event.toolName,
      product: event.product,
      surface: event.surface ?? null,
      is_write: event.isWrite,
      is_delete: event.isDelete,
      approval: event.approval,
      // Arguments AS EXECUTED, so a correction made on the approval card is what gets stored.
      args: redactValue(event.args),
      account_id: event.accountId ?? null,
      container_id: event.containerId ?? null,
      workspace_id: event.workspaceId ?? null,
      property_id: event.propertyId ?? null,
      ok: event.ok,
      result_summary: forLog(event.resultSummary, 500),
      duration_ms: event.durationMs,
    }).catch((err) => this.fail('recordToolEvent', err));
  }

  /** Keeps the conversation list ordered by real activity rather than by when it was opened. */
  private touch(conversationId: string): void {
    void this.request('PATCH', `chat_conversations?id=eq.${encodeURIComponent(conversationId)}`, {
      updated_at: new Date().toISOString(),
    }).catch((err) => this.fail('touch', err));
  }

  // ── Reading it back ────────────────────────────────────────────────────────
  //
  // EVERY query below filters on user_id explicitly. The service role key bypasses RLS, so the
  // database will happily return somebody else's conversation if asked; the ownership check is
  // this code, and nothing else. Same reasoning as beginConversation's id check.
  //
  // These throw rather than swallowing, unlike the write path. A write that fails costs a history
  // row nobody is waiting for; a read that fails is a user staring at an empty list, and silently
  // returning [] would tell them their conversations are gone.

  /** The caller's recent conversations, newest activity first. */
  /**
   * Scoped to ONE container or property when asked.
   *
   * The sidebar shows the conversations for wherever you are, not everything you have ever said.
   * Filtering server-side rather than in the client matters once someone has more than a page of
   * history: a client-side filter over the newest 30 rows would show an empty list for a container
   * whose conversations are all older than that, which reads as "this container has no history"
   * when it has plenty.
   */
  async listConversations(
    userId: string,
    limit = 30,
    scope?: { containerId?: string; propertyId?: string; archived?: boolean },
  ): Promise<ConversationSummary[]> {
    const filter = scope?.containerId
      ? `&container_id=eq.${encodeURIComponent(scope.containerId)}`
      : scope?.propertyId
        ? `&property_id=eq.${encodeURIComponent(scope.propertyId)}`
        : '';

    // Deleted rows are never returned to anyone. Archived ones are one query away, because
    // archiving something you cannot then find again is a delete wearing a softer word.
    const shelf = scope?.archived ? '&archived_at=not.is.null' : '&archived_at=is.null';

    const rows = (await this.request(
      'GET',
      `chat_conversations?user_id=eq.${encodeURIComponent(userId)}${filter}${shelf}&deleted_at=is.null` +
        `&select=${CONVERSATION_COLUMNS}` +
        `&order=pinned.desc,updated_at.desc.nullslast,created_at.desc&limit=${Math.min(Math.max(limit, 1), 100)}`,
      undefined,
      'return=representation',
    )) as ConversationRow[] | null;

    return (rows ?? []).map(toSummary);
  }

  /**
   * Pin or archive one conversation.
   *
   * Scoped by user_id as well as id, so the filter itself is the authorisation: a request for
   * someone else's conversation matches no row and changes nothing, rather than being checked and
   * then trusted.
   */
  async setConversationState(
    userId: string,
    conversationId: string,
    state: { pinned?: boolean; archived?: boolean },
  ): Promise<ConversationSummary | null> {
    const patch: Record<string, unknown> = {};
    if (typeof state.pinned === 'boolean') patch.pinned = state.pinned;
    if (typeof state.archived === 'boolean') {
      patch.archived_at = state.archived ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) return null;

    const rows = (await this.request(
      'PATCH',
      `chat_conversations?id=eq.${encodeURIComponent(conversationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&select=${CONVERSATION_COLUMNS}`,
      patch,
      'return=representation',
    )) as ConversationRow[] | null;

    const row = rows?.[0];
    return row ? toSummary(row) : null;
  }

  /**
   * Remove a conversation from the user's history.
   *
   * Soft, and not as a shortcut. chat_tool_events cascades from this table and records what the
   * assistant actually changed in a live GTM container; a hard delete would let the subject of the
   * audit erase the record of their own writes. The row stays, every user-facing read filters it
   * out, and the user sees it gone.
   */
  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const rows = (await this.request(
      'PATCH',
      `chat_conversations?id=eq.${encodeURIComponent(conversationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&select=id`,
      { deleted_at: new Date().toISOString() },
      'return=representation',
    )) as { id: string }[] | null;

    return (rows?.length ?? 0) > 0;
  }

  /**
   * One conversation's messages, oldest first, for replay into the transcript.
   *
   * Tool events are deliberately NOT joined in. Replaying which tools ran would suggest they could
   * be inspected or re-approved, and neither is true after the turn ended: the results are gone and
   * an approval cannot be revisited. The transcript shows what was said; the audit trail, which is
   * a separate surface with its own reader, shows what was done.
   */
  async getConversation(userId: string, conversationId: string): Promise<ConversationDetail | null> {
    const convs = (await this.request(
      'GET',
      `chat_conversations?id=eq.${encodeURIComponent(conversationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&deleted_at=is.null&select=${CONVERSATION_COLUMNS}&limit=1`,
      undefined,
      'return=representation',
    )) as ConversationRow[] | null;

    const conv = convs?.[0];
    // Not theirs, or does not exist. The two are answered identically on purpose: distinguishing
    // them would confirm the existence of another user's conversation to anyone guessing ids.
    if (!conv) return null;

    const rows = (await this.request(
      'GET',
      `chat_messages?conversation_id=eq.${encodeURIComponent(conversationId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&select=role,content,created_at&order=created_at.asc&limit=200`,
      undefined,
      'return=representation',
    )) as MessageRow[] | null;

    return {
      id: conv.id,
      title: conv.title ?? 'Untitled conversation',
      product: conv.product === 'ga4' ? 'ga4' : 'gtm',
      accountId: conv.account_id ?? undefined,
      containerId: conv.container_id ?? undefined,
      workspaceId: conv.workspace_id ?? undefined,
      propertyId: conv.property_id ?? undefined,
      updatedAt: conv.updated_at ?? conv.created_at,
      messages: (rows ?? [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' })),
    };
  }
}

const CONVERSATION_COLUMNS =
  'id,title,product,account_id,container_id,workspace_id,property_id,pinned,archived_at,created_at,updated_at';

function toSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title ?? 'Untitled conversation',
    product: r.product === 'ga4' ? 'ga4' : 'gtm',
    accountId: r.account_id ?? undefined,
    containerId: r.container_id ?? undefined,
    workspaceId: r.workspace_id ?? undefined,
    propertyId: r.property_id ?? undefined,
    pinned: r.pinned === true,
    archived: r.archived_at != null,
    updatedAt: r.updated_at ?? r.created_at,
  };
}

interface ConversationRow {
  id: string;
  title: string | null;
  product: string | null;
  account_id: string | null;
  container_id: string | null;
  workspace_id: string | null;
  property_id: string | null;
  pinned?: boolean | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string | null;
}

interface MessageRow {
  role: string;
  content: string | null;
  created_at: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  product: 'gtm' | 'ga4';
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  propertyId?: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: { role: 'user' | 'assistant'; content: string }[];
}
