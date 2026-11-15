import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  addCommitment,
  appendWatchLog,
  dueCommitments,
  LEDGER_ROWS_PER_ITEM,
  ledgerAck,
  ledgerHeads,
  ledgerLog,
  listCommitments,
  openFocusChanges,
  resolveCommitment,
  setWatchMode,
} from '../src/db.js';
import { checkItem } from '../src/focus.js';
import { evalPredicate, parseEmission, parsePredicate, shouldWake, validateWatchMode } from '../src/ledger.js';

/**
 * THE LEDGER (design proposal #1). A check gets memory and the wake becomes a
 * predicate the concierge authors. The contract under test: a JSON-emitting
 * check writes a head and a log; the first head is a baseline, never news; a
 * 'log' item never wakes however much it moves; a predicate item wakes only
 * when the predicate holds on a head that moved; a log-mode item is never in
 * the due set the pulse reads; and the log converges.
 */

const CHAT = -777_002;
const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
const made: number[] = [];
after(() => {
  for (const id of made) resolveCommitment(id, CHAT, 'dropped', 'test fixture');
});

function fixture(name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}
function watched(label: string, file: string, mode?: string): number {
  const id = addCommitment(CHAT, label, `watching ${label}`, '2000-01-01 00:00:00', { howToCheck: 'cat it', checkCmd: `cat ${file}`, focus: 2 });
  if (mode !== undefined) setWatchMode(id, CHAT, mode);
  made.push(id);
  return id;
}
const rec = (id: number) => listCommitments(CHAT).find((c) => c.id === id)!;

describe('ledger: the predicate grammar', () => {
  it('parses clauses, && binds tighter than ||, and evaluates totally', () => {
    const p = parsePredicate('consecutive_fails >= 3 && status != "green" || head.code == 503');
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(p.pred.length, 2);
    assert.equal(evalPredicate(p.pred, { consecutive_fails: 3, status: 'red' }), true);
    assert.equal(evalPredicate(p.pred, { consecutive_fails: 3, status: 'green' }), false);
    assert.equal(evalPredicate(p.pred, { head: { code: 503 } }), true);
    assert.equal(evalPredicate(p.pred, {}), false, 'missing fields never throw');
    assert.equal(evalPredicate(p.pred, null), false);
    const q = parsePredicate('x > 1');
    assert.ok(q.ok);
    if (q.ok) assert.equal(evalPredicate(q.pred, { x: 'str' }), false, 'ordering over a non-number is false');
  });
  it('refuses what it cannot read, at authoring time', () => {
    assert.equal(validateWatchMode('log'), undefined);
    assert.equal(validateWatchMode(''), undefined);
    assert.equal(validateWatchMode('status == "red"'), undefined);
    assert.match(validateWatchMode('status = red')!, /cannot read/);
    assert.match(validateWatchMode('(a > 1)')!, /cannot read/);
    assert.match(validateWatchMode('a > 1; rm -rf /')!, /cannot read/);
  });
  it('shouldWake: null = on change, log = never, predicate = when it holds', () => {
    assert.deepEqual(shouldWake(null, true, {}), { wake: true });
    assert.deepEqual(shouldWake(null, false, {}), { wake: false });
    assert.deepEqual(shouldWake('log', true, { status: 'red' }), { wake: false });
    assert.deepEqual(shouldWake('status == "red"', true, { status: 'red' }), { wake: true });
    assert.deepEqual(shouldWake('status == "red"', true, { status: 'green' }), { wake: false });
    const bad = shouldWake('status === red', true, { status: 'red' });
    assert.equal(bad.wake, false);
    assert.match(bad.error!, /cannot read/);
  });
  it('parseEmission accepts {head} and rejects plain text or a bare object', () => {
    assert.deepEqual(parseEmission('{"head":{"a":1},"detail":{"x":2}}'), { head: { a: 1 }, detail: { x: 2 } });
    assert.deepEqual(parseEmission(' {"head":{"a":1}} '), { head: { a: 1 } });
    assert.equal(parseEmission('OPEN'), undefined);
    assert.equal(parseEmission('{"a":1}'), undefined);
    assert.equal(parseEmission('{"head":[1]}'), undefined);
  });
});

describe('ledger: a JSON-emitting check', () => {
  it('first head is a baseline; a log-mode item never wakes however much it moves', async () => {
    const f = fixture('log.json', { head: { fails: 0 }, detail: { note: 'first' } });
    const id = watched('log-item', f, 'log');
    assert.equal(await checkItem(rec(id)), false);
    assert.deepEqual(ledgerHeads(CHAT).find((h) => h.id === id)?.head, { fails: 0 });
    assert.equal(ledgerLog(id).length, 1);
    assert.equal(ledgerLog(id)[0]!.kind, 'baseline');
    writeFileSync(f, JSON.stringify({ head: { fails: 9, status: 'red' }, detail: { note: 'boom' } }));
    assert.equal(await checkItem(rec(id)), false, 'log mode never escalates');
    assert.equal(ledgerLog(id)[0]!.kind, 'change');
    assert.equal(openFocusChanges(id).length, 0);
    assert.equal(ledgerHeads(CHAT).find((h) => h.id === id)?.unseen, 2);
    assert.equal(ledgerAck(id), 2);
    assert.equal(ledgerHeads(CHAT).find((h) => h.id === id)?.unseen, 0);
    assert.ok(!dueCommitments().some((c) => c.id === id), 'a log-mode item is never in the pulse\'s due set');
  });

  it('a predicate item wakes only when the predicate holds on a head that moved', async () => {
    const f = fixture('pred.json', { head: { fails: 0 } });
    const id = watched('pred-item', f, 'fails >= 3');
    assert.equal(await checkItem(rec(id)), false, 'baseline');
    writeFileSync(f, JSON.stringify({ head: { fails: 1 } }));
    assert.equal(await checkItem(rec(id)), false, 'moved, predicate false');
    writeFileSync(f, JSON.stringify({ head: { fails: 3 } }));
    assert.equal(await checkItem(rec(id)), true, 'moved, predicate true');
    const ch = openFocusChanges(id);
    assert.equal(ch.length, 1);
    assert.equal(ch[0]!.before, '{"fails":1}');
    assert.equal(ch[0]!.after, '{"fails":3}');
    assert.equal(await checkItem(rec(id)), false, 'still true but unchanged: one alert, not one per sweep');
  });

  it('with no mode, a changed head wakes like a changed text did', async () => {
    const f = fixture('plain.json', { head: { state: 'OPEN' } });
    const id = watched('wake-item', f);
    assert.equal(await checkItem(rec(id)), false);
    writeFileSync(f, JSON.stringify({ head: { state: 'MERGED' } }));
    assert.equal(await checkItem(rec(id)), true);
  });

  it('the log converges: rows per item are capped', () => {
    const id = watched('cap-item', fixture('cap.json', { head: {} }), 'log');
    for (let i = 0; i < LEDGER_ROWS_PER_ITEM + 25; i++) appendWatchLog(id, 'sample', { i });
    assert.equal(ledgerLog(id, 200).length, LEDGER_ROWS_PER_ITEM);
    assert.deepEqual(JSON.parse(ledgerLog(id, 1)[0]!.payload), { i: LEDGER_ROWS_PER_ITEM + 24 });
  });
});
