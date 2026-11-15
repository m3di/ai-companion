import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { graphOf, lintText, type Graph } from '../src/entities.js';
import { simplify } from '../src/simplify.js';

/**
 * THE SIMPLIFIER'S PROOFS.
 *
 * Every rewrite in `simplify.ts` claims to be a proof rather than a judgment
 * call — reduction removes only what is already implied, a critical path is a
 * real chain, a collapsed run is history. Four of those claims were false when
 * first written and were caught by running them on one realistic process. These
 * tests are that process, kept.
 */

function graph(records: string): Graph {
  const { entities, errors } = lintText(records, 't');
  assert.deepEqual(errors, [], `fixture does not lint:\n${errors.map((e) => e.message).join('\n')}`);
  return graphOf(entities);
}

/** `alpha > beta` means alpha blocks beta. `!` closes, `*` marks the goal. */
function chainOf(spec: string): string {
  const nodes = spec.split('>').map((s) => s.trim());
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i]!;
    const name = raw.replace(/[!*]/g, '');
    const next = nodes[i + 1]?.replace(/[!*]/g, '');
    out.push(
      `---\nid: t/${name}\nkind: step\nchain: [msg#${i + 1}]\nstatus: ${raw.includes('!') ? 'closed' : 'open'}` +
        (raw.includes('*') ? '\ngoal: true' : '') +
        (next ? `\nedges:\n  blocks: [t/${next}]` : '') +
        '\n',
    );
  }
  return out.join('');
}

function adjacency(edges: Array<{ src: string; dst: string }>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const { src, dst } of edges) {
    if (!m.has(src)) m.set(src, new Set());
    m.get(src)!.add(dst);
  }
  return m;
}

function closure(adj: Map<string, Set<string>>, start: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const m of adj.get(n) ?? []) stack.push(m);
  }
  return out;
}

describe('transitive reduction', () => {
  const diamond = `${chainOf('a > b > c')}---
id: t/shortcut
kind: step
chain: [msg#9]
status: open
edges:
  blocks: [t/c]
`;

  it('drops an edge that a longer path already says', () => {
    const g = graph(`${chainOf('a > b > c')}`);
    // Add the implied shortcut a→c and it must not survive the reduction.
    const withShortcut = graph(
      `${chainOf('a > b > c')}`.replace('  blocks: [t/b]', '  blocks: [t/b, t/c]'),
    );
    assert.equal(simplify(g).edges.length, 2);
    const reduced = simplify(withShortcut).edges;
    assert.equal(reduced.length, 2, `expected a→c to be reduced away, got ${JSON.stringify(reduced)}`);
    assert.ok(!reduced.some((e) => e.src === 't/a' && e.dst === 't/c'));
  });

  it('preserves reachability exactly', () => {
    // The whole safety argument for reduction: it removes edges, never paths.
    const g = graph(diamond);
    const full = new Map<string, Set<string>>();
    for (const { src, rel, dst } of g.edges) {
      if (rel !== 'blocks') continue;
      if (!full.has(src)) full.set(src, new Set());
      full.get(src)!.add(dst);
    }
    const reduced = adjacency(simplify(g).edges);
    for (const id of g.entities.keys()) {
      assert.deepEqual([...closure(reduced, id)].sort(), [...closure(full, id)].sort(), `reachability changed at ${id}`);
    }
  });

  it('keeps an edge that is the only route', () => {
    const g = graph(diamond);
    const reduced = simplify(g).edges;
    assert.ok(reduced.some((e) => e.src === 't/shortcut' && e.dst === 't/c'));
  });
});

