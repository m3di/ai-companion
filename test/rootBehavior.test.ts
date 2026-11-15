import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { loadGraph } from '../src/entities.js';
import { behaviourFacts, renderBehaviourSection } from '../src/rootBehavior.js';

/**
 * `## How to behave`, AS A RENDER.
 *
 * Three properties carry this section, and each was bought:
 *   - it draws ONLY from `self/*`, because the behaviour section became a
 *     dumping ground for domain knowledge once;
 *   - it is STABLE between renders, because it sits in the injected prefix and
 *     a section that reorders itself re-bills the whole conversation (I12);
 *   - it matches what is on disk, because a generated file that drifts from its
 *     source is the failure `_map.md` already taught us (I2).
 *
 * The rules are also facts on `self/root-render`, so a reader who finds this
 * surprising can read WHY in the graph rather than in a commit message.
 */

const ROOT = join(config.knowledgeDir, 'root.md');
const section = (raw: string): string => {
  const start = raw.search(/^## How to behave\s*$/m);
  assert.notEqual(start, -1, 'root.md has no "## How to behave" heading');
  const after = raw.slice(start + '## How to behave'.length);
  const rel = after.search(/^##\s/m);
  return raw.slice(start, rel === -1 ? raw.length : start + '## How to behave'.length + rel);
};

describe('the behaviour render', () => {
  it('draws only from the self/ domain', () => {
    const ids = new Set(behaviourFacts().map((f) => f.id));
    assert.ok(ids.size > 0, 'the self domain produced no behaviour facts');
    for (const id of ids) assert.match(id, /^self\//, `${id} is not in self/ — domain knowledge is back in the behaviour section`);
  });

  it('excludes self/root-render, by structure and not by a list', () => {
    // It is `relates-to` rather than `part-of`, so it is not a behaviour. If it
    // ever appears here, someone re-parented it and the render silently grew a
    // rule the day has no use for.
    assert.equal(behaviourFacts().some((f) => f.id === 'self/root-render'), false);
    const g = loadGraph();
    const e = g.entities.get('self/root-render');
    assert.ok(e, 'self/root-render has gone — the render rules live on it');
    assert.equal((e!.edges['part-of'] ?? []).includes('self/companion'), false);
  });

  it('renders every fact of every self/companion child, losing none', () => {
    const g = loadGraph();
    const expected = [...g.entities.values()]
      .filter((e) => e.id === 'self/companion' || (e.edges['part-of'] ?? []).includes('self/companion'))
      .reduce((n, e) => n + e.facts.length, 0);
    assert.equal(behaviourFacts().length, expected, 'the render dropped or duplicated a fact');
  });

  it('is byte-identical between renders — I12', () => {
    assert.equal(renderBehaviourSection(), renderBehaviourSection());
  });

  it('carries no clock and no today-stamp — I12', () => {
    const s = renderBehaviourSection();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(s.includes(today), false, 'the render stamped today into the injected prefix');
    assert.doesNotMatch(s, /\b\d{2}:\d{2}:\d{2}\b/, 'the render put a clock in the injected prefix');
  });

  it('emits full text, never a bare pointer — the concierge is its reader', () => {
    for (const { fact } of behaviourFacts()) {
      assert.ok(fact.length > 40, `"${fact}" is too short to be a rule — it reads like a pointer`);
    }
  });

  it('matches what is on disk', () => {
    // The same contract `_map.md` is held to: a generated block that drifts from
    // its source is worse than no block, because it looks authoritative.
    assert.equal(section(readFileSync(ROOT, 'utf8')).trim(), renderBehaviourSection().trim());
  });

  it('says it is generated, so nobody hand-edits it', () => {
    assert.match(renderBehaviourSection(), /GENERATED from the self\/ domain/);
  });
});
