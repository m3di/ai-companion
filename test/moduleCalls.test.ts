import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callerBreakdown, logModuleCall, moduleCallsBetween } from '../src/db.js';

/**
 * THE CALL LOG.
 *
 * This table exists to answer one question — "did the DAY reach for memory?" —
 * and the honest failure mode is that a broken logger makes a quiet failure
 * indistinguishable from a quiet day. So the contract is: it records who and
 * what was touched, it survives bad input, and it never throws.
 */

const WIDE = ['1970-01-01 00:00:00', '2999-01-01 00:00:00'] as const;
// The rows THIS run wrote. `moduleCallsBetween` is capped, and on 2026-09-05
// the live log crossed the cap — so "the last row of the whole window" stopped
// being the row just written, and the suite went red on a full table rather
// than on a broken logger. A window that starts a minute ago cannot fill.
const recentUtc = () => new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ');
const last = () => moduleCallsBetween(recentUtc(), WIDE[1]).at(-1)!;

describe('the module call log', () => {
  it('records who called, and the nodes the call touched', () => {
    logModuleCall({
      sessionKey: 'test:concierge',
      module: 'entities',
      fn: 'find',
      args: '["core-api/monolith"]',
      ok: true,
      ms: 12,
      refs: ['core-api/monolith', 'core-api/monolith', 'people/mehdi'],
    });
    const row = last();
    assert.equal(row.session_key, 'test:concierge');
    assert.equal(row.fn, 'find');
    assert.equal(row.ok, 1);
    // Deduplicated on the way in: the same node named in both the args and the
    // result is one node touched, not two.
    assert.deepEqual(row.refs, ['core-api/monolith', 'people/mehdi']);
  });

  it('attributes calls per caller — the number M4 is judged on', () => {
    const before = callerBreakdown(...WIDE).find((c) => c.session_key === 'test:worker')?.calls ?? 0;
    logModuleCall({ sessionKey: 'test:worker', module: 'entities', fn: 'openLoops', args: '[]', ok: true, ms: 3, refs: [] });
    logModuleCall({ sessionKey: 'test:worker', module: 'entities', fn: 'find', args: '[]', ok: true, ms: 3, refs: [] });
    const row = callerBreakdown(...WIDE).find((c) => c.session_key === 'test:worker')!;
    assert.equal(row.calls, before + 2);
    assert.equal(row.fns, 2, 'distinct functions per caller is what tells breadth from repetition');
  });

  it('keeps a failed call — a call that found nothing is the signal, not noise', () => {
    logModuleCall({ sessionKey: 'test:fail', module: 'entities', fn: 'find', args: '["nope/nope"]', ok: false, ms: 1, refs: [] });
    assert.equal(last().ok, 0);
  });

  it('never throws, whatever it is handed', () => {
    assert.doesNotThrow(() =>
      logModuleCall({ module: 'entities', fn: 'x', args: 'y'.repeat(5000), ok: true, ms: 0, refs: Array(500).fill('a/b') }),
    );
    const row = last();
    assert.ok(row.args.length <= 400, 'args were not capped');
    assert.ok(row.refs.length <= 40, 'refs were not capped');
    assert.equal(row.session_key, null, 'a caller-less run must still be logged');
  });

  it('windows on the same bounds a dream carries', () => {
    // The cycle view joins on dreams.covers_from/covers_to, so the log has to
    // answer for an arbitrary window, not just "recently".
    assert.equal(moduleCallsBetween('2999-01-01 00:00:00', '2999-01-02 00:00:00').length, 0);
    assert.ok(moduleCallsBetween(...WIDE).length > 0);
  });
});
