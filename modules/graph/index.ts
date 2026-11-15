import { loadGraph, type Entity, type Graph } from '../_companion.js';

/**
 * THE GRAPH'S INSTRUMENT PANEL — structure, not content.
 *
 * `modules/entities` answers questions ABOUT THE WORK: what is open, who owns
 * it, what blocks it. Nothing answered questions about the GRAPH ITSELF — how
 * dense it is, whether it is balanced, which nodes have grown fat enough to
 * stop being one idea, whether the same thing is stored twice, whether it is
 * converging or just accumulating.
 *
 * That gap is why I6 ("memory converges") has been an aspiration rather than a
 * property: its acceptance test is a NUMBER, and until now no number existed.
 * A structural optimizer built before these measurements would have had no
 * evidence it helped except its own report — which is the failure mode the
 * graph was built to avoid in the first place.
 *
 * So this module is deliberately READ-ONLY and deliberately opinionated. It
 * does not "improve" anything; it names what is out of shape, in numbers a
 * human or an agent can compare across runs and across domains. What to do
 * about a finding is a judgement, and judgement belongs to the caller.
 *
 * The demand rows behind it (I5), all from the 2026-08-05 session: a duplicate
 * pair minted ten minutes apart under two ids and undetectable; two entities
 * minted with no route back to the traces; a node misfiled in the wrong domain
 * for two days; and a graph in which a third of all edges turned out to be the
 * vaguest relation available, which nobody had ever counted.
 */

/** The authored relation that means "connected, unspecified". Its share of the
 *  graph is the cheapest single read on whether structure is real or nominal. */
const VAGUE_REL = 'relates-to';
/** Relations the loader computes rather than accepting from an author. They are
 *  excluded from authored-structure measures: counting them would report the
 *  loader's work as the graph's. */
const DERIVED = new Set(['acted-by']);

export interface Shape {
  entities: number;
  edges: number;
  domains: number;
  /** Authored edges per entity. The blunt density number. */
  edgesPerEntity: number;
  /** Share of authored edges that are `relates-to`, 0–1. High means the graph
   *  knows things are connected but not how — nominal structure, not real. */
  vagueShare: number;
  /** Entities with no edge at all, in or out — counted over ALL edges, derived
   *  included, because this measures REACHABILITY, not authorship. */
  isolated: number;
  /** Entities carrying no fact — should be zero; the write path refuses them. */
  factless: number;
  /** Median and worst facts-per-node, for spotting drift toward fat nodes. */
  factsMedian: number;
  factsMax: number;
  byKind: Array<{ kind: string; n: number }>;
  byRel: Array<{ rel: string; n: number; derived: boolean }>;
  /** Lint state at the moment of measuring — a shape read off a broken graph
   *  is not comparable with one read off a clean graph. */
  errors: number;
}

/**
 * The whole graph in one call — the numbers you compare between runs.
 *
 * This is the reading that answers I6's acceptance test ("denser than last
 * month and not larger without a reason"): `edgesPerEntity` is the density,
 * `entities` is the size, and `vagueShare` is the honesty check on the first
 * two — a graph can raise its density to any number you like by adding
 * `relates-to` edges, and that is growth pretending to be convergence.
 */
export function shape(): Shape {
  const g = loadGraph();
  const es = [...g.entities.values()];
  const authored = g.edges.filter((e) => !DERIVED.has(e.rel));
  const deg = degrees(g, { derived: true });
  const facts = es.map((e) => e.facts.length).sort((a, b) => a - b);

  const kinds = tally(es.map((e) => e.kind));
  const rels = tally(g.edges.map((e) => e.rel));
  return {
    entities: es.length,
    edges: authored.length,
    domains: new Set(es.map((e) => e.domain)).size,
    edgesPerEntity: round2(authored.length / Math.max(1, es.length)),
    vagueShare: round2(authored.filter((e) => e.rel === VAGUE_REL).length / Math.max(1, authored.length)),
    isolated: es.filter((e) => !deg.in.get(e.id) && !deg.out.get(e.id)).length,
    factless: es.filter((e) => !e.facts.length).length,
    factsMedian: facts[Math.floor(facts.length / 2)] ?? 0,
    factsMax: facts[facts.length - 1] ?? 0,
    byKind: kinds.map(([kind, n]) => ({ kind, n })),
    byRel: rels.map(([rel, n]) => ({ rel, n, derived: DERIVED.has(rel) })),
    errors: g.errors.length,
  };
}

export interface DomainProfile {
  domain: string;
  entities: number;
  /** Authored edges with both ends inside the domain. */
  internal: number;
  /** Authored edges leaving the domain. */
  outbound: number;
  /** Authored edges arriving from outside. */
  inbound: number;
  /** internal / (internal + outbound + inbound). Near 1 = a silo; near 0 = a
   *  domain whose contents belong to other domains, or a pure hub. */
  cohesion: number;
  avgFacts: number;
  isolated: number;
  /** Open, non-dormant entities — the domain's live surface. */
  open: number;
  vagueShare: number;
}

