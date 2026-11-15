import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * SESSION ROTATION (src/rotation.ts).
 *
 * On 2026-08-25 a flat turn counter cleared the concierge between two messages
 * a minute apart; the bot said "Welcome back" to a person mid-sentence, and
 * nothing recorded that it had happened. The properties pinned here:
 *   - THE RULES ARE THE RULES. Context above the threshold rotates only when
 *     the human has been idle; the ceiling rotates regardless; nothing else
 *     ever does. Boundaries are inclusive.
 *   - CONTEXT IS MEASURED, NOT SUMMED. The SDK's exact total wins; the
 *     fallback divides the per-run cache sums by the run's calls. The bill
 *     (`input + read + created`) is never the window.
 *   - "IDLE" MEANS THE HUMAN, BY PROVENANCE. `messages.source` decides, not
 *     the text: a bracket-led message the person sent is the person's. The
 *     turn about to run does not count as activity against itself.
 *   - NO SESSION, NO ROTATION. The first turn after a clear reads yesterday's
 *     usage row and must not hand off an empty transcript.
 *   - THE HANDOFF IS A RENDER. Every line comes from a row: the last human
 *     messages verbatim, the bot's own last reply, commitments (local time,
 *     labels capped) and notes just touched; bounded, stable, framed so the new
 *     session knows the old one is gone.
 *   - A ROTATION LEAVES A TRACE. An event every time, saying exact or
 *     estimated; friction when it landed mid-thread; a tally with zeros as
 *     zeros; and the handoff reaches the PROMPT, never the turn's own record.
 *
 * Own database: the suite runs files in parallel against one scratch DB, and
 * assertions on the concierge's real session key would be timing, not truth.
 */

const dir = mkdtempSync(join(tmpdir(), 'rotation-'));
process.env.DB_PATH = join(dir, 'rotation-test.db');
process.env.KNOWLEDGE_DIR = join(dir, 'kb');

type Rot = typeof import('../src/rotation.js');
type Db = typeof import('../src/db.js');
type Cfg = typeof import('../src/config.js');
let R: Rot;
let D: Db;
let C: Cfg;
let raw: Database.Database;

const CHAT = 777;
const KEY = `${CHAT}:-1`;
const NOW = '2026-08-25 16:21:00';
const ALL = ['1970-01-01 00:00:00', '2999-01-01 00:00:00'] as const;

/** A usage row whose per-call ESTIMATE is `ctx` (sums are `numTurns` × that), optionally with the exact SDK total. */
function seedUsage(key: string, ctx: number, numTurns = 1, exact = 0): void {
  raw
    .prepare(
      'INSERT INTO usage (session_key, input_tokens, cache_read, cache_creation, num_turns, context_window, context_tokens) VALUES (?, ?, ?, ?, ?, 1000000, ?)',
    )
    .run(key, 100, (ctx - 100) * numTurns, 0, numTurns, exact);
}

function seedMessage(key: string, role: 'user' | 'assistant', content: string, at: string, source: 'human' | 'machine' | null = role === 'user' ? 'human' : null): void {
  raw.prepare('INSERT INTO messages (session_key, role, content, created_at, source) VALUES (?, ?, ?, ?, ?)').run(key, role, content, at, source);
}

function withSession(): void {
  D.setSessionId(KEY, 'sess-live', 'concierge:1');
}

function clearAll(): void {
  raw.exec("DELETE FROM usage; DELETE FROM messages; DELETE FROM events WHERE source = 'rotation'; DELETE FROM friction; DELETE FROM tool_calls; DELETE FROM commitments; DELETE FROM sessions;");
}

before(async () => {
  D = await import('../src/db.js');
  R = await import('../src/rotation.js');
  C = await import('../src/config.js');
  raw = new Database(process.env.DB_PATH!);
});

