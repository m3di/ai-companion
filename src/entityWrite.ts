import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import {
  carryEntityKeys,
  retireEntityKeys,
  confirmFact,
  journalEntityWrite,
  type WriteOp,
} from './db.js';
import {
  chainEntryProblem,
  DATA_FILE,
  EDGE_RELS,
  ENTITY_KINDS,
  factSha,
  isAuthoredRel,
  loadGraph,
  renderRecords,
  toRow,
  VIEW_FILE,
  type AuthoredRel,
  type Diagnostic,
  type Entity,
  type EntityKind,
} from './entities.js';
import { pulse } from './pulse.js';
import { currentRunId } from './runs.js';

/**
 * WHO A WRITE BELONGS TO.
 *
 * A module runs in its own process and calls `record()` with the literal actor
 * "module", because inside that process there is nobody else to be. So every
 * agent write was journalled as "module" with a null run_id — and
 * `currentRunId("module")` matched the open run of nobody.
 *
 * The damage was quiet and went to the heart of the design: a debug-agent turn
 * wrote the graph, the ledger showed that run with ZERO writes, and "revert
 * this run" was a button that would have reverted nothing and said it
 * succeeded. Per-run revert is the reason it is safe to let an agent write at
 * all, and it was resting on attribution that was not there.
 *
 * `callModule` now passes the caller into the child's environment, so a write
 * made on someone's behalf is recorded as theirs. Nothing is inferred: absent
 * the variable the actor stands as given.
 */
export function attributedTo(actor: string): string {
  return actor === 'module' ? process.env.BOT_CALLER || actor : actor;
}

/**
 * IS THIS PROCESS ALLOWED TO WRITE AT ALL?
 *
 * Set by `callModule` for a caller that is read-only — today, the operator's
 * agent while the bot is LIVE. It is enforced HERE, at the single write path,
 * rather than in the agent's prompt or its tool wrapper, for the reason every
 * other guard in this file exists: a rule a model is asked to follow is a
 * suggestion, and a rule the write path enforces is a rule. The agent can be
 * confused, jailbroken, or simply wrong about which mode it is in; it still
 * cannot write.
 *
 * Scoped to the CALLER and not to the mode, deliberately. The nightly writes
 * while the bot is live — that is its whole job — so a blanket "no writes while
 * live" would break the night to protect the day.
 */
function readOnlyProcess(): boolean {
  return process.env.BOT_READONLY === '1';
}
import { refreshRootBehaviour } from './rootBehavior.js';
import { markDomainsDirty, refreshStorySurfaces } from './storyTree.js';
import { renderMap, simplify } from './simplify.js';

const MAP_FILE = '_map.md';

/**
 * Re-render the domain briefings a write just invalidated.
 *
 * `_map.md` is generated from the entities, and it is what a reader actually
 * reads for a 60-second view of a domain — so a write that updates the rows and
 * leaves the map alone lands in the graph and stays INVISIBLE. That is not
 * hypothetical: the night of 2026-08-04 corrected the paperwork vacancy to
 * Nora's real posting, and `paperwork/_map.md` went on naming the dead
 * "Software Engineer – Bioinformatics & Health Data" draft, because nothing on
 * this path ever re-rendered it. The prober already learned this lesson for
 * state ("a writer maintains its own views"); the write path never did.
 *
 * Best-effort by design: the write is already committed and validated by the
 * time this runs, and a failed re-render must not roll back a good correction —
 * the suite's "generated views are current" check will catch a stale map.
 */
function refreshMaps(domains: Iterable<string>, graph: ReturnType<typeof loadGraph>): void {
  if (graph.errors.length) return;
  const touched = [...domains];
  try {
    const s = simplify(graph);
    for (const d of touched) writeFileSync(join(DIR, d, MAP_FILE), renderMap(d, graph, s));
  } catch (e) {
    console.error('[entityWrite] map re-render failed (the write itself stands)', e);
  }
  // `## How to behave` is a view of the self/ domain in exactly the way a
  // `_map.md` is a view of its own — so the same rule applies: a writer
  // maintains its own views, or the derived file quietly disagrees with its
  // source (I2). Without this, correcting a habit would change the graph and
  // leave the concierge reading the old rule until something else happened to
  // re-render.
  if (touched.includes('self')) {
    const r = refreshRootBehaviour();
    if (r.problem) console.error(`[entityWrite] root behaviour re-render failed: ${r.problem}`);
  }
  // The story is one more view a writer maintains — but only its DIRTY flags
  // move here (mechanical, instant); the prose waits for the night. The
  // re-render below repaints the surfaces from whatever text already exists,
  // so a stale narrative is at least honestly framed by current pointers.
  try {
    markDomainsDirty(touched);
    const s = refreshStorySurfaces();
    if (s.problem) console.error(`[entityWrite] story re-render failed: ${s.problem}`);
  } catch (e) {
    console.error('[entityWrite] story dirty-marking failed (the write itself stands)', e);
  }
}

