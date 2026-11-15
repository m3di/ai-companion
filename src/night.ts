import { lastSettledNight, settleNight, type NightSettledRow } from './db.js';

/**
 * THE NIGHT IS A DEBT, NOT AN APPOINTMENT.
 *
 * The nightly rewrite used to be a durable commitment row due at 04:00, polled
 * every minute, and that shape was wrong in both directions at once. Three
 * days of real use, three symptoms, one cause:
 *
 *   - 2026-08-12 — dreams #66 (07:59) and #67 (08:02), three minutes apart.
 *     An induced `/dream` folded the window; the commitment did not know that
 *     had happened, came due anyway, and folded it again.
 *   - 2026-08-13 — the pass landed at 03:15 UTC, 2h45m late.
 *   - 2026-08-15 — the pass landed at 05:48 UTC; the morning routine had
 *     already fired at 05:15. The day started before the night finished, so
 *     today's messages went into yesterday's session, and the fold that was
 *     supposed to close that session ran on top of them.
 *
 * An appointment is a time at which something is ATTEMPTED. What the machine
 * actually needs is a debt: at the boundary a night becomes OWED, everything
 * that belongs to the day is blocked until it is paid, and paying it once pays
 * it — no matter who paid, or how late.
 *
 * ## Why a separate table and not "was there a dream today"
 *
 * A pass that runs and finds a quiet window writes no `dreams` row, by design —
 * there was nothing to journal. Reading the debt off `dreams` would therefore
 * treat a legitimately empty night as an unpaid one, and a debt that blocks the
 * day and cannot be discharged is a bot that never speaks again. `night_settled`
 * records that the night was ACCOUNTED FOR, which is a different fact from
 * whether it had anything to say.
 *
 * ## The escape hatch is part of the design, not a concession
 *
 * Strictness here has a real cost: a pass takes minutes, and the moment it is
 * mandatory it stands between the operator and something urgent at exactly the
 * wrong time. So `cancelled` is a first-class way to settle a night — the pass
 * is aborted, its writes are rolled back, the boundary is marked, and the day
 * opens. The day is never held hostage by its own hygiene (I8).
 */

/** The hour (local) at which one day's memory ends and the next begins. */
export const NIGHT_HOUR = Number(process.env.NIGHTLY_HOUR ?? 4);

/**
 * A pass that lands in the hour BEFORE a boundary settles that boundary too.
 *
 * Without this the one double-dream window left open is the narrow one: fold at
 * 03:40, boundary at 04:00, and the machine asks for a second fold twenty
 * minutes later over a window with nothing in it. A pass that recent IS the
 * night; the clock is a schedule, not a definition.
 */
const SETTLE_FORWARD_MS = 60 * 60_000;

function utcDb(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The most recent day boundary at or before `now`, as UTC db text.
 *
 * Computed in LOCAL time and stored in UTC: the hour means something to the
 * person asleep through it, and the comparison has to survive a DST shift and
 * the rest of the database being UTC.
 */
export function nightBoundary(now: Date = new Date()): string {
  const b = new Date(now);
  b.setHours(NIGHT_HOUR, 0, 0, 0);
  if (b.getTime() > now.getTime()) b.setDate(b.getDate() - 1);
  return utcDb(b);
}

/** The next boundary after `now`. */
function nextBoundary(now: Date = new Date()): Date {
  const b = new Date(now);
  b.setHours(NIGHT_HOUR, 0, 0, 0);
  if (b.getTime() <= now.getTime()) b.setDate(b.getDate() + 1);
  return b;
}

export interface NightDebt {
  /** The boundary that has not been paid. */
  boundary: string;
  /** How long the day has been waiting, in minutes. */
  overdueMin: number;
  /** The last night that WAS settled, for context in a refusal. */
  last?: NightSettledRow;
}

/**
 * Is a night owed right now?
 *
 * `undefined` means the machine is square with itself and the day may run.
 */
export function nightOwed(now: Date = new Date()): NightDebt | undefined {
  const boundary = nightBoundary(now);
  const last = lastSettledNight();
  if (last && last.boundary >= boundary) return undefined;
  const overdueMin = Math.max(0, Math.round((now.getTime() - Date.parse(`${boundary.replace(' ', 'T')}Z`)) / 60_000));
  return { boundary, overdueMin, last };
}

/**
 * Mark the current night accounted for.
 *
 * Called by the pass itself on every terminal outcome — folded, quiet, or
 * cancelled — because every one of them means the day may now start. The one
 * outcome that must NOT settle is a pass that FAILED: the window it was going
 * to fold is still unfolded, and the retry is the whole point.
 */
export function settleTonight(how: NightSettledRow['how'], note?: string, now: Date = new Date()): string {
  const boundary = nightBoundary(now);
  settleNight(boundary, how, note);
  if (nextBoundary(now).getTime() - now.getTime() <= SETTLE_FORWARD_MS) {
    settleNight(utcDb(nextBoundary(now)), how, note ? `${note} (settled forward)` : 'settled forward');
  }
  return boundary;
}

/** One line for a human: what the machine is waiting for. */
export function describeDebt(d: NightDebt): string {
  const h = Math.floor(d.overdueMin / 60);
  const ago = h ? `${h}h ${d.overdueMin % 60}m` : `${d.overdueMin}m`;
  const last = d.last ? `Last settled night: ${d.last.boundary} (${d.last.how}).` : 'No night has ever been settled.';
  return `The night of ${d.boundary} UTC has not been folded — ${ago} overdue. ${last}`;
}
