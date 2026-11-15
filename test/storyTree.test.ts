import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * THE STORY TREE, AS A RENDER (round 11, P1).
 *
 * The properties pinned here are the ones the design was bought with:
 *   - STRUCTURE IS MECHANICAL. Nodes come from the domain list, dirtiness
 *     moves up the ancestor path on a write, an unnarratable (empty) domain
 *     is cleared by the worklist rather than offered as permanent dirt — and
 *     none of it needs an agent to have an opinion (I9).
 *   - THE TEXT IS REFUSED, NOT TRUSTED. Over budget, an unresolvable ref, no
 *     ref, refs that never touch the GRAPH — each is a refusal at the write
 *     tool (I1/I2). And what the tool would refuse, the lint must still CATCH
 *     if it lands some other way.
 *   - ROOT.MD IS LEFT ALONE (P2b). Level 0 is an injected block with its own
 *     budget; the P1 section is stripped from root.md once and never written
 *     again, and every other byte of the file survives.
 *   - THE RENDER IS STABLE (I12): same rows, same bytes — no clock, no date.
 *
 * The fixture is a temporary knowledge tree AND a temporary database: this
 * file exercises applyWrite end-to-end, and the suite runs files in parallel
 * against one scratch DB — assertions on shared rows are timing, not truth.
 */

const dir = mkdtempSync(join(tmpdir(), 'kb-story-'));
process.env.KNOWLEDGE_DIR = dir;
process.env.DB_PATH = join(dir, 'story-test.db');

type Story = typeof import('../src/storyTree.js');
type Db = typeof import('../src/db.js');
type Mod = typeof import('../src/entityWrite.js');
let S: Story;
let D: Db;
let applyWrite: Mod['applyWrite'];

const alpha = {
  id: 'demo/alpha',
  kind: 'system',
  aka: ['the alpha'],
  facts: ['alpha hosts clients one, two and three', 'alpha is written in scala'],
  edges: { 'relates-to': ['demo/beta'] },
  status: 'n/a',
  dormant: false,
  goal: false,
  chain: ['repo:demo/_map.md'],
};
const beta = { id: 'demo/beta', kind: 'component', aka: [], facts: ['beta imports from alpha'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'] };
const gamma = { id: 'other/gamma', kind: 'system', aka: [], facts: ['gamma stands alone'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#2'] };

const ROOT_DOC =
  '# root\n\n## How to behave\nrules here\n\n## Domains\n- demo\n\n## Global facts\n- a fact\n\n## Now\n- volatile\n';

before(async () => {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });
  mkdirSync(join(dir, 'vacant'), { recursive: true });
  writeFileSync(join(dir, 'demo', 'entities.jsonl'), `${JSON.stringify(alpha)}\n${JSON.stringify(beta)}\n`);
  writeFileSync(join(dir, 'other', 'entities.jsonl'), `${JSON.stringify(gamma)}\n`);
  writeFileSync(join(dir, 'vacant', 'entities.jsonl'), '');
  writeFileSync(join(dir, 'root.md'), ROOT_DOC);
  S = await import('../src/storyTree.js');
  D = await import('../src/db.js');
  ({ applyWrite } = await import('../src/entityWrite.js'));
});

describe('the story tree structure is mechanical', () => {
  it('creates root plus one node per domain, and creating twice is creating once', () => {
    S.ensureStoryNodes();
    const before1 = D.listStoryNodes();
    S.ensureStoryNodes();
    const after1 = D.listStoryNodes();
    assert.equal(before1.length, after1.length, 'ensure is not idempotent');
    assert.deepEqual(
      after1.map((n) => n.id).sort(),
      ['domain:demo', 'domain:other', 'domain:vacant', 'root'],
    );
  });

  it('picks up a domain it has never seen, without touching existing text', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.STORY_ROOT_ID, 'kept [[demo/alpha]]');
    S.markDomainsDirty(['zz-test-domain']);
    assert.ok(D.getStoryNode(S.storyNodeId('zz-test-domain')), 'new domain got no node');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.text, 'kept [[demo/alpha]]', 'mark overwrote existing text');
    D.deleteStoryNode(S.storyNodeId('zz-test-domain'));
  });

  it('a write dirties the domain story AND the root above it', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'was clean [[demo/alpha]]');
    D.saveStoryText(S.STORY_ROOT_ID, 'was clean too [[demo/alpha]]');
    S.markDomainsDirty(['demo']);
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 1, 'the domain story did not go dirty');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.dirty, 1, 'dirtiness did not propagate to root');
  });

  it('hands the night domains before root, with the domain entities as material and where the root lands stated', () => {
    S.ensureStoryNodes();
    S.markDomainsDirty(['demo']);
    const items = S.storyWorklist();
    const rootAt = items.findIndex((i) => i.id === S.STORY_ROOT_ID);
    const demoAt = items.findIndex((i) => i.id === S.storyNodeId('demo'));
    assert.notEqual(rootAt, -1, 'a dirty root is missing from the worklist');
    assert.notEqual(demoAt, -1, 'the dirty domain is missing from the worklist');
    assert.ok(demoAt < rootAt, 'the worklist puts root before its children');
    assert.ok(items[demoAt]!.material.includes('demo/alpha'), 'domain material lacks its own entities');
    assert.match(items[rootAt]!.material, /INJECTED/, 'the root item does not say where the story lands');
    assert.match(items[demoAt]!.material, /FIRST SENTENCE IS THE POINTER/, 'the domain item does not say its first sentence is the pointer');
  });

  it('clears an empty domain mechanically instead of offering it as permanent dirt', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('vacant'), '');
    S.markDomainsDirty(['vacant']);
    const items = S.storyWorklist();
    assert.equal(
      items.some((i) => i.id === S.storyNodeId('vacant')),
      false,
      'a domain with nothing to ref was offered to the rewrite gate that requires a ref',
    );
    const n = D.getStoryNode(S.storyNodeId('vacant'));
    assert.equal(n?.dirty, 0, 'the empty domain stayed dirty forever');
    assert.equal(n?.text, '');
  });
});

