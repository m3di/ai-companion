import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { DERIVED_RELS, type Entity, type Graph, isAuthoredRel, loadGraph, PEOPLE_DOMAIN } from './entities.js';

/**
 * THE GRAPH LINTER — typology, not types.
 *
 * `entities.ts` already lints, and every one of its 24 rules is FATAL: the
 * grammar, the relation vocabulary, the fields the prober owns. Those keep the
 * graph PARSEABLE. Nothing keeps it WELL SHAPED, and the difference showed —
 * 44% of authored edges are `relates-to`, two nodes for one Fibery initiative
 * sat unmergeable for two days, and a node's corrections were systematically
 * the facts least likely to be read. Every one of those was measurable the
 * whole time and none of them was expressible, because a rule could only be
 * fatal or absent.
 *
 * So this is the other half, and it is deliberately DUMB. No model, no
 * judgment, no network: rows in, findings out, same answer every run. That is
 * what makes it usable as a gate — a check whose verdict depends on who is
 * reading cannot ratchet anything.
 *
 *   RED    the graph is wrong. Refused at the write path.
 *   YELLOW the graph is badly shaped. May be ignored one at a time, but the
 *          COUNT is the thing under discipline (see the note on ratcheting).
 *   BLUE   measured, trended, never blocking. Candidates for a human or an
 *          agent to look at, never an instruction.
 *
 * Every finding carries a STABLE CODE. That is not decoration: colour is
 * presentation and changes with the terminal, but `W203` is what lets you ask
 * "has this gone down over three weeks", which is the only question that says
 * whether the linter works. Codes are never reused once retired.
 *
 * NOTHING HERE ENFORCES ANYTHING YET. This pass exists to answer one question
 * before any gate is built: what would the ratchet actually be signing us up
 * for? A yellow count of 400 makes "the night may not end with more than it
 * started" a rule that fails every night and gets switched off.
 */

const DIR = config.knowledgeDir;

export type Severity = 'red' | 'yellow' | 'blue';

export interface Finding {
  /** Stable, never reused. E = red, W = yellow, I = blue. */
  code: string;
  severity: Severity;
  /** The entity it is about; a pair rule names the first and puts the second
   *  in `detail`, so a finding always has one anchor. */
  id: string;
  domain: string;
  /** One line, no newlines — this list has to stay diffable. */
  detail: string;
}

/**
 * WHY A YELLOW EXISTS — and therefore what may be done about it.
 *
 * The first measurement made the split necessary. A flat "the night may not end
 * with more yellows than it started" reads well and fails on contact: some
 * rules fire the INSTANT a node is created, for no reason but that it is new.
 * The night minted 9 nodes on 2026-08-05; under a flat ratchet that is ~20 new
 * yellows for doing its job, so the budget breaks on every productive night and
 * then gets switched off — the proposal queue's failure, one layer down.
 *
 *   'birth' — must be true the moment the node exists. Cheap to satisfy while
 *             writing it, expensive to chase afterwards, and it never accrues
 *             from ordinary editing. So it is ENFORCED AT THE WRITE, not
 *             budgeted: a mint that would create one is refused.
 *   'rot'   — accumulates from ordinary editing: facts pile up, sentences grow
 *             compound, structure goes vague. This is what a budget is FOR.
 *             Healthy work does not add these; sloppy work does.
 *
 * The test for which a rule is: could a node be born violating it through no
 * fault of the author? If yes it is rot (or blue), never birth.
 */
export type RuleClass = 'birth' | 'rot';

export interface Rule {
  code: string;
  severity: Severity;
  /** Only yellows carry a class: reds are always refused, blues never gate. */
  cls?: RuleClass;
  /** What a violation MEANS, in the terms the fix would be written in. */
  what: string;
  run: (g: Graph, ctx: Ctx) => Finding[];
}

/** Precomputed things several rules need, so the pass stays one traversal each. */
interface Ctx {
  entities: Entity[];
  /** id -> ids that point AT it, authored edges only. */
  inbound: Map<string, Set<string>>;
  /** id -> ids it points at, authored edges only. */
  outbound: Map<string, Set<string>>;
}

// --- Thresholds -------------------------------------------------------------
//
// Every one of these is a guess until the measurement pass reports. They are
// gathered here rather than inlined so the numbers can be moved from evidence
// instead of from taste, and so a threshold change is a visible diff.

