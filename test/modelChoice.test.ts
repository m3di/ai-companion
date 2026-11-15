import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

import { turnOptions } from '../src/modelChoice.js';

/**
 * WHO RUNS ON WHAT (src/modelChoice.ts, chat_sessions.model/effort).
 *
 * Until 2026-08-27 one CLAUDE_MODEL ran the concierge, every worker and the
 * night at default effort. The resolution order is now a pure function and
 * a thread pref, pinned here:
 *   - THE CONCIERGE KEEPS CLAUDE_MODEL at its configured effort, whatever any
 *     thread stored.
 *   - A WORKER RUNS WHAT ITS DISPATCH CHOSE, else the deployment's worker
 *     defaults; a stored effort the config does not know falls back rather
 *     than reaching the SDK.
 *   - THE PREF IS A ROW on the thread, and a partial choice keeps the other
 *     half (the dispatch tool merges; the row stores what it is given).
 *
 * Own database for the row half: the suite runs files in parallel.
 */

const cfg = { model: 'claude-opus-4-8', conciergeEffort: 'medium' as const, workerModel: 'sonnet', workerEffort: 'medium' as const };

describe('turnOptions', () => {
  it('the control slot runs CLAUDE_MODEL at the concierge effort, ignoring any thread pref', () => {
    assert.deepEqual(turnOptions({ isControl: true, thread: { model: 'haiku', effort: 'low' }, config: cfg }), {
      model: 'claude-opus-4-8',
      effort: 'medium',
    });
  });

  it('a worker with no pref runs the deployment worker defaults', () => {
    assert.deepEqual(turnOptions({ isControl: false, config: cfg }), { model: 'sonnet', effort: 'medium' });
    assert.deepEqual(turnOptions({ isControl: false, thread: {}, config: cfg }), { model: 'sonnet', effort: 'medium' });
  });

  it('a worker runs what its dispatch chose', () => {
    assert.deepEqual(turnOptions({ isControl: false, thread: { model: 'opus', effort: 'high' }, config: cfg }), {
      model: 'opus',
      effort: 'high',
    });
  });

  it('half a pref keeps the default for the other half', () => {
    assert.deepEqual(turnOptions({ isControl: false, thread: { model: 'haiku' }, config: cfg }), { model: 'haiku', effort: 'medium' });
    assert.deepEqual(turnOptions({ isControl: false, thread: { effort: 'low' }, config: cfg }), { model: 'sonnet', effort: 'low' });
  });

  it('an effort the config does not know falls back instead of reaching the SDK', () => {
    assert.deepEqual(turnOptions({ isControl: false, thread: { effort: 'max' }, config: cfg }), { model: 'sonnet', effort: 'medium' });
    assert.deepEqual(turnOptions({ isControl: true, config: { ...cfg, conciergeEffort: 'ultra' as never } }), {
      model: 'claude-opus-4-8',
      effort: undefined,
    });
  });

  it('with no worker default configured, a worker inherits CLAUDE_MODEL', () => {
    assert.equal(turnOptions({ isControl: false, config: { ...cfg, workerModel: '' } }).model, 'claude-opus-4-8');
  });
});

describe('the thread pref row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelchoice-'));
  process.env.DB_PATH = join(dir, 'modelchoice-test.db');
  process.env.KNOWLEDGE_DIR = join(dir, 'kb');
  type Db = typeof import('../src/db.js');
  let D: Db;
  const CHAT = 5151;
  let slot: number;

  before(async () => {
    D = await import('../src/db.js');
    slot = D.createSession(CHAT, 'sized worker');
  });

  it('starts unset — the deployment default applies', () => {
    assert.deepEqual(D.threadModel(CHAT, slot), { model: undefined, effort: undefined });
  });

  it('stores what it is given and reads it back', () => {
    D.setThreadModel(CHAT, slot, { model: 'opus', effort: 'high' });
    assert.deepEqual(D.threadModel(CHAT, slot), { model: 'opus', effort: 'high' });
  });

  it('a partial write clears the half it was not given (the dispatch tool merges before writing)', () => {
    D.setThreadModel(CHAT, slot, { model: 'haiku' });
    assert.deepEqual(D.threadModel(CHAT, slot), { model: 'haiku', effort: undefined });
  });

  it('an unknown slot reads as unset, never throws', () => {
    assert.deepEqual(D.threadModel(CHAT, 9999), { model: undefined, effort: undefined });
  });

  it('the usage row records the effort a turn ran at', () => {
    D.saveUsage(`${CHAT}:${slot}`, {
      model: 'sonnet',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      durationMs: 1,
      numTurns: 1,
      contextWindow: 200_000,
      effortAsked: 'low',
    });
    const t = D.costTally('1970-01-01 00:00:00', '2999-01-01 00:00:00');
    const worker = t.roles.find((r) => r.role === 'worker')!;
    assert.deepEqual(worker.models, [{ model: 'sonnet', effort: 'low', turns: 1, usd: 0.01 }]);
  });
});
