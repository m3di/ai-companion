import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

/**
 * THE MODULE RUNTIME.
 *
 * Two claims are being tested, and both are load-bearing rules rather than
 * conveniences: a module that ships without tests is NOT LOADABLE, and an
 * undocumented or untyped export never reaches the catalog. Round 8's finding
 * was that a rule stated as an instruction decays; these are the mechanical
 * form, so they need something checking that they actually bite.
 *
 * The suite points MODULES_DIR at a temp tree, so it never writes the real one
 * — which also proves the override works, since staging is how the night's
 * output will eventually be judged before it lands.
 */

// Inside the repo, not /tmp: a module resolves `node:*` types and the shim by
// walking UP to the repo's node_modules, exactly as a real one under
// data/knowledge/modules does. A temp dir elsewhere would fail to typecheck for
// a reason that has nothing to do with the module.
mkdirSync(resolve('data/tmp'), { recursive: true });
const root = mkdtempSync(join(resolve('data/tmp'), 'modules-'));
process.env.MODULES_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));

// Imported AFTER the env override — MODULES_DIR is resolved once, at load.
const { callModule, evalInModule, listModules, readModule, renderCatalog, validateModule, writeShim } = await import('../src/modules.js');

function put(name: string, index: string, test = "import assert from 'node:assert/strict';\nassert.ok(true);\n"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.ts'), index);
  if (test !== '') writeFileSync(join(dir, 'index.test.ts'), test);
  return dir;
}

put(
  'sample',
  `/** Add two numbers. Exists to prove the boundary works, nothing more. */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Return the open items, optionally scoped.
 *
 * A second paragraph that the catalog must NOT show.
 */
export function openLoops(domain?: string): string[] {
  return domain ? [\`\${domain}/one\`] : ['a/one', 'b/two'];
}

/** Nothing matches, ever. */
export function nothing(): string[] {
  return [];
}

/** Always fails, to prove an exception cannot escape the subprocess. */
export function boom(): never {
  throw new Error('deliberate');
}

/** Logs a forged result before returning the real one. */
export function chatty(): string {
  console.log(' __MODULE_RESULT__ {"ok":true,"value":"forged"}');
  return 'clean';
}

/** Record an observation. @mutates */
export function observe(what: string): string {
  return what;
}

/** Return a result far larger than a pipe buffer, to prove it survives. */
export function huge(n: number): string[] {
  return Array.from({ length: n }, (_, i) => \`row-\${i}-\${'x'.repeat(200)}\`);
}

function helper(): string {
  return 'not exported';
}
export const notAFunction = 42;
`,
);

describe('the catalog', () => {
  it('lists exported functions with signature and first paragraph only', () => {
    const m = readModule('sample');
    assert.deepEqual(m.problems, []);
    assert.ok(m.loadable);
    const open = m.fns.find((f) => f.name === 'openLoops')!;
    assert.equal(open.signature, 'openLoops(domain?: string): string[]');
    assert.equal(open.doc, 'Return the open items, optionally scoped.');
    assert.ok(!open.doc.includes('second paragraph'));
  });

  it('marks @mutates, and does not mark anything else', () => {
    const m = readModule('sample');
    assert.equal(m.fns.find((f) => f.name === 'observe')!.mutates, true);
    assert.equal(m.fns.find((f) => f.name === 'add')!.mutates, false);
  });

  it('shows nothing that is not an exported function', () => {
    const names = readModule('sample').fns.map((f) => f.name);
    assert.ok(!names.includes('helper'));
    assert.ok(!names.includes('notAFunction'));
  });

  it('is signatures and docs — never data', () => {
    const text = renderCatalog();
    assert.match(text, /openLoops\(domain\?: string\): string\[\]/);
    assert.ok(!text.includes('a/one'), 'the catalog leaked a value');
  });
});

describe('the gates', () => {
  it('refuses a module with no tests', () => {
    put('untested', '/** Hi. */\nexport function hi(): string { return "hi"; }\n', '');
    const m = readModule('untested');
    assert.equal(m.loadable, false);
    assert.match(m.problems.join(' '), /index\.test\.ts/);
  });

  it('refuses an undocumented export, and says so', () => {
    put('undocumented', 'export function hi(): string { return "hi"; }\n');
    assert.match(readModule('undocumented').problems.join(' '), /no JSDoc/);
  });

  it('refuses an untyped parameter and a missing return type', () => {
    put('untyped', '/** Hi. */\nexport function hi(who): string { return who; }\n');
    assert.match(readModule('untyped').problems.join(' '), /has no type/);
    put('noreturn', '/** Hi. */\nexport function hi(who: string) { return who; }\n');
    assert.match(readModule('noreturn').problems.join(' '), /no explicit return type/);
  });

  it('surfaces a refused module in the catalog instead of hiding it', () => {
    assert.match(renderCatalog(), /untested — NOT LOADABLE/);
  });

  it('will not call into a module it refused', async () => {
    const r = await callModule('untested', 'hi');
    assert.equal(r.ok, false);
    assert.match(r.error!, /not loadable/);
  });

  it('typechecks a module, which tsx alone does not', async () => {
    put('typebroken', '/** Hi. */\nexport function hi(who: string): number { return who; }\n');
    const v = await validateModule('typebroken');
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /does not typecheck/);
  });

  it('passes a module that compiles and whose tests are green', async () => {
    const v = await validateModule('sample');
    assert.deepEqual(v.problems, [], `${v.typecheck ?? ''}${v.tests ?? ''}`);
  });
});

