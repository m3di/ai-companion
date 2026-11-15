import { loadGraph } from './entities.js';
import { parkUnanswered, SILENCE_ASKS } from './silence.js';
import { openGoalQuestions, parkedBySilence } from './touch.js';

/**
 * The goal questions, by hand.
 *
 *   npx tsx src/touchCli.ts          # open questions: asked how often, when last; and what is parked
 *   npx tsx src/touchCli.ts --park   # run the night's silence step now (writes the graph)
 */

const args = process.argv.slice(2);
const g = loadGraph();

if (args.includes('--park')) {
  const parked = parkUnanswered({ actor: 'cli' });
  console.log(parked.length ? parked.map((p) => `parked ${p.id} — asked ${p.asked}× since ${p.since}`).join('\n') : `nothing to park (threshold ${SILENCE_ASKS} asks)`);
  process.exit(0);
}

const open = openGoalQuestions();
console.log(`GOAL QUESTIONS — ${open.length} open (parked at ${SILENCE_ASKS} unanswered asks)`);
for (const d of open) {
  const e = g.entities.get(d.entity_id);
  const state = !e ? 'gone' : e.dormant ? 'dormant' : e.goal ? 'is a goal' : 'open';
  console.log(`  ${d.entity_id.padEnd(46)} asked ${d.nudges}×${d.last_nudged_at ? ` (last ${d.last_nudged_at.slice(0, 16)})` : ''} · since ${d.at.slice(0, 10)} · ${state}`);
  if (d.reason) console.log(`      night: ${d.reason.slice(0, 140)}`);
}
const parked = parkedBySilence();
if (parked.length) {
  console.log(`\nPARKED BY SILENCE — ${parked.length}`);
  for (const d of parked) {
    const e = g.entities.get(d.entity_id);
    console.log(`  ${d.entity_id.padEnd(46)} ${d.at.slice(0, 10)} · ${d.reason} · now ${e?.dormant ? 'still parked' : 'revived'}`);
  }
}
