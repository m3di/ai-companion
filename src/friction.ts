import { sep } from 'node:path';
import { config } from './config.js';
import {
  type FrictionInput,
  logToolCall,
  noteRetrievalBypass,
  noteRetrievalStep,
  noteRetrievalTreeStep,
  noteStoryRead,
  recordFriction,
} from './db.js';
import { pulse } from './pulse.js';
import { storyIdFor } from './storyTree.js';

/**
 * FRICTION DETECTION (round 9, docs/history/plans/round-9-modules.md §4).
 *
 * "No interaction == no improvement. No friction == the code is good, the logic
 * is solid." (Mehdi, 2026-07-28)
 *
 * The memory layer is becoming an API the day CALLS and the night MAINTAINS, and
 * the night only knows what to build if something tells it where the API fell
 * short. The obvious way to get that is to ask the agent. Round 8 spent four
 * separate lessons proving why that fails: every rule stated as an instruction
 * decayed or was wrong, and every rule made mechanical held. An agent that needs
 * something the API cannot give does not file a complaint — it reads the raw
 * file and moves on, because that is the shortest path to finishing its actual
 * task, and it is right to do so.
 *
 * So the shortcut IS the complaint. This module watches for it.
 *
 * Reading raw stays ALLOWED, deliberately. A missing function must never leave
 * an agent stuck; it should just leave a trace.
 */

const KNOWLEDGE = config.knowledgeDir;
/** How the tree is spelled when a path is written relative to the repo root. */
const REL = 'data/knowledge/';

/** Does this string name something inside the knowledge tree? */
function knowledgePath(s: string): string | undefined {
  if (!s) return undefined;
  const i = s.indexOf(REL);
  if (i >= 0) return s.slice(i + REL.length);
  if (s === KNOWLEDGE) return '';
  if (s.startsWith(KNOWLEDGE + sep)) return s.slice(KNOWLEDGE.length + 1);
  return undefined;
}

/** Strip a knowledge-relative path to the unit that would own the function:
 *  the domain, plus which of its files was opened. */
function target(rel: string): string {
  if (!rel) return 'tree';
  const parts = rel.split('/').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? 'tree';
  return `${parts[0]}/${parts.at(-1)}`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The graph function this tool call reached for, if it reached for one.
 *
 * Named by FUNCTION and not by tool, because the path is what M9 groups on and
 * "callModule → callModule → callModule" says nothing at all. An `evalInModule`
 * composes several, so it contributes the set it touched — the same
 * coalescing `module_use.shape` already does, for the same reason: composition
 * identifies a use far better than wording does.
 */
export function graphStepOf(toolName: string, input: Record<string, unknown>): string | undefined {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name === 'callModule') {
    const mod = str(input.module) || 'entities';
    const fn = str(input.fn);
    return fn ? `${mod === 'entities' ? '' : `${mod}.`}${fn}` : undefined;
  }
  if (name === 'evalInModule') {
    const hits = [...new Set((str(input.expression) || str(input.expr)).match(/\bm\.([a-zA-Z_]\w*)/g) ?? [])]
      .map((h) => h.slice(2))
      .sort();
    return hits.length ? hits.join('+') : 'eval';
  }
  return undefined;
}

/**
 * The TREE surface this call used, if it used one.
 *
 * Reading the md tree through `readNote` is neither a graph reach nor a
 * bypass — it is the legitimate prose API, and the episode log counted it as
 * neither, so a turn answered entirely from the tree scored `no-reach` and
 * looked exactly like a turn that consulted no memory at all. Over the first
 * real day that hid twelve `readNote` calls inside eighty-four "never asked"
 * rows.
 *
 * The distinction is the whole of M5: how much of the day's memory use is
 * prose, and how much is the graph. A single number that cannot separate them
 * cannot say whether convergence is happening.
 */
export function treeStepOf(toolName: string): string | undefined {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  return ['readNote', 'recallNotes', 'digestSource', 'readFocus'].includes(name) ? name : undefined;
}

/**
 * The story node a `readStory` call opened, as the refs of a GRAPH step.
 *
 * A story is a render of the graph, so reading one is a graph reach, not a
 * tree read — it scores the episode `answered`, and its ref is the story-node
 * id (`domain:<scope>`). A scope that resolves to no written story is not a
 * step at all: a refused read reached nothing, and an episode that scored it
 * would call a typo an answer.
 */
