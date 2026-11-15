import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workerOpenSnapshot, workerStaticPrompt } from '../src/workerPrompt.js';
import { WORKER_TOOL_NAMES } from '../src/workerTools.js';

/**
 * THE WORKER'S PREFIX MUST NOT MOVE (Charter I8 — an anomaly narrated is an
 * anomaly missed; this one was narrated for weeks as "the bot is expensive").
 *
 * A worker's injected context is appended to the system prompt, ahead of the
 * entire transcript in the prompt cache. The failure it caused was not subtle
 * and not gradual: on 2026-08-02 one worker session spent $86 because this block
 * carried the focus set, so a background probe flipping a state string — or
 * merely the clock advancing past a `checked <time>` stamp — re-wrote 614k
 * cached tokens. A single call in that session produced 372 tokens of output for
 * $3.87.
 *
 * What has to hold is therefore a property, not a value: the same brief must
 * produce a byte-identical block no matter what else in the system moved. A
 * regression here is invisible in every log and every test that only checks the
 * text "looks right" — it shows up as a bill. So this asserts stability
 * directly, and separately asserts that the worker has no tool that would let it
 * pull a moving surface back in through the side door.
 */

describe("a worker's injected context", () => {
  // Since 2026-08-28 the brief no longer rides in the prefix at all: it is in
  // the first turn's [SESSION OPEN] block (src/workerPrompt.ts), and the
  // system prompt in front of the transcript is frozen per session —
  // test/workerPrompt.test.ts asserts that prefix. What this keeps asserting
  // is the property that cost the money: the same brief, the same bytes, and
  // nothing in the block that ticks on its own besides the date it names once.
  it('is byte-identical for the same brief across calls', () => {
    const brief = 'Fix the tracker-code resolver in affiliate-app. Do not touch V37.';
    const now = new Date('2026-08-28T10:00:00Z');
    const first = workerOpenSnapshot({ brief, cwd: '/repo', now });
    const second = workerOpenSnapshot({ brief, cwd: '/repo', now });
    assert.equal(first, second);
  });

  it('carries the brief and the facts the preset used to carry, and no clock', () => {
    const out = workerOpenSnapshot({ brief: 'Ship PR #152.', cwd: '/repo', now: new Date('2026-08-28T10:00:00Z') });
    assert.ok(out.includes('Ship PR #152.'), 'the brief itself must be there');
    assert.doesNotMatch(out, /\d{1,2}:\d{2}/, 'a wall-clock time has no place even in a one-time block');
    assert.equal(out.match(/\d{4}-\d{2}-\d{2}/g)?.length, 1, 'the date appears once, as the day the thread began');
  });

  it('is never in the static prompt', () => {
    assert.ok(!(workerStaticPrompt() ?? '').includes('Ship PR #152.'));
  });
});

describe("a worker's tools", () => {
  it('cannot reach the memory surfaces the brief replaced', () => {
    // Stripping the context is only half the fix: a worker that could still call
    // recallNotes or read the focus set would pull the same moving text into its
    // transcript, and would once again be a second writer of a store the night
    // owns. These names must stay gone.
    for (const gone of [
      'trackOpenLoop',
      'noticeFocusChange',
      'noteIdea',
      'observe',
      'recallNotes',
      'readNote',
      'writeNote',
    ]) {
      assert.ok(!(WORKER_TOOL_NAMES as readonly string[]).includes(gone), `${gone} must not be a worker tool`);
    }
  });

  it('keeps the ones that let it finish a task without holding a turn open', () => {
    for (const kept of ['watchRun', 'reportBlocked', 'searchMessages', 'findPastWork']) {
      assert.ok((WORKER_TOOL_NAMES as readonly string[]).includes(kept), `${kept} must remain a worker tool`);
    }
  });
});
