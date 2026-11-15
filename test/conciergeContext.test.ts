import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { config } from '../src/config.js';
import { conciergeSystemPrompt } from '../src/concierge.js';
import { focusLines } from '../src/focus.js';
import { mergedFocusLines } from '../src/focusView.js';

/**
 * WHAT MAY SIT IN FRONT OF THE CONCIERGE'S TRANSCRIPT.
 *
 * I12: the system prompt is a cache prefix, so every byte of it sits ahead of
 * the whole conversation and a value that ticks makes the entire history
 * uncacheable and re-billed. The focus set was the worst offender in the
 * system — 25,000 characters, rewritten by a probe sweep every fifteen minutes,
 * which means it invalidated the session cache four times an hour whether or
 * not anything about the conversation had changed.
 *
 * It came out on 2026-08-06 on the audit's own recommendation: `readFocus()`
 * was being called 13× a day, so the concierge had already stopped needing the
 * copy. This pins that it does not come back.
 */

const CHAT = 121628633;

describe('the concierge system prompt', () => {
  it('does not inline the focus set', () => {
    const p = conciergeSystemPrompt(CHAT);
    // Non-empty lines only: `"".includes("")` is true and would pass forever.
    const lines = mergedFocusLines(CHAT, focusLines(CHAT)).filter((l) => l.trim().length > 20);
    const leaked = lines.filter((l) => p.includes(l.trim().slice(0, 40)));
    assert.deepEqual(leaked, [], `the focus set is back in the prefix:\n${leaked.slice(0, 3).join('\n')}`);
  });

  it('tells the concierge where the set actually is', () => {
    // Removing the copy without redirecting the reader would just make it guess.
    assert.match(conciergeSystemPrompt(CHAT), /readFocus\(\)/);
  });

  /**
   * THE "renders byte-identically twice" TEST LIVES IN test/frozenPrompt.test.ts
   * NOW — and it is right there, because the prompt no longer embeds the live
   * feed: the state moved into a one-time session-open snapshot on 2026-08-27,
   * after the ledger showed the moving prefix re-uploading the whole transcript
   * every turn. The history below is kept as the record of why it was once
   * wrong.
   *
   * It was written, and it was wrong. The prompt embeds the live awareness feed
   * and the attention set, so a running bot posting a single event between the
   * two renders fails it — which is not an I12 violation at all. I12 forbids a
   * value that ticks ON ITS OWN (a clock, a probe sweep); it does not forbid the
   * prompt changing when the DATA changes, which is the whole point of the data
   * being there.
   *
   * The first version guarded root.md's mtime and still flaked, because the feed
   * is a different input. It went red inside the nightly audit's own `npm test`,
   * which is the worst place for a false alarm: the audit exists to be believed,
   * and a suite that cries wolf costs more than the assertion was worth.
   *
   * What IS pinned is the property that mattered — the 25,000-character focus
   * set, rewritten by a sweep every fifteen minutes, is no longer in the prefix.
   * `test/workerContext.test.ts` keeps a byte-identity test where it is
   * meaningful, because a worker's brief is one string with no live inputs.
   */
});
