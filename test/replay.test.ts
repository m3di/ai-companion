import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';

/**
 * WHAT SURVIVES A RESTART (src/replay.ts, src/turnLock.ts, src/rotation.ts).
 *
 * On 2026-08-27 a Telegram send retried forever, the concierge lock was held
 * for two hours, the fix restarted the process — and the message queued behind
 * the lock (eyes reaction and all) vanished with the process, as did the
 * handoff the 09:15 rotation had built for the session it cleared. Two stores
 * that must outlive the process, and the properties pinned here:
 *   - THE QUEUE IS A TABLE. Enqueue writes a row, dequeue takes the oldest and
 *     deletes it; release leaves the rows (a thrown turn must not cost the
 *     messages behind it); the lock itself stays in memory because a dead
 *     process must not hold one.
 *   - RECOVERY IS AT-MOST-ONCE, AND GATED. The rows are taken in one
 *     transaction; a second take sees nothing. While the day may not run —
 *     a night owed, a pass holding the machine, debug — nothing is taken and
 *     the rows stay for the tick to retry.
 *   - THE PLAN IS A RULE. A person's in-flight turn is replayed with a framing
 *     that says so; a machine's in-flight turn is reported, never re-run; a
 *     queued turn runs, framed, unless it is a stale machine turn; a replay
 *     that died again is reported, not looped.
 *   - THE HANDOFF IS A ROW. Written at rotation, delivered to the empty session
 *     as many times as it takes until a new session ACKS, dropped when stale,
 *     never delivered over a stored session, and cleared by a deliberate clear.
 *
 * Own database: the queue table is global, and the suite runs files in
 * parallel against one scratch DB. A fresh database owes a night by
 * construction — the gate tests use that, and settle it when they need LIVE.
 */

const dir = mkdtempSync(join(tmpdir(), 'replay-'));
process.env.DB_PATH = join(dir, 'replay-test.db');
process.env.KNOWLEDGE_DIR = join(dir, 'kb');

type Db = typeof import('../src/db.js');
type Lock = typeof import('../src/turnLock.js');
type Replay = typeof import('../src/replay.js');
type Rot = typeof import('../src/rotation.js');
type Night = typeof import('../src/night.js');
let D: Db;
let L: Lock;
let P: Replay;
let R: Rot;
let N: Night;
let raw: Database.Database;

const CHAT = 4242;
const KEY = `${CHAT}:-1`;
const OTHER = '9:-1';
const NOW = '2026-08-27 09:15:00';
const ALL = ['1970-01-01 00:00:00', '2999-01-01 00:00:00'] as const;
/** The rows a DEAD process left: everything this test wrote, re-owned. Rows
 *  carrying the live BOOT_ID are this process's own turns and must never
 *  be recovered (2026-08-28: the tick replayed live turns for six hours). */
const orphan = () => raw.exec("UPDATE turns_running SET boot_id = 'dead'; UPDATE turn_queue SET boot_id = 'dead'");

before(async () => {
  D = await import('../src/db.js');
  L = await import('../src/turnLock.js');
  P = await import('../src/replay.js');
  R = await import('../src/rotation.js');
  N = await import('../src/night.js');
  raw = new Database(process.env.DB_PATH!);
});

beforeEach(() => {
  L.__resetForTest();
  raw.exec(
    "DELETE FROM turns_running; DELETE FROM turn_queue; DELETE FROM pending_handoff; DELETE FROM events WHERE source IN ('restart', 'rotation'); DELETE FROM sessions; DELETE FROM usage; DELETE FROM messages; DELETE FROM friction; DELETE FROM night_settled; DELETE FROM dream_phase;",
  );
});

