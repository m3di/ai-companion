import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { functionHits, moduleUse, recordModuleUse } from '../src/db.js';
import { normalizeExpression, touchedFunctions } from '../src/friction.js';

/**
 * THE USE LEDGER.
 *
 * Live testing found the hole this closes. Asked which item had been open
 * longest, an agent hand-rolled the answer out of two expressions and got it
 * wrong — the graph has no creation date — and NOTHING failed. No error, no
 * empty, no bypass. Instrumenting failure alone cannot see a confident
 * substitution; instrumenting USE can, because the expression itself is the
 * specification the caller had to write by hand.
 */

const MOD = `__test__${process.pid}`;
let n = 0;
const shape = () => `shape${++n}`;

describe('normalizing an expression', () => {
  it('erases literals, so scope is not mistaken for a different question', () => {
    assert.equal(
      normalizeExpression('m.openLoops("core-api").filter(e => !e.actor)'),
      normalizeExpression("m.openLoops('paperwork').filter(e => !e.actor)"),
    );
  });

  it('erases numbers and collapses whitespace', () => {
    assert.equal(normalizeExpression('m.search("x",  20)\n  .length'), 'm.search(_, _) .length');
  });

  it('keeps the shape that identifies the question', () => {
    assert.match(normalizeExpression('m.find("a").chain.length'), /m\.find\(_\)\.chain\.length/);
  });

  it('is not fooled by a quote inside a string', () => {
    assert.equal(normalizeExpression('m.search("a \\" b")'), 'm.search(_)');
  });
});

describe('what an expression touched', () => {
  const known = ['openLoops', 'find', 'search'];

  it('names the module functions it composed, sorted', () => {
    assert.deepEqual(touchedFunctions('m.openLoops().map(l => m.find(l.id))', known), ['find', 'openLoops']);
  });

  it('ignores methods that are not the module\'s', () => {
    assert.deepEqual(touchedFunctions('m.openLoops().filter(x => x.actor).map(x => x.id)', known), ['openLoops']);
  });

  it('ignores a name that is not in the catalog', () => {
    assert.deepEqual(touchedFunctions('m.nope()', known), []);
  });

  it('counts a function once however often it appears', () => {
    assert.deepEqual(touchedFunctions('m.find("a").id + m.find("b").id', known), ['find']);
  });
});

describe('the ledger', () => {
  it('coalesces repeats and keeps the distinct forms', () => {
    const s = shape();
    recordModuleUse({ module: MOD, fn: '(eval)', shape: s, example: 'm.openLoops(_).length', ms: 100, ok: true });
    recordModuleUse({ module: MOD, fn: '(eval)', shape: s, example: 'm.openLoops(_).length', ms: 100, ok: true });
    recordModuleUse({ module: MOD, fn: '(eval)', shape: s, example: 'm.openLoops(_).map(_)', ms: 200, ok: true });
    const row = moduleUse().find((r) => r.shape === s && r.module === MOD)!;
    assert.equal(row.hits, 3);
    assert.equal(row.ok_hits, 3);
    assert.deepEqual(row.examples.split('\n'), ['m.openLoops(_).map(_)', 'm.openLoops(_).length']);
  });

  it('separates successes from failures without losing either', () => {
    const s = shape();
    recordModuleUse({ module: MOD, fn: 'find', shape: s, ms: 10, ok: true });
    recordModuleUse({ module: MOD, fn: 'find', shape: s, ms: 10, ok: false });
    const row = moduleUse().find((r) => r.shape === s && r.module === MOD)!;
    assert.equal(row.hits, 2);
    assert.equal(row.ok_hits, 1);
  });

  it('tracks total time, so a slow function is visible before anyone complains', () => {
    const s = shape();
    recordModuleUse({ module: MOD, fn: 'slowOne', shape: s, ms: 300, ok: true });
    recordModuleUse({ module: MOD, fn: 'slowOne', shape: s, ms: 500, ok: true });
    assert.equal(moduleUse().find((r) => r.shape === s && r.module === MOD)!.ms_total, 800);
  });

  it('never throws at the call site', () => {
    assert.doesNotThrow(() => recordModuleUse({ module: MOD, fn: 'x', shape: shape(), ms: Number.NaN, ok: true }));
  });
});

describe('decay accounting', () => {
  it('credits a function reached through an expression', () => {
    // The bug this exists to prevent: two expressions composed openLoops and it
    // was still reported as never called, which would have retired the most-used
    // function in the catalog.
    const mod = `${MOD}-decay`;
    recordModuleUse({ module: mod, fn: '(eval)', shape: 'find+openLoops', example: 'x', ms: 1, ok: true });
    const hits = functionHits(mod);
    assert.equal(hits.get('openLoops')?.hits, 1);
    assert.equal(hits.get('find')?.hits, 1);
  });

  it('adds direct calls and composed uses together', () => {
    const mod = `${MOD}-both`;
    recordModuleUse({ module: mod, fn: 'openLoops', shape: 'openLoops', ms: 1, ok: true });
    recordModuleUse({ module: mod, fn: '(eval)', shape: 'openLoops', example: 'x', ms: 1, ok: true });
    assert.equal(functionHits(mod).get('openLoops')?.hits, 2);
  });

  it('credits nothing for an expression that touched nothing', () => {
    const mod = `${MOD}-none`;
    recordModuleUse({ module: mod, fn: '(eval)', shape: '(none)', example: '1 + 1', ms: 1, ok: true });
    assert.equal(functionHits(mod).size, 0);
  });
});
