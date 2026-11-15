import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import { costLine } from '../src/costLine.js';

/**
 * THE COST LINE (db.ts costTally / costPerDay, src/costLine.ts, audit costLineFrom).
 *
 * 2026-08-27: the week had cost ~$375 and nobody had a line to read it from —
 * the ledger existed, the number did not. Pinned here:
 *   - ONE CLASSIFIER. Every key saveUsage writes lands in its role: slot -1 the
 *     concierge, a numeric slot a worker, :operator/:defrag/:reform/:distill/
 *     :digest (and the retired :dream/:grow) the night, :brief the summarizer,
 *     anything else 'other' — and /stats folds through the same function.
 *   - ZEROS ARE ZEROS: a window with no rows still prints the three roles.
 *   - EVERY ROLE NAMES ITS MODEL AND THE EFFORT IT ASKED FOR.
 *   - THE DAILY SERIES HAS EVERY DAY, quiet ones at zero; the audit's baseline
 *     is the days that spent, and it fires only past the named ratio.
 *   - THE WARM-THREAD BACKFILL RUNS ONCE, pins only threads with a session,
 *     and leaves a named row behind.
 *
 * Own database: the suite runs files in parallel against one scratch DB.
 */

const dir = mkdtempSync(join(tmpdir(), 'cost-'));
process.env.DB_PATH = join(dir, 'cost-test.db');
process.env.KNOWLEDGE_DIR = join(dir, 'kb');

type Db = typeof import('../src/db.js');
type Audit = typeof import('../src/audit.js');
let D: Db;
let A: Audit;
let raw: Database.Database;

