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
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'dist', 'chat-orchestrator', 'src', 'index.js');
const logDir = join(packageRoot, 'logs');
const logFile = join(logDir, 'orchestrator.log');

/** A run shorter than this did not get as far as serving anything, so it counts as a failed start. */
const HEALTHY_RUN_MS = 20_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

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
    if (stopping) return;

    const ranFor = Date.now() - startedAt;
    note(`orchestrator exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) after ${Math.round(ranFor / 1000)}s`);

    if (ranFor < HEALTHY_RUN_MS) {
      consecutiveFastExits++;
    } else {
      // It ran long enough to have served traffic, so this is a crash rather than a bad start.
      consecutiveFastExits = 0;
    }

    const delay = BACKOFF_MS[Math.min(consecutiveFastExits, BACKOFF_MS.length - 1)];
    if (consecutiveFastExits >= 3) {
      note(
        `${consecutiveFastExits} fast exits in a row. This is usually configuration, not bad luck: ` +
          `check the error above and .env before waiting for the next attempt.`,
      );
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
  note(`started orchestrator (pid ${child.pid})`);
}

/** Stops the child before exiting, so a restart does not find the port still held. */
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  note(`supervisor received ${signal}, stopping orchestrator`);
  child?.kill();
  // Give it a moment to close listeners, then leave regardless.
  setTimeout(() => process.exit(0), 3_000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

note(`supervising ${entry}`);
note(`logging to ${logFile}`);
start();