describe('the rotation rules', () => {
  const base = { aboveTokens: 200_000, idleMin: 15, ceilingTokens: 600_000 };
  const decide = (contextTokens: number, idle: number) => R.rotationDecision({ ...base, contextTokens, minutesSinceLastUserMessage: idle });

  it('never rotates below the threshold, however idle', () => {
    assert.deepEqual(decide(199_999, 600), { rotate: false, reason: null });
    assert.deepEqual(decide(0, Infinity), { rotate: false, reason: null });
  });

  it('holds above the threshold while the human is active', () => {
    assert.deepEqual(decide(400_000, 2), { rotate: false, reason: null });
    assert.deepEqual(decide(400_000, 14.9), { rotate: false, reason: null });
  });

  it('rotates above the threshold once the human has been idle — inclusive on both edges', () => {
    assert.deepEqual(decide(200_000, 15), { rotate: true, reason: 'idle-threshold' });
    assert.deepEqual(decide(204_000, 17), { rotate: true, reason: 'idle-threshold' });
    assert.deepEqual(decide(250_000, Infinity), { rotate: true, reason: 'idle-threshold' });
  });

  it('rotates at the ceiling whatever the human is doing', () => {
    assert.deepEqual(decide(600_000, 0), { rotate: true, reason: 'ceiling' });
    assert.deepEqual(decide(900_000, 1), { rotate: true, reason: 'ceiling' });
  });

  it('reads its defaults from config: 200k above at 15 min idle, 600k ceiling', () => {
    assert.equal(C.config.rotateAboveTokens, 200_000);
    assert.equal(C.config.rotateIdleMin, 15);
    assert.equal(C.config.rotateCeilingTokens, 600_000);
    assert.deepEqual(R.rotationDecision({ contextTokens: 200_000, minutesSinceLastUserMessage: 15 }), { rotate: true, reason: 'idle-threshold' });
    assert.deepEqual(R.rotationDecision({ contextTokens: 199_999, minutesSinceLastUserMessage: 15 }), { rotate: false, reason: null });
    assert.deepEqual(R.rotationDecision({ contextTokens: 600_000, minutesSinceLastUserMessage: 0 }), { rotate: true, reason: 'ceiling' });
  });
});

describe('measuring context', () => {
  it('is 0 / estimated for a session that never ran', () => {
    clearAll();
    assert.deepEqual(D.lastTurnContextTokens(KEY), { tokens: 0, source: 'est' });
  });

  it('prefers the exact SDK total when the turn stored one', () => {
    clearAll();
    seedUsage(KEY, 204_000, 3, 198_765);
    assert.deepEqual(D.lastTurnContextTokens(KEY), { tokens: 198_765, source: 'exact' });
  });

  it('otherwise divides the per-run sums by the run’s calls — the bill is not the window', () => {
    clearAll();
    seedUsage(KEY, 204_000, 3); // sums 612k over 3 calls, like the 08-25 row
    const c = D.lastTurnContextTokens(KEY);
    assert.equal(c.source, 'est');
    assert.equal(c.tokens, 204_000);
  });
});

