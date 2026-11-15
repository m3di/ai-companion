import { spawn } from 'node:child_process';
import { countRunningWatches, finishWatch, insertWatch, runningWatches } from './db.js';
import { resumeTurn } from './dispatch.js';

/**
 * BACKGROUND WATCHES — how a worker waits on something external (CI, a deploy,
 * an e2e run) WITHOUT holding its turn open.
 *
 * The old guidance had a worker foreground-watch a run to completion, which
 * pinned the thread at "typing…" and was lost the instant the turn or session
 * ended (a session-limit reset mid-wait dropped it every time). Instead: the
 * worker launches the watch here, its turn ENDS, and the bot process — which
 * outlives any single turn or session — re-invokes the worker the moment the
 * watch command exits, carrying the verdict. The `watches` table persists it so
 * even a bot restart re-arms the still-running watch rather than dropping it.
 *
 * Commands are restricted to `gh` (the CI/PR use case) — this runs in the bot's
 * own process, outside the worker's permission sandbox, so it is not a general
 * shell. `gh run watch --exit-status` / `gh pr checks <n> --watch --fail-fast`
 * are the intended shapes.
 */

const TAIL_CAP = 2000;
const MAX_WATCH_MS = 90 * 60 * 1000; // a CI/e2e run that hasn't finished in 90m is stuck
const MAX_PER_SLOT = 3;

export const WATCH_PREFIXES = ['gh '];

export function watchCommandAllowed(command: string): boolean {
  return WATCH_PREFIXES.some((p) => command.trim().startsWith(p));
}

export interface WatchStart {
  ok: boolean;
  id?: number;
  reason?: string;
}

/** Launch a watch: record it, spawn it, and wire its exit to a worker re-invoke.
 *  Returns immediately — the caller's turn should end. */
export function startWatch(chatId: number, slot: number, command: string, label: string): WatchStart {
  if (!watchCommandAllowed(command)) {
    return { ok: false, reason: `Only ${WATCH_PREFIXES.map((p) => `\`${p.trim()}\``).join('/')} commands can be watched (this runs outside the sandbox). Got: ${command.slice(0, 60)}` };
  }
  if (countRunningWatches(chatId, slot) >= MAX_PER_SLOT) {
    return { ok: false, reason: `Already watching ${MAX_PER_SLOT} runs on this thread — wait for one to finish.` };
  }
  const id = insertWatch(chatId, slot, command, label);
  spawnWatch(id, chatId, slot, command, label);
  return { ok: true, id };
}

/** The actual child process + exit → re-invoke. Shared by startWatch and the
 *  boot re-arm, so both paths behave identically. */
function spawnWatch(id: number, chatId: number, slot: number, command: string, label: string): void {
  let child;
  try {
    child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Could not even start — resolve the row and tell the worker rather than
    // leaving a phantom "running" watch forever.
    finishWatch(id, -1, `failed to launch: ${e instanceof Error ? e.message : String(e)}`);
    void resumeTurn(chatId, slot, watchPrompt(label, command, -1, `failed to launch: ${e instanceof Error ? e.message : String(e)}`), 'machine');
    return;
  }

  let tail = '';
  const absorb = (b: Buffer) => {
    tail = (tail + b.toString()).slice(-TAIL_CAP);
  };
  child.stdout?.on('data', absorb);
  child.stderr?.on('data', absorb);

  const killer = setTimeout(() => {
    tail += `\n[watch timed out after ${Math.round(MAX_WATCH_MS / 60000)}m — killed]`;
    child.kill('SIGTERM');
  }, MAX_WATCH_MS);

  let done = false;
  const settle = (code: number) => {
    if (done) return; // 'exit' and 'error' can both fire — resolve once
    done = true;
    clearTimeout(killer);
    finishWatch(id, code, tail.trim());
    void resumeTurn(chatId, slot, watchPrompt(label, command, code, tail.trim()), 'machine');
  };
  child.on('error', (e) => {
    absorb(Buffer.from(`\nspawn error: ${e.message}`));
    settle(-1);
  });
  child.on('exit', (code) => settle(code ?? -1));
}

/** The re-invoke prompt: states the verdict plainly and hands control back. */
function watchPrompt(label: string, command: string, code: number, tail: string): string {
  const verdict = code === 0 ? 'PASSED (exit 0)' : `FAILED/ended (exit ${code})`;
  return (
    `[WATCH FINISHED] The background run you were waiting on has finished — you were re-invoked to act on it.\n` +
    `What: ${label}\n` +
    `Command: ${command}\n` +
    `Result: ${verdict}\n` +
    (tail ? `Output tail:\n${tail}\n` : '') +
    `\nContinue from here: if it passed, proceed with the next step; if it failed, read the output, decide whether it is a real failure or flake, and either fix/rerun or report the concrete cause. Do not re-launch a watch just to poll — only if there is a genuinely new run to wait on.`
  );
}

/** On boot, re-arm every watch still marked running: the child died with the
 *  previous process, but `gh run watch` re-attaches to a run that is still going
 *  (and returns immediately if it already finished). Without this a restart
 *  mid-wait would strand the worker forever. */
export function rearmWatches(): void {
  const rows = runningWatches();
  if (!rows.length) return;
  console.log(`[watch] re-arming ${rows.length} background watch(es) after restart`);
  for (const w of rows) spawnWatch(w.id, w.chat_id, w.slot, w.command, w.label);
}