describe('a story rewrite is refused, not trusted', () => {
  it('refuses text over its budget', () => {
    S.ensureStoryNodes();
    const long = `[[demo/alpha]] ${'word '.repeat(1200)}`;
    const problem = S.validateStoryText(S.STORY_ROOT_ID, long);
    assert.ok(problem && /over budget/.test(problem), `expected an over-budget refusal, got: ${problem}`);
  });

  it('refuses a ref the graph does not answer to — a wrong ref is worse than none', () => {
    const problem = S.validateStoryText(S.STORY_ROOT_ID, 'A tale about [[no-such/entity-at-all]].');
    assert.ok(problem && /unresolvable/.test(problem), `expected an unresolvable-ref refusal, got: ${problem}`);
  });

  it('refuses text with no ref at all — a story with no node behind it is a second store', () => {
    const problem = S.validateStoryText(S.STORY_ROOT_ID, 'A vivid narrative, connected to nothing.');
    assert.ok(problem && /no \[\[ref\]\]/.test(problem), `expected a no-ref refusal, got: ${problem}`);
  });

  it('refuses refs that never touch the graph — story ids are navigation, not grounding', () => {
    S.ensureStoryNodes();
    const problem = S.validateStoryText(S.STORY_ROOT_ID, 'See [[domain:demo]] for everything.');
    assert.ok(problem && /GRAPH entity/.test(problem), `expected a no-grounding refusal, got: ${problem}`);
  });

  it('never consults root.md — a fat root.md refuses nothing, the root story has its own budget', () => {
    S.ensureStoryNodes();
    const fat = `# root\n\n## Filler\n${'x'.repeat(9600)}\n\n## Now\n- volatile\n`;
    writeFileSync(join(dir, 'root.md'), fat);
    const problem = S.validateStoryText(S.STORY_ROOT_ID, `[[demo/alpha]] ${'pad '.repeat(150)}`);
    assert.equal(problem, null, `the root story was refused against root.md's cap: ${problem}`);
    writeFileSync(join(dir, 'root.md'), ROOT_DOC);
  });

  it('accepts a grounded, budgeted text; saving clears dirty and repaints both surfaces', () => {
    S.ensureStoryNodes();
    S.markDomainsDirty(['demo']);
    const text = 'The demo platform turns on [[demo/alpha]], which [[demo/beta]] imports from.';
    const r = S.applyStoryRewrite(S.storyNodeId('demo'), text);
    assert.equal(r.ok, true, `rewrite refused: ${r.problem}`);
    const n = D.getStoryNode(S.storyNodeId('demo'));
    assert.equal(n?.text, text);
    assert.equal(n?.dirty, 0, 'saving did not clear the dirty flag');
    assert.ok(readFileSync(join(dir, 'story.md'), 'utf8').includes(text), 'story.md was not repainted');
  });

  it('extracts refs by exact double-bracket, several to a line, nothing fuzzier', () => {
    assert.deepEqual(S.extractRefs('a [[people/x]] b [[self/y]] c [people/not-a-ref]'), ['people/x', 'self/y']);
    assert.deepEqual(S.extractRefs('[[a]] [[b]]'), ['a', 'b'], 'two refs on one line must both extract');
  });
});

