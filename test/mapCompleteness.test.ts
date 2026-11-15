import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { loadGraph, reformedDomains } from '../src/entities.js';
import { simplify } from '../src/simplify.js';

/**
 * A SUMMARY MAY NOT CONTRADICT ITS SOURCE.
 *
 * `_map.md` used to render `facts[0]` and nothing else. Facts append, so the
 * newest knowledge — disproportionately the CORRECTIONS — was the least likely
 * thing to appear: 445 of 609 facts never reached a map, and on 20 entities the
 * fact that overruled `facts[0]` was among them.
 *
 * On 2026-08-06 that produced a real mistake. The concierge read
 * `paperwork/_map`, saw "Final documents must be court-certified Portuguese",
 * and drafted an email asking Iris whether to translate to English or Portuguese
 * first — a question the same entity records as RESOLVED the previous day, in
 * `facts[2]`. It asked a question its own memory had answered.
 *
 * These tests pin the two properties that stop it: an overriding fact is never
 * hidden, and whatever IS hidden is admitted to.
 */

const OVERRIDE = /\b(RESOLVED|SUPERSEDE[SD]?|superseded|MISCLASSIFIED|no longer|reversed|retracted|replaced by|instead of|was wrong|LIFTED|corrected|he\/him|she\/her)\b/i;
const mapOf = (d: string): string => readFileSync(join(config.knowledgeDir, d, '_map.md'), 'utf8');

describe('domain maps do not hide corrections', () => {
  const g = loadGraph();
  // Only the entities a map actually LISTS. `simplify()` drops closed work from
  // the briefing on purpose — all 40 currently absent are closed — and a
  // 60-second map that listed finished work would be the silt this module
  // exists to prevent. The contract is about what it shows, not what it omits.
  const listed = simplify(g).live;

  it('shows every fact that overrides an earlier one', () => {
    const missing: string[] = [];
    for (const e of listed) {
      const map = mapOf(e.domain);
      for (const f of e.facts.slice(1)) {
        if (!OVERRIDE.test(f)) continue;
        // Compare on a distinctive slice: the map wraps and may escape, so an
        // exact-string match would be brittle for the wrong reason.
        const probe = f.slice(0, 60);
        if (!map.includes(probe)) missing.push(`${e.id}: "${probe}…"`);
      }
    }
    assert.deepEqual(missing, [], `a correction is invisible on its own domain map:\n${missing.join('\n')}`);
  });

  it('admits how much it is not showing', () => {
    // The property that matters even more than completeness: a reader must be
    // able to tell "this is all of it" from "this is the first line of it".
    for (const e of listed) {
      const shown = 1 + e.facts.slice(1).filter((f) => OVERRIDE.test(f)).length;
      if (e.facts.length <= shown) continue;
      const rest = e.facts.length - shown;
      assert.match(
        mapOf(e.domain),
        new RegExp(`\\(\\+${rest} more facts?`),
        `${e.domain}/_map.md hides ${rest} fact(s) of ${e.id} without saying so`,
      );
    }
  });

  it('every domain has a map to check', () => {
    for (const d of reformedDomains()) assert.doesNotThrow(() => mapOf(d), `${d} has no _map.md`);
  });
});
