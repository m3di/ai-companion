import { EventEmitter } from 'node:events';

/**
 * THE PULSE BUS — the system's own activity, made watchable.
 *
 * Everything the machine does is already recorded somewhere, and none of it is
 * WATCHABLE. `module_use` is an aggregate upsert (a call bumps `hits`; the call
 * itself leaves no trace in time), `entity_state` keeps only the latest value,
 * and the prober's sweep exists purely as console lines. So the Atlas cannot be
 * built by tailing a table — there is no event stream to tail.
 *
 * This is that stream, and it is deliberately the cheapest possible thing:
 * in-process, bounded, lossy, and unpersisted. A dropped pulse costs a missed
 * animation frame and nothing else, which is the whole reason it is allowed to
 * sit in the hot path of the prober and the dispatch loop. Nothing here may ever
 * become load-bearing: if a fact matters, it belongs in a table, and the pulse
 * is only its shadow.
 *
 * The ring buffer exists so a page opened mid-flight is not blank — the last
 * couple of minutes replay on connect, and only then does it go live.
 */

/** What kind of thing happened. The Atlas paints each differently. */
export type PulseKind =
  /** An entity's probe ran. Quiet unless it moved. */
  | 'probe'
  /** An entity's state actually changed — the loud one. */
  | 'entity-change'
  /** A focus item's check ran. */
  | 'focus'
  /** A knowledge-API function was called. */
  | 'call'
  /** An agent went around the API. */
  | 'friction'
  /** A session turn started or ended. */
  | 'turn'
  /** A tool call inside a turn. */
  | 'tool'
  /** A nightly / operator pass. */
  | 'operator'
  /** The day queued an observation — it lights the entities it named (M1). */
  | 'observe'
  /** Life upkeep or the board moved (proposal #7) — the /life page refetches on it. */
  | 'life';

export interface Pulse {
  /** Monotonic within a process run — the client dedupes replay on it. */
  seq: number;
  at: string;
  kind: PulseKind;
  /** One line, already human-readable: the ticker shows this verbatim. */
  text: string;
  /**
   * Entity ids this pulse is ABOUT. The renderer halos these nodes and runs a
   * light along the edges between them, so an empty list means "no node lit" —
   * which is correct for a turn that touched nothing in the graph.
   */
  refs?: string[];
  /** Domains this pulse is about, when no entity is known. Lights the hull. */
  domains?: string[];
  /** Louder rendering: a status flip, a failure, a change that reshapes things. */
  loud?: boolean;
  /** Anything the modal or ticker wants; never interpreted by the renderer. */
  meta?: Record<string, unknown>;
}

const RING = 200;

const bus = new EventEmitter();
// The Atlas may hold several tabs open, and node warns at 10 — but the real
// reason to raise this is that a leak here would be invisible, so cap it high
// and let an actual leak still trip the warning.
bus.setMaxListeners(64);

const ring: Pulse[] = [];
let seq = 0;

/**
 * Emit one pulse. Never throws: a broken listener must not be able to take down
 * a prober sweep or a dispatch turn, which is the whole risk of putting an
 * observation hook in a hot path.
 */
export function pulse(kind: PulseKind, text: string, extra: Omit<Pulse, 'seq' | 'at' | 'kind' | 'text'> = {}): void {
  const p: Pulse = { seq: ++seq, at: new Date().toISOString(), kind, text: text.slice(0, 300), ...extra };
  ring.push(p);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  try {
    bus.emit('pulse', p);
  } catch (e) {
    console.error('[pulse] listener threw', e);
  }
  // AND OUT OF THIS PROCESS. A write made from a CLI used to change the graph
  // and light nothing, because this bus is per-process — the gardener was
  // invisible on the Atlas, which is most of the reason to run one while
  // watching.
  if (sink && !relaying) {
    try {
      sink(process.pid, p.at, JSON.stringify(p));
    } catch {
      /* a pulse that cannot be published is still a pulse that was emitted */
    }
  }
}

/**
 * WHERE A PULSE GOES TO REACH OTHER PROCESSES — injected, not imported.
 *
 * `pulse()` is called from the module host's sandbox, which has no database at
 * all, so a static import of `db.js` here would break every module call; and a
 * dynamic `require` is not available in ESM, which took the bot down once
 * finding out. Whoever HAS a database registers it.
 */
type PulseSink = (pid: number, at: string, body: string) => void;
let sink: PulseSink | undefined;
export function setPulseSink(fn: PulseSink): void {
  sink = fn;
}

/** True while re-emitting someone else's pulse, so a relay cannot echo it back
 *  into the table and set two processes forwarding to each other forever. */
let relaying = false;

/**
 * Bring in pulses from other processes — the CLI, the gardener, a one-off
 * script — so the Atlas shows every change to the graph rather than only the
 * ones the bot happened to make itself. Call once, from the long-lived process.
 */
export function startPulseRelay(
  fetchSince: (sinceId: number, pid: number) => Array<{ id: number; body: string }>,
  latestId: () => number,
  intervalMs = 1000,
): () => void {
  let since = latestId();
  const timer = setInterval(() => {
    try {
      for (const row of fetchSince(since, process.pid)) {
        since = row.id;
        // RE-SEQUENCED HERE. A foreign pulse carries its own process's seq,
        // and every short-lived CLI counts from 1 — while the page dedupes by
        // seq (a reconnect replays the ring). So after the first relayed pulse
        // every later one arrived as a duplicate and was dropped: a gardening
        // pass lit one node and then nothing. Found 2026-11-13 when the life
        // page's refetch-on-pulse never fired. One stream, one numbering.
        const p = { ...(JSON.parse(row.body) as Pulse), seq: ++seq };
        relaying = true;
        try {
          ring.push(p);
          if (ring.length > RING) ring.splice(0, ring.length - RING);
          bus.emit('pulse', p);
        } finally {
          relaying = false;
        }
      }
    } catch (e) {
      console.error('[pulse] relay failed', e);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The replay a newly-connected client gets before it goes live. */
export function recentPulses(limit = RING): Pulse[] {
  return ring.slice(-limit);
}

/** Subscribe. Returns the unsubscribe. */
export function onPulse(fn: (p: Pulse) => void): () => void {
  bus.on('pulse', fn);
  return () => bus.off('pulse', fn);
}
