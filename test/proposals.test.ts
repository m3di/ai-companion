import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addProposalEvidence,
  amendDesignProposal,
  createDesignProposal,
  getDesignProposal,
  listDesignProposals,
  mergeDesignProposals,
  setDesignProposalStatus,
} from '../src/db.js';
import { decideProposal, landProposal, renderProposal, verifyLandedProposals, writeIdeaMeasured } from '../src/proposals.js';

/**
 * THE PROPOSAL CHANNEL. One row is the home; evidence accrues on it; a
 * perspective that moves is an amend row, not an overwrite; only a decision
 * moves it past open, and the decision writes the Charter's table; a landed
 * row is verified by its own command, not by anyone re-reading it.
 */

const charter = join(mkdtempSync(join(tmpdir(), 'charter-')), 'CHARTER.md');
writeFileSync(charter, '# C\n\n## Ideas measured\n\n| date | idea | verdict |\n|---|---|---|\n| 2026-08-01 | first | **Accepted.** |\n\n## Changelog\n\n- x\n');

describe('design proposals', () => {
  it('open → evidence → amend keeps a trail', () => {
    const id = createDesignProposal({ title: 'A ledger for checks', problem: 'woken 12× a morning', actor: 'day' });
    addProposalEvidence({ proposalId: id, actor: 'day', kind: 'message', ref: 'msg#14320', text: 'morning routine no longer works' });
    assert.equal(amendDesignProposal(id, { appendBody: '## Amendment\nkill the morning dump' }, 'day', 'the chat added this'), true);
    const p = getDesignProposal(id)!;
    assert.match(p.body, /kill the morning dump/);
    assert.equal(p.evidence.length, 2);
    assert.equal(p.evidence[1]!.kind, 'amend');
    assert.equal(p.evidence_count, 2);
    assert.match(renderProposal(id)!, /msg#14320/);
  });

  it('a decision writes the Charter table and only an open row can be decided', () => {
    const id = createDesignProposal({ title: 'Thing', problem: 'p', actor: 'night' });
    const r = decideProposal(id, 'accepted', { invariant: 'I9', milestone: 'M3', deletes: 'the hash-diff wake', measure: 'deferrals/day' }, 'worth it', { charterPath: charter });
    assert.deepEqual(r, { ok: true, charter: true });
    const rows = readFileSync(charter, 'utf8').split('\n');
    const i = rows.findIndex((l) => l.includes('Thing (proposal #'));
    assert.ok(i > 0, 'row appended');
    assert.match(rows[i]!, /Accepted → M3/);
    assert.equal(rows[i + 1], '', 'row sits inside the table, before the blank line');
    assert.equal(getDesignProposal(id)!.status, 'accepted');
    assert.equal(decideProposal(id, 'rejected', { invariant: '', milestone: '', deletes: '', measure: '' }, 'again', { charterPath: charter }).ok, false);
  });

  it('writeIdeaMeasured refuses a file without the table', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'nochar-')), 'x.md');
    writeFileSync(p, '# nothing\n');
    assert.equal(writeIdeaMeasured('2026-10-30', 'i', 'v', p), false);
  });

  it('land needs accepted; verify runs the check and promotes to verified', async () => {
    const id = createDesignProposal({ title: 'Verifiable', problem: 'p', verify: 'ls package.json', actor: 'day' });
    assert.equal(landProposal(id, 'abc123'), false, 'open cannot land');
    setDesignProposalStatus(id, 'accepted');
    assert.equal(landProposal(id, 'abc123'), true);
    const res = await verifyLandedProposals();
    const mine = res.find((r) => r.p.id === id)!;
    assert.equal(mine.verdict, 'shipped');
    assert.equal(getDesignProposal(id)!.status, 'verified');
    assert.equal(getDesignProposal(id)!.landed_ref, 'abc123');
  });

  it('a landed row with no verify is unfalsifiable, not shipped', async () => {
    const id = createDesignProposal({ title: 'Blind', problem: 'p', actor: 'day' });
    setDesignProposalStatus(id, 'accepted');
    landProposal(id, 'def');
    const mine = (await verifyLandedProposals()).find((r) => r.p.id === id)!;
    assert.equal(mine.verdict, 'unfalsifiable');
    assert.equal(getDesignProposal(id)!.status, 'landed');
  });

  it('merge moves evidence and closes the source', () => {
    const a = createDesignProposal({ title: 'Dup A', problem: 'p', actor: 'day' });
    const b = createDesignProposal({ title: 'Dup B', problem: 'p', actor: 'night' });
    addProposalEvidence({ proposalId: a, actor: 'day', kind: 'note', text: 'from a' });
    assert.equal(mergeDesignProposals(a, b, 'night', 'same thing'), true);
    const B = getDesignProposal(b)!;
    assert.equal(getDesignProposal(a)!.status, 'merged');
    assert.equal(getDesignProposal(a)!.merged_into, b);
    assert.ok(B.evidence.some((e) => e.text === 'from a'));
    assert.ok(B.evidence.some((e) => e.kind === 'amend' && e.ref === `merged #${a}`));
    assert.equal(mergeDesignProposals(a, b, 'night', 'twice'), false);
    assert.ok(!listDesignProposals().some((p) => p.id === a), 'merged rows are not listed as open');
  });
});
