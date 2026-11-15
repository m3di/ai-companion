import { postEvent, recordPacketDecision, standingPacketDecisions } from './db.js';
import { loadGraph } from './entities.js';
import { applyWrite } from './entityWrite.js';
import { goalReach } from './graphLint.js';

/**
 * SILENCE → DORMANT. Step three of the goal work (2026-09-05).
 *
 * The walnut plan was replayed for two months because nothing could age it:
 * no field said it had been raised, and no field said it had been ignored.
 * Now the touch-watch (src/touch.ts) asks, in the flow, what a plan is for,
 * and counts the asks. This is what the count is FOR: a plan asked about
 * SILENCE_ASKS times with no answer — no goal recorded, still not parked — is
 * parked by the night. It stays in the graph and stays probed; it stops being
 * surfaced, stops being asked about, and stops charging W213.
 *
 * Mechanical and journalled, not a model's call: "asked three times, no
 * answer" is a measured fact, and the write is one `dormant` op a single
 * message can undo. Mehdi hears about it — the park posts to the awareness
 * feed the concierge reads at session open and when it sets up the morning —
 * because a topic dropped in silence is the "bot forgot" feeling from the
 * other side.
 *
 * What parking does NOT do, said plainly: the morning worker composes its
 * quests from its own brief, not from the graph, so a parked plan stops being
 * surfaced by memory but not by that prose until the brief says to check. The
 * event names that.
 */

export const SILENCE_ASKS = 3;

export interface Parked {
  id: string;
  asked: number;
  /** When the question was first opened by the night. */
  since: string;
}

export function parkUnanswered(opts: { chatId?: number; threshold?: number; actor?: string } = {}): Parked[] {
  const threshold = opts.threshold ?? SILENCE_ASKS;
  const actor = opts.actor ?? 'nightly';
  const due = standingPacketDecisions().filter((d) => d.code === 'W213' && d.decision === 'unknown' && d.nudges >= threshold);
  if (!due.length) return [];
  const g = loadGraph();
  const reaches = goalReach(g);
  const out: Parked[] = [];
  for (const d of due) {
    const e = g.entities.get(d.entity_id);
    if (!e || e.goal || e.dormant || reaches(e.id)) continue; // answered, or already parked
    const reason = `parked by silence: asked what it is for ${d.nudges}× in the flow since ${d.at.slice(0, 10)} with no answer, and the night could not find a goal in the evidence (${d.reason.slice(0, 100)})`;
    const r = applyWrite({ op: 'dormant', id: e.id, dormant: true }, reason, actor);
    if (!r.ok) {
      console.error(`[silence] could not park ${e.id}: ${r.problem}`);
      continue;
    }
    recordPacketDecision({ code: 'W213', entity_id: e.id, decision: 'parked', reason: `after ${d.nudges} unanswered asks`, evidence: e.chain.join(','), actor });
    if (opts.chatId !== undefined) {
      postEvent(
        opts.chatId,
        'night',
        `parked ${e.id}: asked ${d.nudges}× what this plan is for, no answer — it no longer competes for attention (one message revives it: record dormant:false). ` +
          `Anything that still draws on it by prose — the morning routine's brief, a standing quest — should stop until Mehdi picks it back up.`,
      );
    }
    out.push({ id: e.id, asked: d.nudges, since: d.at });
  }
  return out;
}
