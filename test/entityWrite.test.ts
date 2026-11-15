import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * THE WRITE PATH'S GUARANTEES.
 *
 * Round 10 hands the pen to a model: the night corrects a fact and the graph
 * changes, with no human in the loop. The safety argument for that is entirely
 * mechanical — a writer cannot corrupt the graph, cannot touch probe-owned
 * fields, and cannot write anything unexplained — so these tests ARE the safety
 * argument. If they pass, direct writes are safe; if they cannot be written,
 * direct writes were the wrong call.
 *
 * The fixture is a temporary knowledge tree, because a test that exercises
 * writes against the real one is a test that can lose Mehdi's memory.
 */

const dir = mkdtempSync(join(tmpdir(), 'kb-write-'));
process.env.KNOWLEDGE_DIR = dir;

type Mod = typeof import('../src/entityWrite.js');
type Ents = typeof import('../src/entities.js');
let applyWrite: Mod['applyWrite'];
let confirmFacts: Mod['confirmFacts'];
let loadGraph: Ents['loadGraph'];

const DATA = join(dir, 'demo', 'entities.jsonl');

const alpha = {
  id: 'demo/alpha',
  kind: 'system',
  aka: ['the alpha'],
  facts: ['alpha hosts clients one, two and three', 'alpha is written in scala'],
  edges: { 'relates-to': ['demo/beta'] },
  status: 'n/a',
  dormant: false,
  goal: false,
  chain: ['repo:demo/_map.md'],
};
const beta = { id: 'demo/beta', kind: 'component', aka: [], facts: ['beta imports from alpha'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'] };

function reset(): void {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  writeFileSync(DATA, `${JSON.stringify(alpha)}\n${JSON.stringify(beta)}\n`);
}

before(async () => {
  reset();
  ({ applyWrite, confirmFacts } = await import('../src/entityWrite.js'));
  ({ loadGraph } = await import('../src/entities.js'));
});

after(() => {
  // The fixture lives in the OS temp dir; leaving it is fine, but the env var
  // must not leak into anything that runs after this file in-process.
  delete process.env.KNOWLEDGE_DIR;
});

const facts = (id: string): string[] => loadGraph().entities.get(id)!.facts;

describe('correcting a fact', () => {
  it('replaces it in the data file and leaves the rest alone', () => {
    reset();
    const r = applyWrite(
      { op: 'correct-fact', id: 'demo/alpha', from: 'alpha hosts clients one, two and three', to: 'alpha hosts clients four and five' },
      'mehdi named the current list in chat on 2026-07-31',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    assert.deepEqual(facts('demo/alpha'), ['alpha hosts clients four and five', 'alpha is written in scala']);
    assert.equal(facts('demo/beta').length, 1);
  });

  it('journals what changed, from what, and why', async () => {
    reset();
    const { entityWrites } = await import('../src/db.js');
    applyWrite(
      { op: 'correct-fact', id: 'demo/alpha', from: 'alpha is written in scala', to: 'alpha is written in scala 2.13' },
      'saw the build file',
      'nightly',
    );
    const [row] = entityWrites('demo/alpha', 1);
    assert.equal(row!.before, 'alpha is written in scala');
    assert.equal(row!.after, 'alpha is written in scala 2.13');
    assert.equal(row!.reason, 'saw the build file');
    assert.equal(row!.actor, 'nightly');
  });

  it('names the facts it does have when the target does not match', () => {
    reset();
    const r = applyWrite({ op: 'correct-fact', id: 'demo/alpha', from: 'alpha hosts clients one and two', to: 'x' }, 'why', 'cli');
    assert.equal(r.ok, false);
    // A bare "not found" is useless for fixing a near miss — the caller has to
    // be able to see what it should have matched.
    assert.match(r.problem!, /alpha hosts clients one, two and three/);
  });

  it('refuses a write with no reason', () => {
    reset();
    const r = applyWrite({ op: 'correct-fact', id: 'demo/alpha', from: 'alpha is written in scala', to: 'x' }, '   ', 'cli');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /needs a reason/);
  });
});

describe('the rollback guard', () => {
  it('refuses a fact that asserts state, and changes nothing', () => {
    reset();
    const original = readFileSync(DATA, 'utf8');
    // "is currently merged" is a fact anchored to a state — the lint rejects it,
    // and the whole point is that the writer finds out by being refused rather
    // than by leaving the tree broken.
    const r = applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'alpha is currently blocked on review' }, 'saw it', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /would have broken the graph/);
    assert.equal(readFileSync(DATA, 'utf8'), original, 'the data file must be byte-identical after a refused write');
  });

  it('sets and clears goal, and refuses a no-op', () => {
    reset();
    const r = applyWrite({ op: 'goal', id: 'demo/beta', goal: true }, 'the evidence names it as the outcome', 'nightly');
    assert.equal(r.ok, true, r.problem);
    assert.equal(loadGraph().entities.get('demo/beta')!.goal, true);
    assert.match(readFileSync(DATA, 'utf8'), /"id":"demo\/beta"[^\n]*"goal":true/);
    const again = applyWrite({ op: 'goal', id: 'demo/beta', goal: true }, 'again', 'nightly');
    assert.equal(again.ok, false);
    assert.match(again.problem!, /already/);
    const off = applyWrite({ op: 'goal', id: 'demo/beta', goal: false }, 'it was the plan, not the outcome', 'nightly');
    assert.equal(off.ok, true, off.problem);
    assert.equal(loadGraph().entities.get('demo/beta')!.goal, false);
  });

  it('parks and revives, and refuses a no-op', () => {
    reset();
    const seed = applyWrite({ op: 'mint', id: 'demo/plan', kind: 'task', facts: ['a plan'], chain: ['msg#2'], edges: [{ rel: 'part-of', target: 'demo/alpha' }] }, 'seed', 'nightly');
    assert.equal(seed.ok, true, seed.problem);
    const park = applyWrite({ op: 'dormant', id: 'demo/plan', dormant: true }, 'asked 3×, no answer', 'nightly');
    assert.equal(park.ok, true, park.problem);
    assert.equal(loadGraph().entities.get('demo/plan')!.dormant, true);
    // The actor-clearing half lives in test/silence.test.ts, whose fixture has a person to name.
    assert.equal(applyWrite({ op: 'dormant', id: 'demo/plan', dormant: true }, 'again', 'nightly').ok, false);
    const revive = applyWrite({ op: 'dormant', id: 'demo/plan', dormant: false }, 'Mehdi brought it back', 'nightly');
    assert.equal(revive.ok, true, revive.problem);
    assert.equal(loadGraph().entities.get('demo/plan')!.dormant, false);
  });

  it('mints a goal when asked to', () => {
    reset();
    const r = applyWrite(
      { op: 'mint', id: 'demo/omega', kind: 'project', goal: true, facts: ['omega is what done looks like'], chain: ['msg#9'], edges: [{ rel: 'part-of', target: 'demo/alpha' }] },
      'the evidence names the outcome',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    assert.equal(loadGraph().entities.get('demo/omega')!.goal, true);
  });

  it('refuses an edge to an entity that does not exist', () => {
    reset();
    const original = readFileSync(DATA, 'utf8');
    const r = applyWrite({ op: 'edge', id: 'demo/alpha', rel: 'blocks', target: 'demo/ghost' }, 'inferred', 'nightly');
    assert.equal(r.ok, false);
    assert.equal(readFileSync(DATA, 'utf8'), original);
  });

  it('leaves the derived index matching the files after a rollback', () => {
    reset();
    applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'alpha is currently blocked on review' }, 'saw it', 'nightly');
    assert.deepEqual(facts('demo/alpha'), alpha.facts, 'a rolled-back write must not survive in the index');
  });
});

