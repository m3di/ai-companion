import { plan, renderPlan } from './gardener.js';
import { lintGraph } from './graphLint.js';
import { runWrites } from './db.js';
import { finishRun, openRun } from './runs.js';

/**
 * A GARDENING RUN — the unit an operator reviews and a prompt is judged on.
 *
 * Two ways in, and the difference is only where the intent comes from:
 *
 *   LINTER  — the findings choose the work. "Fix what is worst, up to N."
 *   PROMPT  — a human chooses it. "Split the facts on core-api/ci-robustness-38."
 *
 * Both open a run, so both produce the same reviewable object: an instruction,
 * the writes it caused, and the nodes it touched. That symmetry is the point —
 * you cannot compare a hand-written instruction against an automatic one if
 * only one of them is recorded.
 *
 * ## What this module does NOT do
 *
 * It does not call a model. The agent is whoever holds the prompt — the night
 * through `gardenPlan`, or a person at a terminal reading the packets. This
 * assembles the brief, opens the run so the writes are attributed, and closes
 * it with the outcome. Keeping the model out means a run is reproducible and
 * the same brief can be shown to a person and an agent unchanged.
 */

export interface RunBrief {
  runId: number;
  /** What to hand the agent: the instruction plus the prepared packets. */
  brief: string;
  /** Lint codes in scope, for the record. */
  codes: string[];
  rotBefore: number;
}

/**
 * Open a gardening run and build its brief.
 *
 * The caller does the work (or hands the brief to an agent), then calls
 * `closeGardenRun`. Split rather than wrapped because the work in between is
 * sometimes a person reading a screen, and a callback cannot span that.
 */
export async function openGardenRun(opts: {
  trigger: 'prompt' | 'linter';
  /** The instruction. For a linter run this is generated; for a prompt run it
   *  is the operator's own words, kept verbatim. */
  prompt: string;
  limit?: number;
  /** Whose calls belong to this run. Defaults to a human at a terminal. */
  actor?: string;
}): Promise<RunBrief> {
  const report = lintGraph();
  const p = plan(opts.limit ?? 8);
  const codes = [...new Set(p.packets.map((k) => k.code))];

  const instruction =
    opts.trigger === 'linter'
      ? `${opts.prompt}\n\nWork the packets below. Do the ones the evidence settles; SKIP the rest.`
      : opts.prompt;

  // openRun, not withRun: the work between here and `closeGardenRun` is often a
  // person reading a screen, which no callback can span.
  const runId = openRun({ kind: 'gardener', trigger: opts.trigger, prompt: opts.prompt, codes, actor: opts.actor ?? 'operator' });

  return {
    runId,
    codes,
    rotBefore: report.rot,
    brief: [
      `GARDENING RUN #${runId} — ${opts.trigger}`,
      '',
      instruction,
      '',
      // The rules a gardening agent works under. Stated here rather than in a
      // system prompt because they are about THIS task, and a rule that only
      // applies sometimes belongs with the sometimes.
      'HOW TO WORK:',
      '- Every change goes through record(). Never edit a file.',
      '- One write, one reason, and the reason says what you SAW — not what you did.',
      '- SKIP anything the evidence does not settle. Skipping is the expected',
      '  outcome for most packets; an unsure fix is worse than an untouched node.',
      '- Do not mint to tidy. A new node needs a demand, not a gap (I5).',
      '- When you finish, say what you changed AND what you skipped and why.',
      '',
      renderPlan(p),
    ].join('\n'),
  };
}

export interface RunResult {
  runId: number;
  rotBefore: number;
  rotAfter: number;
  writes: number;
  touched: string[];
}

/** Close the run, and measure what it was worth. */
export function closeGardenRun(runId: number, rotBefore: number, outcome: string): RunResult {
  finishRun(runId, outcome);
  const writes = runWrites(runId);
  // rot is the number a run is judged on. A gardening pass that does not move
  // it did work nobody asked for — worth seeing, not hiding.
  return {
    runId,
    rotBefore,
    rotAfter: lintGraph().rot,
    writes: writes.length,
    touched: [...new Set(writes.map((w) => w.entity_id))],
  };
}
