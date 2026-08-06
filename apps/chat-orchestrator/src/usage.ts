/**
 * Usage metering: how much of their plan a user has spent, and whether they may spend more.
 *
 * Separate from audit.ts on purpose. The audit trail answers "what did the assistant do"; this
 * answers "may it do any more". They happen to share a database and a credential, and nothing else.
 *
 * The counters live on user_plans next to the quotas Settings already renders, and are moved by two
 * Postgres functions rather than by read-modify-write from here. Two turns finishing at the same
 * moment would otherwise both read 10 and both write 11.
 *
 * FAILS OPEN. If the quota cannot be read, the turn proceeds. Refusing to answer a question because
 * a metering table was briefly unreachable spends far more goodwill than the few uncounted turns
 * cost, and an operator who wants a hard stop should set a limit, not rely on an outage. Every
 * failure is logged and counted, so failing open never means failing silently.
 */
import { forLog, userRef } from './redact.js';

export interface QuotaStatus {
  allowed: boolean;
  /** Which limit was hit, when one was. */
  reason: 'chat_messages' | 'tokens' | null;
  usedChat: number;
  limitChat: number | null;
  usedTokens: number;
  limitTokens: number | null;
  planType: string;
}

/** Row shape returned by the chat_quota_status function. */
interface QuotaRow {
  allowed: boolean;
  reason: string | null;
  used_chat: number;
  limit_chat: number | null;
  used_tokens: number | string;
  limit_tokens: number | null;
  plan_type: string;
}

export class UsageMeter {
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

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      // Short: this sits in front of every turn, so a hung database must not become a hung chat.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${forLog(await res.text().catch(() => ''), 200)}`);
    }
    return res.json().catch(() => null);
  }

  private fail(what: string, err: unknown): void {
    this.failureCount++;
    console.error(
      `[usage] ${what} failed (${this.failureCount} total): ${forLog(err instanceof Error ? err.message : String(err))}`,
    );
  }

  /**
   * Reads this user's remaining allowance, rolling the month over if it has passed.
   *
   * Returns null when metering is off or unreadable, which callers must treat as "allowed". The
   * alternative, defaulting to blocked, turns a database blip into an outage for everyone.
   */
  async check(userId: string): Promise<QuotaStatus | null> {
    if (!this.enabled) return null;
    try {
      const rows = (await this.rpc('chat_quota_status', { p_user_id: userId })) as QuotaRow[];
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return null;
      return {
        allowed: row.allowed !== false,
        reason: (row.reason as QuotaStatus['reason']) ?? null,
        usedChat: row.used_chat ?? 0,
        limitChat: row.limit_chat ?? null,
        // BIGINT arrives as a string once it exceeds what JSON can hold exactly.
        usedTokens: Number(row.used_tokens ?? 0),
        limitTokens: row.limit_tokens ?? null,
        planType: row.plan_type ?? 'free',
      };
    } catch (err) {
      this.fail(`check for ${userRef(userId)}`, err);
      return null;
    }
  }

  /** Adds one turn and its tokens to this period. Fire and forget. */
  record(userId: string, tokens: number): void {
    if (!this.enabled) return;
    void this.rpc('record_chat_usage', {
      p_user_id: userId,
      p_tokens: Math.max(0, Math.round(tokens)),
    }).catch((err) => this.fail(`record for ${userRef(userId)}`, err));
  }
}

/**
 * Groups digits the same way on every host.
 *
 * Bare toLocaleString() reads the SERVER's locale, so the identical limit rendered as "500,000" on
 * one machine and "5,00,000" on another purely because of where the process happened to be running.
 * The response also carries the raw numbers, so a client that wants the reader's own locale should
 * format those rather than display this string.
 */
function groupDigits(value: number | null): string {
  return value === null ? '' : value.toLocaleString('en-US');
}

/** What the user is told when they run out. Names the limit, and what resets it. */
export function quotaMessage(status: QuotaStatus): string {
  const tail =
    'The allowance resets at the start of next month, or you can upgrade for a larger one.';
  if (status.reason === 'tokens') {
    return (
      `You have used all ${groupDigits(status.limitTokens)} tokens included in your ` +
      `${status.planType} plan this month. ${tail}`
    );
  }
  return (
    `You have used all ${groupDigits(status.limitChat)} chat messages included in your ` +
    `${status.planType} plan this month. ${tail}`
  );
}
