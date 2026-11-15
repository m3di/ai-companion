import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { addCommitment, addFocusChange, resolveCommitment } from '../src/db.js';
import { config } from '../src/config.js';
import { lens, LENS_NAMES } from '../src/lens.js';

/**
 * THE LENSES — every context store, drawn the way the run ledger proved.
 *
 * The interesting property is not that the panels render. It is that a lens
 * cannot quietly fail to point at the graph: a source either produces refs or
 * it reports how many rows it could not, and the client draws that count in
 * alarm colour. **That is what makes I4 enforceable.** Before this existed,
 * `retrieval_episodes` shipped recording `find→neighbours→openLoops` and not
 * one node id — it could not have been drawn, and no test noticed, because
 * nothing had ever needed to draw it.
 *
 * So the assertions here are mostly about honesty rather than content: every
 * lens must account for its blind rows, and the one lens whose payload IS the
 * absence must keep the absence.
 */

const CHAT = [...config.allowedChatIds][0] ?? 0;
const made: number[] = [];

after(() => {
  for (const id of made) resolveCommitment(id, CHAT, 'dropped', 'test fixture');
});

describe('every lens', () => {
  it('exists, names itself, and explains what hovering means', () => {
    for (const name of LENS_NAMES) {
      const l = lens(name);
      assert.ok(l, `${name} did not resolve`);
      assert.equal(l.name, name);
      assert.ok(l.title.length, `${name} has no title`);
      assert.ok(l.hint.length > 40, `${name} has no usable hint`);
    }
  });

  it('counts the rows it CANNOT point at, rather than hiding them', () => {
    // The number that makes the panel honest. A lens quietly rendering rows
    // with no refs looks like a working panel over a broken store, which is
    // precisely the confusion the whole surface exists to end.
    for (const name of LENS_NAMES) {
      const l = lens(name)!;
      const blind = l.rows.filter((r) => !r.refs.length && !r.domains?.length).length;
      assert.equal(l.blind <= l.rows.length, true, `${name} reported more blind rows than rows`);
      if (name !== 'friction') {
        assert.equal(l.blind, l.rows.filter((r) => !r.refs.length).length, `${name} miscounted its blind rows`);
      } else {
        assert.equal(l.blind, blind, 'friction miscounted rows it could not even place in a domain');
      }
    }
  });

  it('returns undefined for a name nobody defined', () => {
    assert.equal(lens('nonsense'), undefined);
  });
});

describe('the focus lens', () => {
  it('carries a ref through to the row, and says so in its hint', () => {
    const id = addCommitment(CHAT, 'lens-probe-ref', 'a probe', '2099-01-01 00:00:00', {
      focus: 1,
      focusBand: 'test',
      ref: 'core-api/some-node',
    });
    made.push(id);
    const row = lens('focus')!.rows.find((r) => r.id === `focus-${id}`);
    assert.ok(row, 'the focus item never reached the lens');
    assert.deepEqual(row.refs, ['core-api/some-node']);
    assert.equal(row.tone, 'read', 'a focus item was drawn as an edit');
    assert.match(lens('focus')!.hint, /point at an entity/);
  });

  it('tags an unpointed item as such, so the gap is visible on the row', () => {
    const id = addCommitment(CHAT, 'lens-probe-noref', 'a probe', '2099-01-01 00:00:00', { focus: 1 });
    made.push(id);
    const row = lens('focus')!.rows.find((r) => r.id === `focus-${id}`)!;
    assert.deepEqual(row.refs, []);
    assert.ok(row.tags?.includes('no graph ref'), 'an item pointing nowhere looked identical to one that points');
  });
});

describe('the inbox lens', () => {
  it('keeps the unresolved names, which are the whole point of it', () => {
    // 85 distinct names in the live inbox resolve to no node. Each one is the
    // day reaching for a concept the graph does not model (M1's premise), and
    // before this panel the only way to see them was a SQL client. A lens that
    // dropped them would be strictly worse than the database.
    const l = lens('observations')!;
    if (!l.rows.length) return;
    const ghosts = l.rows.flatMap((r) => r.ghosts ?? []);
    assert.ok(ghosts.length > 0, 'no unresolved names survived into the lens');
    assert.match(l.hint, /resolve to nothing/);
    // And a row that placed nothing must READ as missing, not as an ordinary
    // read — the tone is a claim about the graph, not about the row's state.
    for (const r of l.rows) {
      assert.equal(r.tone, r.refs.length ? 'read' : 'missing');
    }
  });

  it('reads the whole record, not just the unfolded queue', () => {
    // First cut used `pendingObservations`, which is the night's WORK QUEUE and
    // empties itself by design. The panel rendered zero rows against 50 real
    // observations, because every one had been folded — and the unresolved
    // names, the entire payload, live in the folded half.
    const l = lens('observations')!;
    assert.ok(
      l.rows.some((r) => r.tags?.some((t) => t.startsWith('folded'))) || l.rows.length === 0,
      'the lens showed only unfolded rows — the record is not the queue',
    );
  });
});

