// Desktop notifications for long-running work (a 250-page tag-suggestion scan runs for minutes, and
// the whole point is that you go and do something else meanwhile).
//
// PURE + framework-free: what to say and WHETHER to say it live here, so the rules are testable
// without an OS notification centre. The main process only renders what these functions return.
//
// Two rules do the work, and both exist to stop this becoming noise:
//   1. Never notify about something the user is already watching. A toast for a result already on
//      screen is pure interruption.
//   2. Never notify about work that finished before they could leave. A scan that took four seconds
//      did not free anyone up.

/** Below this, the task finished too quickly to have been worth walking away from. */
export const MIN_NOTIFY_MS = 20_000;

export type TaskOutcome = 'completed' | 'stopped' | 'failed';

export interface TaskResultSummary {
  /** What ran, in the user's words ("Tag suggestion scan"). */
  task: string;
  outcome: TaskOutcome;
  /** How long it ran. Used for the "was this worth a notification" test and shown in the body. */
  elapsedMs: number;
  /** Pages/items processed, when the task counts them. */
  done?: number;
  /** Pages/items intended, when known. A stopped run reports done OF total. */
  total?: number;
  /** What was actually produced (tags found, findings, rows). */
  found?: number;
  /** Noun for `found`, singular. Pluralised with a plain "s". */
  foundLabel?: string;
  /** Present on 'failed': the reason, already in human terms. */
  error?: string;
}

/** Whether an OS notification should fire. `focused` is whether the app window has focus RIGHT NOW,
 *  at the moment the task ended, not when it started: someone who walked away and came back is
 *  looking at the screen and needs no toast. */
export function shouldNotify(r: TaskResultSummary, focused: boolean): boolean {
  if (focused) return false;
  // A failure is worth surfacing however fast it happened - a scan that dies in two seconds is
  // exactly the case where the user is about to sit waiting for nothing.
  if (r.outcome === 'failed') return true;
  return r.elapsedMs >= MIN_NOTIFY_MS;
}

/** "4m 12s" / "45s". Rounded, because a notification is a glance, not a stopwatch. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const plural = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

export interface NotificationText {
  title: string;
  body: string;
}

/**
 * What the notification says.
 *
 * The outcome is never softened: a stopped scan says stopped and shows how far it got, and a run
 * that found nothing says so rather than reporting a page count that reads like success. Someone
 * coming back to a toast has to be able to tell "it worked" from "it gave up" without opening the
 * app, or the notification has cost them a trip.
 */
export function notificationText(r: TaskResultSummary): NotificationText {
  const took = formatDuration(r.elapsedMs);
  const label = r.foundLabel ?? 'result';

  if (r.outcome === 'failed') {
    return {
      title: `${r.task} failed`,
      body: r.error ? `${r.error} (after ${took})` : `It stopped with an error after ${took}.`,
    };
  }

  const pages = r.done !== undefined ? plural(r.done, 'page') : '';
  const found = r.found !== undefined ? plural(r.found, label) : '';

  if (r.outcome === 'stopped') {
    const scope = r.done !== undefined && r.total !== undefined && r.total > 0
      ? `${r.done.toLocaleString('en-US')} of ${r.total.toLocaleString('en-US')} pages`
      : pages || 'partway through';
    return {
      title: `${r.task} stopped`,
      body: [scope, found, `after ${took}`].filter(Boolean).join(' · ') + '. This covers only what was read before you stopped.',
    };
  }

  // Nothing found is a real outcome, not an empty success. Saying "250 pages scanned" alone would
  // read as a win to someone glancing at a toast.
  const nothing = r.found === 0;
  return {
    title: `${r.task} complete`,
    body: nothing
      ? [pages, `no ${label}s found`, `in ${took}`].filter(Boolean).join(' · ')
      : [pages, found, `in ${took}`].filter(Boolean).join(' · '),
  };
}
