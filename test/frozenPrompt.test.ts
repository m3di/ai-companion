import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * ONE PROMPT PER SESSION — the I12 test that should always have existed.
 *
 * The concierge's system prompt is a cache prefix. On 2026-08-27 the ledger
 * read cache_read = 13,573 tokens (the tool schemas, the only stable part) on
 * every concierge turn against 60k–160k tokens cache_WRITTEN per turn: the
 * prompt was rebuilt every turn with live state inlined (the attention set,
 * today's events, open commitments), and any changed byte re-uploaded the
 * whole transcript behind it. Three isolation experiments proved the SDK
 * caches a resumed transcript across processes whenever the prefix holds.
 *
 * `test/conciergeContext.test.ts` once recorded that a byte-identity test was
 * "written, and it was wrong", because the prompt embedded the live feed by
 * design. That design is what this change removes, so the assertion is now
 * right: the STATIC prompt must be byte-identical across two builds with the
 * world changed between them — an event posted, a commitment added, a thread
 * recap moved — and the state those used to carry must live in the one-time
 * session-open snapshot instead, sent IN the first turn and never refreshed.
 */

const dir = mkdtempSync(join(tmpdir(), 'frozen-prompt-'));
process.env.KNOWLEDGE_DIR = join(dir, 'kb');
process.env.DB_PATH = join(dir, 'frozen-prompt-test.db');

type Cg = typeof import('../src/concierge.js');
type Db = typeof import('../src/db.js');
type Sp = typeof import('../src/sessionPrompt.js');
type Rot = typeof import('../src/rotation.js');
type Mc = typeof import('../src/modelChoice.js');
type Ss = typeof import('../src/sessions.js');

let C: Cg;
let D: Db;
let S: Sp;
let R: Rot;
let M: Mc;
let SS: Ss;

const CHAT = 121628633;
const KEY = `${CHAT}:-1`;
const CONTRACT = 'concierge:2/test';

const alpha = {
  id: 'demo/alpha',
  kind: 'system',
  aka: ['Alpha'],
  facts: ['Alpha is the demo platform'],
  edges: {},
  status: 'n/a',
  goal: false,
  dormant: false,
  chain: ['msg#1'],
};

before(async () => {
  const kb = join(dir, 'kb');
  mkdirSync(join(kb, 'demo'), { recursive: true });
  writeFileSync(join(kb, 'demo', 'entities.jsonl'), `${JSON.stringify(alpha)}\n`);
  writeFileSync(join(kb, 'root.md'), '# root\n\n## How to behave\n- rules\n\n## Now\n- volatile\n');
  C = await import('../src/concierge.js');
  D = await import('../src/db.js');
  S = await import('../src/sessionPrompt.js');
  R = await import('../src/rotation.js');
  M = await import('../src/modelChoice.js');
  SS = await import('../src/sessions.js');
  SS.ensureChat(CHAT);
});

/** Move the world: an event, a commitment, a thread with a recap. */
function disturb(tag: string): { slot: number; label: string } {
  D.postEvent(CHAT, 'test', `something happened ${tag}`);
  const label = `commitment ${tag}`;
  D.addCommitment(CHAT, label, 'body', '2099-01-01 09:00:00');
  const slot = D.createSession(CHAT, `thread ${tag}`);
  D.setRecap(CHAT, slot, `recap ${tag}`);
  return { slot, label };
}

describe('the static prompt holds still while the world moves (I12)', () => {
  it('is byte-identical across two builds with state changed between them', () => {
    const a = C.conciergeStaticPrompt(CHAT);
    const moved = disturb('one');
    const b = C.conciergeStaticPrompt(CHAT);
    assert.equal(a, b);
    assert.ok(a.length > 1000);
    // And the moved state is nowhere in it — not the event, not the commitment, not the card.
    assert.ok(!a.includes('something happened one'));
    assert.ok(!a.includes(moved.label));
    assert.ok(!a.includes('recap one'));
    // No wall-clock value in the prefix (a date-time stamp would tick on its own).
    assert.ok(!/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(a), 'no clock in the prefix');
  });

  it('carries the static things and points at the tools for the rest', () => {
    const p = C.conciergeStaticPrompt(CHAT);
    assert.match(p, /## The story/);
    assert.match(p, /How to behave/);
    assert.match(p, /\[SESSION OPEN\]/);
    assert.match(p, /listThreads \/ findThread \/ readThread/);
    assert.match(p, /readFocus\(\)/);
  });
});

describe('the session-open snapshot', () => {
  it('holds the cards, the feed and the open commitments, and says it is not refreshed', () => {
    const moved = disturb('two');
    const snap = C.sessionOpenSnapshot(CHAT);
    assert.ok(snap.startsWith('[SESSION OPEN — '));
    assert.match(snap, /NOT refreshed/);
    assert.ok(snap.includes('something happened two'));
    assert.ok(snap.includes(moved.label));
    assert.ok(snap.includes('recap two'));
    assert.ok(snap.includes(`slot ${moved.slot}:`));
  });

  it('is not part of the static prompt', () => {
    const snap = C.sessionOpenSnapshot(CHAT);
    const p = C.conciergeStaticPrompt(CHAT);
    const lines = snap.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(lines.length > 0, 'the snapshot has lines to test');
    for (const line of lines) {
      assert.ok(!p.includes(line), `snapshot line leaked into the prefix: ${line}`);
    }
  });
});

describe('one prompt per session', () => {
  it('freezes on the first resolution with the snapshot OWED, and sends it in that turn', () => {
    D.clearSession(KEY);
    const r = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(r.resolution, 'opened');
    assert.ok(r.sessionOpen && r.sessionOpen.startsWith('[SESSION OPEN'));
    assert.equal(D.frozenPrompt(KEY)?.prompt, r.systemPrompt);
    assert.equal(D.frozenPrompt(KEY)?.contract, CONTRACT);
    assert.equal(D.frozenPrompt(KEY)?.snapshotOwed, 1, 'owed until a turn carrying it ends ok');
  });

  it('keeps owing (and re-sending) the snapshot while no turn has carried it to the end', () => {
    // The first turn died before finishing — overload, Stop, a restart. No
    // settle happened. The stored prompt holds; the snapshot rides again.
    const again = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(again.resolution, 'stored');
    assert.ok(again.sessionOpen && again.sessionOpen.startsWith('[SESSION OPEN'));
    // A turn that ended ok settles it; from then on no snapshot.
    S.settleSnapshot(KEY);
    assert.equal(D.frozenPrompt(KEY)?.snapshotOwed, 0);
    const settled = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(settled.resolution, 'stored');
    assert.equal(settled.sessionOpen, undefined);
  });

  it('returns the stored prompt unchanged on the next turn, whatever moved', () => {
    const first = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    disturb('three');
    const second = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(second.resolution, 'stored');
    assert.equal(second.sessionOpen, undefined);
    assert.equal(second.systemPrompt, first.systemPrompt);
  });

  it('is dropped by clearSession, and the next resolution opens again with a snapshot', () => {
    D.clearSession(KEY);
    assert.equal(D.frozenPrompt(KEY), undefined);
    const after = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(after.resolution, 'opened');
    assert.ok(after.sessionOpen);
    S.settleSnapshot(KEY);
  });

  it('rebuilds WITHOUT a snapshot when only the prompt was dropped under a live session', () => {
    // A session exists (the SDK acknowledged one) and the root render moved:
    // rootBehavior drops the frozen prompt, not the session.
    D.setSessionId(KEY, 'live-session', CONTRACT);
    D.dropFrozenPrompt(KEY);
    const r = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(r.resolution, 'refreshed');
    assert.equal(r.sessionOpen, undefined, 'the transcript already lived the state');
    assert.equal(D.frozenPrompt(KEY)?.snapshotOwed, 0);
    assert.equal(S.resolveConciergePrompt(CHAT, KEY, CONTRACT).resolution, 'stored');
  });

  it('rebuilds under a new contract — a new tool set is a new session', () => {
    D.clearSession(KEY);
    S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    const other = S.resolveConciergePrompt(CHAT, KEY, 'concierge:2/other');
    assert.equal(other.resolution, 'opened');
    assert.equal(D.frozenPrompt(KEY)?.contract, 'concierge:2/other');
    D.clearSession(KEY);
    S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    S.settleSnapshot(KEY);
  });

  it('owes a RE-SENT snapshot when the SDK replaces the session under a resume, settled by the turn that carries it', () => {
    // A turn resumed 'old' and the SDK acknowledged 'new': the transcript never saw the snapshot.
    assert.equal(S.noteSessionReplaced(KEY, 'old', 'new'), true);
    assert.equal(D.frozenPrompt(KEY)?.snapshotOwed, 2);
    const owed = S.resolveConciergePrompt(CHAT, KEY, CONTRACT);
    assert.equal(owed.resolution, 'stored', 'the frozen prompt still holds');
    assert.ok(owed.sessionOpen && owed.sessionOpen.startsWith('[STATE RE-SENT'), 'the wording says the last turn lacked it');
    assert.ok(!owed.sessionOpen.includes('the moment this session began'));
    // The next turn carried it and ended ok.
    S.settleSnapshot(KEY);
    assert.equal(S.resolveConciergePrompt(CHAT, KEY, CONTRACT).sessionOpen, undefined);
    // An ordinary resume that comes back as itself owes nothing.
    assert.equal(S.noteSessionReplaced(KEY, 'new', 'new'), false);
    assert.equal(S.resolveConciergePrompt(CHAT, KEY, CONTRACT).sessionOpen, undefined);
  });
});

describe('the first turn is composed handoff → snapshot → text', () => {
  it('orders the three and omits what is absent', () => {
    assert.equal(R.composeTurnPrompt('[HANDOFF]', 'hi', '[SESSION OPEN]'), '[HANDOFF]\n\n[SESSION OPEN]\n\nhi');
    assert.equal(R.composeTurnPrompt(undefined, 'hi', '[SESSION OPEN]'), '[SESSION OPEN]\n\nhi');
    assert.equal(R.composeTurnPrompt('[HANDOFF]', 'hi'), '[HANDOFF]\n\nhi');
    assert.equal(R.composeTurnPrompt(undefined, 'hi'), 'hi');
  });
});

describe('the built-in tools the concierge may have', () => {
  it('is the configured list for the control slot and unrestricted for a worker', () => {
    assert.deepEqual(M.builtinToolsFor(true, { conciergeBuiltinTools: ['Bash', 'WebFetch'] }), ['Bash', 'WebFetch']);
    assert.deepEqual(M.builtinToolsFor(true, { conciergeBuiltinTools: [] }), []);
    assert.equal(M.builtinToolsFor(false, { conciergeBuiltinTools: ['Read'] }), undefined);
  });

  it('defaults to Bash and WebFetch — what the ledger shows the concierge uses — with Read off', async () => {
    const { config } = await import('../src/config.js');
    assert.deepEqual(config.conciergeBuiltinTools, ['Bash', 'WebFetch']);
    assert.ok(!config.conciergeBuiltinTools.includes('Read'));
  });
});