/**
 * THE WRITE PATH (round 10) — how anything other than the prober changes the
 * graph.
 *
 * Round 8 built the graph and round 9 made it callable, and between them they
 * produced a memory that could be read from every angle and written from none.
 * Three days of live running settled what that costs: 303 messages, a PR merged
 * after three review rounds, a product hold, a design invalidated — and
 * `entities.jsonl` not modified once. The graph did not decay. It was never
 * alive; a graph with no ingest path is a snapshot from the moment it is built.
 *
 * So this module exists to make ONE sentence true: *the night can correct a
 * fact it discovers is wrong.* Everything here follows from that and stops
 * there.
 *
 * ## Why direct writes, and what makes them safe
 *
 * The alternative was a proposal queue — the night records what it believes and
 * a human applies it. That is the safer-looking design and it is the wrong one:
 * a queue nobody drains is a graph nobody writes, one level up, and this round
 * exists because of exactly that failure mode. Mehdi's call, and I agree with
 * it: direct.
 *
 * What makes direct safe is not a gate, it is a DIFF. Every write is journalled
 * with its evidence (`entity_writes`), so a confidently wrong night is
 * reviewable afterwards and revertible field by field. `before` holds the whole
 * prior value, so a revert needs nothing but the row.
 *
 * ## Three mechanical guards
 *
 * 1. **`state` is not writable here, by construction.** There is no op for it.
 *    Only `prober.ts` writes state, that rule is what caught the 2026-07-28
 *    corruption, and round 10 does not weaken it — it gives observation its own
 *    field (`observed`) instead of asking the rule to bend.
 * 2. **Every write is validated by RE-LOADING the whole graph.** Not by
 *    checking the change: by writing it, parsing the tree back, and comparing
 *    the diagnostics. Any write that introduces an error is rolled back to the
 *    exact prior bytes. A writer cannot corrupt the graph even by trying,
 *    which is what makes it safe to hand the pen to a model.
 * 3. **A reason is required.** An empty one is refused. A write nobody can
 *    explain is precisely the write the journal exists to catch, and demanding
 *    the sentence at the call site is cheaper than detecting its absence later.
 */

const DIR = config.knowledgeDir;

export type Write =
  /** The correction case — the one this round was built for. */
  | { op: 'correct-fact'; id: string; from: string; to: string }
  | { op: 'add-fact'; id: string; fact: string }
  | { op: 'drop-fact'; id: string; fact: string }
  /** What the night saw. The observed twin of the probe's `state`. */
  | { op: 'observe'; id: string; observed: string }
  | { op: 'note'; id: string; note: string }
  | { op: 'edge'; id: string; rel: AuthoredRel; target: string }
  /**
   * A relation that was never true, or stopped being. The `drop-fact` of edges.
   *
   * Its absence made `move` half an op: relocating
   * `affiliate-app/northwind-payment-method-2297` to core-api left it `part-of
   * affiliate-app/system`, and nothing could say otherwise — the graph could
   * gain a wrong relation and never lose one.
   */
  | { op: 'drop-edge'; id: string; rel: AuthoredRel; target: string }
  /**
   * The entity is filed in the WRONG PLACE. The only op that changes an id.
   *
   * An entity's domain is not a field — it is the id's prefix, which picks the
   * file it lives in. So "this is Core-API work, not affiliate-app" was, until
   * now, unwritable: every other op can correct what an entity SAYS, and none
   * could correct where it LIVES. The night of 2026-08-04 diagnosed exactly
   * that on `affiliate-app/northwind-payment-method-2297`, could only leave a note
   * saying so, and asked for a mechanism. This is it.
   *
   * It is also the only op that touches more than one file: everything
   * pointing AT the old id follows it, across every domain that pointed.
   */
  | { op: 'move'; id: string; to: string }
  /**
   * The entity should not exist. The only op that REMOVES one.
   *
   * Until now the graph could gain a node and never lose one, so the duplicate
   * pair two overlapping nightly passes minted on 2026-08-05
   * (`core-api/ci-robustness-38` and `core-api/ci-robustness-initiative-38`, the
   * same Fibery initiative under two ids) sat there for days, visible to
   * `similar()` and removable by nothing.
   *
   * `into` is the merge case: everything pointing at the retired id is
   * repointed there first, so a retire can never leave a dangling edge. The
   * whole row is journalled in `before`, which is what makes this revertible
   * from the journal alone rather than from a backup.
   */
  | { op: 'retire'; id: string; into?: string }
  /**
   * The entity is WHAT DONE LOOKS LIKE — or it is not. The flag every critical
   * path terminates on (`criticalPath()`, `hopsToGoal`), and until 2026-09-05
   * the one field no op could set: the six goals in the graph were all written
   * by the reform, so a plan minted since could only ever hang in the air.
   * `personal/daily-quest-system` did exactly that for two months — a fixed
   * plan, replayed daily, with nothing above it to re-derive it from. W213
   * finds such plans; this op, and `goal` on `mint`, is how the night settles
   * them.
   */
  | { op: 'goal'; id: string; goal: boolean }
  /**
   * PARKED, or picked back up. The reform's own definition: work that is real
   * but deliberately not competing for attention. It stays probed and stays in
   * the index; it stops being surfaced. Step three of the goal work
   * (2026-09-05) parks a plan by SILENCE — asked N times in the flow what it is
   * for, no answer — and un-parking is one message. `dormant: true` clears the
   * actor, because the grammar refuses a parked node that names who is moving
   * it; the journal's `before` records the actor it had.
   */
  | { op: 'dormant'; id: string; dormant: boolean }
  /**
   * Fix a chain entry: `from` alone drops it, `to` alone adds one, both
   * replace. Provenance is otherwise write-once, so a bad entry — an entity
   * path where a trace belongs, a spelling nothing can follow — was a lint
   * finding nobody could act on (2026-11-12, the round-trip red on
   * `affiliate-app/stage-email-recipient-rule`). Never empties a chain.
   */
  | { op: 'correct-chain'; id: string; from?: string; to?: string }
  | {
      op: 'mint';
      id: string;
      kind: EntityKind;
      facts: string[];
      aka?: string[];
      chain?: string[];
      actor?: string;
      note?: string;
      /** Born as a goal — the outcome a plan is for. */
      goal?: boolean;
      /**
       * HOW IT JOINS THE GRAPH — required, and the reason W201 exists at all.
       *
       * A mint could not declare edges until 2026-08-07, so every node was born
       * ISOLATED and stayed that way until something happened to link it. Six
       * never did. That was not an author being careless — the op had no way to
       * say it, and chasing a node down afterwards costs far more than naming
       * its parent while writing it.
       *
       * Targets must already exist, so this also forces the question "what is
       * this part of" at the one moment the answer is in hand.
       */
      edges?: Array<{ rel: AuthoredRel; target: string }>;
    };

