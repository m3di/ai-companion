/**
 * CONCIERGE SESSION ROTATION — rotate at the seam, hand off from the database.
 *
 * The concierge is an all-day session whose whole history re-sends every turn,
 * so something has to bound it. Until 2026-08-26 that was a flat turn counter
 * (`CONCIERGE_RESET_AFTER = 30`): blind to how big the context actually was
 * and to whether the person was mid-thread. On 2026-08-25 it fired between two
 * messages a minute apart — the bot answered "After daily" with "Welcome back"
 * and a focus-set dump, having never heard the sentence before it. No event,
 * no friction row; the night saw nothing.
 *
 * Two rules replace the counter, both reading numbers the ledger already
 * keeps (the usage row of the last turn, the messages table):
 *
 *   - IDLE THRESHOLD: context ≥ `rotateAboveTokens` AND the human quiet for
 *     ≥ `rotateIdleMin` minutes. Idle is the free seam: after ~5 minutes the
 *     prompt cache has expired anyway, so the next turn re-creates the prefix
 *     whether or not the session was rotated. A nap costs nothing extra; a
 *     reset mid-thread costs the conversation.
 *   - CEILING: context ≥ `rotateCeilingTokens`, whatever the human is doing.
 *     With a handoff a forced rotation is survivable; a refused turn is not.
 *     This is the only path that can rotate within minutes of a human message,
 *     and when it does the rotation is filed as friction (`mid-thread-reset`).
 *
 * CONTEXT IS MEASURED, NOT SUMMED. A usage row is per RUN and its cache sums
 * span every internal API call, so `input + read + created` is the bill, not
 * the window — ~num_turns× too big (the first cut of this rule read 612k for a
 * turn whose live context was 204k). The turn stores the SDK's own
 * `getContextUsage` total when it can (`usage.context_tokens`); the fallback
 * is the per-call estimate `latestContextInfo` already used. The event line
 * says which (`src=exact|est`).
 *
 * "IDLE" IS THE HUMAN, BY PROVENANCE. A 'user' row is `source='human'` or
 * `'machine'` where it was written; the turn about to run carries `human`
 * from its call site. Nothing sniffs text: [USER ANSWERED] and [PROCESS BATCH]
 * are bracket-led AND the person's.
 *
 * NO SESSION, NOTHING TO ROTATE. Usage rows outlive every clearSession — the
 * nightly fold, /reset, a debug exit — so the first turn after one used to
 * read yesterday's row, "rotate" an empty session, and inject a handoff
 * telling a session that is supposed to onboard not to. `storedSessionId`
 * gates the whole thing.
 *
 * THE HANDOFF is derived from the DATABASE, never from the old model's memory
 * (I9/I4): the person's last messages verbatim, the bot's own last reply, the
 * commitments and notes the session just touched. Regenerable, inspectable,
 * and delivered INTO THE TURN rather than the system prompt (I12 — the prefix
 * must not move).
 *
 * SDK note: `@anthropic-ai/claude-agent-sdk` 0.3.x exposes `autoCompactEnabled`
 * on `Settings`, which `query()` accepts through `options.settings` — so
 * model-written compaction IS reachable per call. Deliberately not enabled: a
 * summary the model writes about itself is exactly the kind of memory this
 * system refuses to hold (unauditable, un-revertible). The handoff below is
 * the compaction, and every line of it points at a row.
 */
import { fmtLocal } from './commitments.js';
import { config } from './config.js';
import {
  clearSession,
  commitmentsTouchedSince,
  dbNow,
  dropPendingHandoff,
  lastHumanMessageAt,
  lastTurnContextTokens,
  notesWrittenSince,
  pendingHandoffRow,
  postEvent,
  recentAssistantMessages,
  recentHumanMessages,
  recordFriction,
  rotationEventsBetween,
  savePendingHandoff,
  storedSessionId,
} from './db.js';

export type RotationReason = 'idle-threshold' | 'ceiling';
export type ContextSource = 'exact' | 'est';

export interface RotationInputs {
  /** The session's live context after its last turn. */
  contextTokens: number;
  /** Minutes since the human last spoke; Infinity when they never have. */
  minutesSinceLastUserMessage: number;
  aboveTokens?: number;
  idleMin?: number;
  ceilingTokens?: number;
}

export interface RotationDecision {
  rotate: boolean;
  reason: RotationReason | null;
}

/** Pure: the two rules and nothing else. */
export function rotationDecision(i: RotationInputs): RotationDecision {
  const above = i.aboveTokens ?? config.rotateAboveTokens;
  const idle = i.idleMin ?? config.rotateIdleMin;
  const ceiling = i.ceilingTokens ?? config.rotateCeilingTokens;
  if (i.contextTokens >= ceiling) return { rotate: true, reason: 'ceiling' };
  if (i.contextTokens >= above && i.minutesSinceLastUserMessage >= idle) return { rotate: true, reason: 'idle-threshold' };
  return { rotate: false, reason: null };
}

