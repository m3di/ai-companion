import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';

/**
 * THE LOCK THAT TOOK THE BOT DOWN TWICE.
 *
 * Fifty lines of Set and Map, and both outages came from the same blind spot: a
 * session can hold the lock in a state where there is nothing to abort. On
 * 2026-08-06 that state ate a morning of messages — every one got the queued-👀
 * and no reply, while `/cancel` answered "Nothing is running" and the only
 * escape was restarting the process (I8).
 *
 * So the property under test is not "cancel aborts things". It is **release is
 * reachable from every state**, including the one with no controller.
 *
 * Since 2026-08-27 the queue is a table (turn_queue), so this file has its own
 * database: `__resetForTest` clears that table whole, and the suite runs files
 * in parallel against one scratch DB.
 */

const dir = mkdtempSync(join(tmpdir(), 'turnlock-'));
process.env.DB_PATH = join(dir, 'turnlock-test.db');
process.env.KNOWLEDGE_DIR = join(dir, 'kb');

type Lock = typeof import('../src/turnLock.js');
let lock: Lock;

const A = '1:-1';
const B = '1:7';

before(async () => {
  lock = await import('../src/turnLock.js');
});

beforeEach(() => lock.__resetForTest());

describe('the turn lock', () => {
  it('grants one holder and queues the rest', () => {
    assert.equal(lock.acquire(A), true);
    assert.equal(lock.acquire(A), false, 'the lock was granted twice');
    assert.equal(lock.acquire(B), true, 'a different session was blocked by an unrelated lock');
  });

  it('releases a lock held with NOTHING TO ABORT — the 2026-08-06 state', () => {
    lock.acquire(A); // held, but the turn never got as far as registering
    assert.equal(lock.isAbortable(A), false);

    assert.equal(lock.cancel(A), false, 'reported an abort it could not have performed');
    assert.equal(lock.isBusy(A), false, 'THE BUG: the lock stayed held after cancel');
    assert.equal(lock.acquire(A), true, 'the next message still could not start a turn');
  });

  it('aborts a live turn and releases it', () => {
    lock.acquire(A);
    const c = new AbortController();
    lock.register(A, c);
    assert.equal(lock.cancel(A), true);
    assert.equal(c.signal.aborted, true);
    assert.equal(lock.isBusy(A), false);
  });

  it('cancelPrefix visits stuck sessions, not just abortable ones', () => {
    lock.acquire(A); // stuck in setup, no controller
    lock.acquire(B);
    lock.register(B, new AbortController());

    const { aborted, released } = lock.cancelPrefix('1:');
    assert.equal(aborted, 1, 'the live turn was not aborted');
    assert.equal(released, 1, 'the STUCK session was never visited — the second half of the bug');
    assert.deepEqual(lock.lockState(), []);
  });

  it('leaves other chats alone', () => {
    lock.acquire('1:-1');
    lock.acquire('2:-1');
    lock.cancelPrefix('1:');
    assert.equal(lock.isBusy('2:-1'), true, 'cancelling one chat freed another');
  });

  it('drops the queue on CANCEL, so nothing replays into a turn the person stopped', () => {
    lock.acquire(A);
    lock.enqueue(A, { text: 'one', visible: true });
    lock.enqueue(A, { text: 'two', visible: true });
    assert.equal(lock.lockState()[0]!.queued, 2);
    lock.cancel(A);
    assert.equal(lock.dequeue(A), undefined);
  });

  it('keeps the queue on RELEASE — a finished or thrown turn does not cost the messages behind it', () => {
    lock.acquire(A);
    lock.enqueue(A, { text: 'one', visible: true });
    lock.enqueue(A, { text: 'two', visible: true });
    lock.release(A);
    assert.equal(lock.isBusy(A), false);
    assert.equal(lock.dequeue(A)?.text, 'one', 'THE 2026-08-27 BUG: release deleted the queue');
    assert.equal(lock.dequeue(A)?.text, 'two');
  });

  it('dequeues in arrival order', () => {
    lock.acquire(A);
    lock.enqueue(A, { text: 'first', visible: true });
    lock.enqueue(A, { text: 'second', visible: true });
    assert.equal(lock.dequeue(A)?.text, 'first');
    assert.equal(lock.dequeue(A)?.text, 'second');
    assert.equal(lock.dequeue(A), undefined);
  });

  it('reports a stuck lock distinguishably in lockState', () => {
    lock.acquire(A);
    lock.acquire(B);
    lock.register(B, new AbortController());
    const rows = Object.fromEntries(lock.lockState().map((r) => [r.key, r.abortable]));
    assert.equal(rows[A], false, 'a setup-stuck lock must be visible as such');
    assert.equal(rows[B], true);
  });

  it('release is idempotent', () => {
    lock.acquire(A);
    lock.release(A);
    assert.doesNotThrow(() => lock.release(A));
    assert.equal(lock.isBusy(A), false);
  });
});

describe('runOrQueue — the holder drains, and a throw does not end the drain', () => {
  it('runs now when idle and queues when held; the sync prefix decides, before any await', async () => {
    const ran: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => (releaseFirst = res));
    const run = async (t: { text: string }) => {
      ran.push(t.text);
      if (t.text === 'first') await gate;
    };
    // Fired without awaiting between them — exactly how recoverAfterRestart
    // fans out: the first call must take the lock before the second looks.
    const p1 = lock.runOrQueue(A, { text: 'first', visible: true }, run);
    const p2 = lock.runOrQueue(A, { text: 'second', visible: true }, run);
    const p3 = lock.runOrQueue(A, { text: 'third', visible: true }, run);
    assert.equal(await p2, false, 'the second call ran instead of queueing');
    assert.equal(await p3, false);
    assert.equal(lock.lockState()[0]!.queued, 2, 'the queued turns were not written back as rows');
    assert.deepEqual(ran, ['first'], 'a queued turn ran before the holder finished');
    releaseFirst();
    assert.equal(await p1, true);
    assert.deepEqual(ran, ['first', 'second', 'third'], 'the holder did not drain in order');
    assert.equal(lock.isBusy(A), false);
    assert.equal(lock.dequeue(A), undefined);
  });

  it('a turn that throws mid-drain is logged and the rest still run', async () => {
    const ran: string[] = [];
    const run = async (t: { text: string }) => {
      if (t.text === 'boom') throw new Error('a send that gave up');
      ran.push(t.text);
    };
    lock.acquire(A);
    lock.enqueue(A, { text: 'boom', visible: true });
    lock.enqueue(A, { text: 'after the throw', visible: true });
    lock.release(A);
    const ok = await lock.runOrQueue(A, { text: 'start', visible: true }, run);
    assert.equal(ok, true);
    assert.deepEqual(ran, ['start', 'after the throw'], 'THE 2026-08-27 SCENARIO: the messages behind the throw were lost');
    assert.equal(lock.isBusy(A), false);
  });

  it('releases the lock even when the FIRST turn throws, with the queue intact for the drain', async () => {
    const seen: string[] = [];
    const run = async (t: { text: string }) => {
      seen.push(t.text);
      if (t.text === 'first') throw new Error('view.begin() failed');
    };
    const p1 = lock.runOrQueue(A, { text: 'first', visible: true }, run);
    const p2 = lock.runOrQueue(A, { text: 'second', visible: true }, run);
    await Promise.all([p1, p2]);
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal(lock.isBusy(A), false);
  });
});
