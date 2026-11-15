import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

/**
 * THE WORKER'S PREFIX HOLDS STILL (I12, the other half of the fleet).
 *
 * test/workerContext.test.ts has guarded the APPENDED block since 08-02 —
 * the $86 session — but the claude_code preset in front of it was never
 * covered, and it moves per process: today's date, the working directory,
 * a git-status snapshot, the model name. Every worker turn is a new process,
 * so a resumed worker re-uploaded its history exactly as the concierge did
 * before 2026-08-27. The preset is gone; this asserts what replaced it.
 */

const dir = mkdtempSync(join(tmpdir(), 'worker-prompt-'));
process.env.KNOWLEDGE_DIR = join(dir, 'kb');
process.env.DB_PATH = join(dir, 'worker-prompt-test.db');
const promptPath = join(dir, 'system.md');
process.env.SYSTEM_PROMPT_PATH = promptPath;
writeFileSync(promptPath, '## Style over Telegram\n- terse\n');

type Db = typeof import('../src/db.js');
type Sp = typeof import('../src/sessionPrompt.js');
type Wp = typeof import('../src/workerPrompt.js');
type Ss = typeof import('../src/sessions.js');

let D: Db;
let S: Sp;
let W: Wp;
let SS: Ss;

const CHAT = 121628633;
const CONTRACT = 'worker:3/test';
const CWD = '/Users/someone/Projects/repo';
let slot = 0;
let key = '';

before(async () => {
  D = await import('../src/db.js');
  S = await import('../src/sessionPrompt.js');
  W = await import('../src/workerPrompt.js');
  SS = await import('../src/sessions.js');
  SS.ensureChat(CHAT);
  slot = D.createSession(CHAT, 'worker under test');
  key = D.sessionKey(CHAT, slot);
  D.setBrief(CHAT, slot, 'Ship PR #152. Do not touch V37.');
});

describe('the static worker prompt', () => {
  it('is byte-identical across builds, the same for every worker, and carries no clock or directory', () => {
    const a = W.workerStaticPrompt() ?? '';
    D.setBrief(CHAT, slot, 'a different brief');
    D.postEvent(CHAT, 'test', 'something happened');
    const b = W.workerStaticPrompt() ?? '';
    assert.equal(a, b);
    assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}/, 'no date in the prefix');
    assert.doesNotMatch(a, /\d{1,2}:\d{2}/, 'no wall-clock in the prefix');
    assert.ok(!a.includes(CWD) && !a.includes(process.cwd()), 'no working directory in the prefix');
    assert.ok(!a.includes('a different brief') && !a.includes('Ship PR #152'), 'the brief is not in the prefix');
    assert.match(a, /WORKER thread/);
    assert.match(a, /\[SESSION OPEN\]/);
    assert.match(a, /\[GUIDANCE\]/);
    assert.match(a, /reportBlocked/);
    assert.match(a, /Style over Telegram/, 'prompts/system.md rides in the static text');
    D.setBrief(CHAT, slot, 'Ship PR #152. Do not touch V37.');
  });
});

