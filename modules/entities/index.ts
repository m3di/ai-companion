import {
  applyWrite,
  confirmFacts,
  type Entity,
  entityWrites,
  factSha,
  focusView,
  loadGraph,
  openEntityChanges,
  resolveRef,
  simplify,
  staleFacts,
  type Write,
} from '../_companion.js';

/**
 * THE ENTITY MODULE — round 8's graph, made callable (round 9 §4).
 *
 * Round 8 made knowledge a typed graph of entities, each carrying its own clock.
 * Reading it still meant reading it: `loadGraph()` parses every row of every
 * domain, and an agent that wanted one answer got the whole tree or went and
 * grepped the JSONL. This module is the other half — the questions, named, with
 * compact answers.
 *
 * Every function here obeys one rule: RETURN AN ANSWER, NOT THE DATA. A list
 * gives one line per entity and the id needed to go deeper; only `find` returns
 * a whole record, because that is what it is for. The moment a function starts
 * handing back the graph, the round has failed at its own goal — the context an
 * agent pays should track the size of its QUESTION, not the size of memory.
 *
 * Most of this module reads. The write half is at the bottom (round 10) and is
 * narrow on purpose: `record` may correct, add, drop, observe, relate or mint —
 * and may never touch `state`, which the prober owns and re-derives.
 */

// --- Shapes -----------------------------------------------------------------

export interface Card {
  id: string;
  domain: string;
  kind: string;
  aka: string[];
  status: 'open' | 'closed' | 'n/a';
  /** What the probe last saw, and when. Never hand-written. */
  state?: string;
  state_at?: string;
  actor?: string;
  dormant: boolean;
  goal: boolean;
  facts: string[];
  edges: Record<string, string[]>;
  /** Message ids, episodes, files, PRs — the route back to the raw traces. */
  chain: string[];
  note?: string;
  /** Whether this entity re-derives its own state, and how. */
  probe?: string;
}

export interface Line {
  id: string;
  kind: string;
  status: string;
  state?: string;
  actor?: string;
  /** Open entities standing in the way. */
  blockedBy?: string[];
  onCriticalPath?: boolean;
  dormant?: boolean;
  /** The first fact — enough to recognise it without opening it. */
  gist?: string;
  /**
   * How much of a `search` term this row actually matched, when it did not
   * match all of it — "2/4 terms: prod, readiness".
   *
   * Present ONLY on partial hits, so a near-miss can never be mistaken for the
   * thing that was asked for. A ranked search that returns its best guesses
   * silently is worse than one that returns nothing: the caller writes the
   * guess into memory as an answer.
   */
  partial?: string;
}

export interface DomainSummary {
  domain: string;
  entities: number;
  open: number;
  closed: number;
  /** Longest open chain to a goal in this domain, if it has one. */
  criticalPath?: string[];
  /** Kinds present, most common first — what this domain is made of. */
  kinds: string[];
}

export interface Band {
  tier: number;
  title: string;
  items: Line[];
}

export interface Move {
  id: string;
  before: string;
  after: string;
  at: string;
  /** True when the change flipped open/closed — the ones that reshape the graph. */
  statusFlip: boolean;
}

/** One node of the whole-graph view: a Card minus the heavy fields. */
export interface Node {
  id: string;
  domain: string;
  kind: string;
  status: 'open' | 'closed' | 'n/a';
  state?: string;
  state_at?: string;
  actor?: string;
  dormant: boolean;
  goal: boolean;
  /** How many edges touch it, in either direction — the renderer's size input. */
  degree: number;
  /** Enough to recognise it without opening it. */
  gist?: string;
  /** Whether it re-derives its own state. An entity without one has no clock. */
  probed: boolean;
}

/** A directed edge, inverse pairs already collapsed to one arrow. */
export interface Link {
  source: string;
  rel: string;
  target: string;
}

export interface GraphView {
  nodes: Node[];
  links: Link[];
  domains: DomainSummary[];
  /** Lint errors, if any — a graph that fails lint is drawn, but flagged. */
  errors: string[];
  generatedAt: string;
}

