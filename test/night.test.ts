import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allowed, refusal } from '../src/mode.js';
import { describeDebt, NIGHT_HOUR, nightBoundary, type NightDebt } from '../src/night.js';

/**
 * THE NIGHT IS A DEBT.
 *
 * Three days of real use produced three symptoms of one cause — the fold was an
 * APPOINTMENT, a time at which it was attempted, and nothing else in the
 * machine could see whether it had actually happened:
 *
 *   08-12  dreams #66 (07:59) and #67 (08:02). An induced pass folded the
 *          window; the scheduled row came due anyway and folded it again.
 *   08-13  the pass landed 2h45m late.
 *   08-15  the morning routine fired at 05:15; the fold that was supposed to
 *          CLOSE the previous day landed at 05:48. Today's activity went into
 *          yesterday's session, and the fold then rewrote it underneath.
 *
 * Two properties carry the fix, and the second one matters as much as the first:
 *
 *   1. While a night is owed, nothing that belongs to the day may run.
 *   2. The debt can always be given up on. A mandatory night that cannot be
 *      cancelled is a bot nobody can reach on the morning it matters (I8).
 *
 * The GATE is tested by passing the debt in rather than writing the row,
 * deliberately: `night_settled` is one global row, the suite runs its files in
 * parallel against one database, and a test that unsettled a night to make its
 * point would blind every other file for as long as it ran. `test/prepare.ts`
 * settles the snapshot's night for the same reason.
 */

const DAY = ['day-turn', 'worker', 'commitment', 'wakeup', 'auto-nightly', 'probe-sweep', 'focus-sweep', 'harvest', 'distill'] as const;

const debt: NightDebt = { boundary: '2026-08-15 00:30:00', overdueMin: 318 };

describe('the day waits for the night', () => {
  it('holds EVERY day activity while a night is owed', () => {
    for (const a of DAY) {
      assert.equal(allowed(a, true), false, `${a} ran before the night had folded`);
    }
  });

  it('lets all of them through the moment it is settled', () => {
    for (const a of DAY) {
      assert.equal(allowed(a, false), true, `${a} stayed blocked after the night was settled`);
    }
  });

  /**
   * THE PROPERTY THAT KEEPS THIS FROM BEING A TRAP (I8).
   *
   * Everything the debt blocks is something that would run ON a stale day. The
   * four it must never block are the four that make it payable — the fold
   * itself, and the three doors a person gets in through to cancel it. This is
   * the third time in three weeks a hold has had to be designed so it cannot
   * block its own release, and the first two got it wrong first.
   */
  it('never blocks the fold, or the doors that cancel it', () => {
    for (const a of ['dream', 'operator-turn', 'debug-enter'] as const) {
      assert.equal(allowed(a, true), true, `${a} was blocked by the very debt it exists to clear`);
    }
  });

  it('names the debt in the refusal, not the mode', () => {
    // The bot is LIVE while a night is owed, so the honest-looking answer —
    // "the bot is LIVE, sedate it first" — sends the operator to sedate a bot
    // that is already waiting. Same failure as telling someone "DEBUG MODE"
    // while it was live; the refusal has to name what is actually holding it.
    const r = refusal('day-turn', debt);
    assert.match(r, /NIGHT IS STILL OWED/);
    // And says it in terms of the surface the refusal ARRIVES on. This lands in
    // Telegram at 8am; "open a terminal" is not an escape hatch from a phone.
    assert.match(r, /\/cancelnight/, 'the refusal did not say how to take the night back from the chat');
    assert.doesNotMatch(r, /bot is LIVE/);
  });

  it('leaves non-day refusals alone', () => {
    // `operator-write` is refused while live for an unrelated reason, and a
    // debt must not rewrite that message into one about the night.
    assert.match(refusal('operator-write', debt), /LIVE/);
  });
});

describe('the boundary', () => {
  it('is the most recent local NIGHT_HOUR, never a future one', () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const b = new Date(`${nightBoundary(noon).replace(' ', 'T')}Z`);
    assert.ok(b.getTime() <= noon.getTime(), 'the boundary was in the future');
    assert.equal(b.getHours(), NIGHT_HOUR);
    assert.ok(noon.getTime() - b.getTime() < 24 * 3_600_000, 'the boundary was more than a day back');
  });

  it('rolls back to yesterday for a time before the hour', () => {
    // 02:00 with a 04:00 boundary belongs to YESTERDAY's day, which is the
    // whole point of putting the boundary in the small hours: the operator
    // working past midnight is still in the day he started in.
    const small = new Date();
    small.setHours(Math.max(0, NIGHT_HOUR - 2), 0, 0, 0);
    const b = new Date(`${nightBoundary(small).replace(' ', 'T')}Z`);
    assert.equal(b.getDate(), new Date(small.getTime() - 86_400_000).getDate());
  });
});

describe('describeDebt', () => {
  it('says how late it is and what the last settled night was', () => {
    const s = describeDebt({ ...debt, last: { boundary: '2026-08-14 00:30:00', settled_at: 'x', how: 'quiet', note: null } });
    assert.match(s, /5h 18m overdue/);
    assert.match(s, /2026-08-14 00:30:00 \(quiet\)/);
  });

  it('says so plainly when no night has ever been settled', () => {
    assert.match(describeDebt(debt), /No night has ever been settled/);
  });
});
