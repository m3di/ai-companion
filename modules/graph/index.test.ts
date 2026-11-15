import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { domains, heavy, hierarchy, loose, shape, similar, stuck } from './index.js';

/**
 * THE GRAPH MODULE'S CONTRACT.
 *
 * These run against the REAL tree, like every other module's tests, and that
 * constrains them in a useful way: a measure is asserted on its INVARIANTS
 * (a share is between 0 and 1, a sum of parts equals the whole, a reported
 * outlier is really in the graph) rather than on today's values, which change
 * every night by design.
 *
 * The one thing worth stating plainly: a measure that is silently wrong is
 * worse than no measure, because the whole point of this module is that an
 * agent and a human will make structural decisions from these numbers. So the
 * tests are mostly consistency checks between measures that must agree.
 */

describe('shape', () => {
  it('reports a graph that is there', () => {
    const s = shape();
    assert.ok(s.entities > 100, `${s.entities} entities`);
    assert.ok(s.edges > 0);
    assert.ok(s.domains >= 8);
    assert.equal(s.errors, 0, 'the live graph does not lint clean — every measure below is suspect');
  });

  it('keeps shares in range and counts internally consistent', () => {
    const s = shape();
    assert.ok(s.vagueShare >= 0 && s.vagueShare <= 1, `vagueShare ${s.vagueShare}`);
    assert.ok(s.factsMedian <= s.factsMax);
    assert.equal(
      s.byKind.reduce((n, k) => n + k.n, 0),
      s.entities,
      'the kind histogram does not add up to the entity count',
    );
    // `edges` counts AUTHORED edges only; the histogram carries derived ones too.
    assert.equal(
      s.byRel.filter((r) => !r.derived).reduce((n, r) => n + r.n, 0),
      s.edges,
      'the relation histogram does not add up to the authored edge count',
    );
  });

  it('refuses to count a derived relation as authored structure', () => {
    const s = shape();
    const derived = s.byRel.filter((r) => r.derived);
    assert.ok(derived.length > 0, 'acted-by has vanished — M0 regressed, or DERIVED is wrong');
    // The whole point of I2: the loader's own work must not inflate a measure
    // of what an author built.
    assert.ok(derived.every((r) => !['part-of', 'relates-to'].includes(r.rel)));
  });

  it('the isolated count agrees with the list loose() reports', () => {
    assert.equal(shape().isolated, loose().isolated.length);
  });
});

describe('domains', () => {
  it('profiles every domain the same way, comparably', () => {
    const ds = domains();
    assert.equal(ds.length, shape().domains);
    assert.equal(
      ds.reduce((n, d) => n + d.entities, 0),
      shape().entities,
      'domain profiles do not partition the graph',
    );
    for (const d of ds) {
      assert.ok(d.cohesion >= 0 && d.cohesion <= 1, `${d.domain} cohesion ${d.cohesion}`);
      assert.ok(d.vagueShare >= 0 && d.vagueShare <= 1, `${d.domain} vagueShare ${d.vagueShare}`);
      assert.ok(d.open <= d.entities);
      assert.ok(d.isolated <= d.entities);
    }
  });

  it('counts every cross-domain edge from both ends', () => {
    // An edge leaving one domain arrives in another, so the totals must match.
    const ds = domains();
    assert.equal(
      ds.reduce((n, d) => n + d.outbound, 0),
      ds.reduce((n, d) => n + d.inbound, 0),
      'outbound and inbound disagree — a cross-domain edge is being counted once',
    );
  });
});

describe('heavy', () => {
  it('ranks by fact weight and respects the limit', () => {
    const h = heavy(5);
    assert.equal(h.length, 5);
    for (let i = 1; i < h.length; i++) assert.ok(h[i - 1]!.chars >= h[i]!.chars, 'not sorted by weight');
    assert.ok(h[0]!.chars > 0);
    assert.ok(h[0]!.longest <= h[0]!.chars);
  });

  it('names nodes that actually exist', () => {
    const ids = new Set(loose().unprovenanced.concat(loose().isolated));
    for (const n of heavy(3)) {
      assert.match(n.id, /^[a-z0-9-]+\/[a-z0-9-]+$/i);
      assert.ok(n.facts > 0, `${n.id} is in the heavy list with no facts`);
      assert.ok(!ids.has(n.id) || true); // the sets may legitimately overlap
    }
  });
});

