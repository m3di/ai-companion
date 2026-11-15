import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * DRILL-THROUGH (round 11, P2).
 *
 * The story's bet is that a NAMED pointer gets followed where an open-ended
 * query does not, and a bet needs a number: `story_followed` counts, per
 * retrieval episode, the DISTINCT reached refs the story had on offer at that
 * moment — deduped like the refs column, so their ratio stays ≤ 1.
 * The properties pinned here:
 *   - THE OFFERED SET IS WHAT WAS SHOWN. `storyRefs()` is exactly the [[refs]]
 *     in the INJECTED level-0 block that resolve to graph ENTITIES, plus the
 *     story-node id of every domain the block points at (readStory is the
 *     follow the pointer line names). A ref that lives only deeper in a domain
 *     story never enters it — the first version counted every ref in every
 *     story, 113 of 169 entities, and could not lose.
 *   - A FOLLOW IS COUNTED, A SPONTANEOUS REACH IS NOT. Only refs in the
 *     offered set bump the counter, only inside an open episode.
 *   - THE NUMBER SURVIVES SCORING. Closing an episode derives its outcome and
 *     keeps `story_followed`, so the window tally can split follows by how
 *     they ended — the half that keeps a bait-y story honest.
 *
 * Own tree AND own database, like storyTree.test.ts and for the same reason:
 * the suite runs files in parallel against one scratch DB, and assertions on
 * shared rows are timing, not truth.
 */

const dir = mkdtempSync(join(tmpdir(), 'kb-follow-'));
process.env.KNOWLEDGE_DIR = dir;
process.env.DB_PATH = join(dir, 'follow-test.db');
// A module tree of this file's own, inside the repo so a module resolves the
// shim by walking up to node_modules (the modules.test.ts precedent).
mkdirSync(resolve('data/tmp'), { recursive: true });
const modRoot = mkdtempSync(join(resolve('data/tmp'), 'follow-mod-'));
process.env.MODULES_DIR = modRoot;
after(() => rmSync(modRoot, { recursive: true, force: true }));

type Story = typeof import('../src/storyTree.js');
type Db = typeof import('../src/db.js');
type Mod = typeof import('../src/modules.js');
let S: Story;
let D: Db;
let M: Mod;

const alpha = {
  id: 'demo/alpha',
  kind: 'system',
  aka: [],
  facts: ['alpha exists'],
  edges: {},
  status: 'n/a',
  dormant: false,
  goal: false,
  chain: ['msg#1'],
};
const beta = { id: 'demo/beta', kind: 'component', aka: [], facts: ['beta exists'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#2'] };

before(async () => {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  writeFileSync(join(dir, 'demo', 'entities.jsonl'), `${JSON.stringify(alpha)}\n${JSON.stringify(beta)}\n`);
  writeFileSync(join(dir, 'root.md'), '# root\n\n## Now\n- volatile\n');
  // The echo module: hands back whatever id it was given, so the seam's ref
  // extraction sees exactly the entity we planted.
  mkdirSync(join(modRoot, 'probe'), { recursive: true });
  writeFileSync(
    join(modRoot, 'probe', 'index.ts'),
    '/** Echo an id back. Exists to prove the follow seam, nothing more. */\nexport function hit(id: string): string {\n  return id;\n}\n',
  );
  writeFileSync(join(modRoot, 'probe', 'index.test.ts'), "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  S = await import('../src/storyTree.js');
  D = await import('../src/db.js');
  M = await import('../src/modules.js');
  // The derived entity index is what storyRefs() resolves against; parse once
  // so the fixtures exist there (loadGraph writes it as a side effect).
  (await import('../src/entities.js')).loadGraph();
});

describe('the offered set is what the injected block shows', () => {
  it('collects entity refs from the block, the listed domain ids, and nothing dangling', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'alpha exists [[demo/alpha]], see also [[demo/ghost]].');
    S.invalidateStoryRefs();
    const offered = S.storyRefs();
    assert.ok(offered.has('demo/alpha'), 'an injected entity ref is missing');
    assert.ok(offered.has('domain:demo'), 'the pointed-at domain id is missing — readStory("demo") must count as a follow');
    assert.ok(!offered.has('demo/ghost'), 'a dangling ref leaked into the offered set');
  });

  it('offers only what the pointer line carries — a ref deeper in the story is not on offer', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'alpha exists [[demo/alpha]]. Beta is the deeper fact [[demo/beta]].');
    S.invalidateStoryRefs();
    const offered = S.storyRefs();
    assert.ok(offered.has('demo/alpha'), 'the first-sentence ref is missing');
    assert.ok(!offered.has('demo/beta'), 'a ref the day was never shown counted as offered');
  });

  it('a rewrite through applyStoryRewrite refreshes the set without waiting out the TTL', () => {
    S.ensureStoryNodes();
    const r = S.applyStoryRewrite(S.storyNodeId('demo'), 'now about beta [[demo/beta]]');
    assert.equal(r.ok, true, r.problem);
    assert.ok(S.storyRefs().has('demo/beta'), 'the offered set is stale after a same-process rewrite');
    assert.ok(!S.storyRefs().has('demo/alpha'), 'a dropped ref survived in the offered set');
  });
});

