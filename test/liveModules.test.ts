import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listModules, renderCatalog, validateModule } from '../src/modules.js';

/**
 * THE SHIPPED MODULES, held to their own gate.
 *
 * `test/modules.test.ts` proves the runtime enforces its rules; this proves the
 * modules that actually exist pass them. It is the check that has to be here
 * rather than only in the night's audit: the night runs once a day, and a module
 * broken at 10:00 is broken for every agent until then.
 *
 * Slow on purpose — it compiles each module and runs its contract tests.
 */

const mods = listModules();

describe('the live module tree', () => {
  it('has at least the entity module', () => {
    assert.ok(
      mods.some((m) => m.name === 'entities'),
      `modules found: ${mods.map((m) => m.name).join(', ') || '(none)'}`,
    );
  });

  it('advertises only loadable modules as callable', () => {
    for (const m of mods) {
      if (!m.loadable) assert.match(renderCatalog(), new RegExp(`${m.name} — NOT LOADABLE`));
    }
  });

  it('keeps the catalog small enough to be worth injecting', () => {
    // The round exists to stop context growing with memory. If the catalog ever
    // costs more than the index it replaces, that has stopped being true.
    assert.ok(renderCatalog().length < 8000, `catalog is ${renderCatalog().length} chars`);
  });

  for (const m of mods) {
    it(`${m.name}: compiles and its contract tests are green`, async () => {
      const v = await validateModule(m.name);
      assert.ok(v.ok, [v.problems.join('; '), v.typecheck, v.tests].filter(Boolean).join('\n'));
    });
  }
});
