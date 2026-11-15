import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * THE WORK STATE.
 *
 * Two properties carry it, and both are about what CANNOT happen:
 *
 *   1. In debug, nothing reaches the day. Not a turn, not a worker, not a
 *      probe. A mode that suspends most of the bot is not a mode — the value is
 *      that the machine holds still, and one loop still ticking is enough to
 *      make an experiment unreadable.
 *   2. A rollback restores the tree EXACTLY, or refuses. "Rolled back" when
 *      something was left behind is a lie the operator would build on.
 *
 * And one that is easy to get backwards: rolling back must NOT touch the
 * concierge's context, because the whole point is that the experiment cost the
 * day nothing. Keeping changes must.
 */

const dir = mkdtempSync(join(tmpdir(), 'mode-'));
process.env.KNOWLEDGE_DIR = dir;

type Mod = typeof import('../src/mode.js');
let m: Mod;
let claimDreamPhase: typeof import('../src/db.js')['claimDreamPhase'];

const FILE = () => join(dir, 'demo', 'entities.jsonl');
const row = (id: string) =>
  JSON.stringify({ id, kind: 'system', aka: [], facts: ['a fact'], edges: {}, status: 'n/a', dormant: false, goal: false, chain: ['msg#1'] });

function resetTree(): void {
  mkdirSync(join(dir, 'demo'), { recursive: true });
  writeFileSync(FILE(), `${row('demo/alpha')}\n`);
}

before(async () => {
  resetTree();
  m = await import('../src/mode.js');
  ({ claimDreamPhase } = await import('../src/db.js'));
});

let releaseDream: (() => void) | null = null;

function clean(): void {
  // A leaked phase or session would make every later case run against a
  // machine in a state it did not ask for — and the dream phase in particular
  // blocks everything, so a leak turns the rest of the file red for a reason
  // that has nothing to do with the rest of the file.
  releaseDream?.();
  releaseDream = null;
  if (m?.currentMode() === 'debug') m.exitDebug({ rollback: false });
}

beforeEach(() => {
  clean();
  resetTree();
});

after(() => {
  clean();
  delete process.env.KNOWLEDGE_DIR;
});

/** Claim the dream phase and remember how to let it go. */
function dream(scope = 'nightly'): void {
  const c = m.beginDream(scope);
  assert.ok(c.ok, 'could not claim the dream phase');
  releaseDream = c.release;
}

describe('entering and leaving', () => {
  it('starts live, and every activity is allowed', () => {
    assert.equal(m.currentMode(), 'live');
    for (const a of ['day-turn', 'worker', 'commitment', 'probe-sweep', 'auto-nightly'] as const) {
      assert.equal(m.allowed(a), true, `${a} blocked while live`);
    }
  });

  /**
   * READING IS FREE; CHANGING IS NOT.
   *
   * These were one permission, and the conflation had a price the design never
   * intended: to ask the machine what a node looked like you had to sedate it,
   * suspending turns, workers, probes and the nightly — an enormous cost for a
   * question, and one that meant the operator simply did not ask.
   */
  it('lets the operator ASK while live, but not WRITE', () => {
    assert.equal(m.currentMode(), 'live');
    assert.equal(m.allowed('operator-turn'), true, 'a read-only question needed the day suspended');
    assert.equal(m.allowed('operator-write'), false, 'the agent could write to a live graph');
  });

  it('grants the write, and only the write, on entering debug', () => {
    m.enterDebug('to change something');
    assert.equal(m.allowed('operator-turn'), true);
    assert.equal(m.allowed('operator-write'), true);
  });

  it('suspends EVERY day activity in debug — not most of them', () => {
    m.enterDebug('a test');
    assert.equal(m.currentMode(), 'debug');
    // Exhaustive on purpose. One loop still ticking is enough to make an
    // experiment unreadable, and the prober in particular writes back INTO the
    // tree a rollback is meant to restore.
    for (const a of ['day-turn', 'worker', 'commitment', 'wakeup', 'auto-nightly', 'probe-sweep', 'focus-sweep', 'harvest', 'distill'] as const) {
      assert.equal(m.allowed(a), false, `${a} still runs in debug`);
    }
  });

  it('snapshots the tree on entry', () => {
    const d = m.enterDebug('snapshot check');
    assert.ok(existsSync(join(d.snapshot, 'demo', 'entities.jsonl')));
    assert.equal(readFileSync(join(d.snapshot, 'demo', 'entities.jsonl'), 'utf8'), readFileSync(FILE(), 'utf8'));
  });

  it('is idempotent — a second enter keeps the FIRST snapshot', () => {
    // Re-snapshotting would capture the dirty tree and quietly make the
    // rollback a no-op, which is the worst possible failure here: it reports
    // success and restores nothing.
    const a = m.enterDebug('first');
    writeFileSync(FILE(), `${row('demo/alpha')}\n${row('demo/beta')}\n`);
    const b = m.enterDebug('second');
    assert.equal(a.snapshot, b.snapshot);
    assert.equal(a.since, b.since);
  });

  it('exiting when already live is a no-op, not a crash', () => {
    assert.equal(m.exitDebug({ rollback: true }), undefined);
  });
});