/** One hop out from an entity, with the relation and which way it points. */
export interface Neighbour extends Line {
  rel: string;
  /** 'out' — this entity → the neighbour; 'in' — the neighbour → this entity. */
  direction: 'out' | 'in';
}

export interface Stats {
  id: string;
  degree: number;
  /** Edge counts by relation, e.g. `blocks→2`, `part-of←5`. */
  byRelation: string[];
  openBlockers: number;
  /** Hops to the nearest goal along `blocks`, if it can reach one. */
  hopsToGoal?: number;
  /** Days since the probe last saw this entity's state. */
  stateAgeDays?: number;
  /** How many of its domain's entities are open. */
  domainOpen: number;
}

// --- Internals (not exported: only documented, typed exports reach the catalog)

function card(e: Entity): Card {
  return {
    id: e.id,
    domain: e.domain,
    kind: e.kind,
    aka: e.aka,
    status: e.status,
    state: e.state,
    state_at: e.state_at,
    actor: e.actor,
    dormant: e.dormant,
    goal: e.goal,
    facts: e.facts,
    edges: e.edges,
    chain: e.chain,
    note: e.note,
    probe: e.probe,
  };
}

function line(e: Entity, blockedBy?: string[], onPath?: boolean): Line {
  const l: Line = { id: e.id, kind: e.kind, status: e.status };
  if (e.state) l.state = e.state;
  if (e.actor) l.actor = e.actor;
  if (e.dormant) l.dormant = true;
  if (blockedBy?.length) l.blockedBy = blockedBy;
  if (onPath) l.onCriticalPath = true;
  if (e.facts[0]) l.gist = e.facts[0];
  return l;
}

/** Resolve a reference the way a person would: an id, or an unambiguous alias,
 *  or the tail of an id. Ambiguity returns NOTHING rather than a guess. */
/** Resolution moved into the loader (src/entities.ts) once the day's `observe`
 *  tool needed the same rule; this stays as the module's local name for it. */
const resolve = resolveRef;

function openBlockers(graph: ReturnType<typeof loadGraph>, s: ReturnType<typeof simplify>, id: string): string[] {
  return s.edges
    .filter((x) => x.dst === id)
    .map((x) => x.src)
    .filter((src) => graph.entities.get(src)?.status === 'open');
}

// --- The API ----------------------------------------------------------------

/**
 * What the system knows about, by domain: how much, how much of it is open, and
 * the longest open chain to each domain's goal.
 *
 * Start here. It is the whole tree in a few lines, and it replaces reading an
 * index that grows with memory.
 */