describe('a follow is counted and a spontaneous reach is not', () => {
  it('bumps story_followed only for offered refs, only inside an open episode', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'alpha [[demo/alpha]]');
    S.invalidateStoryRefs();
    const offered = S.storyRefs();

    // No open episode: a no-op — proven below, when this key's episode opens
    // AFTER the call and must start at zero.
    D.noteStoryFollowed('follow-nobody', ['demo/alpha']);
    const nobodyId = D.openRetrievalEpisode('follow-nobody', 'day', 'too late');
    const nobody = D.recentRetrievalEpisodes(10).find((e) => e.id === nobodyId);
    assert.equal(nobody?.story_followed, 0, 'a follow noted outside any episode landed on a later one');

    const id = D.openRetrievalEpisode('follow-key', 'day', 'which alpha?');
    // The seam's arithmetic, without a live module host: the caller filters
    // against the offered set and hands over the list BEFORE the refs land
    // (the dedupe reads recorded refs as already-scored).
    const reached = ['demo/alpha', 'demo/beta'];
    D.noteStoryFollowed('follow-key', reached.filter((r) => offered.has(r)));
    D.noteRetrievalStep('follow-key', 'find', 5, reached);
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.story_followed, 1, 'exactly one of the two reached refs was on offer');
  });

  it('counts a ref once per episode, however many calls reach it', () => {
    const id = D.openRetrievalEpisode('follow-dedupe', 'day', 'same ref thrice');
    for (const fn of ['find', 'graph', 'history']) {
      // The seam's order per call: count against pre-state, then record.
      D.noteStoryFollowed('follow-dedupe', ['demo/alpha']);
      D.noteRetrievalStep('follow-dedupe', fn, 1, ['demo/alpha']);
    }
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.story_followed, 1, 'three calls on one offered ref must score one follow');
    assert.equal((JSON.parse(row!.refs) as string[]).length, 1, 'refs itself stays deduped');
  });

  it('readStory is a graph step and a STORY READ — counted apart from entity follows', async () => {
    const F = await import('../src/friction.js');
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'alpha [[demo/alpha]]');
    S.invalidateStoryRefs();
    assert.deepEqual(F.storyStepOf('mcp__bot__readStory', { scope: 'demo' }), ['domain:demo']);
    assert.deepEqual(F.storyStepOf('mcp__bot__readStory', { scope: 'domain:demo' }), ['domain:demo']);
    assert.equal(F.storyStepOf('mcp__bot__readNote', { key: 'demo' }), undefined);
    const id = D.openRetrievalEpisode('follow-story', 'day', 'what is demo?');
    F.noteToolCall('follow-story', 'mcp__bot__readStory', { scope: 'demo' });
    D.closeRetrievalEpisode('follow-story');
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.path, 'readStory', 'readStory did not land on the episode path as a graph step');
    assert.deepEqual(JSON.parse(row!.refs), ['domain:demo'], 'the opened story is not on the episode refs');
    assert.equal(row?.story_read, 1, 'opening the story the block pointed at is a story read');
    assert.equal(row?.story_followed, 0, 'a story read must not count as an entity follow — the door cannot prove the thesis');
    assert.equal(row?.outcome, 'answered', 'a story read must score as a graph reach, not a tree read');
  });

  it('a refused readStory — typo, or a domain not yet narrated — is no step and no ref', async () => {
    const F = await import('../src/friction.js');
    S.ensureStoryNodes();
    D.ensureStoryNode(S.storyNodeId('zz-unwritten'), S.STORY_ROOT_ID, 'zz-unwritten');
    assert.equal(F.storyStepOf('mcp__bot__readStory', { scope: 'typo' }), undefined, 'an unknown scope scored as a reach');
    assert.equal(F.storyStepOf('mcp__bot__readStory', { scope: 'zz-unwritten' }), undefined, 'an unwritten story scored as a reach');
    const id = D.openRetrievalEpisode('follow-typo', 'day', 'what is typo?');
    F.noteToolCall('follow-typo', 'mcp__bot__readStory', { scope: 'typo' });
    D.closeRetrievalEpisode('follow-typo');
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.steps, 0, 'a refused read landed on the episode as a step');
    assert.equal(row?.story_read, 0, 'a refused read counted as a story read');
    assert.equal(row?.outcome, 'no-reach', 'a refused read must not score the episode answered');
    D.deleteStoryNode(S.storyNodeId('zz-unwritten'));
  });

  it('keeps story_followed through closeRetrievalEpisode and its outcome scoring', () => {
    const id = D.openRetrievalEpisode('follow-close', 'day', 'still counted?');
    D.noteStoryFollowed('follow-close', ['demo/alpha']);
    D.noteRetrievalStep('follow-close', 'find', 1, ['demo/alpha']);
    D.closeRetrievalEpisode('follow-close');
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.outcome, 'answered');
    assert.equal(row?.story_followed, 1, 'scoring the episode lost the follow count');
  });
});

