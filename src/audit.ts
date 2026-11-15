import { execFile } from 'node:child_process';
import type { CheckMissRow } from './db.js';
import {
  allEntityState,
  costPerDay,
  dbNow,
  frictionSummary,
  inboxDepth,
  lastRot,
  recordRot,
  apiUseSince,
  openFriction,
  pendingFindings,
  recentCheckMisses,
  recordFindingVerdict,
  retrievalsSince,
} from './db.js';
import { loadGraph } from './entities.js';
import { lintGraph, rulesetId } from './graphLint.js';
import { debugState } from './mode.js';
import { storyLint, storyRefs } from './storyTree.js';
import { rotationTally } from './rotation.js';
import { doorsTally } from './doors.js';
import { datedTally } from './dated.js';
import { moduleDrift } from './modules.js';
import { checkCommandAllowed, classifyCheck, runCommand } from './focus.js';
import { designProposalsSummary, verifyLandedProposals } from './proposals.js';

/**
 * THE NIGHT'S AUDIT — the machine reading its own discomfort (Charter M2).
 *
 * The night used to open by reading the day's CONTENT. It could tell you what
 * Mehdi worked on and never that its own state layer had been frozen for three
 * days, its test suite red the whole time, and its knowledge API called zero
 * times — all of which were true on 2026-07-31, and none of which any nightly
 * report mentioned, because nothing looked.
 *
 * So this runs FIRST, before a word of the timeline, and it obeys one rule:
 *
 *   EVERY INPUT GETS A LINE WHETHER OR NOT IT FOUND ANYTHING.
 *
 * That is the whole design. "Nothing to report" and "nobody looked" are the
 * exact pair this round exists to separate, and a block that renders only its
 * hits is indistinguishable from a block that is broken. A line saying "clean"
 * is worth its tokens because its ABSENCE is then meaningful.
 *
 * Everything here is measured in-process, except the suite and the typecheck,
 * which are run as subprocesses BY THE HARNESS rather than by the operator —
 * the operator has no shell by design, and giving it one to check its own tests
 * would trade a real boundary for a convenience.
 */

export interface AuditLine {
  /** Short name of the input, so a missing one is noticeable by its absence. */
  input: string;
  /** True when this input found something the night should act on. */
  fired: boolean;
  text: string;
}

const RUN_TIMEOUT_MS = 180_000;

/**
 * Run one npm script — with THREE outcomes, not two (I3).
 *
 * This returned `ok: !err`, so every way a subprocess can fail to answer —
 * a wall-clock timeout, a SIGKILL, a maxBuffer overflow — became "the check
 * FAILED". On 2026-08-18 that turned into proposal #33: "TYPECHECK RED — npm
 * run typecheck FAILS, per tonight's nightly health audit", filed against a
 * tree that typechecks clean at that exact commit.
 *
 * The mechanism is the same one that broke the dream hold the same night: a
 * fold spans 4-5 hours because the laptop SLEEPS through it, `execFile`'s
 * timeout is wall clock, and a suspended subprocess is killed on wake. The
 * audit then reported a machine that could not be measured as a machine that
 * is broken.
 *
 * That is I3 — "a check has three outcomes; only a VALUE may become state" —
 * violated by the audit whose whole job is to enforce it. And the cost is
 * specific: the audit's one promise is that a red suite reaches Mehdi by
 * morning (M2's acceptance test), and a check that cries wolf is one nobody
 * reads on the morning it is right.
 */
type RunOutcome = { state: 'pass' | 'fail' | 'unknown'; tail: string; why?: string };