/**
 * Every domain measured the same way, so they can be compared rather than
 * described one at a time.
 *
 * Comparison is the point: an absolute cohesion of 0.4 means nothing, but one
 * domain at 0.4 among ten at 0.8 is a question worth asking, and a domain with
 * zero internal edges is either a genuine hub (`people`, pointed at by
 * everything and pointing at nothing) or a folder pretending to be a domain.
 * The measure cannot tell those apart and does not try — it surfaces the
 * outlier and leaves the judgement where it belongs.
 */
export function domains(): DomainProfile[] {
  const g = loadGraph();
  const deg = degrees(g, { derived: true });
  const es = [...g.entities.values()];
  const domainOf = (id: string): string | undefined => g.entities.get(id)?.domain;

  const out: DomainProfile[] = [];
  for (const d of [...new Set(es.map((e) => e.domain))].sort()) {
    const rows = es.filter((e) => e.domain === d);
    let internal = 0;
    let outbound = 0;
    let inbound = 0;
    let vague = 0;
    for (const e of g.edges) {
      if (DERIVED.has(e.rel)) continue;
      const s = domainOf(e.src);
      const t = domainOf(e.dst);
      if (s !== d && t !== d) continue;
      if (s === d && t === d) internal++;
      else if (s === d) outbound++;
      else inbound++;
      if (s === d && e.rel === VAGUE_REL) vague++;
    }
    const touching = internal + outbound + inbound;
    out.push({
      domain: d,
      entities: rows.length,
      internal,
      outbound,
      inbound,
      cohesion: round2(internal / Math.max(1, touching)),
      avgFacts: round2(rows.reduce((n, e) => n + e.facts.length, 0) / Math.max(1, rows.length)),
      isolated: rows.filter((e) => !deg.in.get(e.id) && !deg.out.get(e.id)).length,
      open: rows.filter((e) => e.status === 'open' && !e.dormant).length,
      vagueShare: round2(vague / Math.max(1, internal + outbound)),
    });
  }
  return out.sort((a, b) => b.entities - a.entities);
}

export interface HeavyNode {
  id: string;
  kind: string;
  facts: number;
  /** Total characters of fact text — the honest weight, since one 400-character
   *  fact is a paragraph wearing a fact's clothes. */
  chars: number;
  /** Longest single fact, in characters. */
  longest: number;
  degree: number;
}

/**
 * The nodes that have stopped being one idea — split candidates, ranked.
 *
 * Ranked by total fact CHARACTERS rather than fact count, because the two fail
 * differently and only one of them is visible in a count: a node with three
 * 700-character facts reads as small and is not. A fat node is not wrong, but
 * it is where I1 ("a fact lives in exactly one node") quietly stops being true
 * — once a node covers four subjects, the fifth thing you learn has two
 * plausible homes and the graph starts duplicating instead of converging.
 */
export function heavy(limit: number = 10): HeavyNode[] {
  const g = loadGraph();
  const deg = degrees(g, { derived: true });
  return [...g.entities.values()]
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      facts: e.facts.length,
      chars: e.facts.join(' ').length,
      longest: e.facts.reduce((n, f) => Math.max(n, f.length), 0),
      degree: (deg.in.get(e.id) ?? 0) + (deg.out.get(e.id) ?? 0),
    }))
    .sort((a, b) => b.chars - a.chars)
    .slice(0, Math.max(1, limit));
}

export interface LooseEnds {
  /** No edge in or out, derived included: in the graph, but not part of it. */
  isolated: string[];
  /** Nothing points at them — reachable only by knowing the id already. Counted
   *  over all edges, so a person node reached by `acted-by` is not listed. */
  unreachable: string[];
  /** Every one of their edges is `relates-to`: attached, but by nothing that
   *  says what the attachment means. */
  vagueOnly: string[];
  /** No `chain` — no route back to the trace that justified them (I7). */
  unprovenanced: string[];
}

/**
 * The ends that lead nowhere — what a reader can't reach, and what can't be
 * traced back.
 *
 * These are the four ways a node fails to be part of the graph while sitting
 * inside it. `unreachable` matters most for retrieval: an agent navigates by
 * following edges from something it already has, so a node nothing points at is
 * effectively invisible however good its content is. `unprovenanced` is I7's
 * lint made countable — a fact with neither a probe nor provenance is a claim
 * the system cannot re-derive or defend.
 */
