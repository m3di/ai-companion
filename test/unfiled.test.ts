import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { addCommitment, closeRetrievalEpisode, openRetrievalEpisode, resolveCommitment, unfiledTurns } from '../src/db.js';
import { config } from '../src/config.js';

/**
 * WHAT THE DAY HEARD AND NEVER WROTE DOWN.
 *
 * On 2026-08-16 Mehdi asked which documents he had to sign and send to Iris.
 * The concierge looked up `paperwork/form-signing`, answered him, and filed
 * nothing. Three more messages in the same window said the same thing — one of
 * them "I will sign the forms today and send her scans". The night had every
 * one of them inside dream #72's window, alongside a standing instruction in
 * capitals that every open loop belongs in the focus set, and filed none. The
 * next morning a worker faithfully reported the set: "waiting on Bram, not
 * you". Nobody lied; nothing had been written down.
 *
 * The instruction existed and failed. What did not exist was a way to stop
 * asking the night to FIND the needle. This is the needle-handing, so the
 * assertions are about what must never fall off the list.
 */

const CHAT = [...config.allowedChatIds][0] ?? 0;
const made: number[] = [];

after(() => {
  for (const id of made) resolveCommitment(id, CHAT, 'dropped', 'test fixture');
});

describe('turns that left no trace', () => {
  it('finds a turn that read a node and recorded nothing — the proving case', () => {
    // The retrieval WORKED. That is what makes this row the sharpest in the
    // block: the day found the right node to answer him and memory still did
    // not move, so "the graph could not help" is not available as an excuse.
    const rows = unfiledTurns('2026-08-16 00:30:11', '2026-08-17 02:05:19', 50);
    const signing = rows.find((r) => r.trigger.includes('documents i supposed to sign'));
    assert.ok(signing, 'the message that started all of this fell off the list');
    assert.ok((JSON.parse(signing.refs) as string[]).some((r) => r.endsWith('/form-signing')), signing.refs);
  });

  it('keeps first-person obligations, which are the ones that get lost', () => {
    const rows = unfiledTurns('2026-08-16 00:30:11', '2026-08-17 02:05:19', 50);
    assert.ok(
      rows.some((r) => /i will sign the forms today/i.test(r.trigger)),
      'an explicit "I will do X today" was not surfaced',
    );
  });

  it('excludes system-authored turns — this block is about what the PERSON said', () => {
    // [PULSE] / [COMMITMENT] / [SYSTEM EVENT] are the machine talking to
    // itself; their loops are already tracked by the rows that fired them, and
    // including them would bury the handful of human messages that matter.
    const rows = unfiledTurns('2026-08-01 00:00:00', '2026-12-31 00:00:00', 500);
    assert.equal(rows.filter((r) => r.trigger.startsWith('[')).length, 0);
  });

  it('drops a turn once something durable came out of it', () => {
    const key = 'test:unfiled:durable';
    openRetrievalEpisode(key, 'day', 'a probe turn that files something');
    // A commitment created while the turn was open is exactly the outcome the
    // block exists to produce — so producing one must remove the row.
    const cid = addCommitment(CHAT, 'unfiled-probe', 'body', '2099-01-01 00:00:00', { focus: 1 });
    made.push(cid);
    closeRetrievalEpisode(key);
    const rows = unfiledTurns('2026-08-01 00:00:00', '2026-12-31 00:00:00', 500);
    assert.ok(
      !rows.some((r) => r.trigger === 'a probe turn that files something'),
      'a turn that filed a commitment still counted as leaving no trace',
    );
  });

  it('respects its cap, so one loud day cannot flood the digest', () => {
    assert.ok(unfiledTurns('2026-08-01 00:00:00', '2026-12-31 00:00:00', 3).length <= 3);
  });
});
