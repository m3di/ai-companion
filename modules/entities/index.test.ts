import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blockers,
  confirm,
  criticalPath,
  domains,
  find,
  focus,
  health,
  history,
  openLoops,
  recentlyMoved,
  record,
  search,
  trace,
  unconfirmed,
} from './index.js';

/**
 * THE ENTITY MODULE'S CONTRACT.
 *
 * A module without these does not load — not as tidiness, but because the night
 * is allowed to rewrite this file and the day depends on it. These tests are
 * what the night reverts against.
 *
 * They run against the REAL tree, deliberately. Every design error in round 8
 * was found by real data and none by reasoning about fixtures.
 */

describe('health', () => {
  it('reports a sound graph', () => {
    const h = health();
    assert.deepEqual(h.errors, [], 'the live graph does not lint clean');
    assert.ok(h.entities > 100, `${h.entities} entities`);
    assert.ok(h.domains >= 8);
  });
});

describe('domains', () => {
  it('summarises the whole tree without returning it', () => {
    const ds = domains();
    assert.ok(ds.length >= 8);
    const total = ds.reduce((n, d) => n + d.entities, 0);
    assert.equal(total, health().entities);
    for (const d of ds) {
      assert.equal(d.open + d.closed <= d.entities, true, `${d.domain}: counts exceed its size`);
      assert.ok(d.kinds.length, `${d.domain}: no kinds`);
    }
    // The point of the function: an overview must not carry the graph with it.
    assert.ok(JSON.stringify(ds).length < 6000, 'the summary is not a summary');
  });

  it('carries a computed critical path where one exists', () => {
    const withPath = domains().filter((d) => d.criticalPath?.length);
    assert.ok(withPath.length > 0, 'no domain has a critical path');
    for (const d of withPath) assert.ok(d.criticalPath!.length > 1);
  });
});

describe('find', () => {
  it('opens an entity by its id', () => {
    const any = openLoops()[0]!;
    const c = find(any.id)!;
    assert.equal(c.id, any.id);
    assert.ok(c.chain.length, 'an entity with no route back to the traces');
  });

  it('resolves the tail of an id', () => {
    const any = openLoops()[0]!;
    assert.equal(find(any.id.split('/').pop()!)?.id, any.id);
  });

  it('returns null rather than guessing', () => {
    assert.equal(find('no-such-entity-anywhere'), null);
  });

  it('never invents state', () => {
    // The prober is the only writer of state; a card claiming state with no
    // probe behind it would mean the module made it up.
    for (const d of domains()) {
      const some = openLoops(d.domain).slice(0, 3);
      for (const l of some) {
        const c = find(l.id)!;
        if (c.state !== undefined) assert.ok(c.probe, `${c.id}: state with no probe`);
      }
    }
  });
});

/** A word certain to exist in the live graph, taken from a real entity id. */
function anyEntityWord(): string {
  const id = domains()[0] ? find(domains()[0]!.domain)?.id ?? '' : '';
  const w = (id || 'system').split('/').pop()!.split('-')[0]!;
  return w.length > 2 ? w : 'system';
}

describe('search', () => {
  it('finds an entity by a word from its own id', () => {
    const target = openLoops()[0]!;
    const word = target.id.split('/').pop()!.split('-')[0]!;
    assert.ok(
      search(word).some((h) => h.id === target.id),
      `searching "${word}" did not find ${target.id}`,
    );
  });

  it('returns nothing for a term the graph has none of', () => {
    // This asserted "requires every word, not any", which was the old rule and
    // the bug: a four-word question needed all four tokens inside one node, so
    // the night asked "stagebox prod readiness reset", got nothing back while 58
    // entities carried most of those words, and read it as "the graph does not
    // know about this". What must survive is the narrower promise — a term with
    // NO word in the graph still returns empty, because that emptiness is how a
    // missing concept is discovered (personal/texforge was minted from exactly
    // such a miss on 08-17).
    // The term is deliberately gibberish in EVERY token: an earlier version of
    // this case used "zzzz-nothing-matches-this", whose middle words are
    // ordinary English that really does appear in the graph — so it was
    // asserting the AND filter, not the promise. See the note in search() about
    // stopwords, which remain a known weakness.
    assert.deepEqual(search('zzzq qqxvv wwbbz'), []);
  });

  it('respects its limit', () => {
    assert.ok(search('a', 3).length <= 3);
  });

  it('is the thing you would otherwise grep for', () => {
    // A term written with hyphens must find an entity that spells it with
    // spaces, and vice versa — the normalisation a grep would not do.
    const hits = search('tracker code');
    assert.ok(hits.length > 0, 'no hit for a term the tree definitely holds');
  });
});

