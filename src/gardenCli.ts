import { applyWrite } from './entityWrite.js';
import { plan, renderPlan, skipPacket } from './gardener.js';
import { lintGraph } from './graphLint.js';

/**
 * The gardener, by hand.
 *
 *   npx tsx src/gardenCli.ts              # the plan: what needs doing, with context
 *   npx tsx src/gardenCli.ts --limit 30   # a heavier pass
 *   npx tsx src/gardenCli.ts --apply      # commit the MECHANICAL fixes only
 *   npx tsx src/gardenCli.ts skip <code> <id> reference|unknown "<reason>"   # decline a packet durably
 *
 * `--apply` is deliberately narrow. On 2026-08-07 the deterministically fixable
 * classes were counted across the whole graph and came to almost nothing — the
 * write path's guards had already prevented them. What is left needs judgment,
 * and the honest shape for judgment is a packet a reader answers, not an
 * algorithm that guesses. So this commits one class (symmetric relates-to) and
 * prints the rest.
 *
 * Everything it does IS journalled through the normal write path, so a heavy
 * pass is revertible row by row like any other night's work.
 */

const args = process.argv.slice(2);
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};

// npx tsx src/gardenCli.ts skip W213 personal/focus-set reference "a standing lane, not a plan"
if (args[0] === 'skip') {
  const [, code, id, decision, ...rest] = args;
  const r = skipPacket({ code: code ?? '', id: id ?? '', decision: decision ?? '', reason: rest.join(' '), actor: 'cli' });
  console.log(r.ok ? `${code} ${id} declined as ${decision}.` : `REFUSED: ${r.problem}`);
  process.exit(r.ok ? 0 : 1);
}

const p = plan(num('--limit', 12));

if (!args.includes('--apply')) {
  console.log(renderPlan(p));
  process.exit(0);
}

const before = lintGraph();
console.log(`Applying ${p.safe.length} mechanical fix(es). rot ${before.rot}, ${before.entities} entities.\n`);

let ok = 0;
const refused: string[] = [];
for (const k of p.safe) {
  if (!k.op) {
    refused.push(`${k.id}: marked safe but carries no op — a bug in the gardener, not the graph`);
    continue;
  }
  const target = 'target' in k.op ? k.op.target : '?';
  const r = applyWrite(
    k.op,
    `gardener ${k.code}: collapsing a symmetric relates-to — ${target} relates-to ${k.id} carries the same statement, and neighbours() reads both directions`,
    'gardener',
  );
  if (r.ok) {
    ok++;
    console.log(`  ✓ ${k.id} —relates-to→ ${target}  dropped`);
  } else {
    refused.push(`${k.id} → ${target}: ${r.problem}`);
  }
}

const after = lintGraph();
console.log(`\n${ok} applied, ${refused.length} refused.`);
for (const r of refused) console.log(`  ✗ ${r}`);
// The number that says whether the pass was worth running. A gardening run that
// does not move it did work nobody asked for.
console.log(`rot ${before.rot} → ${after.rot} across ${after.entities} entities.`);
if (after.bySeverity.red) console.error(`\nRED: ${after.bySeverity.red} — the graph is worse than when this started. Revert from entity_writes.`);
