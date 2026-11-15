import { eventsSince } from './db.js';
import { toUtcDb } from './commitments.js';

/**
 * The awareness feed — the read side of the events blackboard. The concierge
 * prompt gets a compact, fixed-cost tail of what happened across the system
 * TODAY. (Workers no longer receive a blanket bulletin — their brief carries
 * what their task needs; round 5, §3.11.)
 */

const EVENT_CAP = 10;

/** Local start-of-today as DB-format UTC text. */
function todayStartUtc(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return toUtcDb(d);
}

/** Today's events as "HH:MM [source] body" lines (local time), oldest-first. */
export function todaysEventLines(chatId: number, cap = EVENT_CAP): string[] {
  return eventsSince(chatId, todayStartUtc(), cap).map((e) => {
    const t = new Date(`${e.created_at.replace(' ', 'T')}Z`);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} [${e.source}] ${e.body}`;
  });
}

