import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimInstance, runningInstance } from '../src/instance.js';

const dir = () => mkdtempSync(join(tmpdir(), 'companion-lock-'));

describe('one bot per machine — I8/I9', () => {
  it('a stale pid file (process gone) is not a holder', () => {
    const f = join(dir(), 'bot.pid');
    writeFileSync(f, JSON.stringify({ pid: 2 ** 22 - 7, since: 'x' })); // no such pid
    assert.equal(runningInstance(f), undefined);
  });

  it('an unreadable pid file is not a holder', () => {
    const f = join(dir(), 'bot.pid');
    writeFileSync(f, 'garbage');
    assert.equal(runningInstance(f), undefined);
  });

  it('a live holder is named, and the lock is released by the owner only', () => {
    const f = join(dir(), 'bot.pid');
    const release = claimInstance(f);
    const held = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(held.pid, process.pid);
    // our own pid never blocks ourselves (a restart under the same pid is impossible; a re-read must not self-refuse)
    assert.equal(runningInstance(f), undefined);
    // another live process holding the file IS a holder
    writeFileSync(f, JSON.stringify({ pid: process.ppid, since: 'now' }));
    assert.equal(runningInstance(f)?.pid, process.ppid);
    release(); // not ours any more → left alone
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, process.ppid);
  });
});
