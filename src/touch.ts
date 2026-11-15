import { notePacketNudge, standingPacketDecisions, type PacketDecisionRow } from './db.js';
import { loadGraph } from './entities.js';
import { goalReach } from './graphLint.js';
import { CONTROL_SLOT } from './sessions.js';

/**
 * THE TOUCH-WATCH — a question asked when the topic is live, never on a clock.
 *
 * The night's W213 packet ends three ways, and one of them is a question only
 * Mehdi can answer: "the evidence does not say what this plan is for". The
 * first design had the night script that question and the day recite it, and
 * Mehdi named the failure before it shipped: "it will become 'why are you
 * ignoring my questions about walnut' and I will ignore it too." A question
 * on a schedule is the walnut in a different hat.
 *
 * So the cue rides on a READ. When the concierge reaches for a node whose goal
 * is unknown — find(), neighbours(), an eval that named it — the result
 * carries one line: this plan has no goal, the night could not find one, ask
 * in the flow. The topic is live by construction, because the concierge is
 * reading it in the middle of a turn about it. Nothing fires when nobody
 * touches it (I5), nothing is injected per turn (I12), and the ask count on
 * the ledger is the silence clock step three reads.
 *
 * Only the concierge is cued: a worker cannot ask Mehdi anything, the night
 * already declined, and the debug agent is the operator's, not his.
 */

/** Standing 'unknown' verdicts — the day's open questions. */
export function openGoalQuestions(): PacketDecisionRow[] {
  return standingPacketDecisions().filter((d) => d.code === 'W213' && d.decision === 'unknown');
}

/** Plans the night parked by silence (src/silence.ts) — still parked or not. */
export function parkedBySilence(): PacketDecisionRow[] {
  return standingPacketDecisions().filter((d) => d.code === 'W213' && d.decision === 'parked');
}

/** At most once a day per plan: a cue shown twice in one conversation is nagging. */
const NUDGE_EVERY_MS = 24 * 3_600_000;

function isConcierge(sessionKey: string): boolean {
  return sessionKey.endsWith(`:${CONTROL_SLOT}`);
}

/**
 * The lines a read should carry, given who read and what it touched. Empty
 * almost always — it costs nothing unless a touched ref has an open question,
 * and only then is the graph loaded to check the question is still open (a
 * goal recorded since the verdict closes it without anyone tidying the row).
 */
export function touchNudges(sessionKey: string, refs: string[], now = Date.now()): string[] {
  if (!refs.length || !isConcierge(sessionKey)) return [];
  const open = openGoalQuestions().filter((d) => refs.includes(d.entity_id));
  const parked = parkedBySilence().filter((d) => refs.includes(d.entity_id));
  if (!open.length && !parked.length) return [];
  const g = loadGraph();
  const reaches = goalReach(g);
  const out: string[] = [];
  const recently = (d: PacketDecisionRow) => !!d.last_nudged_at && now - new Date(`${d.last_nudged_at.replace(' ', 'T')}Z`).getTime() < NUDGE_EVERY_MS;
  // A PARKED plan being read: Mehdi may be bringing the topic back. The cue is
  // to revive it in the same breath as the question — not to re-park by habit.
  for (const d of parked) {
    const e = g.entities.get(d.entity_id);
    if (!e || e.goal || reaches(e.id) || recently(d)) continue;
    notePacketNudge(d.id);
    out.push(
      `⚑ ${e.id} was PARKED by the night${d.at ? ` on ${d.at.slice(0, 10)}` : ''}: it is a plan with no goal, and asking what it is for got no answer${d.reason ? ` (${d.reason.slice(0, 120)})` : ''}. ` +
      `It ${e.dormant ? 'is still parked' : 'has since been revived'}. If Mehdi is picking the topic back up: ` +
      `${e.dormant ? `record({op:'dormant', id:'${e.id}', dormant:false}) and ` : ''}ask what it is for — once, in your own words — and record the answer (a goal node, and an edge from ${e.id} to it). If it is not live, say nothing.`,
    );
  }
  for (const d of open) {
    const e = g.entities.get(d.entity_id);
    if (!e || e.goal || e.dormant || reaches(e.id)) continue; // answered, or parked
    if (recently(d)) continue;
    notePacketNudge(d.id);
    out.push(
      `⚑ ${e.id} is a plan with no goal above it: nothing in memory says what it is FOR, and the night could not find it in the evidence` +
      `${d.reason ? ` ("${d.reason.slice(0, 120)}")` : ''}${d.nudges ? `; you have raised it ${d.nudges}× before with no answer` : ''}. ` +
      `If the topic is live in this conversation, ask what it is for — once, in your own words, as part of what you were saying — and record the answer ` +
      `(record({op:'goal', id:'<the outcome>', goal:true}) on the outcome node, or an edge from ${e.id} to it). If it is not live, say nothing.`,
    );
  }
  return out;
}
