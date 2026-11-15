import { renderVitals, vitals } from './vitals.js';

/**
 * The machine's vital signs — the first thing an operator session reads.
 *
 *   npx tsx src/vitalsCli.ts          # one screen
 *   npx tsx src/vitalsCli.ts --json   # for an agent to reason over
 *
 * Free by design: no subprocess, no model, no network. The audit answers "is
 * anything broken" and costs a minute; this answers "what state is this thing
 * in" and costs nothing, which is the only reason it gets read every time.
 */
const v = vitals();
console.log(process.argv.includes('--json') ? JSON.stringify(v, null, 2) : renderVitals(v));
