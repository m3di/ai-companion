import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { Entity, Graph } from './entities.js';

/**
 * GRAPH SIMPLIFICATION (round 8) — "apply simplification rules that flatten the
 * problems and help resolving and representing them" (Mehdi, 2026-07-28).
 *
 * This is the payoff for making knowledge a typed graph rather than prose. Every
 * rule here is a rewrite with a proof, not a judgment call: transitive reduction
 * removes an edge that says nothing new, a resolved chain collapses because its
 * members can no longer block anything, the critical path is the longest open
 * chain to a goal. `paperwork/_map.md` maintains "the ONE critical path" BY
 * HAND today, and it goes stale the moment a step lands — here it is computed.
 *
 * Nothing in this module writes. It takes a parsed graph and returns a view, so
 * the renderer and the focus projection both compute from the same reduction.
 */

export interface Simplified {
  /** Entities that still matter: open, or closed but blocking something open. */
  live: Entity[];
  /** Closed entities pruned from the rendered view (still in the file). */
  pruned: Entity[];
  /** `blocks` edges after transitive reduction. */
  edges: Array<{ src: string; dst: string }>;
  /** Runs of closed entities folded into one node. */
  collapsed: Array<{ into: string; members: string[] }>;
  /** Longest open chain to each goal, longest first. */
  criticalPaths: Array<{ goal: string; path: string[] }>;
  /** Same edge set + overlapping aka — a possible duplicate. Never auto-merged. */
  mergeCandidates: Array<{ a: string; b: string; why: string }>;
}

const isOpen = (e: Entity) => e.status === 'open';

/** Adjacency over `blocks` only — the dependency relation. The other relations
 *  are context; they do not constrain order and so cannot be reduced. */
function blocksMap(graph: Graph): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const id of graph.entities.keys()) m.set(id, new Set());
  for (const { src, rel, dst } of graph.edges) {
    if (rel === 'blocks') m.get(src)?.add(dst);
  }
  return m;
}

/** Every node reachable from `start` via `blocks`, excluding itself. */
function reachable(from: Map<string, Set<string>>, start: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(from.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const m of from.get(n) ?? []) stack.push(m);
  }
  return out;
}

/**
 * TRANSITIVE REDUCTION — drop A→C when A→B→C already says it.
 *
 * This is what stops a map from restating the same dependency five ways as the
 * graph grows, which is the graph equivalent of the silt the push-down mandate
 * fights in prose. Safe only because the parser refuses cycles.
 */
function transitiveReduction(adj: Map<string, Set<string>>): Array<{ src: string; dst: string }> {
  const kept: Array<{ src: string; dst: string }> = [];
  for (const [src, directs] of adj) {
    for (const dst of directs) {
      // Redundant iff dst is reachable from some OTHER direct successor.
      const viaOther = [...directs].some((mid) => mid !== dst && reachable(adj, mid).has(dst));
      if (!viaOther) kept.push({ src, dst });
    }
  }
  return kept;
}

/**
 * COLLAPSE RESOLVED CHAINS — a run of closed entities that blocks only other
 * closed entities is history, and history belongs in the traces. Fold it to one
 * node so the map shows the shape of what is LEFT.
 */
