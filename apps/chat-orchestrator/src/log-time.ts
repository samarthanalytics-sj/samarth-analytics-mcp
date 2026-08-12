/**
 * Stamps every console line with the time it was written.
 *
 * Why: the log records how long a turn TOOK but never said WHEN it ran. Only the supervisor's own
 * lines carried a clock, so dating a request meant finding the nearest restart and counting
 * forward from it. That is fine once and useless when you are trying to line a user's report up
 * against what the server was doing at the time, which is most of the reason to read this file.
 *
 * Installed as a console wrapper rather than threaded through 46 call sites in 25 files, so a line
 * added later is stamped without anyone remembering to do it.
 *
 * LOCAL time, and the full date. The supervisor writes UTC ISO, so the two formats differ on
 * purpose: a bare HH:MM:SS next to a UTC stamp invites subtracting one from the other, and the
 * date matters because this log spans days between restarts.
 */

let installed = false;

/**
 * The bracketed stamp that prefixes a line, e.g. "[2026-08-12 19:52:31]".
 *
 * Exported and pure so the FORMAT can be tested without touching the console. Testing it through
 * the installer instead meant fighting the idempotence guard, which is a fair sign the two concerns
 * did not belong in one function.
 */
export function timestampPrefix(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `[${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}]`
  );
}

/**
 * Replaces console.log / .error / .warn with stamped versions. Safe to call more than once.
 *
 * Only the FIRST argument is prefixed. Prefixing every line of a multi-line payload would put a
 * timestamp inside JSON bodies, and those get read and pasted around.
 */
export function installTimestampedLogging(): void {
  if (installed) return;
  installed = true;

  for (const level of ['log', 'error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(timestampPrefix(), ...args);
    };
  }
}
