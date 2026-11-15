import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOAL_RELS, isPlan, lintGraph, RULES, rotCount } from '../src/graphLint.js';
import { loadGraph } from '../src/entities.js';

/**
 * THE LINTER'S CONTRACT — and above all, the split.
 *
 * These run against the REAL graph, so they assert INVARIANTS rather than
 * today's counts, which move every night by design. The exception is the split
 * itself, which is a property of the RULE TABLE and must never drift: a
 * misclassified rule is not a wrong number, it is a budget that charges the
 * night for doing its job, and the first thing that happens to such a budget is
 * that someone turns it off.
 *
 * Two rules in the first measurement pass were wrong on their own first run
 * (E103 forbade correct behaviour; W211 missed the pair it was written for).
 * That is the argument for testing the classification, not just the mechanics.
 */

describe('the rule table', () => {
  it('gives every yellow a class, and no red or blue one', () => {
    // A yellow with no class is a finding nothing can decide what to do with:
    // not refused at the write, not in the budget, just noise that accumulates.
    for (const r of RULES) {
      if (r.severity === 'yellow') assert.ok(r.cls, `${r.code} is yellow with no class`);
      else assert.equal(r.cls, undefined, `${r.code} is ${r.severity} but carries a class`);
    }
  });

  it('uses each code exactly once, and never reuses a retired one', () => {
    const codes = RULES.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length, 'a duplicate code breaks every trend line');
    // Retired in the first measurement pass. Their numbers mean something
    // specific in the changelog and must not come to mean something else.
    for (const gone of ['E103', 'W202', 'W208', 'W210']) {
      assert.equal(codes.includes(gone), false, `${gone} was retired — pick a new number`);
    }
  });

  it('names its severity in its code prefix', () => {
    const prefix = { red: 'E', yellow: 'W', blue: 'I' } as const;
    for (const r of RULES) assert.ok(r.code.startsWith(prefix[r.severity]), `${r.code} is ${r.severity}`);
  });
});

describe('the split', () => {
  it("classifies as 'birth' only what a mint can be REFUSED for", () => {
    // The test that keeps the budget fair: a birth rule must be something the
    // write path can demand up front. If it cannot be checked at the mint, it
    // will be violated by new nodes and charged to the budget forever.
    const birth = RULES.filter((r) => r.cls === 'birth').map((r) => r.code);
    assert.deepEqual(birth.sort(), ['W201', 'W209'], 'the birth set changed — is the mint checklist still enforcing it?');
  });

  it('charges the budget only for rules ordinary work does not trip', () => {
    // Every rot rule must be about the CONTENT of an edit — facts, sentences,
    // structure — never about a node merely being new.
    const rot = RULES.filter((r) => r.cls === 'rot').map((r) => r.code);
    assert.ok(rot.length >= 6);
    assert.equal(rot.includes('W201'), false, 'isolation is a birth defect, not rot');
  });

  it('rot is the sum of exactly the rot rules, and nothing else', () => {
    const r = lintGraph();
    const expected = r.byCode.filter((c) => c.cls === 'rot').reduce((n, c) => n + c.n, 0);
    assert.equal(r.rot, expected);
    assert.equal(rotCount(), r.rot, 'the standalone counter disagrees with the report');
    assert.ok(r.rot < r.bySeverity.yellow + r.bySeverity.blue, 'rot cannot exceed everything measured');
  });

  it('the budget is smaller than the raw yellow count — that is the point', () => {
    const r = lintGraph();
    assert.ok(r.rot <= r.bySeverity.yellow, 'rot is a subset of yellow');
  });
});

describe('determinism', () => {
  it('two runs over the same graph give byte-identical findings', () => {
    // The whole justification for a linter over a model: the verdict cannot
    // depend on who is reading. If this ever fails, nothing downstream — the
    // ratchet, the trend, the gate — means anything.
    const a = lintGraph(loadGraph());
    const b = lintGraph(loadGraph());
    assert.equal(JSON.stringify(a.findings), JSON.stringify(b.findings));
    assert.equal(a.rot, b.rot);
  });

  it('sorts findings so a fix shows as a removed line, not a reshuffle', () => {
    const { findings } = lintGraph();
    for (let i = 1; i < findings.length; i++) {
      const p = findings[i - 1]!;
      const c = findings[i]!;
      const order = p.code.localeCompare(c.code) || p.id.localeCompare(c.id) || p.detail.localeCompare(c.detail);
      assert.ok(order <= 0, `${p.code}/${p.id} sorted after ${c.code}/${c.id}`);
    }
  });

  it('reports every rule, including the ones that found nothing', () => {
    // The audit's own rule: a rule reporting zero must be distinguishable from
    // a rule that broke.
    assert.equal(lintGraph().byCode.length, RULES.length);
  });
});

describe('W213 — a plan that reaches no goal', () => {
  it('never names a goal, a dormant node, or a node that reaches one', () => {
    const g = loadGraph();
    const goals = new Set([...g.entities.values()].filter((e) => e.goal).map((e) => e.id));
    for (const x of lintGraph(g).findings.filter((x) => x.code === 'W213')) {
      const e = g.entities.get(x.id)!;
      assert.ok(!e.goal, `${x.id} is itself a goal`);
      assert.ok(!e.dormant, `${x.id} is parked and should not be charged`);
      assert.ok(isPlan(e), `${x.id} is a ${e.kind} (${e.status}), not a plan`);
      for (const rel of GOAL_RELS) for (const t of e.edges[rel] ?? []) assert.ok(!goals.has(t), `${x.id} ${rel} ${t}, which is a goal`);
    }
  });

  it('is rot, not birth — a plan is legitimately minted before its outcome has a name', () => {
    assert.equal(RULES.find((r) => r.code === 'W213')?.cls, 'rot');
  });
});

describe('what the live graph must never contain', () => {
  it('has no reds — they are refused at the write path', () => {
    const reds = lintGraph().findings.filter((x) => x.severity === 'red');
    assert.deepEqual(reds, [], `the write path let a red through: ${JSON.stringify(reds.slice(0, 3))}`);
  });

  it('every finding names an entity that exists', () => {
    const g = loadGraph();
    for (const x of lintGraph(g).findings) assert.ok(g.entities.has(x.id), `${x.code} names a missing entity ${x.id}`);
  });
});
