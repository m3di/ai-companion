import { markWriteReverted, runWriteRows, type EntityWriteRow } from './db.js';
import { applyWrite, type Write } from './entityWrite.js';
import type { EntityKind } from './entities.js';

/**
 * UNDOING A RUN, one inverse write at a time.
 *
 * Debug mode already has a rollback and it is a snapshot: whole-tree, atomic,
 * cannot half-fail. That is the right tool for *"this whole session was
 * scaffolding"* and the wrong one for *"run #3 was a bad idea"* — a snapshot
 * cannot undo one attempt out of five without discarding the four around it.
 *
 * So this is the finer instrument, and it is honest about being finer:
 *
 * - It goes in REVERSE order. Writes depend on each other — a mint then an edge
 *   pointing at it — and undoing forwards would try to delete a node something
 *   still points at.
 * - It goes through `applyWrite` like anything else, so each inverse is
 *   validated, journalled and rolled back on lint failure. A revert is not a
 *   privileged path; it is a write that happens to restore something.
 * - It STOPS at the first refusal rather than pressing on. A half-reverted run
 *   is a state nobody designed, and continuing past a refusal is how you get
 *   one — better to stop with the graph consistent and say which write blocked.
 *
 * The inverse of a write is only recoverable because `before` and `after` hold
 * the actual values. Where they do not — a `mint` records no row to restore —
 * the inverse is structural (`retire`) rather than a replay.
 */

export interface RevertOutcome {
  runId: number;
  reverted: number;
  /** The write that stopped it, if one did. */
  blocked?: { writeId: number; op: string; entityId: string; problem: string };
  /** Writes that needed no inverse — already reverted, or nothing to undo. */
  skipped: number;
}

/** `edge`/`drop-edge` journal their value as `rel → target`. */
function parseEdge(value: string): { rel: string; target: string } | undefined {
  const m = /^(\S+)\s*→\s*(.+)$/.exec(value.trim());
  return m ? { rel: m[1]!, target: m[2]!.trim() } : undefined;
}

/**
 * The write that undoes this one, or a reason it cannot be undone.
 *
 * Exported because it is the interesting half: a caller that wants to SHOW what
 * a revert would do, before doing it, needs exactly this.
 */
export function inverseOf(w: EntityWriteRow): { write: Write } | { problem: string } {
  const id = w.entity_id;
  switch (w.op) {
    case 'add-fact':
      return w.after ? { write: { op: 'drop-fact', id, fact: w.after } } : { problem: 'no value recorded' };
    case 'drop-fact':
      return w.before ? { write: { op: 'add-fact', id, fact: w.before } } : { problem: 'no value recorded' };
    case 'correct-fact':
      return w.before && w.after
        ? { write: { op: 'correct-fact', id, from: w.after, to: w.before } }
        : { problem: 'a correction needs both halves to be undone' };
    case 'note':
      // A note has no "unset": restoring an absent note means an empty one.
      return { write: { op: 'note', id, note: w.before ?? '' } };
    case 'observe':
      return { write: { op: 'observe', id, observed: w.before ?? '' } };
    case 'goal':
      return { write: { op: 'goal', id, goal: w.before === 'true' } };
    case 'dormant':
      // `before` is "true|false[ actor=x]"; the flag comes back, the actor does
      // not — there is no actor op, and a revived node names its mover afresh.
      return { write: { op: 'dormant', id, dormant: (w.before ?? '').startsWith('true') } };
    case 'edge': {
      const e = w.after && parseEdge(w.after);
      return e ? { write: { op: 'drop-edge', id, rel: e.rel as never, target: e.target } } : { problem: 'unreadable edge value' };
    }
    case 'drop-edge': {
      const e = w.before && parseEdge(w.before);
      return e ? { write: { op: 'edge', id, rel: e.rel as never, target: e.target } } : { problem: 'unreadable edge value' };
    }
    case 'correct-chain':
      // Swap the halves: a drop is undone by an add, a replace by the reverse.
      return w.before || w.after
        ? { write: { op: 'correct-chain', id, from: w.after ?? undefined, to: w.before ?? undefined } }
        : { problem: 'no value recorded' };
    case 'move':
      // `before` is the id it came FROM; moving it back is the inverse.
      return w.before ? { write: { op: 'move', id, to: w.before } } : { problem: 'no origin recorded' };
    case 'mint':
      return { write: { op: 'retire', id } };
    case 'retire': {
      // The whole row was journalled precisely so this is possible.
      if (!w.before) return { problem: 'no row recorded — this retire predates whole-row journalling' };
      try {
        const row = JSON.parse(w.before) as {
          id: string; kind: string; facts: string[]; aka?: string[]; chain?: string[]; actor?: string; note?: string;
          goal?: boolean; edges?: Record<string, string[]>;
        };
        return {
          write: {
            op: 'mint',
            id: row.id,
            kind: row.kind as EntityKind,
            facts: row.facts,
            aka: row.aka,
            chain: row.chain,
            actor: row.actor,
            note: row.note,
            goal: row.goal,
            edges: Object.entries(row.edges ?? {}).flatMap(([rel, ts]) => ts.map((t) => ({ rel: rel as never, target: t }))),
          },
        };
      } catch {
        return { problem: 'the recorded row is not readable' };
      }
    }
    default:
      return { problem: `no inverse defined for "${w.op}"` };
  }
}

/** What reverting this run WOULD do. Read-only — the review before the act. */
export function previewRevert(runId: number): Array<{ writeId: number; op: string; entityId: string; inverse: string }> {
  return [...runWriteRows(runId)]
    .reverse()
    .map((w) => {
      const inv = inverseOf(w);
      return {
        writeId: w.id,
        op: w.op,
        entityId: w.entity_id,
        inverse: 'problem' in inv ? `CANNOT: ${inv.problem}` : inv.write.op,
      };
    });
}

/**
 * Undo a run. Reverse order, through the normal write path, stopping at the
 * first refusal so the graph is never left half-way through an attempt.
 */
export function revertRun(runId: number, rows: EntityWriteRow[], reason: string): RevertOutcome {
  const out: RevertOutcome = { runId, reverted: 0, skipped: 0 };
  for (const w of [...rows].reverse()) {
    if (w.reverted_at) {
      out.skipped++;
      continue;
    }
    const inv = inverseOf(w);
    if ('problem' in inv) {
      out.blocked = { writeId: w.id, op: w.op, entityId: w.entity_id, problem: inv.problem };
      return out;
    }
    const r = applyWrite(inv.write, `revert of write #${w.id} (run #${runId}): ${reason}`, 'revert');
    if (!r.ok) {
      out.blocked = { writeId: w.id, op: w.op, entityId: w.entity_id, problem: r.problem ?? 'refused' };
      return out;
    }
    markWriteReverted(w.id);
    out.reverted++;
  }
  return out;
}