export interface WriteResult {
  ok: boolean;
  /** The journal row, when the write landed. */
  writeId?: number;
  /** Why it did not land — a refusal, or the lint errors it would have caused. */
  problem?: string;
  errors?: Diagnostic[];
}

/**
 * Apply one write. Validates, persists, re-renders the domain's view, and
 * journals — or changes nothing at all.
 *
 * `actor` is who to blame: 'nightly', a session key, or 'cli'.
 */
export function applyWrite(w: Write, reason: string, actor: string): WriteResult {
  if (readOnlyProcess()) {
    return {
      ok: false,
      problem:
        'REFUSED — the bot is LIVE and you are read-only. Nothing was written. ' +
        'Ask the operator to sedate it (the DEBUG chip in the Atlas) and then say what you wanted to do; ' +
        'until then, answer from what you can read.',
    };
  }

  const malformed = validateShape(w);
  if (malformed) return { ok: false, problem: malformed };

  // ONE WRITER AT A TIME, ACROSS PROCESSES.
  //
  // This function is fully synchronous, so inside the bot it is already atomic —
  // JS runs it to completion and no other write can interleave. That is why the
  // hole was invisible: every writer lived in one process.
  //
  // A gardener run from a CLI does not. Two processes both do read → mutate →
  // writeFileSync over the same domain file, and the second silently erases the
  // first: not a corrupt graph (each write lints clean on its own) but a LOST
  // one, which is worse, because nothing reports it and the journal shows both
  // writes as successful.
  return withWriteLock(actor, () => applyWriteLocked(w, reason, actor));
}

/** The lock's home. Advisory, in the tree the writes go to. */
const LOCK = join(DIR, '.write.lock');
/** Longer than the slowest write (a full tree re-parse), far shorter than a
 *  human noticing. A lock older than this belonged to a process that died. */
const LOCK_STALE_MS = 30_000;

function withWriteLock(actor: string, run: () => WriteResult): WriteResult {
  let held = false;
  try {
    try {
      // 'wx' fails if it exists — the atomic test-and-set this relies on.
      writeFileSync(LOCK, `${process.pid} ${actor} ${new Date().toISOString()}`, { flag: 'wx' });
      held = true;
    } catch {
      const age = existsSync(LOCK) ? Date.now() - statSync(LOCK).mtimeMs : Infinity;
      if (age < LOCK_STALE_MS) {
        return {
          ok: false,
          problem: `another process is writing the graph (${readFileSync(LOCK, 'utf8').trim()}) — retry in a moment`,
        };
      }
      // A crashed writer must not wedge the graph forever: that would be a
      // check blocking its own repair (I8). Take it over, loudly.
      console.warn(`[entityWrite] breaking a stale write lock (${(age / 1000) | 0}s old)`);
      writeFileSync(LOCK, `${process.pid} ${actor} ${new Date().toISOString()}`);
      held = true;
    }
    return run();
  } finally {
    if (held) try { unlinkSync(LOCK); } catch { /* already gone */ }
  }
}

