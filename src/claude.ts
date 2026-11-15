import { readFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, type PermissionMode } from './config.js';
import { stripLoneSurrogates } from './format.js';

/** Per-turn usage/cost, distilled from the SDK's result message. */
export interface TurnUsage {
  /** Model(s) used this turn (comma-joined; usually one). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  /** The primary model's context-window size (max), for reference. */
  contextWindow: number;
  /** Exact live context after the turn (SDK getContextUsage); absent when it could not be read. */
  contextTokens?: number;
  contextMax?: number;
}

// How long a turn will wait for the SDK's context report before giving up and
// storing nothing. The rotation rule falls back to an estimate; a turn that
// hangs on a control request would be the worse trade.
const CONTEXT_USAGE_MS = 1500;

/** The SDK's exact context total for a live query, or undefined — never a throw, never a wait past the cap. */
async function contextUsageOf(q: unknown): Promise<{ totalTokens: number; maxTokens: number } | undefined> {
  const fn = (q as { getContextUsage?: () => Promise<{ totalTokens: number; maxTokens: number }> })?.getContextUsage;
  if (typeof fn !== 'function') return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((res) => {
      timer = setTimeout(() => res(undefined), CONTEXT_USAGE_MS);
      timer.unref?.();
    });
    const r = await Promise.race([fn.call(q), timeout]);
    if (!r || !Number.isFinite(r.totalTokens)) return undefined;
    return { totalTokens: r.totalTokens, maxTokens: r.maxTokens };
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ClaudeEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  /**
   * A fragment of the answer as it is written, when `stream` is on.
   *
   * `text` arrives per completed assistant BLOCK, which for a turn that thinks
   * for forty seconds and then writes six paragraphs means forty seconds of
   * nothing followed by everything. That is the whole of the difference between
   * watching an agent work and waiting for one. A consumer takes deltas OR
   * text, never both — the same words arrive twice by design, once as they are
   * written and once as a finished block.
   */
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | { kind: 'result'; ok: boolean; error?: string; usage?: TurnUsage };

/** Build a TurnUsage from a result message's modelUsage map (or null if absent). */
export function extractUsage(msg: any): TurnUsage | undefined {
  const modelUsage = msg?.modelUsage as Record<string, any> | undefined;
  if (!modelUsage || Object.keys(modelUsage).length === 0) return undefined;
  const entries = Object.entries(modelUsage);
  const sum = (f: string) => entries.reduce((n, [, u]) => n + (Number(u?.[f]) || 0), 0);
  // Primary model = the one that produced the most output tokens.
  const primary = entries.reduce((a, b) => ((b[1]?.outputTokens ?? 0) > (a[1]?.outputTokens ?? 0) ? b : a));
  return {
    model: entries.map(([m]) => m).join(','),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheCreationTokens: sum('cacheCreationInputTokens'),
    costUsd: Number(msg?.total_cost_usd) || sum('costUSD'),
    durationMs: Number(msg?.duration_ms) || 0,
    numTurns: Number(msg?.num_turns) || 0,
    contextWindow: Number(primary?.[1]?.contextWindow) || 0,
  };
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<
  { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }
>;

function readSystemPrompt(): string {
  try {
    return readFileSync(config.systemPromptPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs one user turn against Claude Code and yields normalized events.
 * Pass `resume` (a session id) to continue an existing conversation; omit it
 * to start a fresh session. The system prompt file is read on every call so
 * edits take effect immediately. `canUseTool` gates tool execution.
 */
export async function* askClaude(opts: {
  prompt: string;
  resume?: string;
  canUseTool?: CanUseTool;
  permissionMode?: PermissionMode;
  mcpServers?: Record<string, unknown>;
  cwd?: string;
  abortController?: AbortController;
  // Extra context appended to the work-thread system prompt (shared memory).
  appendContext?: string;
  // Concierge mode: a custom string system prompt + a tool allowlist, replacing
  // the Claude Code preset so it runs lean and focused on bot management.
  concierge?: { systemPrompt: string; allowedTools: string[] };
  /** A frozen custom system prompt in place of the `claude_code` preset
   *  (workers, src/workerPrompt.ts). Unlike `concierge`, settings sources are
   *  left at the SDK default so the project's CLAUDE.md still loads, exactly
   *  as it did under the preset. A string prompt has no dynamic SYSTEM
   *  sections (date, environment, repo status are preset-only), but the CLI
   *  still prepends its userContext — CLAUDE.md, email, the current date — as
   *  the first user message of every call; see src/workerPrompt.ts. */
  systemPrompt?: string;
  /** Emit `delta` events as the answer is written. Off by default: every
   *  existing caller stores a finished turn and would only pay to re-render
   *  words it already has. */
  stream?: boolean;
  /** Model for THIS turn (an alias like 'sonnet' or a full id); omitted = CLAUDE_MODEL. */
  model?: string;
  /** Thinking effort for this turn; omitted = the SDK's default for the model. */
  effort?: 'low' | 'medium' | 'high';
  /** Cap on internal agentic turns (the summarizer runs one). */
  maxTurns?: number;
  /** The tools that EXIST for this query. `allowedTools` only pre-approves;
   *  this is the availability filter (sdk.d.ts: "to restrict which tools are
   *  available, use the `tools` option"). `[]` = a query that can only talk. */
  tools?: string[];
  /** Hard stop in dollars: the SDK ends the query past it. */
  maxBudgetUsd?: number;
}): AsyncGenerator<ClaudeEvent> {
  // appendContext arrives pre-labeled (shared memory / bulletin / workspace
  // sections built by the dispatcher) — append it verbatim.
  // The append only exists on the preset branch. Dropping it silently on the
  // others is how the operator agent's brief went undelivered for weeks
  // (src/debugAgent.ts, until 2026-08-28): refuse instead.
  if (opts.appendContext && (opts.concierge || opts.systemPrompt)) {
    throw new Error('askClaude: appendContext is preset-only; put the text in the turn prompt when using a custom system prompt');
  }
  const append = stripLoneSurrogates(readSystemPrompt() + (opts.appendContext ? `\n\n${opts.appendContext}` : ''));

  const stream = query({
    // Guard against a lone UTF-16 surrogate (e.g. from a sliced emoji in the
    // assembled context) making the request body invalid JSON.
    prompt: stripLoneSurrogates(opts.prompt),
    options: {
      resume: opts.resume,
      cwd: opts.cwd ?? config.workingDir,
      // The built-in AskUserQuestion needs an interactive frontend we don't
      // have here — it silently no-ops ("tool hiccup"). Remove it so the model
      // falls back to our telegram askUserQuestion tool, which renders buttons.
      disallowedTools: ['AskUserQuestion'],
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      permissionMode: opts.permissionMode ?? config.permissionMode,
      ...(opts.stream ? { includePartialMessages: true } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers as never } : {}),
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      ...((opts.model ?? config.model) ? { model: opts.model ?? config.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.maxBudgetUsd ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      ...(opts.concierge
        ? { systemPrompt: opts.concierge.systemPrompt, allowedTools: opts.concierge.allowedTools, settingSources: [] }
        : opts.systemPrompt
          ? { systemPrompt: opts.systemPrompt }
          : { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append } }),
    },
  });

  // The SDK message shapes are a discriminated union; we narrow by `type` and
  // normalize into our own events, so we keep this loop loosely typed.
  // The exact context of a turn is the LAST API call's input — its prompt
  // tokens plus what it read from and wrote into the cache. Every assistant
  // message carries that call's usage, so the final one is the measurement;
  // it needs no control channel, which single-shot mode closes with the
  // result (the 08-27 rows read context_tokens=0 for exactly that reason).
  let lastCallContext = 0;
  for await (const msg of stream as AsyncIterable<any>) {
    if (msg.type === 'assistant') {
      const u = msg.message?.usage;
      if (u) {
        const n = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
        if (n > 0) lastCallContext = n;
      }
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      yield { kind: 'session', sessionId: msg.session_id };
    } else if (msg.type === 'stream_event') {
      // Only the text deltas. The stream also carries block starts/stops and
      // tool-input deltas; the first two say nothing a consumer needs and the
      // third is a partial JSON string that is useless until it is complete —
      // the `tool` event below already carries the parsed arguments.
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        yield { kind: 'delta', text: ev.delta.text as string };
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          yield { kind: 'text', text: block.text };
        } else if (block.type === 'tool_use') {
          yield { kind: 'tool', name: block.name, input: block.input ?? {} };
        }
      }
    } else if (msg.type === 'result') {
      const usage = extractUsage(msg);
      if (usage) {
        // The query is still live here (the result is its last message, not
        // its close), so the control channel can report the exact window.
        if (lastCallContext > 0) {
          usage.contextTokens = lastCallContext;
          usage.contextMax = usage.contextWindow;
        } else {
          const cu = await contextUsageOf(stream);
          if (cu) {
            usage.contextTokens = cu.totalTokens;
            usage.contextMax = cu.maxTokens;
          }
        }
      }
      yield {
        kind: 'result',
        ok: msg.subtype === 'success',
        error: msg.subtype === 'success' ? undefined : String(msg.subtype),
        usage,
      };
      if (msg.session_id) yield { kind: 'session', sessionId: msg.session_id };
    }
  }
}
