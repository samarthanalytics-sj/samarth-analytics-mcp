/**
 * Keeps the orchestrator running.
 *
 * The orchestrator is a long-lived process that holds MCP child processes, in-memory approval state,
 * and per-user sessions. Started by hand it dies with the terminal, and a crash at 2am is a service
 * that is simply down until somebody notices. This restarts it and writes down why it stopped.
 *
 * Deliberately small. It is a restart loop and a log file, not a process manager: no config format,
 * no daemon protocol, no dependencies. Anything more belongs to whatever supervises the real host
 * (systemd, a container runtime, a platform), and this should be deleted when that exists.
 *
 * The one behaviour worth explaining is the crash-loop backoff. A process that exits immediately is
 * almost always misconfigured, not unlucky: a missing OPENAI_API_KEY fails the same way on the
 * hundredth attempt as the first. Restarting it in a tight loop burns CPU, floods the log, and
 * buries the error message that would have explained it. So a fast exit escalates the delay, and a
 * run that lasted long enough to be real resets it.
 *
 *   node scripts/supervise.mjs
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'dist', 'chat-orchestrator', 'src', 'index.js');
const logDir = join(packageRoot, 'logs');
const logFile = join(logDir, 'orchestrator.log');

/**
 * Where a deploy declares itself, and where it finds the process to stop.
 *
 * A deploy and a crash used to be the same line in this log. Both arrive as an
 * external kill, so the child exits with no signal and code -1 (4294967295
 * unsigned), and the supervisor could only report what it saw:
 *
 *   orchestrator exited (code 4294967295, signal none) after 2470s
 *
 * On 2026-08-12 five of those lines were routine deploys, one per merged PR,
 * and reading the log back they were indistinguishable from a service falling
 * over every half hour. Two days of apparent crash-looping were a healthy
 * service being redeployed.
 *
 * The obvious fix, having the deploy send SIGTERM so the child shuts down
 * cleanly, does not work here: this host is Windows, where killing another
 * process maps to TerminateProcess whatever signal is named, and the target
 * never runs its handler. The orchestrator's own SIGTERM handler is real but
 * unreachable from outside the process.
 *
 * So intent is declared out of band instead. scripts/restart.mjs writes the
 * flag, then stops the pid in the pid file; this loop reads the flag and says
 * which kind of stop it was. The kill is still abrupt. What changed is that the
 * log no longer implies an incident when there wasn't one.
 */
const pidFile = join(logDir, 'orchestrator.pid');
const restartFlag = join(logDir, 'restart-requested');
/**
 * What the last stop was, for the next run to report.
 *
 * The orchestrator cannot record its own stop on this host (see above), so the supervisor writes
 * one note here and the next run turns it into an "Orchestrator Stopped" or "Unexpected Shutdown"
 * event, with the time, the duration and whether it was planned. Read once and deleted by
 * src/lifecycle.ts.
 */
const lastExitFile = join(logDir, 'last-exit.json');

function writeLastExit(record) {
  try {
    writeFileSync(lastExitFile, JSON.stringify(record), 'utf8');
  } catch (err) {
    note(`could not write ${lastExitFile}: ${err.message}. The next run will not report this stop.`);
  }
}

/**
 * How long a restart request stays believable.
 *
 * Without an expiry, a flag written by a deploy whose kill then failed would sit
 * on disk and relabel the next genuine crash as planned — the one failure mode
 * that would make this worse than no feature at all.
 */
const RESTART_FLAG_TTL_MS = 120_000;

/** A run shorter than this did not get as far as serving anything, so it counts as a failed start. */
const HEALTHY_RUN_MS = 20_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
/** A planned restart is not backing off from anything; just let the port clear. */
const PLANNED_RESTART_MS = 500;

mkdirSync(logDir, { recursive: true });

/**
 * Keeps one previous log alongside the current one.
 *
 * Without this the file grows until the disk complains, and the usual reflex, truncating on start,
 * would throw away the crash that caused the restart you are investigating.
 */
function rotateIfLarge() {
  try {
    if (statSync(logFile).size < MAX_LOG_BYTES) return;
    renameSync(logFile, `${logFile}.1`);
  } catch {
    // No log yet, or a rename that lost a race with another writer. Either way, keep going.
  }
}

rotateIfLarge();
let log = createWriteStream(logFile, { flags: 'a' });

function note(message) {
  const line = `[supervisor ${new Date().toISOString()}] ${message}\n`;
  log.write(line);
  process.stdout.write(line);
}

let child = null;
let stopping = false;
let consecutiveFastExits = 0;

/**
 * Reads and clears a restart request, returning null when there isn't a usable one.
 *
 * Always deletes the file it read, including when it was too old to honour: a
 * flag left behind is exactly what would mislabel a later crash.
 */
