import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { openFriction, recordFriction, resolveFriction, type FrictionKind } from '../src/db.js';
import { bypassOf } from '../src/friction.js';

/**
 * THE FRICTION LEDGER.
 *
 * The premise of round 9 is that a rule only holds if it is mechanical, so the
 * detector has to be a pure function of what dispatch already sees — and then it
 * has to be tested like one. If bypass detection is wrong, the night's audit is
 * evidence-driven in name only.
 */

const KB = config.knowledgeDir;

describe('bypass detection', () => {
  const sig = (tool: string, input: Record<string, unknown>) => bypassOf(tool, input)?.signature;

  it('sees a raw Read of an entity file, absolute or relative', () => {
    assert.equal(sig('Read', { file_path: `${KB}/affiliate-app/entities.jsonl` }), 'read:affiliate-app/entities.jsonl');
    assert.equal(sig('Read', { file_path: 'data/knowledge/affiliate-app/entities.jsonl' }), 'read:affiliate-app/entities.jsonl');
    assert.equal(sig('Read', { file_path: './data/knowledge/paperwork/_map.md' }), 'read:paperwork/_map.md');
  });

  it('sees a search under the tree and keeps the question asked', () => {
    const f = bypassOf('Grep', { pattern: 'tracker_code', path: `${KB}/affiliate-app` })!;
    assert.equal(f.signature, 'search:affiliate-app');
    assert.match(f.detail!, /tracker_code/);
    assert.equal(sig('Glob', { pattern: '**/*.jsonl', path: KB }), 'search:tree');
  });

  it('sees a shell command that reaches into the tree', () => {
    assert.equal(sig('Bash', { command: 'jq -r .id data/knowledge/fibery/entities.jsonl | head' }), 'shell:fibery/entities.jsonl');
    assert.equal(sig('Bash', { command: `grep -c '' "${KB}/personal/entities.md"` }), 'shell:personal/entities.md');
  });

  it('groups by what was opened, not by how it was phrased', () => {
    // Two agents asking different questions of the same domain are one missing
    // function, not two — that is what makes a hit count mean something.
    assert.equal(
      sig('Grep', { pattern: 'tracker_code', path: `${KB}/affiliate-app` }),
      sig('Grep', { pattern: 'postback', path: `${KB}/affiliate-app` }),
    );
  });

  it('ignores everything outside the tree', () => {
    assert.equal(bypassOf('Read', { file_path: '/Users/me/Projects/core-api/src/Importer.php' }), undefined);
    assert.equal(bypassOf('Grep', { pattern: 'knowledge', path: '/Users/me/Projects/core-api' }), undefined);
    assert.equal(bypassOf('Bash', { command: 'gh pr view 3181 --json state' }), undefined);
    assert.equal(bypassOf('Write', { file_path: `${KB}/x/entities.jsonl` }), undefined, 'a write is not a retrieval bypass');
    assert.equal(bypassOf('mcp__bot__readNote', { key: 'work/core-api' }), undefined, 'using the API is not bypassing it');
  });

  it('is not fooled by a name that merely mentions knowledge', () => {
    assert.equal(bypassOf('Read', { file_path: resolve('docs/plans/round-9-modules.md') }), undefined);
    assert.equal(bypassOf('Bash', { command: 'echo knowledge' }), undefined);
  });
});

describe('the ledger', () => {
  // The suite runs against a fresh snapshot of the live DB, which already holds
  // real rows — so every fixture carries its own signature namespace.
  let n = 0;
  const sig = () => `__test__/${process.pid}/${++n}`;
  const put = (signature: string, detail: string, kind: FrictionKind = 'bypass') =>
    recordFriction({ kind, module: 'entities', signature, detail });
  const find = (signature: string) => openFriction().find((r) => r.signature === signature);

  it('coalesces repeats into one row', () => {
    const s = sig();
    put(s, 'Grep "a"');
    put(s, 'Grep "b"');
    put(s, 'Grep "c"');
    assert.equal(openFriction().filter((r) => r.signature === s).length, 1);
    assert.equal(find(s)!.hits, 3);
  });

  it('keeps the distinct occurrences, newest first, and does not repeat one', () => {
    const s = sig();
    put(s, 'Grep "tracker_code"');
    put(s, 'Grep "tracker_code"');
    put(s, 'Grep "postback"');
    const row = find(s)!;
    assert.equal(row.hits, 3);
    assert.deepEqual(row.detail.split('\n'), ['Grep "postback"', 'Grep "tracker_code"']);
  });

  it('treats the same friction after a fix as news, not as a repeat', () => {
    const s = sig();
    put(s, 'first');
    const before = find(s)!;
    resolveFriction([before.id], 'added entities.search()');
    assert.equal(find(s), undefined, 'a resolved row must leave the open ledger');
    put(s, 'again');
    const after = find(s)!;
    assert.notEqual(after.id, before.id, 'the fix did not hold — that is a new row, not hits=2');
    assert.equal(after.hits, 1);
  });

  it('separates kinds that share a signature', () => {
    const s = sig();
    put(s, 'x', 'bypass');
    put(s, 'x', 'empty');
    assert.equal(openFriction().filter((r) => r.signature === s).length, 2);
  });

  it('ranks the loudest first', () => {
    const quiet = sig();
    const loud = sig();
    put(quiet, 'once');
    for (let i = 0; i < 5; i++) put(loud, `hit ${i}`);
    const open = openFriction();
    assert.ok(open.findIndex((r) => r.signature === loud) < open.findIndex((r) => r.signature === quiet));
  });

  it('never throws at the call site', () => {
    // Instrumentation that can break the thing it measures does not get to stay
    // installed, so a bad row must be swallowed rather than surface in a turn.
    assert.doesNotThrow(() => recordFriction({ kind: 'nonsense' as FrictionKind, signature: sig(), detail: 'x' }));
  });
});