describe('the turn queue is a table', () => {
  it('writes a row on enqueue — every flag — and reads it back in arrival order', () => {
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'first', visible: true, userMsgId: 11, human: true });
    L.enqueue(KEY, { text: 'second', visible: false, background: true });
    const rows = raw.prepare('SELECT * FROM turn_queue ORDER BY id').all() as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].chat_id, CHAT);
    assert.equal(rows[0].slot, -1);
    assert.equal(rows[0].human, 1);
    assert.equal(rows[0].user_msg_id, 11);
    assert.equal(rows[1].background, 1, 'background was not written through the real enqueue path');
    assert.equal(rows[1].visible, 0);
    assert.equal(L.lockState()[0]!.queued, 2);
    assert.deepEqual(L.dequeue(KEY), { text: 'first', visible: true, userMsgId: 11, background: undefined, human: true });
    assert.deepEqual(L.dequeue(KEY), { text: 'second', visible: false, userMsgId: undefined, background: true, human: undefined });
    assert.equal(L.dequeue(KEY), undefined);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM turn_queue').get() as any).n, 0, 'a dequeued row survived');
  });

  it('release leaves the rows; cancel drops them; other sessions are never touched', () => {
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'mine', visible: true });
    L.enqueue(OTHER, { text: 'theirs', visible: true });
    L.release(KEY);
    assert.equal(D.queuedTurnCount(KEY), 1, 'release deleted the queue — the 2026-08-27 scenario, re-run');
    L.acquire(KEY);
    L.cancel(KEY);
    assert.equal(D.queuedTurnCount(KEY), 0, 'cancel did not drop the queue');
    assert.equal(L.dequeue(OTHER)?.text, 'theirs');
  });

  it('outlives the lock: the rows are there for a boot that never held it', () => {
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'queued before the crash', visible: true, human: true });
    const rows = D.allQueuedTurns();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, 'queued before the crash');
    assert.equal(rows[0]!.human, 1);
  });
});

describe('recovery is at-most-once, and gated', () => {
  it('takes stranded and queued rows in one transaction and a second take sees nothing', () => {
    D.beginTurn(KEY, CHAT, -1, 'in flight when it died', true, 31);
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'waiting when it died', visible: true, human: true });
    orphan();
    const first = D.takeRecoveryRows();
    assert.equal(first.stranded.length, 1);
    assert.equal(first.stranded[0]!.text, 'in flight when it died');
    assert.equal(first.stranded[0]!.human, 1);
    assert.equal(first.stranded[0]!.user_msg_id, 31);
    assert.equal(first.queued.length, 1);
    assert.deepEqual(D.takeRecoveryRows(), { stranded: [], queued: [] });
    assert.equal(D.hasRecoveryRows(), false);
  });

  it('beginTurn keeps the whole text and the provenance, not only the head', () => {
    const long = 'x'.repeat(2000);
    const id = D.beginTurn(KEY, CHAT, -1, long, false);
    const row = raw.prepare('SELECT * FROM turns_running WHERE id = ?').get(id) as any;
    assert.equal(row.text.length, 2000);
    assert.equal(row.prompt_head.length, 300);
    assert.equal(row.human, 0);
    assert.equal(row.user_msg_id, null);
  });

  it('refuses while a night is owed and leaves every row where it was', () => {
    D.beginTurn(KEY, CHAT, -1, 'asked before the fold', true);
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'and this', visible: true, human: true });
    orphan();
    const r = P.takeRecoveryIfAllowed(NOW);
    assert.ok('refused' in r, 'recovery ran with the night unpaid (I11)');
    assert.match(r.refused, /night|owed|fold/i);
    assert.equal(D.hasRecoveryRows(), true, 'the rows were taken despite the refusal');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM turns_running').get() as any).n, 1);
    assert.equal(D.queuedTurnCount(KEY), 1);
  });

  it('refuses while a pass holds the machine (dreaming outranks everything)', () => {
    N.settleTonight('dreamt', 'test fixture');
    raw.prepare("INSERT INTO dream_phase (id, scope, since, pid) VALUES (1, 'nightly', datetime('now'), ?)").run(process.pid);
    D.beginTurn(KEY, CHAT, -1, 'asked mid-pass', true);
    orphan();
    const r = P.takeRecoveryIfAllowed(NOW);
    assert.ok('refused' in r, 'recovery ran into a dreaming machine');
    assert.match(r.refused, /DREAMING/);
    assert.equal(D.hasRecoveryRows(), true);
  });

  it("leaves this process's own live turns alone — only a dead process's rows are stranded", () => {
    D.beginTurn(KEY, CHAT, -1, 'in flight right now', true, 77);
    L.acquire(KEY);
    L.enqueue(KEY, { text: 'waiting behind it', visible: true, human: true });
    assert.equal(D.hasRecoveryRows(), false, 'a live turn reads as stranded');
    assert.deepEqual(D.takeRecoveryRows(), { stranded: [], queued: [] });
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM turns_running').get() as any).n, 1, 'the live row was taken');
    assert.equal(D.queuedTurnCount(KEY), 1, 'the live queue row was taken');
    // A dead process's row next to it IS taken, and only it.
    raw.prepare("INSERT INTO turns_running (session_key, chat_id, slot, prompt_head, text, human, boot_id) VALUES (?, ?, -1, 'old', 'left by the last process', 1, 'dead')").run(OTHER, 9);
    assert.equal(D.hasRecoveryRows(), true);
    const taken = D.takeRecoveryRows();
    assert.equal(taken.stranded.length, 1);
    assert.equal(taken.stranded[0]!.text, 'left by the last process');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM turns_running').get() as any).n, 1);
  });

  it('takes and plans once the day is allowed — the gate opening is the only door', () => {
    D.beginTurn(KEY, CHAT, -1, 'asked before the fold', true);
    orphan();
    assert.ok('refused' in P.takeRecoveryIfAllowed(NOW));
    N.settleTonight('dreamt', 'test fixture');
    const r = P.takeRecoveryIfAllowed(NOW);
    assert.ok('plan' in r, 'still refused with the night settled');
    assert.equal(r.plan.replay.length, 1);
    assert.equal(D.hasRecoveryRows(), false);
    assert.ok('plan' in P.takeRecoveryIfAllowed(NOW), 'not idempotent');
  });
});

