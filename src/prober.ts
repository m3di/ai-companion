import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { pulse } from './pulse.js';
import { addEntityChange, allEntityState, entityState, noteCheckMiss, postEvent, recordEntityProbe, touchEntityProbe } from './db.js';
import { checkCommandAllowed, classifyCheck, runCommand } from './focus.js';
import { DATA_FILE, loadGraph, renderRecords, toRow, VIEW_FILE, type Entity } from './entities.js';
import { renderMap, simplify } from './simplify.js';
import { markDomainsDirty, refreshStorySurfaces } from './storyTree.js';

/**
 * THE ENTITY PROBER (round 8) — "its entities have time and a separate,
 * self-sustained, self-growing state" (Mehdi, 2026-07-28).
 *
 * Round 7 built exactly this mechanism (run a deterministic command, scrub the
 * volatile tokens, hash, diff) and attached it to the wrong object: a
 * commitment. Self-sustaining state is a property of the ENTITY. Moving it here
 * is what lets knowledge be timeless without going stale — the facts never
 * change, and the state never has to be written by anyone.
 *
 * Two invariants this module owns:
 *   1. The prober is the ONLY writer of an entity's state. `entity_state` is the
 *      authority; the linter rejects any record file that disagrees with it.
 *   2. An unchanged probe costs a subprocess and nothing else. That is what
 *      makes a COMPLETE index affordable — the quiet tail of the graph is
 *      almost free, so nothing has to be dropped to keep the set small.
 */

/** How stale a probe may be before the sweep re-runs it. */
const PROBE_EVERY_MIN = Number(process.env.ENTITY_PROBE_MIN ?? 15);
/** How stale a CLOSED entity's probe may be. Long, because the only thing it
 *  can still tell us is that the thing reopened. */
const CLOSED_PROBE_EVERY_MIN = Number(process.env.ENTITY_PROBE_CLOSED_MIN ?? 12 * 60);
const STATE_CAP = 400;
/** Changes per entity per day before it is treated as a flapping probe. */
const NOISE_CAP = 4;
/** Blocked sweeps tolerated before the halt is announced to a human. */
const BLOCKED_BEFORE_ESCALATION = 4;

/** Consecutive sweeps refused because the graph failed lint. */
let blockedSweeps = 0;

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Derive open/closed from the probed text via the record's own `closed_when`. */
function statusFor(e: Entity, state: string): 'open' | 'closed' {
  if (!e.closed_when) return 'open';
  try {
    return new RegExp(e.closed_when, 'i').test(state) ? 'closed' : 'open';
  } catch {
    return 'open';
  }
}

export interface ProbeOutcome {
  id: string;
  changed: boolean;
  before?: string;
  after?: string;
  status?: string;
  skipped?: string;
}

/**
 * Probe one entity. The first probe is a BASELINE, never news — otherwise every
 * newly minted entity would immediately announce the state it was born with.
 */
export async function probeEntity(e: Entity): Promise<ProbeOutcome> {
  if (!e.probe) return { id: e.id, changed: false, skipped: 'no probe' };
  if (!checkCommandAllowed(e.probe)) {
    return { id: e.id, changed: false, skipped: 'probe not allowlisted' };
  }
  // The quiet pulse. Most probes find nothing, and that is the point: a sweep
  // rippling through 56 nodes every quarter hour is the clearest picture of a
  // system that is alive — and its absence was invisible for three days.
  pulse('probe', `probing ${e.id}`, { refs: [e.id], domains: [e.domain] });
  const outcome = classifyCheck(await runCommand(e.probe), STATE_CAP);
  if (outcome.kind !== 'value') {
    // ONLY A VALUE MAY BECOME STATE (Charter I3). Touch the clock so the entity
    // is not re-probed in a tight loop, leave the last real state standing, and
    // RECORD the miss — leaving it standing is correct and invisible, and
    // invisible is how the July outage lasted three days.
    //
    // The prober used to guard only the two cases it had personally been burned
    // by: a command that could not run, and one that printed nothing. A command
    // that printed `jq: error (at <stdin>:0): Cannot index o…` sailed through
    // and became the entity's state, which is what the 2026-08-02 log showed —
    // errors sitting as truth until a later probe happened to succeed.
    touchEntityProbe(e.id);
    noteCheckMiss('probe', e.id, outcome.kind, outcome.detail);
    return { id: e.id, changed: false, skipped: `probe ${outcome.kind}: ${outcome.detail.slice(0, 80)}` };
  }
  const state = outcome.value;
  const h = hash(state);
  const prev = entityState(e.id);
  const status = statusFor(e, state);

  if (!prev || prev.last_seen === null) {
    recordEntityProbe(e.id, state, h, status);
    return { id: e.id, changed: false, status, skipped: 'baseline' };
  }
  if (prev.last_seen === h) {
    touchEntityProbe(e.id);
    return { id: e.id, changed: false, status: prev.status };
  }

  const before = prev.state ?? '';
  recordEntityProbe(e.id, state, h, status);
  pulse('entity-change', `${e.id}: ${before.slice(0, 30) || '(none)'} → ${state.slice(0, 30)}`, {
    refs: [e.id],
    domains: [e.domain],
    loud: status !== prev.status,
    meta: { before, after: state, status, flip: status !== prev.status },
  });
  // A flapping probe (one whose output carries a token the scrubber missed)
  // must never become a token pump: absorb it silently past the cap.
  const noisy = addEntityChange(e.id, before, state, status !== prev.status) >= NOISE_CAP;
  return { id: e.id, changed: !noisy, before, after: state, status };
}

