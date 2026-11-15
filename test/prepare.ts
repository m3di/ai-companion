import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Snapshot the live database for the test run.
 *
 * The suite reads real state — `entity_state` is what the hand-edit lint rule
 * checks a file against — so a fixture DB would make the golden test pass on
 * data nobody has. But `loadGraph()` also WRITES (it rebuilds the derived entity
 * index on a clean parse), and a test run must not touch the running bot's
 * database. So: a consistent copy, and DB_PATH pointed at it.
 *
 * `VACUUM INTO` rather than a file copy, because the live DB is in WAL mode and
 * the newest rows live in the -wal sidecar, not the main file.
 */
const src = resolve(process.env.LIVE_DB_PATH || 'data/companion.db');
const dst = resolve(process.env.DB_PATH || 'data/tmp/test.db');

/**
 * THE GUARD THAT SHOULD HAVE BEEN HERE FROM THE START.
 *
 * This script DELETES `dst` before writing the snapshot, and `dst` comes from
 * an ambient environment variable. On 2026-08-02 that variable was
 * `DB_PATH=data/companion.db` — the value `.env` sets for the running bot — and
 * it reached here because the nightly audit shells out to `npm test` with the
 * bot's own environment. The first line of the test suite deleted the live
 * database: 5,491 messages, 48 sessions, 48 dreams. It was recoverable only
 * because a backup happened to be four minutes old.
 *
 * Three things now stop it, at three layers, because one is how this happened:
 * `npm test` sets DB_PATH for this script too, the audit scrubs the variable
 * out of the environment it hands to npm, and THIS refuses outright. A
 * destructive default that reads its target from the environment must verify
 * the target, not trust whoever set it.
 */
if (dst === src) {
  console.error(
    `[test] REFUSING TO RUN: DB_PATH resolves to the LIVE database (${dst}).\n` +
      `       This script deletes its destination. Set DB_PATH to a scratch path, e.g. data/tmp/test.db.`,
  );
  process.exit(1);
}

mkdirSync(dirname(dst), { recursive: true });
for (const f of [dst, `${dst}-wal`, `${dst}-shm`]) rmSync(f, { force: true });

if (!existsSync(src)) {
  console.log(`[test] no live db at ${src} — tests will run against an empty one`);
} else {
  const db = new Database(src, { readonly: true });
  db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  db.close();
  console.log(`[test] snapshot ${src} → ${dst}`);

  /**
   * SETTLE THE NIGHT IN THE SNAPSHOT.
   *
   * A night that has not been folded HOLDS THE DAY (src/night.ts), which is the
   * point of it — and it would hold the suite too. Every case that asserts an
   * ordinary `live` machine permits an ordinary day activity would go red
   * whenever the snapshot happened to be taken before that morning's fold,
   * i.e. exactly when someone runs the tests early.
   *
   * Settling it here is not papering over the gate: a resting test fixture is
   * one that owes nothing. The gate itself is asserted directly, by passing the
   * debt in, because it is ONE GLOBAL ROW and the files run in parallel.
   */
  const out = new Database(dst);
  out.exec(`CREATE TABLE IF NOT EXISTS night_settled (
    boundary TEXT PRIMARY KEY, settled_at TEXT NOT NULL, how TEXT NOT NULL, note TEXT
  )`);
  const b = new Date();
  b.setHours(Number(process.env.NIGHTLY_HOUR ?? 4), 0, 0, 0);
  if (b.getTime() > Date.now()) b.setDate(b.getDate() - 1);
  out
    .prepare('INSERT OR REPLACE INTO night_settled (boundary, settled_at, how, note) VALUES (?, ?, ?, ?)')
    .run(b.toISOString().slice(0, 19).replace('T', ' '), new Date().toISOString().slice(0, 19).replace('T', ' '), 'dreamt', 'test fixture');
  /*
   * The work-mode lock and the debug session are machine state, not data: a
   * snapshot taken WHILE a pass holds the machine carries the live
   * `dream_phase` row, and every test that reads the mode then sees DREAMING
   * and refuses — red exactly when the night runs the suite, green by day
   * (finding #30, filed 08-08; reproduced 08-26 by a reviewer's run). A
   * fixture is a resting machine: live, nobody holding it.
   */
  const has = (t: string) => out.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (has('dream_phase')) out.exec('DELETE FROM dream_phase');
  if (has('debug_session')) out.exec('DELETE FROM debug_session');
  out.close();
}
