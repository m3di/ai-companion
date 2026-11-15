import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * SILENCE → DORMANT. A temporary knowledge tree, because this step WRITES the
 * graph; the snapshot DB carries the ask ledger. The contract: a plan asked
 * about SILENCE_ASKS times with no goal is parked exactly once, an answered
 * one never is, and reading a parked plan cues a revival, not a re-park.
 */

const dir = mkdtempSync(join(tmpdir(), 'kb-silence-'));
process.env.KNOWLEDGE_DIR = dir;

type Silence = typeof import('../src/silence.js');
type Touch = typeof import('../src/touch.js');
type Db = typeof import('../src/db.js');
type Ents = typeof import('../src/entities.js');
let parkUnanswered: Silence['parkUnanswered'];
let touchNudges: Touch['touchNudges'];
let recordPacketDecision: Db['recordPacketDecision'];
let notePacketNudge: Db['notePacketNudge'];
let loadGraph: Ents['loadGraph'];

const row = (o: Record<string, unknown>) => JSON.stringify({ aka: [], facts: ['x'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'], ...o });

before(async () => {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  mkdirSync(join(dir, 'people'), { recursive: true });
  writeFileSync(join(dir, 'people', 'entities.jsonl'), row({ id: 'people/mehdi', kind: 'person', facts: ['the operator'] }) + '\n');
  writeFileSync(
    join(dir, 'demo', 'entities.jsonl'),
    [
      row({ id: 'demo/outcome', kind: 'project', goal: true }),
      row({ id: 'demo/answered', kind: 'task', status: 'open', edges: { 'part-of': ['demo/outcome'] } }),
      row({ id: 'demo/silent', kind: 'process', actor: 'mehdi', edges: { 'relates-to': ['demo/outcome'] } }),
      row({ id: 'demo/fresh', kind: 'task', status: 'open', edges: { 'relates-to': ['demo/outcome'] } }),
    ].join('\n') + '\n',
  );
  ({ parkUnanswered } = await import('../src/silence.js'));
  ({ touchNudges } = await import('../src/touch.js'));
  ({ recordPacketDecision, notePacketNudge } = await import('../src/db.js'));
  ({ loadGraph } = await import('../src/entities.js'));
});

describe('silence → dormant', () => {
  it('parks a plan asked about enough times with no answer, once, and leaves the rest alone', () => {
    const ask = (id: string, n: number) => {
      const rid = recordPacketDecision({ code: 'W213', entity_id: id, decision: 'unknown', reason: 'test', evidence: 'msg#1', actor: 'test' });
      for (let i = 0; i < n; i++) notePacketNudge(rid);
    };
    ask('demo/silent', 3);
    ask('demo/fresh', 1);
    ask('demo/answered', 5); // reaches a goal now — the question was answered
    const parked = parkUnanswered({ threshold: 3, actor: 'test' });
    assert.deepEqual(parked.map((p) => p.id), ['demo/silent']);
    assert.equal(parked[0]!.asked, 3);
    const g = loadGraph();
    assert.equal(g.entities.get('demo/silent')!.dormant, true);
    assert.equal(g.entities.get('demo/silent')!.actor, undefined);
    assert.equal(g.entities.get('demo/fresh')!.dormant, false);
    assert.equal(g.entities.get('demo/answered')!.dormant, false);
    assert.deepEqual(parkUnanswered({ threshold: 3, actor: 'test' }), [], 'parked twice');
  });

  it('cues a revival, not a question, when the concierge reads a parked plan', () => {
    const lines = touchNudges('1:-1', ['demo/silent']);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /was PARKED by the night/);
    assert.match(lines[0]!, /dormant:false/);
    assert.deepEqual(touchNudges('1:-1', ['demo/silent']), [], 'cued twice in a day');
  });
});
