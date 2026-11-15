import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { completionDecision, completionReadout, READOUT_CAPS } from '../src/completion.js';

/**
 * THE WORKER'S REPORT REACHES THE CONCIERGE WHOLE, AND ONCE (src/completion.ts).
 *
 * 2026-08-27: a worker's closing report was cut at 4,000 chars in the wake-up
 * readout and the concierge told Mehdi a Fibery field did not exist — the
 * worker had found it below the cut. The same day a steer made one worker run
 * wake the concierge twice, the first time with "finished" while the guidance
 * turn was still queued. Pinned here: the final message is rendered whole up
 * to a generous cap; a cut says where it cut, how long the text was, and which
 * thread holds the rest; and a run reports exactly once, when its queue is
 * empty, ok only if every turn was — an abort reports nothing.
 */

describe('the completion readout', () => {
  it('renders every message whole under the caps, Task/Worker tagged', () => {
    const out = completionReadout(
      [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: 'did the thing' },
      ],
      7,
    );
    assert.equal(out, 'Task: do the thing\nWorker: did the thing');
  });

  it('gives the FINAL message the large cap and the earlier ones the small one', () => {
    const long = 'x'.repeat(READOUT_CAPS.otherCap + 1);
    const out = completionReadout(
      [
        { role: 'assistant', content: long },
        { role: 'assistant', content: long },
      ],
      7,
    );
    const [first, last] = out.split('\n');
    assert.match(first!, /truncated at 500 of 501 chars/);
    assert.equal(last, `Worker: ${long}`);
  });

  it('a cut names the slot and both lengths and sends the reader to readThread', () => {
    const content = 'y'.repeat(READOUT_CAPS.lastCap + 250);
    const out = completionReadout([{ role: 'assistant', content }], 42);
    assert.ok(out.startsWith(`Worker: ${'y'.repeat(READOUT_CAPS.lastCap)}…[truncated at 16000 of 16250 chars`));
    assert.match(out, /readThread\(42\)/);
    assert.match(out, /not evidence that something is absent\]$/);
  });

  it('is byte-stable for the same rows', () => {
    const rows = [
      { role: 'user', content: 'a'.repeat(600) },
      { role: 'assistant', content: 'b'.repeat(20_000) },
    ];
    assert.equal(completionReadout(rows, 3), completionReadout(rows, 3));
  });
});

describe('one wake-up per worker run', () => {
  it('a background turn with more queued defers instead of reporting', () => {
    assert.deepEqual(completionDecision({ background: true, aborted: false, queued: 1, owed: false }), {
      notify: false,
      owe: true,
    });
  });

  it('the turn that empties the queue pays the debt even if it was not itself dispatched', () => {
    assert.deepEqual(completionDecision({ background: false, aborted: false, queued: 0, owed: true }), {
      notify: true,
      owe: false,
    });
  });

  it('a background turn with an empty queue reports at once', () => {
    assert.deepEqual(completionDecision({ background: true, aborted: false, queued: 0, owed: false }), {
      notify: true,
      owe: false,
    });
  });

  it('an owed debt keeps carrying while turns are still queued', () => {
    assert.deepEqual(completionDecision({ background: false, aborted: false, queued: 2, owed: true }), {
      notify: false,
      owe: true,
    });
  });

  it('a plain (delegate-and-show) turn with nothing owed reports nothing', () => {
    assert.deepEqual(completionDecision({ background: false, aborted: false, queued: 0, owed: false }), {
      notify: false,
      owe: false,
    });
  });

  it('an abort neither reports nor carries — the debt is cleared', () => {
    assert.deepEqual(completionDecision({ background: true, aborted: true, queued: 0, owed: true }), {
      notify: false,
      owe: false,
    });
  });
});
