import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { askClaude } from './claude.js';
import { config } from './config.js';
import { addProposal, clearSession, getSessionId, setSessionId } from './db.js';
import { lintGraph } from './graphLint.js';
import { allowed, refusal } from './mode.js';
import { buildModuleTools, catalogSection, MODULE_TOOL_NAMES } from './moduleTools.js';
import { pulse } from './pulse.js';
import { emitTurn, startTurn } from './agentTurns.js';
import { finishRun, openRun, runStatus } from './runs.js';
import { renderVitals, vitals } from './vitals.js';

/**
 * THE DEBUG AGENT — the operator's hands on the graph.
 *
 * Until now a "run" was bookkeeping and nothing else: `openGardenRun` recorded
 * an intent, printed a brief, and left. Asking it *"what would it cost to
 * rename core-api/monolith?"* opened a run that changed nothing and answered
 * nothing, because there was no one on the other end. This is the one who
 * answers.
 *
 * ## A conversation, not a command
 *
 * The first design was a fresh session per prompt, briefed each time. That is
 * wrong for the work: an operator asks what something costs, reads the answer,
 * asks a follow-up, then says *do it* — and each of those depends on the last.
 * So the session PERSISTS and is resumed, exactly like the concierge's. The
 * brief is paid once; every prompt after it is cheap and in context.
 *
 * `reset()` is the escape hatch when a session has wandered or grown expensive.
 *
 * ## Answering is a complete outcome
 *
 * Most operator prompts are questions, and the agent is told plainly that
 * answering one and writing nothing is a finished job. A gardener that feels
 * obliged to change something in order to have done something is exactly the
 * failure the whole linter/packet design has been avoiding, one layer up.
 *
 * ## Every write belongs to a run
 *
 * A run is opened around the turn, so anything the agent records is attributed
 * and revertible as one attempt — which is what makes it safe to let it write
 * at all. If the turn writes nothing, the run stands as a record that the
 * question was asked and answered.
 *
 * ## Watched, not awaited
 *
 * The turn streams: every tool call and every fragment of the answer is
 * published to `agentTurns` as it happens, and the run id is handed back
 * through `onOpen` before the first token so a watcher can subscribe to a turn
 * that has only just begun. The caller still gets the finished turn when it
 * lands — the stream is an addition, not a replacement, and the durable record
 * is still the run row.
 */

const AGENT = 'debug-agent';
const KEY = () => `${[...config.allowedChatIds][0] ?? 0}:debug-agent`;

const SYSTEM = `You are the OPERATOR'S AGENT, working on a live knowledge graph while the bot is sedated in debug mode.

The operator is Mehdi. He is at a terminal or the Atlas, doing open-brain surgery on his own memory system: the day is suspended, nothing else is writing, and the tree is snapshotted so anything you do can be discarded wholesale.

READ-ONLY vs WRITING — CHECK THE LINE AT THE TOP OF EVERY PROMPT
- Each prompt is prefixed with the machine's state. READ-ONLY means the bot is LIVE and answering the day; you may read everything and write NOTHING. The write path will refuse you, so do not try it to find out.
- Read-only is the NORMAL state, not a degraded one. Almost every operator question is a question, and answering it is the whole job.
- When read-only and you have concluded a change is needed, call propose() with it and stop. The operator gets a button that sedates the bot and applies it. Do NOT ask them to go and enable something; the button does that.
- Never say you have changed something when you have not.

WHAT YOU ARE FOR
- Answer questions about the graph. Most prompts ARE questions. Answering one and writing nothing is a COMPLETE job — say what you found and stop.
- When asked what a change would cost, go and look: read the node, its neighbours, what points at it, and say concretely what would move. Do not change anything to find out.
- Apply changes when, and only when, the operator asks for them.

HOW YOU WORK
- Read through the knowledge API. It is a real API — find, neighbours, trace, search, graph, blockers, stats.
- Write ONLY through record(). Never edit a file. Every write needs a reason that says what you SAW.
- One change per record() call. A rename is a \`move\`; a wrong relation is drop-edge then edge.
- If the evidence does not settle something, SAY SO rather than guessing. "I don't know, here is what would tell us" is a good answer.
- Be specific and short. The operator is reading this next to the graph.

PROPOSING, RATHER THAN ASKING
- When you have worked out what you WOULD do and it is not yet approved, end the turn by calling propose() — a one-line summary and the concrete steps. Do not end with "want me to do it?" in prose: the operator approves by clicking, and a question in text is a question they have to answer by typing.
- propose() is for a plan you are ready to carry out. A question you genuinely cannot answer without the operator ("which of these two did you mean?") is still a question — ask it plainly.
- When a turn arrives saying a proposal is APPROVED, carry it out. It was your own plan one message ago; do not re-derive it, and do not re-ask.
- One proposal per turn. Two plans in one approval is one thing the operator cannot say no to half of.

WHAT YOU MUST NOT DO
- Do not mint nodes to tidy the graph. A new node needs a demand, not a gap.
- Do not fix things you were not asked about. If you notice something, mention it; do not act on it.
- Do not touch state, state_at or status. The prober owns those.`;