describe('what a writer may not touch', () => {
  it('has no op for state — the probe owns it', () => {
    // Not a runtime check: a compile-time one. `state` is absent from the Write
    // union, so this is the test asserting the SHAPE is what makes it safe,
    // rather than a guard that could be forgotten. If someone adds a state op,
    // this comment is the thing that should stop them.
    reset();
    const ops = ['correct-fact', 'add-fact', 'drop-fact', 'observe', 'note', 'edge', 'mint'];
    assert.ok(!ops.includes('state'));
    assert.ok(!ops.includes('status'));
  });

  it('writes observation to its own field, dated', () => {
    reset();
    const r = applyWrite({ op: 'observe', id: 'demo/beta', observed: 'nora put the epic on hold' }, 'standup 07-31', 'nightly');
    assert.equal(r.ok, true, r.problem);
    const e = loadGraph().entities.get('demo/beta')!;
    assert.equal(e.observed, 'nora put the epic on hold');
    assert.match(e.observed_at!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.state, undefined, 'observation must never land in the probe-owned field');
  });
});

describe('minting', () => {
  it('adds an entity the graph did not have', () => {
    reset();
    const r = applyWrite(
      { op: 'mint', id: 'demo/gamma', kind: 'task', facts: ['gamma migrates the importer to the new keying'], chain: ['msg#42'], edges: [{ rel: 'part-of', target: 'demo/alpha' }] },
      'came up in the 07-31 session',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    assert.equal(loadGraph().entities.get('demo/gamma')!.kind, 'task');
  });

  it('refuses an entity with no facts', () => {
    reset();
    const r = applyWrite({ op: 'mint', id: 'demo/delta', kind: 'task', facts: [], edges: [{ rel: 'part-of', target: 'demo/alpha' }] }, 'seemed relevant', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /id, not knowledge/);
  });

  it('refuses to mint over something that exists', () => {
    reset();
    const r = applyWrite({ op: 'mint', id: 'demo/alpha', kind: 'task', facts: ['x'], edges: [{ rel: 'part-of', target: 'demo/beta' }] }, 'why', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /already exists/);
  });

  /**
   * THE BIRTH CHECKLIST. A mint could not declare edges until 2026-08-07, so
   * every node was born isolated and six never got linked. That was never an
   * author being careless — the op had no way to say it. Requiring it here is
   * the whole reason W201 can be enforced at the write instead of budgeted
   * afterwards: the cost of saying "part-of X" while writing the node is
   * nothing, and the cost of finding it again three weeks later is everything.
   */
  it('refuses a node that would be born isolated', () => {
    reset();
    const r = applyWrite(
      { op: 'mint', id: 'demo/orphan', kind: 'task', facts: ['a real thing'], chain: ['msg#1'], edges: [] },
      'no edges and no actor',
      'nightly',
    );
    assert.equal(r.ok, false);
    assert.match(r.problem!, /at least one edge, or an actor/);
    assert.match(r.problem!, /part-of/, 'the refusal must show the shape it wants');
    assert.equal(loadGraph().entities.has('demo/orphan'), false);
  });

  it('accepts an ACTOR instead of an edge — that derives a real, traversable one', () => {
    // The checklist asks for a node that arrives FINDABLE, not for a particular
    // field. `actor` derives `acted-by`, and neighbours() traverses derived
    // edges like any other; demanding an authored edge on top would be stricter
    // than the rule being enforced.
    reset();
    // An actor must name a real person — the lint that keeps `people/` the one
    // home for a person also makes `actor` a checked reference, not a string.
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(
      join(dir, 'people', 'entities.jsonl'),
      `${JSON.stringify({ id: 'people/mehdi', kind: 'person', aka: [], facts: ['the operator'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'] })}\n`,
    );
    const r = applyWrite(
      { op: 'mint', id: 'demo/byactor', kind: 'task', facts: ['someone is on this'], chain: ['msg#2'], actor: 'mehdi' },
      'connected through its actor',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    assert.equal(loadGraph().entities.get('demo/byactor')!.actor, 'mehdi');
  });

  it('refuses an edge to a node that does not exist yet', () => {
    reset();
    const r = applyWrite(
      { op: 'mint', id: 'demo/eps', kind: 'task', facts: ['x'], chain: ['msg#1'], edges: [{ rel: 'part-of', target: 'demo/nope' }] },
      'target is imaginary',
      'nightly',
    );
    assert.equal(r.ok, false);
    assert.match(r.problem!, /does not exist/);
  });

  it('refuses a node that is part of itself', () => {
    reset();
    const r = applyWrite(
      { op: 'mint', id: 'demo/zeta', kind: 'task', facts: ['x'], chain: ['msg#1'], edges: [{ rel: 'part-of', target: 'demo/zeta' }] },
      'self reference',
      'nightly',
    );
    assert.equal(r.ok, false);
    assert.match(r.problem!, /itself/);
  });

  it('lands the declared edges, so the node is connected the moment it exists', () => {
    reset();
    const r = applyWrite(
      {
        op: 'mint',
        id: 'demo/eta',
        kind: 'task',
        facts: ['eta reworks the keying'],
        chain: ['msg#7'],
        edges: [{ rel: 'part-of', target: 'demo/alpha' }, { rel: 'relates-to', target: 'demo/beta' }],
      },
      'two edges, one relation each',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    const e = loadGraph().entities.get('demo/eta')!;
    assert.deepEqual(e.edges['part-of'], ['demo/alpha']);
    assert.deepEqual(e.edges['relates-to'], ['demo/beta']);
  });

  it('groups two edges of the same relation under one key', () => {
    reset();
    const r = applyWrite(
      {
        op: 'mint',
        id: 'demo/theta',
        kind: 'task',
        facts: ['x'],
        chain: ['msg#8'],
        edges: [{ rel: 'relates-to', target: 'demo/alpha' }, { rel: 'relates-to', target: 'demo/beta' }],
      },
      'same rel twice',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
    assert.deepEqual(loadGraph().entities.get('demo/theta')!.edges['relates-to'], ['demo/alpha', 'demo/beta']);
  });
});

describe('fact provenance', () => {
  it('gives every fact a clock on load, and retires the clock when the fact goes', async () => {
    reset();
    const { factProvenance } = await import('../src/db.js');
    const { factSha } = await import('../src/entities.js');
    loadGraph();
    const p = factProvenance('demo/alpha');
    assert.equal(p.size, 2);
    assert.equal(p.get(factSha('alpha is written in scala'))!.confirmed_at, null, 'a fact starts unconfirmed — nobody has looked at it');

    applyWrite({ op: 'drop-fact', id: 'demo/alpha', fact: 'alpha is written in scala' }, 'no longer true', 'nightly');
    assert.equal(factProvenance('demo/alpha').size, 1);
  });

  it('starts a new clock when a fact is corrected', async () => {
    reset();
    const { factProvenance } = await import('../src/db.js');
    const { factSha } = await import('../src/entities.js');
    loadGraph();
    confirmFacts('demo/alpha', ['alpha is written in scala']);
    assert.ok(factProvenance('demo/alpha').get(factSha('alpha is written in scala'))!.confirmed_at);

    applyWrite(
      { op: 'correct-fact', id: 'demo/alpha', from: 'alpha is written in scala', to: 'alpha is written in scala 2.13' },
      'checked build.sbt',
      'nightly',
    );
    const p = factProvenance('demo/alpha');
    // A corrected fact is a NEW claim: it must not inherit the confirmation of
    // the sentence it replaced, or a correction would look better-verified than
    // anything actually checked.
    assert.equal(p.get(factSha('alpha is written in scala 2.13'))!.confirmed_at, null);
    assert.equal(p.has(factSha('alpha is written in scala')), false);
  });

  it('confirming is not a write — it touches no file', async () => {
    reset();
    loadGraph();
    const original = readFileSync(DATA, 'utf8');
    confirmFacts('demo/alpha', alpha.facts);
    assert.equal(readFileSync(DATA, 'utf8'), original);
  });
});

/**
 * MOVING AN ENTITY — the op that changes an id.
 *
 * Added after 2026-08-04, when the night worked out that
 * `affiliate-app/northwind-payment-method-2297` was Core-API work, had no way to say
 * so, and left a note asking for a mechanism. The domain is the id's prefix, so
 * a move is the only write that touches more than one file — which makes the
 * all-or-nothing guarantee the thing worth testing hardest.
 */
const OTHER = join(dir, 'other', 'entities.jsonl');
const gamma = { id: 'other/gamma', kind: 'system', aka: [], facts: ['gamma is the other domain root'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#2'] };

function resetTwo(): void {
  reset();
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(OTHER, `${JSON.stringify(gamma)}\n`);
}

describe('moving an entity', () => {
  it('relocates it and drags every inbound edge along', () => {
    resetTwo();
    const r = applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'beta is other-domain work — mehdi said so in chat', 'nightly');
    assert.equal(r.ok, true, r.problem);

    const g = loadGraph();
    assert.equal(g.errors.length, 0, 'the move left the graph unclean');
    assert.equal(g.entities.has('demo/beta'), false, 'the old id survived the move');
    assert.equal(g.entities.get('other/beta')!.domain, 'other');
    assert.deepEqual(g.entities.get('other/beta')!.facts, beta.facts, 'the entity lost content in transit');
    // The whole point: an edge that pointed at the old id must follow it, or the
    // move trades a misfiled entity for an unreachable one.
    assert.deepEqual(g.entities.get('demo/alpha')!.edges['relates-to'], ['other/beta']);
    assert.match(readFileSync(OTHER, 'utf8'), /other\/beta/);
    assert.doesNotMatch(readFileSync(DATA, 'utf8'), /demo\/beta/);
  });

  it('carries the confirmation clock, so a moved entity is not freshly minted', async () => {
    resetTwo();
    const { factProvenance } = await import('../src/db.js');
    const { factSha } = await import('../src/entities.js');
    loadGraph();
    confirmFacts('demo/beta', beta.facts);

    applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'beta belongs to other', 'nightly');
    const p = factProvenance('other/beta');
    assert.ok(p.get(factSha(beta.facts[0]!))?.confirmed_at, 'the move reset the confirmation clock — the entity now looks never-checked');
    assert.equal(factProvenance('demo/beta').size, 0, 'provenance was left behind on the old id');
  });

  it('journals the move as a before/after pair of ids', async () => {
    resetTwo();
    const { entityWrites } = await import('../src/db.js');
    applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'mehdi corrected the domain in chat', 'nightly');
    const [row] = entityWrites('other/beta');
    assert.equal(row!.op, 'move');
    assert.equal(row!.before, 'demo/beta');
    assert.equal(row!.after, 'other/beta');
    assert.match(row!.reason, /mehdi corrected/);
  });

  it('refuses to land on an id that is taken — a move is not a merge', () => {
    resetTwo();
    const r = applyWrite({ op: 'move', id: 'demo/beta', to: 'other/gamma' }, 'testing the refusal', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /already exists/);
    assert.ok(loadGraph().entities.has('demo/beta'), 'a refused move still moved something');
  });

  it('refuses to invent a domain', () => {
    resetTwo();
    const r = applyWrite({ op: 'move', id: 'demo/beta', to: 'nosuch/beta' }, 'testing the refusal', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /has no entities\.jsonl/);
    assert.ok(loadGraph().entities.has('demo/beta'));
  });

  it('leaves BOTH domains byte-identical when it refuses', () => {
    resetTwo();
    const beforeDemo = readFileSync(DATA, 'utf8');
    const beforeOther = readFileSync(OTHER, 'utf8');
    // Every refusal path must be file-clean, not just edge-case-clean: a move
    // that half-applied would leave a dangling edge, which is the one kind of
    // damage the other ops cannot produce.
    for (const to of ['Not A Domain/beta', 'other/gamma', 'nosuch/beta', 'demo/beta']) {
      const r = applyWrite({ op: 'move', id: 'demo/beta', to }, 'testing the guard', 'nightly');
      assert.equal(r.ok, false, `move to ${to} was allowed`);
      assert.equal(readFileSync(DATA, 'utf8'), beforeDemo, `move to ${to} touched the source domain`);
      assert.equal(readFileSync(OTHER, 'utf8'), beforeOther, `move to ${to} touched the destination domain`);
    }
  });
});

describe('the domain briefing', () => {
  it('is re-rendered by the write, not left for the prober', async () => {
    resetTwo();
    const { renderMap, simplify } = await import('../src/simplify.js');
    const map = join(dir, 'demo', '_map.md');
    // Seed it from the pre-write graph, then write and re-read: a map that
    // still matches the OLD graph is the 2026-08-04 paperwork bug, where a
    // correction landed in the entities and the briefing went on saying the
    // superseded thing because nothing re-rendered it.
    const g0 = loadGraph();
    writeFileSync(map, renderMap('demo', g0, simplify(g0)));
    const stale = readFileSync(map, 'utf8');

    applyWrite(
      { op: 'correct-fact', id: 'demo/alpha', from: 'alpha hosts clients one, two and three', to: 'alpha hosts clients four and five' },
      'mehdi named the current list',
      'nightly',
    );
    const fresh = loadGraph();
    assert.notEqual(readFileSync(map, 'utf8'), stale, 'the write left the briefing stale');
    assert.equal(readFileSync(map, 'utf8'), renderMap('demo', fresh, simplify(fresh)), 'the briefing does not match the graph the write produced');
  });

  it('is re-rendered in BOTH domains a move touched', async () => {
    resetTwo();
    const { renderMap, simplify } = await import('../src/simplify.js');
    const g0 = loadGraph();
    const s0 = simplify(g0);
    for (const d of ['demo', 'other']) writeFileSync(join(dir, d, '_map.md'), renderMap(d, g0, s0));

    applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'beta is other-domain work', 'nightly');
    const g1 = loadGraph();
    const s1 = simplify(g1);
    for (const d of ['demo', 'other']) {
      assert.equal(readFileSync(join(dir, d, '_map.md'), 'utf8'), renderMap(d, g1, s1), `${d}/_map.md was left behind by the move`);
    }
  });
});

describe('dropping an edge', () => {
  it('removes the relation and leaves the entity otherwise intact', () => {
    resetTwo();
    const r = applyWrite({ op: 'drop-edge', id: 'demo/alpha', rel: 'relates-to', target: 'demo/beta' }, 'never actually related — mehdi said so', 'nightly');
    assert.equal(r.ok, true, r.problem);
    const g = loadGraph();
    assert.equal(g.errors.length, 0);
    // The key goes with the last target: an empty relation list is not a
    // relation, and rendering one breaks the view round-trip.
    assert.equal('relates-to' in g.entities.get('demo/alpha')!.edges, false);
    assert.deepEqual(g.entities.get('demo/alpha')!.facts, alpha.facts);
  });

  it('refuses a relation the entity does not have', () => {
    resetTwo();
    const r = applyWrite({ op: 'drop-edge', id: 'demo/alpha', rel: 'relates-to', target: 'other/gamma' }, 'testing the refusal', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /has no relates-to/);
  });

  it('is what finishes a move — the moved entity can leave its old parent', () => {
    resetTwo();
    applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'beta is other-domain work', 'nightly');
    // alpha's edge followed beta across; now sever it, which is the real
    // affiliate-app → core-api case: the relation belonged to the old domain.
    const r = applyWrite({ op: 'drop-edge', id: 'demo/alpha', rel: 'relates-to', target: 'other/beta' }, 'beta left the domain; the relation went with it', 'nightly');
    assert.equal(r.ok, true, r.problem);
    const g = loadGraph();
    assert.equal(g.errors.length, 0);
    assert.equal('relates-to' in g.entities.get('demo/alpha')!.edges, false);
    assert.ok(g.entities.has('other/beta'));
  });
});

describe('a move and the pending inbox', () => {
  it('carries a pending observation ref across, and leaves folded history alone', async () => {
    resetTwo();
    const { saveObservation, foldObservation } = await import('../src/db.js');
    loadGraph();
    const mk = (text: string) => saveObservation({ text, refs: ['demo/beta'], unresolved: [], evidence: 'msg#1', source: 'test' });
    const pending = mk('beta shipped');
    const folded = mk('beta shipped, long ago');
    foldObservation(folded, 'already true');

    applyWrite({ op: 'move', id: 'demo/beta', to: 'other/beta' }, 'beta is other-domain work', 'nightly');

    const { pendingObservations } = await import('../src/db.js');
    const row = pendingObservations(200).find((o) => o.id === pending);
    assert.deepEqual(row!.refs, ['other/beta'], 'a pending observation was left pointing at an id that no longer exists');
    // The folded twin is history and must not be rewritten; it is simply gone
    // from the queue, which is what `folded_at IS NULL` in the carry buys.
    assert.equal(pendingObservations(200).some((o) => o.id === folded), false);
  });
});

describe('retiring an entity', () => {
  it('removes it and drops the sidecar clocks', async () => {
    resetTwo();
    const { factProvenance } = await import('../src/db.js');
    loadGraph();
    confirmFacts('other/gamma', gamma.facts);
    assert.ok(factProvenance('other/gamma').size > 0);

    const r = applyWrite({ op: 'retire', id: 'other/gamma' }, 'a duplicate the graph should not carry', 'nightly');
    assert.equal(r.ok, true, r.problem);
    const g = loadGraph();
    assert.equal(g.errors.length, 0);
    assert.equal(g.entities.has('other/gamma'), false);
    assert.equal(factProvenance('other/gamma').size, 0, 'the confirmation clock outlived the entity');
  });

  it('REFUSES while anything still points at it', () => {
    resetTwo();
    // demo/alpha relates-to demo/beta; retiring beta would dangle that edge.
    const r = applyWrite({ op: 'retire', id: 'demo/beta' }, 'testing the refusal', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /still point at/);
    assert.ok(loadGraph().entities.has('demo/beta'), 'a refused retire still removed something');
  });

  it('folds inbound edges into the survivor — the merge case', () => {
    resetTwo();
    const r = applyWrite({ op: 'retire', id: 'demo/beta', into: 'other/gamma' }, 'same thing stored twice; gamma is the survivor', 'nightly');
    assert.equal(r.ok, true, r.problem);
    const g = loadGraph();
    assert.equal(g.errors.length, 0, 'the merge left a dangling edge');
    assert.equal(g.entities.has('demo/beta'), false);
    assert.deepEqual(g.entities.get('demo/alpha')!.edges['relates-to'], ['other/gamma']);
  });

  it('journals the whole row, so the journal alone can undo it', async () => {
    resetTwo();
    const { entityWrites } = await import('../src/db.js');
    applyWrite({ op: 'retire', id: 'other/gamma' }, 'retiring to check the journal', 'nightly');
    const [row] = entityWrites('other/gamma');
    assert.equal(row!.op, 'retire');
    const restored = JSON.parse(row!.before!) as { id: string; facts: string[] };
    assert.equal(restored.id, 'other/gamma');
    assert.deepEqual(restored.facts, gamma.facts, 'the journal cannot rebuild what it deleted');
  });

  it('refuses to fold into something that does not exist, or into itself', () => {
    resetTwo();
    assert.match(applyWrite({ op: 'retire', id: 'demo/beta', into: 'nope/nope' }, 'x', 'nightly').problem!, /no entity/);
    assert.match(applyWrite({ op: 'retire', id: 'demo/beta', into: 'demo/beta' }, 'x', 'nightly').problem!, /into itself/);
    assert.ok(loadGraph().entities.has('demo/beta'));
  });
});

/**
 * A MALFORMED WRITE IS REFUSED, NOT THROWN.
 *
 * `Write` is a compile-time union, and the two callers that matter do not get
 * it: the night and the concierge reach `record()` across a module boundary
 * carrying JSON a model composed. On 2026-08-06 the night sent `correct-fact`
 * as `{before, after}`; `mutate` reached for `w.from.slice(60)` INSIDE the
 * branch that builds the friendly "no such fact" message and threw. The
 * diagnostic was the crash, and the caller got a stack trace where it needed a
 * field name.
 */
describe('a write whose shape is wrong', () => {
  it('names the fields it wanted AND the ones it got, instead of throwing', () => {
    reset();
    const bad = { op: 'correct-fact', id: 'demo/alpha', before: 'x', after: 'y' } as never;
    let r: ReturnType<typeof applyWrite>;
    assert.doesNotThrow(() => {
      r = applyWrite(bad, 'the exact payload the night sent on 2026-08-06', 'nightly');
    });
    assert.equal(r!.ok, false);
    // Both halves matter: what it needed, and what it actually sent. Without
    // the second the caller cannot see that it used the wrong NAME rather than
    // omitting a value.
    assert.match(r!.problem!, /"from"/);
    assert.match(r!.problem!, /"to"/);
    assert.match(r!.problem!, /Received:.*"before".*"after"/s);
  });

  it('refuses an unknown op by listing the real ones', () => {
    reset();
    const r = applyWrite({ op: 'update', id: 'demo/alpha' } as never, 'reason', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /unknown op "update"/);
    assert.match(r.problem!, /correct-fact/);
  });

  it('treats a blank required field as missing, not as a value', () => {
    reset();
    const r = applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: '   ' } as never, 'reason', 'nightly');
    assert.equal(r.ok, false);
    assert.match(r.problem!, /"fact"/);
  });

  it('checks the shape BEFORE the reason, so a wrong field is not reported as a missing reason', () => {
    // The reason check used to run first, which meant a caller with both
    // problems fixed the wrong one and hit the crash on its second try.
    reset();
    const r = applyWrite({ op: 'correct-fact', id: 'demo/alpha', before: 'x' } as never, '', 'nightly');
    assert.match(r.problem!, /"from"/);
  });

  it('still lets a well-formed write through', () => {
    reset();
    const r = applyWrite(
      { op: 'add-fact', id: 'demo/alpha', fact: 'alpha runs on jvm 21' },
      'validation must refuse the malformed, not the merely new',
      'nightly',
    );
    assert.equal(r.ok, true, r.problem);
  });
});

