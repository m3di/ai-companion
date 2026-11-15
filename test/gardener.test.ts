import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadGraph } from '../src/entities.js';
import { plan, renderPlan, skipPacket } from '../src/gardener.js';

/**
 * THE GARDENER'S CONTRACT.
 *
 * Two properties carry the whole design, and both are about restraint:
 *
 *   1. A packet that is not `safe` carries NO op. The gardener's value is that
 *      it prepares work, and the moment it starts deciding, judgment is being
 *      dressed as determinism — which is the failure this session spent its
 *      length correcting.
 *   2. `plan()` writes nothing. That is what lets it run beside a live day, and
 *      it is the reason the gardener is a preparer rather than a second writer:
 *      the write path had no cross-process lock until 2026-08-07, so a second
 *      writer would silently erase the first.
 */

describe('what the gardener may decide', () => {
  it('gives an op ONLY to packets it can be certain about', () => {
    const p = plan(40);
    for (const k of p.packets) {
      assert.equal(k.safe, false, `${k.code} ${k.id} claims to be mechanically fixable`);
      assert.equal(k.op, undefined, `${k.code} ${k.id} is a judgment call but carries an op to apply`);
    }
    for (const k of p.safe) {
      assert.equal(k.safe, true);
      assert.ok(k.op, `${k.id} is marked safe with nothing to apply`);
    }
  });

  it('only ever proposes dropping an edge mechanically', () => {
    // Widening this set is a real decision, not a refactor: every other op
    // changes what the graph SAYS, and none of them can be certain without a
    // reader. If this test fails, the new op needs the argument written down.
    for (const k of plan(40).safe) assert.equal(k.op!.op, 'drop-edge');
  });

  it('picks a stable survivor, so two runs agree on which arrow goes', () => {
    const a = plan(40).safe.map((k) => `${k.id}|${'target' in k.op! ? k.op.target : ''}`);
    const b = plan(40).safe.map((k) => `${k.id}|${'target' in k.op! ? k.op.target : ''}`);
    assert.deepEqual(a, b);
    // And never both directions of one pair — that would delete the relation.
    const pairs = new Set(a.map((x) => x.split('|').sort().join('~')));
    assert.equal(pairs.size, a.length, 'both arrows of a pair are queued for dropping');
  });
});

describe('what a packet has to contain', () => {
  it('carries the evidence, so the reader never has to go and look', () => {
    for (const k of plan(40).packets) {
      assert.ok(k.problem.length > 10, `${k.id} has no statement of the problem`);
      assert.ok(k.context.length > 0, `${k.id} sends the reader off to find its own context`);
      assert.ok(k.suggest.includes('record('), `${k.id} does not name the call that would fix it`);
      assert.ok(k.id.includes('/'));
    }
  });

  it('is one packet per node per code — several findings are one piece of work', () => {
    const keys = plan(40).packets.map((k) => `${k.code}|${k.id}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('bounds the pass, because an unbounded diff is not reviewable', () => {
    assert.ok(plan(3).packets.length <= 3);
    assert.ok(plan(40).packets.length >= plan(3).packets.length);
  });

  it('puts the heaviest work first', () => {
    const w = plan(40).packets.map((k) => k.weight);
    for (let i = 1; i < w.length; i++) assert.ok(w[i - 1]! >= w[i]!);
  });
});

describe('declining a packet', () => {
  it('holds while the evidence holds, and reopens when the chain grows', () => {
    const g = loadGraph();
    const first = plan(200, g).packets.find((k) => k.code === 'W213');
    if (!first) return; // nothing to decline on this graph — the rule found no orphan plan
    const r = skipPacket({ code: 'W213', id: first.id, decision: 'unknown', reason: 'test: the chain names no outcome', actor: 'test' }, g);
    assert.equal(r.ok, true, 'ok' in r && !r.ok ? r.problem : '');
    assert.ok(!plan(200, g).packets.some((k) => k.code === 'W213' && k.id === first.id), 'a declined packet was offered again on the same evidence');
    // New evidence: a longer chain. The same graph object, one more chain entry.
    const e = g.entities.get(first.id)!;
    e.chain = [...e.chain, 'msg#999999'];
    assert.ok(plan(200, g).packets.some((k) => k.code === 'W213' && k.id === first.id), 'a grown chain must reopen the question');
    e.chain = e.chain.slice(0, -1);
  });

  it('refuses anything but the two durable answers, and a packet that is not firing', () => {
    const g = loadGraph();
    const any = [...g.entities.values()][0]!;
    assert.equal(skipPacket({ code: 'W213', id: any.id, decision: 'later', reason: 'x', actor: 'test' }, g).ok, false);
    assert.equal(skipPacket({ code: 'W999', id: any.id, decision: 'reference', reason: 'x', actor: 'test' }, g).ok, false);
    assert.equal(skipPacket({ code: 'W213', id: 'nope/nothing', decision: 'reference', reason: 'x', actor: 'test' }, g).ok, false);
  });
});

describe('reading it', () => {
  it('renders something an agent can act on without a lookup', () => {
    const text = renderPlan(plan(3));
    assert.match(text, /GARDENING PLAN/);
    assert.match(text, /record\(/);
    assert.match(text, /SKIP/, 'the instruction to skip an unsure fix must survive rendering');
  });

  it('writes nothing — the property that lets it run beside a live day', () => {
    const before = JSON.stringify([...loadGraph().entities.values()].map((e) => [e.id, e.facts, e.edges]));
    plan(40);
    const after = JSON.stringify([...loadGraph().entities.values()].map((e) => [e.id, e.facts, e.edges]));
    assert.equal(before, after);
  });
});
