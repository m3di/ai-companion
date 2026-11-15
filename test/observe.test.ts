import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inboxDepth, pendingObservations, foldObservation, unattributedRefs } from '../src/db.js';
import { captureObservation, inboxLine } from '../src/observe.js';

/**
 * THE OBSERVATION INBOX — the day's write path (Charter M1).
 *
 * What has to hold is not that rows get stored; it is that a ref is RESOLVED at
 * capture time and that a ref resolving to nothing is kept rather than dropped.
 * The first is what lets the night fold without re-reading the day; the second
 * is the only honest signal for where the graph should grow. A version of this
 * that quietly discarded unknown names would look identical in every log and
 * would silently delete the whole discovery half.
 *
 * These run against a snapshot of the real graph (test/prepare.ts), so the refs
 * below are real entities — which also makes this a live check that the tree
 * still parses and that `people/mehdi` is still where M0 put him.
 */

const capture = (text: string, about: string[]) => captureObservation({ text, about, source: 'test' });

describe('capturing an observation', () => {
  it('stores the canonical id, whatever name the agent used', () => {
    // A short name and the full id are the same node; both must land as the id,
    // because a stored alias is a second name someone has to maintain.
    const byTail = capture('mehdi is the actor here', ['mehdi']);
    const byId = capture('and again, by full id', ['people/mehdi']);
    assert.deepEqual(byTail.resolved, ['people/mehdi']);
    assert.deepEqual(byId.resolved, ['people/mehdi']);
    assert.deepEqual(byTail.unresolved, []);
  });

  it('collapses two names for one entity into one ref', () => {
    const c = capture('named twice', ['mehdi', 'people/mehdi', 'MEHDI']);
    assert.deepEqual(c.resolved, ['people/mehdi']);
  });

  it('keeps a name that resolves to nothing — that is the signal, not an error', () => {
    const c = capture('something about a thing we have never recorded', ['not-a-real-entity-xyz']);
    assert.deepEqual(c.resolved, []);
    assert.deepEqual(c.unresolved, ['not-a-real-entity-xyz']);
    assert.ok(c.id > 0, 'the row is stored anyway');
  });

  it('keeps the resolved and the unresolved halves of one observation', () => {
    const c = capture('half of this lands', ['mehdi', 'not-a-real-entity-xyz']);
    assert.deepEqual(c.resolved, ['people/mehdi']);
    assert.deepEqual(c.unresolved, ['not-a-real-entity-xyz']);
  });

  it('ignores blank refs rather than storing them as missing nodes', () => {
    const c = capture('trailing comma in the list', ['mehdi', '', '   ']);
    assert.deepEqual(c.unresolved, []);
  });
});

describe('the queue', () => {
  it('a captured observation is pending until it is folded', () => {
    const before = inboxDepth().pending;
    const c = capture('to be folded', ['mehdi']);
    assert.equal(inboxDepth().pending, before + 1);
    assert.ok(pendingObservations().some((o) => o.id === c.id));

    foldObservation(c.id, 'recorded as an observation on people/mehdi');
    assert.equal(inboxDepth().pending, before);
    assert.ok(!pendingObservations().some((o) => o.id === c.id));
  });

  it('counts what named nothing, which is what the night should grow from', () => {
    capture('a gap', ['another-missing-entity-abc']);
    // An explicit limit, because the default is 20 and this asks about the
    // FUNCTION, not about how much real data happens to exist today. The suite
    // runs against a snapshot of the live database, so with no limit here the
    // case passed for months and then went red on a Saturday for the only
    // reason that could not be read off the failure: the graph had grown past
    // 20 distinct unresolved refs and pushed this one-hit row off the ranking.
    const rows = unattributedRefs(1000);
    assert.ok(rows.some((r) => r.ref === 'another-missing-entity-abc'));
  });

  it('ranks by hits and caps, so the night reads the loudest gaps first', () => {
    // The behaviour the case above was accidentally relying on, now asserted on
    // purpose: what the cap is FOR.
    capture('twice named', ['loud-missing-ref']);
    capture('twice named again', ['loud-missing-ref']);
    const top = unattributedRefs(3);
    assert.ok(top.length <= 3);
    assert.deepEqual(
      [...top].sort((a, b) => b.hits - a.hits)[0]?.hits,
      top[0]?.hits,
      'the ranking did not lead with the most-named gap',
    );
  });

  it('stays silent while the queue is shallow, and speaks when it is not', () => {
    // The line has to still be readable on the day it matters, so it must not
    // appear every turn — that is how a warning stops being read.
    assert.equal(inboxLine(), null, 'a handful of fresh rows is not news');
    for (let i = 0; i < 30; i++) capture(`bulk ${i}`, ['mehdi']);
    assert.match(inboxLine() ?? '', /observation inbox: \d+ unfolded/);
  });
});
