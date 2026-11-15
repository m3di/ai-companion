import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { emitTurn, getTurn, onTurn, runningTurn, startTurn } from '../src/agentTurns.js';

/**
 * A TURN IN FLIGHT, and the one property that makes it worth a separate channel
 * from the pulse bus: NOTHING IS INFERRED FROM WHO WAS LISTENING.
 *
 * The pulse bus is lossy on purpose and its own header forbids anything
 * load-bearing riding on it — a dropped pulse costs an animation frame. A
 * dropped delta costs a sentence out of the middle of an answer, and the reader
 * cannot tell a lossy answer from a complete one. So every fragment is
 * appended to a buffer as well as published, and a client that connects late or
 * reconnects mid-turn recovers the whole answer so far.
 */

let next = 1000;
/** A turn id nobody else is using. Every case ENDS the turn it starts:
 *  `runningTurn` scans the whole registry, so a leaked running turn from an
 *  earlier case is indistinguishable from the one under test. */
const fresh = () => next++;

describe('a turn while it is happening', () => {
  it('accumulates the answer for a listener that was not there', () => {
    const id = fresh();
    startTurn(id, 'q');
    emitTurn(id, { kind: 'delta', text: 'Hello ' });
    emitTurn(id, { kind: 'delta', text: 'world' });
    // Nobody subscribed for either fragment, which is exactly the case the
    // pulse bus cannot serve: a page opened one second after the ask.
    assert.equal(getTurn(id)?.text, 'Hello world');
    emitTurn(id, { kind: 'done', text: 'Hello world' });
  });

  it('publishes to a listener AND buffers, never one without the other', () => {
    const id = fresh();
    startTurn(id, 'q');
    const seen: string[] = [];
    const off = onTurn(id, (ev) => ev.kind === 'delta' && seen.push(ev.text));
    emitTurn(id, { kind: 'delta', text: 'a' });
    emitTurn(id, { kind: 'delta', text: 'b' });
    off();
    emitTurn(id, { kind: 'delta', text: 'c' });
    assert.deepEqual(seen, ['a', 'b']);
    // The unsubscribed fragment still landed. A listener that got something the
    // buffer never saw — or the reverse — would make two clients disagree about
    // the same turn.
    assert.equal(getTurn(id)?.text, 'abc');
    emitTurn(id, { kind: 'done', text: 'abc' });
  });

  it('collects reached nodes in order, without repeats', () => {
    const id = fresh();
    startTurn(id, 'q');
    emitTurn(id, { kind: 'step', step: 'find(a/one)', refs: ['a/one'] });
    emitTurn(id, { kind: 'step', step: 'neighbours(a/one)', refs: ['a/one', 'b/two'] });
    // This list IS the growing footprint on the graph, so a node re-read must
    // not enter it twice — the order is "when it was first touched".
    assert.deepEqual(getTurn(id)?.reached, ['a/one', 'b/two']);
    emitTurn(id, { kind: 'done', text: '' });
  });

  it('lets the finished text win over the accumulated deltas', () => {
    const id = fresh();
    startTurn(id, 'q');
    emitTurn(id, { kind: 'delta', text: 'partial' });
    emitTurn(id, { kind: 'done', text: 'the whole answer', costUsd: 0.1 });
    // They should be identical, and where they are not, the reader must see the
    // one the run row stores. Two accounts of the same answer is worse than a
    // late correction.
    assert.equal(getTurn(id)?.text, 'the whole answer');
    assert.equal(getTurn(id)?.status, 'done');
  });

  it('marks a failed turn ended rather than leaving it running forever', () => {
    const id = fresh();
    startTurn(id, 'q');
    emitTurn(id, { kind: 'error', message: 'the query died' });
    // A panel watching a turn that ended thirty seconds ago spins forever, so
    // a failure must END the turn, not merely annotate it.
    assert.equal(getTurn(id)?.status, 'error');
    assert.notEqual(runningTurn()?.runId, id);
  });

  it('ignores events for a turn that was never started', () => {
    // A late delta from an aborted turn must not resurrect it as a half-row.
    emitTurn(fresh(), { kind: 'delta', text: 'x' });
  });

  it('reports the turn in flight, and stops once it lands', () => {
    // What the panel asks on load: is anything running that I should attach to?
    const a = fresh();
    startTurn(a, 'first');
    assert.equal(runningTurn()?.runId, a);
    emitTurn(a, { kind: 'done', text: 'done' });
    assert.equal(runningTurn(), undefined);
  });
});

