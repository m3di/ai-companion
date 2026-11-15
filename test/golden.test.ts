import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { formatDiagnostics, loadGraph, reformedDomains, renderRecords, VIEW_FILE, type Entity } from '../src/entities.js';
import { focusView } from '../src/focusView.js';
import { checkCommandAllowed } from '../src/focus.js';
import { renderMap, simplify } from '../src/simplify.js';

/**
 * THE GOLDEN LOAD — the real tree, not a fixture.
 *
 * Every design error in round 8 was found by running against real data and none
 * by reasoning about it: the lint rules that rejected true history, the merge
 * heuristic that flagged four unrelated components, the critical path that
 * started mid-chain, the Fibery vocabulary that named three states the workspace
 * does not use. A suite that only tests fixtures would have caught none of them.
 */

const graph = loadGraph();
const s = simplify(graph);

describe('the live knowledge tree', () => {
  it('lints clean', () => {
    assert.equal(graph.errors.length, 0, `\n${formatDiagnostics(graph.errors)}`);
  });

  it('is populated', () => {
    assert.ok(graph.entities.size > 100, `${graph.entities.size} entities`);
    assert.ok(reformedDomains().length >= 8, `${reformedDomains().length} domains`);
  });

  it('has no dangling edge', () => {
    for (const { src, rel, dst } of graph.edges) {
      assert.ok(graph.entities.has(src), `edge from unknown ${src}`);
      assert.ok(graph.entities.has(dst), `${src} ${rel} → unknown ${dst}`);
    }
  });

  it('runs nothing outside the allowlist', () => {
    // A probe runs OUTSIDE the sandbox, on Mehdi's machine, unattended. This is
    // the one rule in the system whose failure mode is not a bad answer.
    for (const e of graph.entities.values()) {
      if (!e.probe) continue;
      assert.ok(checkCommandAllowed(e.probe), `${e.id}: probe not allowlisted — ${e.probe}`);
    }
  });

  it('lets the prober own state', () => {
    for (const e of graph.entities.values()) {
      if (e.state !== undefined) assert.ok(e.probe, `${e.id}: carries state with no probe to have written it`);
      if (e.closed_when) assert.ok(e.probe, `${e.id}: closed_when with no probe`);
    }
  });

  it('gives every entity a route back to the traces', () => {
    for (const e of graph.entities.values()) assert.ok(e.chain.length > 0, `${e.id}: empty chain`);
  });
});

describe('the projections over it', () => {
  it('produces a non-empty focus set', () => {
    const bands = focusView(graph, s);
    assert.ok(bands.length > 0, 'no focus bands');
    assert.ok(bands.some((b) => b.items.length > 0), 'every band is empty');
  });

  it('puts each entity in at most one band', () => {
    const seen = new Set<string>();
    for (const b of focusView(graph, s)) {
      for (const i of b.items) {
        assert.ok(!seen.has(i.entity.id), `${i.entity.id} appears in two bands`);
        seen.add(i.entity.id);
      }
    }
  });

  it('computes at least one critical path, and every one is a real chain', () => {
    assert.ok(s.criticalPaths.length > 0, 'no critical path anywhere in the tree');
    const adj = new Map<string, Set<string>>();
    for (const { src, dst } of s.edges) {
      if (!adj.has(src)) adj.set(src, new Set());
      adj.get(src)!.add(dst);
    }
    for (const p of s.criticalPaths) {
      assert.ok(p.path.length > 1, `${p.goal}: degenerate path`);
      assert.equal(new Set(p.path).size, p.path.length, `${p.goal}: repeats a node`);
      assert.equal(p.path.at(-1), p.goal);
      for (const id of p.path) assert.equal(graph.entities.get(id)?.status, 'open', `${id} is on a critical path but not open`);
      for (let i = 0; i + 1 < p.path.length; i++) {
        assert.ok(adj.get(p.path[i]!)?.has(p.path[i + 1]!), `${p.path[i]} → ${p.path[i + 1]} is not a reduced edge`);
      }
    }
  });

  it('accounts for every entity as live or pruned', () => {
    assert.equal(s.live.length + s.pruned.length, graph.entities.size);
  });
});

/**
 * The views are DERIVED. If a checked-in view no longer matches what the
 * renderer produces, the readable half of the tree is quietly lying — and the
 * fix costs nothing (`npx tsx src/reformCli.ts --render`), which is the whole
 * point of having split data from presentation.
 */
describe('generated views are current', () => {
  const byDomain = new Map<string, Entity[]>();
  for (const e of graph.entities.values()) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain)!.push(e);
  }

  for (const [domain, ents] of byDomain) {
    it(`${domain}`, () => {
      const dir = join(config.knowledgeDir, domain);
      const view = join(dir, VIEW_FILE);
      if (existsSync(view)) {
        const expected = renderRecords([...ents].sort((a, b) => a.line - b.line));
        assert.equal(readFileSync(view, 'utf8'), expected, `${domain}/${VIEW_FILE} is stale — re-render it`);
      }
      const map = join(dir, '_map.md');
      if (existsSync(map)) {
        assert.equal(readFileSync(map, 'utf8'), renderMap(domain, graph, s), `${domain}/_map.md is stale — re-render it`);
      }
    });
  }
});