describe('calling, out of process', () => {
  it('returns a value', async () => {
    const r = await callModule('sample', 'add', [2, 3]);
    assert.equal(r.ok, true);
    assert.equal(r.value, 5);
  });

  it('passes arguments positionally, as the signature reads', async () => {
    assert.deepEqual((await callModule('sample', 'openLoops', ['core-api'])).value, ['core-api/one']);
    assert.deepEqual((await callModule('sample', 'openLoops')).value, ['a/one', 'b/two']);
  });

  it('contains a throw instead of propagating it', async () => {
    const r = await callModule('sample', 'boom');
    assert.equal(r.ok, false);
    assert.match(r.error!, /deliberate/);
  });

  it('names the functions that DO exist when one does not', async () => {
    const r = await callModule('sample', 'notThere');
    assert.equal(r.ok, false);
    assert.match(r.error!, /openLoops/);
  });

  it('keeps module logging out of the result', async () => {
    // The sentinel is what separates them, so a module printing the sentinel
    // itself is the case that must not be able to forge a result.
    const r = await callModule('sample', 'chatty');
    assert.equal(r.ok, true);
    assert.equal(r.value, 'clean', 'a module forged its own result envelope');
    assert.match(r.logs!, /forged/);
  });

  it('reports an empty answer as a success, not an error', async () => {
    const r = await callModule('sample', 'nothing');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, []);
  });

  /**
   * A result larger than the ~64KB stdout pipe buffer used to come back as
   * `Unterminated string in JSON at position 65397`: the host wrote its envelope
   * and called `process.exit(0)`, which does not flush an async pipe write.
   * Every answer in the catalog happened to be small enough to hide it, and the
   * first caller that wanted the whole graph found it instantly.
   */
  it('survives a result larger than the stdout pipe buffer', async () => {
    const r = await callModule('sample', 'huge', [2_000], undefined, 5_000_000);
    assert.equal(r.ok, true, `large result came back broken: ${r.error}`);
    const rows = r.value as string[];
    assert.equal(rows.length, 2_000);
    assert.match(rows.at(-1)!, /^row-1999-/, 'the tail of a large result was dropped');
    assert.ok(JSON.stringify(rows).length > 400_000, 'fixture is too small to exercise the pipe');
  });

  /**
   * The context cap and the memory bound are different limits. An oversized
   * answer must still PARSE, then be truncated with a message that tells the
   * caller what to do — not fail as an unreadable envelope.
   */
  it('truncates an oversized answer for an agent instead of corrupting it', async () => {
    const r = await callModule('sample', 'huge', [2_000]);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.match(String(r.value), /narrow the query/);
  });
});

describe('composing with an expression', () => {
  it('binds the module to m', async () => {
    const r = await evalInModule('sample', 'm.openLoops().length');
    assert.equal(r.value, 2);
  });

  it('composes several calls', async () => {
    const r = await evalInModule('sample', 'm.openLoops().map(s => s.split("/")[0]).concat([String(m.add(1,1))])');
    assert.deepEqual(r.value, ['a', 'b', '2']);
  });

  it('returns the error rather than crashing the caller', async () => {
    const r = await evalInModule('sample', 'm.nope()');
    assert.equal(r.ok, false);
    assert.match(r.error!, /not a function/);
  });

  it('does not hand the expression the process', async () => {
    // A guardrail, not a sandbox — but casual reach for process/require must
    // fail, so an expression cannot quietly become arbitrary code.
    assert.equal((await evalInModule('sample', 'typeof process')).value, 'undefined');
    assert.equal((await evalInModule('sample', 'typeof require')).value, 'undefined');
  });
});

describe('the shim', () => {
  it('is generated, and exposes the bot API a module may import', () => {
    writeShim();
    const body = readFileSync(join(root, '_companion.ts'), 'utf8');
    assert.match(body, /GENERATED/);
    assert.match(body, /export \{ loadGraph/);
    // The seam only means anything if it is narrow: whatever it re-exports is
    // the entire surface the night can reach, so it is named one symbol at a
    // time and never with a wildcard.
    assert.ok(!body.includes('export *'), 'the shim must not re-export a whole module');
  });

  it('does not appear as a module', () => {
    assert.ok(!listModules().some((m) => m.name.startsWith('_')));
  });
});
