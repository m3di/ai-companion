/**
 * RECOVERY AFTER A RESTART — the pure half.
 *
 * Two stores outlive the process: `turns_running` (a turn that was in flight)
 * and `turn_queue` (turns that never started). What to do with each row is a
 * rule, not a judgement, so it lives here where a test can reach it without a
 * transport or a model; `dispatch.recoverAfterRestart` only carries the plan
 * out.
 *
 * The rule: a PERSON's turn is replayed — they asked and were never answered,
 * and the 2026-08-27 restart made Mehdi retype his message. A MACHINE's turn
 * that was in flight is NOT re-run — a commitment or a system turn may have
 * half-applied something, and running its instruction again could redo it —
 * so it is reported, as it always was. A queued machine turn never ran, so it
 * carries no half-applied state and is run, framed with when it was queued,
 * unless it is older than QUEUE_TTL_MIN — a check-in from six hours ago is
 * not a check-in. A replayed turn says so in its own first line, so the bot
 * cannot claim it "just" received it; and a turn already framed as a replay is
 * never replayed again — a message that crashes the process on every attempt
 * must not loop forever — it goes into the report instead, so the person is
 * told rather than left with a reaction and silence.
 *
 * Recovery is a DAY activity. Mode lives in the database and survives a
 * restart, so a source edit during a debug session, or a boot while a night is
 * owed, must not replay a person's message into a sedated concierge (I11, and
 * debug's defining rule). `takeRecoveryIfAllowed` refuses and leaves the rows;
 * the tick calls it again, so recovery happens the moment the gate opens.
 */
import { fmtLocal } from './commitments.js';
import { restartEventsBetween, takeRecoveryRows, type QueuedTurnRow, type StrandedTurn, dbNow } from './db.js';
import { allowed, refusal } from './mode.js';

export const REPLAY_MARK = '[REPLAYED after a restart';
export const QUEUED_MARK = '[QUEUED at';
/** A queued machine turn older than this is dropped, not run. Same bound as the
 *  rotation handoff: six hours is where "still the same day's business" ends. */
export const QUEUE_TTL_MIN = 6 * 60;

export interface ReplayTurn {
  chatId: number;
  slot: number;
  key: string;
  /** What runs — framed. */
  text: string;
  /** What the person (or machine) actually sent — what the event names. */
  original: string;
  visible: boolean;
  background: boolean;
  userMsgId?: number;
  human: boolean;
  origin: 'in-flight' | 'queued';
}

export interface RecoveryPlan {
  /** Machine turns that were in flight: reported to the concierge, never re-run. */
  report: StrandedTurn[];
  /** Human turns that were in flight AND already framed as a replay: reported, not retried. */
  abandoned: StrandedTurn[];
  /** Queued machine turns past the TTL: dropped with an event. */
  expired: QueuedTurnRow[];
  /** Everything that runs again, oldest first: in-flight human turns, then the queue. */
  replay: ReplayTurn[];
}

/** The framing a replayed human turn carries — in the TURN, never the prompt. */
export function replayFraming(text: string, receivedUtc: string): string {
  return `${REPLAY_MARK} — received ${fmtLocal(receivedUtc)} local, never answered]\n${text}`;
}

/** The framing a queued machine turn carries: it is running late, and says so. */
export function queuedFraming(text: string, queuedUtc: string): string {
  return `${QUEUED_MARK} ${fmtLocal(queuedUtc).slice(11)} local, running now]\n${text}`;
}

function minutesBetween(fromUtc: string, toUtc: string): number {
  return (Date.parse(`${toUtc.replace(' ', 'T')}Z`) - Date.parse(`${fromUtc.replace(' ', 'T')}Z`)) / 60_000;
}

export function planRecovery(stranded: StrandedTurn[], queued: QueuedTurnRow[], nowUtc = dbNow()): RecoveryPlan {
  const plan: RecoveryPlan = { report: [], abandoned: [], expired: [], replay: [] };
  for (const t of stranded) {
    if (t.human !== 1) {
      plan.report.push(t);
      continue;
    }
    if (t.text.startsWith(REPLAY_MARK)) {
      plan.abandoned.push(t);
      continue;
    }
    plan.replay.push({
      chatId: t.chat_id,
      slot: t.slot,
      key: t.session_key,
      text: replayFraming(t.text, t.started_at),
      original: t.text,
      visible: true,
      background: false,
      userMsgId: t.user_msg_id ?? undefined,
      human: true,
      origin: 'in-flight',
    });
  }
  for (const q of queued) {
    const human = q.human === 1;
    if (!human && minutesBetween(q.created_at, nowUtc) > QUEUE_TTL_MIN) {
      plan.expired.push(q);
      continue;
    }
    const framed = q.text.startsWith(REPLAY_MARK) || q.text.startsWith(QUEUED_MARK);
    plan.replay.push({
      chatId: q.chat_id,
      slot: q.slot,
      key: q.session_key,
      text: framed ? q.text : human ? replayFraming(q.text, q.created_at) : queuedFraming(q.text, q.created_at),
      original: q.text,
      visible: q.visible === 1,
      background: q.background === 1,
      userMsgId: q.user_msg_id ?? undefined,
      human,
      origin: 'queued',
    });
  }
  return plan;
}

/**
 * Take what the last process left and plan it — or refuse, leaving every row
 * where it is, when the day is not allowed to run. Idempotent: once drained
 * the take is empty, so the tick can call this every minute.
 */
export function takeRecoveryIfAllowed(nowUtc = dbNow()): { plan: RecoveryPlan } | { refused: string } {
  if (!allowed('day-turn')) return { refused: refusal('day-turn') };
  const taken = takeRecoveryRows();
  return { plan: planRecovery(taken.stranded, taken.queued, nowUtc) };
}

// --- The tally cycleCli prints ----------------------------------------------

export const RESTART_SOURCE = 'restart';

export type RestartEventKind = 'killed' | 'replayed' | 'abandoned' | 'expired' | 'dropped';

export function restartEventBody(kind: RestartEventKind, head: string): string {
  return `turn ${kind} by restart: ${head.replace(/\s+/g, ' ').slice(0, 120)}`;
}

export interface RestartTally {
  /** In-flight turns a restart killed and did not re-run (reported, abandoned), plus queued turns it dropped. */
  killed: number;
  /** Turns a restart ran again. */
  replayed: number;
}

/** What restarts did to turns in a window, from the event log. */
export function restartTally(chatId: number, fromUtc: string, toUtc: string): RestartTally {
  const t: RestartTally = { killed: 0, replayed: 0 };
  for (const e of restartEventsBetween(chatId, fromUtc, toUtc)) {
    if (e.body.startsWith('turn replayed by restart')) t.replayed++;
    else if (e.body.startsWith('turn ')) t.killed++;
  }
  return t;
}
