import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * PROSE REACHES THE STORY (round 11, P2c).
 *
 * On 2026-08-25 the concierge saved the boiler repair as a NOTE under
 * `personal/`, and the story tree — which narrates the graph — never noticed:
 * no entity moved, no dirt reached `domain:personal`, and level 0 kept
 * narrating a world the note had already changed. Pinned here:
 *   - A NOTE WRITE DIRTIES ITS DOMAIN'S STORY (and the root above it), exactly
 *     as an entity write does. A note the graph has no domain for mints no
 *     orphan node but is not silent either: the ROOT goes dirty and the key
 *     reaches the night's root material — M1's discovery signal, as prose.
 *   - THE NIGHT IS HANDED THE NOTES with the domain's entities, bounded: past
 *     the cap a note's key still appears, only its excerpt is elided. A domain
 *     with notes and no entities is OFFERED, never mechanically cleared.
 *   - THE CONCIERGE LADDER IS STORY-FIRST. The courier turn ran five
 *     searchMessages before touching the story because the prompt's ladder
 *     listed searchMessages and not the story. Order is the instruction — and
 *     the rung's label (`## The story`) is a heading that exists in the prompt.
 *   - readStory LOGS ITS SCOPE — the courier turn's call landed as a row with
 *     an empty target, and the miss could not be read off the log.
 *
 * Own temp tree and own temp database, as the sibling story tests do.
 */

const dir = mkdtempSync(join(tmpdir(), 'kb-story-notes-'));
process.env.KNOWLEDGE_DIR = dir;
process.env.DB_PATH = join(dir, 'story-notes-test.db');

type Story = typeof import('../src/storyTree.js');
type Db = typeof import('../src/db.js');
type Kb = typeof import('../src/knowledge.js');
type Fr = typeof import('../src/friction.js');
type Cg = typeof import('../src/concierge.js');
let S: Story;
let D: Db;
let K: Kb;
let F: Fr;
let C: Cg;

const alpha = { id: 'demo/alpha', kind: 'system', aka: [], facts: ['alpha exists'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'] };

const CHAT = 121628633;

before(async () => {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  mkdirSync(join(dir, 'hollow'), { recursive: true });
  writeFileSync(join(dir, 'demo', 'entities.jsonl'), `${JSON.stringify(alpha)}\n`);
  // A domain whose last entity was retired: the file exists and is empty.
  writeFileSync(join(dir, 'hollow', 'entities.jsonl'), '');
  writeFileSync(join(dir, 'root.md'), '# root\n\n## How to behave\nrules\n\n## Now\n- volatile\n');
  S = await import('../src/storyTree.js');
  D = await import('../src/db.js');
  K = await import('../src/knowledge.js');
  F = await import('../src/friction.js');
  C = await import('../src/concierge.js');
});

const clean = (): void => {
  S.ensureStoryNodes();
  D.saveStoryText(S.storyNodeId('demo'), 'demo is narrated [[demo/alpha]]');
  D.saveStoryText(S.STORY_ROOT_ID, 'root is narrated [[demo/alpha]]');
};

describe('a note write reaches the story', () => {
  it('dirties the domain story AND the root above it', () => {
    clean();
    K.upsertNote('demo/repair', 'the repair', 'Plumber on 08-17. Descale after.');
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 1, 'the note left the domain story clean');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.dirty, 1, 'dirt did not reach the root');
    K.deleteNote('demo/repair');
  });

  it('a note the graph has no domain for mints no node, dirties the root, and reaches the root material', () => {
    clean();
    K.upsertNote('health/x', 'a health note', 'Blood pressure was fine at the checkup.');
    assert.equal(D.getStoryNode(S.storyNodeId('health')), undefined, 'a note folder became a story node');
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 0, 'a foreign note dirtied a domain it is not in');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.dirty, 1, 'the un-domained note left the root clean');
    const root = S.storyWorklist().find((i) => i.id === S.STORY_ROOT_ID);
    assert.ok(root, 'the dirty root is not on the worklist');
    assert.ok(root.material.includes('## Notes with no domain in the graph'), 'no un-domained block in the root material');
    assert.ok(root.material.includes('- health/x: Blood pressure was fine at the checkup.'), `key missing: ${root.material}`);
    assert.equal(S.storyLint().undomained, 1, 'the lint does not count the un-domained note');
    K.deleteNote('health/x');
    assert.equal(S.storyLint().undomained, 0);
  });

  it('a root-level note key is un-domained too', () => {
    clean();
    K.upsertNote('scratch', 'loose', 'a loose note at the top');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.dirty, 1);
    assert.equal(S.storyLint().undomained, 1);
    K.deleteNote('scratch');
  });

  it('moving and deleting a note dirty the domain too', () => {
    K.upsertNote('demo/repair', 'the repair', 'Plumber on 08-17.');
    clean();
    K.moveNote('demo/repair', 'demo/boiler');
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 1, 'a move left the story clean');
    clean();
    K.deleteNote('demo/boiler');
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 1, 'a delete left the story clean');
  });
});

