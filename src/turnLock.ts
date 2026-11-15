/**
 * THE TURN LOCK — one running turn per session, the rest queued.
 *
 * This is fifty lines of `Set` and `Map` and it has taken the bot down twice,
 * which is why it is its own module with its own tests instead of private state
 * in `dispatch.ts`.
 *
 * **2026-08-02** — a hung subprocess held a session forever and silently
 * swallowed every message behind it. Answer: the idle watchdog.
 *
 * **2026-08-06** — a turn that hung in SETUP (before it had registered an
 * AbortController) held the lock with nothing to abort and nothing watching.
 * `/cancel` found no controller, returned early WITHOUT releasing, and answered
 * "Nothing is running" — true, and useless. `cancelChat` iterated the
 * controller map, so the one session that needed rescuing was never even
 * visited. The only escape was restarting the process. That is I8: a check that
 * blocks its own repair.
 *
 * The rule the whole module exists to enforce: **`release` must be reachable
 * from every state the lock can be in**, including "held, with nothing to
 * abort". Everything else here is bookkeeping.
 */

import { clearQueuedTurns, dequeueTurn, dropQueuedTurns, queuedTurnCount, queueTurn } from './db.js';

export interface QueuedTurn {
  text: string;
  visible: boolean;
  userMsgId?: number;
  background?: boolean;
  /** The person produced this turn (typed, tapped, pressed) — provenance, carried, never sniffed. */
  human?: boolean;
}

export interface LockRow {
  key: string;
  queued: number;
  /** False means a turn is holding the lock but has not registered a
   *  controller yet — it is stuck in setup, and only `release` will free it. */
  abortable: boolean;
}

const busy = new Set<string>();
const running = new Map<string, AbortController>();

/** A session key is `${chatId}:${slot}` (db.ts sessionKey) — the queue row
 *  needs both halves so a boot can re-address what it finds. */
function parseKey(key: string): { chatId: number; slot: number } {
  const i = key.lastIndexOf(':');
  return { chatId: Number(key.slice(0, i)), slot: Number(key.slice(i + 1)) };
}

/** Take the lock, or report that someone else has it. */
export function acquire(key: string): boolean {
  if (busy.has(key)) return false;
  busy.add(key);
  return true;
}

/**
 * Give it back. Idempotent. The QUEUE IS NOT TOUCHED: release runs in the
 * holder's `finally`, including when a turn threw, and a throw must not cost
 * the messages waiting behind it (2026-08-27: a bounded Telegram retry now
 * throws by design, and the first version of the durable queue would have
 * deleted rows 2-4 in that very `finally`). Dropping the queue is the explicit
 * act of `cancel` — the person said stop — never a side effect of finishing.
 */
export function release(key: string): void {
  busy.delete(key);
  running.delete(key);
}

/** True while a turn holds the lock — whether or not it is abortable. */
export function isBusy(key: string): boolean {
  return busy.has(key);
}

/** Register the turn's abort handle. Until this lands, the turn is unabortable
 *  and `cancel` can only release the lock — which is exactly what it must do. */
export function register(key: string, controller: AbortController): void {
  running.set(key, controller);
}

export function isAbortable(key: string): boolean {
  return running.has(key);
}

/**
 * THE QUEUE IS A TABLE, NOT A MAP (2026-08-27). Every queued turn used to
 * live in process memory, and the process restarts on every source edit, on
 * every crash, and on the fix for the two-hour hang — each time the queue
 * died with the eyes reaction still on the messages. The busy set and the
 * controllers stay in memory because a lock held by a dead process must NOT
 * survive it; the queue must, and boot replays it (dispatch.recoverAfterRestart).
 */
export function enqueue(key: string, turn: QueuedTurn): void {
  const { chatId, slot } = parseKey(key);
  queueTurn(key, chatId, slot, turn);
}

export function dequeue(key: string): QueuedTurn | undefined {
  const row = dequeueTurn(key);
  if (!row) return undefined;
  return {
    text: row.text,
    visible: row.visible === 1,
    userMsgId: row.user_msg_id ?? undefined,
    background: row.background === 1 ? true : undefined,
    human: row.human === 1 ? true : undefined,
  };
}

/**
 * Run a turn now if the session is idle, else queue it. Returns whether it
 * ran (the caller reacts 👀 when it did not). The holder drains the queue
 * before releasing, and EVERY turn in that drain is its own try: one that
 * throws is logged and the next one still runs — a thrown send must not
 * strand the messages behind it. The ordering the boot recovery relies on:
 * everything up to the first await is synchronous, so a second call made
 * before the first yields sees the lock held and queues.
 */
export async function runOrQueue(key: string, turn: QueuedTurn, run: (turn: QueuedTurn) => Promise<void>): Promise<boolean> {
  if (!acquire(key)) {
    enqueue(key, turn);
    return false;
  }
  try {
    for (let next: QueuedTurn | undefined = turn; next; next = dequeue(key)) {
      try {
        await run(next);
      } catch (e) {
        console.error(`[turnLock] turn on ${key} threw; draining the rest`, e);
      }
    }
  } finally {
    release(key);
  }
  return true;
}

/**
 * Abort the turn holding this session, and release the lock either way.
 *
 * Returns whether a live turn was actually aborted, so a caller can tell
 * "I stopped something" from "I cleared a stuck lock" — a distinction worth
 * reporting, because the second one used to be indistinguishable from "nothing
 * was wrong".
 */
export function cancel(key: string): boolean {
  const controller = running.get(key);
  release(key);
  // /cancel means "stop, and forget what was waiting" — the one place the
  // queue is dropped on purpose rather than left for a boot to replay.
  dropQueuedTurns(key);
  if (!controller) return false;
  controller.abort();
  return true;
}

/**
 * Cancel everything in a chat. Walks `busy ∪ running`, not just `running` —
 * the session worth rescuing is precisely the one that holds the lock without a
 * controller, and iterating the controller map alone made it invisible.
 */
export function cancelPrefix(prefix: string): { aborted: number; released: number } {
  const keys = [...new Set([...busy, ...running.keys()])].filter((k) => k.startsWith(prefix));
  let aborted = 0;
  for (const key of keys) if (cancel(key)) aborted++;
  return { aborted, released: keys.length - aborted };
}

/** Every held lock and what is stacked behind it — the state that used to be
 *  invisible while it was blocking everything. */
export function lockState(): LockRow[] {
  return [...busy].map((key) => ({
    key,
    queued: queuedTurnCount(key),
    abortable: running.has(key),
  }));
}

/** Test-only: drop all state between cases. Not exported through dispatch. */
export function __resetForTest(): void {
  busy.clear();
  clearQueuedTurns();
  running.clear();
}