export const T = {
  /** Facts on one node before it is doing more than one job. */
  FACTS_MAX: 6,
  /** Characters in one fact before it is a paragraph. */
  FACT_CHARS: 320,
  /** Characters across a node's facts before the node is a document. */
  NODE_CHARS: 1200,
  /** Characters in a note before it should have been facts. */
  NOTE_CHARS: 400,
  /** Share of a node's authored edges that may be `relates-to`. */
  VAGUE_SHARE: 0.6,
  /** Jaccard over normalised words before two facts are "the same fact twice". */
  FACT_DUP: 0.6,
  /** Jaccard over normalised words before two NODES look like one node. */
  NODE_DUP: 0.45,
  /** A fact with this many clause separators is doing several things at once. */
  CLAUSES: 3,
} as const;

// --- Helpers ----------------------------------------------------------------

/** The relations a plan hangs off its goal by. Exported so the gardener's
 *  W213 packet and this rule cannot disagree about what "reaches" means. */
export const GOAL_RELS = ['blocks', 'part-of'] as const;

/** A memoised "does this id reach a goal along GOAL_RELS" over one graph —
 *  the W213 question, shared with the day's touch check (src/touch.ts). */
export function goalReach(g: Graph): (id: string) => boolean {
  const goals = new Set([...g.entities.values()].filter((e) => e.goal).map((e) => e.id));
  const memo = new Map<string, boolean>();
  const reaches = (id: string, path: Set<string>): boolean => {
    if (goals.has(id)) return true;
    if (memo.has(id)) return memo.get(id)!;
    if (path.has(id)) return false;
    path.add(id);
    const e = g.entities.get(id);
    const hit = !!e && GOAL_RELS.some((rel) => (e.edges[rel] ?? []).some((t) => reaches(t, path)));
    path.delete(id);
    memo.set(id, hit);
    return hit;
  };
  return (id) => reaches(id, new Set());
}

/** Work that exists to get somewhere: an open task or project, or a process
 *  (a process has no open/closed — it runs until it is retired or dormant). */
export function isPlan(e: Entity): boolean {
  if (e.kind === 'process') return e.status !== 'closed';
  return (e.kind === 'task' || e.kind === 'project') && e.status === 'open';
}

const norm = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Overlap of two word sets, 0..1. Deterministic and cheap; used only to
 *  SURFACE candidates, never to authorise a change. */
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

function authoredEdges(e: Entity): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [rel, targets] of Object.entries(e.edges)) {
    if (!isAuthoredRel(rel)) continue;
    for (const t of targets) out.push([rel, t]);
  }
  return out;
}

function buildCtx(g: Graph): Ctx {
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  for (const e of g.entities.values()) {
    outbound.set(e.id, outbound.get(e.id) ?? new Set());
    for (const [, target] of authoredEdges(e)) {
      outbound.get(e.id)!.add(target);
      if (!inbound.has(target)) inbound.set(target, new Set());
      inbound.get(target)!.add(e.id);
    }
  }
  return { entities: [...g.entities.values()], inbound, outbound };
}

const f = (code: string, severity: Severity, e: Entity, detail: string): Finding => ({
  code,
  severity,
  id: e.id,
  domain: e.domain,
  detail: detail.replace(/\s+/g, ' ').trim(),
});

// --- The rules --------------------------------------------------------------

