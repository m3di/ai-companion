import { callModule, evalInModule, listModules, MODULES_DIR, renderCatalog, renderResult, validateModule } from './modules.js';

/**
 * Drive the knowledge API by hand.
 *
 *   npx tsx src/moduleCli.ts                          # the catalog
 *   npx tsx src/moduleCli.ts entities openLoops core-api
 *   npx tsx src/moduleCli.ts --eval entities 'm.openLoops().length'
 *   npx tsx src/moduleCli.ts --validate entities      # tsc + its own tests
 *
 * This is also the honest way to answer "is the catalog worth its context?" —
 * call the same questions an agent would, and read what comes back.
 */

const argv = process.argv.slice(2);

if (argv.includes('--validate')) {
  const names = argv.filter((a) => !a.startsWith('--'));
  const targets = names.length ? names : listModules().map((m) => m.name);
  let bad = 0;
  for (const name of targets) {
    const v = await validateModule(name);
    console.log(`${v.ok ? 'OK  ' : 'FAIL'} ${v.module}${v.problems.length ? ` — ${v.problems.join('; ')}` : ''}`);
    if (v.typecheck) console.log(v.typecheck);
    if (v.tests) console.log(v.tests);
    if (!v.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

if (argv[0] === '--eval') {
  const [, module, expr] = argv;
  if (!module || !expr) {
    console.error("usage: moduleCli.ts --eval <module> '<expression>'");
    process.exit(1);
  }
  const r = await evalInModule(module, expr);
  console.log(renderResult(r));
  process.exit(r.ok ? 0 : 1);
}

const [module, fn, ...rest] = argv;
if (!module) {
  const mods = listModules();
  console.log(`modules dir: ${MODULES_DIR}`);
  console.log(mods.length ? renderCatalog() : 'no modules yet');
  process.exit(0);
}
if (!fn) {
  console.error(`usage: moduleCli.ts <module> <fn> [json args...]\n\n${renderCatalog()}`);
  process.exit(1);
}

// Arguments are JSON when they parse as JSON, and plain strings otherwise — so
// `openLoops core-api` works without anyone having to quote a shell string twice.
const args = rest.map((a) => {
  try {
    return JSON.parse(a) as unknown;
  } catch {
    return a;
  }
});

const r = await callModule(module, fn, args);
console.log(renderResult(r));
console.log(`\n(${r.ms}ms${r.truncated ? ', truncated' : ''})`);
process.exit(r.ok ? 0 : 1);
