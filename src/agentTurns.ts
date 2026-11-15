import { EventEmitter } from 'node:events';

/**
 * A TURN WHILE IT IS STILL HAPPENING.
 *
 * The ledger holds finished runs and is the right store for them: a run's
 * writes, its reads and its answer all belong in the database, and they are all
 * there the moment it lands. What was missing is the forty seconds BEFORE that
 * — the agent reading six nodes and writing three paragraphs — during which the
 * only honest thing the page could say was "thinking…".
 *
 * ## Why not the pulse bus
 *
 * The obvious move was to push the answer through `pulse()`, which already
 * crosses processes and already reaches the page. It is the wrong bus and its
 * own header says so: bounded, lossy, unpersisted, *"nothing here may ever
 * become load-bearing"*. A dropped pulse costs an animation frame. A dropped
 * delta costs a sentence out of the middle of an answer, silently — the reader
 * cannot tell a lossy answer from a complete one, which makes it worse than no
 * streaming at all.
 *
 * So this is a separate, small, in-process registry with different properties:
 * every delta is appended to a buffer that survives until the turn is claimed,
 * so a client that connects late or reconnects mid-turn gets the whole answer
 * so far and then the rest live. Nothing is inferred from what a listener
 * happened to be attached for.
 *
 * ## In-process, deliberately
 *
 * Unlike the work state and the open run — both of which had to move into the
 * database because two processes disagreed about them — a live turn has exactly
 * one writer: the process running the SDK query, which is the same process
 * serving the Atlas. There is no second party to disagree with. When the turn
 * ends, everything worth keeping is already in `graph_runs` and `entity_writes`
 * through the normal path; this buffer is the transient half and dies with it.
 */

export type TurnEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'step'; step: string; refs: string[] }
  /** A plan the agent is handing over for approval. Arrives mid-turn, before
   *  the answer finishes — the buttons appear as soon as it is offered. */
  | { kind: 'proposal'; id: number; summary: string; steps: string[] }
  | { kind: 'done'; text: string; costUsd?: number }
  | { kind: 'error'; message: string };

export interface LiveTurn {
  runId: number;
  prompt: string;
  startedAt: string;
  /** The answer so far. Complete when `status` is not `running`. */
  text: string;
  steps: Array<{ step: string; refs: string[] }>;
  status: 'running' | 'done' | 'error';
  error?: string;
  costUsd?: number;
  /** The plan this turn offered, if it offered one. */
  proposal?: { id: number; summary: string; steps: string[] };
  /** Every entity id the turn has reached for, in order of first touch. This is
   *  the live footprint — the ledger's `touched` is the settled one. */
  reached: string[];
}

/**
 * How many finished turns to keep addressable.
 *
 * Small on purpose. A finished turn's durable record is its run row, and this
 * is only here so a client that reconnects in the second after a turn lands
 * still finds the answer rather than a 404. Anything older is a question for
 * the ledger.
 */
const KEEP = 12;

const turns = new Map<number, LiveTurn>();
const bus = new EventEmitter();
bus.setMaxListeners(64);

function trim(): void {
  const finished = [...turns.values()].filter((t) => t.status !== 'running');
  if (finished.length <= KEEP) return;
  for (const t of finished.slice(0, finished.length - KEEP)) turns.delete(t.runId);
}

export function startTurn(runId: number, prompt: string): LiveTurn {
  const t: LiveTurn = {
    runId,
    prompt,
    startedAt: new Date().toISOString(),
    text: '',
    steps: [],
    status: 'running',
    reached: [],
  };
  turns.set(runId, t);
  trim();
  return t;
}

/**
 * Record an event against a turn AND publish it.
 *
 * Both, always, in one call: a listener that got an event the buffer never saw
 * would show a client something a reconnecting client could never recover, and
 * the two would disagree about the same turn.
 */
export function emitTurn(runId: number, ev: TurnEvent): void {
  const t = turns.get(runId);
  if (!t) return;
  if (ev.kind === 'delta') t.text += ev.text;
  else if (ev.kind === 'step') {
    t.steps.push({ step: ev.step, refs: ev.refs });
    for (const r of ev.refs) if (!t.reached.includes(r)) t.reached.push(r);
  } else if (ev.kind === 'proposal') {
    t.proposal = { id: ev.id, summary: ev.summary, steps: ev.steps };
  } else if (ev.kind === 'done') {
    // The finished text wins over the accumulated deltas. They should be
    // identical and if they ever are not, the one the run row stores is the one
    // the reader must see — two accounts of the same answer is worse than a
    // late correction.
    if (ev.text) t.text = ev.text;
    t.costUsd = ev.costUsd;
    t.status = 'done';
  } else {
    t.status = 'error';
    t.error = ev.message;
  }
  try {
    bus.emit(`turn:${runId}`, ev);
  } catch (e) {
    console.error('[agentTurns] listener threw', e);
  }
  if (ev.kind !== 'delta' && ev.kind !== 'step') trim();
}

export function getTurn(runId: number): LiveTurn | undefined {
  return turns.get(runId);
}

/** The turn currently running, if one is. At most one: the open-run lock
 *  already makes concurrent operator turns impossible. */
export function runningTurn(): LiveTurn | undefined {
  return [...turns.values()].find((t) => t.status === 'running');
}

export function onTurn(runId: number, fn: (ev: TurnEvent) => void): () => void {
  bus.on(`turn:${runId}`, fn);
  return () => bus.off(`turn:${runId}`, fn);
}
