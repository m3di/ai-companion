/**
 * WHAT THE CONCIERGE IS HANDED WHEN A WORKER FINISHES — and when.
 *
 * Two failures from 2026-08-27, both at the same seam, both pure to fix:
 *
 *  - THE READOUT WAS THE WRONG SIZE. The wake-up rendered the worker's last
 *    eight messages with the final one capped at 4,000 chars. A worker's
 *    closing report ("the plan, the open questions") is routinely longer, so
 *    the concierge saw `…[truncated]`, reasoned from the partial text, and
 *    told Mehdi "Roadmap Description isn't a field on the entity" — the
 *    worker had found it two paragraphs below the cut. The final message now
 *    gets 16,000 chars (≈4k tokens, trivial beside a concierge turn), the
 *    earlier ones stay at 500, and a cut names its slot and both lengths so
 *    the reader is sent to readThread instead of to a conclusion.
 *
 *  - ONE RUN, TWO WAKE-UPS. A steer (updateBrief) queues a [GUIDANCE] turn
 *    behind the running one. The original turn then woke the concierge with
 *    "finished" while the guidance turn was still waiting, and the guidance
 *    turn woke it again. A worker's run is the whole drain of its queue: the
 *    report is owed once, when the queue is empty, ok only if every turn was.
 */

export interface ReadoutMessage {
  role: string;
  content: string;
}

export interface ReadoutCaps {
  lastCap: number;
  otherCap: number;
}

export const READOUT_CAPS: ReadoutCaps = { lastCap: 16_000, otherCap: 500 };

/**
 * Render a worker thread's recent messages for the concierge. Pure: the same
 * rows render byte-identically. A cut is loud about being a cut.
 */
export function completionReadout(msgs: ReadoutMessage[], slot: number, caps: ReadoutCaps = READOUT_CAPS): string {
  const lastIdx = msgs.length - 1;
  return msgs
    .map((m, i) => {
      const cap = i === lastIdx ? caps.lastCap : caps.otherCap;
      const body =
        m.content.length > cap
          ? `${m.content.slice(0, cap)}…[truncated at ${cap} of ${m.content.length} chars — the full text is readThread(${slot}); a truncated readout is not evidence that something is absent]`
          : m.content;
      return `${m.role === 'user' ? 'Task' : 'Worker'}: ${body}`;
    })
    .join('\n');
}

export interface CompletionInput {
  /** This turn was dispatched (the concierge is owed a report for it). */
  background: boolean;
  /** This turn was aborted — an abort ends the run without a report. */
  aborted: boolean;
  /** Turns still queued on this worker after this one. */
  queued: number;
  /** An earlier turn of this run already deferred its report. */
  owed: boolean;
}

export interface CompletionDecision {
  /** Wake the concierge now. */
  notify: boolean;
  /** Carry the debt to the next turn on this worker. */
  owe: boolean;
}

/**
 * Whether a finishing worker turn wakes the concierge, defers, or neither.
 * A run reports once, at the end of its queue; an abort clears the debt.
 */
export function completionDecision(i: CompletionInput): CompletionDecision {
  if (i.aborted) return { notify: false, owe: false };
  const due = i.background || i.owed;
  if (!due) return { notify: false, owe: false };
  if (i.queued > 0) return { notify: false, owe: true };
  return { notify: true, owe: false };
}