function consumeRestartRequest() {
  if (!existsSync(restartFlag)) return null;
  let raw = '';
  try {
    raw = readFileSync(restartFlag, 'utf8');
  } catch {
    // Unreadable is as good as absent; fall through and clear it.
  }
  try {
    unlinkSync(restartFlag);
  } catch {
    // Losing this race means a duplicate label at worst, never a missed crash.
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Hand-written or truncated. Honour the intent, describe it as unknown.
    parsed = {};
  }

  const requestedAt = Number(parsed.at);
  const age = Number.isFinite(requestedAt) ? Date.now() - requestedAt : Number.POSITIVE_INFINITY;
  if (age > RESTART_FLAG_TTL_MS) {
    note(
      `ignoring a restart request that was ${Number.isFinite(age) ? `${Math.round(age / 1000)}s` : 'un-timestamped and'} ` +
        `old — treating this stop as unplanned`,
    );
    return null;
  }
  return { reason: typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'no reason given', age };
}

/** Publishes the child's pid so a deploy can stop the right process. */
function writePidFile(pid) {
  try {
    writeFileSync(pidFile, String(pid), 'utf8');
  } catch (err) {
    note(`could not write ${pidFile}: ${err.message}. scripts/restart.mjs will not find the process.`);
  }
}

function clearPidFile() {
  try {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  } catch {
    // A stale pid file is handled by the reader, which checks the process exists.
  }
}

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [entry], {
    cwd: packageRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  child.on('exit', (code, signal) => {
    child = null;
    clearPidFile();
    if (stopping) return;

    const ranFor = Date.now() - startedAt;
    const seconds = Math.round(ranFor / 1000);
    const planned = consumeRestartRequest();

    writeLastExit({
      at: new Date().toISOString(),
      code: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      planned: Boolean(planned),
      reason: planned ? planned.reason : '',
      ranForMs: ranFor,
      fastExits: planned ? 0 : ranFor < HEALTHY_RUN_MS ? consecutiveFastExits + 1 : 0,
    });

    let delay;
    if (planned) {
      // Said plainly, because the whole point is that this line is not an incident.
      note(
        `orchestrator stopped for a PLANNED RESTART after ${seconds}s — reason: ${planned.reason}. ` +
          `Not a crash; the exit code below is just how Windows reports an external stop ` +
          `(code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
      );
      // A deploy is not evidence of instability, so it must not push the backoff
      // ladder up and slow down the restart the operator is waiting on.
      consecutiveFastExits = 0;
      delay = PLANNED_RESTART_MS;
    } else {
      note(`orchestrator exited UNEXPECTEDLY (code ${code ?? 'null'}, signal ${signal ?? 'none'}) after ${seconds}s`);

      if (ranFor < HEALTHY_RUN_MS) {
        consecutiveFastExits++;
      } else {
        // It ran long enough to have served traffic, so this is a crash rather than a bad start.
        consecutiveFastExits = 0;
      }

      delay = BACKOFF_MS[Math.min(consecutiveFastExits, BACKOFF_MS.length - 1)];
      if (consecutiveFastExits >= 3) {
        note(
          `${consecutiveFastExits} fast exits in a row. This is usually configuration, not bad luck: ` +
            `check the error above and .env before waiting for the next attempt.`,
        );
      }
    }
    note(`restarting in ${delay / 1000}s`);

    // Rotate between runs rather than mid-stream, so a crash and its restart stay in one file.
    //
    // NOT unref'd, deliberately. Once the child has exited and its pipes have closed, this timer is
    // the only thing referencing the event loop; unref'ing it lets Node decide there is nothing left
    // to do and exit, so the supervisor dies at the exact moment it is supposed to act.
    setTimeout(() => {
      rotateIfLarge();
      log = createWriteStream(logFile, { flags: 'a' });
      start();
    }, delay);
  });

  child.on('error', (err) => note(`failed to spawn: ${err.message}`));
  writePidFile(child.pid);
  note(`started orchestrator (pid ${child.pid})`);
}

/** Stops the child before exiting, so a restart does not find the port still held. */
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  note(`supervisor received ${signal}, stopping orchestrator`);
  // A stop the operator asked for. Recorded here because the child's exit handler above returns
  // early while `stopping` is set, and the next run should still say this was deliberate.
  if (child) {
    writeLastExit({
      at: new Date().toISOString(),
      code: null,
      signal,
      planned: true,
      reason: `supervisor stopped by ${signal}`,
      ranForMs: 0,
      fastExits: 0,
    });
  }
  child?.kill();
  clearPidFile();
  // Give it a moment to close listeners, then leave regardless.
  setTimeout(() => process.exit(0), 3_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

note(`supervising ${entry}`);
note(`logging to ${logFile}`);
start();
