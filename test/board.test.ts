import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPatches, autoItems, buildBoard, commitmentTitle, localDay, parseBoardDay, renderBoard } from '../src/board.js';
import type { BoardCommitment, BoardPatch, LifeItem } from '../src/db.js';
import { toUtcDb } from '../src/commitments.js';

/**
 * THE BOARD (proposal #7, Mehdi's reshape of 2026-11-13). Under test: the
 * automatic layer exists with no agent at all; the day session's patches fix
 * it — move, relabel, hide, add — and never erase it; a hidden item is still
 * reported; a session is a span, not a point; never-logged chores are named,
 * not drawn.
 */

// A Friday (off day) at 16:30 local.
const NOW = new Date(2026, 10, 13, 16, 30);
const at = (off: number, h: number, m = 0) => toUtcDb(new Date(2026, 10, 13 + off, h, m));
const chore = (id: string, tier: 1 | 2, days: number, lastOff: number | null): LifeItem => ({
  id, label: id, tier, days, weight: 1, aka: [], last_at: lastOff === null ? null : at(lastOff, 12),
});
const C = (id: number, body: string, due: string, recur: string | null = null): BoardCommitment => ({ id, label: `c-${id}`, body, due_at: due, recur });
const P = (id: number, p: Partial<BoardPatch> & Pick<BoardPatch, 'op' | 'reason'>): BoardPatch => ({
  id, target: null, day: null, day_to: null, at: null, until: null, kind: null, label: null, ref: null, created_at: '', ...p,
});
const today = localDay(NOW);

describe('board: the automatic layer, with no agent', () => {
  const { items, noData } = autoItems(
    [C(1, 'Dentist at the clinic. Booked Wednesday.', at(0, 15)), C(2, 'Review block — batch PRs.', at(2, 9), 'weekly'), C(3, 'Old thing.', at(-3, 9))],
    [chore('vacuum', 2, 7, -10), chore('fridge', 2, 30, -5), chore('teeth', 1, 1, -1), chore('windows', 2, 60, null)],
    NOW,
  );

  it('shows dated commitments in the week, titled by their first sentence', () => {
    const dent = items.find((i) => i.key === `commitment:1@${today}`)!;
    assert.equal(dent.label, 'Dentist at the clinic');
    assert.equal(dent.at, '15:00');
    assert.ok(!items.some((i) => i.key.startsWith('commitment:3')), 'a commitment due before the week is not drawn');
    assert.equal(items.filter((i) => i.key.startsWith('commitment:2@')).length, 1, 'a weekly commitment appears once in seven days');
  });

  it('carries an overdue chore into today, and leaves daily basics and never-logged chores off the line', () => {
    const vac = items.find((i) => i.ref === 'life:vacuum')!;
    assert.equal(vac.day, today);
    assert.match(vac.why, /overdue/);
    assert.equal(vac.at, '11:00', 'off day: late morning');
    assert.ok(!items.some((i) => i.ref === 'life:teeth'));
    assert.deepEqual(noData, ['windows']);
  });

  it('draws the work block on work days only', () => {
    assert.ok(!items.some((i) => i.key === `work@${today}`), 'Friday is off');
    assert.ok(items.some((i) => i.kind === 'work' && i.day === localDay(new Date(2026, 10, 15))));
  });
});

describe('board: the day session fixes, it does not replace', () => {
  const auto = autoItems([C(1, 'Call with Sasha.', at(1, 11, 30)), C(2, 'Nudge him about photos.', at(0, 20))], [], NOW).items;
  const days = Array.from({ length: 7 }, (_, i) => localDay(new Date(2026, 10, 13 + i)));
  const tomorrow = days[1]!;

  it('an adjust moves an automatic item and keeps its source and reason', () => {
    const r = applyPatches(auto, [P(1, { op: 'adjust', target: `commitment:1@${tomorrow}`, at: '12:00', reason: 'moved in the thread' })], days);
    const it = r.items.find((i) => i.key === `commitment:1@${tomorrow}`)!;
    assert.equal(it.at, '12:00');
    assert.equal(it.source, 'auto');
    assert.equal(it.adjusted?.reason, 'moved in the thread');
  });

  it('a hide removes it from the line but reports it, and the latest patch on a target wins', () => {
    const r = applyPatches(auto, [
      P(1, { op: 'adjust', target: `commitment:2@${today}`, at: '19:00', reason: 'x' }),
      P(2, { op: 'hide', target: `commitment:2@${today}`, reason: 'a bot reminder' }),
    ], days);
    assert.ok(!r.items.some((i) => i.key === `commitment:2@${today}`));
    assert.equal(r.hidden[0]?.reason, 'a bot reminder');
  });

  it('an add is a point; an add with day_to is a tier-3 span', () => {
    const r = applyPatches(auto, [
      P(3, { op: 'add', day: today, at: '17:30', kind: 'appointment', label: 'Photos', reason: 'agreed this morning' }),
      P(4, { op: 'add', day: days[3]!, day_to: days[5]!, kind: 'session', label: 'Trip', reason: 'tier 3' }),
    ], days);
    assert.equal(r.items.find((i) => i.key === 'day:3')?.source, 'day');
    assert.equal(r.spans[0]?.label, 'Trip');
    assert.ok(!r.items.some((i) => i.key === 'day:4'), 'a span is never a point on the line');
  });

  it('a patch whose target is gone is moot, not an error', () => {
    const r = applyPatches(auto, [P(5, { op: 'hide', target: 'commitment:999@2026-11-13', reason: 'x' })], days);
    assert.equal(r.items.length, auto.length);
  });
});

describe('board: what the concierge reads', () => {
  it('names every item by key, and reports hidden items and sessions', () => {
    const b = buildBoard(
      [C(9001, 'Checkup at the clinic.', at(0, 15)), C(9002, 'Evening reminder.', at(2, 20))],
      [chore('vacuum', 2, 7, -10)],
      [
        P(1, { op: 'hide', target: `commitment:9002@${localDay(new Date(2026, 10, 15))}`, reason: 'a reminder, not something attended' }),
        P(2, { op: 'add', day: localDay(new Date(2026, 10, 16)), day_to: localDay(new Date(2026, 10, 18)), kind: 'session', label: 'Trip', reason: 'spans these days' }),
      ],
      NOW,
    );
    const txt = renderBoard(b);
    assert.match(txt, /key=commitment:9001@/);
    assert.match(txt, /HIDDEN by you/);
    assert.match(txt, /SESSIONS \(tier 3\)/);
    assert.equal(b.days.length, 7);
  });

  it('parses the days a concierge says', () => {
    assert.equal(parseBoardDay('today', NOW), today);
    assert.equal(parseBoardDay('tomorrow', NOW), localDay(new Date(2026, 10, 14)));
    assert.equal(parseBoardDay('Tuesday', NOW), localDay(new Date(2026, 10, 17)));
    assert.equal(parseBoardDay('fri', NOW), today);
    assert.equal(parseBoardDay('someday', NOW), undefined);
  });

  it('titles a commitment from its body, falling back to the label', () => {
    assert.equal(commitmentTitle(C(1, '[CHECK-IN] Runs as a concierge turn.', at(0, 9))), 'Runs as a concierge turn');
    assert.equal(commitmentTitle({ ...C(2, 'x'.repeat(120), at(0, 9)), label: 'long-thing' }), 'long thing');
  });

  it('builds with no patches and no commitments — the empty week is still a week', () => {
    const b = buildBoard([], [], [], NOW);
    assert.equal(b.days.length, 7);
    assert.equal(b.days[0]!.items.length, 0);
  });
});
