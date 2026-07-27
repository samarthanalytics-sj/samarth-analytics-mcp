// Renderer side of the dev logging bridge.
//
//  1. Global error capture (D): the ErrorBoundary catches React RENDER errors, but async errors and
//     unhandled promise rejections escape it. These handlers surface those in the console too.
//  2. Main -> renderer mirror (A/B/C): re-print the redacted entries the main process sends
//     (console logs, IPC calls, Google API HTTP) into THIS DevTools Console, tagged by origin so
//     main-process activity is distinguishable from genuine renderer logs.
//
// Entirely best-effort: it must never throw into app startup. In a packaged build the main process
// sends nothing on the devlog channel, so the mirror is a silent no-op; the error handlers stay
// (harmless, and useful if DevTools is ever opened on a shipped build).

import type { DevLogEntry, DevLogLevel } from '../../shared/devlog';

const SCOPE_STYLE: Record<string, string> = {
  main: 'color:#8b95a7;font-weight:600',
  ipc: 'color:#4a9eff;font-weight:600',
  http: 'color:#3fb98a;font-weight:600',
};
const LABEL_BASE = 'padding:1px 5px;border-radius:4px;background:rgba(127,127,127,0.14)';

function printEntry(entry: DevLogEntry): void {
  try {
    const level: DevLogLevel = (['debug', 'log', 'info', 'warn', 'error'] as DevLogLevel[]).includes(entry.level) ? entry.level : 'log';
    const style = `${LABEL_BASE};${SCOPE_STYLE[entry.scope] ?? SCOPE_STYLE.main}`;
    // The first arg is the ONLY format string; %c consumes `style`. The redacted parts follow as
    // separate args, so objects stay expandable in DevTools and no stray %-specifier in them is
    // re-interpreted. See devlog.ts for why parts are pre-formatted/structured this way.
    // eslint-disable-next-line no-console
    (console[level] as (...a: unknown[]) => void)(`%cmain:${entry.scope}`, style, ...entry.parts);
  } catch {
    /* a broken log line must never take out the bridge */
  }
}

let installed = false;

/** Wire up global error capture + the main-process log mirror. Idempotent; safe to call once at
 *  renderer startup. */
export function installRendererDevConsole(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    // eslint-disable-next-line no-console
    console.error('[uncaught]', e.error ?? e.message, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '');
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    // eslint-disable-next-line no-console
    console.error('[unhandledrejection]', e.reason);
  });

  try {
    window.desktop?.onDevLog?.(printEntry);
  } catch {
    /* preload bridge not present (e.g. a test harness) - skip the mirror */
  }
}