function npmRun(script: string): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(
      'npm',
      ['run', '--silent', script],
      {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd: process.cwd(),
        // DB_PATH IS SCRUBBED, and this is not belt-and-braces — it is the hole.
        // The bot's environment names the LIVE database, `npm test` snapshots a
        // scratch copy by deleting it first, and inheriting the variable pointed
        // that deletion at the real thing. The night auditing its own health
        // must not be able to destroy what it is auditing.
        env: { ...process.env, DB_PATH: undefined, LIVE_DB_PATH: undefined },
      },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.trim();
        // The tail, not the head: a test runner's summary and a compiler's
        // errors both land at the end, and the head is setup noise.
        const tail = out.split('\n').slice(-25).join('\n');
        if (!err) return resolve({ state: 'pass', tail });
        // A NON-ZERO EXIT is the tool answering "broken". Anything else — a
        // signal, a wall-clock timeout, a buffer overrun — is the tool never
        // getting to answer, and must not be reported as an answer.
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
        const killed = e.killed || !!e.signal || e.code === 'ETIMEDOUT' || typeof e.code === 'string';
        if (killed) {
          return resolve({
            state: 'unknown',
            tail,
            why: e.signal ? `killed (${e.signal})` : String(e.code ?? 'did not complete'),
          });
        }
        resolve({ state: 'fail', tail });
      },
    );
  });
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The graph's own liveness: which entities have a probe, and whether the clock
 * is moving. 97 of 153 entities had no probe at all and nothing could say
 * whether that was fine (they are timeless facts) or a hole (they are open work
 * nobody watches) — so coverage is reported as a number either way.
 */
function probeCoverage(): AuditLine {
  const graph = loadGraph();
  const entities = [...graph.entities.values()];
  const open = entities.filter((e) => e.status === 'open' && !e.dormant);
  const unprobed = open.filter((e) => !e.probe);
  const state = allEntityState();
  const stale = entities
    .filter((e) => e.probe)
    .filter((e) => {
      const at = state.get(e.id)?.probed_at;
      return !at || Date.now() - new Date(`${at.replace(' ', 'T')}Z`).getTime() > 6 * 3_600_000;
    });
  const fired = stale.length > 0;
  const staleText = stale.length
    ? ` STALE: ${stale.length} probe(s) not run in 6h — ${stale.slice(0, 5).map((e) => e.id).join(', ')}. A frozen clock is the shape of the 2026-07-28 outage.`
    : ' every probe has run within 6h.';
  return {
    input: 'probe coverage',
    fired,
    text: `${entities.length} entities, ${open.length} open and not dormant, of which ${unprobed.length} have NO probe (nothing can close them but a person).${staleText}`,
  };
}

function frictionLine(): AuditLine {
  const rows = openFriction();
  const summary = frictionSummary();
  if (!rows.length) {
    return {
      input: 'friction ledger',
      fired: false,
      text: 'no open friction rows. Read this together with API use below — an empty ledger means the API did not fail, NOT that it was good, and it stays empty when nobody calls it at all.',
    };
  }
  // WHEN IT LAST HAPPENED, on every row. An open friction row is not a live
  // one: `entities.graph` sat at the top of this list with 5 errors from
  // 2026-07-31, six days after the fix, and read as current because nothing
  // here carried a date. Same mistake as the check-miss and API-use lines.
  const stale = daysAgo(1);
  const top = rows
    .slice(0, 8)
    .map(
      (r) =>
        `- [${r.kind} ×${r.hits}${r.last_at < stale ? ` · LAST SEEN ${r.last_at}, not since` : ''}] ` +
        `${r.module || '—'}${r.fn ? `.${r.fn}` : ''} ${r.signature}: ${r.detail.slice(0, 120)}`,
    )
    .join('\n');
  const live = rows.filter((r) => r.last_at >= stale);
  // A BYPASS IS EVIDENCE, NOT A FAULT. The night reading `root.md` and the
  // `_map.md` files raw is the second-store signal (I1/M5) and it is worth
  // seeing — but it happens every night, nothing in tonight's pass can fix it,
  // and an input that fires nightly on something unactionable teaches its reader
  // to skim. Errors and misses are faults; a bypass is a design observation.
  const faults = live.filter((r) => r.kind !== 'bypass').length;
  const bypasses = live.length - faults;
  return {
    input: 'friction ledger',
    fired: faults > 0,
    text:
      `${rows.length} open row(s); in the last 24h ${faults} fault(s)` +
      `${bypasses ? ` and ${bypasses} bypass(es) — raw reads of generated files, the M5 signal, not tonight's work` : ''}` +
      ` (${summary.map((s) => `${s.kind}:${s.hits}`).join(' ')}):\n${top}`,
  };
}

