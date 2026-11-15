import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as D from '../src/db.js';
import { datedBlock, datedCue, datedForPass, datedTally, decideDated, offerDated } from '../src/dated.js';
import { todayLine } from '../src/concierge.js';

const raw = new Database(process.env.DB_PATH!);
const CHAT = 424242;

// The real shapes of 2026-10-03 (Saturday), local time — the departure day
// agreed in the chat and lost by the night.
test('dated: the Lisbon messages resolve to the day they name', () => {
  const sat = '2026-10-03 15:34';
  assert.deepEqual(datedCue('if Riverside Forum is my only option then i have to do it tomorrow', sat), { cue: 'tomorrow', day: '2026-10-04' });
  assert.deepEqual(datedCue("ok now let's get the return ticket for tomorrow i have to return the room at 12:00", sat), { cue: 'tomorrow', day: '2026-10-04' });
  assert.deepEqual(datedCue('ok got the ticket Skylark 18:25', sat), { cue: '18:25', day: null });
  assert.deepEqual(datedCue('the Sunday brief', sat), { cue: 'Sunday', day: '2026-10-04' });
  assert.deepEqual(datedCue('Saturday again', sat), { cue: 'Saturday', day: '2026-10-10' });
  assert.deepEqual(datedCue('file before 9 Oct', sat), { cue: '9 Oct', day: '2026-10-09' });
  assert.deepEqual(datedCue('standup on Oct 7', sat), { cue: 'Oct 7', day: '2026-10-07' });
  assert.deepEqual(datedCue('in 3 days', sat), { cue: 'in 3 days', day: '2026-10-06' });
  assert.deepEqual(datedCue('tonight we eat', sat), { cue: 'tonight', day: '2026-10-03' });
  assert.equal(datedCue('what was that sport shop for buying taekwondo dress', sat), null);
});

test('dated: offered once; verdicts only from the offered set; stamped rows count; cancelled rows go; unjudged rows carry', () => {
  raw.prepare('DELETE FROM dated_verdicts').run();
  raw.prepare('DELETE FROM messages WHERE session_key LIKE ?').run(`${CHAT}:%`);
  raw.prepare('DELETE FROM commitments WHERE chat_id = ?').run(CHAT);
  const key = `${CHAT}:-1`;
  // Messages land with created_at = now; the window is "the last hour".
  D.logMessage(key, 'user', 'movie moves to tomorrow 11:00 then the flight', 'human');
  D.logMessage(key, 'user', 'what about that sports shop', 'human');
  D.logMessage(key, 'assistant', 'tomorrow is fine', undefined);
  D.logMessage(key, 'user', '[PULSE] tomorrow is machine talk', 'machine');
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
  const to = D.dbNow();

  const rows = datedForPass(CHAT, hourAgo, to);
  assert.equal(rows.length, 1, 'only the human message naming a day');
  const id = rows[0]!.id;
  assert.equal(rows[0]!.cue, 'tomorrow');
  const block = datedBlock(CHAT, hourAgo, to, rows);
  assert.match(block, /WHAT MEHDI DATED/);
  assert.match(block, new RegExp(`msg #${id},`));
  assert.match(block, /NOTHING due that day/);

  offerDated(rows);
  offerDated(rows);
  const offered = raw.prepare("SELECT COUNT(*) AS n FROM dated_verdicts WHERE message_id = ? AND decision = 'offered'").get(id) as { n: number };
  assert.equal(offered.n, 1, 'a re-rendered window does not offer twice');

  const bad = decideDated(id + 1000, 'declined', 'x');
  assert.equal(bad.ok, false);
  assert.match((bad as { problem: string }).problem, new RegExp(`#${id}`), 'the refusal lists the valid rows');

  // Unjudged: the next pass carries it, marked.
  const later = new Date(Date.now() + 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const next = datedForPass(CHAT, later, later);
  assert.ok(next.some((s) => s.id === id && s.carried), 'an offered, unjudged row comes back carried');
  assert.match(datedBlock(CHAT, later, later, next), /STILL UNDECIDED/);

  assert.equal(decideDated(id, 'committed', '#1').ok, true);
  assert.equal(decideDated(id, 'declined', 'changed my mind').ok, true);
  const verdicts = raw.prepare("SELECT decision FROM dated_verdicts WHERE message_id = ? AND decision != 'offered'").all(id) as Array<{ decision: string }>;
  assert.deepEqual(verdicts.map((v) => v.decision), ['declined'], 'a pass that reconsiders overwrites itself');

  const t0 = datedTally('2000-01-01 00:00:00', D.dbNow());
  assert.equal(t0.declined, 0, 'unstamped verdicts do not count');
  assert.equal(t0.unlanded, 1);
  D.stampDatedVerdicts(999999, '2000-01-01 00:00:00');
  const t1 = datedTally('2000-01-01 00:00:00', D.dbNow());
  assert.equal(t1.declined, 1);
  assert.equal(t1.offered, 1);
  assert.equal(datedForPass(CHAT, later, later).length, 0, 'a judged row is not carried');

  // A cancelled pass takes its unstamped rows with it; stamped ones stay.
  const since = D.dbNow();
  D.recordDatedVerdict(id, 'tracked', 'cancelled pass');
  assert.equal(D.deleteUnstampedDatedVerdicts(since), 1);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM dated_verdicts').get() as { n: number }).n, 2);

  // The block names what the table already holds for the day.
  D.addCommitment(CHAT, 'departure-day', 'checkout 12:00, film 11:00, flight 18:25', '2099-01-02 05:00:00');
  const futureRow = { id: 1, at: '2099-01-01 10:00', text: 'tomorrow', cue: 'tomorrow', day: '2099-01-02' };
  const b = datedBlock(CHAT, hourAgo, to, [futureRow]);
  assert.match(b, /departure-day .*\(open\)/);
});

test('the snapshot day line names today and yesterday in local words', () => {
  const l = todayLine(new Date(2026, 9, 4, 8, 14));
  assert.match(l, /Today is Sunday 4 October 2026 — 08:14 local/);
  assert.match(l, /yesterday was Saturday 3 October 2026/);
  assert.match(l, /commitments due today ARE the plan/);
});
