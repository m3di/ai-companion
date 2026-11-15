import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Entity } from '../src/entities.js';
import { memoryCue, namesInText } from '../src/recall.js';

/**
 * THE MEMORY CUE resolves what a message NAMES — ids, aliases, task and PR
 * numbers — and nothing it does not. Pure over a hand-built set, so a false
 * positive is a test failure and not a cue Mehdi learns to skim.
 */

const ent = (id: string, aka: string[] = [], extra: Partial<Entity> = {}): Entity =>
  ({ id, domain: id.split('/')[0]!, kind: 'task', aka, facts: ['x'], edges: {}, status: 'open', dormant: false, goal: false, chain: [], file: '', line: 0, factsLine: 0, edgesLine: 0, ...extra }) as Entity;

const ES = [
  ent('core-api/ewallet-vertical-persist-1299', ['#1299', 'ewallet vertical bug']),
  ent('core-api/tiered-commission-plans', ['TCP', '#2579']),
  ent('client-onboarding/wingwallet', ['WW', 'Wingwallet']),
  ent('personal/daily-quest-system', ['quest system', 'daily quests']),
  ent('people/nora', ['Nora']),
  ent('people/mehdi', ['Mehdi']),
  ent('personal/car-service', ['car service', 'service check']),
];

const ids = (t: string) => namesInText(t, ES).map((n) => n.id);

describe('the memory cue', () => {
  it('matches ids, aliases and numbers the way people type them', () => {
    assert.deepEqual(ids('what about #1299, is the ewallet thing fixed?'), ['core-api/ewallet-vertical-persist-1299']);
    assert.deepEqual(ids('task 1299 again'), ['core-api/ewallet-vertical-persist-1299']);
    assert.deepEqual(ids('lets talk about the quest system and my car service'), ['personal/daily-quest-system', 'personal/car-service']);
    assert.deepEqual(ids('Nora asked about TCP'), ['core-api/tiered-commission-plans', 'people/nora']);
    assert.deepEqual(ids('core-api/tiered-commission-plans is blocked'), ['core-api/tiered-commission-plans']);
  });

  it('does not fire on Mehdi, on lowercase versions of short all-caps aliases, or on substrings', () => {
    assert.deepEqual(ids('Mehdi here, good morning'), []);
    assert.deepEqual(ids('the tcp handshake failed on www'), [], 'tcp/ww in lowercase are not the aliases');
    assert.deepEqual(ids('a questionnaire about wingwallets'), [], 'quest inside questionnaire, WW inside a word');
  });

  it('cues a hub only when nothing more specific is named', () => {
    const g = { entities: new Map([...ES, ent('core-api/system', ['Core-API'], { kind: 'system' })].map((e) => [e.id, e])) } as unknown as Parameters<typeof memoryCue>[1];
    assert.deepEqual(memoryCue('tell me about Core-API', g)?.refs, ['core-api/system']);
    assert.deepEqual(memoryCue('Core-API: is #1299 fixed?', g)?.refs, ['core-api/ewallet-vertical-persist-1299']);
    assert.match(memoryCue('is #1299 fixed?', g)!.line, /find\(id\)/);
    assert.equal(memoryCue('ok thanks', g), undefined);
  });

  it('is silent on a message that names nothing', () => {
    assert.deepEqual(ids('ok thanks'), []);
    assert.deepEqual(ids(''), []);
  });
});
