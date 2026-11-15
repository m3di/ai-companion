import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorOwnedElsewhere, dedupeEpisodes, episodeById, episodesByProject, upsertEpisode, markEpisodeDistilled } from '../src/db.js';
import { newLoops, recapLoops } from '../src/distill.js';

/**
 * DESIGN PROPOSAL #2 — the distiller re-emitted the same open loops every
 * pass. Root cause: two forked transcripts share an episode anchor; the
 * dedupe's tie-break preferred the NEWEST row id, so each harvest re-inserted
 * the loser (fresh id, distilled_at NULL), it was summarised again as new
 * work, and the distilled twin was deleted. Three rules close it: the tie
 * goes to the distilled row, a copy that is owned elsewhere is never inserted,
 * and a re-summary hands over only loops the previous summary did not.
 */

const base = {
  project: 'kube', cwd: '/Users/x/Projects/kube', gitBranch: null,
  startedAt: '2026-11-01 10:00:00', endedAt: '2026-11-01 11:00:00', turns: 8, userPrompts: 3,
  tools: {}, files: [], milestones: [], entities: [], title: null, skeleton: 'x', closed: true,
  distillable: true, foldable: true,
};

describe('episodes: a fork never resurrects a distilled twin (proposal #2)', () => {
  it('the dedupe tie goes to the distilled row, not the newest id', () => {
    upsertEpisode({ ...base, sessionId: 'fork-parent', seq: 0, anchor: 'anchor-A' });
    const parent = episodeById_('fork-parent');
    markEpisodeDistilled(parent.id, JSON.stringify({ headline: 'h', openLoops: ['PR #36 unmerged'] }));
    upsertEpisode({ ...base, sessionId: 'fork-child', seq: 0, anchor: 'anchor-A' });
    assert.equal(dedupeEpisodes(), 1);
    assert.ok(episodeById(parent.id), 'the distilled parent survived');
    assert.equal(episodeById_('fork-child', true), undefined, 'the fresh copy was the one removed');
  });

  it('a copy owned by another transcript is never inserted — ownership sticks', () => {
    assert.equal(anchorOwnedElsewhere('anchor-A', 'fork-child'), true);
    assert.equal(anchorOwnedElsewhere('anchor-A', 'fork-parent'), false, 'its own row is not "elsewhere"');
    assert.equal(anchorOwnedElsewhere('anchor-none', 'fork-child'), false);
    assert.equal(anchorOwnedElsewhere(null, 'fork-child'), false);
  });
});

describe('distill: a re-summary hands over only new loops', () => {
  it('drops loops the previous recap already handed over, modulo case and punctuation', () => {
    const prev = recapLoops(JSON.stringify({ headline: 'h', openLoops: ['namespace-lister PR (#36) not opened', 'Flux PAT unrevoked'], followUp: 'ask Amin' }));
    assert.deepEqual(prev, ['namespace-lister PR (#36) not opened', 'Flux PAT unrevoked', 'ask Amin']);
    const next = ['Namespace-lister PR #36 not opened.', 'flux PAT unrevoked', 'admin certs not revocable', 'Ask Amin'];
    assert.deepEqual(newLoops(prev, next), ['admin certs not revocable']);
  });
  it('a first summary hands over everything, once', () => {
    assert.deepEqual(newLoops(recapLoops(null), ['a', 'A', 'b']), ['a', 'b']);
    assert.deepEqual(recapLoops('not json'), []);
  });
});

function episodeById_(sessionId: string, allowMissing = false) {
  const row = episodesByProject('kube', 50).find((r) => r.session_id === sessionId && r.seq === 0);
  if (!row && !allowMissing) throw new Error(`no episode for ${sessionId}`);
  return row as NonNullable<typeof row>;
}