describe('the recovery plan is a rule', () => {
  const stranded = (text: string, human: number, at = NOW, userMsgId: number | null = null) =>
    ({ id: 1, session_key: KEY, chat_id: CHAT, slot: -1, prompt_head: text.slice(0, 300), started_at: at, text, human, user_msg_id: userMsgId }) as any;
  const queued = (text: string, human: number, extra: Partial<{ visible: number; background: number; user_msg_id: number | null; created_at: string }> = {}) =>
    ({ id: 2, session_key: KEY, chat_id: CHAT, slot: -1, text, visible: 1, background: 0, user_msg_id: null, human, created_at: NOW, ...extra }) as any;

  it("replays a person's in-flight turn with a framing that says so, carrying the message id", () => {
    const plan = P.planRecovery([stranded('what did the plumber replace?', 1, NOW, 77)], [], NOW);
    assert.equal(plan.report.length, 0);
    assert.equal(plan.replay.length, 1);
    const r = plan.replay[0]!;
    assert.ok(r.text.startsWith(P.REPLAY_MARK), r.text);
    assert.match(r.text, /received 2026-08-27 \d\d:\d\d local, never answered\]\nwhat did the plumber/);
    assert.equal(r.original, 'what did the plumber replace?');
    assert.equal(r.userMsgId, 77);
    assert.equal(r.human, true);
    assert.equal(r.origin, 'in-flight');
  });

  it("reports a machine's in-flight turn and never re-runs it", () => {
    const plan = P.planRecovery([stranded('[COMMITMENT · check-in] fired', 0)], [], NOW);
    assert.equal(plan.replay.length, 0);
    assert.equal(plan.report.length, 1);
  });

  it('reports — does not loop — a replay that died again', () => {
    const plan = P.planRecovery([stranded(P.replayFraming('crashes every time', NOW), 1)], [], NOW);
    assert.equal(plan.replay.length, 0);
    assert.equal(plan.abandoned.length, 1);
  });

  it('runs every queued turn, oldest first, with its original flags; a person is framed as a replay, a machine as late', () => {
    const plan = P.planRecovery([], [queued('a person', 1, { user_msg_id: 7 }), queued('[PULSE] a machine', 0, { visible: 0, background: 1 })], NOW);
    assert.equal(plan.replay.length, 2);
    assert.ok(plan.replay[0]!.text.startsWith(P.REPLAY_MARK));
    assert.equal(plan.replay[0]!.userMsgId, 7);
    assert.ok(plan.replay[1]!.text.startsWith(P.QUEUED_MARK), plan.replay[1]!.text);
    assert.match(plan.replay[1]!.text, /^\[QUEUED at \d\d:\d\d local, running now\]\n\[PULSE\] a machine$/);
    assert.equal(plan.replay[1]!.original, '[PULSE] a machine');
    assert.equal(plan.replay[1]!.visible, false);
    assert.equal(plan.replay[1]!.background, true);
    assert.equal(plan.replay[1]!.human, false);
  });

  it('drops a queued MACHINE turn past the six-hour bound and keeps one inside it; a person is never dropped', () => {
    const stale = queued('[COMMITMENT · check-in] fired', 0, { created_at: '2026-08-27 03:14:00' }); // 361 min
    const fresh = queued('[PULSE] due', 0, { created_at: '2026-08-27 03:15:00' }); // 360 min
    const person = queued('still waiting', 1, { created_at: '2026-08-26 09:00:00' });
    const plan = P.planRecovery([], [stale, fresh, person], NOW);
    assert.deepEqual(plan.expired.map((q) => q.text), ['[COMMITMENT · check-in] fired']);
    assert.deepEqual(plan.replay.map((r) => r.original), ['[PULSE] due', 'still waiting']);
  });

  it('does not frame twice', () => {
    const already = queued(P.queuedFraming('late once', NOW), 0);
    const plan = P.planRecovery([], [already], NOW);
    assert.equal(plan.replay[0]!.text, already.text);
  });

  it('puts in-flight human turns before the queue', () => {
    const plan = P.planRecovery([stranded('asked first', 1)], [queued('asked second', 1)], NOW);
    assert.deepEqual(plan.replay.map((r) => r.origin), ['in-flight', 'queued']);
  });

  it('tallies killed and replayed from the event log, zeros as zeros', () => {
    assert.deepEqual(P.restartTally(CHAT, ...ALL), { killed: 0, replayed: 0 });
    D.postEvent(CHAT, P.RESTART_SOURCE, P.restartEventBody('killed', 'a commitment'));
    D.postEvent(CHAT, P.RESTART_SOURCE, P.restartEventBody('abandoned', 'a looping replay'));
    D.postEvent(CHAT, P.RESTART_SOURCE, P.restartEventBody('expired', 'a stale check-in'));
    D.postEvent(CHAT, P.RESTART_SOURCE, P.restartEventBody('replayed', 'in-flight: a person'));
    D.postEvent(CHAT, P.RESTART_SOURCE, P.restartEventBody('replayed', 'queued: another'));
    D.postEvent(CHAT + 1, P.RESTART_SOURCE, P.restartEventBody('replayed', 'someone else'));
    assert.deepEqual(P.restartTally(CHAT, ...ALL), { killed: 3, replayed: 2 });
  });
});