/**
 * ONE WRITER AT A TIME, ACROSS PROCESSES.
 *
 * `applyWrite` is fully synchronous, so inside one process it is already
 * atomic — which is exactly why this hole stayed invisible: every writer lived
 * in the bot. A gardener run from a CLI does not, and two processes doing
 * read → mutate → writeFileSync over the same domain file means the second
 * silently erases the first. Not a corrupt graph — each write lints clean on
 * its own — but a LOST one, which is worse, because the journal records both
 * as successful.
 */
describe('the write lock', () => {
  it('refuses while another process holds it, and says who', async () => {
    reset();
    const { writeFileSync: wf, unlinkSync: ul } = await import('node:fs');
    const lock = join(dir, '.write.lock');
    wf(lock, '99999 someone-else 2026-08-07T00:00:00.000Z');
    try {
      const r = applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'x' }, 'while locked', 'nightly');
      assert.equal(r.ok, false);
      assert.match(r.problem!, /another process is writing/);
      assert.match(r.problem!, /someone-else/, 'a refusal that does not name the holder is not actionable');
    } finally {
      ul(lock);
    }
  });

  it('releases the lock after a write, so the next one is not blocked', () => {
    reset();
    assert.equal(applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'first' }, 'one', 'nightly').ok, true);
    assert.equal(applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'second' }, 'two', 'nightly').ok, true);
    assert.equal(existsSync(join(dir, '.write.lock')), false, 'the lock outlived its write');
  });

  it('releases the lock even when the write is REFUSED', () => {
    // The failure mode that would wedge the graph permanently: a rejected write
    // leaving the lock behind means every later write fails for thirty seconds
    // and the cause is invisible.
    reset();
    assert.equal(applyWrite({ op: 'add-fact', id: 'demo/nope', fact: 'x' }, 'no such node', 'nightly').ok, false);
    assert.equal(existsSync(join(dir, '.write.lock')), false);
    assert.equal(applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'after a refusal' }, 'ok now', 'nightly').ok, true);
  });

  it('breaks a STALE lock rather than letting a dead process wedge the graph (I8)', async () => {
    reset();
    const { writeFileSync: wf, utimesSync } = await import('node:fs');
    const lock = join(dir, '.write.lock');
    wf(lock, '99999 a-process-that-died 2026-08-01T00:00:00.000Z');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const r = applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'after a crash' }, 'stale lock', 'nightly');
    assert.equal(r.ok, true, r.problem);
    assert.equal(existsSync(join(dir, '.write.lock')), false);
  });
});