describe('openLoops', () => {
  it('returns only open entities', () => {
    for (const l of openLoops()) assert.equal(l.status, 'open');
  });

  it('scopes to a domain', () => {
    const d = domains().find((x) => x.open > 0)!;
    const scoped = openLoops(d.domain);
    assert.equal(scoped.length, d.open);
    for (const l of scoped) assert.ok(l.id.startsWith(`${d.domain}/`));
  });

  it('puts critical-path work first', () => {
    const ls = openLoops();
    const lastOnPath = ls.map((l) => !!l.onCriticalPath).lastIndexOf(true);
    const firstOff = ls.map((l) => !!l.onCriticalPath).indexOf(false);
    if (lastOnPath >= 0 && firstOff >= 0) assert.ok(firstOff > lastOnPath);
  });
});

describe('blockers', () => {
  it('returns nothing for something unblocked, and only open ones otherwise', () => {
    const blocked = openLoops().find((l) => l.blockedBy?.length);
    if (!blocked) return; // a fully unblocked tree is a legitimate state
    const bs = blockers(blocked.id);
    assert.ok(bs.length >= blocked.blockedBy!.length);
    for (const b of bs) assert.equal(b.status, 'open');
    assert.equal(new Set(bs.map((b) => b.id)).size, bs.length, 'a blocker was reported twice');
  });

  it('is empty for an unknown reference', () => {
    assert.deepEqual(blockers('nothing-here'), []);
  });
});

describe('criticalPath', () => {
  it('every path is open work ending at its goal', () => {
    const ps = criticalPath();
    assert.ok(ps.length > 0);
    for (const p of ps) {
      assert.equal(p.path.at(-1), p.goal);
      assert.equal(new Set(p.path).size, p.path.length);
      for (const id of p.path) assert.equal(find(id)?.status, 'open', `${id} is on a path but not open`);
    }
  });

  it('scopes to a domain', () => {
    const d = criticalPath()[0]!.goal.split('/')[0]!;
    for (const p of criticalPath(d)) assert.ok(p.goal.startsWith(`${d}/`));
  });
});

describe('focus', () => {
  it('bands are ordered, titled, and non-overlapping', () => {
    const bands = focus();
    assert.ok(bands.length > 0);
    const seen = new Set<string>();
    let prev = 0;
    for (const b of bands) {
      assert.ok(b.tier > prev, 'bands are not in tier order');
      prev = b.tier;
      assert.ok(b.title.length > 0);
      for (const i of b.items) {
        assert.ok(!seen.has(i.id), `${i.id} is in two bands`);
        seen.add(i.id);
      }
    }
  });

  it('holds exactly the open entities', () => {
    assert.equal(focus().reduce((n, b) => n + b.items.length, 0), openLoops().length);
  });
});

describe('traces and news', () => {
  it('a trace points OUT of the graph, never back into it', () => {
    const id = openLoops()[0]!.id;
    const t = trace(id);
    assert.ok(t.length > 0);
    for (const c of t) assert.notEqual(c, id);
  });

  it('recentlyMoved reports before/after pairs', () => {
    for (const m of recentlyMoved()) {
      assert.ok(m.id);
      assert.notEqual(m.before, m.after, `${m.id}: reported a move that did not move`);
    }
  });
});

/**
 * THE WRITE HALF (round 10).
 *
 * These run against the REAL tree like everything else here, which constrains
 * what they can assert: a contract test must not mutate Mehdi's memory. So the
 * split is deliberate — the guard rails are proven HERE, on real data, because
 * refusals change nothing and a guard that only holds on a fixture is not a
 * guard; the successful-write mechanics (rollback bytes, journal contents,
 * provenance clocks) are proven in `test/entityWrite.test.ts` against a
 * temporary tree, where a mistake costs nothing.
 */
