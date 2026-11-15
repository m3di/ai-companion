import { openEntityChanges } from './db.js';
import { loadGraph, type Entity, type Graph } from './entities.js';
import { simplify, type Simplified } from './simplify.js';

/**
 * FOCUS AS A PROJECTION (round 8) — "focus is the active list of these leads …
 * we might lose something from the focus list but we can always pick up a fresh
 * thread from the knowledge index of entities" (Mehdi, 2026-07-28).
 *
 * Round 7 made focus a stored ledger and then had to solve an INTAKE problem:
 * every mechanism it built (checker, worker escalation, ranked surface) assumed
 * the item was already there, so a bug hit in a live session could reach Fibery,
 * a note and a thread and still never reach the surface Mehdi reads.
 *
 * Deriving it dissolves that problem instead of plumbing around it. A session
 * that opens something mints an ENTITY; appearing in focus follows for free, and
 * losing the list is a cache miss rather than data loss — exactly the recovery
 * property Mehdi asked for.
 *
 * The tiers are read off the graph's SHAPE, not off anyone's taste — see
 * tierFor() for the ladder. How many bands appear is therefore data: a set that
 * is all one thing prints as one band, and the count moves as the work does.
 */

export interface FocusItem {
  entity: Entity;
  tier: number;
  band: string;
  /** Open entities standing between this one and being actionable. */
  blockedBy: string[];
  /** True when this entity sits on a critical path to a goal. */
  onCriticalPath: boolean;
  /** Unconsumed probe changes — why it is worth surfacing right now. */
  changed?: { before: string; after: string; at: string; statusFlip: boolean };
}

export interface FocusBand {
  tier: number;
  title: string;
  items: FocusItem[];
}

const BAND_TITLES: Record<number, string> = {
  1: 'your ball, on the critical path',
  2: 'your ball',
  3: 'waiting on someone',
  4: 'tracked, nobody on it',
  5: 'dormant',
};

/** Who the system treats as Mehdi in an entity's `actor` field. */
const SELF = new Set(['mehdi', 'me', 'self', 'us']);

/**
 * The tier ladder, corrected by the first real graph.
 *
 * "Unblocked and Mehdi is the actor" put TWENTY of thirty-six open items in
 * tier 1 — which is not a focus list, it is the backlog with a different name.
 * Two things separate a real top band from that pile: whether anything actually
 * waits on this (the critical path) and whether it is deliberately parked.
 */
function tierFor(e: Entity, openBlockers: string[], onPath: boolean): number {
  if (e.dormant) return 5;
  const mine = !!e.actor && SELF.has(e.actor.toLowerCase());
  if (openBlockers.length) return mine || onPath ? 3 : 4;
  if (mine) return onPath ? 1 : 2;
  if (e.actor) return 3;
  // Nobody named and nothing in the way: real, but nobody has picked it up.
  return onPath ? 3 : 4;
}

/**
 * Build the focus set from the entity graph.
 *
 * Everything OPEN is a member — completeness is the point, and it is affordable
 * because the prober keeps the quiet tail fresh for the cost of a subprocess.
 * Tier decides loudness; nothing is excluded to keep the list short.
 */