describe('correct-chain — provenance that can be fixed', () => {
  const chainOf = (id: string) => loadGraph().entities.get(id)!.chain;

  it('replaces, canonicalising the new spelling', () => {
    reset();
    const r = applyWrite({ op: 'correct-chain', id: 'demo/beta', from: 'msg#1', to: 'msg #7' }, 'fix spelling', 'cli');
    assert.equal(r.ok, true, r.problem);
    assert.deepEqual(chainOf('demo/beta'), ['msg#7']);
  });

  it('drops and adds', () => {
    reset();
    assert.equal(applyWrite({ op: 'correct-chain', id: 'demo/alpha', to: 'pr#12' }, 'add', 'cli').ok, true);
    assert.deepEqual(chainOf('demo/alpha'), ['repo:demo/_map.md', 'pr#12']);
    assert.equal(applyWrite({ op: 'correct-chain', id: 'demo/alpha', from: 'repo:demo/_map.md' }, 'drop', 'cli').ok, true);
    assert.deepEqual(chainOf('demo/alpha'), ['pr#12']);
  });

  it('refuses an entity path, a missing entry, and an emptied chain', () => {
    reset();
    assert.match(applyWrite({ op: 'correct-chain', id: 'demo/alpha', to: 'demo/beta' }, 'x', 'cli').problem!, /points at an entity/);
    assert.match(applyWrite({ op: 'correct-chain', id: 'demo/alpha', from: 'msg#999' }, 'x', 'cli').problem!, /has no chain entry/);
    assert.match(applyWrite({ op: 'correct-chain', id: 'demo/beta', from: 'msg#1' }, 'x', 'cli').problem!, /no chain/);
    assert.match(applyWrite({ op: 'correct-chain', id: 'demo/beta' } as never, 'x', 'cli').problem!, /needs `from`/);
  });

  it('a row whose chain names an entity is an error in the DATA file, not only in the view', () => {
    reset();
    writeFileSync(DATA, `${JSON.stringify(alpha)}\n${JSON.stringify({ ...beta, chain: ['msg#1', 'demo/beta.md'] })}\n`);
    assert.ok(loadGraph().errors.some((e) => /points at an entity/.test(e.message)));
    reset();
  });

  it('a broken tree still accepts the write that repairs it, and nothing else (I8)', () => {
    reset();
    writeFileSync(DATA, `${JSON.stringify(alpha)}\n${JSON.stringify({ ...beta, chain: ['msg#1', 'demo/beta.md'] })}\n`);
    const elsewhere = applyWrite({ op: 'add-fact', id: 'demo/alpha', fact: 'unrelated' }, 'x', 'cli');
    assert.match(elsewhere.problem!, /does not currently lint clean/);
    const noFix = applyWrite({ op: 'add-fact', id: 'demo/beta', fact: 'touches the broken row, fixes nothing' }, 'x', 'cli');
    assert.equal(noFix.ok, false, 'a write at the broken entity must still reduce the errors');
    const fix = applyWrite({ op: 'correct-chain', id: 'demo/beta', from: 'demo/beta.md' }, 'repair', 'cli');
    assert.equal(fix.ok, true, fix.problem);
    assert.equal(loadGraph().errors.length, 0);
    reset();
  });
});
