import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * A COMMITMENT BATCH MAY NOT OUTLIVE ITS OWN PERMISSION.
 *
 * The firing loop checked the work state once, before the batch, and the
 * reasoning was explicit: `markCommitmentFired` advances the row before the
 * callback runs, so refusing halfway would consume a firing and lose it. That
 * held while the only way into a suspended state was a person typing `/debug`.
 *
 * It stopped holding when `nightly-pipeline` — a commitment IN THE BATCH —
 * became the thing that enters DREAMING. On 2026-08-08 the nightly fired at
 * 12:36, took the machine, and two more commitments and a dispatched worker
 * went on running against a permission granted before the machine was taken.
 * A worker read memory while the night was rewriting it.
 *
 * The fix is not "check more often" but "check where it matters, and check
 * BEFORE consuming": the guard sits ahead of `markCommitmentFired`, so a
 * refused commitment is never advanced and is simply still due next poll.
 * These tests hold that shape — the loop must stop the moment the state
 * changes, and it must stop without eating anything.
 */

const dir = mkdtempSync(join(tmpdir(), 'batch-'));
process.env.KNOWLEDGE_DIR = dir;

type Commitments = typeof import('../src/commitments.js');
type Db = typeof import('../src/db.js');
let C: Commitments;
let db: Db;

/** Stands in for the work state. The real `allowed('commitment')` reads a
 *  single global row, and two test files claiming it at once is a race, not a
 *  test — so the guard is exercised through its injected form. */
let free = true;
const mayFire = () => free;

const CHAT = 4242;

before(async () => {
  C = await import('../src/commitments.js');
  db = await import('../src/db.js');
});

after(() => {
  delete process.env.KNOWLEDGE_DIR;
});

/** Drop everything currently due, so each case starts from an empty batch. A
 *  row left over from an earlier case would be fired FIRST and make the counts
 *  below mean nothing. */
function clearDue(): void {
  for (const c of C.splitDue().fire) db.resolveCommitment(c.id, c.chat_id, 'dropped');
  for (const c of C.splitDue().check) db.resolveCommitment(c.id, c.chat_id, 'dropped');
}

beforeEach(() => {
  free = true;
  clearDue();
});

/** Three FIRE commitments, all already due. */
function seedThree(prefix: string): void {
  const past = C.toUtcDb(new Date(Date.now() - 60_000));
  for (const n of ['a', 'b', 'c']) db.addCommitment(CHAT, `${prefix}-${n}`, `body ${n}`, past, { createdBy: 'test' });
}

/** Labels still due — i.e. NOT consumed by a firing. */
function stillDue(prefix: string): string[] {
  return C.splitDue()
    .fire.filter((c) => c.label.startsWith(prefix))
    .map((c) => c.label)
    .sort();
}

describe('a commitment batch and the work state', () => {
  it('stops the moment a member of the batch takes the machine', async () => {
    seedThree('taker');
    const ran: string[] = [];
    await C.fireDueCommitments(async (c) => {
      ran.push(c.label);
      // Exactly what nightly-pipeline does: this callback is the one that takes
      // the machine, from inside the batch it belongs to.
      if (ran.length === 1) free = false;
    }, mayFire);
    assert.deepEqual(ran.length, 1, `the batch kept firing after the machine was taken: ${ran.join(', ')}`);
  });

  it('does not CONSUME the ones it held back', async () => {
    // The whole objection to checking inside the loop was that a refusal would
    // eat a firing. It does not: the check runs before the row is advanced, so
    // a held-back commitment is still due and fires on the next free poll.
    seedThree('kept');
    await C.fireDueCommitments(async () => {
      free = false;
    }, mayFire);
    const left = stillDue('kept');
    assert.equal(left.length, 2, `held-back commitments were consumed — only ${left.length} left due`);

    // And with the machine free again, they run.
    free = true;
    const ran: string[] = [];
    await C.fireDueCommitments(async (c) => {
      ran.push(c.label);
    }, mayFire);
    assert.ok(ran.length >= 2, 'the held-back commitments did not fire once the machine was free');
  });

  it('fires nothing at all when the machine is already taken', async () => {
    seedThree('blocked');
    free = false;
    const ran: string[] = [];
    await C.fireDueCommitments(async (c) => {
      ran.push(c.label);
    }, mayFire);
    assert.deepEqual(ran, [], `commitments fired while the machine was held: ${ran.join(', ')}`);
    assert.equal(stillDue('blocked').length, 3, 'a blocked batch still consumed its rows');
  });
});