function applyWriteLocked(w: Write, reason: string, actor: string): WriteResult {

  if (!reason.trim()) {
    return { ok: false, problem: 'a write needs a reason — say what you saw that justifies it' };
  }

  const graph = loadGraph();
  // Refuse to build on a broken tree. Writing into a graph that already fails
  // lint would make this write indistinguishable from the damage, and the
  // rollback check below could not tell which errors were ours.
  //
  // EXCEPT the repair (I8). Refusing every write while any error stands meant
  // the write path could not fix the very record that broke it: on 2026-11-13
  // the data loader learned the chain rule, two old rows tripped it, and
  // `correct-chain` on those rows was refused "repair it before writing". A
  // single-entity write AT an entity that carries an error is let through, and
  // the post-write check holds it to strictly fewer errors and no new one.
  const repairing = graph.errors.length > 0 && w.op !== 'move' && w.op !== 'retire' && w.op !== 'mint' && graph.errors.some((e) => e.id === w.id);
  if (graph.errors.length && !repairing) {
    return {
      ok: false,
      problem: `the graph does not currently lint clean (${graph.errors.length} error(s)) — repair it before writing`,
      errors: graph.errors.slice(0, 5),
    };
  }

  const existing = graph.entities.get(w.id);
  if (w.op === 'mint') {
    if (existing) return { ok: false, problem: `${w.id} already exists — correct or observe it instead of minting it` };
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(w.id)) {
      return { ok: false, problem: `id must be <domain>/<slug>, got "${w.id}"` };
    }
    if (!ENTITY_KINDS.includes(w.kind)) {
      return { ok: false, problem: `kind must be one of ${ENTITY_KINDS.join(', ')}` };
    }
    if (!w.facts.length) return { ok: false, problem: 'an entity with no facts is an id, not knowledge' };
    // Refuse up front rather than letting the reload guard reject it as
    // "would have broken the graph" — a mint is the one op where the caller
    // has the provenance in hand and can simply be asked for it.
    if (!(w.chain ?? []).length) {
      return { ok: false, problem: 'a mint needs a chain — at least one pointer back to the trace that justifies it (msg#123, episode#45, a URL, or repo:path)' };
    }
    // THE BIRTH CHECKLIST (graphLint 'birth' rules). Everything here is cheap
    // to satisfy now and expensive to chase later, which is exactly why it is
    // refused at the write instead of budgeted afterwards.
    // CONNECTED, BY EITHER ROUTE. An `actor` derives an `acted-by` edge, and
    // `neighbours()` traverses derived edges like any other — so a node that
    // names who is acting on it IS reachable, and demanding an authored edge on
    // top would be stricter than the rule this checklist enforces. The point is
    // that a node arrives findable, not that it arrives with a particular field.
    if (!w.edges?.length && !w.actor?.trim()) {
      return {
        ok: false,
        problem:
          `a mint needs at least one edge, or an actor — say how ${w.id} joins the graph ` +
          `(e.g. edges:[{rel:"part-of",target:"${w.id.split('/')[0]}/…"}], or actor:"mehdi"). ` +
          `Nodes went isolated for years for no reason but that this op could not express it. Relations: ${EDGE_RELS.join(', ')}`,
      };
    }
    for (const e of w.edges ?? []) {
      if (!isAuthoredRel(e.rel)) return { ok: false, problem: `"${e.rel}" is not an authored relation — one of ${EDGE_RELS.join(', ')}` };
      // Self BEFORE existence: the node being minted is not in the graph yet, so
      // an edge to itself would otherwise be reported as "target does not
      // exist", which sends the caller off to mint a thing that is already here.
      if (e.target === w.id) return { ok: false, problem: `${w.id} cannot be joined to itself — name something that already exists` };
      if (!graph.entities.has(e.target)) return { ok: false, problem: `${e.rel} target "${e.target}" does not exist — mint it first, or point at something that does` };
    }
  } else if (!existing) {
    return { ok: false, problem: `no entity ${w.id}` };
  }

  // A move rewrites two domains plus everything that pointed at the old id, so
  // it cannot share the single-file path below.
  if (w.op === 'move') return applyMove(w, existing!, graph, reason, actor);
  if (w.op === 'retire') return applyRetire(w, existing!, graph, reason, actor);

  const domain = w.op === 'mint' ? w.id.split('/')[0]! : existing!.domain;
  const dataPath = join(DIR, domain, DATA_FILE);
  const before = readFileSync(dataPath, 'utf8');

  const mutation = mutate(w, existing);
  if ('problem' in mutation) return { ok: false, problem: mutation.problem };

  // Rewrite the domain's rows with the mutated entity in place (or appended).
  const rows = [...graph.entities.values()].filter((e) => e.domain === domain);
  const next =
    w.op === 'mint'
      ? [...rows, mutation.entity]
      : rows.map((e) => (e.id === w.id ? mutation.entity : e));
  writeFileSync(dataPath, `${next.map(toRow).join('\n')}\n`);

  // THE GUARD: parse the whole tree back and compare. Anything we introduced —
  // a fact that asserts state, an edge to a target that does not exist, a
  // dormant entity that named an actor — rolls the file back to the byte.
  const after = loadGraph();
  const key = (e: { id?: string; message: string }) => `${e.id ?? ''}|${e.message}`;
  const had = new Set(graph.errors.map(key));
  const broke = repairing
    ? after.errors.length >= graph.errors.length || after.errors.some((e) => !had.has(key(e)))
    : after.errors.length > 0;
  if (broke) {
    writeFileSync(dataPath, before);
    loadGraph(); // restore the derived index to the pre-write graph
    return {
      ok: false,
      problem: 'the write would have broken the graph — nothing was changed',
      errors: after.errors.slice(0, 5),
    };
  }

  writeFileSync(join(DIR, domain, VIEW_FILE), renderRecords(next));
  refreshMaps([domain], after);

  const writeId = journalEntityWrite({
    entityId: w.id,
    op: w.op as WriteOp,
    before: mutation.beforeValue,
    after: mutation.afterValue,
    reason,
    actor: attributedTo(actor),
    runId: currentRunId(attributedTo(actor)),
  });
  // Loud for the two ops that change what the system BELIEVES; quiet for the
  // ones that only enrich it. On the Atlas a correction should be impossible to
  // miss — it is the night overruling stored memory, and that is exactly the
  // event a person watching would want to catch.
  // BOTH ENDS OF AN EDGE. The renderer runs a light ALONG the link when a pulse
  // names more than one node, so an edge write that refs only its source halos
  // a dot where it should draw the relation that just came into existence —
  // which is the single most legible thing a gardening pass produces.
  const refs =
    w.op === 'edge' || w.op === 'drop-edge'
      ? [w.id, w.target]
      : w.op === 'mint'
        ? [w.id, ...(w.edges ?? []).map((e) => e.target)]
        : [w.id];
  pulse('entity-change', `${w.op} ${w.id} — ${reason.slice(0, 80)}`, {
    refs,
    loud: w.op === 'correct-fact' || w.op === 'mint',
  });
  return { ok: true, writeId };
}