export function domains(): DomainSummary[] {
  const graph = loadGraph();
  const s = simplify(graph);
  const byDomain = new Map<string, Entity[]>();
  for (const e of graph.entities.values()) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain)!.push(e);
  }
  return [...byDomain]
    .map(([domain, es]) => {
      const counts = new Map<string, number>();
      for (const e of es) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      const path = s.criticalPaths.find((p) => p.goal.startsWith(`${domain}/`));
      const out: DomainSummary = {
        domain,
        entities: es.length,
        open: es.filter((e) => e.status === 'open').length,
        closed: es.filter((e) => e.status === 'closed').length,
        kinds: [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`),
      };
      if (path) out.criticalPath = path.path;
      return out;
    })
    .sort((a, b) => b.open - a.open);
}

/**
 * Open one entity in full: its facts, its edges, its current state and the chain
 * back to where it came from.
 *
 * Takes an id, an alias, or the tail of an id. An AMBIGUOUS alias returns null
 * rather than a guess — silently picking one is how two distinct things quietly
 * become one.
 */
export function find(ref: string): Card | null {
  const graph = loadGraph();
  const e = resolve(graph, ref);
  return e ? card(e) : null;
}

/**
 * Search everything the graph holds — ids, aliases, facts and notes — for a
 * word or phrase.
 *
 * This is the function that exists so nobody has to grep the JSONL. All words
 * must appear somewhere in the entity; matching ignores case and hyphens.
 */
export function search(term: string, limit: number = 20): Line[] {
  const graph = loadGraph();
  const s = simplify(graph);
  const norm = (x: string) => x.toLowerCase().replace(/[-_]/g, ' ');
  const words = norm(term).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  /**
   * RANK, DO NOT FILTER.
   *
   * This required EVERY word of the term to appear in one entity's text, and
   * dropped everything else. A four-word question therefore needed all four
   * tokens in a single node, which essentially never happens — so the night
   * asked "stagebox prod readiness reset" and got nothing back while 58 entities
   * contained most of those words. Thirty-four such empties are in the friction
   * ledger, and each one was read as "the graph does not know about this".
   *
   * Some of those really were missing (`texforge` was empty until the night
   * minted it on 08-17 — the discovery loop working exactly as designed). But
   * an AND filter cannot tell "we have nothing" from "no single node happens to
   * contain all your words", and conflating those two makes the empty result
   * useless as a signal in both directions.
   *
   * So matches are now scored by how much of the term they carry, and a hit
   * that did not match everything says so on the row (`partial`). Ranking
   * without saying that would be worse than the filter: the caller would write
   * the closest guess into memory as an answer.
   */
  const hays = [...graph.entities.values()].map(
    (e) => [e, norm([e.id, ...e.aka, ...e.facts, e.note ?? '', e.state ?? ''].join(' '))] as const,
  );
  /**
   * KNOWN WEAKNESS, recorded rather than half-fixed: ordinary English words.
   *
   * "zzzz nothing matches this" still returns self/root-render at 2/4, because
   * "nothing" and "this" genuinely occur in one entity's text. A
   * document-frequency filter was tried and does not help at this size — in a
   * 169-node graph a stopword that appears once reads as RARE, which is the
   * opposite of what IDF assumes. A stopword list would work and is a second
   * thing to maintain, so it waits for a query log that shows the cost. The
   * `partial` label is the guard in the meantime: a 2/4 hit on "nothing, this"
   * is visibly not an answer.
   */
  const terms = words;

  const hits: Array<{ e: Entity; score: number; matched: string[] }> = [];
  for (const [e, hay] of hays) {
    const matched = terms.filter((w) => hay.includes(w));
    // AT LEAST HALF THE QUESTION, or it is noise rather than a near-miss.
    //
    // Ranking with no floor let one common word carry a whole query: searching
    // "zzzz nothing matches this" returned real entities, because "this" and
    // "nothing" appear in ordinary facts. A hit that carries one term out of
    // four is not a partial answer to the question — it is a different subject
    // that happens to share a word, and offering it is how a guess becomes a
    // recorded fact. Half is the point where a result is still ABOUT what was
    // asked: "stagebox prod" out of "stagebox prod readiness reset" is, "this" is not.
    if (matched.length < Math.ceil(terms.length / 2)) continue;
    const idHits = terms.filter((w) => norm(e.id).includes(w)).length;
    // Coverage dominates everything else: a node carrying three of four terms
    // outranks an open node carrying one, whatever else is true about it.
    const score =
      matched.length * 100 +
      idHits * 10 +
      (matched.length === terms.length && idHits === terms.length ? 30 : 0) +
      (e.status === 'open' ? 2 : 0);
    hits.push({ e, score, matched });
  }
  return hits
    .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id))
    .slice(0, limit)
    .map((h) => {
      const l = line(h.e, openBlockers(graph, s, h.e.id));
      if (h.matched.length < terms.length) l.partial = `${h.matched.length}/${terms.length} terms: ${h.matched.join(', ')}`;
      return l;
    });
}

/**
 * Everything still open, optionally scoped to one domain — what has not closed,
 * who is on it, and what is in its way.
 */
export function openLoops(domain?: string): Line[] {
  const graph = loadGraph();
  const s = simplify(graph);
  const onPath = new Set(s.criticalPaths.flatMap((p) => p.path));
  return [...graph.entities.values()]
    .filter((e) => e.status === 'open' && (!domain || e.domain === domain))
    .map((e) => line(e, openBlockers(graph, s, e.id), onPath.has(e.id)))
    .sort((a, b) => Number(!!b.onCriticalPath) - Number(!!a.onCriticalPath) || a.id.localeCompare(b.id));
}

/**
 * What actually stands between this entity and being done: its open blockers,
 * direct first, then everything behind them.
 */
export function blockers(ref: string): Line[] {
  const graph = loadGraph();
  const s = simplify(graph);
  const e = resolve(graph, ref);
  if (!e) return [];
  const seen = new Set<string>();
  const out: Line[] = [];
  let frontier = openBlockers(graph, s, e.id);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = graph.entities.get(id);
      if (!b) continue;
      out.push(line(b));
      next.push(...openBlockers(graph, s, id));
    }
    frontier = next;
  }
  return out;
}

/**
 * The longest chain of open work ending at a goal — computed from the graph, not
 * maintained by anyone.
 *
 * With no argument it returns every domain's path, longest first.
 */
export function criticalPath(domain?: string): Array<{ goal: string; path: string[] }> {
  const graph = loadGraph();
  return simplify(graph)
    .criticalPaths.filter((p) => !domain || p.goal.startsWith(`${domain}/`))
    .map((p) => ({ goal: p.goal, path: p.path }));
}

/**
 * The focus set, in bands: whose ball it is and how loudly it should say so.
 *
 * Derived from the graph's SHAPE — blockers, actor, critical path, dormancy —
 * so it cannot drift from what is actually true. How many bands come back is
 * data, not a setting.
 */
export function focus(): Band[] {
  const graph = loadGraph();
  const s = simplify(graph);
  return focusView(graph, s).map((b) => ({
    tier: b.tier,
    title: b.title,
    items: b.items.map((i) => line(i.entity, i.blockedBy, i.onCriticalPath)),
  }));
}

/**
 * Entities whose probe has seen something change and that nobody has acted on
 * yet — the news, without asking anyone what happened.
 */
export function recentlyMoved(): Move[] {
  return openEntityChanges().map((c) => ({
    id: c.entity_id,
    before: c.before ?? '',
    after: c.after ?? '',
    at: c.created_at,
    statusFlip: !!c.status_flip,
  }));
}

/**
 * The route back to the raw record: message ids, episodes, files, PRs, urls.
 *
 * Knowledge is an INDEX over the traces, never a replacement for them — this is
 * the pointer that makes that true, and it is what to follow when the answer
 * needs detail the graph deliberately does not hold.
 */
export function trace(ref: string): string[] {
  const graph = loadGraph();
  return resolve(graph, ref)?.chain ?? [];
}

/**
 * The whole index at once — every entity as a node, every edge as one directed
 * link, plus the per-domain rollup.
 *
 * This function BREAKS THE MODULE'S OWN RULE (return an answer, not the data),
 * and it may do so for exactly one reason: its caller is a RENDERER, and a
 * renderer's genuine question is "the whole shape". It exists because the Atlas
 * demanded it (`docs/plans/atlas-visualization.md`), not because the graph
 * should be readable in bulk. An agent that calls this instead of `domains()`,
 * `search()` or `openLoops()` has paid the entire memory as context to answer a
 * question one line would have answered — which is the tax round 9 exists to
 * end. If you are not drawing pixels, this is the wrong function.
 */
export function graph(): GraphView {
  const g = loadGraph();
  const degree = new Map<string, number>();
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const { src, rel, dst } of g.edges) {
    // `blocks`/`blocked-by` are materialized in BOTH directions by the loader,
    // so drawing them raw gives every dependency two arrows pointing at each
    // other. Keep the forward sense only; the inverse carries no new fact.
    if (rel === 'blocked-by') continue;
    const key = `${src}|${rel}|${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: src, rel, target: dst });
    degree.set(src, (degree.get(src) ?? 0) + 1);
    degree.set(dst, (degree.get(dst) ?? 0) + 1);
  }
  const nodes = [...g.entities.values()].map((e) => {
    const n: Node = {
      id: e.id,
      domain: e.domain,
      kind: e.kind,
      status: e.status,
      dormant: e.dormant,
      goal: e.goal,
      degree: degree.get(e.id) ?? 0,
      probed: Boolean(e.probe),
    };
    if (e.state) n.state = e.state;
    if (e.state_at) n.state_at = e.state_at;
    if (e.actor) n.actor = e.actor;
    if (e.facts[0]) n.gist = e.facts[0];
    return n;
  });
  return {
    nodes,
    links,
    domains: domains(),
    errors: g.errors.map((d) => `${d.file}:${d.line} ${d.message}`),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One hop out from an entity: what it touches, by which relation, in which
 * direction.
 *
 * `find` gives an entity's own edge lists as bare ids; this resolves them into
 * lines you can read, and adds the edges pointing back AT it — which the record
 * never states, because an edge is written from one end only.
 */
export function neighbours(ref: string): Neighbour[] {
  const g = loadGraph();
  const s = simplify(g);
  const e = resolve(g, ref);
  if (!e) return [];
  const out: Neighbour[] = [];
  for (const edge of g.edges) {
    if (edge.rel === 'blocked-by') continue;
    const isOut = edge.src === e.id;
    const other = g.entities.get(isOut ? edge.dst : edge.src);
    if (!other || (!isOut && edge.dst !== e.id)) continue;
    out.push({ ...line(other, openBlockers(g, s, other.id)), rel: edge.rel, direction: isOut ? 'out' : 'in' });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel) || a.id.localeCompare(b.id));
}

/**
 * The shape of one entity's position in the graph: how connected it is, how far
 * it sits from a goal, and how old its state is.
 *
 * `stateAgeDays` is the one to watch — an entity whose probe stopped running
 * looks exactly like an entity whose state never changes, and only its age tells
 * the two apart.
 */
export function stats(ref: string): Stats | null {
  const g = loadGraph();
  const s = simplify(g);
  const e = resolve(g, ref);
  if (!e) return null;

  const counts = new Map<string, number>();
  let degree = 0;
  for (const edge of g.edges) {
    if (edge.rel === 'blocked-by') continue;
    if (edge.src === e.id) counts.set(`${edge.rel}→`, (counts.get(`${edge.rel}→`) ?? 0) + 1);
    else if (edge.dst === e.id) counts.set(`${edge.rel}←`, (counts.get(`${edge.rel}←`) ?? 0) + 1);
    else continue;
    degree += 1;
  }

  // Hops to a goal along the reduced `blocks` edges: how much has to land after
  // this before something the graph calls a goal is reached.
  let hops: number | undefined;
  const seen = new Set([e.id]);
  let frontier = [e.id];
  for (let d = 0; d < 12 && frontier.length; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      if (d > 0 && g.entities.get(id)?.goal) {
        hops = d;
        break;
      }
      for (const edge of s.edges) if (edge.src === id && !seen.has(edge.dst)) (seen.add(edge.dst), next.push(edge.dst));
    }
    if (hops !== undefined) break;
    frontier = next;
  }

  const out: Stats = {
    id: e.id,
    degree,
    byRelation: [...counts].sort().map(([k, n]) => `${k}${n}`),
    openBlockers: openBlockers(g, s, e.id).length,
    domainOpen: [...g.entities.values()].filter((x) => x.domain === e.domain && x.status === 'open').length,
  };
  if (hops !== undefined) out.hopsToGoal = hops;
  if (e.state_at) {
    const ms = Date.now() - Date.parse(`${e.state_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(ms)) out.stateAgeDays = Math.round((ms / 86_400_000) * 10) / 10;
  }
  return out;
}

/**
 * Whether the graph is currently sound: how many entities, and every lint error
 * if it is not.
 *
 * A failing graph means every other answer here is suspect, so it is worth being
 * able to ask directly rather than inferring it from a strange result.
 */
export function health(): { entities: number; domains: number; errors: string[] } {
  const graph = loadGraph();
  return {
    entities: graph.entities.size,
    domains: new Set([...graph.entities.values()].map((e) => e.domain)).size,
    errors: graph.errors.map((d) => `${d.file}:${d.line} ${d.message}`),
  };
}

// --- Writing (round 10) -----------------------------------------------------

export interface Recorded {
  ok: boolean;
  /** The journal row id, when it landed — the handle for a later revert. */
  writeId?: number;
  /** Why it did not land: a refusal, or the lint it would have caused. */
  problem?: string;
}

/**
 * CHANGE THE GRAPH. The first write function in the catalog.
 *
 * Every other function here answers a question. This one is the reason the
 * answers stay true: until round 10 the graph could be read from ten angles and
 * written from none, so it held whatever was true the day it was reformed and
 * quietly aged from there. The proving case is `reference/repos-and-platforms`,
 * which named five Core-API network clients of which not one was still current,
 * and which no mechanism in the system could ever have corrected.
 *
 * WHAT YOU MAY WRITE — the ops, and when each is the right one:
 *
 * - `correct-fact` — a stored fact is WRONG. Give the exact existing text in
 *   `from` (it must match; you will be shown the entity's real facts if it does
 *   not) and the replacement in `to`. This is the op the round was built for.
 * - `add-fact` — something timelessly true that the entity does not yet say.
 *   Facts must not assert state ("currently blocked", "waiting on Nora") — that
 *   is what `observe` is for, and the write will be refused if you try.
 * - `drop-fact` — a fact that stopped being true and has no replacement.
 * - `observe` — what YOU saw that no command can answer: a decision reversed, a
 *   hold lifted in a meeting, a plan abandoned. Lands in `observed`, dated,
 *   beside (never on top of) the probe's `state`.
 * - `note` — a one-line aside about the entity itself.
 * - `goal` — the entity IS what done looks like (`goal: true`), or is not. A
 *   goal terminates a critical path; a plan hangs off one by `part-of` or
 *   `blocks`. Set it on the OUTCOME, never on the plan — "omega-3 and fibre
 *   gaps closed" is a goal, "buy walnuts" is a step toward it. W213 lists the
 *   open plans that reach no goal; reach for this op, or `goal: true` on a
 *   `mint`, when the evidence says what they are for.
 * - `dormant` — PARK it (`dormant: true`), or pick it back up (`false`). Parked
 *   work is real but not competing for attention: it stays probed and indexed
 *   and stops being surfaced. Parking clears the actor (nobody is moving it).
 *   The night parks a plan by SILENCE — asked several times in the flow what it
 *   is for, no answer; if Mehdi brings a parked topic back, un-park it in the
 *   same turn and ask what it is for.
 * - `correct-chain` — fix provenance: `from` alone drops an entry, `to` alone
 *   adds one, both replace. For an entry nothing can follow (an entity path
 *   where a `msg#`/URL/`repo:path` belongs). Never empties a chain.
 * - `edge` — a relation you discovered. The target must already exist.
 * - `drop-edge` — a relation that was never true, or stopped being. Same shape
 *   as `edge`. Reach for it after a `move`, when the entity's own `part-of`
 *   still points into the domain it just left.
 * - `mint` — an entity the graph does not have. Needs at least one fact (an id
 *   with no facts is an id, not knowledge), a `chain`, and at least one
 *   **edge**: say how it joins the graph, e.g.
 *   `edges: [{rel: "part-of", target: "core-api/monolith"}]`. Targets must
 *   already exist. Chain entries use the graph's own spellings — `msg#6497`,
 *   `episode#12`, `pr#3510`, `repo:path`, or a URL; anything else cannot be
 *   followed. This is not ceremony — until 2026-08-07 a mint could not
 *   express an edge at all, so every node was born isolated and six never got
 *   linked. Naming the parent while you write the node costs nothing; finding
 *   the node again three weeks later costs everything.
 * - `move` — the entity is FILED IN THE WRONG PLACE. Give the new id in `to`.
 *   A domain is not a field, it is the id's prefix, so this is the only way to
 *   say "this is Core-API work, not affiliate-app" — the case the night of
 *   2026-08-04 hit on `affiliate-app/northwind-payment-method-2297` and could only
 *   leave a note about. Everything pointing at the old id follows it, and the
 *   state and confirmation clocks move with it. The destination domain must
 *   already exist and the destination id must be free: a move relocates one
 *   entity, it never merges two.
 * - `retire` — the entity SHOULD NOT EXIST: a duplicate, or something minted by
 *   mistake. With `into`, it is a MERGE — everything pointing at the retired id
 *   is repointed there first, so a retire can never leave a dangling edge; carry
 *   any fact only the doomed copy holds over BEFORE calling it. Without `into`
 *   it is refused while anything still points at the node. The whole row is
 *   journalled, so this is undoable from the journal alone. This is the op for
 *   the pair two overlapping nightly passes minted on 2026-08-05.
 *
 * A REFUSAL NAMES WHAT IT WANTED. If the shape is wrong you get the fields the
 * op needs AND the fields you actually sent — `correct-fact` takes `from`/`to`,
 * not `before`/`after`, which is the mistake that cost the night of 2026-08-06 a
 * retry. Read the refusal; do not guess a second shape.
 *
 * WHAT YOU MAY NOT WRITE: `state`, `state_at`, `status`. The prober owns those
 * and re-derives them from a command every fifteen minutes. There is no op for
 * them, deliberately.
 *
 * THE REASON IS REQUIRED, and it is not a formality. Every write is journalled
 * with it, and that journal is the only thing standing between "the night
 * maintains memory" and "the night quietly rewrites memory". Say what you SAW —
 * "Mehdi named the current client list in chat 2026-07-31", not "updating the
 * client list".
 *
 * Nothing is written if anything is wrong: the whole tree is re-parsed after
 * the change and rolled back to the byte on any new diagnostic. A refusal is
 * safe to retry with a different shape.
 */
export function record(write: Write, reason: string): Recorded {
  const r = applyWrite(write, reason, 'module');
  const lint = (r.errors ?? []).map((d) => d.message).join('; ');
  return { ok: r.ok, writeId: r.writeId, problem: r.problem ?? (lint || undefined) };
}

/**
 * Mark an entity's facts as still true, having actually checked them.
 *
 * Call this when you have read an entity's facts against real material — a
 * session, a PR, a conversation — and found nothing contradicting them. It
 * changes no file and cannot fail; it only winds the confirmation clock, which
 * is what makes `unconfirmed()` able to tell "verified recently" from "written
 * once and never looked at again".
 *
 * Confirming nothing is the default state of the whole graph, so this being
 * cheap is the point: call it on everything you read, not only on what changed.
 */
export function confirm(ref: string): { confirmed: number } {
  const graph = loadGraph();
  const e = resolve(graph, ref);
  if (!e) return { confirmed: 0 };
  return { confirmed: confirmFacts(e.id, e.facts) };
}

export interface AgingFact {
  id: string;
  fact: string;
  /** When the system first saw this exact sentence. */
  since: string;
  /** When a night last confirmed it, or null if nothing ever has. */
  confirmedAt: string | null;
}

/**
 * Facts nothing has confirmed in `days` — oldest first.
 *
 * The companion to contradiction-detection, and it exists because contradiction
 * only catches facts the day's work happens to touch. Nothing in a normal day
 * mentions which network clients a monolith hosts, so no contradiction ever
 * fires and the wrong list survives indefinitely. This is the other half:
 * surface what has NOT been looked at, and ask.
 *
 * Intended use is one per night, not a batch — the output is a question for a
 * human, and a list of twenty questions gets answered zero times.
 */
export function unconfirmed(days: number = 90, limit: number = 5): AgingFact[] {
  const graph = loadGraph();
  const out: AgingFact[] = [];
  for (const row of staleFacts(days, limit * 8)) {
    const e = graph.entities.get(row.entity_id);
    if (!e) continue;
    const fact = e.facts.find((f) => factSha(f) === row.fact_sha);
    if (!fact) continue;
    out.push({ id: e.id, fact, since: row.since, confirmedAt: row.confirmed_at });
    if (out.length >= limit) break;
  }
  return out;
}

export interface WriteEntry {
  id: number;
  entityId: string;
  op: string;
  before: string | null;
  after: string | null;
  reason: string;
  actor: string;
  at: string;
}

/**
 * What has been written to an entity, newest first — the audit trail.
 *
 * Direct writes are only safe because they are reviewable, and this is the
 * review. Reading it before correcting something is also how you avoid undoing
 * a change a previous night made for a reason you have forgotten.
 */
export function history(ref: string, limit: number = 10): WriteEntry[] {
  const graph = loadGraph();
  const e = resolve(graph, ref);
  if (!e) return [];
  return entityWrites(e.id, limit).map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    op: r.op,
    before: r.before,
    after: r.after,
    reason: r.reason,
    actor: r.actor,
    at: r.created_at,
  }));
}