function collapseResolved(graph: Graph, adj: Map<string, Set<string>>): Simplified['collapsed'] {
  const closed = [...graph.entities.values()].filter((e) => e.status === 'closed');
  const closedIds = new Set(closed.map((e) => e.id));

  // Connected components of the closed subgraph, walked UNDIRECTED. A forward-
  // only walk finds a run only when it happens to start at the run's head —
  // start one node in and the same chain reads as two runs of one.
  const nbrs = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!nbrs.has(a)) nbrs.set(a, new Set());
    nbrs.get(a)!.add(b);
  };
  for (const id of closedIds) {
    for (const n of adj.get(id) ?? []) {
      if (!closedIds.has(n)) continue;
      link(id, n);
      link(n, id);
    }
  }

  const seen = new Set<string>();
  const out: Simplified['collapsed'] = [];
  for (const e of closed) {
    if (seen.has(e.id)) continue;
    const members: string[] = [];
    const stack = [e.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(id);
      for (const n of nbrs.get(id) ?? []) stack.push(n);
    }
    if (members.length < 2) continue;
    // Order the run the way the work actually happened: a member with no
    // closed predecessor inside the run comes first.
    const inRun = new Set(members);
    const ordered: string[] = [];
    const placed = new Set<string>();
    const visit = (id: string): void => {
      if (placed.has(id)) return;
      placed.add(id);
      for (const p of members) if (inRun.has(p) && adj.get(p)?.has(id)) visit(p);
      ordered.push(id);
    };
    for (const m of members) visit(m);
    out.push({ into: ordered[0]!, members: ordered });
  }
  return out;
}

/**
 * CRITICAL PATH — the longest chain of OPEN entities ending at a goal.
 *
 * This is the question the focus set is really asking ("what is actually in the
 * way"), and it is why the flow layer exists at all. Closed nodes are skipped
 * rather than traversed: a finished step constrains nothing.
 */
function criticalPaths(graph: Graph, reduced: Array<{ src: string; dst: string }>): Simplified['criticalPaths'] {
  // Walk BACKWARD over the REDUCED edges. Backward because the path is
  // everything that must happen before the goal, and reduced because a
  // redundant shortcut is not a step — counting it would make the chain look
  // shorter than the work actually is.
  const preds = new Map<string, string[]>();
  for (const { src, dst } of reduced) {
    if (!preds.has(dst)) preds.set(dst, []);
    preds.get(dst)!.push(src);
  }

  const memo = new Map<string, string[]>();
  /** Longest chain of OPEN entities ending AT `id`, inclusive of `id`. */
  const chainTo = (id: string): string[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    memo.set(id, [id]); // cycle guard; the parser already refuses real cycles
    let best: string[] = [];
    for (const p of preds.get(id) ?? []) {
      const e = graph.entities.get(p);
      if (!e || !isOpen(e)) continue; // a finished step constrains nothing
      const sub = chainTo(p);
      if (sub.length > best.length) best = sub;
    }
    const path = [...best, id];
    memo.set(id, path);
    return path;
  };

  return [...graph.entities.values()]
    .filter((e) => e.goal && isOpen(e))
    .map((g) => ({ goal: g.id, path: chainTo(g.id) }))
    .filter((p) => p.path.length > 1)
    .sort((a, b) => b.path.length - a.path.length);
}

/**
 * MERGE CANDIDATES — flagged, never merged. Identity resolution is the one
 * place where a wrong automatic call silently destroys a distinct thing, so
 * this hands the reformer a question rather than making the decision.
 */
function mergeCandidates(graph: Graph): Simplified['mergeCandidates'] {
  const all = [...graph.entities.values()];
  const out: Simplified['mergeCandidates'] = [];
  const norm = (s: string) => s.trim().toLowerCase();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      // Symmetric on purpose. The first cut only checked a's aliases against b's
      // id, so whether a duplicate was found depended on which of the two
      // happened to be defined first in the file — `nora ~ nora-vance` was
      // caught by luck, and its mirror image would have been missed.
      const akaA = a.aka.map(norm);
      const akaB = b.aka.map(norm);
      const shared = [
        ...akaA.filter((x) => akaB.includes(x)),
        ...akaA.filter((x) => norm(b.id) === x || norm(b.id).endsWith(`/${x}`)),
        ...akaB.filter((x) => norm(a.id) === x || norm(a.id).endsWith(`/${x}`)),
      ];
      if (shared.length) {
        out.push({ a: a.id, b: b.id, why: `share alias "${shared[0]}"` });
        continue;
      }
      if (a.kind !== b.kind) continue;
      // Membership edges are NOT evidence of duplication: on the real
      // affiliate-app graph every component carries `part-of: platform`, so a
      // naive signature flagged postback-channel against import-engine,
      // client-soft-delete and client-config — four unrelated things. Ignore
      // membership, and require at least two shared edges before suspecting a
      // duplicate at all.
      const sig = (e: Entity) =>
        Object.entries(e.edges)
          .filter(([rel]) => rel !== 'part-of' && rel !== 'owned-by')
          .flatMap(([rel, ts]) => ts.map((t) => `${rel}:${t}`))
          .sort();
      const sa = sig(a);
      if (sa.length >= 2 && sa.join('|') === sig(b).join('|')) {
        out.push({ a: a.id, b: b.id, why: `identical kind and ${sa.length} shared edges` });
      }
    }
  }
  return out;
}

