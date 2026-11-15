import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * THE POLISH (src/polish.ts). Pinned without calling a model:
 *   - THE PROMPT CARRIES THE WHOLE RAW TRANSCRIPT, confidences as tags, and
 *     the previous polish fenced as data — whole text in, whole text out, so
 *     a spoken correction can rewrite the earlier part.
 *   - THE QUERY CAN ONLY TALK: no tools, the deny-all gate, one turn, the
 *     cheap model at low effort, a dollar cap — the brief's shape.
 *   - THE SYSTEM PROMPT SAYS FIDELITY: keep his words, apply corrections,
 *     never add.
 *   - A FAILED CALL THROWS, so the app keeps the previous polish (I8).
 */

const dir = mkdtempSync(join(tmpdir(), 'polish-'));
process.env.DB_PATH = join(dir, 'polish-test.db');
process.env.KNOWLEDGE_DIR = join(dir, 'kb');

type PolishMod = typeof import('../src/polish.js');
let P: PolishMod;

before(async () => {
  P = await import('../src/polish.js');
});

describe('the polish prompt', () => {
  it('tags every scored word with its confidence, leaves unscored ones bare, and fences the previous polish', () => {
    const prompt = P.polishPrompt(
      [
        { text: ' the', confidence: 0.78 },
        { text: ' airport.', confidence: 0.85 },
        { text: ' Skylar', confidence: 0.27 },
        { text: ' leaves', confidence: null },
      ],
      'The airport.',
    );
    assert.match(prompt, /^<previous_polish>\nThe airport\.\n<\/previous_polish>\n\n<raw_transcript>\n/);
    assert.match(prompt, /the⟨0\.78⟩ airport\.⟨0\.85⟩ Skylar⟨0\.27⟩ leaves\n<\/raw_transcript>$/);
  });

  it('omits the previous block on the first pass', () => {
    const prompt = P.polishPrompt([{ text: 'hello', confidence: 0.9 }], '');
    assert.ok(!prompt.includes('previous_polish'));
    assert.ok(prompt.startsWith('<raw_transcript>'));
  });
});

describe('the polish query', () => {
  it('can only talk: no tools, deny-all, one turn, the cheap model at low effort, a cap', () => {
    const o = P.polishAskOptions([{ text: 'x', confidence: 1 }], '', new AbortController());
    assert.deepEqual(o.tools, []);
    assert.equal(o.maxTurns, 1);
    assert.equal(o.effort, 'low');
    assert.match(String(o.model), /haiku/);
    assert.ok((o.maxBudgetUsd ?? 0) > 0 && (o.maxBudgetUsd ?? 0) <= 0.1);
    // The cap grows with the take and stays bounded: 290 words cost more than 5 cents through the CLI.
    const big = P.polishAskOptions(Array.from({ length: 290 }, () => ({ text: 'w', confidence: 1 })), '', new AbortController());
    assert.ok((big.maxBudgetUsd ?? 0) > 0.1 && (big.maxBudgetUsd ?? 0) <= 0.5, `budget for 290 words: ${big.maxBudgetUsd}`);
    assert.equal(P.polishBudgetUsd(100_000), 0.5);
    assert.equal(o.concierge?.systemPrompt, P.POLISH_SYSTEM);
    assert.deepEqual(o.concierge?.allowedTools, []);
  });

  it('says fidelity, corrections, and no additions', () => {
    assert.match(P.POLISH_SYSTEM, /Never add facts/);
    assert.match(P.POLISH_SYSTEM, /CORRECTS an earlier one/);
    assert.match(P.POLISH_SYSTEM, /Keep the speaker's meaning/);
    assert.match(P.POLISH_SYSTEM, /Write ONLY the polished text/);
  });

  it('joins every text block, bills under :polish, and throws when the call failed', async () => {
    async function* ok() {
      yield { kind: 'text' as const, text: 'The 11 o\'clock show at Riverside Forum, ' };
      yield { kind: 'text' as const, text: 'then the airport.' };
      yield { kind: 'result' as const, ok: true };
    }
    const r = await P.polish(1, [{ text: 'x', confidence: 1 }], '', ok as never);
    assert.equal(r.text, "The 11 o'clock show at Riverside Forum, then the airport.");
    async function* bad() {
      yield { kind: 'result' as const, ok: false, error: 'budget' };
    }
    await assert.rejects(P.polish(1, [{ text: 'x', confidence: 1 }], '', bad as never), /budget/);
  });
});