export function loose(): LooseEnds {
  const g = loadGraph();
  const deg = degrees(g, { derived: true });
  const es = [...g.entities.values()];
  const authoredOf = (e: Entity): string[] =>
    Object.entries(e.edges)
      .filter(([rel]) => !DERIVED.has(rel))
      .flatMap(([rel, ts]) => ts.map(() => rel));
  return {
    isolated: es.filter((e) => !deg.in.get(e.id) && !deg.out.get(e.id)).map((e) => e.id).sort(),
    unreachable: es.filter((e) => !deg.in.get(e.id) && deg.out.get(e.id)).map((e) => e.id).sort(),
    vagueOnly: es
      .filter((e) => {
        const rels = authoredOf(e);
        return rels.length > 0 && rels.every((r) => r === VAGUE_REL);
      })
      .map((e) => e.id)
      .sort(),
    unprovenanced: es.filter((e) => !e.chain.length).map((e) => e.id).sort(),
  };
}

export interface SimilarPair {
  a: string;
  b: string;
  /** 0–1. Shared vocabulary across id, aka and facts. */
  score: number;
  /** Why they scored: the tokens they share, most distinctive first. */
  shared: string[];
  sameDomain: boolean;
}

/**
 * Pairs that may be the same thing stored twice — merge candidates, ranked.
 *
 * The case that asked for this: on 2026-08-05 two overlapping nightly passes
 * minted `core-api/ci-robustness-initiative-38` and `core-api/ci-robustness-38`
 * ten minutes apart, for the same Fibery initiative, and nothing in the system
 * could notice. Duplication is the specific way this graph fails to converge —
 * it does not get wrong, it gets redundant, and redundancy is invisible to
 * every per-node check.
 *
 * Scored on shared distinctive tokens rather than string distance, so
 * `ci-robustness-38` and `ci-robustness-initiative-38` match on the words that
 * carry meaning instead of being separated by an inserted one. Stopwords and
 * tokens common across the graph are discounted; a token that appears in half
 * the graph proves nothing. This is a SUGGESTION list — merging is a judgement
 * and this module makes none.
 */