/**
 * WHO A WRITE BELONGS TO, across a process boundary.
 *
 * A module runs in its own process and calls `record()` with the literal actor
 * "module", because inside that process there is nobody else to be. So an agent
 * write was journalled as "module" with a null run_id, and the run ledger
 * showed the turn with ZERO writes while the graph had changed. "Revert this
 * run" was a button that would have reverted nothing and reported success —
 * per-run revert is the reason it is safe to let an agent write at all, and it
 * was resting on attribution that was not there.
 *
 * `callModule` passes the caller in the child's environment; this is the half
 * that reads it back.
 */
describe('attributing a write made on someone else\'s behalf', () => {
  const saved = process.env.BOT_CALLER;
  after(() => {
    if (saved === undefined) delete process.env.BOT_CALLER;
    else process.env.BOT_CALLER = saved;
  });

  it('credits the caller when a module wrote for one', async () => {
    const { attributedTo } = await import('../src/entityWrite.js');
    process.env.BOT_CALLER = 'debug-agent';
    assert.equal(attributedTo('module'), 'debug-agent');
  });

  it('leaves a named actor alone — only "module" is anonymous', async () => {
    const { attributedTo } = await import('../src/entityWrite.js');
    process.env.BOT_CALLER = 'debug-agent';
    // The nightly writes as itself and must not be relabelled by whatever
    // happens to be in the environment.
    assert.equal(attributedTo('nightly'), 'nightly');
    assert.equal(attributedTo('revert'), 'revert');
  });

  it('infers nothing when there is no caller', async () => {
    const { attributedTo } = await import('../src/entityWrite.js');
    delete process.env.BOT_CALLER;
    assert.equal(attributedTo('module'), 'module');
  });
});

/**
 * READ-ONLY IS ENFORCED AT THE WRITE PATH, not in a prompt.
 *
 * The agent is TOLD it is read-only, and that is worth doing — but a rule a
 * model is asked to follow is a suggestion. It can be confused about which mode
 * it is in, or simply wrong. The guarantee has to live where the write happens,
 * so that being wrong costs nothing.
 *
 * Scoped to the CALLER rather than the mode, deliberately: the nightly writes
 * while the bot is live — that is its entire job — so a blanket "no writes
 * while live" would break the night in order to protect the day.
 */
describe('a read-only caller', () => {
  const saved = process.env.BOT_READONLY;
  after(() => {
    if (saved === undefined) delete process.env.BOT_READONLY;
    else process.env.BOT_READONLY = saved;
  });

  it('is refused by applyWrite itself, whatever it was asked to do', async () => {
    const { applyWrite } = await import('../src/entityWrite.js');
    process.env.BOT_READONLY = '1';
    const r = applyWrite({ op: 'add-fact', id: 'people/mehdi', fact: 'anything at all' }, 'a test', 'module');
    assert.equal(r.ok, false);
    assert.match(r.problem ?? '', /read-only/i);
    // And it must say what to DO about it, not merely that it failed.
    assert.match(r.problem ?? '', /sedate/i);
  });

  it('writes nothing at all when refused — not even a journal row', async () => {
    const { applyWrite } = await import('../src/entityWrite.js');
    const { maxEntityWriteId } = await import('../src/db.js');
    process.env.BOT_READONLY = '1';
    const before = maxEntityWriteId();
    applyWrite({ op: 'add-fact', id: 'people/mehdi', fact: 'still nothing' }, 'a test', 'module');
    assert.equal(maxEntityWriteId(), before, 'a refused write still journalled');
  });
});
