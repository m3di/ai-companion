import { frictionSummary, moduleUse, openFriction, resolveFriction } from './db.js';
import { unusedFunctions } from './modules.js';

/**
 * Read the friction ledger by hand.
 *
 * The night's code audit (round 9 step 5) is what will consume this, but the
 * ledger starts filling the moment step 2 lands and friction data takes CALENDAR
 * time to accumulate — so there has to be a way to watch it grow, and to judge
 * whether the detector is measuring what it claims to.
 *
 *   npx tsx src/frictionCli.ts              # open friction, loudest first
 *   npx tsx src/frictionCli.ts --resolve 3 7 --as "added entities.search()"
 */

const argv = process.argv.slice(2);
const resolveIdx = argv.indexOf('--resolve');

if (resolveIdx >= 0) {
  const asIdx = argv.indexOf('--as');
  const ids = argv
    .slice(resolveIdx + 1, asIdx >= 0 ? asIdx : undefined)
    .map(Number)
    .filter(Number.isFinite);
  const how = asIdx >= 0 ? argv.slice(asIdx + 1).join(' ') : 'resolved by hand';
  if (!ids.length) {
    console.error('usage: frictionCli.ts --resolve <id>... [--as "what fixed it"]');
    process.exit(1);
  }
  resolveFriction(ids, how);
  console.log(`resolved ${ids.length} row(s): ${how}`);
  process.exit(0);
}

const rows = openFriction();
const summary = frictionSummary();

console.log('=== FRICTION — where the API fell short');
if (!rows.length) {
  // Not an empty result — a finding. "No friction == the code is good, the logic
  // is solid" is the design's own success condition, not a missing feature.
  console.log('(none — nothing hit a wall the memory layer put there)');
} else {
  console.log(summary.map((s) => `${s.kind}: ${s.rows} row(s), ${s.hits} hit(s)`).join(' · '));
  for (const r of rows) {
    const where = [r.module, r.fn].filter(Boolean).join('.');
    console.log(`#${r.id} [${r.kind}] ${r.signature}${where ? ` · ${where}` : ''} — ${r.hits} hit(s), last ${r.last_at} UTC`);
    for (const line of r.detail.split('\n').filter(Boolean).slice(0, 5)) console.log(`    ${line}`);
    if (r.session_key) console.log(`    last seen in session ${r.session_key}`);
  }
}

/**
 * USE is the louder half, and the reason this section exists at all: an agent
 * that hand-rolls an answer out of two eval expressions never fails, so it never
 * lands above. A composition that keeps recurring is a missing function stated
 * in code by the caller.
 */
const use = moduleUse();
console.log('\n=== USE — what the API was actually asked to do');
if (!use.length) {
  console.log('(none yet)');
} else {
  for (const u of use) {
    const avg = u.hits ? Math.round(u.ms_total / u.hits) : 0;
    const label = u.fn === '(eval)' ? `composed ${u.shape || '(nothing known)'}` : `${u.module}.${u.fn}`;
    console.log(`${label} — ${u.hits} call(s)${u.ok_hits < u.hits ? `, ${u.hits - u.ok_hits} failed` : ''}, ~${avg}ms, last ${u.last_at} UTC`);
    for (const ex of u.examples.split('\n').filter(Boolean).slice(0, 4)) console.log(`    ${ex}`);
  }
}

// The counterweight to a catalog that only grows (§8).
const dead = unusedFunctions();
if (dead.length) {
  console.log('\n=== UNUSED — retirement candidates');
  for (const d of dead) {
    console.log(`${d.module}.${d.fn} — ${d.neverCalled ? 'never called' : `last called ${d.lastCalled} UTC`}`);
  }
}