export function simplify(graph: Graph): Simplified {
  const adj = blocksMap(graph);
  const edges = transitiveReduction(adj);
  const collapsed = collapseResolved(graph, adj);

  // PRUNE: a closed entity that blocks nothing open has nothing left to say to
  // the reader. It stays in the FILE — the record and its chain are the durable
  // index — but it leaves the rendered map.
  const live: Entity[] = [];
  const pruned: Entity[] = [];
  for (const e of graph.entities.values()) {
    if (e.status !== 'closed') {
      live.push(e);
      continue;
    }
    const blocksSomethingOpen = [...(adj.get(e.id) ?? [])].some((n) => {
      const t = graph.entities.get(n);
      return t && isOpen(t);
    });
    (blocksSomethingOpen ? live : pruned).push(e);
  }

  return {
    live: live.sort((a, b) => a.id.localeCompare(b.id)),
    pruned,
    edges,
    collapsed,
    criticalPaths: criticalPaths(graph, edges),
    mergeCandidates: mergeCandidates(graph),
  };
}

/**
 * Render a domain's `_map.md` FROM the simplified graph.
 *
 * The map stops being authored and becomes a view — the same move `index.md`
 * already made. That is what makes the formality load-bearing instead of
 * decorative: a readable briefing that cannot drift from the graph, because it
 * is regenerated from it every time the graph changes.
 */
/**
 * Does this fact OVERRIDE what the entity said earlier?
 *
 * The map used to show `facts[0]` and nothing else. Facts APPEND, so the newest
 * knowledge — which is disproportionately the corrections — was the least
 * likely thing to be shown: 445 of 609 facts (73%) never reached any map, and
 * on 20 entities the one fact that overruled `facts[0]` was among them.
 *
 * That is not an omission, it is a summary that contradicts its own source. It
 * cost a real mistake on 2026-08-06: the concierge read `paperwork/_map`,
 * saw `translation-model — Final documents must be court-certified Portuguese;
 * DATA arranges the Portuguese translations`, and drafted an email asking Iris
 * the English-vs-Portuguese question — which fact[2] of that same entity records
 * as RESOLVED the day before. It asked a question its own memory had answered.
 *
 * `people/sasha` was one keystroke from the same failure: the map showed the QA
 * role and hid "Sasha is MALE — he/him, never she/her".
 *
 * So an overriding fact is promoted into the summary, and whatever is still
 * hidden is COUNTED rather than silently dropped. A lossy render that does not
 * announce its lossiness is worse than a long one — the reader cannot tell
 * "this is all of it" from "this is the first line of it".
 */
function overriding(fact: string): boolean {
  return /\b(RESOLVED|SUPERSEDE[SD]?|superseded|MISCLASSIFIED|no longer|reversed|retracted|replaced by|instead of|was wrong|LIFTED|corrected|he\/him|she\/her)\b/i.test(fact);
}