describe('the live seam counts follows, and its guards hold', () => {
  it('callModule inside an open day episode scores the follow', async () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'alpha [[demo/alpha]]');
    S.invalidateStoryRefs();
    const id = D.openRetrievalEpisode('seam-day', 'day', 'via the module host');
    const r = await M.callModule('probe', 'hit', ['demo/alpha'], 'seam-day');
    assert.equal(r.ok, true, `the probe module did not run: ${r.error}`);
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.story_followed, 1, 'deleting countStoryFollows from the call path breaks here');
  });

  it('evalInModule inside an open day episode scores the follow', async () => {
    const id = D.openRetrievalEpisode('seam-eval', 'day', 'via eval');
    const r = await M.evalInModule('probe', "m.hit('demo/alpha')", 'seam-eval');
    assert.equal(r.ok, true, `the probe eval did not run: ${r.error}`);
    const row = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(row?.story_followed, 1, 'deleting countStoryFollows from the eval path breaks here');
  });

  it('a readOnly caller and a caller outside any episode bump nothing', async () => {
    const id = D.openRetrievalEpisode('seam-ro', 'day', 'read-only caller');
    const ro = await M.callModule('probe', 'hit', ['demo/alpha'], 'seam-ro', undefined, true);
    assert.equal(ro.ok, true, `read-only probe did not run: ${ro.error}`);
    const roRow = D.recentRetrievalEpisodes(10).find((e) => e.id === id);
    assert.equal(roRow?.story_followed, 0, 'a readOnly caller must not be scored (nor build the set)');

    // 'atlas' has no open episode — the guard returns before the offered set.
    const before1 = D.recentRetrievalEpisodes(10);
    const at = await M.callModule('probe', 'hit', ['demo/alpha'], 'atlas');
    assert.equal(at.ok, true);
    assert.deepEqual(
      D.recentRetrievalEpisodes(10).map((e) => [e.id, e.story_followed]),
      before1.map((e) => [e.id, e.story_followed]),
      'a caller outside any episode changed a follow count',
    );
  });
});