export function focusView(graph: Graph = loadGraph(), s?: Simplified): FocusBand[] {
  const simp = s ?? simplify(graph);
  const onPath = new Set(simp.criticalPaths.flatMap((p) => p.path));

  const changes = new Map<string, ReturnType<typeof openEntityChanges>[number]>();
  for (const c of openEntityChanges()) if (!changes.has(c.entity_id)) changes.set(c.entity_id, c);

  const items: FocusItem[] = [];
  for (const e of graph.entities.values()) {
    // `n/a` entities (a person, a system) are context, not loops; `closed` ones
    // are done. Dormant DOES appear — parked is not gone, and the whole point of
    // a complete index is that nothing quietly falls out of view.
    if (e.status !== 'open') continue;
    // Read blockers off the REDUCED edges: an implied dependency is not an
    // extra thing in the way, and counting it would push items down a tier.
    const blockedBy = simp.edges
      .filter((x) => x.dst === e.id)
      .map((x) => x.src)
      .filter((src) => graph.entities.get(src)?.status === 'open');
    const c = changes.get(e.id);
    items.push({
      entity: e,
      tier: tierFor(e, blockedBy, onPath.has(e.id)),
      band: '',
      blockedBy,
      onCriticalPath: onPath.has(e.id),
      changed: c ? { before: c.before ?? '', after: c.after ?? '', at: c.created_at, statusFlip: !!c.status_flip } : undefined,
    });
  }

  const bands = new Map<number, FocusBand>();
  for (const it of items) {
    it.band = BAND_TITLES[it.tier] ?? `tier ${it.tier}`;
    if (!bands.has(it.tier)) bands.set(it.tier, { tier: it.tier, title: it.band, items: [] });
    bands.get(it.tier)!.items.push(it);
  }

  // Inside a band: what just moved first, then what is on a critical path, then
  // stable order. The ranking is the surface's whole job — one candidate at a
  // time, top of the list.
  for (const b of bands.values()) {
    b.items.sort((a, z) => {
      if (!!a.changed !== !!z.changed) return a.changed ? -1 : 1;
      if (a.onCriticalPath !== z.onCriticalPath) return a.onCriticalPath ? -1 : 1;
      return a.entity.id.localeCompare(z.entity.id);
    });
  }
  return [...bands.values()].sort((a, b) => a.tier - b.tier);
}

/**
 * THE MIGRATION SURFACE — both halves of focus, while the migration runs.
 *
 * Focus is becoming a projection of the entity graph, but only REFORMED domains
 * have one. Dropping the stored ledger before the last domain is reformed would
 * make un-reformed work vanish — the exact failure this whole line of work
 * exists to end. So both are shown, labelled, and the stored half empties itself
 * as domains are reformed until this collapses to the derived view.
 *
 * Lives here rather than in focus.ts because focus.ts is imported BY entities.ts
 * (for the probe allowlist); putting the merge there would close an import cycle.
 */
export function mergedFocusLines(chatId: number, storedLines: string[]): string[] {
  let derived: string[] = [];
  try {
    const graph = loadGraph();
    if (graph.errors.length) {
      // A graph that failed lint must not feed a surface Mehdi acts on. Say so
      // plainly rather than silently showing a shorter list.
      derived = [`(entity graph has ${graph.errors.length} lint error(s) — derived focus withheld until the reformer fixes it)`];
    } else if (graph.entities.size) {
      derived = focusLinesFromGraph(focusView(graph));
    }
  } catch (e) {
    console.error('[focus] derived view failed', e);
  }
  if (!derived.length) return storedLines;
  if (!storedLines.length) return derived;
  return [...storedLines, '', '### derived from the entity graph (reformed domains)', ...derived];
}

/** One compact line per item — what workers and the concierge see. */
export function focusLinesFromGraph(bands: FocusBand[]): string[] {
  const label = (id: string) => id.split('/').pop() ?? id;
  const out: string[] = [];
  for (const b of bands) {
    if (bands.length > 1) out.push(`### ${b.tier}. ${b.title}`);
    for (const it of b.items) {
      const e = it.entity;
      out.push(
        `- ${e.id}${e.state ? ` — \`${e.state}\`` : ''}${e.actor ? ` · on ${e.actor}` : ''}${it.onCriticalPath ? ' · CRITICAL PATH' : ''}` +
          (it.changed ? `\n    MOVED (${it.changed.at} UTC): ${it.changed.before} → ${it.changed.after}` : '') +
          (it.blockedBy.length ? `\n    blocked by: ${it.blockedBy.map(label).join(', ')}` : '') +
          (e.facts[0] ? `\n    ${e.facts[0]}` : '') +
          `\n    chain: ${e.chain.slice(0, 4).join(', ')}`,
      );
    }
  }
  return out;
}