describe('the worker session-open snapshot', () => {
  it('carries the date, the directory, the platform and the brief, and says it is not refreshed', () => {
    const snap = W.workerOpenSnapshot({ brief: 'Ship PR #152.', cwd: CWD, now: new Date('2026-08-28T10:00:00Z') });
    assert.ok(snap.startsWith('[SESSION OPEN — '));
    assert.match(snap, /NOT refreshed/);
    assert.match(snap, /Today's date: 2026-08-28/);
    assert.ok(snap.includes(`Working directory: ${CWD}`));
    assert.match(snap, /Platform: /);
    assert.ok(snap.includes('Ship PR #152.'));
    assert.ok(W.workerOpenSnapshot({ cwd: CWD }).includes('(none given'));
    assert.ok(W.workerOpenSnapshot({ cwd: CWD, variant: 'resent' }).startsWith('[STATE RE-SENT'));
  });
});

describe('resolveWorkerPrompt', () => {
  it('opens with a snapshot the first time, owed until a turn carrying it ends ok', () => {
    const r = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(r.resolution, 'opened');
    assert.ok(r.sessionOpen?.startsWith('[SESSION OPEN'));
    assert.ok(r.sessionOpen?.includes('Ship PR #152.'));
    assert.equal(D.frozenPrompt(key)?.snapshotOwed, 1);
  });

  it('opens with a snapshot — not a silent refresh — under a NEW contract on a warm session', () => {
    // The 08-28 review's blocker: at a contract rollover every warm worker has a
    // session id (refused by the resume) and no prompt row; keying "refreshed,
    // owe nothing" on the id alone opened a fresh transcript with no brief.
    const s2 = D.createSession(CHAT, 'warm worker');
    const k2 = D.sessionKey(CHAT, s2);
    D.setBrief(CHAT, s2, 'the warm brief');
    D.setSessionId(k2, 'built-under-the-old-contract', 'worker:2/old');
    const r = S.resolveWorkerPrompt(CHAT, s2, k2, CONTRACT, CWD);
    assert.equal(r.resolution, 'opened');
    assert.ok(r.sessionOpen?.includes('the warm brief'));
    assert.equal(D.frozenPrompt(k2)?.snapshotOwed, 1);
  });

  it('reflects a brief that changed before the first turn settled', () => {
    D.setBrief(CHAT, slot, 'Ship PR #152 — AND rebase first.');
    const again = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(again.resolution, 'stored');
    assert.ok(again.sessionOpen?.includes('AND rebase first'));
  });

  it('sends nothing after the settle while only the recap moves, and the prompt bytes are unchanged', () => {
    const before = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    S.settleSnapshot(key);
    D.setRecap(CHAT, slot, 'recap moved');
    const after = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(after.resolution, 'stored');
    assert.equal(after.sessionOpen, undefined);
    assert.equal(after.systemPrompt, before.systemPrompt);
  });

  it('re-sends the brief as [BRIEF UPDATED] when it is rewritten after the settle', () => {
    // dispatchTask onto a warm slot and switchThread both call setBrief; the
    // old per-turn append delivered that for free, the frozen prompt cannot.
    D.setBrief(CHAT, slot, 'yet another brief');
    assert.equal(D.frozenPrompt(key)?.snapshotOwed, 3);
    const r = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(r.resolution, 'stored');
    assert.ok(r.sessionOpen?.startsWith('[BRIEF UPDATED'));
    assert.ok(r.sessionOpen?.includes('yet another brief'));
    assert.ok(!r.sessionOpen?.includes('the moment this thread began'));
    S.settleSnapshot(key);
    assert.equal(S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD).sessionOpen, undefined);
  });

  it('keeps the stored bytes when prompts/system.md is momentarily unreadable', async () => {
    const before = D.frozenPrompt(key)?.prompt;
    const { config } = (await import('../src/config.js')) as { config: { systemPromptPath: string } };
    const path = config.systemPromptPath;
    config.systemPromptPath = join(dir, 'missing.md');
    try {
      assert.equal(W.workerStaticPrompt(), undefined);
      const r = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
      assert.equal(r.resolution, 'stored');
      assert.equal(r.systemPrompt, before);
    } finally {
      config.systemPromptPath = path;
    }
  });

  it('refreshes under the live transcript, without a snapshot, when prompts/system.md is edited', () => {
    D.setSessionId(key, 'live-worker-session', CONTRACT);
    writeFileSync(promptPath, '## Style over Telegram\n- terse\n- and kind\n');
    const r = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(r.resolution, 'refreshed');
    assert.equal(r.sessionOpen, undefined, 'the transcript already lived the state');
    assert.match(r.systemPrompt, /and kind/);
    assert.equal(D.frozenPrompt(key)?.prompt, r.systemPrompt);
    assert.equal(S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD).resolution, 'stored');
  });

  it('keeps the debt across such a refresh', () => {
    D.setSnapshotOwed(key, 2);
    writeFileSync(promptPath, '## Style over Telegram\n- terse\n- and kind\n- and brief\n');
    const r = S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    assert.equal(r.resolution, 'refreshed');
    assert.ok(r.sessionOpen?.startsWith('[STATE RE-SENT'));
    assert.equal(D.frozenPrompt(key)?.snapshotOwed, 2);
    S.settleSnapshot(key);
  });

  it('rebuilds with a snapshot under a new contract — a new tool set is a new session', () => {
    D.clearSession(key);
    assert.equal(D.frozenPrompt(key), undefined);
    S.resolveWorkerPrompt(CHAT, slot, key, CONTRACT, CWD);
    const other = S.resolveWorkerPrompt(CHAT, slot, key, 'worker:3/other', CWD);
    assert.equal(other.resolution, 'opened');
    assert.ok(other.sessionOpen);
    assert.equal(D.frozenPrompt(key)?.contract, 'worker:3/other');
  });

  it('owes a RE-SENT snapshot when the SDK replaces a worker session under a resume', () => {
    S.settleSnapshot(key);
    assert.equal(S.noteSessionReplaced(key, 'old', 'new'), true);
    const r = S.resolveWorkerPrompt(CHAT, slot, key, 'worker:3/other', CWD);
    assert.ok(r.sessionOpen?.startsWith('[STATE RE-SENT'));
    S.settleSnapshot(key);
    assert.equal(S.resolveWorkerPrompt(CHAT, slot, key, 'worker:3/other', CWD).sessionOpen, undefined);
  });
});