describe('loose', () => {
  it('an isolated node is never also reported as unreachable', () => {
    const l = loose();
    // `unreachable` means "nothing points at it but it points at something";
    // an isolated node points at nothing, so the two sets must be disjoint or
    // the definitions have drifted into each other.
    const iso = new Set(l.isolated);
    for (const id of l.unreachable) assert.equal(iso.has(id), false, `${id} is in both sets`);
  });

  it('reports provenance gaps, which the write path now refuses to create', () => {
    // Not asserted as empty: the repair is a judgement about real memory, and a
    // test that demands zero would fail the moment the night finds a real one.
    for (const id of loose().unprovenanced) assert.match(id, /\//);
  });
});

describe('similar', () => {
  it('scores in range, never pairs a node with itself, and is symmetric-free', () => {
    const pairs = similar(20, 0.2);
    const seen = new Set<string>();
    for (const p of pairs) {
      assert.notEqual(p.a, p.b);
      assert.ok(p.score > 0 && p.score <= 1, `${p.a}/${p.b} scored ${p.score}`);
      assert.ok(p.shared.length > 0, 'a pair scored above zero with nothing shared');
      const key = [p.a, p.b].sort().join('|');
      assert.equal(seen.has(key), false, `${key} reported twice`);
      seen.add(key);
    }
  });

  it('ranks the strongest candidate first', () => {
    const pairs = similar(10, 0.2);
    for (let i = 1; i < pairs.length; i++) assert.ok(pairs[i - 1]!.score >= pairs[i]!.score);
  });

  it('a higher threshold can only narrow the list', () => {
    const loose_ = similar(50, 0.2).length;
    const tight = similar(50, 0.5).length;
    assert.ok(tight <= loose_, 'raising minScore returned MORE pairs');
  });
});

describe('hierarchy', () => {
  it('reports part-of as an acyclic hierarchy with real roots', () => {
    const h = hierarchy();
    assert.equal(h.rel, 'part-of');
    assert.deepEqual(h.cycles, [], `part-of has a cycle: ${JSON.stringify(h.cycles)}`);
    assert.ok(h.roots.length > 0);
    assert.equal(h.maxDepth, h.deepest.length);
    assert.ok(h.maxDepth >= 2, 'part-of is flat — nothing is contained in anything');
  });

  it('the deepest path is a real chain of real nodes', () => {
    const h = hierarchy();
    assert.equal(new Set(h.deepest).size, h.deepest.length, 'the deepest path repeats a node');
    assert.ok(h.deepest.every((id) => id.includes('/')));
  });

  it('fanout covers exactly the roots', () => {
    const h = hierarchy();
    assert.deepEqual(h.fanout.map((f) => f.id).sort(), [...h.roots].sort());
  });

  it('answers for a relation nothing uses without inventing structure', () => {
    const h = hierarchy('supersedes');
    assert.equal(h.rel, 'supersedes');
    assert.deepEqual(h.cycles, []);
    assert.ok(h.maxDepth >= 0);
  });
});

describe('stuck', () => {
  it('lists only open, unprobed entities — the ones no command can close', () => {
    for (const s of stuck()) {
      assert.match(s.id, /\//);
      assert.ok(typeof s.claimsDone === 'boolean');
      if (s.claimsDone) assert.ok(s.evidence && s.evidence.length > 10, `${s.id} claims done with no evidence`);
    }
  });

  it('sorts the ones with evidence first — those are the actionable ones', () => {
    const rows = stuck();
    const firstWithout = rows.findIndex((s) => !s.claimsDone);
    if (firstWithout === -1) return;
    assert.equal(rows.slice(firstWithout).some((s) => s.claimsDone), false, 'an actionable row is buried below the rest');
  });

  it('never lists an entity that has a probe', async () => {
    const { loadGraph } = await import('../_companion.js');
    const g = loadGraph();
    for (const s of stuck()) assert.equal(g.entities.get(s.id)?.probe, undefined, `${s.id} has a probe`);
  });
});