/** Serialise one domain's rows. An emptied domain gets an empty file, not a
 *  lone newline — the parser reads that as a blank row. */
function serialise(rows: Entity[]): string {
  return rows.length ? `${rows.map(toRow).join('\n')}\n` : '';
}

/**
 * Relocate an entity, and take everything pointing at it along.
 *
 * The multi-file version of the same guard the rest of this module lives by:
 * snapshot every file we are about to touch, write them all, re-parse the whole
 * tree, and restore every snapshot to the byte if a single new diagnostic
 * appeared. A dangling edge is exactly the damage a half-applied move would
 * leave, and it is exactly what the re-parse catches.
 */
function applyMove(
  w: Extract<Write, { op: 'move' }>,
  cur: Entity,
  graph: ReturnType<typeof loadGraph>,
  reason: string,
  actor: string,
): WriteResult {
  const to = w.to.trim();
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(to)) return { ok: false, problem: `id must be <domain>/<slug>, got "${to}"` };
  if (to === cur.id) return { ok: false, problem: `${cur.id} is already there` };
  if (graph.entities.has(to)) {
    return { ok: false, problem: `${to} already exists — a move cannot merge two entities; fold one by hand, or move to a free id` };
  }
  const toDomain = to.split('/')[0]!;
  if (!existsSync(join(DIR, toDomain, DATA_FILE))) {
    // Minting a domain is a tree decision (it needs a _map.md to be worth
    // anything), and doing it as a side effect of a move would create a folder
    // nobody briefed. Refuse and say what is missing.
    return { ok: false, problem: `domain "${toDomain}" has no ${DATA_FILE} — a move cannot invent a domain; create it and its map first` };
  }

  const moved: Entity = { ...cur, id: to, domain: toDomain, file: `${toDomain}/${DATA_FILE}` };

  // INBOUND EDGES FOLLOW. An id nobody can reach is worse than a misfiled one.
  const rewired: Entity[] = [];
  const entities = [...graph.entities.values()].map((e) => {
    if (e.id === cur.id) return moved;
    if (!Object.values(e.edges).some((ts) => ts.includes(cur.id))) return e;
    const edges = Object.fromEntries(
      Object.entries(e.edges).map(([rel, ts]) => [rel, ts.map((t) => (t === cur.id ? to : t))]),
    );
    const next = { ...e, edges };
    rewired.push(next);
    return next;
  });

  const affected = new Set([cur.domain, toDomain, ...rewired.map((e) => e.domain)]);
  const snapshot = new Map<string, string>();
  for (const d of affected) {
    const p = join(DIR, d, DATA_FILE);
    snapshot.set(p, readFileSync(p, 'utf8'));
  }
  const rowsOf = (d: string) => entities.filter((e) => e.domain === d);
  for (const d of affected) writeFileSync(join(DIR, d, DATA_FILE), serialise(rowsOf(d)));

  const after = loadGraph();
  if (after.errors.length) {
    for (const [p, bytes] of snapshot) writeFileSync(p, bytes);
    loadGraph(); // restore the derived index to the pre-write graph
    return {
      ok: false,
      problem: 'the move would have broken the graph — nothing was changed',
      errors: after.errors.slice(0, 5),
    };
  }

  for (const d of affected) writeFileSync(join(DIR, d, VIEW_FILE), renderRecords(rowsOf(d)));
  refreshMaps(affected, after);
  // The state and confirmation clocks are keyed by id and are NOT derived from
  // the files, so they have to be carried explicitly or the moved entity looks
  // freshly minted and unprobed.
  carryEntityKeys(cur.id, to);

  const writeId = journalEntityWrite({
    entityId: to,
    op: 'move',
    before: cur.id,
    after: to,
    reason,
    actor: attributedTo(actor),
    runId: currentRunId(attributedTo(actor)),
  });
  // Loud: a move changes where the system thinks a piece of work BELONGS, which
  // is the same class of event as a correction.
  pulse('entity-change', `move ${cur.id} → ${to} — ${reason.slice(0, 80)}`, {
    refs: [to, cur.id],
    loud: true,
  });
  return { ok: true, writeId };
}

