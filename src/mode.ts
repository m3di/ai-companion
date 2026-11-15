import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import {
  beatDreamPhase,
  claimDreamPhase,
  clearDebugSession,
  debugSession,
  dreamCancelRequested,
  dreamPhase,
  maxEntityWriteId,
  openDebugSession,
  recordDebugSession,
  releaseDreamPhase,
  writesSince,
} from './db.js';
import { describeDebt, type NightDebt, nightOwed } from './night.js';
import { pulse } from './pulse.js';

/**
 * WORK STATE — live, dreaming, or debug.
 *
 * The bot's normal condition is LIVE: the day answers, the night folds, the
 * probes tick. That is also the condition under which it is impossible to work
 * ON it, because everything moves while you look. Every session in this
 * codebase has hit the same wall — you change a rule, and to see whether it
 * helped you have to wait for a night that also does eight other things, into a
 * concierge context that has since absorbed the experiment.
 *
 * DEBUG is the other state, and it is defined by what it FORBIDS:
 *
 *   - no day session, no worker, no commitment turn, no wakeup;
 *   - nothing added to the concierge's context, at all;
 *   - no probe sweep, no focus sweep, no harvest, no distil;
 *   - no AUTOMATIC nightly.
 *
 * and by what it still allows: gardening, an INDUCED dream, and reads. So the
 * graph can be worked on iteratively and watched — every write still pulses, so
 * the Atlas lights the nodes as they change — while nothing else moves
 * underneath.
 *
 * ## Why a snapshot and not a journal replay
 *
 * `entity_writes` holds a `before` for every op, so an inverse-op rollback is
 * possible and it is the wrong choice: it fails halfway on dependencies (revert
 * the mint before the edge that points at it), it cannot undo anything that
 * ISN'T a journalled graph write, and a half-completed rollback leaves a state
 * nobody designed. The tree is 740K across 89 files. A snapshot costs
 * milliseconds and cannot half-fail, and it covers the whole tree rather than
 * only the part that went through `record()`.
 *
 * ## Exiting
 *
 * Two doors, and the difference is the concierge's context:
 *
 *   - ROLLBACK — the tree returns to what it was, so the concierge's picture is
 *     still accurate and its context is LEFT ALONE. That is the point of
 *     rolling back: the experiment costs the day nothing.
 *   - KEEP — the memory changed under a context built on the old one, so the
 *     context must go. Not a courtesy: a concierge answering from a picture the
 *     graph no longer supports is exactly the failure mode that had it emailing
 *     Iris a question already answered.
 *
 * The state lives in the DATABASE, not in a variable. `tsx watch` restarts this
 * process on every source edit, which is precisely what one does while
 * debugging — a mode held in memory would silently revert to live mid-session
 * and let the day back in.
 *
 * ## Three states, and why dreaming is not a third peer
 *
 * The bot may be in exactly one state, and DREAMING is the third. It is not
 * modelled as a peer of debug, because flat exclusivity would make the induced
 * dream illegal — and the induced dream is the operator's main instrument for
 * *"did that change help?"*. So:
 *
 *   - DEBUG is a SESSION: a snapshot, a baseline write id, a reason. It spans
 *     everything the operator does, and it survives a dream.
 *   - DREAMING is a PHASE: a lock with a start and a holder. It is claimed for
 *     the length of one rewrite pass and released.
 *
 * `currentMode()` reports dreaming over debug over live, so an induced dream
 * reads as `dreaming` for its duration and drops back to `debug` after. While
 * it holds, NOTHING else runs — no day turn, no worker, and no operator prompt
 * either. A dream is the day's termination routine; anything that talks to the
 * day while it terminates is writing into a context that is being rewritten.
 *
 * The phase lives in the DATABASE for the same reason the session does, and for
 * one more: it replaced an in-process variable in `operator.ts` that was
 * guarding against a real double-nightly and could not see across a process
 * boundary at all. The scheduled pass runs in the bot; an induced one runs from
 * a CLI. Two locks, neither of which was one.
 */

export type Mode = 'live' | 'dreaming' | 'debug';

