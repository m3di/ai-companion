import { closeGardenRun, openGardenRun } from './gardenRun.js';
import { recentRuns } from './runs.js';

/**
 * Run the gardener as a reviewable ATTEMPT.
 *
 *   npx tsx src/gardenRunCli.ts open --linter            # findings choose the work
 *   npx tsx src/gardenRunCli.ts open "split ci-robustness-38"   # you choose it
 *   npx tsx src/gardenRunCli.ts close <id> "what I did and skipped"
 *   npx tsx src/gardenRunCli.ts list
 *
 * `open` prints a brief and leaves the run OPEN, so every `record()` made after
 * it — by you, by an agent, from any process — is attributed to that attempt.
 * `close` seals it and reports what it was worth.
 *
 * The split matters: the work in between is a person or an agent reading and
 * deciding, which no callback can wrap. The cost is that an abandoned run keeps
 * claiming later writes, so `list` shows an open run first.
 */

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'open': {
    const linter = rest.includes('--linter');
    // Drop flags AND their values. The first cut kept the value, so
    // `open --linter --limit 3` recorded the prompt as "3" — and the prompt is
    // the one field this whole ledger exists to make reviewable.
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === '--limit') { i++; continue; }
      if (a.startsWith('--')) continue;
      words.push(a);
    }
    const prompt = linter
      ? words.join(' ') || 'Reduce the graph\'s rot: take the highest-weight packets that the evidence settles.'
      : words.join(' ');
    if (!prompt) {
      console.error('a prompt run needs an instruction — that instruction IS the thing under review');
      process.exit(2);
    }
    const b = await openGardenRun({ trigger: linter ? 'linter' : 'prompt', prompt, limit: Number(rest[rest.indexOf('--limit') + 1]) || 8 });
    console.log(b.brief);
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Run #${b.runId} is OPEN. rot ${b.rotBefore}. Every record() from now is attributed to it.`);
    console.log(`Close with:  npx tsx src/gardenRunCli.ts close ${b.runId} "what you did and skipped"`);
    break;
  }

  case 'close': {
    const id = Number(rest[0]);
    const outcome = rest.slice(1).join(' ');
    if (!id || !outcome) {
      console.error('close needs a run id and an outcome — "what I changed and what I skipped, and why"');
      process.exit(2);
    }
    const r = closeGardenRun(id, 0, outcome);
    console.log(`Run #${r.runId} closed. ${r.writes} write(s), ${r.touched.length} node(s) touched. rot now ${r.rotAfter}.`);
    for (const t of r.touched) console.log(`  ${t}`);
    break;
  }

  case 'list':
  default: {
    for (const r of recentRuns(Number(rest[0]) || 10)) {
      const state = r.ended_at ? '' : '  ← OPEN';
      console.log(`#${r.id} ${r.kind}/${r.trigger}  ${r.started_at}${state}`);
      console.log(`   prompt:  ${r.prompt.slice(0, 90)}`);
      console.log(`   writes:  ${r.writes.length}, touched ${r.touched.length}: ${r.touched.slice(0, 5).join(', ')}`);
      if (r.outcome) console.log(`   outcome: ${r.outcome.slice(0, 120)}`);
      console.log('');
    }
    break;
  }
}
