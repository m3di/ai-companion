import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import {
  closeRetrievalEpisode,
  noteRetrievalBypass,
  noteRetrievalRefs,
  noteRetrievalStep,
  noteRetrievalTreeStep,
  openRetrievalEpisode,
  retrievalPaths,
} from '../src/db.js';
import { graphStepOf, treeStepOf } from '../src/friction.js';

/**
 * THE QUESTION IS THE UNIT (M4).
 *
 * `module_use` has counted calls since round 9 and cannot answer the question
 * M9 needs answered: it aggregates by shape and discards ordering, grouping and
 * outcome. It can say "find was called 7 times". It cannot say "answering
 * what-is-Mehdi-working-on took find → neighbours → find, and then the agent
 * gave up and read root.md".
 *
 * Three properties, and the third is the one that makes the log worth keeping:
 *
 *   1. The path is ORDERED. `find→neighbours` is the recurring shape M9
 *      collapses into one call; a bag of steps names nothing.
 *   2. It closes on EVERY exit, including a turn that threw. An episode log
 *      that only records successes reports the happy path as the workload.
 *   3. Give-up outranks cost. A question answered in six steps is expensive; a
 *      question that ended in a bypass means the structure is missing
 *      something, and those must not sort together.
 *
 * Each test uses its own session key: the open-episode table is keyed by
 * session, the suite runs its files in parallel against one database, and two
 * cases sharing a key would close each other's episodes.
 */

const KEY = (n: string) => `test:episode:${n}`;

beforeEach(() => {
  // A previous case that threw would leave its episode open and silently
  // absorb this one's steps.
  for (const n of ['path', 'giveup', 'noreach', 'reopen']) closeRetrievalEpisode(KEY(n));
});

describe('a retrieval episode', () => {
  it('records the path in the order it was walked', () => {
    openRetrievalEpisode(KEY('path'), 'day', 'what is Mehdi working on?');
    noteRetrievalStep(KEY('path'), 'find');
    noteRetrievalStep(KEY('path'), 'neighbours');
    noteRetrievalStep(KEY('path'), 'openLoops');
    const e = closeRetrievalEpisode(KEY('path'))!;
    assert.equal(e.path, 'find→neighbours→openLoops', 'the order was lost');
    assert.equal(e.steps, 3);
    assert.equal(e.outcome, 'answered');
  });

  it('scores a give-up as bypassed, not as an answer', () => {
    openRetrievalEpisode(KEY('giveup'), 'day', 'what is blocking the release?');
    noteRetrievalStep(KEY('giveup'), 'find');
    noteRetrievalBypass(KEY('giveup')); // the agent read root.md instead
    const e = closeRetrievalEpisode(KEY('giveup'))!;
    assert.equal(e.bypasses, 1);
    assert.equal(e.outcome, 'bypassed', 'a question the graph could not serve counted as served');
  });

  it('tells "never asked" apart from "asked and answered"', () => {
    // The distinction the whole milestone turns on. A turn that needed no
    // memory and a turn that needed it and did not reach are both "0 calls",
    // and only one of them is a problem.
    openRetrievalEpisode(KEY('noreach'), 'day', 'hello');
    const e = closeRetrievalEpisode(KEY('noreach'))!;
    assert.equal(e.outcome, 'no-reach');
    assert.equal(e.steps, 0);
  });

  it('closes a stale episode when a session opens a new one', () => {
    // A turn that threw before its `finally` — or a process that died — must
    // not leave an episode that quietly collects the NEXT turn's steps.
    openRetrievalEpisode(KEY('reopen'), 'day', 'first');
    noteRetrievalStep(KEY('reopen'), 'find');
    openRetrievalEpisode(KEY('reopen'), 'day', 'second');
    noteRetrievalStep(KEY('reopen'), 'search');
    const e = closeRetrievalEpisode(KEY('reopen'))!;
    assert.equal(e.path, 'search', "the second question inherited the first's path");
    assert.equal(e.trigger, 'second');
  });

  it('ignores steps taken outside any episode', () => {
    // A CLI or a probe reads the graph outside a question. Inventing an
    // episode for it would put noise into the workload M9 optimizes against.
    assert.doesNotThrow(() => noteRetrievalStep('test:episode:never-opened', 'find'));
    assert.doesNotThrow(() => noteRetrievalBypass('test:episode:never-opened'));
    assert.equal(closeRetrievalEpisode('test:episode:never-opened'), undefined);
  });

  it('ranks give-up above cost', () => {
    const ranked = retrievalPaths(50);
    const firstBypass = ranked.findIndex((p) => p.bypasses > 0);
    const lastClean = ranked.map((p) => p.bypasses).lastIndexOf(0);
    if (firstBypass !== -1 && lastClean !== -1) {
      assert.ok(firstBypass < lastClean, 'a clean path outranked one that ended in a give-up');
    }
  });
});

/**
 * The step is named by FUNCTION, never by tool. "callModule→callModule" is not
 * a path — it is the same word three times, and it would make every question in
 * the system look identical.
 */
