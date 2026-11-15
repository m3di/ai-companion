import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recordPacketDecision } from '../src/db.js';
import { loadGraph } from '../src/entities.js';
import { lintGraph } from '../src/graphLint.js';
import { openGoalQuestions, touchNudges } from '../src/touch.js';

/**
 * THE TOUCH-WATCH'S CONTRACT: the cue rides on a read, only the concierge sees
 * it, at most once a day, and never for a question that has since been
 * answered. Runs against the snapshot DB and the live graph, and picks any
 * orphan plan W213 currently reports; if there is none, there is nothing to
 * ask and the test says so by passing.
 */

const CONCIERGE = '121628633:-1';

describe('the touch-watch', () => {
  const orphan = lintGraph().findings.find((f) => f.code === 'W213')?.id;

  it('cues the concierge once when it reads a plan with an unknown goal, and not again the same day', () => {
    if (!orphan) return;
    const g = loadGraph();
    recordPacketDecision({ code: 'W213', entity_id: orphan, decision: 'unknown', reason: 'test: chain names no outcome', evidence: g.entities.get(orphan)!.chain.join(','), actor: 'test' });
    assert.ok(openGoalQuestions().some((d) => d.entity_id === orphan));
    const first = touchNudges(CONCIERGE, ['people/mehdi', orphan]);
    assert.equal(first.length, 1);
    assert.match(first[0]!, /no goal above it/);
    assert.match(first[0]!, /If it is not live, say nothing/);
    assert.deepEqual(touchNudges(CONCIERGE, [orphan]), [], 'cued twice within a day');
    assert.equal(touchNudges(CONCIERGE, [orphan], Date.now() + 25 * 3_600_000).length, 1, 'a day later the cue returns');
    assert.match(touchNudges(CONCIERGE, [orphan], Date.now() + 50 * 3_600_000)[0]!, /raised it 2× before/);
  });

  it('cues nobody but the concierge, and nothing for an untouched node', () => {
    if (!orphan) return;
    assert.deepEqual(touchNudges('nightly', [orphan]), []);
    assert.deepEqual(touchNudges('debug-agent', [orphan]), []);
    assert.deepEqual(touchNudges('121628633:3', [orphan]), [], 'a worker cannot ask Mehdi anything');
    assert.deepEqual(touchNudges(CONCIERGE, []), []);
    assert.deepEqual(touchNudges(CONCIERGE, ['people/mehdi']), []);
  });
});
