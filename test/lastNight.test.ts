import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../src/config.js';
import { recentDreams, saveDream } from '../src/db.js';
import { lastNightBlock } from '../src/operator.js';

/**
 * THE NIGHT'S PROMISES TO ITSELF.
 *
 * Every pass ends by narrating what it did and, over and over, what it INTENDS:
 * "I'll skip these eight edges tonight", "compress it on the next pass", "keep
 * an eye on that". Reading three nights of real reports back, those lines are
 * everywhere — and until now not one of them reached the next pass. The digest
 * carried root, the graph, the focus set, the inbox, the events and the
 * timeline; the report went to Telegram and the journal, both read by a human
 * and by nothing else. So the night could form an intention nightly and act on
 * one never.
 *
 * The block is deliberately ONE report, framed as a reconciliation rather than
 * a recap — an intention gets one night on prose and then has to become a focus
 * item, a commitment or a graph fact to survive a second. Handing over a week
 * of reports would make the night's own prose a store it answers to, which is
 * the failure root.md already had (I1).
 */

const chatId = [...config.allowedChatIds][0] ?? 0;

describe("the night reads its own last report", () => {
  it('carries the report body, so a promise in it is visible at all', () => {
    const [last] = recentDreams(chatId, 1);
    if (!last) return; // a database with no dreams yet has nothing to assert
    const block = lastNightBlock(chatId);
    assert.match(block, new RegExp(`night #${last.id}`), 'the block did not name the report it carries');
    // The distinguishing content, not just the header: the bug being fixed was
    // that the body reached the next pass nowhere.
    const probe = last.report.replace(/\s+/g, ' ').slice(0, 60).trim();
    assert.ok(
      block.replace(/\s+/g, ' ').includes(probe),
      'the block named a report it did not actually include',
    );
  });

  it('asks for a verdict on every forward-looking line, not a summary', () => {
    const [last] = recentDreams(chatId, 1);
    if (!last) return;
    const block = lastNightBlock(chatId);
    // The framing IS the feature. Carrying the text without the three-way
    // reconciliation would just be narrative continuity, which is what makes
    // prose a store instead of a funnel.
    assert.match(block, /ALREADY DURABLE/);
    assert.match(block, /STILL WORTH DOING/);
    assert.match(block, /NO LONGER WORTH DOING/);
    assert.match(block, /last time it will be shown to you/i);
  });

  it('is empty rather than fabricated when there is no previous night', () => {
    // A chat with no history must not be handed an invented report to
    // reconcile against — the first pass of a fresh instance has no promises.
    assert.equal(lastNightBlock(-999_999), '');
  });

  it('caps a runaway report instead of eating the window', () => {
    // Reports run ~6k chars; nothing stops a pass writing 60k, and the digest
    // already carries root, the graph, the inbox and the timeline.
    const huge = 'x'.repeat(20_000);
    saveDream(-424_242, huge, '1970-01-01 00:00:00', '1970-01-02 00:00:00');
    const block = lastNightBlock(-424_242);
    assert.ok(block.length < 12_000, `the block grew to ${block.length} chars`);
    assert.match(block, /\[cut \d+ chars\]/, 'it truncated without saying so');
  });
});
