import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clearSession, getSessionId, setSessionId, storedSessionId } from '../src/db.js';

/**
 * A RESUME IS A PROMISE THAT THE WORLD STILL EXISTS.
 *
 * A stored session id says "this transcript is worth continuing". That stops
 * being true when the agent's world changes, not merely when its history grows:
 * stripping the worker to its brief deleted five of its tools in one commit, and
 * every stored worker session instantly became a 629k-token history of calls to
 * tools that were gone, assembled from context the worker could no longer see.
 * Resuming one pays full price to re-cache a transcript that then misleads the
 * model about what it can do.
 *
 * The rule cannot be "remember to clear sessions when you change the tools"
 * (I9): the contract is derived from the tool list, so changing the tools IS the
 * invalidation. What has to hold is the pair below — a mismatched contract never
 * resumes, and the id survives anyway so the transcript stays readable.
 */

const KEY = 'test-contract:0';
const A = 'worker:2/aaaaaaaa';
const B = 'worker:2/bbbbbbbb';

describe('resuming a session', () => {
  it('resumes only under the contract it was built with', () => {
    clearSession(KEY);
    setSessionId(KEY, 'session-one', A);
    assert.equal(getSessionId(KEY, A), 'session-one');
    assert.equal(getSessionId(KEY, B), undefined, 'a changed tool set must not resume');
    clearSession(KEY);
  });

  it('keeps the id readable even when it may not be resumed', () => {
    // The transcript is still the record of what happened — locateThreadTrace
    // and findPastWork read it. Invalidating a resume must not lose the history.
    clearSession(KEY);
    setSessionId(KEY, 'session-one', A);
    assert.equal(storedSessionId(KEY), 'session-one');
    assert.equal(getSessionId(KEY, B), undefined);
    assert.equal(storedSessionId(KEY), 'session-one', 'the id must survive the refusal');
    clearSession(KEY);
  });

  it('refuses every session written before contracts existed', () => {
    // The migration backfills '' — the honest answer for a row whose world was
    // never recorded, and the reason today's 49 stored sessions all start fresh.
    clearSession(KEY);
    setSessionId(KEY, 'legacy-session');
    assert.equal(getSessionId(KEY, A), undefined);
    assert.equal(storedSessionId(KEY), 'legacy-session');
    clearSession(KEY);
  });
});
