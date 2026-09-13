/**
 * Approval broker.
 *
 * A write tool is never executed because the model asked for it. The orchestrator parks the turn,
 * shows the user the parsed arguments, and executes only after that user explicitly approves.
 *
 * The model can therefore propose a change but never make one, which is the property that lets
 * write access exist at all on containers that belong to somebody's clients.
 *
 * State is in memory and per process, which is correct for a single node. Two nodes need this in
 * Redis, because an approval POST could land on the instance that is not holding the turn.
 */
import { randomUUID } from 'node:crypto';

export interface PendingApproval {
  id: string;
  /** The user who must approve. Nobody else can resolve it. */
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** When set, the caller must echo this word for the approval to count. */
  confirmWord?: string;
  createdAt: number;
  resolve(outcome: ApprovalOutcome): void;
  timer: NodeJS.Timeout;
}

export type ApprovalOutcome =
  | { approved: true; args: Record<string, unknown> }
  | { approved: false; reason: 'declined' | 'timeout' | 'aborted' };

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_approval' | 'not_yours' | 'already_resolved' | 'confirmation_required',
  ) {
    super(message);
  }
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  /**
   * Parks a write until the user decides.
   *
   * Resolves rather than rejects on decline, because a declined write is a normal outcome the model
   * should be told about and reason around, not an exception that aborts the turn.
   */
  request(
    userId: string,
    toolName: string,
    args: Record<string, unknown>,
    onCreated: (id: string) => void,
    confirmWord?: string,
  ): Promise<ApprovalOutcome> {
    const id = randomUUID();
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ approved: false, reason: 'timeout' });
      }, this.ttlMs);
      // Never hold the process open for an approval nobody is going to give.
      timer.unref?.();

      this.pending.set(id, {
        id,
        userId,
        toolName,
        args,
        confirmWord,
        createdAt: Date.now(),
        resolve,
        timer,
      });
      onCreated(id);
    });
  }

  /**
   * Records a decision.
   *
   * `args` lets the user correct what the model proposed before it runs. That is the point of
   * showing them: an approval card that cannot be edited is a confirmation dialog, and people click
   * through those.
   */
  resolve(
    id: string,
    userId: string,
    decision: 'approve' | 'decline',
    args?: Record<string, unknown>,
    typed?: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) {
      throw new ApprovalError('That approval has expired or was already answered.', 'unknown_approval');
    }
    // An approval id is a capability. Without this check, any authenticated user who guessed or
    // observed one could authorize a write against someone else's container.
    if (entry.userId !== userId) {
      throw new ApprovalError('That approval belongs to a different session.', 'not_yours');
    }

    // A delete carries a word the user must retype. Checked here rather than in the UI, because a
    // client-side gate is a suggestion and this one has to be a rule.
    if (decision === 'approve' && entry.confirmWord && typed?.trim() !== entry.confirmWord) {
      throw new ApprovalError(
        `This change needs you to type ${entry.confirmWord} to confirm.`,
        'confirmation_required',
      );
    }

    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(
      decision === 'approve'
        ? { approved: true, args: args ?? entry.args }
        : { approved: false, reason: 'declined' },
    );
  }

  /** Declines everything a user has outstanding. Used when their turn is aborted. */
  abortFor(userId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.userId !== userId) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ approved: false, reason: 'aborted' });
    }
  }

  stats(): { pending: number } {
    return { pending: this.pending.size };
  }
}

/**
 * A one-line description of what a write will do, for the approval card headline.
 *
 * Generic on purpose: it reads the arguments a tool actually received rather than carrying a table
 * of per-tool phrasing that would drift as tools are added.
 */
export function summarizeWrite(toolName: string, args: Record<string, unknown>): string {
  if (/(^|_)(delete|remove)(_|$)/i.test(toolName)) {
    const subject = toolName.replace(/_(delete|remove).*$/, '').replace(/_/g, ' ');
    const id =
      (typeof args.tagId === 'string' && args.tagId) ||
      (typeof args.triggerId === 'string' && args.triggerId) ||
      (typeof args.variableId === 'string' && args.variableId) ||
      (typeof args.name === 'string' && args.name) ||
      '';
    return id ? `Delete from ${subject}: ${id}` : `Delete from ${subject}`;
  }

  const verb = toolName.includes('_create')
    ? 'Create'
    : toolName.includes('_update')
      ? 'Update'
      : toolName.includes('_revert')
        ? 'Revert'
        : 'Change';

  const subject = toolName
    .replace(/^ga4_/, 'GA4 ')
    .replace(/_(create|update|revert).*$/, '')
    .replace(/_/g, ' ');

  const name =
    (typeof args.name === 'string' && args.name) ||
    (typeof args.displayName === 'string' && args.displayName) ||
    (typeof args.tagId === 'string' && `tag ${args.tagId}`) ||
    (typeof args.triggerId === 'string' && `trigger ${args.triggerId}`) ||
    (typeof args.variableId === 'string' && `variable ${args.variableId}`) ||
    '';

  return name ? `${verb} ${subject}: ${name}` : `${verb} ${subject}`;
}
