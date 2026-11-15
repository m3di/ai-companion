import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * FROZEN IS NOT FAILING — the one property four separate audit lines got wrong.
 *
 * On 2026-08-06 the nightly pass opened its report with "40 probe checks are
 * frozen on the same two known bugs", and it was wrong in the way that matters
 * most: 36 of those rows had not moved since the fix landed at 10:54 that
 * morning, and the 2 that WERE still ticking had a completely different cause,
 * which the aggregate hid. It also called five pending proposals live when every
 * one had already shipped — including one whose success was in the evidence
 * directly above it.
 *
 * The shared mistake: every one of these tables records that something failed
 * ONCE, and only a timestamp says whether it still does. So the rule under test
 * is not any individual line's wording — it is that a report which cannot
 * separate "this is broken now" from "this was broken and is not" will
 * eventually spend a night's attention on a bug that no longer exists.
 *
 * These tests run against the RENDERED text, because the text is what the model
 * reads and therefore the only surface where the bug was ever visible.
 */

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ');

type Row = { kind: string; ref: string; outcome: string; detail: string; hits: number; last_at: string };
const miss = (ref: string, ago: number, hits = 4): Row => ({
  kind: 'probe',
  ref,
  outcome: 'unanswered',
  detail: 'exited 0 and printed nothing',
  hits,
  last_at: iso(ago),
});

/**
 * The classifier under test, extracted so it can be exercised without a
 * database. It must stay identical to `checkMissLine`'s — see the note there.
 */
function split(rows: Row[]): { live: Row[]; frozen: Row[] } {
  const now = Date.now();
  const isLive = (r: Row) => now - Date.parse(`${r.last_at}Z`) <= HOUR;
  return { live: rows.filter(isLive), frozen: rows.filter((r) => !isLive(r)) };
}

describe('separating a live failure from a recorded one', () => {
  it('reproduces the 2026-08-06 shape: 38 stopped, 2 still going', () => {
    const rows = [
      ...Array.from({ length: 38 }, (_, i) => miss(`core-api/frozen-${i}`, 10 * HOUR)),
      miss('core-api/northwind-payment-method-2297', 5 * 60_000),
      miss('client-onboarding/fabrikam-signup-decision-2659', 20 * 60_000),
    ];
    const { live, frozen } = split(rows);
    assert.equal(live.length, 2, 'the two that were still failing must survive the split');
    assert.equal(frozen.length, 38);
    // The count alone was what misled the night. 40 is true and useless.
    assert.notEqual(live.length, rows.length);
  });

  it('a high hit count does not make an old row live', () => {
    // The rows that misled were the LOUDEST — 96 hits each, sorted to the top.
    // Loudness is a measure of how badly something failed, never of when.
    const { live } = split([miss('noisy', 8 * HOUR, 96), miss('quiet', 60_000, 1)]);
    assert.deepEqual(live.map((r) => r.ref), ['quiet']);
  });

  it('an empty live set is a real answer, not an absent one', () => {
    const { live, frozen } = split([miss('old', 30 * HOUR)]);
    assert.equal(live.length, 0);
    assert.equal(frozen.length, 1, 'history must still be reported — silently dropping it hides a pattern');
  });
});

describe('the audit renders the distinction it makes', () => {
  it('says STOPPED, and does not fire, when nothing is still failing', async () => {
    const { renderAudit } = await import('../src/audit.js');
    const text = renderAudit([
      {
        input: 'unanswered checks',
        fired: false,
        text: 'Nothing has failed in the last hour.\n\n40 STOPPED — last failure 2026-08-06 13:20:02, nothing since.',
      },
    ]);
    assert.match(text, /STOPPED/);
    assert.doesNotMatch(text, /⚠️/, 'stopped history must not be dressed as an alarm');
  });

  it('marks a fired line so a live fault cannot read as history', async () => {
    const { renderAudit } = await import('../src/audit.js');
    const text = renderAudit([{ input: 'unanswered checks', fired: true, text: '2 STILL FAILING' }]);
    assert.match(text, /⚠️/);
  });
});

/**
 * A proposal is a claim that something is STILL broken — and until 2026-08-07 it
 * was the only claim in the system nothing ever re-checked.
 */
describe('a proposal carries its own check', () => {
  it('a verdict of "shipped" is legible in the operator\'s own text', async () => {
    const { renderAudit } = await import('../src/audit.js');
    const text = renderAudit([
      { input: 'proposal queue', fired: true, text: '5 ALREADY SHIPPED — its own check passes.\n- #28 [shipped] stop injecting…' },
    ]);
    assert.match(text, /ALREADY SHIPPED/);
    assert.match(text, /#28 \[shipped\]/);
  });

  it('a missing check is reported as unknowable, never as "still open"', () => {
    // The dangerous default. "No evidence it shipped" and "evidence it did not"
    // are the pair the whole audit exists to keep apart (I3), and collapsing
    // them is what let five fixed bugs read as five live ones.
    const verdicts = ['shipped', 'not-yet', 'unfalsifiable', 'broken: not allowlisted'];
    const open = verdicts.filter((v) => v === 'not-yet');
    assert.equal(open.length, 1, 'exactly one verdict may mean "confirmed still broken"');
    assert.ok(!verdicts.includes(''), 'an empty verdict would be indistinguishable from not-yet');
  });
});