function apiUseLine(): AuditLine {
  const since = daysAgo(1);
  const rows = apiUseSince(since);
  const calls = rows.reduce((n, r) => n + r.hits, 0);
  if (!calls) {
    return {
      input: 'knowledge API use',
      fired: true,
      text: 'THE API WAS NOT CALLED ONCE in the last 24h. That is a finding about the API, not silence about it — a catalog nobody reaches for is either badly named, badly placed, or answering questions nobody has.',
    };
  }
  const top = rows
    .slice(0, 8)
    .map((r) => `- ${r.hits}× ${r.module}.${r.fn}${r.failed ? ` (${r.failed} failed IN THIS WINDOW)` : ''}`)
    .join('\n');
  return { input: 'knowledge API use', fired: false, text: `${calls} call(s) in 24h:\n${top}` };
}

/**
 * IS THE RUNNING INSTANCE THE ONE THIS REPO SHIPS?
 *
 * The live `entities` module spent two days behind its source with nothing
 * saying so. Its `record` doc listed neither `move` nor `retire`, so the night
 * could not reach for ops the write path had already given it — the 2026-08-04
 * pass left a NOTE about a misfiled entity it was able to move all along. It
 * took a hand diff to find, which is precisely what this audit exists to
 * replace.
 */
function moduleDriftLine(): AuditLine {
  const drift = moduleDrift();
  if (!drift.length) {
    return { input: 'module drift', fired: false, text: 'every seeded module matches what the repo ships.' };
  }
  const mine = drift.filter((d) => !d.edited);
  const theirs = drift.filter((d) => d.edited);
  const parts: string[] = [];
  // Stale-and-untouched should be impossible: boot repairs it. If one shows up
  // here, the repair itself is broken, and that is worth saying loudly.
  if (mine.length) parts.push(`${mine.map((d) => d.name).join(', ')} — stock copies still behind the repo AFTER a boot repair; seeding is not working.`);
  if (theirs.length) {
    parts.push(
      `${theirs.map((d) => d.name).join(', ')} — edited in the tree, so nothing will overwrite them (the night's work outranks the repo's). Reconcile by hand if the repo has since moved.`,
    );
  }
  return { input: 'module drift', fired: mine.length > 0, text: parts.join('\n') };
}

/**
 * THE GRAPH'S SHAPE, AND WHETHER IT IS GETTING WORSE.
 *
 * Reds are refused at the write path, and birth defects are refused at the
 * mint, so neither can accrue — if either is above zero it is historical
 * residue and named as such. What is left is ROT: the decay ordinary editing
 * produces and ordinary care prevents.
 *
 * This reports the number and its direction. It does NOT yet block, and the
 * distinction is deliberate: a budget needs a trend before it can have a
 * threshold, and a threshold guessed today would be defended tomorrow instead
 * of the graph.
 */