function seed(key: string, model: string, effort: string, usd: number, at: string): void {
  raw
    .prepare('INSERT INTO usage (session_key, model, effort_asked, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(key, model, effort, usd, at);
}

before(async () => {
  D = await import('../src/db.js');
  A = await import('../src/audit.js');
  raw = new Database(process.env.DB_PATH!);
});

describe('costRoleOf — every key saveUsage writes', () => {
  it('reads the role off the key tail', () => {
    assert.equal(D.costRoleOf('121628633:-1'), 'concierge');
    assert.equal(D.costRoleOf('121628633:42'), 'worker');
    assert.equal(D.costRoleOf('121628633:0'), 'worker');
    for (const k of ['operator', 'defrag', 'reform', 'distill', 'digest', 'dream', 'grow']) {
      assert.equal(D.costRoleOf(`121628633:${k}`), 'night', k);
    }
    assert.equal(D.costRoleOf('undefined:reform'), 'night');
    assert.equal(D.costRoleOf('121628633:brief'), 'brief');
    assert.equal(D.costRoleOf('atlas'), 'other');
    assert.equal(D.costRoleOf('(none)'), 'other');
  });
});

describe('costTally', () => {
  it('an empty window is zeros for every role, not nothing', () => {
    const t = D.costTally('2030-01-01 00:00:00', '2030-01-02 00:00:00');
    assert.equal(t.total, 0);
    assert.equal(t.turns, 0);
    assert.deepEqual(
      t.roles.map((r) => [r.role, r.turns, r.usd]),
      [
        ['concierge', 0, 0],
        ['worker', 0, 0],
        ['night', 0, 0],
        ['brief', 0, 0],
        ['other', 0, 0],
      ],
    );
    assert.equal(costLine(t), '  -> COST: $0.00 over 0 turn(s) — concierge no turns · worker no turns · night no turns');
  });

  it('sums by role and names model + effort asked, splitting a role that ran two', () => {
    seed('7:-1', 'claude-opus-4-8', 'medium', 1.0, '2026-08-27 10:00:00');
    seed('7:-1', 'claude-opus-4-8', 'medium', 0.5, '2026-08-27 11:00:00');
    seed('7:3', 'sonnet', 'medium', 0.2, '2026-08-27 10:30:00');
    seed('7:3', 'opus', 'high', 2.0, '2026-08-27 10:40:00');
    seed('7:operator', 'claude-opus-4-8', '', 3.0, '2026-08-27 04:00:00');
    seed('7:brief', 'claude-haiku-4-5-20251001', 'low', 0.01, '2026-08-27 10:41:00');
    seed('atlas', 'x', '', 0.05, '2026-08-27 10:41:00');
    seed('7:-1', 'claude-opus-4-8', 'medium', 9.0, '2026-08-28 10:00:00'); // outside
    const t = D.costTally('2026-08-27 00:00:00', '2026-08-27 23:59:59');
    assert.equal(Number(t.total.toFixed(2)), 6.76);
    assert.equal(t.turns, 7);
    const by = Object.fromEntries(t.roles.map((r) => [r.role, r]));
    assert.equal(by.concierge!.turns, 2);
    assert.equal(by.concierge!.usd, 1.5);
    assert.deepEqual(by.concierge!.models, [{ model: 'claude-opus-4-8', effort: 'medium', turns: 2, usd: 1.5 }]);
    assert.deepEqual(
      by.worker!.models.map((m) => [m.model, m.effort, m.turns, m.usd]),
      [
        ['opus', 'high', 1, 2.0],
        ['sonnet', 'medium', 1, 0.2],
      ],
    );
    assert.equal(by.night!.usd, 3.0);
    assert.equal(by.brief!.usd, 0.01);
    assert.equal(by.other!.usd, 0.05);
    const line = costLine(t);
    assert.equal(
      line,
      '  -> COST: $6.76 over 7 turn(s) — ' +
        'concierge $1.50 over 2 turn(s) at $0.75/turn [claude-opus-4-8/medium(asked) $1.50 ×2] · ' +
        'worker $2.20 over 2 turn(s) at $1.10/turn [opus/high(asked) $2.00 ×1, sonnet/medium(asked) $0.20 ×1] · ' +
        'night $3.00 over 1 turn(s) at $3.00/turn [claude-opus-4-8 $3.00 ×1] · ' +
        'brief $0.01 over 1 turn(s) at $0.01/turn [claude-haiku-4-5-20251001/low(asked) $0.01 ×1] · ' +
        'other $0.05 over 1 turn(s) at $0.05/turn [x $0.05 ×1]',
    );
  });

  it('/stats folds through the same classifier — a brief is never a Worker', () => {
    const s = D.statsRollup(7);
    const areas = Object.fromEntries(s.byArea.map((a) => [a.area, a]));
    assert.equal(areas.Brief!.runs, 1);
    assert.equal(areas.Night!.runs, 1);
    assert.equal(areas.Workers!.runs, 2);
    assert.equal(areas.Concierge!.runs, 3);
    assert.equal(areas.Other, undefined);
  });
});

describe('costPerDay and the audit line', () => {
  it('fills every day in the range, quiet ones at zero', () => {
    const days = D.costPerDay('2026-08-25', '2026-08-28');
    assert.deepEqual(
      days.map((d) => [d.day, Number(d.usd.toFixed(2))]),
      [
        ['2026-08-25', 0],
        ['2026-08-26', 0],
        ['2026-08-27', 6.76],
        ['2026-08-28', 9.0],
      ],
    );
  });

  it('averages over the days that spent, fires only past the ratio, prints the number either way', () => {
    const quiet = A.costLineFrom([
      { day: '2026-08-19', usd: 0 },
      { day: '2026-08-20', usd: 10 },
      { day: '2026-08-21', usd: 12 },
      { day: '2026-08-22', usd: 14 },
    ]);
    assert.equal(quiet.fired, false);
    assert.equal(quiet.text, '$14.00 on 2026-08-22; 3-day average over 2 active day(s) $11.00.');
    const spike = A.costLineFrom([
      { day: '2026-08-20', usd: 10 },
      { day: '2026-08-21', usd: 10 },
      { day: '2026-08-22', usd: 10 * A.COST_SPIKE_RATIO + 0.01 },
    ]);
    assert.equal(spike.fired, true);
    assert.match(spike.text, /over 1\.5×/);
    const edge = A.costLineFrom([
      { day: '2026-08-20', usd: 10 },
      { day: '2026-08-21', usd: 10 * A.COST_SPIKE_RATIO },
    ]);
    assert.equal(edge.fired, false);
    const alone = A.costLineFrom([{ day: '2026-08-21', usd: 5 }]);
    assert.equal(alone.fired, false);
    assert.match(alone.text, /no prior day with spend/);
    assert.equal(A.costLineFrom([]).fired, false);
  });
});

describe('the warm-thread backfill', () => {
  it('pins threads with a stored session to the previous default, once, and leaves a row', () => {
    // The module ran it at import against an empty database; reset the marker to exercise it.
    raw.prepare("DELETE FROM backfills WHERE name = 'thread-model-2026-08-27'").run();
    const CHAT = 31;
    const warm = D.createSession(CHAT, 'warm');
    const cold = D.createSession(CHAT, 'cold');
    const chosen = D.createSession(CHAT, 'chosen');
    D.setSessionId(`${CHAT}:${warm}`, 'sess-warm', 'worker:1');
    D.setSessionId(`${CHAT}:${chosen}`, 'sess-chosen', 'worker:1');
    D.setThreadModel(CHAT, chosen, { model: 'haiku' });
    assert.equal(D.backfillThreadModels('opus'), 1);
    assert.deepEqual(D.threadModel(CHAT, warm), { model: 'opus', effort: undefined });
    assert.deepEqual(D.threadModel(CHAT, cold), { model: undefined, effort: undefined });
    assert.deepEqual(D.threadModel(CHAT, chosen), { model: 'haiku', effort: undefined });
    // Once: a later thread with a session and no model is NOT pinned.
    const later = D.createSession(CHAT, 'later');
    D.setSessionId(`${CHAT}:${later}`, 'sess-later', 'worker:1');
    assert.equal(D.backfillThreadModels('opus'), 0);
    assert.deepEqual(D.threadModel(CHAT, later), { model: undefined, effort: undefined });
    const row = raw.prepare("SELECT note FROM backfills WHERE name = 'thread-model-2026-08-27'").get() as { note: string };
    assert.match(row.note, /1 warm thread\(s\) pinned to opus/);
  });
});