/**
 * The one tool this agent has beyond the knowledge API: a way to end a turn
 * with a plan instead of a question.
 *
 * It writes nothing to the graph. That is the whole point — the proposal is the
 * gap between working something out and doing it, and the gap is where the
 * operator lives. Applying is a separate turn, through `record()` like anything
 * else, so an approved plan is still journalled, attributed and revertible one
 * write at a time.
 */
function proposeTool(runId: number) {
  return tool(
    'propose',
    'Offer a plan for the operator to approve with one click. Call this INSTEAD of ending your turn with "shall I do it?" — you have worked out what to do, and this is how you hand it over. Writes nothing; you carry it out in a later turn if it is approved.',
    {
      summary: z.string().describe('One line: what you would do. This is what the operator reads on the button.'),
      steps: z
        .array(z.string())
        .describe('The concrete steps, one per line — the write you would make and to what. Enough that the operator can judge it without re-reading your whole answer.'),
    },
    async ({ summary, steps }) => {
      const id = addProposal(runId, summary, steps);
      emitTurn(runId, { kind: 'proposal', id, summary, steps });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Proposal #${id} is waiting for the operator. Stop here — say nothing further about whether to do it; the answer arrives as a new turn.`,
          },
        ],
      };
    },
  );
}

/** `domain/name` — the graph's address shape, and what lights a node. */
const ENTITY_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/i;

/**
 * Every string and number anywhere in a tool's input, in order.
 *
 * Flat `Object.values` was not enough and the failure was invisible: the
 * knowledge API is reached through `callModule('entities', 'find', [id])`, so
 * the entity id lives two levels down inside an array. The step rendered as
 * `callModule(entities, find)` — the one word that mattered missing — and, far
 * worse, the ref list came back empty, so a turn that read six nodes lit none
 * of them. The feature looked implemented and did nothing.
 */