export function renderMap(domain: string, graph: Graph, s: Simplified): string {
  const mine = s.live.filter((e) => e.domain === domain);
  const path = s.criticalPaths.find((p) => graph.entities.get(p.goal)?.domain === domain);
  const label = (id: string) => graph.entities.get(id)?.id.split('/').pop() ?? id;

  const byKind = new Map<string, Entity[]>();
  for (const e of mine) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind)!.push(e);
  }

  const out: string[] = [
    '---',
    `key: ${domain}/_map`,
    `summary: ${domain} — generated from entities.md; do not edit by hand`,
    '---',
    '',
    `# ${domain}`,
    '',
    '<!-- GENERATED from entities.md by renderMap(). Edits here are overwritten.',
    '     Change the entity records instead; the map is a view of the graph. -->',
    '',
  ];

  if (path?.path.length) {
    out.push('## Critical path', '', path.path.map(label).join(' → '), '');
  }

  const open = mine.filter(isOpen);
  if (open.length) {
    out.push('## Open', '');
    for (const e of open) {
      // Read from the REDUCED edges: a dependency the reduction removed is
      // already implied by the chain, and restating it is the silt this whole
      // module exists to prevent. Only OPEN blockers are shown — a closed one
      // constrains nothing, and listing it keeps reporting work that landed.
      const blockedBy = s.edges
        .filter((x) => x.dst === e.id)
        .map((x) => x.src)
        .filter((d) => graph.entities.get(d)?.status === 'open');
      out.push(
        `- **${label(e.id)}** (${e.kind})${e.state ? ` — \`${e.state}\`` : ''}${e.actor ? ` · on ${e.actor}` : ''}` +
          (blockedBy.length ? `\n  blocked by: ${blockedBy.map(label).join(', ')}` : ''),
      );
    }
    out.push('');
  }

  out.push('## What is known', '');
  for (const [kind, es] of [...byKind].sort()) {
    out.push(`**${kind}**`);
    for (const e of es) {
      out.push(`- ${label(e.id)} — ${e.facts[0] ?? e.note ?? '(no facts recorded)'}`);
      // OVERRIDING FACTS ARE NEVER HIDDEN, and the summary always admits it is
      // one. See `overriding()` for what this cost.
      for (const f of e.facts.slice(1).filter(overriding)) out.push(`  ↳ ${f}`);
      const rest = e.facts.length - 1 - e.facts.slice(1).filter(overriding).length;
      if (rest > 0) out.push(`  _(+${rest} more fact${rest === 1 ? '' : 's'} — \`find("${e.id}")\`)_`);
    }
    out.push('');
  }

  out.push('## Retrieval', '', 'Every entity carries a `chain:` — message ids, episodes, files, PRs.', 'Open `entities.md` for the full records.', '');

  if (s.collapsed.length) {
    const mineCollapsed = s.collapsed.filter((c) => c.into.startsWith(`${domain}/`));
    if (mineCollapsed.length) {
      out.push('## Resolved', '');
      for (const c of mineCollapsed) out.push(`- ${c.members.map(label).join(' → ')} (done)`);
      out.push('');
    }
  }

  // A GENERATOR MAY NOT DESTROY WHAT IT DOES NOT OWN.
  //
  // `_map.md` says "Edits here are overwritten" — but `noteIdea` (round 5, still
  // live in the concierge and every worker) appends dated "## Open possibilities"
  // lines to exactly this file, and the nightly operator is still instructed to
  // curate them. So the day writes ideas into a file the graph regenerates, and
  // the documented cure for a stale view (`reformCli --render`) silently deletes
  // them: four of Mehdi's 2026-07-28 video-pipeline ideas were one render away
  // from being lost. Carrying the section through is not the design fix — ideas
  // should become records — but a renderer must never be the thing that loses
  // them while that decision is pending.
  const carried = openPossibilities(domain);
  if (carried) out.push(carried, '');

  return out.join('\n');
}

/** The hand-authored "## Open possibilities" tail of a domain's existing map. */
function openPossibilities(domain: string): string {
  const path = join(config.knowledgeDir, domain, '_map.md');
  if (!existsSync(path)) return '';
  const raw = readFileSync(path, 'utf8');
  const m = /^##\s+Open possibilities\s*$/mi.exec(raw);
  if (!m) return '';
  return raw.slice(m.index).trimEnd();
}
