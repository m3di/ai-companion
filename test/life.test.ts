import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addLifeItem, lifeItems, lifeLogCounts, lifeParams, logLifeDone, tuneLifeItem, type LifeItem } from '../src/db.js';
import { toUtcDb } from '../src/commitments.js';
import { buildLifeView, freshness, houseHealth, nextDue, parseDoneWhen, renderLifeState, resolveItem, tier1 } from '../src/life.js';

/**
 * LIFE UPKEEP (design proposal #7). Under test: freshness halves per
 * half-life; house health is the weighted mean of LOGGED tier-2 items only —
 * a never-logged item is excluded, not counted as zero; tier 1 is done inside
 * its cadence; a phrase resolves to exactly one item or none; a done-time is
 * past or refused; and tuning never resets on re-seed.
 */

const NOW = new Date('2026-11-13T12:00:00Z');
const daysAgo = (d: number) => toUtcDb(new Date(NOW.getTime() - d * 86_400_000));
const item = (id: string, tier: 1 | 2, days: number, last: number | null, weight = 1, aka: string[] = []): LifeItem => ({
  id,
  label: id,
  tier,
  days,
  weight,
  aka,
  last_at: last === null ? null : daysAgo(last),
});

describe('life: the derived numbers', () => {
  it('freshness halves every half-life', () => {
    assert.equal(freshness(0, 7), 1);
    assert.equal(freshness(7, 7), 0.5);
    assert.equal(freshness(14, 7), 0.25);
  });

  it('health is the weighted mean of logged items, and never-logged items are left out', () => {
    const h = houseHealth([item('vacuum', 2, 7, 7, 2), item('fridge', 2, 30, 0, 1), item('windows', 2, 60, null, 1)], NOW);
    assert.ok(Math.abs(h.health! - (2 * 0.5 + 1 * 1) / 3) < 1e-9);
    assert.equal(h.coverage, 3 / 4);
    assert.equal(h.lines.find((l) => l.item.id === 'windows')!.fresh, null);
  });

  it('no tier-2 data is "no data", not 0 %', () => {
    const h = houseHealth([item('vacuum', 2, 7, null)], NOW);
    assert.equal(h.health, null);
    assert.match(renderLifeState([item('vacuum', 2, 7, null)], { target: 0.85, threshold: 0.75 }, NOW), /no data yet/);
  });

  it('tier 1 is done inside its cadence and due after it', () => {
    const [teeth, haircut, bath] = tier1([item('teeth', 1, 1, 0.5), item('haircut', 1, 28, 30), item('bath', 1, 1, null)], NOW);
    assert.equal(teeth!.done, true);
    assert.equal(haircut!.done, false);
    assert.equal(bath!.done, false);
    assert.equal(bath!.age, null);
  });

  it('the render flags a house below threshold', () => {
    const txt = renderLifeState([item('vacuum', 2, 7, 21)], { target: 0.85, threshold: 0.75 }, NOW);
    assert.match(txt, /13% .*BELOW THRESHOLD/);
  });
});

describe('life: what he said, and when', () => {
  const items = [item('dishes', 1, 1, null, 1, ['sink', 'did the dishes']), item('vacuum', 2, 7, null, 1, ['vacuumed', 'dust']), item('stove', 2, 14, null, 1, ['oven'])];

  it('resolves by id, aka, or a whole word inside the phrase', () => {
    assert.equal(resolveItem(items, 'vacuumed')?.id, 'vacuum');
    assert.equal(resolveItem(items, 'Did the dishes')?.id, 'dishes');
    assert.equal(resolveItem(items, 'cleaned the oven')?.id, 'stove');
  });

  it('refuses what is ambiguous or unknown — never guesses', () => {
    assert.equal(resolveItem(items, 'laundry'), undefined);
    assert.equal(resolveItem(items, 'sink and oven'), undefined);
    assert.equal(resolveItem(items, 'dustbin'), undefined);
  });

  it('a done-time is past, or refused', () => {
    assert.equal(parseDoneWhen(undefined, NOW), toUtcDb(NOW));
    assert.equal(parseDoneWhen('-2h', NOW), toUtcDb(new Date(NOW.getTime() - 7_200_000)));
    assert.equal(parseDoneWhen('yesterday', NOW), toUtcDb(new Date(NOW.getTime() - 86_400_000)));
    assert.equal(parseDoneWhen('2099-01-01', NOW), undefined);
    assert.equal(parseDoneWhen('next tuesday', NOW), undefined);
    const hm = parseDoneWhen('23:59', NOW)!;
    assert.ok(new Date(`${hm.replace(' ', 'T')}Z`) <= NOW, 'HH:mm ahead of now means yesterday');
  });
});

describe('life: the store', () => {
  it('is seeded, logs, counts by source, and keeps a tuned value', () => {
    assert.ok(lifeItems().some((i) => i.id === 'vacuum' && i.tier === 2));
    const p = lifeParams();
    assert.ok(p.target > p.threshold);

    const id = `test-chore-${process.pid}`;
    assert.equal(addLifeItem(id, 'test chore', 2, 10, ['testchore']), true);
    assert.equal(addLifeItem(id, 'test chore', 2, 10, []), false, 'add never overwrites');
    const before = lifeLogCounts('2000-01-01 00:00:00');
    logLifeDone(id, toUtcDb(new Date()), 'voice');
    const after = lifeLogCounts('2000-01-01 00:00:00');
    assert.equal(after.voice, before.voice + 1);
    assert.equal(after.total, before.total + 1);
    assert.ok(lifeItems().find((i) => i.id === id)!.last_at);

    assert.equal(tuneLifeItem(id, 'days', 3), true);
    assert.equal(lifeItems().find((i) => i.id === id)!.days, 3);
    assert.equal(tuneLifeItem('no-such-chore', 'days', 3), false);
  });
});

describe('life: the view the Atlas draws', () => {
  it('a tier-2 chore is due at one half-life, not when it alone crosses the house threshold', () => {
    const due = nextDue(item('vacuum', 2, 7, 3), NOW);
    assert.equal(Math.round((due.getTime() - NOW.getTime()) / 86_400_000), 4);
  });

  it('daily basics are not reminder dots on future days', () => {
    const v = buildLifeView([item('teeth', 1, 1, 0.2), item('haircut', 1, 28, 27)], [], { target: 0.85, threshold: 0.75 }, NOW);
    assert.ok(v.days.slice(1).every((d) => !d.due.includes('teeth')));
    assert.ok(v.days.some((d) => d.due.includes('haircut')));
  });
});
