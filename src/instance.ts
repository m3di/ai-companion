import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * ONE BOT PER MACHINE. 2026-11-08: a detached `npm run start` from a dev
 * session was still alive when Mehdi ran `npm run start` in his terminal.
 * The second instance began polling Telegram, THEN died on the Atlas port
 * (EADDRINUSE, an unhandled 'error' event), taking its Companion.app with
 * it — and the port was the lucky part: without ATLAS_PORT the two would have
 * fought over getUpdates all day, each seeing half the messages.
 *
 * The lock is a pid file, taken before anything with a side effect (the
 * poller, the body, the Atlas), and liveness is `kill -0` — a stale file from
 * a crash is reclaimed, a live holder is named with its start time and the
 * command that frees it. A mechanism, not a note in a README (I9); and the
 * refusal says exactly what is going on and what to do, so a bounced start is
 * never a mystery (I8).
 */
const LOCK = resolve(process.env.COMPANION_PID_FILE ?? 'data/bot.pid');

export type InstanceHolder = { pid: number; since: string };

export function runningInstance(path = LOCK): InstanceHolder | undefined {
  if (!existsSync(path)) return undefined;
  let holder: InstanceHolder;
  try {
    holder = JSON.parse(readFileSync(path, 'utf8')) as InstanceHolder;
  } catch {
    return undefined; // unreadable → stale
  }
  if (!Number.isInteger(holder.pid) || holder.pid === process.pid) return undefined;
  try {
    process.kill(holder.pid, 0);
    return holder;
  } catch {
    return undefined; // the process is gone; the file is debris
  }
}

/**
 * Take the lock or explain who has it. Returns a release function on success;
 * on failure prints the holder and exits — BEFORE the poller starts, so the
 * refused instance never touches Telegram.
 */
export function claimInstance(path = LOCK): () => void {
  const other = runningInstance(path);
  if (other) {
    console.error(
      `[companion] another bot is already running (pid ${other.pid}, since ${other.since}) — refusing to start a second one.\n` +
        `[companion] two instances would split Telegram's updates between them; stop the first with:\n` +
        `[companion]   kill ${other.pid}`,
    );
    process.exit(2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, since: new Date().toISOString() } satisfies InstanceHolder));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(readFileSync(path, 'utf8')) as InstanceHolder;
      if (cur.pid === process.pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  process.once('exit', release);
  return release;
}
