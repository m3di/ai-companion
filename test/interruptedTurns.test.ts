import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { beginTurn, clearStrandedTurns, endTurn, strandedTurns } from '../src/db.js';

/**
 * A TURN THAT DID NOT FINISH MUST LEAVE A TRACE (Charter I8's sibling: the
 * system has to be able to see its own failures).
 *
 * Liveness used to live only in memory — the `running` map and the badges map —
 * so a process that died mid-turn left nothing at all behind. No result event
 * means no usage row, and badges rebuild from scratch, so after a restart an
 * interrupted thread and an idle one are indistinguishable. On 2026-08-02 a
 * `tsx watch` restart killed slot 46 mid-edit and the concierge spent the next
 * 34 minutes telling Mehdi the worker was "actively running".
 *
 * The property that fixes it is narrow and worth pinning exactly: a row exists
 * for precisely the turns that started and did not end. Both directions matter
 * — a leaked row makes boot cry wolf about work that completed fine, which is
 * how a real warning gets trained into background noise.
 */

describe('turns that were still running when the process stopped', () => {
  it('leaves a row for the killed turn and none for the finished one', () => {
    clearStrandedTurns();
    const killed = beginTurn('test:46', 1, 46, 'finish the json, commit and push');
    const finished = beginTurn('test:-1', 1, -1, 'continue please');
    endTurn(finished);

    const left = strandedTurns();
    assert.equal(left.length, 1);
    assert.equal(left[0]?.id, killed);
    assert.equal(left[0]?.slot, 46);
    clearStrandedTurns();
  });

  it('carries enough to say WHAT was interrupted, not just that something was', () => {
    // The report is only useful if it names the thread and the instruction —
    // "a turn died" sends the user hunting; "slot 46 was asked to finish the
    // json" sends them to the repo.
    clearStrandedTurns();
    beginTurn('test:46', 7, 46, 'finish   the json,\ncommit and push');
    const [t] = strandedTurns();
    assert.equal(t?.chat_id, 7);
    assert.equal(t?.slot, 46);
    assert.equal(t?.prompt_head, 'finish the json, commit and push', 'whitespace is flattened for a one-line report');
    assert.ok(t?.started_at, 'when it died is half the story');
    clearStrandedTurns();
  });

  it('is empty after a clean run, so boot stays silent', () => {
    clearStrandedTurns();
    const id = beginTurn('test:0', 1, 0, 'do a thing');
    endTurn(id);
    assert.equal(strandedTurns().length, 0);
  });
});