describe('the night is handed the notes', () => {
  it('lists each note under the domain with its first paragraph, after the entities', () => {
    clean();
    K.upsertNote('demo/repair', 'the repair', 'Plumber on 08-17, valve replaced first.\n\nSecond paragraph is not the excerpt.');
    const demo = S.storyWorklist().find((i) => i.id === S.storyNodeId('demo'));
    assert.ok(demo, 'the dirty domain is not on the worklist');
    const m = demo.material;
    assert.ok(m.includes('## Notes in this domain'), 'no notes block');
    assert.ok(m.indexOf('demo/alpha') < m.indexOf('## Notes in this domain'), 'notes came before the entities');
    assert.ok(m.includes('- demo/repair: Plumber on 08-17, valve replaced first.'), `note excerpt missing: ${m}`);
    assert.ok(!m.includes('Second paragraph'), 'the excerpt ran past the first paragraph');
    assert.ok(!m.includes('_map'), 'the folder map was offered as a note');
    K.deleteNote('demo/repair');
  });

  it('reads a CRLF note like any other', () => {
    clean();
    writeFileSync(
      join(dir, 'demo', 'windows.md'),
      '---\r\nkey: demo/windows\r\nsummary: crlf\r\nupdated: 2026-01-01T00:00:00.000Z\r\n---\r\n\r\nWritten on Windows.\r\nStill one paragraph.\r\n\r\nNot this.\r\n',
    );
    S.markDomainsDirty(['demo']);
    const m = S.storyWorklist().find((i) => i.id === S.storyNodeId('demo'))!.material;
    assert.ok(m.includes('- demo/windows: Written on Windows. Still one paragraph.'), `CRLF note misread: ${m}`);
    assert.ok(!m.includes('key: demo/windows'), 'the frontmatter leaked into the excerpt');
    K.deleteNote('demo/windows');
  });

  it('past the cap a note keeps its key and loses only its excerpt', () => {
    clean();
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const k = `demo/bulk-${String(i).padStart(2, '0')}`;
      keys.push(k);
      K.upsertNote(k, `bulk ${i}`, `${'lorem ipsum '.repeat(40)}${i}`);
    }
    const m = S.storyWorklist().find((i) => i.id === S.storyNodeId('demo'))!.material;
    for (const k of keys) assert.ok(m.includes(`- ${k}`), `${k} vanished from the worklist`);
    assert.match(m, /\(\d+ note\(s\) listed by key only/, 'no keys-only tail although the cap was hit');
    const block = m.slice(m.indexOf('## Notes in this domain'));
    assert.ok(block.length < 3000 + 12 * 40 + 200, `notes block is unbounded: ${block.length} chars`);
    for (const k of keys) K.deleteNote(k);
  });

  it('a domain with a note and no entities is offered, not cleared', () => {
    clean();
    K.upsertNote('hollow/only-note', 'the last trace', 'Everything here was retired, but this note remains.');
    assert.equal(D.getStoryNode(S.storyNodeId('hollow'))?.dirty, 1, 'the note left the hollow domain clean');
    const items = S.storyWorklist();
    const hollow = items.find((i) => i.id === S.storyNodeId('hollow'));
    assert.ok(hollow, 'the worklist cleared a domain that still has a note');
    assert.ok(hollow.material.includes('- hollow/only-note: Everything here was retired'), 'the note is not the material');
    assert.equal(D.getStoryNode(S.storyNodeId('hollow'))?.dirty, 1, 'the worklist cleaned the dirt off a domain with a note');
    K.deleteNote('hollow/only-note');
    S.markDomainsDirty(['hollow']);
    S.storyWorklist();
    assert.equal(D.getStoryNode(S.storyNodeId('hollow'))?.dirty, 0, 'with the note gone, the empty domain was not cleared');
  });
});

describe('the concierge ladder is story-first', () => {
  it('puts the story and readStory before searchMessages, under a heading that exists, and the prompt is byte-stable', () => {
    const l = C.RETRIEVAL_LADDER;
    assert.ok(l.indexOf('## The story') < l.indexOf('readStory'), 'the block is not rung one');
    assert.ok(l.indexOf('readStory') < l.indexOf('searchMessages'), 'searchMessages still outranks the story');
    assert.ok(l.indexOf('find(ref)') < l.indexOf('searchMessages'), 'the graph still comes after the message log');
    const a = C.conciergeSystemPrompt(CHAT);
    const b = C.conciergeSystemPrompt(CHAT);
    assert.ok(a.includes(l), 'the prompt does not carry the ladder');
    assert.match(a, /^## The story$/m, 'the rung names a heading the prompt does not have');
    assert.equal(a, b, 'the prompt is not byte-stable across two calls (I12)');
  });
});

describe('readStory logs its scope', () => {
  it('the tool_calls row carries the scope as its target', () => {
    F.noteToolCall('scope-log', 'mcp__bot__readStory', { scope: 'demo' });
    const raw = new Database(process.env.DB_PATH!, { readonly: true });
    const row = raw.prepare("SELECT target FROM tool_calls WHERE session_key = 'scope-log' AND tool LIKE '%readStory' ORDER BY id DESC LIMIT 1").get() as { target: string } | undefined;
    raw.close();
    assert.equal(row?.target, 'demo');
  });
});
