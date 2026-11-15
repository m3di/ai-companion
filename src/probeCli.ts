import { loadGraph } from './entities.js';
import { sweepProbes } from './prober.js';

/**
 * Run the entity probe sweep by hand.
 *
 * The sweep is also scheduled in the bot process, but a manual run matters at
 * two moments: right after a migration, when every entity is unprobed and the
 * focus set is only provisional until real state lands; and when debugging a
 * probe that is not answering the question it was written for.
 */

const graph = loadGraph();
const probed = [...graph.entities.values()].filter((e) => e.probe);
console.log(`${graph.entities.size} entities · ${probed.length} with probes · ${graph.errors.length} lint errors`);
if (graph.errors.length) {
  console.error('refusing to sweep a graph that fails lint');
  process.exit(1);
}

const started = Date.now();
const results = await sweepProbes();

const baselines = results.filter((r) => r.skipped === 'baseline');
const changed = results.filter((r) => r.changed);
const failed = results.filter((r) => r.skipped?.startsWith('probe failed') || r.skipped === 'probe not allowlisted');
const quiet = results.length - baselines.length - changed.length - failed.length;

console.log(
  `\nswept ${results.length} in ${Math.round((Date.now() - started) / 1000)}s — ` +
    `${baselines.length} baselined · ${changed.length} changed · ${quiet} unchanged · ${failed.length} failed`,
);

// A failing probe is the interesting output: it means an entity that looked
// self-maintaining is not, and nobody would otherwise find out.
for (const f of failed) console.log(`  FAILED ${f.id}: ${f.skipped}`);
for (const c of changed) console.log(`  CHANGED ${c.id}: ${c.before?.slice(0, 50)} → ${c.after?.slice(0, 50)}`);

const after = loadGraph();
const byStatus = new Map<string, number>();
for (const e of after.entities.values()) {
  if (!e.probe) continue;
  byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
}
console.log('\nprobed entities by status:', [...byStatus].map(([s, n]) => `${n} ${s}`).join(' · '));