/** A rotation within this many minutes of a human message is mid-thread. */
export const MID_THREAD_MIN = 5;

function minutesBetween(fromUtc: string, toUtc: string): number {
  const a = Date.parse(`${fromUtc.replace(' ', 'T')}Z`);
  const b = Date.parse(`${toUtc.replace(' ', 'T')}Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.max(0, (b - a) / 60_000);
}

export interface RotationCheck extends RotationDecision {
  contextTokens: number;
  contextSource: ContextSource;
  idleMinutes: number;
}

/**
 * Should the concierge rotate BEFORE running this turn? `human` is the turn's
 * provenance from its call site; when it is the person's, their row is already
 * logged and is skipped — the question is how long they had been quiet before
 * THIS message, not zero. A session with nothing stored never rotates: there
 * is no transcript to hand off from, only a stale usage row.
 */
export function shouldRotateBefore(sessionKey: string, human: boolean, nowUtc = dbNow()): RotationCheck {
  const ctx = lastTurnContextTokens(sessionKey);
  const last = lastHumanMessageAt(sessionKey, human);
  const idleMinutes = last ? minutesBetween(last, nowUtc) : Infinity;
  const base = { contextTokens: ctx.tokens, contextSource: ctx.source, idleMinutes };
  if (!storedSessionId(sessionKey)) return { rotate: false, reason: null, ...base };
  return { ...rotationDecision({ contextTokens: ctx.tokens, minutesSinceLastUserMessage: idleMinutes }), ...base };
}

const HANDOFF_MESSAGES = 8;
const HANDOFF_ASSISTANT_MESSAGES = 2;
const HANDOFF_MSG_CHARS = 300;
const HANDOFF_LABEL_CHARS = 120;
const HANDOFF_LOOKBACK_MIN = 60;
const HANDOFF_MAX_CHARS = 6000;

function fmtIdle(min: number): string {
  return Number.isFinite(min) ? `${Math.round(min)} min` : 'no prior message';
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export interface RotationInfo {
  reason: RotationReason;
  contextTokens: number;
  contextSource: ContextSource;
  idleMinutes: number;
}

/**
 * The handoff block: a render of what the database holds about the last hour,
 * framed so the new session knows the old one is GONE and this is not a
 * memory. Ends without the user message — the caller appends it.
 */
export function buildHandoff(chatId: number, sessionKey: string, info: RotationInfo, nowUtc = dbNow()): string {
  const since = new Date(Date.parse(`${nowUtc.replace(' ', 'T')}Z`) - HANDOFF_LOOKBACK_MIN * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const lines: string[] = [];
  lines.push(
    `[HANDOFF — your previous session was rotated (${info.reason}) at ${info.contextTokens.toLocaleString('en-US')} tokens ` +
      `after ${fmtIdle(info.idleMinutes)} idle; nothing durable was lost. ` +
      `The transcript before this line is GONE: what follows is a render from the database, not a memory. ` +
      `Do not greet or re-onboard — continue the thread as the same assistant.`,
  );
  const msgs = recentHumanMessages(sessionKey, HANDOFF_MESSAGES);
  if (msgs.length) {
    lines.push(`Recent messages from the user (oldest first, local time):`);
    for (const m of msgs) lines.push(`- ${m.at}  ${clip(m.content, HANDOFF_MSG_CHARS)}`);
  }
  // The bot's own last words: for a mid-thread rotation the most useful line
  // is what it had just said, so the new session does not contradict it.
  const said = recentAssistantMessages(sessionKey, HANDOFF_ASSISTANT_MESSAGES);
  if (said.length) {
    lines.push(`Your last reply/replies (oldest first):`);
    for (const m of said) lines.push(`- ${m.at}  ${clip(m.content, HANDOFF_MSG_CHARS)}`);
  }
  const commitments = commitmentsTouchedSince(chatId, since);
  if (commitments.length) {
    lines.push(`Commitments touched in the last ${HANDOFF_LOOKBACK_MIN} min (local time):`);
    for (const c of commitments) lines.push(`- #${c.id} ${clip(c.label, HANDOFF_LABEL_CHARS)} · due ${fmtLocal(c.due_at)} · ${c.status}`);
  }
  const notes = notesWrittenSince(sessionKey, since);
  if (notes.length) {
    lines.push(`Notes written in the last ${HANDOFF_LOOKBACK_MIN} min: ${notes.join(', ')}`);
  }
  let out = `${lines.join('\n')}]`;
  if (out.length > HANDOFF_MAX_CHARS) out = `${out.slice(0, HANDOFF_MAX_CHARS - 2)}…]`;
  return out;
}

/**
 * The prompt a turn actually sends: the handoff, if any, then the user's
 * text. Kept pure and beside the handoff so the seam is testable without a
 * model — dispatch hands the RAW text to the turn row and the episode, and
 * only the prompt carries the render.
 */
export function composeTurnPrompt(handoff: string | undefined, text: string, sessionOpen?: string): string {
  // Order: what the predecessor left (handoff) → the state at open (snapshot)
  // → what the person said. All three ride IN the turn, never in the prefix.
  return [handoff, sessionOpen, text].filter(Boolean).join('\n\n');
}

/** The event line, one fixed shape so `parseRotationEvent` can read it back. */
export function rotationEventBody(info: RotationInfo): string {
  const idle = Number.isFinite(info.idleMinutes) ? Math.round(info.idleMinutes) : -1;
  const mid = info.idleMinutes < MID_THREAD_MIN ? 'yes' : 'no';
  return `concierge session rotated [${info.reason}] ctx=${info.contextTokens} src=${info.contextSource} idle=${idle} mid-thread=${mid}`;
}

export interface RotationEvent {
  reason: RotationReason;
  contextTokens: number;
  contextSource: ContextSource;
  /** -1 when there was no prior human message. */
  idleMinutes: number;
  midThread: boolean;
}

export function parseRotationEvent(body: string): RotationEvent | undefined {
  const m = /rotated \[(idle-threshold|ceiling)\] ctx=(\d+) src=(exact|est) idle=(-?\d+) mid-thread=(yes|no)/.exec(body);
  if (!m) return undefined;
  return {
    reason: m[1] as RotationReason,
    contextTokens: Number(m[2]),
    contextSource: m[3] as ContextSource,
    idleMinutes: Number(m[4]),
    midThread: m[5] === 'yes',
  };
}

/**
 * Rotate the concierge if it is due, and return the handoff to prepend to the
 * turn — or undefined when the session simply continues. Every rotation posts
 * an event; a mid-thread one is also friction.
 */
export function rotateIfDue(chatId: number, sessionKey: string, human: boolean, nowUtc = dbNow()): string | undefined {
  const check = shouldRotateBefore(sessionKey, human, nowUtc);
  if (!check.rotate || !check.reason) return undefined;
  const info: RotationInfo = {
    reason: check.reason,
    contextTokens: check.contextTokens,
    contextSource: check.contextSource,
    idleMinutes: check.idleMinutes,
  };
  clearSession(sessionKey);
  postEvent(chatId, 'rotation', rotationEventBody(info));
  if (info.idleMinutes < MID_THREAD_MIN) {
    recordFriction({
      kind: 'mid-thread-reset',
      signature: `rotation:${info.reason}`,
      detail: `context ${info.contextTokens} tokens (${info.contextSource}), ${Math.round(info.idleMinutes)} min after the last human message`,
      sessionKey,
    });
  }
  const handoff = buildHandoff(chatId, sessionKey, info, nowUtc);
  // Persisted BEFORE it is returned: on 2026-08-27 the turn that carried a
  // handoff hung and the process was restarted, and the next turn re-onboarded
  // — the memory of the rotation lived only in the turn that died with it.
  savePendingHandoff(sessionKey, handoff, info.reason);
  return handoff;
}

/** A handoff older than this is not delivered: the day has moved on, and a
 *  note saying "continue the thread" about a thread six hours gone would be
 *  worse than a plain fresh start. */
export const HANDOFF_TTL_MIN = 6 * 60;

/**
 * The handoff a rotation left for this session, if a NEW session has not yet
 * acknowledged a turn that carried it. Undefined when the session already
 * exists (it got its handoff, or was never rotated), or when the row is stale
 * — which is dropped with an event, never delivered. The row is consumed by
 * `consumeHandoff` at the session ack, not here: a turn that dies between
 * composing the prompt and the SDK's session message leaves it for the next.
 */
export function pendingHandoff(chatId: number, sessionKey: string, nowUtc = dbNow()): string | undefined {
  if (storedSessionId(sessionKey)) return undefined;
  const row = pendingHandoffRow(sessionKey);
  if (!row) return undefined;
  const age = minutesBetween(row.created_at, nowUtc);
  if (age > HANDOFF_TTL_MIN) {
    dropPendingHandoff(sessionKey);
    postEvent(chatId, 'rotation', `handoff dropped: ${Math.round(age / 60)}h old (${row.reason}) — a stale handoff is not delivered`);
    return undefined;
  }
  return row.text;
}

/** The new session has the handoff in its transcript; the row has done its job. */
export function consumeHandoff(sessionKey: string): void {
  dropPendingHandoff(sessionKey);
}

export interface RotationTally {
  count: number;
  midThread: number;
  maxContext: number;
}

/** Rotations in a window, from the event log — what cycleCli prints. */
export function rotationTally(chatId: number, fromUtc: string, toUtc: string): RotationTally {
  const t: RotationTally = { count: 0, midThread: 0, maxContext: 0 };
  for (const e of rotationEventsBetween(chatId, fromUtc, toUtc)) {
    const r = parseRotationEvent(e.body);
    if (!r) continue;
    t.count += 1;
    if (r.midThread) t.midThread += 1;
    t.maxContext = Math.max(t.maxContext, r.contextTokens);
  }
  return t;
}