describe('should this turn rotate first', () => {
  it('does nothing for a session that has never run', () => {
    clearAll();
    withSession();
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.rotate, false);
    assert.equal(c.contextTokens, 0);
  });

  it('does not rotate a session that has just been cleared, however big the last usage row', () => {
    clearAll();
    seedUsage(KEY, 900_000, 1, 900_000);
    seedMessage(KEY, 'user', 'yesterday', '2026-08-25 10:00:00');
    assert.equal(D.storedSessionId(KEY), undefined);
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.rotate, false);
    assert.equal(R.rotateIfDue(CHAT, KEY, true, NOW), undefined);
    assert.equal(D.rotationEventsBetween(CHAT, ...ALL).length, 0);
  });

  it('measures idleness against the message BEFORE the one about to run', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 204_000, 3);
    seedMessage(KEY, 'user', 'earlier thought', '2026-08-25 15:51:00'); // 30 min before NOW
    seedMessage(KEY, 'user', 'After daily', NOW); // the turn about to run, already logged
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.reason, 'idle-threshold');
    assert.equal(Math.round(c.idleMinutes), 30);
    assert.equal(c.contextTokens, 204_000);
    assert.equal(c.contextSource, 'est');
  });

  it('holds when the human spoke a minute ago (the 08-25 case)', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 204_000, 3);
    seedMessage(KEY, 'user', 'Yes so the pills was 20 10', '2026-08-25 16:20:00');
    seedMessage(KEY, 'user', 'After daily', NOW);
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.rotate, false);
    assert.equal(Math.round(c.idleMinutes), 1);
  });

  it('a machine-composed turn is not the human speaking, so it can be the idle seam', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 250_000);
    seedMessage(KEY, 'user', 'last human word', '2026-08-25 15:40:00'); // 41 min
    seedMessage(KEY, 'user', '[COMMITMENT · checkin] fired', NOW, 'machine');
    const c = R.shouldRotateBefore(KEY, false, NOW);
    assert.equal(c.reason, 'idle-threshold');
    assert.equal(Math.round(c.idleMinutes), 41);
  });

  it('a bracket-led message the person sent is the person’s ([USER ANSWERED] is human)', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 250_000);
    seedMessage(KEY, 'user', 'earlier', '2026-08-25 15:40:00');
    seedMessage(KEY, 'user', '[USER ANSWERED] The question(s) you posted have been answered', '2026-08-25 16:20:00', 'human');
    seedMessage(KEY, 'user', '[PROCESS BATCH] I captured these fragments', NOW, 'human');
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.rotate, false, 'the person tapped a minute ago');
    assert.equal(Math.round(c.idleMinutes), 1);
  });

  it('legacy rows without a source fall back to the bracket sniff, and only those', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 250_000);
    seedMessage(KEY, 'user', 'old typed message', '2026-08-25 15:40:00', null);
    seedMessage(KEY, 'user', '[PULSE] old machine row', '2026-08-25 16:20:00', null);
    seedMessage(KEY, 'user', '[COMMITMENT] fired', NOW, 'machine');
    const c = R.shouldRotateBefore(KEY, false, NOW);
    assert.equal(c.reason, 'idle-threshold');
    assert.equal(Math.round(c.idleMinutes), 41);
  });

  it('the ceiling overrides an active human', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 650_000, 1, 650_000);
    seedMessage(KEY, 'user', 'still typing', '2026-08-25 16:20:30');
    seedMessage(KEY, 'user', 'and more', NOW);
    const c = R.shouldRotateBefore(KEY, true, NOW);
    assert.equal(c.reason, 'ceiling');
    assert.equal(c.contextSource, 'exact');
  });
});