export function storyStepOf(toolName: string, input: Record<string, unknown>): string[] | undefined {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name !== 'readStory') return undefined;
  const id = storyIdFor(str(input.scope));
  return id ? [id] : undefined;
}

/**
 * Classify one tool call as a bypass, or not.
 *
 * Pure and total — it takes what dispatch already sees and returns a row to
 * write, so the detection rule is testable without a running session.
 */
export function bypassOf(toolName: string, input: Record<string, unknown>): FrictionInput | undefined {
  const name = toolName.replace(/^mcp__[^_]+__/, '');

  if (name === 'Read' || name === 'NotebookRead') {
    const rel = knowledgePath(str(input.file_path) || str(input.path) || str(input.notebook_path));
    if (rel === undefined) return undefined;
    return { kind: 'bypass', module: 'entities', fn: '', signature: `read:${target(rel)}`, detail: `Read ${rel || 'the whole tree'}` };
  }

  if (name === 'Grep' || name === 'Glob') {
    // A search under the tree is the highest-value signal in here: it names a
    // QUESTION the API could not answer, in the agent's own words.
    const rel = knowledgePath(str(input.path));
    if (rel === undefined) return undefined;
    const pattern = str(input.pattern) || str(input.glob);
    return {
      kind: 'bypass',
      module: 'entities',
      fn: '',
      signature: `search:${target(rel)}`,
      detail: `${name} ${JSON.stringify(pattern)} in ${rel || 'the whole tree'}`,
    };
  }

  if (name === 'Bash') {
    const cmd = str(input.command);
    // Every token, because a knowledge path can sit anywhere in a pipeline.
    const hit = cmd.split(/\s+/).map((t) => knowledgePath(t.replace(/^["']|["'],?$/g, ''))).find((r) => r !== undefined);
    if (hit === undefined) return undefined;
    return { kind: 'bypass', module: 'entities', fn: '', signature: `shell:${target(hit)}`, detail: cmd.slice(0, 300) };
  }

  return undefined;
}


/**
 * A short, comparable name for what a tool was pointed AT.
 *
 * Deliberately field-driven rather than a JSON dump: the value of this column is
 * that two calls through the same door look the same, so `readNote` on one key
 * and `readNote` on another are one door and two targets. A serialized payload
 * would be neither readable nor groupable, and would quietly become a second
 * copy of everything the tools were handed.
 */
function toolTarget(input: Record<string, unknown>): string {
  const i = input ?? {};
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  };
  if (typeof i.module === 'string' && typeof i.fn === 'string') return `${i.module}.${i.fn}`;
  return (
    first('key', 'scope', 'file_path', 'path', 'notebook_path', 'term', 'query', 'pattern', 'expression', 'id', 'ref', 'title', 'command') ??
    ''
  );
}

/**
 * Note one tool call. Called from the dispatch loop, which already sees every
 * tool a day session uses — no new plumbing, and nothing an agent can forget.
 */
export function noteToolCall(sessionKey: string, toolName: string, input: Record<string, unknown>): void {
  // ...and the same stream is now PERSISTED, because the pulse ring is lossy and
  // the picture below is the one that explains an empty API ledger. See
  // logToolCall: on 2026-08-05 reconstructing it took hand-reading a day's
  // conversation, and that is not a thing the next question should cost.
  logToolCall(sessionKey, toolName, toolTarget(input));
  // THE RETRIEVAL EPISODE (M4), recorded at the one seam that already sees
  // every tool a session uses. Threading this through the module layer instead
  // would have missed the half that matters: a bypass is not a module call, and
  // an episode that records only the successful reaches cannot tell a question
  // the graph answered from one it drove someone to the filesystem.
  const step = graphStepOf(toolName, input);
  const story = storyStepOf(toolName, input);
  if (step) noteRetrievalStep(sessionKey, step);
  else if (story) {
    // The door, counted apart from entity follows: opening a story the block
    // pointed at is the round's cheapest claim, and it must not be able to
    // hide the absence of the spontaneous kind.
    noteStoryRead(sessionKey);
    noteRetrievalStep(sessionKey, 'readStory', 0, story);
  } else {
    const tree = treeStepOf(toolName);
    if (tree) noteRetrievalTreeStep(sessionKey, tree);
  }
  // Every tool call is a pulse; only some are friction. The Atlas wants the
  // whole stream — a turn that reads six files and calls nothing is exactly the
  // picture that explains why the API ledger is empty.
  pulse('tool', `${sessionKey}: ${toolName.replace(/^mcp__[^_]+__/, '')}`, {
    domains: knowledgeDomains(input),
    meta: { sessionKey, tool: toolName },
  });
  const f = bypassOf(toolName, input);
  if (f) {
    noteRetrievalBypass(sessionKey);
    recordFriction({ ...f, sessionKey });
    pulse('friction', `bypass — ${f.detail ?? f.signature}`, {
      loud: true,
      domains: knowledgeDomains(input),
      meta: { sessionKey, signature: f.signature },
    });
  }
}

/** Which knowledge domains a tool's input mentions, for lighting the hulls. */
function knowledgeDomains(input: Record<string, unknown>): string[] | undefined {
  const blob = JSON.stringify(input ?? {});
  const found = new Set<string>();
  for (const m of blob.matchAll(/data\/knowledge\/([a-z0-9-]+)/gi)) found.add(m[1]!);
  return found.size ? [...found] : undefined;
}

/**
 * An agent asked the memory for something by name and it was not there.
 *
 * This is `empty` friction on the API that exists TODAY, and it costs nothing to
 * collect: a `readNote("work/core-api/import-pipeline")` that misses is an agent
 * stating, precisely and unprompted, what it expected the tree to contain. The
 * rolling detail list turns into a wish list nobody had to be asked for.
 */
export function noteMiss(module: string, fn: string, asked: string, sessionKey?: string): void {
  recordFriction({ kind: 'empty', module, fn, signature: `${module}.${fn}:miss`, detail: asked.slice(0, 200), sessionKey });
}

/**
 * Reduce an expression to a comparable form: literals become `_`, whitespace
 * collapses.
 *
 * Two agents asking the same question a week apart will not phrase it
 * identically, but they will spell the SHAPE the same way —
 * `m.openLoops(_).filter(...)` — and it is the shape that says what function is
 * missing. Scoping a query to "core-api" rather than "paperwork" is not a
 * different question.
 */
export function normalizeExpression(expr: string): string {
  return expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '_')
    .replace(/\b\d+(\.\d+)?\b/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Which of a module's functions an expression reached for.
 *
 * This is the dedup key for composition, and it coalesces far better than the
 * wording does: `find+openLoops` composed six different ways, six times, is one
 * missing function stated six ways — which is exactly the signal that a
 * hand-rolled answer should have been an API call.
 */
export function touchedFunctions(expr: string, known: string[]): string[] {
  const used = new Set<string>();
  for (const m of expr.matchAll(/\bm\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const name = m[1]!;
    if (known.includes(name)) used.add(name);
  }
  return [...used].sort();
}

/** Record a module call that failed, returned nothing, or ran long. Used by the
 *  module runtime once it exists; here so the vocabulary has one home. */
/**
 * Callers whose EMPTY answers are not friction.
 *
 * The ledger exists to catch "someone reached for memory and memory failed
 * them". That requires someone who wanted an answer. The Atlas is a renderer:
 * it calls `blockers` and `stats` on every node it draws, and most nodes have
 * no blockers, so "nothing" is the correct answer and it produced 252 of the
 * ledger's 303 empty rows — drowning the handful that mean something. Over a
 * week unattended that is thousands.
 *
 * ERRORS from any caller still count. A renderer that crashes is a real fault;
 * a renderer that finds nothing is a Tuesday.
 */
const QUIET_ON_EMPTY = new Set(['atlas']);

export function noteCallFriction(
  kind: Extract<FrictionInput['kind'], 'error' | 'empty' | 'slow' | 'unknown_fn'>,
  module: string,
  fn: string,
  detail: string,
  sessionKey?: string,
): void {
  if (kind === 'empty' && sessionKey && QUIET_ON_EMPTY.has(sessionKey)) return;
  recordFriction({ kind, module, fn, signature: `${module}.${fn}`, detail, sessionKey });
}
