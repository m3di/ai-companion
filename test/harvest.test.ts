import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { harvestable, segmentFile } from '../src/harvest.js';

/**
 * WHO DROVE THE SESSION. A transcript under ~/.claude/projects is either Mehdi
 * at a terminal (`entrypoint: cli` / `claude-desktop`) or a program calling the
 * Agent SDK (`sdk-ts`, `sdk-py`, …) — the bot's own fleet, storysim's
 * simulator. Only the first is his work. The boundary is by entrypoint, not by
 * project, so a repo he both develops in AND runs simulations from keeps the
 * development and loses the simulation without a per-project list.
 */

const dir = mkdtempSync(join(tmpdir(), 'harvest-'));

function transcript(name: string, entrypoint: string | undefined, cwd = '/Users/x/Projects/storysim'): string {
  const base = { cwd, sessionId: name, ...(entrypoint ? { entrypoint } : {}) };
  const t0 = Date.parse('2026-10-30T10:00:00Z');
  const lines = [
    { ...base, type: 'user', uuid: 'u1', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'simulate scene 3 from the cards' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: new Date(t0 + 30_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Running the scene.' }] } },
    { ...base, type: 'user', uuid: 'u2', timestamp: new Date(t0 + 90_000).toISOString(), message: { role: 'user', content: 'again, colder' } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: new Date(t0 + 120_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

describe('harvest: who drove the session', () => {
  it('segmentFile carries the entrypoint, null when the transcript predates it', () => {
    const [sdk] = segmentFile(transcript('sdk', 'sdk-ts'));
    const [typed] = segmentFile(transcript('typed', 'cli'));
    const [old] = segmentFile(transcript('old', undefined));
    assert.equal(sdk?.entrypoint, 'sdk-ts');
    assert.equal(typed?.entrypoint, 'cli');
    assert.equal(old?.entrypoint, null);
    assert.equal(sdk?.project, 'storysim');
  });

  it('an SDK-driven episode is not harvested; a typed one in the same project is', () => {
    const kb = '/nowhere/knowledge';
    assert.equal(harvestable({ cwd: '/Users/x/Projects/storysim', project: 'storysim', entrypoint: 'sdk-ts' }, kb), false);
    assert.equal(harvestable({ cwd: '/Users/x/Projects/storysim', project: 'storysim', entrypoint: 'sdk-py' }, kb), false);
    assert.equal(harvestable({ cwd: '/Users/x/Projects/storysim', project: 'storysim', entrypoint: 'cli' }, kb), true);
    assert.equal(harvestable({ cwd: '/Users/x/Projects/storysim', project: 'storysim', entrypoint: 'claude-desktop' }, kb), true);
  });

  it('no entrypoint means typed — the failure to avoid is dropping HIS work', () => {
    assert.equal(harvestable({ cwd: '/Users/x/Projects/kube', project: 'kube', entrypoint: null }, '/nowhere'), true);
  });

  it('the older boundaries still hold: the knowledge dir and the do-not-watch projects', () => {
    assert.equal(harvestable({ cwd: '/kb/root', project: 'root', entrypoint: 'cli' }, '/kb'), false);
    assert.equal(harvestable({ cwd: '/Users/x/Projects/ai-companion', project: 'ai-companion', entrypoint: 'cli' }, '/kb'), false);
  });
});
