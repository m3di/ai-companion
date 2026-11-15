import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE BODY AS A CHILD (round 12). One command runs everything: `npm run
 * start` spawns Companion.app's binary as a child of the bot, so the two
 * share one lifetime —
 *   - the bot stops (SIGINT, SIGTERM, a watch restart) → the app is killed;
 *   - the app quits (window closed, a crash) → the bot exits with its code;
 *   - the bot dies without a shutdown (a crash, a kill -9) → the app notices
 *     its parent pid is gone and quits itself (COMPANION_PARENT_PID).
 * Mehdi's rule: "app + bot + everything should run with one command, and
 * when they die they should die together."
 *
 * The binary is run from INSIDE the bundle so it keeps the bundle's identity
 * (the microphone grant in part 2 follows the signature), and it is spawned
 * rather than `open`ed because `open` hands the process to launchd and no
 * parent–child bond survives that.
 *
 * COMPANION_APP=0 runs the bot alone (a server, a test, a debugging session
 * that wants no window). A missing build is reported once and skipped: the
 * app is optional, the bot is not.
 */
const BINARY = resolve('body/.build/Companion.app/Contents/MacOS/Companion');

export function startBody(opts: { atlasUrl?: string; onExit: (code: number | null, signal: NodeJS.Signals | null) => void }): ChildProcess | undefined {
  if (process.env.COMPANION_APP === '0') return undefined;
  if (process.platform !== 'darwin') return undefined;
  if (!existsSync(BINARY)) {
    console.log('[body] Companion.app is not built — `npm run body` builds it; running the bot alone');
    return undefined;
  }
  const child = spawn(BINARY, [], {
    env: {
      ...process.env,
      COMPANION_PARENT_PID: String(process.pid),
      ...(opts.atlasUrl ? { COMPANION_ATLAS: opts.atlasUrl } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log(`[body] Companion.app started (pid ${child.pid})`);
  child.once('exit', (code, signal) => {
    console.log(`[body] Companion.app exited (${signal ?? `code ${code}`})`);
    opts.onExit(code, signal);
  });
  child.once('error', (e) => console.error('[body] failed to start Companion.app', e));
  return child;
}

/** Ask the app to quit; it has `grace` ms before SIGKILL. */
export function stopBody(child: ChildProcess | undefined, grace = 3000): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const hammer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, grace);
  hammer.unref();
}