/**
 * Remove an entity, optionally folding what pointed at it into another.
 *
 * The refusal that matters: retiring a node something still points AT would
 * leave a dangling edge, which is the one kind of damage the guard cannot undo
 * for you — so either nothing points at it, or you say where those pointers
 * should go. There is no third option and no force flag.
 *
 * `before` in the journal is the ENTIRE row, so `entityWrites` alone is enough
 * to put it back. That is the trade this op makes: deletion is allowed because
 * it is recorded completely, not because it is safe.
 */
function applyRetire(
  w: Extract<Write, { op: 'retire' }>,
  cur: Entity,
  graph: ReturnType<typeof loadGraph>,
  reason: string,
  actor: string,
): WriteResult {
  const into = w.into?.trim();
  if (into && !graph.entities.has(into)) return { ok: false, problem: `no entity ${into} to fold into` };
  if (into === cur.id) return { ok: false, problem: 'cannot fold an entity into itself' };

  const inbound = [...graph.entities.values()].filter(
    (e) => e.id !== cur.id && Object.values(e.edges).some((ts) => ts.includes(cur.id)),
  );
  if (inbound.length && !into) {
    return {
      ok: false,
      problem: `${inbound.length} entit(y/ies) still point at ${cur.id} (${inbound.map((e) => e.id).slice(0, 5).join(', ')}) — retire with \`into\` to repoint them, or drop those edges first`,
    };
  }

  const rewired: Entity[] = [];
  const entities = [...graph.entities.values()]
    .filter((e) => e.id !== cur.id)
    .map((e) => {
      if (!Object.values(e.edges).some((ts) => ts.includes(cur.id))) return e;
      const edges = Object.fromEntries(
        Object.entries(e.edges)
          // Repoint at `into`, dedupe, and drop a self-edge the repoint created.
          .map(([rel, ts]) => [rel, [...new Set(ts.map((t) => (t === cur.id ? into! : t)))].filter((t) => t !== e.id)])
          .filter(([, ts]) => (ts as string[]).length),
      );
      const next = { ...e, edges };
      rewired.push(next);
      return next;
    });

  const affected = new Set([cur.domain, ...rewired.map((e) => e.domain)]);
  const snapshot = new Map<string, string>();
  for (const d of affected) snapshot.set(join(DIR, d, DATA_FILE), readFileSync(join(DIR, d, DATA_FILE), 'utf8'));
  const rowsOf = (d: string) => entities.filter((e) => e.domain === d);
  for (const d of affected) writeFileSync(join(DIR, d, DATA_FILE), serialise(rowsOf(d)));

  const after = loadGraph();
  if (after.errors.length) {
    for (const [p, bytes] of snapshot) writeFileSync(p, bytes);
    loadGraph();
    return { ok: false, problem: 'the retire would have broken the graph — nothing was changed', errors: after.errors.slice(0, 5) };
  }

  for (const d of affected) writeFileSync(join(DIR, d, VIEW_FILE), renderRecords(rowsOf(d)));
  refreshMaps(affected, after);
  retireEntityKeys(cur.id);

  const writeId = journalEntityWrite({
    entityId: cur.id,
    op: 'retire',
    // The whole row: this is the undo.
    before: toRow(cur),
    after: into ? `folded into ${into}` : undefined,
    reason,
    actor: attributedTo(actor),
    runId: currentRunId(attributedTo(actor)),
  });
  pulse('entity-change', `retire ${cur.id}${into ? ` → ${into}` : ''} — ${reason.slice(0, 80)}`, {
    refs: into ? [cur.id, into] : [cur.id],
    loud: true,
  });
  return { ok: true, writeId };
}

type Mutation = { entity: Entity; beforeValue?: string; afterValue?: string } | { problem: string };

/**
 * THE FIELDS EACH OP CANNOT WORK WITHOUT.
 *
 * `Write` is a union, so TypeScript already guarantees this — for callers that
 * are compiled with it. The two that matter most are not: the nightly operator
 * and the concierge reach `record()` through a module boundary carrying JSON an
 * LLM composed, and there the shape is a guess.
 */