/**
 * The background sweep. Sequential on purpose: a handful of lookups every
 * quarter hour should be invisible, not a thundering herd.
 *
 * Only entities whose probe has gone stale are run, oldest first, so adding a
 * hundred quiet entities to the graph costs a hundred cheap subprocesses spread
 * over the cadence — not a hundred model turns.
 */
export async function sweepProbes(): Promise<ProbeOutcome[]> {
  let graph = loadGraph();
  // STATE DRIFT IS THE PROBER'S OWN MESS, AND ONLY THE PROBER CAN CLEAN IT.
  // Probed state lands in the DB per entity but reaches the files once, at the
  // end of the sweep — so a sweep cut short (a restart, a crash) leaves the DB
  // ahead of the files. That disagreement is a fatal lint error, and the lint
  // error stops the next sweep, which is the only thing that would have written
  // the files. The guard below then holds a deadlock it caused itself, forever.
  // The DB is DECLARED the authority, so this class needs no author: rewrite the
  // files from the table and carry on. Anything else still waits for a human.
  if (graph.errors.length && graph.errors.every((e) => e.code === 'state-drift')) {
    console.warn(`[prober] repairing ${graph.errors.length} state drift(s) from the probe table`);
    syncStateIntoFiles();
    graph = loadGraph();
  }
  if (graph.errors.length) {
    // Probing a graph that failed lint would write state for records nobody has
    // validated. The reformer's job is to fix the file; the prober waits.
    //
    // But WAITING SILENTLY IS HOW A LAYER DIES. This guard held for three days
    // (2026-07-28→31) over a single bad field, emitting one console line per
    // cycle to a log nobody reads, while every entity's clock stopped. A halt
    // this total has to reach a person: after a few blocked cycles, say so once,
    // then again only if it is still broken hours later.
    blockedSweeps += 1;
    console.warn(`[prober] skipping sweep — ${graph.errors.length} lint error(s) in the entity graph`);
    if (blockedSweeps >= BLOCKED_BEFORE_ESCALATION && blockedSweeps % BLOCKED_BEFORE_ESCALATION === 0) {
      const first = graph.errors[0]!;
      for (const chatId of config.allowedChatIds) {
        postEvent(
          chatId,
          'prober',
          `entity probing HALTED for ${Math.round((blockedSweeps * PROBE_EVERY_MIN) / 60)}h — ${graph.errors.length} lint error(s) block every sweep, so no entity state is being refreshed. First: ${first.file}:${first.line} ${first.message.slice(0, 120)}`,
        );
      }
    }
    return [];
  }
  if (blockedSweeps) {
    console.log(`[prober] graph lint clean again after ${blockedSweeps} blocked sweep(s) — resuming`);
    blockedSweeps = 0;
  }
  const state = allEntityState();
  const cutoff = Date.now() - PROBE_EVERY_MIN * 60_000;
  const closedCutoff = Date.now() - CLOSED_PROBE_EVERY_MIN * 60_000;
  const due = [...graph.entities.values()]
    .filter((e) => e.probe)
    .filter((e) => {
      const at = state.get(e.id)?.probed_at;
      if (!at) return true;
      // A CLOSED entity is probed rarely, not never. Reopening is real and the
      // prober is the only thing that would notice — but on 2026-08-06 the two
      // probes still failing all day were both closed (`Archived` and `Done`),
      // and an archived Fibery task never answers again. That is a probe that
      // cannot succeed, retried every 15 minutes, filing a miss each time and
      // drowning the live failures in the same report.
      const at_ = Date.parse(`${at}Z`);
      return at_ <= (state.get(e.id)?.status === 'closed' ? closedCutoff : cutoff);
    })
    .sort((a, b) => (state.get(a.id)?.probed_at ?? '').localeCompare(state.get(b.id)?.probed_at ?? ''));

  const out: ProbeOutcome[] = [];
  for (const e of due) {
    try {
      const r = await probeEntity(e);
      out.push(r);
      if (r.changed) console.log(`[prober] ${e.id}: ${r.before?.slice(0, 40)} → ${r.after?.slice(0, 40)}`);
    } catch (err) {
      console.error(`[prober] ${e.id} failed`, err);
    }
  }
  // A BASELINE is not news, but it is still the first true state this entity has
  // ever had — the file must carry it, or a freshly minted entity reads as
  // stateless on disk until something happens to change.
  if (out.some((r) => r.changed || r.skipped === 'baseline')) syncStateIntoFiles();
  return out;
}