describe('root.md is left alone', () => {
  const SPLICED =
    '# root\n\n## How to behave\nrules here\n\n## Domains\n- demo\n\n## Global facts\n- a fact\n\n' +
    '## The story\n<!-- GENERATED from the story tree. -->\n\nold level-0 text [[demo/alpha]]\n\nDrill down: story.md holds the per-domain stories.\n\n' +
    '## Now\n- volatile\n';

  it('strips the P1 section once, and every authored section survives byte-for-byte', () => {
    const out = S.stripStorySection(SPLICED);
    assert.equal(out.includes('## The story'), false, 'the generated section survived the strip');
    assert.equal(out.includes('Drill down'), false, 'the dead drill-down line survived');
    assert.equal(out, ROOT_DOC, 'stripping did not restore the authored file exactly');
  });

  it('is a no-op on a file without the section, and strips at EOF', () => {
    assert.equal(S.stripStorySection(ROOT_DOC), ROOT_DOC);
    const atEnd = '# root\n\n## Domains\n- demo\n\n## The story\n<!-- GENERATED from the story tree. -->\n\nold [[demo/alpha]]\n';
    assert.equal(S.stripStorySection(atEnd), '# root\n\n## Domains\n- demo\n');
  });

  it('leaves an AUTHORED ## The story alone — no marker, not ours', () => {
    const authored = '# root\n\n## The story\n\nMehdi wrote this himself.\n\n## Now\n- volatile\n';
    assert.equal(S.stripStorySection(authored), authored, 'an authored section was stripped');
    S.ensureStoryNodes();
    writeFileSync(join(dir, 'root.md'), authored);
    S.refreshStorySurfaces();
    assert.equal(readFileSync(join(dir, 'root.md'), 'utf8'), authored, 'refresh touched an authored section');
    writeFileSync(join(dir, 'root.md'), ROOT_DOC);
  });

  it('ends the section at the next ## heading only — a ### inside it goes with it — and survives CRLF', () => {
    const withSub =
      '# root\r\n\r\n## The story\r\n<!-- GENERATED from the story tree. -->\r\n\r\nold [[demo/alpha]]\r\n\r\n### a sub-part\r\nstill the story\r\n\r\n## Now\r\n- volatile\r\n';
    assert.equal(S.stripStorySection(withSub), '# root\r\n\r\n## Now\r\n- volatile\r\n');
  });

  it('refreshStorySurfaces strips it from the live file once and then never writes root.md again', () => {
    S.ensureStoryNodes();
    writeFileSync(join(dir, 'root.md'), SPLICED);
    const first = S.refreshStorySurfaces();
    assert.equal(first.problem, undefined, first.problem);
    const stripped = readFileSync(join(dir, 'root.md'), 'utf8');
    assert.equal(stripped, ROOT_DOC, 'the live root.md was not restored to its authored form');
    D.saveStoryText(S.STORY_ROOT_ID, 'a fresh root story [[demo/alpha]]');
    S.refreshStorySurfaces();
    assert.equal(readFileSync(join(dir, 'root.md'), 'utf8'), stripped, 'a story rewrite touched root.md');
    assert.ok(readFileSync(join(dir, 'root.md'), 'utf8').includes('## Now\n- volatile'), '## Now did not survive');
    D.saveStoryText(S.STORY_ROOT_ID, '');
  });
});