export function similar(limit: number = 10, minScore: number = 0.3): SimilarPair[] {
  const g = loadGraph();
  const es = [...g.entities.values()];
  const bag = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const e of es) {
    const toks = tokens(`${e.id.split('/')[1] ?? ''} ${e.aka.join(' ')} ${e.facts.join(' ')}`);
    bag.set(e.id, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // A token carries weight in inverse proportion to how many nodes use it.
  const weight = (t: string): number => 1 / Math.log2(2 + (df.get(t) ?? 1));

  const out: SimilarPair[] = [];
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const a = es[i]!;
      const b = es[j]!;
      const ta = bag.get(a.id)!;
      const tb = bag.get(b.id)!;
      if (!ta.size || !tb.size) continue;
      const shared = [...ta].filter((t) => tb.has(t));
      if (!shared.length) continue;
      const num = shared.reduce((n, t) => n + weight(t), 0);
      const den = [...new Set([...ta, ...tb])].reduce((n, t) => n + weight(t), 0);
      const score = round2(num / Math.max(1e-9, den));
      if (score < minScore) continue;
      out.push({
        a: a.id,
        b: b.id,
        score,
        shared: shared.sort((x, y) => weight(y) - weight(x)).slice(0, 6),
        sameDomain: a.domain === b.domain,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

export interface HierarchyReport {
  rel: string;
  /** Nodes with no parent under this relation — the domain roots. */
  roots: string[];
  /** Deepest chain found, as the path itself. */
  deepest: string[];
  maxDepth: number;
  /** Nodes with more than one parent — legal, but the reason `part-of` stops
   *  behaving like a tree and starts behaving like a graph. */
  multiParent: Array<{ id: string; parents: string[] }>;
  /** Cycles under this relation. A cycle in `part-of` is always a bug. */
  cycles: string[][];
  /** Direct children per root — the branching a reader actually has to scan. */
  fanout: Array<{ id: string; children: number }>;
}

/**
 * The containment hierarchy, measured: roots, depth, multi-parent nodes, cycles.
 *
 * `part-of` is the relation a reader navigates by, so its shape is the shape of
 * the graph's usability. Two failures matter and neither shows up per-node: a
 * root with sixty direct children is a list, not a hierarchy — nothing has been
 * organised, only collected; and a hierarchy that is one level deep everywhere
 * means the domains are flat namespaces rather than structure.
 *
 * Cycles are reported separately from depth because a cycle makes depth
 * meaningless, and silently returning a number computed over a cyclic graph is
 * how a measure becomes a lie.
 */
export function hierarchy(rel: string = 'part-of'): HierarchyReport {
  const g = loadGraph();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of g.edges) {
    if (e.rel !== rel) continue;
    parents.set(e.src, [...(parents.get(e.src) ?? []), e.dst]);
    children.set(e.dst, [...(children.get(e.dst) ?? []), e.src]);
  }
  const ids = [...g.entities.keys()];
  const involved = ids.filter((id) => parents.has(id) || children.has(id));
  const roots = involved.filter((id) => !parents.has(id)).sort();

  const cycles = findCycles(parents);
  const cyclic = new Set(cycles.flat());

  let deepest: string[] = [];
  const walk = (id: string, seen: Set<string>, path: string[]): void => {
    if (path.length > deepest.length) deepest = [...path];
    for (const c of children.get(id) ?? []) {
      if (seen.has(c) || cyclic.has(c)) continue;
      seen.add(c);
      walk(c, seen, [...path, c]);
      seen.delete(c);
    }
  };
  for (const r of roots) {
    if (cyclic.has(r)) continue;
    walk(r, new Set([r]), [r]);
  }

  return {
    rel,
    roots,
    deepest,
    maxDepth: deepest.length,
    multiParent: involved
      .filter((id) => (parents.get(id) ?? []).length > 1)
      .map((id) => ({ id, parents: parents.get(id)!.sort() }))
      .sort((a, b) => b.parents.length - a.parents.length),
    cycles,
    fanout: roots
      .map((id) => ({ id, children: (children.get(id) ?? []).length }))
      .sort((a, b) => b.children - a.children),
  };
}

// --- internals --------------------------------------------------------------

/**
 * Degree, over a chosen slice of the edge set.
 *
 * The distinction is load-bearing and was got wrong once already. Measures of
 * what an AUTHOR built (density, vague share) must exclude derived edges, or
 * the loader's own work inflates them. Measures of REACHABILITY must include
 * them, because a derived edge is a real edge — the Atlas draws it and an agent
 * can follow it. Counting `people/eleanora` as isolated while twenty
 * `acted-by` edges point at it is not a stricter measure, it is a false one.
 */
function degrees(g: Graph, opts: { derived: boolean }): { in: Map<string, number>; out: Map<string, number> } {
  const inn = new Map<string, number>();
  const out = new Map<string, number>();
  for (const e of g.edges) {
    if (!opts.derived && DERIVED.has(e.rel)) continue;
    inn.set(e.dst, (inn.get(e.dst) ?? 0) + 1);
    out.set(e.src, (out.get(e.src) ?? 0) + 1);
  }
  return { in: inn, out };
}

function tally(xs: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'this', 'for', 'on', 'with',
  'as', 'by', 'at', 'from', 'not', 'but', 'was', 'are', 'be', 'has', 'have', 'had', 'its', 'so',
  'which', 'what', 'when', 'than', 'then', 'they', 'their', 'them', 'can', 'will', 'would', 'one',
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9#]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Cycles under one relation, as paths. Iterative-safe on this graph's size. */
function findCycles(parents: Map<string, string[]>): string[][] {
  const out: string[][] = [];
  const state = new Map<string, number>(); // 0 unseen, 1 on stack, 2 done
  const stack: string[] = [];
  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const at = stack.indexOf(id);
      if (at !== -1) out.push([...stack.slice(at), id]);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const p of parents.get(id) ?? []) visit(p);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of parents.keys()) visit(id);
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface StuckEntity {
  id: string;
  kind: string;
  actor?: string;
  /** Its own facts already describe the work as finished. */
  claimsDone: boolean;
  /** The fact that says so, if any — the evidence for acting. */
  evidence?: string;
}

/**
 * Open work that NOTHING CAN CLOSE — no probe, so no command will ever move it.
 *
 * `status` is probe-owned by design and there is deliberately no write op for
 * it (the Charter is explicit). The consequence is easy to miss: an entity with
 * no `probe` can never leave `open`, however finished it is. The night can add
 * a fact saying RESOLVED and the entity still sits in the open set forever.
 *
 * On 2026-08-06 the audit reported 25 of 44 open entities with no probe, and
 * two of them already said RESOLVED in their own facts —
 * `client-onboarding/tracker-code-import-reuse-bug` ("RESOLVED 2026-08-02 by
 * the per-client fix") and `paperwork/translation-model`. Most of the other
 * 23 are paperwork and personal items that genuinely close when a PERSON acts
 * and no command can see it; that is not a defect, and this function does not
 * pretend otherwise. It sorts the ones with evidence to the front, because
 * those are the ones where the answer is to give the entity a `probe` and let
 * the clock do its job.
 */
export function stuck(): StuckEntity[] {
  const DONE = /\b(RESOLVED|FIXED|shipped|no longer an issue|completed)\b/i;
  const g = loadGraph();
  return [...g.entities.values()]
    .filter((e) => e.status === 'open' && !e.dormant && !e.probe)
    .map((e) => {
      const hit = e.facts.find((f) => DONE.test(f));
      return { id: e.id, kind: e.kind, actor: e.actor, claimsDone: Boolean(hit), evidence: hit };
    })
    .sort((a, b) => Number(b.claimsDone) - Number(a.claimsDone) || a.id.localeCompare(b.id));
}