describe('the handoff is a row', () => {
  function rotatedSession(): string {
    raw
      .prepare(
        'INSERT INTO usage (session_key, input_tokens, cache_read, cache_creation, num_turns, context_window, context_tokens) VALUES (?, 100, 0, 0, 1, 1000000, 250000)',
      )
      .run(KEY);
    raw
      .prepare("INSERT INTO messages (session_key, role, content, created_at, source) VALUES (?, 'user', 'earlier today', '2026-08-27 08:15:00', 'human')")
      .run(KEY);
    D.setSessionId(KEY, 'sess-old', 'concierge:1');
    const handoff = R.rotateIfDue(CHAT, KEY, false, NOW);
    assert.ok(handoff, 'the fixture did not rotate');
    return handoff;
  }

  it('is persisted at rotation and delivered to the empty session until a new one acks', () => {
    const handoff = rotatedSession();
    const row = D.pendingHandoffRow(KEY);
    assert.ok(row, 'no pending_handoff row after a rotation');
    assert.equal(row!.text, handoff);
    assert.equal(row!.reason, 'idle-threshold');
    assert.equal(D.storedSessionId(KEY), undefined, 'the rotation did not clear the session');
    // A "restart": nothing in memory, only the DB. Delivered — and delivered
    // again, because composing a prompt is not a session having received it.
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), handoff);
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), handoff);
    R.consumeHandoff(KEY);
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), undefined);
    assert.equal(D.pendingHandoffRow(KEY), undefined);
  });

  it('is never delivered over a stored session', () => {
    D.savePendingHandoff(KEY, 'stale note', 'ceiling');
    D.setSessionId(KEY, 'sess-new', 'concierge:1');
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), undefined);
  });

  it('is delivered at exactly the TTL and dropped, with an event, one minute past it', () => {
    D.savePendingHandoff(KEY, 'at the edge', 'idle-threshold');
    raw.prepare("UPDATE pending_handoff SET created_at = '2026-08-27 03:15:00' WHERE session_key = ?").run(KEY); // 360 min
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), 'at the edge');
    raw.prepare("UPDATE pending_handoff SET created_at = '2026-08-27 03:14:00' WHERE session_key = ?").run(KEY); // 361 min
    assert.equal(R.pendingHandoff(CHAT, KEY, NOW), undefined);
    assert.equal(D.pendingHandoffRow(KEY), undefined, 'a stale row lingered');
    const ev = raw.prepare("SELECT body FROM events WHERE chat_id = ? AND source = 'rotation' ORDER BY id DESC LIMIT 1").get(CHAT) as any;
    assert.match(ev.body, /handoff dropped: 6h old \(idle-threshold\)/);
  });

  it('is cleared by a deliberate clear — the clear supersedes the rotation', () => {
    D.savePendingHandoff(KEY, 'about to be superseded', 'idle-threshold');
    D.clearSession(KEY);
    assert.equal(D.pendingHandoffRow(KEY), undefined);
  });
});
