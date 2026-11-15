import { anyOpenRun, beginGraphRun, endGraphRun, openRunId, recentGraphRuns, runReads, runWrites, setOpenRun, type GraphRunRow } from './db.js';
import { pulse } from './pulse.js';

/**
 * A RUN — one attempt by an agent to change the graph, with a stated intent.
 *
 * `entity_writes` already records what changed and why, one row per change.
 * What it cannot record is which ATTEMPT a change belonged to, and that turns
 * out to be the thing worth seeing. Nine writes are nine rows you can review
 * one at a time; *"this prompt, in linter mode, produced those nine and touched
 * these six nodes"* is a judgement about the PROMPT. Without it you can audit a
 * graph forever and never improve the thing that edits it.
 *
 * So the unit of review is the run, not the write. That is what makes the loop
 * closeable: read the run, see what the instruction actually produced, reword
 * the instruction, run it again against the same findings.
 *
 * ## The ambient current run
 *
 * `applyWrite` stamps whatever run is open, rather than every caller threading
 * an id through. That is safe here for a specific reason and not in general:
 * `applyWrite` is fully synchronous and JS is single-threaded, so a run cannot
 * interleave with another inside one process. If a write ever becomes async,
 * this becomes a bug and the id has to be passed explicitly.
 */

/**
 * The open run lives in the DATABASE, not a variable.
 *
 * It started as a module-level `let` and attributed nothing: a run is opened by
 * one command and the writes are made by another — a module call, an agent, a
 * second terminal — so every write landed with a null run_id while the ledger
 * insisted an attempt was in progress. Confidently wrong attribution is worse
 * than none. Same shape as the pulse bus and the work state; in this system the
 * interesting boundary is almost always BETWEEN processes.
 */
export function currentRunId(actor?: string): number | undefined {
  return openRunId(actor);
}

export interface RunSpec {
  kind: 'gardener' | 'nightly' | 'day' | 'manual';
  /**
   * WHOSE attempt this is — the session key whose calls belong to it.
   *
   * Without an owner the open run collects strangers: run #7 was opened from
   * the Atlas and left open, and every module call in the process afterwards,
   * including the Atlas reading the graph as someone clicked around it, was
   * recorded as part of that attempt.
   */
  actor: string;
  /** What started it: a human asked, a lint finding did, or the clock did. */
  trigger: 'prompt' | 'linter' | 'schedule';
  /** The instruction, verbatim — the row's whole reason to exist. */
  prompt: string;
  /** Lint codes aimed at, when a linter drove it. */
  codes?: string[];
}

/**
 * Open a run, do the work, close it — even if the work threw.
 *
 * A run left open would swallow every later write in the process into an
 * attempt that already finished, which is worse than not tracking runs at all:
 * the attribution would be confidently wrong.
 */
export async function withRun<T>(spec: RunSpec, fn: (runId: number) => Promise<T> | T): Promise<{ runId: number; result: T }> {
  const runId = openRun(spec);
  try {
    const result = await fn(runId);
    return { runId, result };
  } finally {
    setOpenRun(null);
  }
}

/**
 * Open a run that OUTLIVES this call — for work a callback cannot span.
 *
 * A gardening run is often a person reading a screen and deciding, which no
 * `try/finally` can wrap. So the run stays current until `finishRun` closes it,
 * and the cost is real: an abandoned run keeps attributing later writes to an
 * attempt that is over. `runStatus()` exists so that is visible rather than
 * discovered later in the ledger.
 */
export function openRun(spec: RunSpec): number {
  const already = anyOpenRun();
  if (already) {
    throw new Error(
      `run #${already.id} (${already.actor}) is already open — runs do not nest, because a write belongs to exactly one attempt. Close it first.`,
    );
  }
  const runId = beginGraphRun(spec.kind, spec.trigger, spec.prompt, spec.codes ?? [], spec.actor);
  setOpenRun(runId);
  pulse('operator', `run #${runId} — ${spec.kind}/${spec.trigger}: ${spec.prompt.slice(0, 90)}`, { loud: true });
  return runId;
}

/** Whether a run is open, for anything that needs to warn about an abandoned one. */
export function runStatus(): { open: boolean; runId?: number; actor?: string } {
  const r = anyOpenRun();
  return r ? { open: true, runId: r.id, actor: r.actor } : { open: false };
}

/** Close a run with the agent's own account of what it did AND refused to do. */
export function finishRun(runId: number, outcome: string): void {
  endGraphRun(runId, outcome);
  if (anyOpenRun()?.id === runId) setOpenRun(null);
  const touched = runWrites(runId);
  pulse('operator', `run #${runId} finished — ${touched.length} write(s)`, {
    // Every node the run touched, so the Atlas can light the whole attempt at
    // once rather than replaying it write by write.
    refs: [...new Set(touched.map((w) => w.entity_id))],
    loud: touched.length > 0,
  });
}

export interface RunView extends GraphRunRow {
  writes: Array<{ id: number; op: string; entity_id: string; reason: string }>;
  /** Everything the run reached for — READ and written. The footprint. */
  touched: string[];
  /** Read but not changed: the reasoning, as distinct from the result. */
  read: string[];
}

/** Runs newest first, each with what it actually did — the review surface. */
export function recentRuns(limit = 20): RunView[] {
  return recentGraphRuns(limit).map((r) => {
    const writes = runWrites(r.id);
    const written = new Set(writes.map((w) => w.entity_id));
    const read = runReads(r.id).filter((id) => !written.has(id));
    return { ...r, writes, read, touched: [...written, ...read] };
  });
}