describe('the handoff', () => {
  const info = { reason: 'idle-threshold' as const, contextTokens: 204_000, contextSource: 'est' as const, idleMinutes: 17 };

  it('renders the last eight human messages verbatim, oldest first, truncated, and nothing from elsewhere', () => {
    clearAll();
    for (let i = 1; i <= 10; i++) seedMessage(KEY, 'user', `human message ${i}`, `2026-08-25 15:${String(i).padStart(2, '0')}:00`);
    seedMessage(KEY, 'user', '[PULSE] machine noise', '2026-08-25 15:30:00', 'machine');
    seedMessage(KEY, 'user', `long ${'x'.repeat(400)}`, '2026-08-25 15:32:00');
    seedMessage('999:-1', 'user', 'someone else entirely', '2026-08-25 15:33:00');
    const h = R.buildHandoff(CHAT, KEY, info, NOW);
    assert.match(h, /^\[HANDOFF — your previous session was rotated \(idle-threshold\) at 204,000 tokens after 17 min idle/);
    assert.match(h, /GONE/);
    assert.match(h, /Do not greet/);
    // 11 human rows seeded (10 numbered + the long one): the last 8 are 4..10 + long.
    assert.doesNotMatch(h, /human message 1\b/);
    assert.doesNotMatch(h, /human message 3\b/);
    assert.match(h, /human message 4\b/);
    assert.ok(h.indexOf('human message 4') < h.indexOf('human message 10'));
    assert.ok(h.indexOf('human message 10') < h.indexOf('long x'));
    assert.doesNotMatch(h, /PULSE/);
    assert.doesNotMatch(h, /someone else/);
    assert.match(h, /long x{295}…/);
    assert.doesNotMatch(h, /x{300}/);
    assert.ok(h.endsWith(']'));
  });

  it('carries the bot’s own last two replies after the human lines', () => {
    clearAll();
    seedMessage(KEY, 'user', 'the pills were 20 and 10', '2026-08-25 16:19:00');
    seedMessage(KEY, 'assistant', 'first reply, superseded', '2026-08-25 16:19:10');
    seedMessage(KEY, 'assistant', 'second reply', '2026-08-25 16:19:20');
    seedMessage(KEY, 'assistant', `third reply ${'z'.repeat(400)}`, '2026-08-25 16:19:30');
    seedMessage('999:-1', 'assistant', 'other chat reply', '2026-08-25 16:19:40');
    const h = R.buildHandoff(CHAT, KEY, info, NOW);
    assert.doesNotMatch(h, /first reply/);
    assert.match(h, /Your last reply\/replies \(oldest first\):\n- \d\d:\d\d  second reply\n- \d\d:\d\d  third reply z{288}…/);
    assert.ok(h.indexOf('the pills were') < h.indexOf('second reply'));
    assert.doesNotMatch(h, /other chat reply/);
  });

  it('carries the commitments (local time, labels capped) and notes the session just touched', () => {
    clearAll();
    seedMessage(KEY, 'user', 'remove the stitch tomorrow', '2026-08-25 16:19:00');
    const id = D.addCommitment(CHAT, `stitch-removal nudge ${'l'.repeat(200)}`, 'walk in', '2026-08-26 09:00:00');
    D.logToolCall(KEY, 'writeNote', 'personal/boiler-repair');
    D.logToolCall(KEY, 'readNote', 'personal/something-read');
    D.logToolCall('999:-1', 'writeNote', 'other/chat');
    const h = R.buildHandoff(CHAT, KEY, info, D.dbNow());
    const local = new Date('2026-08-26T09:00:00Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    const due = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
    assert.match(h, new RegExp(`- #${id} stitch-removal nudge l{99}… · due ${due} · open`));
    assert.doesNotMatch(h, /l{120}/);
    assert.match(h, /Notes written in the last 60 min: personal\/boiler-repair\]$/);
    assert.doesNotMatch(h, /something-read/);
    assert.doesNotMatch(h, /other\/chat/);
  });

  it('is bounded and deterministic', () => {
    clearAll();
    for (let i = 0; i < 8; i++) seedMessage(KEY, 'user', 'y'.repeat(1000), `2026-08-25 15:0${i}:00`);
    seedMessage(KEY, 'assistant', 'w'.repeat(1000), '2026-08-25 15:09:00');
    const a = R.buildHandoff(CHAT, KEY, info, NOW);
    const b = R.buildHandoff(CHAT, KEY, info, NOW);
    assert.equal(a, b);
    assert.ok(a.length <= 6000, `handoff is ${a.length} chars`);
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/); // no ISO clock leaks into the render
  });

  it('says so when the human had never spoken', () => {
    clearAll();
    const h = R.buildHandoff(CHAT, KEY, { ...info, idleMinutes: Infinity }, NOW);
    assert.match(h, /after no prior message idle/);
  });

  it('reaches the prompt and only the prompt', () => {
    assert.equal(R.composeTurnPrompt(undefined, 'After daily'), 'After daily');
    assert.equal(R.composeTurnPrompt('[HANDOFF — …]', 'After daily'), '[HANDOFF — …]\n\nAfter daily');
    // The turn row and the retrieval episode get the raw text: dispatch calls
    // beginTurn(key, chatId, slot, text) and openRetrievalEpisode(key, …, text)
    // with `text`, and only askClaude's `prompt` goes through composeTurnPrompt.
  });
});