describe('rollback', () => {
  it('restores the tree byte for byte', () => {
    const before = readFileSync(FILE(), 'utf8');
    m.enterDebug('rollback');
    writeFileSync(FILE(), `${row('demo/alpha')}\n${row('demo/gamma')}\n`);
    writeFileSync(join(dir, 'demo', 'stray.md'), 'a file that did not exist before');
    m.exitDebug({ rollback: true });
    assert.equal(readFileSync(FILE(), 'utf8'), before);
    // The snapshot covers the whole TREE, not only what went through record() —
    // which is the reason it is a snapshot and not a journal replay.
    assert.equal(existsSync(join(dir, 'demo', 'stray.md')), false, 'a non-graph file survived the rollback');
  });

  it('LEAVES THE CONCIERGE CONTEXT ALONE — that is the point of rolling back', () => {
    m.enterDebug('x');
    writeFileSync(FILE(), `${row('demo/alpha')}\n${row('demo/delta')}\n`);
    const r = m.exitDebug({ rollback: true })!;
    assert.equal(r.rolledBack, true);
    assert.equal(r.contextReset, false, 'a rollback reset the context — the experiment cost the day something');
  });

  it('refuses rather than lying when its snapshot is gone', () => {
    const d = m.enterDebug('lost snapshot');
    rmSync(d.snapshot, { recursive: true, force: true });
    assert.throws(() => m.exitDebug({ rollback: true }), /cannot roll back/);
    // And it must still be in debug: a failed exit that silently went live
    // would let the day back in on top of an unreviewed tree.
    assert.equal(m.currentMode(), 'debug');
  });
});

/**
 * DREAMING — the third state, and the only one nothing may talk to.
 *
 * A rewrite pass is the day's termination routine: it reads the day's whole
 * window, folds the observation inbox and rewrites the root. Anything that
 * writes memory or talks to the concierge WHILE that runs is writing into a
 * context being replaced under it. So dreaming permits nothing at all — and
 * unlike debug, it is not a state you can decide to leave.
 */
