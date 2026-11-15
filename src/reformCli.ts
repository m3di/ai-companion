import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { loadGraph, reformedDomains, renderRecords, VIEW_FILE } from './entities.js';
import { reformDomain } from './reform.js';
import { renderMap, simplify } from './simplify.js';

/**
 * Migration driver for round 8 — run the reformer over domains, by hand.
 *
 * The reform is a one-per-domain, evidence-complete pass that costs real money
 * and several minutes, and it REWRITES a domain's knowledge. That makes it a
 * deliberate operation rather than something the nightly should discover it can
 * do, so it lives behind an explicit command until the shape has been judged on
 * real output.
 *
 *   npx tsx src/reformCli.ts --out <staging-dir> <domain>...
 *   npx tsx src/reformCli.ts --live <domain>...      # writes the real tree
 *   npx tsx src/reformCli.ts --render <domain>...    # regenerate _map.md only
 *
 * `--out` is the default posture: staging first, judge, then migrate.
 */

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const renderOnly = argv.includes('--render');
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : undefined;
const named = argv.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
// `--render` with no domains means every reformed domain: regenerating views is
// free and derived, so the whole-tree repair should be the easy thing to type.
const domains = named.length ? named : renderOnly ? reformedDomains() : [];

if (!domains.length) {
  console.error('usage: reformCli.ts [--out <dir> | --live | --render] <domain>...');
  process.exit(1);
}
if (!live && !renderOnly && !outDir) {
  console.error('refusing to run: pass --out <dir> to stage, or --live to write the real tree');
  process.exit(1);
}

const chatId = [...config.allowedChatIds][0];
if (chatId === undefined) {
  console.error('no ALLOWED_CHAT_IDS configured — evidence gathering needs a chat to search');
  process.exit(1);
}

/**
 * Regenerate a domain's VIEWS from its rows — both `entities.md` and `_map.md`.
 *
 * Both are derived, so this costs nothing and needs no model: it is the repair
 * path whenever the renderer changes. That property is the point of the data /
 * presentation split — a bug in how memory is displayed never requires
 * re-deriving the memory itself.
 */
function render(domain: string, dir: string): void {
  const graph = loadGraph();
  if (graph.errors.length) {
    console.error(`  cannot render ${domain}: the graph has ${graph.errors.length} lint error(s)`);
    return;
  }
  const s = simplify(graph);
  mkdirSync(join(dir, domain), { recursive: true });
  const mine = [...graph.entities.values()].filter((e) => e.domain === domain).sort((a, b) => a.line - b.line);
  if (mine.length) writeFileSync(join(dir, domain, VIEW_FILE), renderRecords(mine));
  writeFileSync(join(dir, domain, '_map.md'), renderMap(domain, graph, s));
  const paths = s.criticalPaths.filter((p) => p.goal.startsWith(`${domain}/`));
  console.log(`  rendered ${domain}/${VIEW_FILE} + _map.md${paths.length ? ` · critical path: ${paths[0]!.path.map((i) => i.split('/').pop()).join(' → ')}` : ''}`);
}

let total = 0;
for (const domain of domains) {
  if (renderOnly) {
    render(domain, config.knowledgeDir);
    continue;
  }
  // Feed already-reformed entities forward so a later domain can point AT an
  // earlier one instead of inventing a dangling reference. Only live-tree
  // entities count: a staged run has not landed anywhere the graph can see.
  const knownIds = live ? [...loadGraph().entities.keys()].filter((id) => !id.startsWith(`${domain}/`)) : [];
  const started = Date.now();
  const r = await reformDomain(chatId, domain, { outDir: live ? undefined : outDir, knownIds });
  total += r.costUsd;
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(
    `=== ${domain}: ${r.ok ? 'OK' : 'FAILED'} · ${r.entities} entities · ${r.attempts} attempt(s) · $${r.costUsd.toFixed(3)} · ${secs}s`,
  );
  if (!r.ok) console.log(r.errors);
  else if (live) render(domain, config.knowledgeDir);
}
console.log(`total: $${total.toFixed(2)}`);
