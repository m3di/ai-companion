import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  clearSession,
  createSession,
  getSessionId,
  isThreadFresh,
  setSessionId,
  setSessionStatus,
  sessionKey,
  setThreadFresh,
} from '../src/db.js';

/**
 * WARM OR FRESH — does a worker remember its own previous runs?
 *
 * On 2026-08-19 the Morning Routine emitted a standup line about stagebox PROD and
 * Fabrikam #2613 that Mehdi had explicitly closed the day before. Every durable
 * store was right: commitment #108 closed on 08-16, the tree note corrected by
 * the concierge, both observations folded into the graph that night. The worker
 * read none of them — it resumes the same session every morning and rebuilt the
 * sheet from its own previous output. Workers produced 17 retrieval episodes
 * that day and every single one scored `no-reach`, so nothing the day or the
 * night wrote could ever have reached it.
 *
 * Two properties, and the second is the one that makes the first worth having:
 *
 *   1. The switch exists at all. Before this there was NO path to reset a
 *      worker's context — `clearSession` was called on the concierge slot and
 *      nowhere else in the codebase.
 *   2. It is enforced at DISPATCH, not remembered. A policy that has to be
 *      recalled at the moment it matters is exactly what failed here, and the
 *      concierge's memory is cleared every night besides.
 */

const CHAT = -880_001;
const made: number[] = [];

after(() => {
  for (const slot of made) setSessionStatus(CHAT, slot, 'archived');
});

function thread(title: string): number {
  const slot = createSession(CHAT, title);
  made.push(slot);
  return slot;
}

describe('a worker that remembers, and one that does not', () => {
  it('is WARM by default — work that spans days must not forget it', () => {
    const slot = thread('a long migration');
    assert.equal(isThreadFresh(CHAT, slot), false, 'a new worker defaulted to forgetting');
  });

  it('keeps its session when warm, so a multi-day task accumulates', () => {
    const slot = thread('warm worker');
    setSessionId(sessionKey(CHAT, slot), 'session-abc', 'default');
    assert.equal(getSessionId(sessionKey(CHAT, slot), 'default'), 'session-abc');
  });

  it('can be told to forget, and the setting is a property of the THREAD', () => {
    // Not of the dispatch, and not of the concierge's memory — the concierge is
    // cleared every night, so a policy held there would evaporate nightly and
    // the routine would silently go warm again.
    const slot = thread('daily standup');
    setThreadFresh(CHAT, slot, true);
    assert.equal(isThreadFresh(CHAT, slot), true);
  });

  it('can be turned back to warm, because the right answer differs per task', () => {
    const slot = thread('sometimes warm');
    setThreadFresh(CHAT, slot, true);
    setThreadFresh(CHAT, slot, false);
    assert.equal(isThreadFresh(CHAT, slot), false);
  });

  it('leaves other threads alone', () => {
    const a = thread('routine');
    const b = thread('long task');
    setThreadFresh(CHAT, a, true);
    assert.equal(isThreadFresh(CHAT, a), true);
    assert.equal(isThreadFresh(CHAT, b), false, 'marking one worker fresh changed another');
  });

  it('reports false for a slot that does not exist, rather than throwing', () => {
    assert.equal(isThreadFresh(CHAT, 9_999), false);
  });

  it('can be made permanent at the moment the operator is already reasoning about it', () => {
    // The gap that produced the workaround on 2026-08-19: `fresh` could only be
    // set by DISPATCHING, so a concierge deciding the policy at 16:32 — while
    // not dispatching — had no way to store it and wrote the rule into two
    // commitment bodies instead. That is a reminder to a context that gets
    // cleared every night, not a mechanism. The switch now lives where the
    // decision is made.
    const slot = thread('stale routine');
    setThreadFresh(CHAT, slot, true);
    assert.equal(isThreadFresh(CHAT, slot), true, 'the policy could not be set without a dispatch');
  });

  it('forgetting actually drops the resumable session', () => {
    // The half of the mechanism the dispatch branch depends on: `fresh` is only
    // a flag, and it means nothing unless clearing really severs the thing the
    // SDK would otherwise resume. Asserted here because the branch itself lives
    // in the dispatch loop, which no unit test can reach.
    const slot = thread('forgetful');
    const key = sessionKey(CHAT, slot);
    setSessionId(key, 'session-to-forget', 'default');
    assert.equal(getSessionId(key, 'default'), 'session-to-forget');
    clearSession(key);
    assert.equal(getSessionId(key, 'default'), undefined, 'the worker would have resumed its old conversation anyway');
  });
});