describe('naming the step', () => {
  it('names the function, not the tool', () => {
    assert.equal(graphStepOf('mcp__bot__callModule', { module: 'entities', fn: 'find', args: ['x'] }), 'find');
  });

  it('qualifies a non-default module, so two modules do not collide', () => {
    assert.equal(graphStepOf('mcp__bot__callModule', { module: 'graph', fn: 'stuck' }), 'graph.stuck');
  });

  it('coalesces a composition by the set it touched', () => {
    // The same coalescing `module_use.shape` already does: composition
    // identifies a use far better than wording does, and sorting makes two
    // spellings of one question the same row.
    const s = graphStepOf('mcp__bot__evalInModule', {
      expression: 'm.openLoops(_).length + JSON.stringify((await m.search(_,_)).map(x=>x.id))',
    });
    assert.equal(s, 'openLoops+search');
  });

  it('is undefined for a tool that never touched the graph', () => {
    assert.equal(graphStepOf('Read', { file_path: '/tmp/x' }), undefined);
    assert.equal(graphStepOf('mcp__bot__readFocus', {}), undefined);
  });
});

/**
 * ONE ACTOR, ONE SESSION KEY.
 *
 * The first real night after episodes shipped recorded dream #71's path in
 * full — `health→find→find→unconfirmed→confirm→…`, 11 steps — and attached
 * ZERO entity ids. The pass logged its steps under `${chatId}:operator` and
 * its module calls under `nightly`, so the refs resolved against a session
 * that had no open episode and went nowhere. Both halves worked; they were
 * just not talking about the same thing.
 *
 * Nothing could have caught it in isolation: steps were right, refs were
 * right, and the join between them lived in two string literals in two files.
 * So the test asserts the join, not the halves.
 */
describe('the path and the refs meet in the same episode', () => {
  it('drops refs when the writer uses a different session name', () => {
    const KEY = 'test:episode:join';
    closeRetrievalEpisode(KEY);
    openRetrievalEpisode(KEY, 'night', 'a pass');
    noteRetrievalStep(KEY, 'find');
    // The bug, reproduced exactly: refs offered under the OTHER name.
    noteRetrievalRefs('test:episode:join-but-different', ['core-api/x']);
    const e = closeRetrievalEpisode(KEY)!;
    assert.equal(e.steps, 1, 'the step was lost too');
    assert.equal(e.refs, '[]', 'refs attached across two different session names — the join is not being tested');
  });

  it('keeps them when the name matches, de-duplicated', () => {
    const KEY = 'test:episode:join2';
    closeRetrievalEpisode(KEY);
    openRetrievalEpisode(KEY, 'night', 'a pass');
    noteRetrievalStep(KEY, 'find');
    noteRetrievalRefs(KEY, ['core-api/x', 'people/y']);
    noteRetrievalStep(KEY, 'neighbours');
    noteRetrievalRefs(KEY, ['core-api/x']); // the same node, reached twice
    const e = closeRetrievalEpisode(KEY)!;
    assert.deepEqual(JSON.parse(e.refs), ['core-api/x', 'people/y']);
    assert.equal(e.path, 'find→neighbours');
    assert.equal(e.outcome, 'answered');
  });
});

/**
 * PROSE IS NOT NOTHING (M5).
 *
 * The first real day scored 84 of 86 turns `no-reach` — and hidden inside them
 * were twelve `readNote` calls. Reading the md tree is neither a graph reach
 * nor a bypass: it is the legitimate prose API, and counting it as neither made
 * a turn answered entirely from memory look exactly like a turn that consulted
 * none. The tree/graph split IS M5's question, so one number that cannot
 * separate them cannot say whether convergence is happening.
 */
describe('tree reads are their own outcome', () => {
  it('scores a turn that used only prose as tree-only, not no-reach', () => {
    const KEY = 'test:episode:tree';
    closeRetrievalEpisode(KEY);
    openRetrievalEpisode(KEY, 'day', 'what is the paperwork status?');
    noteRetrievalTreeStep(KEY, 'readNote');
    const e = closeRetrievalEpisode(KEY)!;
    assert.equal(e.steps, 0, 'a tree read must not count as a graph step');
    assert.equal(e.tree, 1);
    assert.equal(e.outcome, 'tree-only', 'prose use was indistinguishable from no memory at all');
  });

  it('prefers the graph when a turn used both', () => {
    const KEY = 'test:episode:both';
    closeRetrievalEpisode(KEY);
    openRetrievalEpisode(KEY, 'day', 'mixed');
    noteRetrievalTreeStep(KEY, 'readNote');
    noteRetrievalStep(KEY, 'find');
    assert.equal(closeRetrievalEpisode(KEY)!.outcome, 'answered');
  });

  it('still ranks a give-up worst, whatever else the turn did', () => {
    const KEY = 'test:episode:giveup2';
    closeRetrievalEpisode(KEY);
    openRetrievalEpisode(KEY, 'day', 'mixed then gave up');
    noteRetrievalTreeStep(KEY, 'readNote');
    noteRetrievalStep(KEY, 'find');
    noteRetrievalBypass(KEY);
    assert.equal(closeRetrievalEpisode(KEY)!.outcome, 'bypassed');
  });

  it('knows which tools are the prose door', () => {
    assert.equal(treeStepOf('mcp__bot__readNote'), 'readNote');
    assert.equal(treeStepOf('mcp__bot__readFocus'), 'readFocus');
    assert.equal(treeStepOf('mcp__bot__callModule'), undefined, 'a graph call was counted as prose');
    assert.equal(treeStepOf('Read'), undefined, 'a raw file read is a BYPASS, not the prose API');
  });
});