function flatten(v: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (Array.isArray(v)) return v.flatMap((x) => flatten(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).flatMap((x) => flatten(x, depth + 1));
  return [];
}

/** `mcp__bot__callModule` is thirteen characters of plumbing in front of the
 *  two words that say what happened. */
function short(name: string): string {
  return name.replace(/^mcp__[a-z0-9_]+__/i, '');
}

export interface AgentTurn {
  runId: number;
  /** The agent's answer, in its own words. */
  text: string;
  /** Tool calls made, for the transcript. */
  steps: string[];
  costUsd?: number;
}

/** A fresh brief: what state the machine is in, and what the graph looks like. */
function brief(): string {
  const l = lintGraph();
  const worst = l.byCode
    .filter((c) => c.n > 0 && c.severity !== 'blue')
    .sort((a, b) => b.n - a.n)
    .map((c) => `${c.code}×${c.n} — ${c.what}`)
    .join('\n');
  return [
    renderVitals(vitals()),
    '',
    '## The graph linter, right now',
    // The raw lint, not a summary: the operator prompts off this, so what he
    // sees and what the agent sees have to be the same text.
    worst || '(nothing above blue)',
    '',
    '## The knowledge API you read and write through',
    catalogSection(),
  ].join('\n');
}

/**
 * One operator turn. Resumes the session if there is one, briefs it if not.
 *
 * Runs in BOTH live and debug, and the difference is whether it may write.
 *
 * It used to require debug outright, which meant that asking the machine a
 * question about its own memory cost you the whole day: turns, workers,
 * probes and the nightly, all suspended, to read a node. Reading is free and
 * always was; what debug actually buys is the right to CHANGE memory under a
 * concierge whose context was built on the old version. So `operator-turn` is
 * allowed while live and `operator-write` is not, and the write path enforces
 * it rather than the prompt — a rule a model is asked to follow is a
 * suggestion.
 */
export async function ask(prompt: string, onOpen?: (runId: number) => void): Promise<AgentTurn> {
  // `allowed`, not a mode comparison: the two ways this is refused are
  // different and the operator needs to be told which one. Live means "sedate
  // it first"; DREAMING means "wait" — the night is rewriting the memory this
  // agent would be reading, and no amount of entering debug will help.
  if (!allowed('operator-turn')) throw new Error(refusal('operator-turn'));
  // Asked ONCE for the prompt's banner and re-asked per tool call, because a
  // turn can outlive the state it began in.
  const readOnly = !allowed('operator-write');
  const stuck = runStatus();
  if (stuck.open) {
    throw new Error(
      `run #${stuck.runId} (${stuck.actor || 'unowned'}) is still open — close it first: npx tsx src/gardenRunCli.ts close ${stuck.runId} "<what it did>"`,
    );
  }

  const key = KEY();
  const resume = getSessionId(key);
  // The agent's module calls carry this same key, which is what binds its
  // reads and writes to the run and nobody else's.
  const runId = openRun({ kind: 'gardener', trigger: 'prompt', prompt, codes: [], actor: AGENT });
  // The buffer exists BEFORE the first token, so a client that subscribes the
  // instant it learns the run id cannot miss the opening of the answer.
  startTurn(runId, prompt);
  onOpen?.(runId);

  const steps: string[] = [];
  let text = '';
  let costUsd: number | undefined;
  const abortController = new AbortController();
  inFlight = abortController;

  try {
    for await (const ev of askClaude({
      // The brief is paid ONCE, in the session's first turn — in the PROMPT,
      // because a custom system prompt has no append (askClaude refuses one;
      // until 2026-08-28 it was passed as appendContext and silently dropped,
      // so this agent never saw its brief). Re-sending it every prompt would
      // put a moving block of counts in front of the whole conversation (I12).
      prompt: [
        resume ? undefined : brief(),
        `[${readOnly ? 'READ-ONLY — the bot is LIVE; you may read everything and write nothing' : 'DEBUG — the bot is sedated; writes are allowed and revertible'}]\n\n${prompt}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      resume,
      concierge: {
        systemPrompt: SYSTEM,
        allowedTools: [...MODULE_TOOL_NAMES, 'mcp__bot__propose'],
      },
      // The operator is watching this one happen, which is the entire reason
      // this agent exists on a page rather than in a terminal.
      stream: true,
      abortController,
      // `buildModuleTools` returns an ARRAY of tools, and the allowlist names
      // them `mcp__bot__*` — so they have to be wrapped in a server called
      // `bot`. Passing the bare array under another name registered nothing:
      // the allowlist then pointed at tools that did not exist, the SDK fell
      // back to its defaults, and the agent spent 26 Bash calls and $1.08
      // reverse-engineering how to reach an API it was supposed to have been
      // handed. A wrong tool wiring does not fail loudly; it degrades into a
      // shell.
      mcpServers: {
        bot: createSdkMcpServer({
          name: 'bot',
          version: '1.0.0',
          instructions: 'The knowledge API: read the graph, and write it through record().',
          // The guard is a FUNCTION, so it is re-evaluated per call: sedating
          // the bot mid-turn grants the write immediately, and waking it
          // withdraws it.
          tools: [...buildModuleTools(AGENT, () => !allowed('operator-write')), proposeTool(runId)],
        }) as never,
      },
      permissionMode: 'bypassPermissions',
    })) {
      if (ev.kind === 'session') setSessionId(key, ev.sessionId);
      else if (ev.kind === 'delta') emitTurn(runId, { kind: 'delta', text: ev.text });
      else if (ev.kind === 'tool') {
        // The ARGUMENTS are the interesting half — "find" says nothing,
        // "find(core-api/system)" is the step the operator is watching for.
        const scalars = flatten(ev.input);
        const s = `${short(ev.name)}(${scalars.join(', ').slice(0, 90)})`;
        steps.push(s);
        // Any entity id in the arguments lights on the Atlas as the agent
        // reaches for it — the live half of "visualise tool use on the graph".
        const refs = scalars.filter((v) => ENTITY_ID.test(v));
        pulse('tool', `debug-agent: ${s}`.slice(0, 200), { refs });
        emitTurn(runId, { kind: 'step', step: s, refs });
      } else if (ev.kind === 'text') text += ev.text;
      else if (ev.kind === 'result') costUsd = ev.usage?.costUsd;
    }
    emitTurn(runId, { kind: 'done', text, costUsd });
  } catch (e) {
    // The turn is over for the watcher either way. Without this a failed query
    // leaves a panel spinning on a turn that ended thirty seconds ago.
    emitTurn(runId, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    if (inFlight === abortController) inFlight = null;
    // finishRun, not endGraphRun: it also CLEARS the open-run row. Ending the
    // record without clearing it leaves the run open in the database, which
    // blocks the next turn and keeps attributing later writes to a turn that
    // has finished.
    finishRun(runId, text.slice(0, 4000) || '(no answer — see the steps)');
  }

  return { runId, text, steps, costUsd };
}

/**
 * Stop the turn in flight.
 *
 * Watching a turn makes stopping it necessary rather than merely nice: the
 * whole value of seeing an agent reach for the wrong node on step two is being
 * able to say so before step nine. The abort tears down the SDK query, the
 * generator throws, and the existing `finally` closes the run — so an
 * interrupted turn lands in the ledger like any other, with whatever it had
 * written by then still attributed to it.
 */
export function interruptTurn(): boolean {
  if (!inFlight) return false;
  inFlight.abort();
  inFlight = null;
  return true;
}

/** The abort handle for the turn currently running, if any. At most one: the
 *  open-run lock already makes two operator turns impossible. */
let inFlight: AbortController | null = null;

/** Start over: the next prompt pays for a fresh brief. */
export function reset(): void {
  clearSession(KEY());
}