const REQUIRED: Record<Write['op'], string[]> = {
  'correct-fact': ['id', 'from', 'to'],
  'add-fact': ['id', 'fact'],
  'drop-fact': ['id', 'fact'],
  observe: ['id', 'observed'],
  note: ['id', 'note'],
  goal: ['id', 'goal'],
  dormant: ['id', 'dormant'],
  'correct-chain': ['id'],
  edge: ['id', 'rel', 'target'],
  'drop-edge': ['id', 'rel', 'target'],
  move: ['id', 'to'],
  retire: ['id'],
  mint: ['id', 'kind', 'facts'],
};

/**
 * Refuse a malformed write AT THE DOOR, naming the fields it wanted.
 *
 * On 2026-08-06 the nightly pass sent `correct-fact` as `{before, after}`
 * instead of `{from, to}`. `mutate` reached straight for `w.from.slice(60)` —
 * inside the branch that exists to build a HELPFUL "no such fact, here is what
 * it has" message — and threw `Cannot read properties of undefined`. The
 * diagnostic was the crash. The night had to guess its way to the right shape
 * across a retry, and the only reason nothing was lost is that it guessed well.
 *
 * A wrong field name is the single likeliest mistake at this boundary, so it
 * gets the one thing a TypeError never gives: the answer.
 */
