import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

/**
 * Phase 1 — the message router. A cheap classification that decides which thread
 * an incoming message belongs to, or whether it starts a new one. It is NOT a
 * persistent *agent*: its only context is the per-thread memos passed in on each
 * call (see db.ts).
 *
 * Spawning a Claude Code subprocess per call costs ~6s, far too slow for
 * per-message routing, so we keep ONE warm session alive (SDK streaming-input
 * mode) and feed classifications through it: ~6s cold start once, then ~1-2s
 * each. Calls are serialized over the single session and it's periodically reset
 * to bound context growth.
 *
 * A misroute is costly (it pollutes a thread), so callers treat a null result —
 * classifier failed — as "ask the user" rather than "guess".
 */

export interface Thread {
  slot: number;
  title: string;
  summary?: string;
}

export interface Route {
  target: number | 'new' | 'control';
  confidence: 'high' | 'low';
  reason?: string;
}

const SYSTEM = `You route messages in a chat that runs several parallel assistant threads.
Given the user's new message and the list of active threads (each with a title and a short status), decide where the message belongs.
Each request is independent — judge only by the thread list given in that request, not earlier ones.
Reply with ONE line of JSON and nothing else:
{"target": <slot number, or "new", or "control">, "confidence": "high" | "low", "reason": "<≤8 words>"}
Rules:
- Prefer the currently active thread for follow-ups, acknowledgements, or short replies.
- Pick another thread only when the message clearly concerns that thread's topic.
- Use "new" only when the message clearly fits none of the threads.
- Use "control" when the message is about the BOT ITSELF rather than work — managing threads (list/close/rename/switch), bot settings, or remembering a fact/preference for later ("remember that…", "how many threads do I have?", "close the visa one", "what's my working dir?").
- Use "high" only when you are confident; otherwise "low".`;

// Reset the warm session after this many classifications to bound context.
const RESET_AFTER = 50;

interface InputChannel {
  gen: AsyncGenerator<SDKUserMessage>;
  push: (text: string) => void;
  end: () => void;
}

/** A hand-driven async generator of user messages for the streaming session. */
function createInput(): InputChannel {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const gen = (async function* () {
    for (;;) {
      if (queue.length === 0) {
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
      const m = queue.shift();
      if (m) yield m;
    }
  })();
  return {
    gen,
    push(text) {
      queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } });
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
  };
}

let warm: { input: InputChannel; q: Query } | null = null;
let calls = 0;

function startWarm(): { input: InputChannel; q: Query } {
  const input = createInput();
  const q = query({
    prompt: input.gen,
    options: {
      model: config.routerModel,
      systemPrompt: SYSTEM,
      allowedTools: [],
      settingSources: [], // skip CLAUDE.md / settings — a big chunk of init time
    },
  });
  calls = 0;
  warm = { input, q };
  return warm;
}

function resetWarm(): void {
  try {
    warm?.input.end();
  } catch {
    /* ignore */
  }
  warm = null;
}

// Serialize classifications over the single shared session.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run one classification turn through the warm session; null on failure. */
async function classify(prompt: string): Promise<string | null> {
  return withLock(async () => {
    if (warm && calls >= RESET_AFTER) resetWarm();
    const w = warm ?? startWarm();
    calls++;
    w.input.push(prompt);
    let text = '';
    try {
      for (;;) {
        // Drive with next() (not for-await) so breaking doesn't close the session.
        const { value, done } = await w.q.next();
        if (done) {
          resetWarm();
          break;
        }
        const msg = value as any;
        if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'text' && b.text) text += b.text;
          }
        } else if (msg.type === 'result') {
          break;
        }
      }
    } catch (err) {
      console.error('[router] warm session error', err);
      resetWarm();
      return null;
    }
    return text;
  });
}

function parseRoute(text: string, slots: Set<number>): Route | null {
  const match = text.match(/\{[^}]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const obj = raw as { target?: unknown; confidence?: unknown; reason?: unknown };
  const target =
    obj.target === 'new'
      ? 'new'
      : obj.target === 'control'
        ? 'control'
        : typeof obj.target === 'number' && slots.has(obj.target)
          ? obj.target
          : null;
  if (target === null) return null;
  const confidence = obj.confidence === 'high' ? 'high' : 'low';
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 60) : undefined;
  return { target, confidence, reason };
}

/**
 * Classify a message against the active threads. Returns a routing decision, or
 * `null` if the classifier failed — callers should treat null as "ask the user".
 */
export async function routeMessage(
  message: string,
  threads: Thread[],
  activeSlot: number,
): Promise<Route | null> {
  const list = threads
    .map((t) => {
      const here = t.slot === activeSlot ? ' (currently active)' : '';
      const status = t.summary ? ` — ${t.summary}` : '';
      return `- slot ${t.slot}: ${t.title}${status}${here}`;
    })
    .join('\n');
  const prompt = `Active threads:\n${list}\n\nNew message:\n"""\n${message.slice(0, 2000)}\n"""\n\nJSON:`;
  const text = await classify(prompt);
  if (text === null) return null;
  return parseRoute(text, new Set(threads.map((t) => t.slot)));
}

/** Pay the cold start at boot so the first real route is fast. Best-effort. */
export async function primeRouter(): Promise<void> {
  await classify(
    'Active threads:\n- slot 0: warmup — none\n\nNew message:\n"""\nhello\n"""\n\nJSON:',
  ).catch(() => {});
}