describe('the window tally splits follows by how they ended', () => {
  it('counts reached, followed, and the downstream outcome of the follows', () => {
    // Deltas against whatever this file's earlier cases left in the shared DB
    // — an absolute count here would assert on its siblings, not on the tally.
    const base = D.storyFollowTally('1970-01-01 00:00:00', '2999-01-01 00:00:00');

    // A followed question that answered, a reach that followed nothing, and a
    // followed question that still ended in a bypass — the bait-y case.
    D.openRetrievalEpisode('tally-a', 'day', 'a');
    D.noteStoryFollowed('tally-a', ['demo/alpha']);
    D.noteRetrievalStep('tally-a', 'find', 1, ['demo/alpha']);
    D.closeRetrievalEpisode('tally-a');

    D.openRetrievalEpisode('tally-b', 'day', 'b');
    D.noteRetrievalStep('tally-b', 'search', 1, []);
    D.closeRetrievalEpisode('tally-b');

    D.openRetrievalEpisode('tally-c', 'worker', 'c');
    D.noteStoryFollowed('tally-c', ['demo/alpha']);
    D.noteRetrievalStep('tally-c', 'find', 1, ['demo/alpha']);
    D.noteRetrievalBypass('tally-c');
    D.closeRetrievalEpisode('tally-c');

    // A story READ is the other way of taking a pointer: its own number, and
    // it joins the downstream split.
    D.openRetrievalEpisode('tally-d', 'day', 'd');
    D.noteStoryRead('tally-d');
    D.noteRetrievalStep('tally-d', 'readStory', 1, ['domain:demo']);
    D.closeRetrievalEpisode('tally-d');

    // The night's episodes stay out of a DAY drill-through number.
    D.openRetrievalEpisode('tally-night', 'night', 'n');
    D.noteStoryFollowed('tally-night', ['demo/alpha']);
    D.noteRetrievalStep('tally-night', 'find', 1, ['demo/alpha']);
    D.closeRetrievalEpisode('tally-night');

    const t = D.storyFollowTally('1970-01-01 00:00:00', '2999-01-01 00:00:00');
    assert.equal(t.reached - base.reached, 4, 'the four graph-reaching day/worker episodes were not counted');
    assert.equal(t.storyReads - base.storyReads, 1, 'the story read was not counted apart');
    assert.equal(t.answered - base.answered, 2, 'the entity follow and the story read that answered were not split out');
    assert.equal(t.bypassed - base.bypassed, 1, 'the follow that still bypassed was not split out');
    const nightRows = D.recentRetrievalEpisodes(20).filter((e) => e.actor === 'night' && e.story_followed > 0);
    assert.ok(nightRows.length >= 1, 'fixture: the night row exists');
    // followed counts only day+worker: the night's follow must not appear.
    assert.equal(t.followed - base.followed, 2, 'a night episode leaked into the day drill-through tally');
  });

  it('respects the window bounds — an episode before `from` is not counted', () => {
    const id = D.openRetrievalEpisode('tally-old', 'day', 'ancient history');
    D.noteStoryFollowed('tally-old', ['demo/alpha']);
    D.noteRetrievalStep('tally-old', 'find', 1, ['demo/alpha']);
    D.closeRetrievalEpisode('tally-old');
    // Age the row from outside — dbNow() is the only clock the API offers.
    const raw = new Database(process.env.DB_PATH!);
    raw.prepare("UPDATE retrieval_episodes SET started_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    raw.close();
    const t = D.storyFollowTally('2001-01-01 00:00:00', '2999-01-01 00:00:00');
    const old = D.storyFollowTally('1999-01-01 00:00:00', '2999-01-01 00:00:00');
    assert.equal(old.followed - t.followed, 1, 'the aged episode must count only when `from` reaches back to it');
  });
});
