import { foldObservation, inboxDepth, pendingObservations, unattributedRefs } from './db.js';
import { captureObservation } from './observe.js';

/**
 * Read the observation inbox by hand.
 *
 *   npx tsx src/inboxCli.ts                        # depth + the pending queue
 *   npx tsx src/inboxCli.ts --missing              # refs that resolved to nothing
 *   npx tsx src/inboxCli.ts --fold <id> <outcome>  # mark one drained
 *   npx tsx src/inboxCli.ts --add "<text>" ref,ref # queue one (a capture test)
 *
 * The inbox's whole risk is that nobody drains it — a queue nobody reads is a
 * graph nobody writes, one level up, and that is the failure this round exists
 * to end. Until the nightly fold lands (M2), this is how the queue gets looked
 * at, and `--missing` is how the discovery signal gets read: the refs the day
 * kept reaching for and not finding are where the graph should grow next.
 */

const argv = process.argv.slice(2);
const flag = (name: string) => argv.indexOf(`--${name}`);

if (flag('fold') >= 0) {
  const id = Number(argv[flag('fold') + 1]);
  const outcome = argv.slice(flag('fold') + 2).join(' ');
  if (!id || !outcome) {
    console.error('usage: inboxCli.ts --fold <id> <what you did about it>');
    process.exit(1);
  }
  foldObservation(id, outcome);
  console.log(`folded #${id}`);
  process.exit(0);
}

if (flag('add') >= 0) {
  const text = argv[flag('add') + 1] ?? '';
  const about = (argv[flag('add') + 2] ?? '').split(',').filter(Boolean);
  if (!text) {
    console.error('usage: inboxCli.ts --add "<text>" ref,ref');
    process.exit(1);
  }
  const c = captureObservation({ text, about, source: 'cli' });
  console.log(`#${c.id} → resolved [${c.resolved.join(', ')}] · unresolved [${c.unresolved.join(', ')}]`);
  process.exit(0);
}

if (flag('missing') >= 0) {
  const rows = unattributedRefs(40);
  if (!rows.length) console.log('no unresolved refs — every observation landed on a node');
  for (const r of rows) console.log(`${String(r.hits).padStart(4)}×  ${r.ref}`);
  process.exit(0);
}

const { pending, oldest, unattributable } = inboxDepth();
console.log(`inbox: ${pending} pending · ${unattributable} naming nothing · oldest ${oldest ?? '—'}\n`);
for (const o of pendingObservations()) {
  const refs = o.refs.length ? o.refs.join(', ') : '(nothing resolved)';
  const miss = o.unresolved.length ? `  ?${o.unresolved.join(' ?')}` : '';
  console.log(`#${o.id} ${o.created_at} [${o.source}]\n    ${o.text}\n    → ${refs}${miss}${o.evidence ? `\n    ⤷ ${o.evidence}` : ''}`);
}