describe('the level-0 block — what a turn actually sees', () => {
  it('is empty until something is written, then carries the root story and one pointer per narrated domain', () => {
    S.ensureStoryNodes();
    for (const id of ['root', 'domain:demo', 'domain:other', 'domain:vacant']) D.saveStoryText(id, '');
    assert.equal(S.storyContext(), '', 'an unwritten tree rendered something');
    D.saveStoryText(S.STORY_ROOT_ID, 'The demo estate turns on [[demo/alpha]].');
    D.saveStoryText(S.storyNodeId('demo'), 'Alpha hosts three clients [[demo/alpha]]. Beta imports from it [[demo/beta]].');
    const ctx = S.storyContext();
    assert.ok(ctx.startsWith('The demo estate turns on [[demo/alpha]].'), 'the root story does not head the block');
    assert.match(ctx, /^- \*\*demo\*\* — Alpha hosts three clients \[\[demo\/alpha\]\]\. → readStory\("demo"\)$/m, 'the pointer line has the wrong shape');
    assert.equal(ctx.includes('[[demo/beta]]'), false, 'the pointer leaked past the first sentence');
    assert.equal(ctx.includes('**other**'), false, 'an unwritten domain got a pointer line');
    assert.equal(ctx.includes('not yet narrated'), false, 'unwritten domains are named in the injected block — that line moves mid-day (I12)');
  });

  it('does not move when a write mints a new, empty story node (I12)', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.STORY_ROOT_ID, 'The demo estate turns on [[demo/alpha]].');
    const before1 = S.storyContext();
    D.ensureStoryNode(S.storyNodeId('zz-minted-today'), S.STORY_ROOT_ID, 'zz-minted-today');
    assert.equal(S.storyContext(), before1, 'a new empty node changed the injected block under a running session');
    D.deleteStoryNode(S.storyNodeId('zz-minted-today'));
  });

  it('cuts a long first sentence at the pointer width, never inside a ref', () => {
    // Put the ref exactly astride the 160-char cut so the back-off branch runs.
    const straddle = `${'x'.repeat(152)} [[demo/alpha]] and then the sentence goes on for a while longer.`;
    const s = S.firstSentence(straddle);
    assert.ok(s.length <= 161, `pointer too long: ${s.length}`);
    assert.ok(s.endsWith('…'), 'a cut sentence must say it was cut');
    assert.equal((s.match(/\[\[/g) ?? []).length, (s.match(/\]\]/g) ?? []).length, 'the cut left a [[ without its ]]');
    assert.equal(s.includes('[['), false, 'the straddling ref should have been backed off entirely');
    assert.equal(S.firstSentence('Short [[demo/alpha]]. Then more.'), 'Short [[demo/alpha]].');
  });

  it('stays under its budget by shrinking pointers, then dropping lines — never the root text', () => {
    S.ensureStoryNodes();
    const root = `Root text [[demo/alpha]] ${'r'.repeat(1100)}`;
    D.saveStoryText(S.STORY_ROOT_ID, root);
    // 30 pointer lines at the MINIMUM width (~106 chars each) plus a
    // near-max root is ~4300 chars against a 3600 budget: the shrink loop
    // alone cannot save it, so the drop loop must run.
    const minted: string[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        const scope = `zz-many-${String(i).padStart(2, '0')}`;
        D.ensureStoryNode(S.storyNodeId(scope), S.STORY_ROOT_ID, scope);
        D.saveStoryText(S.storyNodeId(scope), `Domain ${i} ${'w'.repeat(300)} [[demo/alpha]] tail. More text.`);
        minted.push(S.storyNodeId(scope));
      }
      const ctx = S.storyContext();
      assert.ok(ctx.length <= 900 * 4, `block over budget: ${ctx.length} chars`);
      assert.ok(ctx.includes(root), 'the root text was cut');
      assert.match(ctx, /^- \d+ more domain\(s\) — readStory names them: /m, 'the drop loop never fired — the test is not exercising it');
      assert.ok(/readStory\("zz-many-00"\)$/m.test(ctx) && ctx.includes('…'), 'the shrink loop never fired — pointers were not cut down first');
      assert.equal(ctx.includes('\n\n\n'), false, 'a triple newline crept in around the "more domains" line');
    } finally {
      for (const id of minted) D.deleteStoryNode(id);
      D.saveStoryText(S.STORY_ROOT_ID, '');
    }
  });
});