describe('critical path', () => {
  it('is the longest open chain, in order, ending at the goal', () => {
    const s = simplify(graph(chainOf('a > b > c > d*')));
    assert.equal(s.criticalPaths.length, 1);
    assert.deepEqual(s.criticalPaths[0]!.path, ['t/a', 't/b', 't/c', 't/d']);
    assert.equal(s.criticalPaths[0]!.goal, 't/d');
  });

  it('names the goal exactly once', () => {
    // The first cut appended the goal to a chain that already ended in it.
    const s = simplify(graph(chainOf('a > b > c*')));
    const path = s.criticalPaths[0]!.path;
    assert.equal(new Set(path).size, path.length, `duplicate node in ${path.join(' → ')}`);
  });

  it('starts at the head of the chain, not in the middle', () => {
    const g = graph(chainOf('a > b > c > d*'));
    const s = simplify(g);
    const preds = new Set(s.edges.filter((e) => e.dst === s.criticalPaths[0]!.path[0]).map((e) => e.src));
    assert.equal(preds.size, 0, 'the path begins at a node that still has open predecessors');
  });

  it('skips closed steps — a finished step constrains nothing', () => {
    const s = simplify(graph(chainOf('a! > b! > c > d*')));
    assert.deepEqual(s.criticalPaths[0]!.path, ['t/c', 't/d']);
  });

  it('every consecutive pair is a real reduced edge', () => {
    const s = simplify(graph(chainOf('a > b > c > d*')));
    const reduced = adjacency(s.edges);
    for (const p of s.criticalPaths) {
      for (let i = 0; i + 1 < p.path.length; i++) {
        assert.ok(reduced.get(p.path[i]!)?.has(p.path[i + 1]!), `${p.path[i]} → ${p.path[i + 1]} is not an edge`);
      }
    }
  });

  it('reports nothing when the goal is closed', () => {
    assert.deepEqual(simplify(graph(chainOf('a > b*!'))).criticalPaths, []);
  });
});

describe('collapse and prune', () => {
  it('folds a resolved run into one node, whichever end it is walked from', () => {
    // Regression: the walk was forward-only, so a run found one node in read as
    // two runs of one. The closed subgraph must be walked UNDIRECTED.
    const s = simplify(graph(chainOf('a! > b! > c! > d')));
    assert.equal(s.collapsed.length, 1);
    assert.deepEqual(s.collapsed[0]!.members, ['t/a', 't/b', 't/c']);
    assert.equal(s.collapsed[0]!.into, 't/a');
  });

  it('does not collapse a single closed node', () => {
    assert.deepEqual(simplify(graph(chainOf('a! > b'))).collapsed, []);
  });

  it('prunes a closed entity that blocks nothing open, and keeps one that does', () => {
    const s = simplify(graph(chainOf('a! > b')));
    assert.deepEqual(s.pruned.map((e) => e.id), []); // a! still blocks the open b
    const done = simplify(graph(chainOf('a! > b!')));
    assert.deepEqual(done.pruned.map((e) => e.id).sort(), ['t/a', 't/b']);
    assert.deepEqual(done.live, []);
  });
});

describe('merge candidates', () => {
  const parts = `---
id: t/platform
kind: system
chain: [msg#1]
status: open
---
id: t/importer
kind: component
chain: [msg#2]
status: open
edges:
  part-of: [t/platform]
---
id: t/postback
kind: component
chain: [msg#3]
status: open
edges:
  part-of: [t/platform]
`;

  it('does not flag two things that merely belong to the same system', () => {
    // On the real affiliate-app graph every component carries `part-of: platform`,
    // which flagged four unrelated components as duplicates of each other.
    assert.deepEqual(simplify(graph(parts)).mergeCandidates, []);
  });

  it('flags a shared alias', () => {
    const c = simplify(graph(parts.replace('id: t/postback\nkind: component', 'id: t/postback\nkind: component\naka: [importer]'))).mergeCandidates;
    assert.equal(c.length, 1);
    assert.match(c[0]!.why, /share alias/);
  });

  it('flags an identical non-membership edge signature', () => {
    const twins = `${parts}---
id: t/left
kind: task
chain: [msg#4]
status: open
edges:
  relates-to: [t/importer, t/postback]
---
id: t/right
kind: task
chain: [msg#5]
status: open
edges:
  relates-to: [t/importer, t/postback]
`;
    const c = simplify(graph(twins)).mergeCandidates;
    assert.equal(c.length, 1);
    assert.match(c[0]!.why, /2 shared edges/);
  });

  it('never merges anything by itself', () => {
    const g = graph(parts.replace('id: t/postback\nkind: component', 'id: t/postback\nkind: component\naka: [importer]'));
    assert.equal(simplify(g).live.length, 3, 'a merge candidate must remain two distinct entities');
  });
});
