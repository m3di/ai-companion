import { lintGraph, RULES, type Severity } from './graphLint.js';

/**
 * The graph linter, on demand — and for now, ONLY on demand.
 *
 *   npx tsx src/lintCli.ts              # counts per rule and per domain
 *   npx tsx src/lintCli.ts --findings   # every finding, one line each
 *   npx tsx src/lintCli.ts --code W203  # one rule in full
 *   npx tsx src/lintCli.ts --domain core-api
 *
 * Nothing here enforces anything. This is the measurement that has to come
 * before the ratchet: a yellow budget the night can never hold is worse than no
 * budget, because it fails every night and then gets switched off.
 */

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const val = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const report = lintGraph();
const onlyCode = val('--code');
const onlyDomain = val('--domain');

const MARK: Record<Severity, string> = { red: 'RED   ', yellow: 'YELLOW', blue: 'blue  ' };

console.log('='.repeat(78));
console.log(`GRAPH LINT — ${report.entities} entities, read-only, no enforcement`);
console.log('='.repeat(78));

console.log('\nBY SEVERITY');
console.log(`  RED    ${String(report.bySeverity.red).padStart(5)}   the graph is wrong — refused at the write`);
console.log(`  YELLOW ${String(report.bySeverity.yellow).padStart(5)}   the graph is badly shaped`);
console.log(`    of which BIRTH ${String(report.birth).padStart(4)}   enforced at the write now; this is historical residue`);
console.log(`    of which ROT   ${String(report.rot).padStart(4)}   <- THE BUDGET. Ordinary work does not add these.`);
console.log(`  blue   ${String(report.bySeverity.blue).padStart(5)}   measured only, never gates`);

console.log('\nBY RULE — every rule reported whether or not it fired');
for (const r of report.byCode) {
  const rule = RULES.find((x) => x.code === r.code)!;
  const cls = r.cls ? `[${r.cls.padEnd(5)}]` : '       ';
  console.log(`  ${MARK[r.severity]} ${r.code} ${cls} ${String(r.n).padStart(5)}   ${rule.what}`);
}

console.log('\nBY DOMAIN — sorted by yellow, which is the budget under discussion');
console.log(`  ${'domain'.padEnd(20)} ${'nodes'.padStart(6)} ${'red'.padStart(5)} ${'yellow'.padStart(7)} ${'blue'.padStart(6)}  yellow/node`);
for (const d of report.byDomain) {
  const per = d.entities ? (d.yellow / d.entities).toFixed(2) : '—';
  console.log(
    `  ${d.domain.padEnd(20)} ${String(d.entities).padStart(6)} ${String(d.red).padStart(5)} ${String(d.yellow).padStart(7)} ${String(d.blue).padStart(6)}  ${per}`,
  );
}

if (has('--findings') || onlyCode || onlyDomain) {
  const rows = report.findings
    .filter((x) => !onlyCode || x.code === onlyCode)
    .filter((x) => !onlyDomain || x.domain === onlyDomain);
  console.log(`\nFINDINGS (${rows.length})`);
  for (const x of rows) console.log(`  ${x.code} ${x.id.padEnd(42)} ${x.detail}`);
} else {
  console.log('\n  (--findings for the list, --code E101 or --domain core-api to narrow)');
}
