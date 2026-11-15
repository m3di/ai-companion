import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { onPulse, pulse, startPulseRelay, type Pulse } from '../src/pulse.js';

/**
 * The relay brings other processes' pulses onto this process's stream. Every
 * short-lived CLI numbers its pulses from 1 and the page dedupes by seq, so a
 * relayed pulse must be re-sequenced here — otherwise everything after the
 * first foreign pulse is dropped as a duplicate (2026-11-13).
 */
describe('pulse relay', () => {
  it('gives every relayed pulse a fresh seq on this stream', async () => {
    pulse('call', 'local, to move the counter');
    const foreign = (n: number) => ({ id: n, body: JSON.stringify({ seq: 1, at: '', kind: 'life', text: `cli ${n}` }) });
    let served = false;
    const got: Pulse[] = [];
    const off = onPulse((p) => p.kind === 'life' && got.push(p));
    const stop = startPulseRelay(
      () => (served ? [] : ((served = true), [foreign(1), foreign(2), foreign(3)])),
      () => 0,
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    stop();
    off();
    assert.equal(got.length, 3);
    assert.equal(new Set(got.map((p) => p.seq)).size, 3, 'three foreign pulses, three distinct seqs');
  });
});