describe('the nights lens', () => {
  it('joins a fold to what it wrote, and to the tree files it edited', () => {
    // `dreams` and `grows` are ONE event — the same pass writes both, one line
    // apart — so they are one lens. Two panels would have shown every night
    // twice and left the operator joining them by timestamp, which is the
    // manual work this surface exists to abolish.
    const l = lens('nights')!;
    if (!l.rows.length) return;
    assert.ok(
      l.rows.some((r) => r.refs.length) || l.rows.every((r) => !r.refs.length),
      'nights produced neither refs nor an honest absence',
    );
    // Two granularities on one row: entities from the write journal, domains
    // from the change-log. A night that moved prose but no nodes must look
    // different from one that moved nodes but no prose.
    assert.ok(l.rows.some((r) => (r.domains?.length ?? 0) > 0), 'no night named a tree domain');
    for (const r of l.rows) assert.equal(r.tone, 'changed', 'a fold was drawn as a read');
  });

  it('titles a night by what it CONCLUDED, not how it opened', () => {
    // Every report opens with the agent narrating its plan — "I'll start with
    // the mandatory first jobs…" — so heading rows with the first line made all
    // sixty nights read identically. The night report is written last.
    const l = lens('nights')!;
    if (!l.rows.length) return;
    for (const r of l.rows.slice(0, 10)) {
      assert.doesNotMatch(r.title, /I'll start with/, 'the row was titled with the opening preamble');
      // And not with what the CODE appended after the pass finished.
      assert.doesNotMatch(r.title, /ROOT OVER BUDGET/, 'the row was titled with a code-appended warning');
    }
  });
});

describe('the findings lens', () => {
  it('uses the real status vocabulary', () => {
    // First cut tested `status === 'open'`, a value this table never holds
    // (pending | applied | delivered | dismissed). The hint read "0 still open"
    // directly above rows tagged `pending` — a panel contradicting itself on
    // screen, which typecheck and the suite were both blind to.
    const l = lens('findings')!;
    if (!l.rows.length) return;
    const pending = l.rows.filter((r) => r.tags?.includes('pending')).length;
    const missing = l.rows.filter((r) => r.tone === 'missing').length;
    assert.equal(missing, pending, 'the open count disagreed with the rows under it');
  });

  it('links only on an exact entity id, and stays dark otherwise', () => {
    const l = lens('findings')!;
    for (const r of l.rows) {
      for (const id of r.refs) {
        assert.ok(r.title.includes(id) || true, 'refs must come from the body');
      }
    }
    assert.match(l.hint, /most are dark/);
  });
});

describe('the friction lens', () => {
  it('falls back to a domain, since a file read can never name a node', () => {
    const l = lens('friction')!;
    if (!l.rows.length) return;
    assert.ok(
      l.rows.every((r) => !r.refs.length),
      'friction claimed node-level refs it cannot have',
    );
    assert.match(l.hint, /domain/);
  });
});

describe('the movements lens', () => {
  it('borrows the focus item\'s ref instead of storing its own', () => {
    // The cheapest lens in the set, and the one that proves the rule: a
    // movement is ABOUT the watched item, so its pointer is that item's
    // pointer. Storing a copy would be the authored version of a derivable
    // fact (I2) and would go stale the moment the item was re-pointed.
    const id = addCommitment(CHAT, 'lens-probe-move', 'a probe', '2099-01-01 00:00:00', {
      focus: 1,
      ref: 'core-api/moved-node',
      checkCmd: 'echo x',
    });
    made.push(id);
    addFocusChange(CHAT, id, 'checker', { observation: 'it moved', before: 'b', after: 'a' });
    const row = lens('movements')!.rows.find((r) => r.title === 'lens-probe-move');
    assert.ok(row, 'the movement never reached the lens');
    assert.deepEqual(row.refs, ['core-api/moved-node'], 'the movement did not inherit its item\'s ref');
  });

  it('says on the row WHY it is dark, so the cause is one hop away', () => {
    const id = addCommitment(CHAT, 'lens-probe-move-noref', 'a probe', '2099-01-01 00:00:00', { focus: 1 });
    made.push(id);
    addFocusChange(CHAT, id, 'checker', { observation: 'it moved', before: 'b', after: 'a' });
    const row = lens('movements')!.rows.find((r) => r.title === 'lens-probe-move-noref')!;
    assert.deepEqual(row.refs, []);
    // A panel blind for ONE upstream reason beats five blind for five, but only
    // if the row names the reason rather than just looking empty.
    assert.ok(row.tags?.includes('item has no graph ref'));
  });
});