export const RULES: Rule[] = [
  // ---- RED: the graph is wrong -------------------------------------------
  {
    code: 'E101',
    severity: 'red',
    what: 'an edge points at a node that does not exist',
    run: (g, ctx) =>
      ctx.entities.flatMap((e) =>
        authoredEdges(e)
          .filter(([, t]) => !g.entities.has(t))
          .map(([rel, t]) => f('E101', 'red', e, `${rel} → ${t}, which is not in the graph`)),
      ),
  },
  {
    code: 'E102',
    severity: 'red',
    what: 'a person is filed outside the people domain',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => e.kind === 'person' && e.domain !== PEOPLE_DOMAIN)
        .map((e) => f('E102', 'red', e, `kind=person but filed in ${e.domain}/`)),
  },
  {
    // WRITTEN AS RED, DEMOTED BY ITS OWN FIRST RUN — 32 hits, and every one of
    // them correct behaviour. A closed entity keeping its probe is exactly how
    // a REOPEN gets noticed; the 2026-08-07 bug was the sweep's cadence, not
    // the probe's existence, and I turned a fix I had just shipped into a rule
    // without re-deriving what it forbade. Kept, blue, as the record of that.
    code: 'I305',
    severity: 'blue',
    what: 'a closed entity still carries a probe (fine — it is how a reopen is noticed; here to be counted)',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => e.status === 'closed' && !!e.probe)
        .map((e) => f('I305', 'blue', e, `closed (${e.state ?? '?'}) and still probed`)),
  },
  {
    code: 'E104',
    severity: 'red',
    what: 'an entity points at itself',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => authoredEdges(e).some(([, t]) => t === e.id))
        .map((e) => f('E104', 'red', e, 'has an edge to itself')),
  },

  // ---- YELLOW: the graph is badly shaped ----------------------------------
  {
    code: 'W201',
    severity: 'yellow',
    cls: 'birth',
    what: 'no edge at all, authored OR derived — nothing can reach it but its name',
    run: (g, ctx) =>
      ctx.entities
        .filter((e) => !(ctx.outbound.get(e.id)?.size ?? 0) && !(ctx.inbound.get(e.id)?.size ?? 0))
        // DERIVED EDGES COUNT FOR REACHABILITY. `acted-by` is computed from
        // `actor`, and `neighbours()` traverses it like any other — so a person
        // named as the actor of a task IS findable from that task. Counting
        // only AUTHORED edges reported 6 isolated nodes on 2026-08-07 of which
        // 3 (eleanora, kian, content-reward) were reachable the whole time.
        // I2 says derived is not authored; it does not say derived is not real.
        .filter((e) => !g.edges.some((x) => x.src === e.id || x.dst === e.id))
        .map((e) => f('W201', 'yellow', e, 'no edge in or out, derived included')),
  },
  {
    // WRITTEN AS YELLOW AT 77 HITS — the single biggest number in the first
    // measurement, and the premise was wrong. `neighbours()` returns
    // `direction: 'out' | 'in'`, so a node with only outbound edges is reached
    // perfectly well FROM ITS TARGET. An edge is one-way to write and two-way
    // to read; I measured the writing side and called it reachability.
    // Isolation (W201, no edge at all) is the real defect, and it is 6.
    code: 'I306',
    severity: 'blue',
    what: 'points out, nothing points in — still reachable, since neighbours() reads both directions',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => (ctx.outbound.get(e.id)?.size ?? 0) > 0 && !(ctx.inbound.get(e.id)?.size ?? 0))
        .map((e) => f('I306', 'blue', e, 'no inbound edge')),
  },
  {
    code: 'W203',
    severity: 'yellow',
    cls: 'rot',
    what: 'its structure is mostly `relates-to`, which says two things are near without saying how',
    run: (_g, ctx) =>
      ctx.entities.flatMap((e) => {
        const edges = authoredEdges(e);
        if (edges.length < 2) return [];
        const vague = edges.filter(([rel]) => rel === 'relates-to').length;
        return vague / edges.length > T.VAGUE_SHARE
          ? [f('W203', 'yellow', e, `${vague}/${edges.length} authored edges are relates-to`)]
          : [];
      }),
  },
  {
    code: 'W204',
    severity: 'yellow',
    cls: 'rot',
    what: 'too many facts on one node — it is describing more than one thing',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => e.facts.length > T.FACTS_MAX)
        .map((e) => f('W204', 'yellow', e, `${e.facts.length} facts (max ${T.FACTS_MAX})`)),
  },
  {
    code: 'W205',
    severity: 'yellow',
    cls: 'rot',
    what: 'a single fact is a paragraph',
    run: (_g, ctx) =>
      ctx.entities.flatMap((e) =>
        e.facts
          .filter((x) => x.length > T.FACT_CHARS)
          .map((x) => f('W205', 'yellow', e, `${x.length} chars: "${x.slice(0, 60)}…"`)),
      ),
  },
  {
    code: 'W206',
    severity: 'yellow',
    cls: 'rot',
    what: 'the node as a whole has become a document',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => e.facts.join(' ').length > T.NODE_CHARS)
        .map((e) => f('W206', 'yellow', e, `${e.facts.join(' ').length} chars of facts`)),
  },
  {
    code: 'W207',
    severity: 'yellow',
    cls: 'rot',
    what: 'two facts on the same node say the same thing',
    run: (_g, ctx) =>
      ctx.entities.flatMap((e) => {
        const out: Finding[] = [];
        const words = e.facts.map(norm);
        for (let i = 0; i < e.facts.length; i++) {
          for (let j = i + 1; j < e.facts.length; j++) {
            const s = jaccard(words[i]!, words[j]!);
            if (s >= T.FACT_DUP) out.push(f('W207', 'yellow', e, `facts ${i + 1} and ${j + 1} overlap ${(s * 100) | 0}%: "${e.facts[i]!.slice(0, 50)}…"`));
          }
        }
        return out;
      }),
  },
  {
    // DISQUALIFIED FROM THE BUDGET BY THE 2026-08-07 LIVE TEST, at a 100% hit
    // rate on fresh output: the night minted `personal/learning-software-testing`
    // with three facts and ALL THREE tripped this. A rule that fires on every
    // fact a careful writer produces is not measuring decay, it is measuring
    // house style, and in a budget it would charge the night for every fact it
    // ever writes — the ratchet would fail on night one and be switched off.
    //
    // It is not WRONG about the shape ("a hobby lane, distinct from the build
    // lane; kept pressure-free — he declined a daily quest" really is three
    // claims welded together). It is wrong about severity. Splitting a compound
    // fact is gardening work for an agent that can read the evidence, not a
    // gate. So: counted, trended, never charged.
    code: 'I308',
    severity: 'blue',
    what: 'one fact carries several claims — splittable by a gardening pass, never a gate (fires on healthy writing)',
    run: (_g, ctx) =>
      ctx.entities.flatMap((e) =>
        e.facts
          .filter((x) => (x.match(/[;—]|\)\s|,\s(?:and|but|which|so)\s/g) ?? []).length >= T.CLAUSES)
          .map((x) => f('I308', 'blue', e, `compound: "${x.slice(0, 70)}…"`)),
      ),
  },
  {
    code: 'W209',
    severity: 'yellow',
    cls: 'birth',
    what: 'no chain — a fact with no route back to what justified it (I4)',
    run: (_g, ctx) =>
      ctx.entities.filter((e) => !e.chain.length).map((e) => f('W209', 'yellow', e, 'no chain entries')),
  },
  {
    // Neither birth nor rot, which is the tell that it is not a defect. Most of
    // these 25 are paperwork and personal items that close when a PERSON
    // acts, and no probe can be written for that. `graph.stuck()` already
    // surfaces the actionable ones. Left yellow it would sit in the budget
    // forever, unfixable, teaching the night that the budget is noise.
    code: 'I307',
    severity: 'blue',
    what: 'open, not dormant, and no probe — often correct (a person must act), so counted, not charged',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => e.status === 'open' && !e.dormant && !e.probe)
        .map((e) => f('I307', 'blue', e, 'open with no probe')),
  },
  {
    code: 'W211',
    severity: 'yellow',
    cls: 'rot',
    what: "one id contains another's AND nothing joins them — how a duplicate looks before anyone notices",
    run: (_g, ctx) => {
      const out: Finding[] = [];
      const byDomain = new Map<string, Entity[]>();
      for (const e of ctx.entities) byDomain.set(e.domain, [...(byDomain.get(e.domain) ?? []), e]);
      for (const es of byDomain.values()) {
        for (const a of es) {
          const sa = a.id.split('/')[1]!;
          for (const b of es) {
            if (a.id >= b.id) continue;
            const sb = b.id.split('/')[1]!;
            // SHARED LEADING SEGMENTS, not `startsWith`. The pair this rule
            // exists for — `ci-robustness-38` and `ci-robustness-initiative-38`
            // — fails a `startsWith` test in both directions, which is how the
            // first draft of this rule scored zero while its own worked example
            // sat in the graph. Two shared segments is the signal; one is just
            // a family name (`lumenlab` and `lumenlab-layer-c` are a parent
            // and its child, and that is fine).
            const pa = sa.split('-');
            const pb = sb.split('-');
            let shared = 0;
            while (shared < pa.length && shared < pb.length && pa[shared] === pb[shared]) shared++;
            if (shared < 2) continue;
            // An edge between them means the relationship is already STATED:
            // this is a parent and its child, not one thing filed twice. The
            // rule is about the pair nothing joins.
            if (ctx.outbound.get(a.id)?.has(b.id) || ctx.outbound.get(b.id)?.has(a.id)) continue;
            out.push(f('W211', 'yellow', a, `shares ${shared} leading id segments with ${b.id}, and no edge joins them`));
          }
        }
      }
      return out;
    },
  },
  {
    /**
     * A PLAN WITH NOTHING ABOVE IT. `personal/daily-quest-system` was recorded
     * on 2026-07-12 as a fixed plan — buy walnuts, add salad — and replayed
     * every morning for two months, because a plan is all the graph held: no
     * node said what the plan was FOR, so nothing could re-derive it, retire
     * it, or ask why it was being ignored. A goal is what makes a plan
     * revisable (M6); a plan that reaches none can only be repeated.
     *
     * Reach is along `blocks` and `part-of`, transitively, to any `goal: true`
     * node. Rot, not birth: a plan is legitimately minted before its outcome
     * has a name, and the outcome is a judgment the night backfills from the
     * chain (gardener W213) — or hands to the day.
     */
    code: 'W213',
    severity: 'yellow',
    cls: 'rot',
    what: 'an open plan that reaches no goal — nothing says what it is for, so it can only be repeated',
    run: (g, ctx) => {
      const reaches = goalReach(g);
      return ctx.entities
        .filter((e) => isPlan(e) && !e.goal && !e.dormant && !reaches(e.id))
        .map((e) => f('W213', 'yellow', e, `${e.kind}, no path along ${GOAL_RELS.join('/')} to any goal`));
    },
  },
  {
    code: 'W212',
    severity: 'yellow',
    cls: 'rot',
    what: 'a note long enough that it is holding facts',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => (e.note?.length ?? 0) > T.NOTE_CHARS)
        .map((e) => f('W212', 'yellow', e, `note is ${e.note!.length} chars`)),
  },

  // ---- BLUE: measured, never blocking -------------------------------------
  {
    code: 'I301',
    severity: 'blue',
    what: 'two NODES look like one node — a merge candidate, never a merge',
    run: (_g, ctx) => {
      // Deliberately blue and deliberately noisy. `similar()`'s strongest live
      // hit is `core-api/pr-3510 ↔ people/omar`, which is a person NAMED in a
      // PR's facts. A score is a place to look, never a verdict.
      const out: Finding[] = [];
      const words = ctx.entities.map((e) => norm([...e.facts, ...e.aka, e.id].join(' ')));
      for (let i = 0; i < ctx.entities.length; i++) {
        for (let j = i + 1; j < ctx.entities.length; j++) {
          const s = jaccard(words[i]!, words[j]!);
          if (s >= T.NODE_DUP) out.push(f('I301', 'blue', ctx.entities[i]!, `${(s * 100) | 0}% word overlap with ${ctx.entities[j]!.id}`));
        }
      }
      return out;
    },
  },
  {
    /**
     * TWO HOMES FOR ONE FACT (I1) — surfaced by the 2026-08-07 live test.
     *
     * The night minted `personal/learning-software-testing` AND wrote
     * `personal/learning-software-testing.md`, then read the md back through a
     * bypass. Nothing reconciles the two, so from that moment the same
     * knowledge exists twice and can disagree with itself. This is the M5
     * convergence problem arriving one file at a time, and until now it arrived
     * silently.
     *
     * Blue, because the fix is a migration and not a refusal: the pre-graph md
     * tree is 34 files, and a rule that blocked on it would block everything.
     * Counted so the number can be watched going DOWN.
     */
    code: 'I309',
    severity: 'blue',
    what: 'a pre-graph .md file shares this entity\'s slug — the same knowledge in two homes (I1, M5)',
    run: (_g, ctx) => {
      const out: Finding[] = [];
      for (const e of ctx.entities) {
        const slug = e.id.split('/')[1]!;
        if (existsSync(join(DIR, e.domain, `${slug}.md`))) {
          out.push(f('I309', 'blue', e, `also lives in ${e.domain}/${slug}.md`));
        }
      }
      return out;
    },
  },
  {
    code: 'I302',
    severity: 'blue',
    what: 'a chain entry that is not a reference anything can follow',
    run: (_g, ctx) =>
      ctx.entities.flatMap((e) =>
        e.chain
          .filter((c) => !/^(https?:\/\/|msg#\d+|episode:|repo:|pr#\d+)/i.test(c))
          .map((c) => f('I302', 'blue', e, `unfollowable chain entry "${c.slice(0, 50)}"`)),
      ),
  },
  {
    code: 'I303',
    severity: 'blue',
    what: 'a hub: so many edges that it means everything and therefore nothing',
    run: (_g, ctx) =>
      ctx.entities
        .map((e) => ({ e, d: (ctx.inbound.get(e.id)?.size ?? 0) + (ctx.outbound.get(e.id)?.size ?? 0) }))
        .filter((x) => x.d >= 12)
        .map((x) => f('I303', 'blue', x.e, `degree ${x.d}`)),
  },
  {
    code: 'I304',
    severity: 'blue',
    what: 'a derived relation appearing where an authored one was meant',
    run: (_g, ctx) =>
      ctx.entities
        .filter((e) => Object.keys(e.edges).some((r) => (DERIVED_RELS as readonly string[]).includes(r)))
        .map((e) => f('I304', 'blue', e, `carries a derived relation in its own record`)),
  },
];

export interface LintReport {
  findings: Finding[];
  /** code -> count, every rule present even at zero (the audit's own rule:
   *  a rule that reports nothing must be distinguishable from one that broke). */
  byCode: Array<{ code: string; severity: Severity; cls?: RuleClass; what: string; n: number }>;
  bySeverity: Record<Severity, number>;
  /** The budgetable number. See `rotCount`. */
  rot: number;
  /** Enforced at the write path, so this should be the historical residue only. */
  birth: number;
  /** domain -> severity -> count. */
  byDomain: Array<{ domain: string; entities: number; red: number; yellow: number; blue: number }>;
  entities: number;
}

/**
 * THE RATCHET NUMBER — rot only, and the only figure a budget may be set on.
 *
 * Birth defects are excluded because they are enforced at the write and so can
 * never accrue; blues are excluded because they never gate. What is left is the
 * decay that ordinary editing produces and ordinary care prevents, which is the
 * only thing a "may not end higher than it started" rule can fairly govern.
 *
 * One integer, deterministic, comparable across nights. That is the entire
 * interface — anything richer invites the night to argue with it.
 */
/**
 * WHICH RULES PRODUCED A NUMBER — the fingerprint a trend line is only valid
 * within. Codes and classes, nothing else: a threshold change alters the count
 * and must invalidate the series just as a demotion does.
 */
export function rulesetId(): string {
  return RULES.map((r) => `${r.code}:${r.cls ?? r.severity}`).join(',') + '|' + JSON.stringify(T);
}

export function rotCount(g: Graph = loadGraph()): number {
  const ctx = buildCtx(g);
  return RULES.filter((r) => r.cls === 'rot').reduce((n, r) => n + r.run(g, ctx).length, 0);
}

/** Run every rule. Read-only: loads the graph and touches nothing. */
export function lintGraph(g: Graph = loadGraph()): LintReport {
  const ctx = buildCtx(g);
  const findings: Finding[] = [];
  const byCode: LintReport['byCode'] = [];
  for (const r of RULES) {
    const hits = r.run(g, ctx);
    findings.push(...hits);
    byCode.push({ code: r.code, severity: r.severity, cls: r.cls, what: r.what, n: hits.length });
  }
  const bySeverity: Record<Severity, number> = { red: 0, yellow: 0, blue: 0 };
  for (const x of findings) bySeverity[x.severity]++;

  const domains = new Map<string, { entities: number; red: number; yellow: number; blue: number }>();
  for (const e of ctx.entities) {
    const d = domains.get(e.domain) ?? { entities: 0, red: 0, yellow: 0, blue: 0 };
    d.entities++;
    domains.set(e.domain, d);
  }
  for (const x of findings) {
    const d = domains.get(x.domain);
    if (d) d[x.severity]++;
  }

  // Sorted by code then id, so two runs diff cleanly and a fix shows as a
  // removed line rather than a reshuffled block.
  findings.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id) || a.detail.localeCompare(b.detail));
  return {
    findings,
    byCode,
    bySeverity,
    rot: byCode.filter((c) => c.cls === 'rot').reduce((n, c) => n + c.n, 0),
    birth: byCode.filter((c) => c.cls === 'birth').reduce((n, c) => n + c.n, 0),
    byDomain: [...domains].map(([domain, d]) => ({ domain, ...d })).sort((a, b) => b.yellow - a.yellow),
    entities: ctx.entities.length,
  };
}
