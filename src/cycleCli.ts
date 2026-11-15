/**
 * THE CYCLE REPORT — one day plus the night that folded it.
 *
 * A "cycle" needed no new concept: `dreams.covers_from`/`covers_to` already
 * bound exactly the window a night claims to have digested, so every other
 * surface joins to it. This prints what a cycle DID, from the tables that
 * recorded it rather than from any agent's account of itself.
 *
 * It answers one question first — did the DAY reach for memory, or only the
 * night? — because that is what removing the tree index from the concierge's
 * context (M4, 2026-08-05) is a bet on, and an unmeasured bet is
 * indistinguishable from a story.
 *
 * Read-only (I11): it writes nothing and opens the database read-only, so it is
 * safe to run mid-test as often as you like. `npx tsx src/cycleCli.ts` for
 * recent cycles; `--open` for the live window since the last dream, which is
 * the one you are inside during a test.
 */
import Database from 'better-sqlite3';
import { config } from './config.js';
import {
  callerBreakdown,
  costTally,
  dbNow,
  doorsUsed,
  lastDreamCoveredTo,
  moduleCallsBetween,
  recentDreams,
  retrievalPaths,
  hintTally,
  retrievalTally,
  storyFollowTally,
  lifeLogCounts,
} from './db.js';
import { storyRefs } from './storyTree.js';
import { doorsTally } from './doors.js';
import { datedTally } from './dated.js';
import { restartTally } from './replay.js';
import { rotationTally } from './rotation.js';
import { costLine } from './costLine.js';

const db = new Database(config.dbPath, { readonly: true });

interface Window {
  label: string;
  from: string;
  to: string;
}

function windows(chatId: number, n: number, openOnly: boolean): Window[] {
  const open: Window = {
    label: 'OPEN — since the last dream (not yet folded)',
    from: lastDreamCoveredTo(chatId) ?? '1970-01-01 00:00:00',
    to: dbNow(),
  };
  if (openOnly) return [open];
  // A CYCLE RUNS TO THE END OF ITS OWN NIGHT, not to the start of it.
  //
  // `covers_to` is stamped by `dbNow()` at the TOP of runRewrite, so a dream's
  // own execution falls after the window it covers — which put every night's
  // work in the NEXT cycle's column and made the first two reports read as
  // "night 11" for a night that had not run yet. The window a person means by
  // "that cycle" is the day PLUS the night that folded it, so it ends at the
  // dream's `created_at`: the moment the report was written.
  const past = recentDreams(chatId, n)
    .filter((d) => d.covers_from && d.covers_to)
    .map((d) => ({ label: `dream #${d.id}  (day ${d.covers_from} → ${d.covers_to}, night to ${d.created_at})`, from: d.covers_from!, to: d.created_at }));
  return [open, ...past];
}

