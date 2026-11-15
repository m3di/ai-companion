import { ask, reset } from './debugAgent.js';
import { onTurn } from './agentTurns.js';

/** Subscribe as soon as the run id exists, and remember how to unsubscribe. */
function onceOpen(sub: (runId: number) => () => void): (runId: number) => void {
  return (runId) => {
    const off = sub(runId);
    process.on('exit', off);
  };
}

/**
 * Talk to the operator's agent.
 *
 *   npx tsx src/agentCli.ts "what would renaming core-api/monolith cost?"
 *   npx tsx src/agentCli.ts --reset      # start a fresh session
 *
 * The session PERSISTS between calls: ask what something costs, read the
 * answer, then say "do it" — each prompt builds on the last, which is the
 * whole shape of operator work.
 */
const args = process.argv.slice(2);
if (args.includes('--reset')) {
  reset();
  console.log('Session cleared. The next prompt pays for a fresh brief.');
  process.exit(0);
}
const prompt = args.join(' ').trim();
if (!prompt) {
  console.error('say something — a prompt is the thing under review');
  process.exit(2);
}
// A terminal gets the same stream the page does: steps as they happen, and the
// answer as it is written rather than in one block at the end.
const off = onceOpen((runId) =>
  onTurn(runId, (ev) => {
    if (ev.kind === 'delta') process.stdout.write(ev.text);
    else if (ev.kind === 'step') console.log(`\n  · ${ev.step}`);
  }),
);
const t = await ask(prompt, off);
console.log('\n');
console.log(`— run #${t.runId}, ${t.steps.length} tool call(s)${t.costUsd ? `, $${t.costUsd.toFixed(3)}` : ''}`);