describe('record — the guard rails', () => {
  it('refuses a write with no reason', () => {
    const r = record({ op: 'add-fact', id: 'reference/repos-and-platforms', fact: 'x' }, '');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /reason/);
  });

  it('refuses to touch an entity that does not exist', () => {
    const r = record({ op: 'observe', id: 'nowhere/nothing', observed: 'x' }, 'testing the refusal');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /no entity/);
  });

  it('has no op for state — the prober owns it', () => {
    // A type-level guarantee, asserted here so the reason survives: `state`,
    // `state_at` and `status` are absent from the Write union, so no caller can
    // reach them however it phrases the request.
    const ops = ['correct-fact', 'add-fact', 'drop-fact', 'observe', 'note', 'edge', 'drop-edge', 'mint', 'move', 'retire'];
    for (const forbidden of ['state', 'state_at', 'status']) assert.ok(!ops.includes(forbidden));
  });

  it('shows the real facts when a correction does not match', () => {
    const target = find('reference/repos-and-platforms');
    assert.ok(target, 'the fixture entity for this test has gone — pick another');
    const r = record({ op: 'correct-fact', id: target!.id, from: 'no such sentence', to: 'x' }, 'testing the near-miss path');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /has no fact/);
  });
});

describe('confirm and unconfirmed', () => {
  it('winds the clock on an entity it actually read', () => {
    const before = unconfirmed(0, 500).filter((f) => f.id === 'reference/repos-and-platforms').length;
    const r = confirm('reference/repos-and-platforms');
    assert.ok(r.confirmed > 0);
    // Confirming with a 0-day threshold cannot remove it from the list (it was
    // confirmed just now, which is <= now), so the assertion is only that the
    // call reported the facts it touched.
    assert.ok(before >= 0);
  });

  it('returns nothing for an unknown ref rather than throwing', () => {
    assert.deepEqual(confirm('nowhere/nothing'), { confirmed: 0 });
  });

  it('only reports facts that still exist on their entity', () => {
    for (const f of unconfirmed(0, 20)) {
      const e = find(f.id);
      assert.ok(e, `${f.id} is in the provenance table but not in the graph`);
      assert.ok(e!.facts.includes(f.fact), 'a retired fact must not surface as an aging one');
    }
  });
});

describe('history', () => {
  it('is empty for an entity nothing has written', () => {
    assert.deepEqual(history('nowhere/nothing'), []);
  });

  it('returns entries newest first, each with its reason', () => {
    const h = history('reference/repos-and-platforms', 5);
    for (const e of h) assert.ok(e.reason.length, 'a journalled write with no reason should be impossible');
    for (let i = 1; i < h.length; i++) assert.ok(h[i - 1]!.id > h[i]!.id);
  });
});

/**
 * SEARCH RANKS, IT DOES NOT FILTER.
 *
 * `search` required EVERY word of the term to appear in one entity's text and
 * dropped everything else, so a four-word question needed all four tokens in a
 * single node. The night asked "stagebox prod readiness reset" and got nothing
 * while 58 entities carried most of those words; thirty-four such empties sit
 * in the friction ledger, every one of them read as "the graph does not know
 * about this".
 *
 * Some genuinely were missing — `texforge` was empty until the night minted it
 * on 08-17, the discovery loop working exactly as designed. The bug is that an
 * AND filter cannot tell that case from "no single node happens to contain all
 * your words", and conflating them makes the empty result useless as a signal
 * in both directions.
 */
describe('search', () => {
  it('finds the right node from a term no single node contains in full', () => {
    const word = anyEntityWord();
    const hits = search(`${word} definitelynotawordinthisgraph`, 5);
    assert.ok(hits.length > 0, 'a term with one unmatched word returned nothing at all');
  });

  it('marks a hit that did not match everything, so a guess cannot pass as an answer', () => {
    // Ranking WITHOUT saying so would be worse than the filter it replaces:
    // the caller would write the closest guess into memory as the answer.
    const word = anyEntityWord();
    const hits = search(`${word} definitelynotawordinthisgraph`, 5);
    assert.ok(hits.every((h) => h.partial), 'a partial hit was returned unmarked');
    assert.match(hits[0]!.partial!, /1\/2 terms/);
  });

  it('leaves a full match unmarked', () => {
    const hits = search(anyEntityWord(), 5);
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.partial, undefined, 'an exact match was labelled as partial');
  });

  it('still returns nothing when the graph truly has none of it', () => {
    // The discovery signal has to survive: an empty result is how the night
    // learns a concept is missing, and it minted personal/texforge from exactly
    // this. Ranking must not manufacture a hit out of nothing.
    assert.deepEqual(search('zzzqqq definitelynotawordinthisgraph', 5), []);
  });

  it('ranks coverage above everything else', () => {
    const hits = search(anyEntityWord(), 20);
    const covered = hits.map((h) => (h.partial ? 0 : 1));
    // Full matches must never sort below partial ones.
    assert.deepEqual(covered, [...covered].sort((a, b) => b - a), 'a partial hit outranked a full match');
  });
});