function count(sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

function rows<T>(sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}

function report(w: Window, chatId: number): void {
  console.log(`\n${'='.repeat(78)}\n${w.label}\n${w.from} -> ${w.to} UTC\n${'='.repeat(78)}`);

  // THE HEADLINE. Day and night are split explicitly: an aggregate that mixes
  // them is exactly what hid "the day never called the API" for three days.
  const callers = callerBreakdown(w.from, w.to);
  const isNight = (k: string) => k === 'nightly' || k.endsWith(':operator');
  const isTool = (k: string) => k === 'atlas' || k === '(none)';
  const dayCalls = callers.filter((c) => !isNight(c.session_key) && !isTool(c.session_key)).reduce((n, c) => n + c.calls, 0);
  const nightCalls = callers.filter((c) => isNight(c.session_key)).reduce((n, c) => n + c.calls, 0);

  console.log('\nKNOWLEDGE API - who reached for memory');
  if (!callers.length) console.log('  (no calls logged in this window)');
  for (const c of callers) {
    const tag = isNight(c.session_key) ? 'night' : isTool(c.session_key) ? 'tool ' : 'DAY  ';
    console.log(`  [${tag}] ${c.session_key.padEnd(24)} ${String(c.calls).padStart(4)} calls, ${c.fns} distinct fn(s)`);
  }
  console.log(`  -> DAY ${dayCalls} / NIGHT ${nightCalls}${dayCalls === 0 ? '   !! the day did not reach for memory once' : ''}`);

  /**
   * THE QUESTIONS, not the calls (M4).
   *
   * The line above counts reaches; this one counts whether they ANSWERED
   * anything. Three outcomes, and the middle one is the whole point: a turn
   * that gave up and read the tree is not the same as a turn that never
   * needed memory, and an aggregate that cannot tell them apart is how "the
   * API is not called" stayed invisible for three days.
   */
  const asks = retrievalTally(w.from);
  if (asks.total) {
    const pct = (n: number) => `${Math.round((100 * n) / asks.total)}%`;
    console.log(
      `  -> ${asks.total} question(s): ${asks.answered} reached the GRAPH (${pct(asks.answered)}), ` +
        `${asks.treeOnly} answered from the TREE only (${pct(asks.treeOnly)}), ` +
        `${asks.bypassed} gave up and read files, ${asks.noReach} needed no memory`,
    );
    const cues = hintTally(w.from);
    if (cues.cued) {
      console.log(
        `  -> MEMORY CUES: ${cues.cued} message(s) named a node the graph holds; the turn read one of them ${cues.followed}× and ignored the cue ${cues.ignored}×` +
          (cues.followed === 0 ? '   !! cued and never followed — the day is told and still does not read' : ''),
      );
    }
    const paths = retrievalPaths(6).filter((p) => p.path);
    if (paths.length) {
      console.log('  paths taken (the input M9 collapses):');
      for (const p of paths) {
        console.log(
          `    ${String(p.n).padStart(3)}x  ${p.path}${p.bypasses ? `   !! ${p.bypasses} ended in a bypass` : ''}`,
        );
      }
    }
  }

  // THE POINTERS (round 11 P2). The story INJECTS refs into every concierge
  // turn — the level-0 block, nothing more; this line says whether anyone
  // took one, and what happened next. Printed whether or not anything fired —
  // a zero here is the finding — and the downstream split is what keeps a
  // bait-y story from scoring well. "NOW injected" because storyRefs() is
  // today's set: past cycles rendered below were offered whatever the block
  // held then, which no table recorded. (Adjacent asymmetry, pre-existing:
  // retrievalTally(w.from) has no upper bound, so past windows over-count
  // there too — don't chase it here.)
  const offered = storyRefs().size;
  const st = storyFollowTally(w.from, w.to);
  console.log(
    `  -> STORY: ${offered} ref(s) now injected` +
      (offered === 0 ? ' (no story pointers resolve — nothing written yet, or refs gone dangling)' : '') +
      `; of ${st.reached} graph-reaching day question(s): ${st.followed} entity follow(s) · ${st.storyReads} story read(s)` +
      (st.followed || st.storyReads
        ? ` — after taking a pointer: ${st.answered} answered, ${st.bypassed} bypassed, ${st.treeOnly} tree-only`
        : ''),
  );

  // THE DOORS (round 11). Files the day RE-READ from disk are offered to the
  // night as fold candidates (src/doors.ts); this line says what it was shown,
  // what it decided, and — the number that matters — whether a path it folded
  // earlier was still opened in this window. Printed whether or not anything
  // fired: "0 offered" on a busy day means the normaliser is blind, not that
  // the day knew everything.
  const dt = doorsTally(w.from, w.to);
  console.log(
    `  -> DOORS: ${dt.offered} offered · ${dt.folded} folded · ${dt.pointed} pointed · ${dt.ignored} ignored` +
      (dt.unlanded ? ` · ${dt.unlanded} UNLANDED (decided by a pass that never saved)` : '') +
      (dt.reReads.length
        ? ` — STILL RE-READ after a fold/pointer: ${dt.reReads.map((r) => `${r.path} (${r.n}×)`).join(', ')}`
        : ' — no folded path re-read'),
  );

  // WHAT MEHDI DATED (src/dated.ts): his messages naming a day or a time,
  // offered to the night with a mandatory verdict — the plan for a named day
  // reaches the next morning only as a commitment due that day. Printed
  // whether or not anything fired: offered with nothing judged is the block
  // being skimmed, which is how the Lisbon departure day was lost.
  const dd = datedTally(w.from, w.to);
  console.log(
    `  -> DATED: ${dd.offered} offered · ${dd.committed} committed · ${dd.tracked} tracked · ${dd.declined} declined` +
      (dd.unlanded ? ` · ${dd.unlanded} UNLANDED (decided by a pass that never saved)` : '') +
      (dd.offered > 0 && dd.committed + dd.tracked + dd.declined === 0 ? ' — !! offered and NOT judged' : ''),
  );

  // LIFE UPKEEP (design proposal #7): done-events he logged, by channel. The
  // whole design rests on him logging; a run of zeros is the walnut loop
  // again and the signal to stop building on it. Printed whether or not any.
  const lc = lifeLogCounts(w.from, w.to);
  console.log(`  -> LIFE: ${lc.total} upkeep done-event(s) logged · ${lc.voice} by voice · ${lc.text} by text${lc.other ? ` · ${lc.other} other` : ''}`);

  // THE ROTATIONS. The concierge's context is rotated by size at an idle
  // seam (src/rotation.ts); a rotation within minutes of a human message is
  // the failure of 2026-08-25 and must read zero. Printed whether or not one
  // happened — a window with no rotations is a fact, not an absence.
  const rot = rotationTally(chatId, w.from, w.to);
  console.log(
    `  -> ROTATIONS: ${rot.count} concierge rotation(s), ${rot.midThread} mid-thread` +
      (rot.count ? `, largest context at rotation ${rot.maxContext.toLocaleString('en-US')} tokens` : '') +
      (rot.midThread ? '   !! a person mid-sentence met a fresh session' : ''),
  );

  // THE RESTARTS. What the runner's restarts did to turns in flight and
  // queued: killed (reported, never re-run) and replayed. A window with none
  // prints zeros — the number the 2026-08-27 outage had no line for.
  const rs = restartTally(chatId, w.from, w.to);
  console.log(
    `  -> RESTARTS: ${rs.killed} turn(s) killed by a restart, ${rs.replayed} replayed` +
      (rs.killed ? '   !! an in-flight turn died with the process' : ''),
  );

  // THE COST. What the window's dollars bought and who spent them — by role,
  // and by model + effort within a role once more than one appears, so a
  // model or effort change is judged by the ledger and not by feel. Zeros
  // print as zeros: a quiet window is a fact about the day, not an absence.
  console.log(costLine(costTally(w.from, w.to)));

  const calls = moduleCallsBetween(w.from, w.to);
  const touched = new Set(calls.flatMap((c) => c.refs));
  if (calls.length) {
    const byFn = new Map<string, number>();
    for (const c of calls) byFn.set(`${c.module}.${c.fn}`, (byFn.get(`${c.module}.${c.fn}`) ?? 0) + 1);
    console.log('  functions: ' + [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, n]) => `${f}x${n}`).join(', '));
    console.log(`  nodes read: ${touched.size}`);
  }

  // WHICH DOOR. An empty API ledger means two opposite things — an agent that
  // ignored memory, and one that reached for it another way — and only this
  // tells them apart.
  const doors = doorsUsed(w.from, w.to).filter((d) => !isNight(d.session_key));
  console.log('\nWHICH DOOR THE DAY USED');
  if (!doors.length) console.log('  (no day tool calls recorded in this window)');
  const byCaller = new Map<string, Array<{ tool: string; n: number }>>();
  for (const d of doors) byCaller.set(d.session_key, [...(byCaller.get(d.session_key) ?? []), d]);
  for (const [who, ds] of byCaller) {
    console.log(`  ${who}: ` + ds.slice(0, 10).map((d) => `${d.tool}x${d.n}`).join(', '));
  }

  const writes = rows<{ op: string; n: number }>(
    'SELECT op, COUNT(*) AS n FROM entity_writes WHERE created_at >= ? AND created_at <= ? GROUP BY op ORDER BY n DESC',
    w.from,
    w.to,
  );
  const written = rows<{ entity_id: string }>(
    'SELECT DISTINCT entity_id FROM entity_writes WHERE created_at >= ? AND created_at <= ?',
    w.from,
    w.to,
  ).map((r) => r.entity_id);
  console.log('\nGRAPH WRITES');
  console.log('  ' + (writes.map((r) => `${r.op}x${r.n}`).join(', ') || '(none)') + `   -> ${written.length} node(s) changed`);

  const obsIn = count('SELECT COUNT(*) AS n FROM observations WHERE created_at >= ? AND created_at <= ?', w.from, w.to);
  const obsFolded = count('SELECT COUNT(*) AS n FROM observations WHERE folded_at >= ? AND folded_at <= ?', w.from, w.to);
  const obsPending = count('SELECT COUNT(*) AS n FROM observations WHERE folded_at IS NULL');
  console.log(`\nOBSERVATION INBOX\n  captured ${obsIn}, folded ${obsFolded}, still pending overall ${obsPending}`);

  // WHAT ENTERED AND LEFT THE SET — which is what "FOCUS SET" says, and what
  // this line did not measure until 2026-08-07. It counted `focus_changes`, the
  // CHECKER's diffs (a watched command's output moved), and so reported "0
  // change(s)" for the cycle in which the night closed slot #104, archived slot
  // 47 and rescoped #84. Real movement read as a flat zero — the exact shape of
  // failure the working rules call "an anomaly narrated is an anomaly missed".
  const entered = rows<{ id: number; label: string }>(
    'SELECT id, label FROM commitments WHERE focus > 0 AND created_at >= ? AND created_at <= ?',
    w.from,
    w.to,
  );
  const left = rows<{ id: number; label: string; status: string }>(
    'SELECT id, label, status FROM commitments WHERE focus > 0 AND resolved_at >= ? AND resolved_at <= ?',
    w.from,
    w.to,
  );
  const held = count("SELECT COUNT(*) AS n FROM commitments WHERE focus > 0 AND status = 'open'");
  // Kept, but named for what it is: the checkers talking, not the set changing.
  const ticks = count('SELECT COUNT(*) AS n FROM focus_changes WHERE created_at >= ? AND created_at <= ?', w.from, w.to);
  const msgs = count('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND created_at <= ?', w.from, w.to);
  console.log(`\nFOCUS SET\n  ${held} slot(s) open now; +${entered.length} entered, -${left.length} left`);
  for (const c of entered) console.log(`  + #${c.id} ${c.label}`);
  for (const c of left) console.log(`  - #${c.id} ${c.label} (${c.status})`);
  console.log(`  ${ticks} checker tick(s) — a watched command's output moved`);
  console.log(`\nCONVERSATION\n  ${msgs} message(s) logged`);

  const fric = rows<{ kind: string; session_key: string | null; signature: string }>(
    'SELECT kind, session_key, signature FROM friction WHERE last_at >= ? AND last_at <= ? ORDER BY last_at DESC LIMIT 8',
    w.from,
    w.to,
  );
  console.log('\nFRICTION - where memory failed whoever was using it');
  if (!fric.length) console.log('  (none)');
  for (const f of fric) console.log(`  ${f.kind.padEnd(8)} ${(f.session_key ?? '-').padEnd(22)} ${f.signature.slice(0, 44)}`);

  // The union is the cycle's footprint on the graph — exactly the set an Atlas
  // overlay would light up when this cycle is selected.
  const footprint = new Set([...touched, ...written]);
  console.log(`\nCYCLE FOOTPRINT - ${footprint.size} node(s) read or written`);
  if (footprint.size) console.log('  ' + [...footprint].sort().slice(0, 24).join(', ') + (footprint.size > 24 ? ' ...' : ''));
}

const chatId = [...config.allowedChatIds][0];
if (chatId === undefined) {
  console.error('No allowed chat id configured.');
  process.exit(1);
}
const openOnly = process.argv.includes('--open');
const n = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
for (const w of windows(chatId, n, openOnly)) report(w, chatId);
console.log('');
