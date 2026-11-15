import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadGraph, parseRecordFile, renderRecords, toRow, type Diagnostic, type Entity } from '../src/entities.js';

/**
 * THE DATA / VIEW ROUND-TRIP.
 *
 * `entities.jsonl` is the data; `entities.md` is a generated view of it. That
 * split only buys anything if the view is genuinely derived — and the first cut
 * was LOSSY: any fact containing ": " got JSON-quoted on the way out, and the
 * grammar had no escape handling on the way back, so memory degraded a little
 * every time it passed through its own presentation layer.
 *
 * Nothing announces that. A round-trip check is the only thing that finds it,
 * which is exactly why it is a test and not a note in the plan.
 */

/** Compare on DATA only — source positions are presentation and never persist. */
function data(e: Entity): unknown {
  return JSON.parse(toRow(e));
}

function reparse(entities: Entity[], domain: string): Entity[] {
  const errors: Diagnostic[] = [];
  const out = parseRecordFile(renderRecords(entities), `${domain}/entities.md`, domain, errors);
  assert.deepEqual(errors, [], `re-parsing the rendered view produced diagnostics:\n${errors.map((d) => d.message).join('\n')}`);
  return out;
}

describe('record ↔ row round-trip', () => {
  it('survives the characters that broke it', () => {
    const hostile = [
      'Two edits precede sending — add "Employment: full-time" to the offer',
      '- a fact that starts with a dash',
      '# a fact that starts with a hash',
      'a fact with, commas and [brackets] and a trailing colon:',
      'unicode: → ← ✓ ünïcödé',
      'backslashes \\ and "quotes" together',
    ];
    const e: Entity = {
      id: 't/alpha',
      domain: 't',
      kind: 'task',
      aka: ['alpha, the first', 'a "quoted" alias'],
      facts: hostile,
      edges: {},
      status: 'open',
      dormant: false,
      goal: false,
      chain: ['msg#1', 'https://example.com/a?b=c&d=e', 'src/importer.ts:42'],
      note: 'a note',
      file: 't/entities.jsonl',
      line: 1,
      factsLine: 1,
      edgesLine: 1,
    };
    const back = reparse([e], 't');
    assert.equal(back.length, 1);
    assert.deepEqual(data(back[0]!), data(e));
  });

  it('is exact for every entity in the real tree', () => {
    const graph = loadGraph();
    assert.deepEqual(graph.errors, [], 'the real tree must lint clean before anything else is meaningful');
    assert.ok(graph.entities.size > 100, `expected a populated tree, got ${graph.entities.size} entities`);

    const byDomain = new Map<string, Entity[]>();
    for (const e of graph.entities.values()) {
      if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
      byDomain.get(e.domain)!.push(e);
    }

    for (const [domain, ents] of byDomain) {
      const ordered = [...ents].sort((a, b) => a.line - b.line);
      const back = reparse(ordered, domain);
      assert.equal(back.length, ordered.length, `${domain}: ${ordered.length} entities in, ${back.length} out`);
      for (let i = 0; i < ordered.length; i++) {
        assert.deepEqual(data(back[i]!), data(ordered[i]!), `${domain}: ${ordered[i]!.id} did not survive the round-trip`);
      }
    }
  });

  it('never writes source positions into the data', () => {
    // A row carrying a line number would make the data depend on how the view
    // happened to be laid out — the exact coupling the split exists to remove.
    for (const e of loadGraph().entities.values()) {
      const row = JSON.parse(toRow(e)) as Record<string, unknown>;
      for (const k of ['file', 'line', 'factsLine', 'edgesLine', 'domain']) {
        assert.ok(!(k in row), `${e.id}: row carries presentation field \`${k}\``);
      }
    }
  });
});