/** Things that must not happen while the machine is being worked on. */
export type Activity =
  | 'day-turn'
  | 'worker'
  | 'commitment'
  | 'wakeup'
  | 'auto-nightly'
  | 'probe-sweep'
  | 'focus-sweep'
  | 'harvest'
  | 'distill'
  /** Opening a debug session — refused mid-dream. */
  | 'debug-enter'
  /**
   * An operator prompt to the debug agent.
   *
   * Allowed while LIVE — reading the graph and answering about it costs the day
   * nothing, and refusing it meant the only way to ask the machine a question
   * about itself was to stop the machine. Never mid-dream.
   */
  | 'operator-turn'
  /**
   * That agent WRITING. This is the one debug actually buys.
   *
   * Split from `operator-turn` because they were conflated, and the conflation
   * had a cost the design never intended: to ask "what does this node look
   * like" you had to sedate the bot, which suspends turns, workers, probes and
   * the nightly — an enormous price for a question. Reading is free; changing
   * memory under a live concierge is not.
   */
  | 'operator-write'
  /** Starting a rewrite pass, induced or scheduled. */
  | 'dream';

/** Beside the tree, not inside it: a snapshot under `data/knowledge/` would be
 *  parsed as knowledge and snapshotted by the next session. */
const SNAPSHOT_DIR = join(config.knowledgeDir, '..', 'debug');

export interface DebugState {
  reason: string;
  since: string;
  snapshot: string;
  /** The last journal id before debug opened — everything after is this session's. */
  baselineWriteId: number;
}

export function currentMode(): Mode {
  if (dreamPhase()) return 'dreaming';
  return debugSession() ? 'debug' : 'live';
}

export function debugState(): DebugState | undefined {
  return debugSession();
}

/**
 * How much this session has actually changed — the number that decides whether
 * leaving is one click or a question.
 *
 * It belongs HERE, on an integer comparison of journal ids, because the first
 * version computed it in the browser by filtering runs on `started_at >=
 * since`. Those are two different time formats — SQLite writes
 * `2026-08-08 13:20:00`, `toISOString` produces `2026-08-08T13:20:00Z` — and
 * since a space sorts before `T`, the filter matched NOTHING. The exit dialog
 * said "nothing was written, leaving costs nothing" over three real writes, and
 * offered no way to discard them.
 *
 * The same count `exitDebug` reports, from the same baseline, so the dialog and
 * the outcome cannot disagree.
 */
export function debugWriteCount(): number {
  const d = debugState();
  return d ? writesSince(d.baselineWriteId).length : 0;
}

/** The pass currently holding the machine, if one is. */
export function dreamState(): { scope: string; since: string; pid: number } | undefined {
  return dreamPhase();
}

/**
 * What each state permits.
 *
 * DREAMING permits nothing at all: it is the day's termination routine, and
 * every activity here either talks to the context being rewritten or writes the
 * graph being folded. DEBUG permits the two things the operator came for.
 */
const PERMITTED: Record<Mode, ReadonlySet<Activity>> = {
  live: new Set<Activity>([
    'day-turn', 'worker', 'commitment', 'wakeup', 'auto-nightly',
    'probe-sweep', 'focus-sweep', 'harvest', 'distill', 'debug-enter', 'dream',
    // Reading and answering, but NOT writing — the whole point of the split.
    'operator-turn',
  ]),
  debug: new Set<Activity>(['operator-turn', 'operator-write', 'dream']),
  dreaming: new Set<Activity>(),
};

/**
 * THE DAY — everything that belongs to the waking half and may not run until
 * the night before it has been folded.
 *
 * The four that are absent are the four that must never be gated on the debt,
 * and each for the same reason: gating them would make the debt unpayable.
 * `dream` pays it. `operator-turn`, `operator-write` and `debug-enter` are how
 * a person gets in to cancel it. A hold that blocks its own release is the
 * shape I8 exists to forbid, and this is the third time in three weeks that
 * exact shape has had to be designed around.
 */
const DAY: ReadonlySet<Activity> = new Set<Activity>([
  'day-turn', 'worker', 'commitment', 'wakeup', 'auto-nightly',
  'probe-sweep', 'focus-sweep', 'harvest', 'distill',
]);

/**
 * Is this allowed right now?
 *
 * Deliberately a QUERY and not a throw. Every caller has a different right
 * answer — a sweep skips, a message says so to the user, a nightly logs — and a
 * thrown error in a `setInterval` is an unhandled rejection nobody sees.
 *
 * Two gates, and the second one is not a mode. A day activity is refused while
 * a night is OWED, because the alternative is what happened on 2026-08-15: the
 * morning routine fired at 05:15, the fold that was meant to close the previous
 * day landed at 05:48, and the night rewrote a session the morning had already
 * written into. A day that starts before its night has ended is a day appended
 * to the wrong one.
 *
 * `owed` is a parameter with a live default for the reason `fireDueCommitments`
 * takes its guard: the debt is ONE GLOBAL ROW, the suite runs its files in
 * parallel against one database, and a test that has to unsettle a night to
 * assert the gate would blind every other file for as long as it ran.
 */
