import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * SCHEMA MIGRATIONS UNDER CONCURRENCY.
 *
 * Every `ADD COLUMN` here was check-then-act, which is safe in one process and
 * a coin flip across several — and the suite itself runs one process per test
 * file against one database. Two of them reaching the same migration together
 * meant one threw `duplicate column name` and took a whole file down with it:
 * on 2026-08-02 the suite failed 4 runs out of 8, always somewhere different.
 *
 * A flaky suite is worse than a red one, because it teaches everyone to re-run
 * instead of to look — and it is exactly what M2's audit would report as a red
 * suite every other night, burning the one signal that is supposed to outrank
 * everything else.
 *
 * This reproduces the race rather than testing the guard's internals: several
 * processes open a brand-new database at once, and all of them must survive.
 */

const PROCESSES = 6;

function bootDb(dbPath: string): Promise<{ code: number; err: string }> {
  return new Promise((res) => {
    execFile(
      'npx',
      ['tsx', '-e', "import('./src/db.js').then(() => process.exit(0))"],
      { cwd: process.cwd(), env: { ...process.env, DB_PATH: dbPath }, timeout: 60_000 },
      (e, _out, stderr) => res({ code: e ? 1 : 0, err: stderr }),
    );
  });
}

describe('schema migrations', () => {
  it('survive several processes opening a fresh database at once', async (t) => {
    t.diagnostic(`${PROCESSES} concurrent opens`);
    const dir = mkdtempSync(join(tmpdir(), 'companion-schema-'));
    try {
      const results = await Promise.all(Array.from({ length: PROCESSES }, () => bootDb(join(dir, 'race.db'))));
      const failed = results.filter((r) => r.code !== 0);
      assert.deepEqual(
        failed.map((f) => f.err.split('\n').find((l) => /Error/.test(l)) ?? 'unknown'),
        [],
        'every process must reach a usable schema — losing an ALTER TABLE race is not a failure',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