function graphShapeLine(prevRot: number | undefined, r: ReturnType<typeof lintGraph>): AuditLine {
  const delta = prevRot === undefined ? undefined : r.rot - prevRot;
  const arrow = delta === undefined ? 'fresh baseline — no comparable prior reading (the rules changed)' : delta > 0 ? `UP ${delta}` : delta < 0 ? `down ${-delta}` : 'unchanged';
  const worst = r.byCode
    .filter((c) => c.cls === 'rot' && c.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((c) => `${c.code}×${c.n}`)
    .join(' ');
  const residue = [
    r.bySeverity.red ? `${r.bySeverity.red} RED (write path should make this impossible — investigate)` : '',
    r.birth ? `${r.birth} birth defect(s) predating the mint checklist` : '',
  ].filter(Boolean);
  return {
    input: 'graph shape',
    // Rot going UP is the only thing here worth interrupting for.
    fired: (delta ?? 0) > 0 || r.bySeverity.red > 0,
    text:
      `rot ${r.rot} (${arrow}) across ${r.entities} entities — ${worst}.` +
      (residue.length ? `\n${residue.join('\n')}` : '') +
      `\nRot is the budgetable number: ordinary work does not add it. \`npx tsx src/lintCli.ts --findings\` for the list.`,
  };
}

/** Read, then remember — so the NEXT audit has something to compare against.
 *  Split from the render so a reading is taken exactly once per audit. */
function graphShapeAndRecord(): AuditLine {
  const rules = rulesetId();
  const prev = lastRot(rules);
  const r = lintGraph();
  recordRot(r.rot, r.birth, r.entities, Object.fromEntries(r.byCode.map((c) => [c.code, c.n])), rules);
  return graphShapeLine(prev, r);
}

function checkMissLine(): AuditLine {
  const rows = recentCheckMisses(daysAgo(1));
  if (!rows.length) {
    return { input: 'unanswered checks', fired: false, text: 'every probe and focus check that ran produced a real value.' };
  }
  // FROZEN IS NOT FAILING. On 2026-08-06 the nightly pass read 40 rows here and
  // opened its report calling all 40 live; 36 had not moved since the fix landed
  // at 10:54 that morning, and the 2 that were still ticking had a different
  // cause entirely, which the count hid. A miss row records that a check failed
  // ONCE — only `last_at` says whether it still is.
  const STILL = 60 * 60 * 1000;
  const now = Date.now();
  const isLive = (r: CheckMissRow) => now - Date.parse(`${r.last_at}Z`) <= STILL;
  const live = rows.filter(isLive);
  const frozen = rows.filter((r) => !isLive(r));
  const show = (r: CheckMissRow) =>
    `- [${r.kind} ${r.outcome} ×${r.hits}] ${r.ref}: ${r.detail.slice(0, 100)}`;

  const parts = [
    live.length
      ? `${live.length} STILL FAILING (last seen within the hour) — these entities' states are the last ones that WERE real, however old:\n${live.slice(0, 10).map(show).join('\n')}`
      : 'Nothing has failed in the last hour.',
  ];
  if (frozen.length) {
    parts.push(
      `${frozen.length} STOPPED — last failure ${frozen.map((r) => r.last_at).sort().at(-1)}, nothing since. Recorded history, not a live fault; do not re-file these as open bugs.`,
    );
  }
  return {
    input: 'unanswered checks',
    // A day's worth of history that stopped failing is not something to wake
    // anyone for — only a live fault is.
    fired: live.length > 0,
    text: parts.join('\n\n'),
  };
}

function inboxLine(): AuditLine {
  const { pending, oldest, unattributable } = inboxDepth();
  if (!pending) {
    return {
      input: 'observation inbox',
      fired: false,
      text: 'empty. If the day plainly changed things, that is a finding about `observe` not being reached for.',
    };
  }
  return {
    input: 'observation inbox',
    fired: true,
    text: `${pending} unfolded (${unattributable} naming nothing in the graph), oldest ${oldest}. Fold every one tonight.`,
  };
}

/**
 * The whole pass. Ordered so the two that can be red — the suite and the
 * typecheck — come first: a red suite means every measurement below it is
 * suspect, and it was red for three days with nobody told.
 */
/**
 * IS THE CONCIERGE REACHING FOR THE FOCUS SET, OR ONLY BEING HANDED IT?
 *
 * This is the gate on step two. The focus set is ~20k characters of the most
 * volatile text in the system and it is injected into every concierge turn,
 * which is what makes the concierge re-cache its whole conversation each time
 * (I12). It cannot just be deleted, because unlike a worker the concierge ACTS
 * on it — so `readFocus` shipped first, alongside the injection, and the
 * injection may only be removed once this line shows the tool being used by
 * habit. A tool nobody calls means the prompt has not moved the behaviour, and
 * pulling the injected copy then would silently blind the concierge to the one
 * surface the whole focus design exists to keep visible.
 */
function focusReadLine(): AuditLine {
  const n = retrievalsSince('focus', daysAgo(1));
  if (!n) {
    return {
      input: 'focus re-reads',
      fired: true,
      // Now that the injection is GONE, a zero here is not "not ready yet" —
      // it is the concierge working blind, which is strictly worse than the
      // state this line was originally written to gate.
      text: 'readFocus() WAS NOT CALLED in the last 24h, and the injected snapshot is gone (2026-08-06) — so the concierge went a whole day without seeing the focus set at all. Either the prompt stopped pushing for it or the set stopped mattering; find out which.',
    };
  }
  return {
    input: 'focus re-reads',
    fired: false,
    text: `readFocus() called ${n}× — the concierge is reaching for the live set, which is the retrieval the injected copy used to pre-empt (I7/I12; injection removed 2026-08-06).`,
  };
}

/**
 * DOES THE PROPOSAL QUEUE STILL DESCRIBE REALITY?
 *
 * A pending proposal is a claim that something is still broken, and it is the
 * only claim in the system that nothing ever re-checks. On 2026-08-06 every one
 * of the five was already fixed; the night read them as live and led its report
 * with bugs that no longer existed.
 *
 * So each proposal carries its own check, and this runs them. Three outcomes
 * (I3): SHIPPED, still open, or the check itself could not run — the last is not
 * evidence of anything and must never read as either of the others.
 */
/** DESIGN proposals: the developer channel. Landed rows get their verify run
 *  here, nightly, for the same reason findings do; open rows older than two
 *  weeks and landed rows with no check fire the line. */
async function designProposalsLine(chatId: number): Promise<AuditLine> {
  await verifyLandedProposals(chatId);
  const s = designProposalsSummary();
  return { input: 'design proposals', fired: s.fired, text: s.text };
}

async function proposalLine(chatId: number): Promise<AuditLine> {
  const rows = pendingFindings(chatId, 'proposal');
  if (!rows.length) return { input: 'proposal queue', fired: false, text: 'nothing pending.' };

  const results = await Promise.all(
    rows.map(async (p) => {
      if (!p.verify?.trim()) return { p, verdict: 'unfalsifiable' as const };
      if (!checkCommandAllowed(p.verify)) return { p, verdict: 'broken: verify command not allowlisted' as const };
      const outcome = classifyCheck(await runCommand(p.verify), 200);
      if (outcome.kind === 'failed') return { p, verdict: `broken: ${outcome.detail.slice(0, 80)}` as const };
      // A check that runs and says nothing has NOT said "not shipped".
      if (outcome.kind === 'unanswered') return { p, verdict: 'not-yet' as const };
      return { p, verdict: 'shipped' as const };
    }),
  );
  for (const r of results) recordFindingVerdict(r.p.id, r.verdict);

  const shipped = results.filter((r) => r.verdict === 'shipped');
  const blind = results.filter((r) => r.verdict === 'unfalsifiable' || r.verdict.startsWith('broken'));
  const label = (r: (typeof results)[number]) => `- #${r.p.id} [${r.verdict}] ${r.p.body.slice(0, 90)}`;

  const parts = [`${rows.length} proposal(s) pending.`];
  if (shipped.length) {
    parts.push(
      `${shipped.length} ALREADY SHIPPED — its own check passes. Do not report these as live bugs; resolve them "applied":\n${shipped.map(label).join('\n')}`,
    );
  }
  if (blind.length) {
    parts.push(
      `${blind.length} CANNOT BE CHECKED — no usable verify command, so nothing but a human can tell these from stale. Give each one a check or dismiss it:\n${blind.map(label).join('\n')}`,
    );
  }
  const open = results.filter((r) => r.verdict === 'not-yet');
  parts.push(open.length ? `${open.length} confirmed still open.` : 'None confirmed still open.');
  return { input: 'proposal queue', fired: shipped.length > 0 || blind.length > 0, text: parts.join('\n\n') };
}

/**
 * WHICH STATE IS THIS MACHINE IN?
 *
 * First line, and it fires in debug — because every measurement below it means
 * something different when the day is suspended. An inbox that is not draining
 * and probes that have not run are alarming while live and expected in debug,
 * and an audit that cannot tell the two apart would report a healthy pause as a
 * fault every time it ran.
 */
function modeLine(): AuditLine {
  const d = debugState();
  if (!d) return { input: 'work state', fired: false, text: 'LIVE — the day runs.' };
  return {
    input: 'work state',
    fired: true,
    text:
      `DEBUG since ${d.since}${d.reason ? ` ("${d.reason}")` : ''} — the day is SUSPENDED. ` +
      `Everything below reads differently: a still inbox and unrun probes are expected, not faults. ` +
      `Snapshot ${d.snapshot}; exit with /live or /live rollback.`,
  };
}

/** The story tree's STRUCTURAL health — deterministic checks only; whether
 *  the prose is any good is the night's judgement, not this line's. */
/**
 * Concierge rotations since yesterday (daysAgo(1) is a DATE, so the window is
 * yesterday-and-today, not a rolling 24h). A rotation at an idle seam is
 * health; one within minutes of a human message is the 2026-08-25 failure — a
 * person mid-sentence answered by a session that never heard them. Fires on that.
 */
function rotationLine(chatId: number): AuditLine {
  const t = rotationTally(chatId, daysAgo(1), dbNow());
  const count = t.count;
  const mid = t.midThread;
  return {
    input: 'session rotations',
    fired: mid > 0,
    text: mid
      ? `${mid} of ${count} concierge rotation(s) since yesterday landed MID-THREAD (a person mid-sentence met a fresh session) — the context ceiling is being hit; raise it or lower the idle threshold so the seam comes first.`
      : `${count} concierge rotation(s) since yesterday, none mid-thread.`,
  };
}

/**
 * THE DAILY COST. Yesterday's dollars against the seven days before it. Fires
 * at 1.5× the average — the threshold that separates a busy day from a day
 * something ran away (the 2026-08-02 session that spent $86 of $117 would have
 * read ~4×). Printed whether or not it fired: a cost nobody reads is a cost
 * nobody bounds.
 */
export const COST_SPIKE_RATIO = 1.5;

export function costLineFrom(days: Array<{ day: string; usd: number }>): AuditLine {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const yesterday = days[days.length - 1];
  if (!yesterday) return { input: 'daily cost', fired: false, text: 'no usage rows at all.' };
  // The baseline is the days that SPENT: a laptop asleep for two days would
  // otherwise halve the average and make an ordinary day read as a spike.
  const active = days.slice(0, -1).filter((d) => d.usd > 0);
  if (!active.length) {
    return { input: 'daily cost', fired: false, text: `${usd(yesterday.usd)} on ${yesterday.day}; no prior day with spend to compare.` };
  }
  const avg = active.reduce((n, d) => n + d.usd, 0) / active.length;
  const spiked = yesterday.usd > COST_SPIKE_RATIO * avg;
  const base = `${days.length - 1}-day average over ${active.length} active day(s) ${usd(avg)}`;
  return {
    input: 'daily cost',
    fired: spiked,
    text: spiked
      ? `${usd(yesterday.usd)} on ${yesterday.day} against a ${base} — over ${COST_SPIKE_RATIO}×; read cycleCli's COST line for who spent it.`
      : `${usd(yesterday.usd)} on ${yesterday.day}; ${base}.`,
  };
}

function costLine(): AuditLine {
  // Yesterday is the last COMPLETE day; the seven before it are the baseline.
  return costLineFrom(costPerDay(daysAgo(8), daysAgo(1)));
}

/** Doors (src/doors.ts): fires when a path the night folded or pointed is
 *  still being re-read — the fold did not take — or when doors were offered
 *  and the pass recorded no decision at all (the block was skimmed). */
function doorsLine(): AuditLine {
  const t = doorsTally(daysAgo(1), dbNow());
  const undecided = t.offered > 0 && t.folded + t.pointed + t.ignored === 0;
  const reRead = t.reReads.filter((r) => r.n >= 3);
  return {
    input: 'doors',
    fired: undecided || reRead.length > 0,
    text: reRead.length
      ? `${reRead.length} folded/pointed path(s) STILL RE-READ since yesterday: ${reRead.map((r) => `${r.path} ${r.n}×`).join(', ')} — the reference is wrong or unfindable; fix the entity tonight, not the day.`
      : undecided
        ? `${t.offered} door(s) offered to the night, NO decision recorded — the block was skimmed; every door gets a doorDecision call.`
        : `${t.offered} offered · ${t.folded} folded · ${t.pointed} pointed · ${t.ignored} ignored since yesterday; no folded path re-read.`,
  };
}

/** Dated statements (src/dated.ts): fires when the night was shown messages
 *  naming a day and recorded no verdict — the departure-day miss of 2026-10-04. */
function datedLine(): AuditLine {
  const t = datedTally(daysAgo(1), dbNow());
  const judged = t.committed + t.tracked + t.declined;
  const undecided = t.offered > 0 && judged === 0;
  return {
    input: 'dated',
    fired: undecided,
    text: undecided
      ? `${t.offered} dated statement(s) offered to the night, NO verdict recorded — a plan for a named day reaches the next morning only as a commitment; every row gets a datedVerdict call.`
      : `${t.offered} offered · ${t.committed} committed · ${t.tracked} tracked · ${t.declined} declined since yesterday.`,
  };
}

function storyLine(): AuditLine {
  const s = storyLint();
  if (s.problems.length) {
    return {
      input: 'story tree',
      fired: true,
      text: `BROKEN SHAPE — ${s.problems.length} problem(s): ${s.problems.slice(0, 5).join('; ')}${s.problems.length > 5 ? '; …' : ''}. A story whose refs dangle is worse than none; fix or rewrite tonight.`,
    };
  }
  // The injected-ref count rides the same line (P2): a clean tree with zero
  // pointers is not healthy, it is a story the night has not written yet —
  // so zero injected FIRES, same as dirt. The count is the level-0 block's
  // refs — what a turn actually sees — not every ref in every story.
  const offered = storyRefs().size;
  const offer = offered ? `${offered} ref(s) injected` : 'no refs injected — the night has not written stories yet';
  // Measured, not fired: a note outside every domain is a concept the graph
  // is missing, and the night's root material already lists it.
  const outside = s.undomained ? `; ${s.undomained} note(s) sit outside any graph domain` : '';
  return {
    input: 'story tree',
    fired: s.dirty > 0 || offered === 0,
    text: s.dirty
      ? `${s.dirty} of ${s.nodes} node(s) dirty — the night owes a rewrite (storyWorklist); ${offer}${outside}.`
      : `${s.nodes} node(s), clean and current; ${offer}${outside}.`,
  };
}

export async function runAudit(chatId: number): Promise<AuditLine[]> {
  const [tests, types, proposals, designs] = await Promise.all([npmRun('test'), npmRun('typecheck'), proposalLine(chatId), designProposalsLine(chatId)]);
  const lines: AuditLine[] = [
    modeLine(),
    {
      input: 'test suite',
      fired: tests.state !== 'pass',
      text:
        tests.state === 'pass'
          ? `npm test GREEN (${/tests (\d+)/.exec(tests.tail)?.[1] ?? '?'} tests).`
          : tests.state === 'fail'
            ? `npm test IS RED. Nothing below is trustworthy until this is fixed, and it cannot be fixed by you — queue a proposal naming the failure.\n${tests.tail}`
            : // NOT AN ANSWER (I3). Reported, never converted into a verdict —
              // the suite may be perfectly green and the machine merely asleep.
              `npm test COULD NOT BE RUN (${tests.why}) — this is NOT a red suite. Do not queue a proposal about the tests from this; say the check did not complete and move on.\n${tests.tail}`,
    },
    {
      input: 'typecheck',
      fired: types.state !== 'pass',
      text:
        types.state === 'pass'
          ? 'npm run typecheck clean.'
          : types.state === 'fail'
            ? `npm run typecheck FAILS — queue a proposal.\n${types.tail}`
            : `npm run typecheck COULD NOT BE RUN (${types.why}) — this is NOT a red typecheck, and proposal #33 was filed on exactly this confusion. Do not queue a proposal from it.\n${types.tail}`,
    },
    proposals,
    designs,
    graphShapeAndRecord(),
    moduleDriftLine(),
    probeCoverage(),
    checkMissLine(),
    frictionLine(),
    apiUseLine(),
    focusReadLine(),
    inboxLine(),
    storyLine(),
    doorsLine(),
    datedLine(),
    rotationLine(chatId),
    costLine(),
  ];
  return lines;
}

/** Render for the digest. Fired inputs are marked; the rest still get a line. */
export function renderAudit(lines: AuditLine[]): string {
  return lines.map((l) => `${l.fired ? '⚠️' : '  '} **${l.input}** — ${l.text}`).join('\n');
}