export function allowed(a: Activity, owed: boolean = !!nightOwed()): boolean {
  if (DAY.has(a) && owed) return false;
  return PERMITTED[currentMode()].has(a);
}

/**
 * One line explaining a refusal, in the terms of whoever hit it.
 *
 * All three states can refuse something, and the operator's next move is
 * different in each — sedate it, wake it, or wait. A message that names the
 * wrong state sends them to the wrong one, which is exactly what happened when
 * this assumed a refusal could only come from debug: asking the agent a
 * question while the bot was LIVE was answered with "DEBUG MODE — suspended",
 * i.e. the opposite of the truth, with the fix being the thing it said to undo.
 */
export function refusal(a: Activity, debtOverride?: NightDebt): string {
  const mode = currentMode();
  // Checked FIRST for day activities, because it is the one refusal that can
  // be true while the mode is a perfectly ordinary `live` — and being told
  // "the bot is LIVE, sedate it" when the real answer is "the night has not
  // folded yet" sends the operator to sedate a bot that is already waiting.
  const debt = DAY.has(a) ? (debtOverride ?? nightOwed()) : undefined;
  if (debt && mode !== 'dreaming') {
    return `THE NIGHT IS STILL OWED — ${a} is held. ${describeDebt(debt)} A fold is starting; the day opens the moment it lands. If this cannot wait, send /cancelnight <why> — the pass stops, its writes are rolled back, and the day opens. (Also on the Atlas chip, or \`npx tsx src/modeCli.ts cancel-dream "<why>"\`.)`;
  }
  if (mode === 'dreaming') {
    const d = dreamState();
    return `DREAMING${d ? ` (a ${d.scope} pass since ${d.since})` : ''} — ${a} is blocked. The night is rewriting the day's memory; nothing may touch it until the pass lands. Try again in a few minutes.`;
  }
  if (mode === 'debug') {
    const d = debugState()!;
    const since = ` (since ${d.since}${d.reason ? `, "${d.reason}"` : ''})`;
    return `DEBUG MODE${since} — ${a} is suspended. The graph can be gardened and dreamed on; the day cannot run. Exit with \`/live\` or \`npx tsx src/modeCli.ts exit\`.`;
  }
  return `The bot is LIVE — ${a} needs the day suspended first, so an experiment cannot land in front of the concierge mid-conversation. Sedate it with the DEBUG chip in the Atlas, \`/debug\`, or \`npx tsx src/modeCli.ts debug "<why>"\`.`;
}

export interface DreamClaim {
  ok: true;
  /** Hand the machine back. */
  release: () => void;
  /** The operator's reason for stopping this pass, if they have asked. */
  cancelled: () => string | undefined;
  /** "still folding" — keeps the hold from being mistaken for debris. */
  beat: () => void;
  /** Put the tree back as it was when the pass started. */
  rollback: () => void;
}

/**
 * Claim the machine for one rewrite pass, or say who holds it.
 *
 * `release`, `cancelled` and `rollback` are returned rather than exported
 * separately so there is no way to release — or unwind — a phase you did not
 * claim.
 *
 * ## Why a pass now snapshots
 *
 * Because the night became mandatory, and mandatory means it stands between
 * the operator and something urgent at exactly the wrong moment. The escape
 * hatch has to be real, and "stop the pass" alone is not real: a fold aborted
 * halfway has rewritten some domains and not others, which is a state nobody
 * designed and the next night would fold ON TOP of. So a cancel restores the
 * tree, and the snapshot is what makes that possible.
 *
 * The same argument as `enterDebug`, for the same reason: an inverse-op replay
 * of `entity_writes` fails halfway on dependencies and cannot undo anything
 * that never went through `record()` — and a pass edits files directly.
 */
