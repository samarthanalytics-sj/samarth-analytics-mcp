/**
 * Per-user MCP process pool.
 *
 * Isolation model: one MCP child process per user, holding only that user's Google access token.
 * A tool call therefore cannot execute under another user's identity even if a bug or a prompt
 * injection tried, because the process running it has no other credentials to reach for.
 *
 * The cost of that isolation is roughly 150-300 MB per live child, so children are pooled, reused
 * across turns, evicted when idle, and capped in number.
 */
import { McpConnection } from './mcp-client.js';
import type { OrchestratorConfig } from './config.js';
import { GoogleIdentityError, type GoogleTokenProvider } from './google-identity.js';

interface PoolEntry {
  connection: McpConnection;
  accessToken: string;
  lastUsedAt: number;
  /** In-flight turns. A child is never evicted while it is serving one. */
  inUse: number;
}

export class McpPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly starting = new Map<string, Promise<PoolEntry>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: OrchestratorConfig,
    private readonly tokens: GoogleTokenProvider | null,
  ) {}

  start(): void {
    this.sweeper ??= setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /**
   * Returns a connection bound to this user's Google identity.
   *
   * A cached child whose token has changed is torn down rather than reused: the token lives in the
   * child's environment, so a new token means a new process.
   */
  async acquire(userId: string, userJwt: string): Promise<McpConnection> {
    const token = await this.resolveToken(userId, userJwt);
    const entry = await this.entryFor(userId, token);
    entry.inUse++;
    entry.lastUsedAt = Date.now();
    return entry.connection;
  }

  release(userId: string): void {
    const entry = this.entries.get(userId);
    if (!entry) return;
    entry.inUse = Math.max(0, entry.inUse - 1);
    entry.lastUsedAt = Date.now();
  }

  /**
   * Replaces a user's child with one holding a freshly minted token. Called after Google rejects
   * the current one mid-turn.
   */
  async refreshIdentity(userId: string, userJwt: string): Promise<McpConnection> {
    if (!this.tokens) {
      throw new GoogleIdentityError(
        'This deployment has no per-user Google identity configured, so the token cannot be refreshed.',
        'refresh_failed',
      );
    }
    const identity = await this.tokens.refresh(userId, userJwt);
    await this.evict(userId, 'identity refreshed');
    const entry = await this.entryFor(userId, identity.accessToken);
    entry.inUse++;
    entry.lastUsedAt = Date.now();
    return entry.connection;
  }

  private async resolveToken(userId: string, userJwt: string): Promise<string> {
    if (!this.tokens) return '';
    const identity = await this.tokens.getIdentity(userId, userJwt);
    // Refresh a little early rather than letting a turn fail halfway through.
    if (identity.expiresAt && identity.expiresAt - Date.now() < 60_000) {
      const refreshed = await this.tokens.refresh(userId, userJwt);
      return refreshed.accessToken;
    }
    return identity.accessToken;
  }

  private async entryFor(userId: string, accessToken: string): Promise<PoolEntry> {
    const existing = this.entries.get(userId);
    if (existing) {
      if (existing.accessToken === accessToken) return existing;
      await this.evict(userId, 'token changed');
    }

    // Collapse concurrent first requests from the same user onto one spawn.
    const pending = this.starting.get(userId);
    if (pending) return pending;

    const promise = this.spawn(userId, accessToken).finally(() => this.starting.delete(userId));
    this.starting.set(userId, promise);
    return promise;
  }

  private async spawn(userId: string, accessToken: string): Promise<PoolEntry> {
    await this.enforceCapacity();

    const connection = new McpConnection(this.cfg, accessToken || undefined);
    await connection.connect();

    const entry: PoolEntry = { connection, accessToken, lastUsedAt: Date.now(), inUse: 0 };
    this.entries.set(userId, entry);
    return entry;
  }

  /** Evicts the least recently used idle child when the pool is full. */
  private async enforceCapacity(): Promise<void> {
    const max = this.cfg.pool.maxSessions;
    if (this.entries.size < max) return;

    const idle = [...this.entries.entries()]
      .filter(([, e]) => e.inUse === 0)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    if (idle.length === 0) {
      throw new Error(
        `All ${max} MCP sessions are busy. Raise MCP_POOL_MAX_SESSIONS or add capacity.`,
      );
    }
    await this.evict(idle[0][0], 'pool at capacity');
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.cfg.pool.idleTtlMs;
    for (const [userId, entry] of this.entries) {
      if (entry.inUse === 0 && entry.lastUsedAt < cutoff) {
        await this.evict(userId, 'idle');
      }
    }
  }

  private async evict(userId: string, reason: string): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry) return;
    this.entries.delete(userId);
    try {
      await entry.connection.close();
    } catch {
      // A child that already exited is fine; the goal is only that it is gone.
    }
    console.log(`[pool] closed MCP session for user ${redactId(userId)} (${reason})`);
  }

  stats(): { sessions: number; busy: number } {
    let busy = 0;
    for (const e of this.entries.values()) if (e.inUse > 0) busy++;
    return { sessions: this.entries.size, busy };
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.entries.keys()].map((id) => this.evict(id, 'shutdown')));
  }
}

/** User ids are pseudonymous but still identifiers; logs get a short prefix only. */
function redactId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}...`;
}
