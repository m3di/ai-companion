import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { addCommitment, listCommitments, resolveCommitment, setCommitmentRef } from '../src/db.js';
import { focusLines } from '../src/focus.js';

/**
 * THE DAY'S DOOR INTO THE GRAPH (M4).
 *
 * A focus item may name the entity it is about, and `readFocus` — the one
 * memory surface the day already calls by habit — hands that pointer over. The
 * point is not the pointer; it is that following it is a graph read, and the
 * day has made exactly zero of those.
 *
 * ## Why this test exists in this shape
 *
 * The first cut of the column typechecked, passed the suite, and displayed
 * NOTHING. `commitments` is read through four prepared statements and the
 * column was added to three: the focus set is loaded by `focusItems`, whose
 * SELECT list wraps onto a second line and so escaped the edit that caught the
 * others. Every layer above it was correct and the feature was inert — the
 * fourth time in this session that green meant nothing.
 *
 * So the assertion deliberately goes end to end, from the write to the RENDERED
 * LINE, rather than checking that a setter set something. A test that read the
 * value back through `listCommitments` would have passed against the bug.
 */

const CHAT = -777_001;
const made: number[] = [];

after(() => {
  for (const id of made) resolveCommitment(id, CHAT, 'dropped', 'test fixture');
});

function focusItem(label: string, ref?: string): number {
  const id = addCommitment(CHAT, label, `body of ${label}`, '2099-01-01 00:00:00', { focus: 1, focusBand: 'test', ref });
  made.push(id);
  return id;
}

describe('a focus item pointing at an entity', () => {
  it('reaches the RENDERED focus line, not just the row', () => {
    focusItem('probe-with-ref', 'core-api/some-entity');
    const line = focusLines(CHAT).find((l) => l.includes('probe-with-ref'));
    assert.ok(line, 'the item did not appear in the focus set at all');
    assert.match(line, /graph: core-api\/some-entity/, 'the ref never reached the line the day reads');
    // The invitation matters as much as the pointer: the line has to say what
    // to DO with it, or it is decoration.
    assert.match(line, /find\("core-api\/some-entity"\)/);
  });

  it('carries no ref, and no ghost of one, when none was set', () => {
    focusItem('probe-no-ref');
    const line = focusLines(CHAT).find((l) => l.includes('probe-no-ref'))!;
    assert.doesNotMatch(line, /graph:/, 'an item with no ref advertised one');
  });

  it('can be pointed at an entity after the fact, and un-pointed', () => {
    const id = focusItem('probe-late-ref');
    setCommitmentRef(id, CHAT, 'paperwork/renewal-case');
    assert.match(focusLines(CHAT).find((l) => l.includes('probe-late-ref'))!, /graph: paperwork\/renewal-case/);
    setCommitmentRef(id, CHAT, null);
    assert.doesNotMatch(focusLines(CHAT).find((l) => l.includes('probe-late-ref'))!, /graph:/);
  });

  it('never invents one — an unpointed item is a signal, not a gap to fill', () => {
    // Measured on the live set before building this: matching labels against
    // entity ids gave 1 exact hit and mostly garbage —
    // `launchpad-release-candidate-conflict` "matched" `launchpad/system`, a
    // domain fallback wearing a match's clothes. A wrong ref is worse than
    // none because the day follows it, so the field is authored (I2) and an
    // item that points nowhere means the graph is missing a node.
    const id = focusItem('probe-unresolvable-thing-nobody-modelled');
    const row = listCommitments(CHAT).find((c) => c.id === id)!;
    assert.equal(row.ref, null);
  });
});