export function beginDream(scope: string): DreamClaim | { ok: false; held: string } {
  const r = claimDreamPhase(scope, new Date().toISOString());
  if (!r.ok) return { ok: false, held: `a ${r.held.scope} pass (pid ${r.held.pid}) since ${r.held.since}` };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshot = join(SNAPSHOT_DIR, `dream-${scope}-${stamp}`);
  try {
    cpSync(config.knowledgeDir, snapshot, { recursive: true });
    pruneDreamSnapshots();
  } catch (e) {
    // A pass that cannot be rolled back is still far better than no pass. Say
    // so loudly and carry on, rather than refusing the night over its undo.
    console.error('[mode] could not snapshot the tree for this pass — cancel will not be able to roll back', e);
  }

  pulse('operator', `DREAMING — a ${scope} pass has the machine. The day is on hold.`, { loud: true });
  return {
    ok: true,
    release: () => {
      releaseDreamPhase();
      pulse('operator', `The ${scope} pass is done — ${currentMode()}.`, { loud: true });
    },
    cancelled: () => dreamCancelRequested(),
    beat: () => beatDreamPhase(),
    rollback: () => {
      if (!existsSync(snapshot)) {
        throw new Error(`the snapshot is gone (${snapshot}) — cannot roll this pass back. Its writes stand; revert by hand from entity_writes.`);
      }
      rmSync(config.knowledgeDir, { recursive: true, force: true });
      cpSync(snapshot, config.knowledgeDir, { recursive: true });
    },
  };
}

/** One a night adds up; keep enough to undo a bad fold noticed a few days late. */
const KEEP_DREAM_SNAPSHOTS = 7;

function pruneDreamSnapshots(): void {
  const old = readdirSync(SNAPSHOT_DIR)
    .filter((n) => n.startsWith('dream-'))
    .sort()
    .reverse()
    .slice(KEEP_DREAM_SNAPSHOTS);
  for (const n of old) rmSync(join(SNAPSHOT_DIR, n), { recursive: true, force: true });
}

export function enterDebug(reason: string): DebugState {
  const existing = debugState();
  if (existing) return existing;
  if (currentMode() === 'dreaming') {
    throw new Error(refusal('debug-enter'));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshot = join(SNAPSHOT_DIR, `knowledge-${stamp}`);
  cpSync(config.knowledgeDir, snapshot, { recursive: true });

  const state: DebugState = {
    reason: reason.trim(),
    since: new Date().toISOString(),
    snapshot,
    baselineWriteId: maxEntityWriteId(),
  };
  openDebugSession(state);
  // The Atlas is the place this is meant to be visible from, and a mode change
  // is exactly the kind of thing a ticker exists to show.
  pulse('operator', `DEBUG MODE entered${reason ? ` — ${reason}` : ''}. The day is suspended.`, { loud: true });
  return state;
}

export interface ExitReport {
  rolledBack: boolean;
  /** Graph writes made during the session — the diff a reviewer wants. */
  writes: Array<{ id: number; op: string; entity_id: string; reason: string; actor: string }>;
  /** True when the concierge's context was cleared because memory moved. */
  contextReset: boolean;
}

/**
 * Leave debug. `rollback` restores the tree; otherwise the changes stand.
 *
 * Returns what happened rather than printing it: the CLI, the chat command and
 * the tests all need the same facts in different words.
 */
export function exitDebug(opts: { rollback: boolean }): ExitReport | undefined {
  const d = debugState();
  if (!d) return undefined;

  const writes = writesSince(d.baselineWriteId);

  if (opts.rollback) {
    if (!existsSync(d.snapshot)) {
      // Refusing is the only safe answer: "rolled back" when nothing was
      // restored is a lie the operator would act on.
      throw new Error(`the snapshot is gone (${d.snapshot}) — cannot roll back. Exit with keep, and revert by hand from entity_writes.`);
    }
    rmSync(config.knowledgeDir, { recursive: true, force: true });
    cpSync(d.snapshot, config.knowledgeDir, { recursive: true });
    pulse('operator', `DEBUG MODE exited — ${writes.length} write(s) ROLLED BACK. The tree is as it was.`, { loud: true });
  } else {
    pulse('operator', `DEBUG MODE exited — ${writes.length} write(s) KEPT.`, { loud: true });
  }

  clearDebugSession();
  // A rollback leaves the concierge's picture accurate, so its context stands.
  // Keeping changes does not: the memory moved under it.
  const contextReset = !opts.rollback && writes.length > 0;
  // FILE IT. A context that emptied for a reason nobody recorded is a context
  // the night will invent a reason for, and the invented one will be wrong.
  recordDebugSession({
    reason: d.reason,
    since: d.since,
    writes: writes.length,
    rolledBack: opts.rollback,
    contextReset,
  });
  return { rolledBack: opts.rollback, writes, contextReset };
}

/** Snapshots from finished sessions — kept, because a rollback one day late is
 *  still the difference between a bad night and a lost graph. */
export function snapshots(): string[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  return readdirSync(SNAPSHOT_DIR).sort().reverse();
}
