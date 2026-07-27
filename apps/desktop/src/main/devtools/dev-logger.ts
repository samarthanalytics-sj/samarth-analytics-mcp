// Dev-only: capture main-process activity (console logs, IPC calls, Google API HTTP) and ship it to
// the renderer so it shows up in the DevTools Console - the activity that is otherwise invisible
// there (main logs go to the terminal; IPC and API HTTP never touch the renderer). Everything is
// redacted by shared/devlog before it leaves the main process.
//
// INSTALL ONLY WHEN !app.isPackaged. Each installer is idempotent and self-contained; if one cannot
// wire up (e.g. gaxios not resolvable) it degrades to a no-op rather than breaking the app.

import { format } from 'node:util';
import type { IpcMain } from 'electron';
import { redact, redactAll, safeUrl, type DevLogEntry, type DevLogLevel } from '../../shared/devlog';

type Sink = (entry: DevLogEntry) => void;

let sink: Sink | null = null;
// Entries emitted before the window exists are buffered (bounded) and flushed once the sink is set,
// so the DevTools Console shows startup activity too. Cleared after the flush.
const BUFFER_CAP = 500;
let buffer: DevLogEntry[] = [];

/** Point the bridge at the renderer (called once the window can receive `webContents.send`). Flushes
 *  any buffered startup entries. */
export function setDevLogSink(fn: Sink): void {
  sink = fn;
  const pending = buffer;
  buffer = [];
  for (const e of pending) {
    try { fn(e); } catch { /* a dead window must never crash a flush */ }
  }
}

/** Redact `parts`, stamp an entry, and deliver it (or buffer it). NEVER throws and NEVER calls
 *  console.* (the console bridge patches console, so calling it here would recurse). */
function emit(scope: string, level: DevLogLevel, ...parts: unknown[]): void {
  let entry: DevLogEntry;
  try {
    entry = { ts: Date.now(), scope, level, parts: redactAll(parts) };
  } catch {
    return;
  }
  if (sink) {
    try { sink(entry); } catch { /* window gone mid-send - drop silently */ }
    return;
  }
  buffer.push(entry);
  if (buffer.length > BUFFER_CAP) buffer.shift();
}

// ── A. Console bridge ────────────────────────────────────────────────────────
const CONSOLE_LEVELS: DevLogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];
let consoleBridged = false;

/** Mirror every main-process console.* call into the DevLog bridge, WITHOUT changing its terminal
 *  behaviour. printf-style args are pre-formatted with util.format so the renderer prints one clean
 *  string (no format-specifier drift across the IPC hop). */
export function installConsoleBridge(): void {
  if (consoleBridged) return;
  consoleBridged = true;
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console) as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]): void => {
      original(...args); // terminal output, unchanged
      try {
        emit('main', level, format(...args));
      } catch { /* logging must never break the real console call */ }
    };
  }
}

// ── B. IPC call log (the app's real "network") ───────────────────────────────
let ipcWrapped = false;

/** Wrap ipcMain.handle so every IPC call logs channel + redacted args + duration + ok/error. Must run
 *  BEFORE the handlers are registered, so it sees all of them. */
export function installIpcLogging(ipc: IpcMain): void {
  if (ipcWrapped) return;
  ipcWrapped = true;
  const orig = ipc.handle.bind(ipc);
  ipc.handle = ((channel: string, listener: (...a: never[]) => unknown): void => {
    orig(channel, (async (event: unknown, ...args: unknown[]): Promise<unknown> => {
      const start = Date.now();
      try {
        const result = await (listener as (...a: unknown[]) => unknown)(event, ...args);
        emit('ipc', 'debug', channel, { ms: Date.now() - start, ok: true, args });
        return result;
      } catch (e) {
        emit('ipc', 'error', `${channel} FAILED`, { ms: Date.now() - start, ok: false, error: e, args });
        throw e;
      }
    }) as never);
  }) as IpcMain['handle'];
}

// ── C. Google API HTTP log ───────────────────────────────────────────────────
let httpWrapped = false;

/** Patch Gaxios.prototype.request (the single transport every @googleapis client and token refresh
 *  goes through) so each outbound HTTP call logs method + safe URL + status + duration. Async +
 *  guarded: if gaxios cannot be loaded, C simply does not activate. */
export async function installHttpLogging(): Promise<void> {
  if (httpWrapped) return;
  try {
    const mod = (await import('gaxios')) as unknown as { Gaxios?: { prototype: { request: (...a: unknown[]) => Promise<unknown> } } };
    const Gaxios = mod.Gaxios;
    if (!Gaxios?.prototype?.request) return;
    httpWrapped = true;
    const orig = Gaxios.prototype.request;
    Gaxios.prototype.request = async function patched(this: unknown, opts: { method?: string; url?: string } = {}): Promise<unknown> {
      const start = Date.now();
      const method = (opts.method ?? 'GET').toUpperCase();
      const url = safeUrl(String(opts.url ?? ''));
      try {
        const res = (await orig.call(this, opts)) as { status?: number };
        emit('http', 'debug', `${method} ${url}`, { status: res?.status, ms: Date.now() - start });
        return res;
      } catch (e) {
        const status = (e as { response?: { status?: number }; code?: string })?.response?.status ?? (e as { code?: string })?.code;
        emit('http', 'error', `${method} ${url} FAILED`, { status, ms: Date.now() - start, error: e });
        throw e;
      }
    } as typeof orig;
  } catch {
    /* gaxios not present / shape changed - C stays off, the rest of the bridge is unaffected */
  }
}

// Re-export so a caller can redact ad-hoc values if needed.
export { redact };