describe('dreaming', () => {
  it('outranks live, and blocks every day activity', () => {
    dream();
    assert.equal(m.currentMode(), 'dreaming');
    for (const a of ['day-turn', 'worker', 'commitment', 'wakeup', 'probe-sweep', 'harvest'] as const) {
      assert.equal(m.allowed(a), false, `${a} ran during a dream`);
    }
    // Including the read-only one. A dream rewrites the very memory a question
    // would be answered from, so even looking is answered with "wait".
    assert.equal(m.allowed('operator-turn'), false, 'the operator could read a graph mid-rewrite');
  });

  it('outranks debug, and the session survives underneath it', () => {
    // The induced dream is the operator's main "did that change help?"
    // instrument. Flat exclusivity between the three states would have made it
    // illegal — so debug is a SESSION and dreaming is a PHASE over it, and the
    // proof is that the snapshot is still there when the pass lands.
    const d = m.enterDebug('operating');
    dream('nightly');
    assert.equal(m.currentMode(), 'dreaming');
    assert.equal(m.debugState()?.snapshot, d.snapshot, 'the debug session was lost to the dream');
    releaseDream!();
    releaseDream = null;
    assert.equal(m.currentMode(), 'debug', 'the pass did not hand the machine back to the operator');
  });

  it('blocks the operator turn that debug exists to allow', () => {
    m.enterDebug('operating');
    assert.equal(m.allowed('operator-turn'), true);
    dream();
    assert.equal(m.allowed('operator-turn'), false, 'the gardener could write while the night folded');
  });

  it('refuses a second pass while one holds the machine', () => {
    dream('nightly');
    const second = m.beginDream('reconstruction');
    assert.equal(second.ok, false, 'two rewrite passes claimed the machine at once');
  });

  it('refuses to open a debug session mid-dream', () => {
    dream();
    assert.throws(() => m.enterDebug('now'), /DREAMING/);
  });

  /**
   * A HOLD MUST ALWAYS BE ESCAPABLE (I8).
   *
   * The dream phase blocks everything — turns, sweeps, the next night, and the
   * operator's own way back in. The first cut checked for debris only when
   * someone tried to CLAIM the lock, which is no help at all to the callers who
   * are merely asking whether they may act: they would have been told DREAMING
   * forever by a pass that ended without saying so. The check belongs on the
   * read.
   */
  it('clears a hold that outlived any plausible pass', () => {
    // THE THRESHOLD MOVED FROM 45 MINUTES TO TWELVE HOURS, and the reason is
    // that the old one fired on healthy passes. Dreams #71-#73 each spanned
    // 3.8h-5.9h of wall clock because the laptop sleeps mid-fold, so the hold
    // was discarded as debris every night while the fold was still writing.
    // Liveness is now the process, not the clock — but this ceiling stays,
    // because I8 needs an escape that does not depend on a person noticing,
    // and a pid alone cannot tell a working pass from a wedged one.
    const long = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    const c = claimDreamPhase('nightly', long);
    assert.ok(c.ok);
    releaseDream = null; // it is about to clear itself; nothing to release
    assert.equal(m.currentMode(), 'live', 'a thirteen-hour-old hold still blocked the day');
    assert.equal(m.allowed('day-turn'), true);
  });

  it('does not clear a hold that is merely young', () => {
    dream();
    assert.equal(m.currentMode(), 'dreaming', 'a fresh pass was mistaken for debris');
  });

  it('names the state in its refusal, so a caller can tell WHY it was told no', () => {
    // Live and dreaming are both "not debug", and the operator's next move
    // differs completely: sedate it, versus wait. A refusal that does not
    // distinguish them sends them to the wrong one.
    // LIVE refuses things too — the operator agent, for one — and saying
    // "DEBUG MODE — suspended" to someone whose bot is running names the
    // opposite of the truth and prescribes the opposite of the fix.
    assert.match(m.refusal('operator-turn'), /LIVE/);
    assert.doesNotMatch(m.refusal('operator-turn'), /DEBUG MODE/);
    m.enterDebug('x');
    assert.match(m.refusal('day-turn'), /DEBUG MODE/);
    dream();
    assert.match(m.refusal('day-turn'), /DREAMING/);
    assert.match(m.refusal('day-turn'), /a nightly pass/);
  });
});

describe('keeping', () => {
  it('leaves the tree changed', () => {
    m.enterDebug('keep');
    writeFileSync(FILE(), `${row('demo/alpha')}\n${row('demo/eps')}\n`);
    m.exitDebug({ rollback: false });
    assert.match(readFileSync(FILE(), 'utf8'), /demo\/eps/);
    assert.equal(m.currentMode(), 'live');
  });

  it('asks for a context reset only when the graph actually moved', () => {
    // A debug session that changed nothing must not cost the concierge its
    // context — that would make entering debug to LOOK at something expensive,
    // and an expensive inspection is one nobody performs.
    m.enterDebug('read-only session');
    const r = m.exitDebug({ rollback: false })!;
    assert.equal(r.writes.length, 0);
    assert.equal(r.contextReset, false);
  });
});
