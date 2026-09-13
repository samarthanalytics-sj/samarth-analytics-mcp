/**
 * Restarts the orchestrator, on the record.
 *
 * Use this after a deploy instead of killing the process by hand. Both do the
 * same thing to the process; only this one leaves the log able to tell the
 * difference afterwards.
 *
 * The problem it solves is a reading problem, not a reliability one. A deploy
 * and a crash reach the supervisor identically — an external stop, no signal,
 * exit code -1 — so on 2026-08-12 five routine deploys, one per merged PR,
 * wrote five lines that read exactly like a service falling over every half
 * hour. Nobody was wrong to worry about them; the log simply did not carry the
 * one fact that would have settled it.
 *
 * Sending SIGTERM instead would be the usual answer and does not work on this
 * host. Windows has no signal delivery for one process stopping another: Node
 * maps every kill onto TerminateProcess, so the orchestrator's SIGTERM handler,
 * which exists and is correct, is unreachable from out here. Intent therefore
 * travels beside the kill rather than inside it — a flag file the supervisor
 * reads when it notices the child is gone.
 *
 *   node scripts/restart.mjs
 *   node scripts/restart.mjs "deploying #876"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(packageRoot, 'logs');
const pidFile = join(logDir, 'orchestrator.pid');
const restartFlag = join(logDir, 'restart-requested');

const reason = process.argv.slice(2).join(' ').trim() || 'manual restart';

/** True when the pid is a process that currently exists. Signal 0 tests, it does not kill. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

function fail(message) {
  console.error(`restart: ${message}`);
  process.exit(1);
}

if (!existsSync(pidFile)) {
  fail(
    `no pid file at ${pidFile}. Either the supervisor is not running, or it predates the pid file ` +
      `and needs restarting once by hand for this to work from now on.`,
  );
}

const pid = Number(readFileSync(pidFile, 'utf8').trim());
if (!Number.isInteger(pid) || pid <= 0) fail(`pid file does not contain a pid: ${JSON.stringify(readFileSync(pidFile, 'utf8'))}`);

if (!alive(pid)) {
  fail(
    `pid ${pid} is not running. The supervisor will already be restarting it, or has stopped; ` +
      `check logs/orchestrator.log rather than killing anything.`,
  );
}

// Written BEFORE the kill, deliberately. The supervisor reads this the moment it
// sees the child exit, and on a fast machine that is sooner than you would think.
mkdirSync(logDir, { recursive: true });
writeFileSync(restartFlag, JSON.stringify({ at: Date.now(), reason, pid }), 'utf8');

try {
  process.kill(pid);
} catch (err) {
  fail(`could not stop pid ${pid}: ${err.message}`);
}

console.log(`restart: stopped orchestrator (pid ${pid}) — ${reason}`);
console.log('restart: the supervisor brings it back in ~0.5s; tail logs/orchestrator.log to watch.');