export function validateShape(w: Write): string | undefined {
  if (!w || typeof w !== 'object') return `a write must be an object, got ${typeof w}`;
  const ops = Object.keys(REQUIRED);
  if (!w.op) return `a write needs an "op" — one of ${ops.join(', ')}`;
  if (!(w.op in REQUIRED)) return `unknown op "${w.op}" — expected one of ${ops.join(', ')}`;

  const bag = w as unknown as Record<string, unknown>;
  const missing = REQUIRED[w.op].filter((k) => {
    const v = bag[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
  if (!missing.length) return undefined;

  // Naming what WAS sent is what turns "invalid" into a one-line fix.
  const got = Object.keys(bag).filter((k) => k !== 'op');
  return (
    `${w.op} needs ${REQUIRED[w.op].map((k) => `"${k}"`).join(', ')} — missing ` +
    `${missing.map((k) => `"${k}"`).join(', ')}. Received: ${got.length ? got.map((k) => `"${k}"`).join(', ') : '(nothing but op)'}.`
  );
}

/**
 * ONE SPELLING PER KIND OF REFERENCE.
 *
 * A chain entry is only worth having if something can follow it, and following
 * means matching a known form. On 2026-08-07 the night minted a node whose
 * chain read `message#6497`; every one of the ~250 other entries in the graph
 * says `msg#`. Two entries, both from that mint, both unfollowable — and the
 * linter flagged them correctly, but nothing would ever have fixed them,
 * because `chain` has no write op.
 *
 * So it is normalised on the way in. This is NOT rewriting provenance: the same
 * message, in the form the rest of the graph uses. A reference we cannot follow
 * is worth nothing, and the alternative — a lint finding nobody can act on — is
 * worse than either.
 */
export function canonicalRef(ref: string): string {
  return ref
    .trim()
    .replace(/^messages?\s*#\s*(\d+)$/i, 'msg#$1')
    .replace(/^msg\s+#\s*(\d+)$/i, 'msg#$1')
    .replace(/^m#(\d+)$/i, 'msg#$1')
    .replace(/^ep(?:isode)?#(\d+)$/i, 'episode#$1')
    .replace(/^pull\/(\d+)$/i, 'pr#$1');
}

function mutate(w: Write, e?: Entity): Mutation {
  if (w.op === 'mint') {
    const entity: Entity = {
      id: w.id,
      domain: w.id.split('/')[0]!,
      kind: w.kind,
      aka: w.aka ?? [],
      facts: w.facts,
      edges: (w.edges ?? []).reduce<Record<string, string[]>>((acc, e) => {
        acc[e.rel] = [...(acc[e.rel] ?? []), e.target];
        return acc;
      }, {}),
      status: 'n/a',
      dormant: false,
      goal: w.goal ?? false,
      actor: w.actor,
      chain: (w.chain ?? []).map(canonicalRef),
      note: w.note,
      file: `${w.id.split('/')[0]}/${DATA_FILE}`,
      line: 0,
      factsLine: 0,
      edgesLine: 0,
    };
    return { entity, afterValue: w.facts.join(' · ') };
  }
  const cur = e!;
  switch (w.op) {
    case 'correct-fact': {
      const i = cur.facts.indexOf(w.from);
      if (i === -1) {
        // Near-miss is the common failure and a bare "not found" is useless for
        // fixing it, so name what IS there.
        return { problem: `${cur.id} has no fact "${w.from.slice(0, 60)}". Its facts are:\n${cur.facts.map((f) => `  - ${f}`).join('\n')}` };
      }
      if (!w.to.trim()) return { problem: 'a correction needs a replacement — use drop-fact to remove one' };
      const facts = [...cur.facts];
      facts[i] = w.to;
      return { entity: { ...cur, facts }, beforeValue: w.from, afterValue: w.to };
    }
    case 'add-fact': {
      if (cur.facts.includes(w.fact)) return { problem: `${cur.id} already states that` };
      return { entity: { ...cur, facts: [...cur.facts, w.fact] }, afterValue: w.fact };
    }
    case 'drop-fact': {
      if (!cur.facts.includes(w.fact)) return { problem: `${cur.id} does not state that` };
      return { entity: { ...cur, facts: cur.facts.filter((f) => f !== w.fact) }, beforeValue: w.fact };
    }
    case 'observe':
      return {
        entity: { ...cur, observed: w.observed, observed_at: new Date().toISOString().slice(0, 10) },
        beforeValue: cur.observed,
        afterValue: w.observed,
      };
    case 'note':
      return { entity: { ...cur, note: w.note }, beforeValue: cur.note, afterValue: w.note };
    case 'dormant': {
      if (typeof w.dormant !== 'boolean') return { problem: 'dormant must be true or false' };
      if (cur.dormant === w.dormant) return { problem: `${cur.id} is already ${w.dormant ? 'parked' : 'not parked'}` };
      const before = `${cur.dormant}${cur.actor ? ` actor=${cur.actor}` : ''}`;
      return { entity: { ...cur, dormant: w.dormant, actor: w.dormant ? undefined : cur.actor }, beforeValue: before, afterValue: String(w.dormant) };
    }
    case 'goal':
      if (typeof w.goal !== 'boolean') return { problem: 'goal must be true or false' };
      if (cur.goal === w.goal) return { problem: `${cur.id} is already ${w.goal ? '' : 'not '}a goal` };
      return { entity: { ...cur, goal: w.goal }, beforeValue: String(cur.goal), afterValue: String(w.goal) };
    case 'edge': {
      if (!isAuthoredRel(w.rel)) return { problem: `rel must be one of ${EDGE_RELS.join(', ')}` };
      const targets = cur.edges[w.rel] ?? [];
      if (targets.includes(w.target)) return { problem: `${cur.id} already has ${w.rel} → ${w.target}` };
      return {
        entity: { ...cur, edges: { ...cur.edges, [w.rel]: [...targets, w.target] } },
        afterValue: `${w.rel} → ${w.target}`,
      };
    }
    case 'drop-edge': {
      if (!isAuthoredRel(w.rel)) return { problem: `rel must be one of ${EDGE_RELS.join(', ')}` };
      const targets = cur.edges[w.rel] ?? [];
      if (!targets.includes(w.target)) return { problem: `${cur.id} has no ${w.rel} → ${w.target}` };
      const left = targets.filter((t) => t !== w.target);
      const edges = { ...cur.edges };
      // An empty relation list is not a relation — drop the key, or the row
      // renders a header with nothing under it and the view round-trip breaks.
      if (left.length) edges[w.rel] = left;
      else delete edges[w.rel];
      return { entity: { ...cur, edges }, beforeValue: `${w.rel} → ${w.target}` };
    }
    case 'correct-chain': {
      const from = w.from?.trim();
      const to = w.to === undefined ? undefined : canonicalRef(w.to);
      if (!from && !to) return { problem: 'correct-chain needs `from` (drop), `to` (add), or both (replace)' };
      if (from && !cur.chain.includes(from)) {
        return { problem: `${cur.id} has no chain entry "${from}". Its chain is: ${cur.chain.join(', ')}` };
      }
      if (to) {
        const bad = chainEntryProblem(to, cur.id, cur.domain);
        if (bad) return { problem: bad };
        if (cur.chain.includes(to) && to !== from) return { problem: `${cur.id} already cites ${to}` };
      }
      const chain = from ? cur.chain.flatMap((c) => (c === from ? (to ? [to] : []) : [c])) : [...cur.chain, to!];
      if (!chain.length) return { problem: `that would leave ${cur.id} with no chain — replace the entry instead of dropping it` };
      return { entity: { ...cur, chain }, beforeValue: from, afterValue: to };
    }
    case 'move':
      // Unreachable — `applyWrite` routes a move to `applyMove`, which rewrites
      // several files and so cannot express itself as a single-entity mutation.
      return { problem: 'move is applied by applyMove, not here' };
    case 'retire':
      return { problem: 'retire is applied by applyRetire, not here' };
  }
}

/**
 * Mark facts as still true, having actually looked.
 *
 * This is the quiet half of the round and the one that makes age-based review
 * possible at all. A night that reads an entity's facts against the day's real
 * material and finds no contradiction has learned something — that the facts
 * held — and until now there was nowhere to put it, so every fact looked
 * equally unexamined forever.
 *
 * Deliberately NOT a write: it changes no file, needs no journal row, and
 * cannot be wrong in a way that damages anything. That asymmetry is why it can
 * be called freely on every entity a night touches, which is the only way the
 * confirmation clock ever gets wound.
 */
export function confirmFacts(id: string, facts: string[]): number {
  for (const f of facts) confirmFact(id, factSha(f));
  return facts.length;
}
