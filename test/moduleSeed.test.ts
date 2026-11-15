import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * WHOSE COPY IS IT? — the question `seedModules` could not previously ask.
 *
 * The old rule was one line: copy only when ABSENT. That is right for the case
 * it was written for — once the night edits a module, silently reverting its
 * work every boot would make "the night maintains this" a lie — but it also
 * froze copies the night had never opened. On 2026-08-07 the live `entities`
 * module turned out to be two days behind its source: its `record` doc listed
 * neither `move` nor `retire`, so the night could not reach for ops the write
 * path had already given it. The 2026-08-04 pass left a NOTE about a misfiled
 * entity it was able to move all along, and nothing anywhere reported the gap.
 *
 * The fix is a stamp of what we last handed over, which splits one question
 * into three answers. These tests are that split, and the third case — "the
 * night edited it" — is the one that must never regress, because a wrong answer
 * there destroys work rather than merely withholding it.
 */

let dir: string;
let repoModules: string;
let seedModules: typeof import('../src/modules.js').seedModules;
let moduleDrift: typeof import('../src/modules.js').moduleDrift;
let stampSeeded: typeof import('../src/modules.js').stampSeeded;

const LIVE = () => join(dir, 'entities', 'index.ts');
const SHIPPED = 'export const version = 2;\n';

/** A module needs an `index.test.ts` to be loadable at all (§6.2). */
function writeModule(root: string, body: string): void {
  mkdirSync(join(root, 'entities'), { recursive: true });
  writeFileSync(join(root, 'entities', 'index.ts'), body);
  writeFileSync(join(root, 'entities', 'index.test.ts'), '// fixture\n');
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mods-'));
  process.env.MODULES_DIR = dir;
  ({ seedModules, moduleDrift, stampSeeded } = await import('../src/modules.js'));
  // The repo side is real — `seedModules` reads `<repo>/modules` — so the
  // fixture stands in for it by staging under the same name and restoring after.
  repoModules = new URL('../modules/', import.meta.url).pathname;
});

after(() => {
  delete process.env.MODULES_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('seeding a module into a fresh tree', () => {
  it('copies it and records what it handed over', () => {
    seedModules();
    assert.ok(readFileSync(join(dir, 'entities', 'index.ts'), 'utf8').length > 0, 'nothing was seeded');
    // The stamp is the whole mechanism: without it the next boot cannot tell
    // its own copy from an edited one.
    assert.ok(readFileSync(join(dir, '.seeded', 'entities.txt'), 'utf8').trim().length > 0);
  });

  it('a freshly seeded tree reports no drift', () => {
    assert.deepEqual(moduleDrift(), []);
  });

  it('does not expose the stamp directory as a module', async () => {
    const { listModules } = await import('../src/modules.js');
    assert.equal(listModules().some((m) => m.name.startsWith('.')), false, '.seeded reached the catalog');
  });
});

describe('a live copy that is only STALE', () => {
  it('is UPDATED, because the stamp proves nobody else wrote it', () => {
    // The real 2026-08-07 state, staged: the tree holds exactly what we last
    // handed it (so the stamp matches), and the repo has since moved on.
    writeModule(dir, SHIPPED);
    stampSeeded('entities');
    assert.deepEqual(moduleDrift(), [{ name: 'entities', edited: false }], 'a stamped copy must read as ours');

    seedModules();
    assert.notEqual(readFileSync(LIVE(), 'utf8'), SHIPPED, 'the stale stock copy was not updated — the 08-07 bug');
    assert.deepEqual(moduleDrift(), [], 'and the drift must close, not merely shrink');
  });
});

describe('a live copy the NIGHT has edited', () => {
  it('is left alone, however many times the process boots', () => {
    // The load-bearing case: a wrong answer here destroys work rather than
    // merely withholding it. No stamp is written, so it reads as the night's —
    // which is also the right default for a tree seeded before stamps existed.
    writeModule(dir, '// the night wrote this\n');
    const before = readFileSync(LIVE(), 'utf8');
    seedModules();
    seedModules();
    assert.equal(readFileSync(LIVE(), 'utf8'), before, "the night's edit was overwritten");
    assert.deepEqual(moduleDrift(), [{ name: 'entities', edited: true }], 'and it must keep being reported');
  });

  it('closes once reconciled by hand and re-stamped', () => {
    cpSync(join(repoModules, 'entities'), join(dir, 'entities'), { recursive: true, force: true });
    stampSeeded('entities');
    assert.deepEqual(moduleDrift(), [], 'a reconciled module still reports drift');
  });
});

describe('the fingerprint', () => {
  it('notices a change in any file, not just the entry point', () => {
    writeFileSync(join(dir, 'entities', 'index.test.ts'), '// edited\n');
    assert.deepEqual(moduleDrift(), [{ name: 'entities', edited: true }]);
  });
});