/**
 * Write the probed state back into the record files.
 *
 * The DB is the authority, but a record on disk that shows no state is unreadable
 * to a human and to any agent holding only the file — and the file surviving on
 * its own is the whole reason knowledge lives in files. So the prober renders
 * its own truth back into `state:`/`state_at:`, which also keeps the linter's
 * hand-edit rule from firing on the system's own writes.
 */
export function syncStateIntoFiles(): void {
  const dirty = new Set<string>();
  const graph = loadGraph();
  const probed = allEntityState();
  const byDomain = new Map<string, Entity[]>();
  for (const e of graph.entities.values()) {
    if (!byDomain.has(e.domain)) byDomain.set(e.domain, []);
    byDomain.get(e.domain)!.push(e);
  }

  for (const [domain, ents] of byDomain) {
    let touched = false;
    for (const e of ents) {
      const row = probed.get(e.id);
      if (!e.probe || !row?.state) continue;
      if (e.state === row.state && e.state_at === row.state_at) continue;
      e.state = row.state;
      e.state_at = row.state_at ?? undefined;
      e.status = row.status === 'closed' ? 'closed' : 'open';
      touched = true;
    }
    if (!touched) continue;
    // Rewrite the DATA, then regenerate the VIEW from it. Editing rows is a
    // whole-field replace rather than the line surgery the record format needed
    // — which is most of why the data layer is rows in the first place.
    const dir = join(config.knowledgeDir, domain);
    const ordered = ents.sort((a, b) => a.line - b.line);
    writeFileSync(join(dir, DATA_FILE), `${ordered.map(toRow).join('\n')}\n`);
    writeFileSync(join(dir, VIEW_FILE), renderRecords(ordered));
    dirty.add(domain);
  }

  // `_map.md` IS a state-bearing view — it lists the open entities with their
  // states — so a writer that changes state and leaves the map alone has left
  // a derived file disagreeing with its source (Charter I2). The suite asserts
  // maps are current, so this made the SUITE go red on any ordinary status
  // flip: on 2026-08-02 a healed jq error turned three domains stale and the
  // audit's loudest signal with them. A writer maintains its own views.
  if (dirty.size) {
    const fresh = loadGraph();
    if (!fresh.errors.length) {
      const s = simplify(fresh);
      for (const domain of dirty) {
        writeFileSync(join(config.knowledgeDir, domain, '_map.md'), renderMap(domain, fresh, s));
      }
    }
    // The story narrates state too ("shipped", "waiting on review"), and the
    // prober is the one writer that bypasses applyWrite — so it maintains
    // this view the same way it maintains the maps, or a state flip leaves
    // the narrative telling yesterday's status with nothing marked stale.
    try {
      markDomainsDirty(dirty);
      const r = refreshStorySurfaces();
      if (r.problem) console.error(`[prober] story re-render failed: ${r.problem}`);
    } catch (e) {
      console.error('[prober] story dirty-marking failed (the state write itself stands)', e);
    }
  }
}