describe('the render is a stable function of its rows — I12', () => {
  it('renders byte-identically twice, for both surfaces', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'Alpha [[demo/alpha]]. More.');
    assert.equal(S.storyContext(), S.storyContext());
    assert.equal(S.renderStoryFile(), S.renderStoryFile());
  });

  it('carries no clock and no today-stamp', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const s of [S.storyContext(), S.renderStoryFile()]) {
      assert.equal(s.includes(today), false, 'the render stamped today into a surface that may be injected');
      assert.doesNotMatch(s, /\b\d{2}:\d{2}:\d{2}\b/, 'the render put a clock in');
    }
    D.saveStoryText(S.storyNodeId('demo'), '');
  });

  it('says it is generated, so nobody hand-edits it', () => {
    assert.match(S.renderStoryFile(), /GENERATED from story_nodes/);
  });
});

describe('readStory opens one story for the day', () => {
  it('returns the text with refs intact, and refuses an unknown or unwritten scope by naming the real ones', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'Alpha hosts [[demo/alpha]].');
    const ok = S.readStory('demo');
    assert.ok('text' in ok && ok.text === 'Alpha hosts [[demo/alpha]].', `readStory lost the text: ${JSON.stringify(ok)}`);
    assert.ok('text' in S.readStory('domain:demo'), 'the story-node id form must open the same story');
    const nope = S.readStory('nowhere');
    assert.ok('problem' in nope && /no story "nowhere"/.test(nope.problem) && /demo/.test(nope.problem), `bad refusal: ${JSON.stringify(nope)}`);
    const unwritten = S.readStory('other');
    assert.ok('problem' in unwritten && /has no story yet/.test(unwritten.problem), `bad refusal: ${JSON.stringify(unwritten)}`);
    D.saveStoryText(S.storyNodeId('demo'), '');
  });
});

describe('the lint catches what the gate would have refused', () => {
  it('self-seeds before judging, and reports a genuinely clean tree as clean', () => {
    // Zero out every text this file may have planted, then lint: on a tree
    // whose nodes match the domains and whose texts are empty, nothing may
    // fire. This is the fresh-database boot case — fourteen missing nodes
    // must be an ensure, not a BROKEN SHAPE alarm.
    for (const n of D.listStoryNodes()) D.saveStoryText(n.id, '');
    const s = S.storyLint();
    assert.deepEqual(s.problems, [], `a clean tree lints dirty: ${s.problems[0] ?? ''}`);
    assert.equal(s.nodes, 4, 'root + three fixture domains');
  });

  it('flags an orphan node whose scope is no longer a domain', () => {
    D.ensureStoryNode('domain:gone-domain', S.STORY_ROOT_ID, 'gone-domain');
    const s = S.storyLint();
    assert.ok(
      s.problems.some((p) => p.includes('gone-domain') && p.includes('orphan')),
      'an orphan story node went unflagged',
    );
    D.deleteStoryNode('domain:gone-domain');
  });

  it('flags a dangling ref and an over-budget text that landed around the gate', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'refs [[gone/forever]]. ' + 'x'.repeat(4000));
    const s = S.storyLint();
    assert.ok(s.problems.some((p) => p.includes('gone/forever')), 'a dangling ref got past the lint');
    assert.ok(s.problems.some((p) => p.includes('over budget')), 'an over-budget node got past the lint');
    D.saveStoryText(S.storyNodeId('demo'), '');
  });
});

describe('a graph write maintains the story, end to end', () => {
  it('applyWrite dirties the story path and repaints root.md and story.md', () => {
    S.ensureStoryNodes();
    D.saveStoryText(S.storyNodeId('demo'), 'clean [[demo/alpha]]');
    D.saveStoryText(S.STORY_ROOT_ID, 'clean [[demo/alpha]]');
    const r = applyWrite(
      { op: 'add-fact', id: 'demo/alpha', fact: 'alpha grew a fourth client in the demo fixture' },
      'integration: the write path must maintain the story view',
      'test',
    );
    assert.equal(r.ok, true, `the fixture write failed: ${JSON.stringify(r)}`);
    assert.equal(D.getStoryNode(S.storyNodeId('demo'))?.dirty, 1, 'the write did not dirty its domain story');
    assert.equal(D.getStoryNode(S.STORY_ROOT_ID)?.dirty, 1, 'the write did not dirty the root story');
    const root = readFileSync(join(dir, 'root.md'), 'utf8');
    assert.equal(root.includes('## The story'), false, 'the write spliced a story section into root.md — level 0 is injected now');
    assert.ok(root.includes('## Now\n- volatile'), '## Now did not survive the write');
    assert.match(readFileSync(join(dir, 'story.md'), 'utf8'), /GENERATED from story_nodes/, 'story.md was not written');
  });
});
