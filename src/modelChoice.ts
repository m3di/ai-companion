/**
 * WHICH MODEL, HOW HARD — resolved per turn, from three places in one order.
 *
 * Until 2026-08-27 a single CLAUDE_MODEL ran the concierge, every worker and
 * the night on the same tier at default effort. The ledger for the week read
 * ~$375: the concierge $206 over 278 turns, workers $129 over 96. Cost is now
 * a choice with a place to be made: the concierge sizes each worker at
 * dispatch (dispatchTask's `model` / `effort`, stored on the thread), the
 * deployment sets the defaults, and the concierge itself keeps CLAUDE_MODEL
 * at a configured effort. This function is the one place that order lives,
 * pure so the cases are pinned rather than remembered.
 */
import type { Effort } from './config.js';

export type WorkerModel = 'haiku' | 'sonnet' | 'opus';

export interface TurnOptions {
  /** An alias ('sonnet') or a full id; undefined = the SDK's own default. */
  model?: string;
  /** undefined = the SDK's default for the model. */
  effort?: Effort;
}

export interface TurnChoiceInput {
  isControl: boolean;
  /** What the thread stored at dispatch (null/undefined = not chosen). */
  thread?: { model?: string; effort?: string };
  config: {
    model?: string;
    conciergeEffort: Effort;
    workerModel: string;
    workerEffort: Effort;
  };
}

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function asEffort(v: string | undefined): Effort | undefined {
  return v && EFFORTS.has(v) ? (v as Effort) : undefined;
}

/**
 * Control slot → CLAUDE_MODEL at the concierge's configured effort. A worker →
 * what its thread stored, else the deployment's worker defaults. A stored
 * value the config does not know (an effort typo, say) falls back rather than
 * reaching the SDK, so a bad row costs a default, never a refused turn.
 */
export function turnOptions(i: TurnChoiceInput): TurnOptions {
  if (i.isControl) {
    return { model: i.config.model, effort: asEffort(i.config.conciergeEffort) };
  }
  return {
    model: i.thread?.model || i.config.workerModel || i.config.model,
    effort: asEffort(i.thread?.effort) ?? asEffort(i.config.workerEffort),
  };
}

/**
 * The BUILT-IN tools a turn may use — the SDK's `tools` option, which is the
 * availability filter (`allowedTools` only pre-approves). MCP tools are not
 * governed by it: they come from the servers regardless. The concierge gets
 * exactly the configured list (default none); a worker keeps the SDK's own
 * default set, so `undefined` = do not restrict.
 */
export function builtinToolsFor(isControl: boolean, config: { conciergeBuiltinTools: string[] }): string[] | undefined {
  return isControl ? [...config.conciergeBuiltinTools] : undefined;
}