describe('a rotation leaves a trace', () => {
  it('at an idle seam: clears the session, posts an event naming its source, files no friction, returns the handoff', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 250_000, 2);
    seedMessage(KEY, 'user', 'earlier', '2026-08-25 15:40:00');
    seedMessage(KEY, 'user', 'now', NOW);
    const h = R.rotateIfDue(CHAT, KEY, true, NOW);
    assert.ok(h && h.startsWith('[HANDOFF'));
    assert.equal(D.getSessionId(KEY, 'concierge:1'), undefined);
    const ev = D.rotationEventsBetween(CHAT, ...ALL);
    assert.equal(ev.length, 1);
    assert.deepEqual(R.parseRotationEvent(ev[0]!.body), {
      reason: 'idle-threshold',
      contextTokens: 250_000,
      contextSource: 'est',
      idleMinutes: 41,
      midThread: false,
    });
    assert.equal(D.openFriction().filter((f) => f.kind === 'mid-thread-reset').length, 0);
  });

  it('mid-thread at the ceiling: the event says so and friction is filed', () => {
    clearAll();
    withSession();
    seedUsage(KEY, 650_000, 1, 650_000);
    seedMessage(KEY, 'user', 'a minute ago', '2026-08-25 16:20:00');
    seedMessage(KEY, 'user', 'now', NOW);
    const h = R.rotateIfDue(CHAT, KEY, true, NOW);
    assert.ok(h);
    const parsed = R.parseRotationEvent(D.rotationEventsBetween(CHAT, ...ALL).at(-1)!.body);
    assert.equal(parsed?.reason, 'ceiling');
    assert.equal(parsed?.contextSource, 'exact');
    assert.equal(parsed?.midThread, true);
    const f = D.openFriction().filter((x) => x.kind === 'mid-thread-reset');
    assert.equal(f.length, 1);
    assert.match(f[0]!.detail, /650000 tokens \(exact\), 1 min after/);
  });

  it('does nothing — no event, no clear — when not due', () => {
    clearAll();
    D.setSessionId(KEY, 'sess-keep', 'concierge:1');
    seedUsage(KEY, 100_000);
    seedMessage(KEY, 'user', 'now', NOW);
    assert.equal(R.rotateIfDue(CHAT, KEY, true, NOW), undefined);
    assert.equal(D.getSessionId(KEY, 'concierge:1'), 'sess-keep');
    assert.equal(D.rotationEventsBetween(CHAT, ...ALL).length, 0);
  });

  it('tallies a window with zeros as zeros', () => {
    clearAll();
    assert.deepEqual(R.rotationTally(CHAT, ...ALL), { count: 0, midThread: 0, maxContext: 0 });
    D.postEvent(CHAT, 'rotation', R.rotationEventBody({ reason: 'idle-threshold', contextTokens: 250_000, contextSource: 'est', idleMinutes: 30 }));
    D.postEvent(CHAT, 'rotation', R.rotationEventBody({ reason: 'ceiling', contextTokens: 610_000, contextSource: 'exact', idleMinutes: 1 }));
    D.postEvent(CHAT, 'rotation', 'unrelated prose that is not a rotation record');
    D.postEvent(CHAT, 'operator', R.rotationEventBody({ reason: 'ceiling', contextTokens: 999_999, contextSource: 'exact', idleMinutes: 0 }));
    assert.deepEqual(R.rotationTally(CHAT, ...ALL), { count: 2, midThread: 1, maxContext: 610_000 });
    assert.deepEqual(R.rotationTally(CHAT, '2999-01-01 00:00:00', '2999-12-31 00:00:00'), { count: 0, midThread: 0, maxContext: 0 });
  });

  it('parses only its own shape', () => {
    assert.equal(R.parseRotationEvent('concierge context cleared for the new day'), undefined);
    const body = R.rotationEventBody({ reason: 'idle-threshold', contextTokens: 1, contextSource: 'est', idleMinutes: Infinity });
    assert.deepEqual(R.parseRotationEvent(body), { reason: 'idle-threshold', contextTokens: 1, contextSource: 'est', idleMinutes: -1, midThread: false });
  });
});
