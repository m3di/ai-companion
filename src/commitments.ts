import {
  addCommitment,
  type CommitmentRecord,
  dueCommitments,
  getAnyCommitmentByLabel,
  markCommitmentFired,
  postEvent,
  resolveCommitment,
  setCommitmentBody,
} from './db.js';
import { allowed, refusal } from './mode.js';

/**
 * Commitments — everything the system has promised its future self, in ONE
 * prospective table (round 5; absorbed wakeups + the waiting ledger). Two
 * firing modes, keyed on how_to_check:
 *  - FIRE (how_to_check NULL): when due, the stored body runs as a fresh
 *    concierge turn — reminders, routines, the nightly pipeline (by label).
 *  - CHECK (how_to_check set): when due, batched into one [PULSE] concierge
 *    turn per chat that judges each entry (check / notify / defer / resolve).
 * Both are durable rows polled every minute, advance-before-run.
 */

/** Format a Date as DB-format UTC text ('YYYY-MM-DD HH:MM:SS'). */
export function toUtcDb(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Render a stored UTC time in the machine's local time for display. */
export function fmtLocal(utcDb: string): string {
  const d = new Date(`${utcDb.replace(' ', 'T')}Z`);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parse a human "when" in LOCAL time into a Date. Accepted forms:
 * relative "+30m" / "+2h" / "+1d"; "HH:mm" (the next occurrence); or
 * "YYYY-MM-DD HH:mm". Returns undefined if unparseable or in the past.
 */
export function parseLocalWhen(input: string): Date | undefined {
  const s = input.trim();
  const rel = s.match(/^\+(\d+)\s*(m|min|h|hr|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase()[0];
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() + ms);
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  const full = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), 0, 0);
    return d.getTime() > Date.now() ? d : undefined;
  }
  return undefined;
}

export const NIGHTLY_PIPELINE_LABEL = 'nightly-pipeline';

/**
 * RETIRE THE NIGHTLY COMMITMENT — the night is a debt now (src/night.ts).
 *
 * It was seeded as a daily FIRE row due at 04:00, which made the fold an
 * APPOINTMENT: a time at which it is attempted. That shape produced all three
 * of the failures that ended it — a second fold three minutes after an induced
 * one (08-12), a fold 2h45m late (08-13), and a morning routine that fired
 * BEFORE the fold meant to close the previous day (08-15). A row that comes due
 * cannot know whether the thing it schedules has already happened, and nothing
 * else in the machine could see it was still pending.
 *
 * Dropped rather than deleted: the row is the marker that keeps it from being
 * re-seeded, and the resolution is the note explaining where it went.
 */
export function retireNightlyPipeline(chatId: number): void {
  const row = getAnyCommitmentByLabel(chatId, NIGHTLY_PIPELINE_LABEL);
  if (!row || row.status !== 'open') return;
  resolveCommitment(
    row.id,
    chatId,
    'dropped',
    'superseded by the night debt (src/night.ts) — the day now waits for the fold instead of scheduling it',
  );
  console.log(`[commitments] retired the nightly pipeline row for chat ${chatId}; the fold is a debt now`);
}

export const MORNING_BRIEF_LABEL = 'morning-brief';

export const MORNING_BRIEF_PROMPT =
  '[MORNING BRIEF] Start-of-day routine. Deliver ONE concise morning brief: what the overnight rewrite changed, in one line, if anything ' +
  "(today's events show it); what today holds, from the open commitments (listCommitments — do NOT re-announce reminders that fire on their own today); " +
  'and a one-line pointer if proposals await the operator (/proposals, via pendingFindings). ' +
  'If there is genuinely nothing to say, send one short good-morning line — do not pad. ' +
  'This brief is a daily commitment you own: if the user asks to move/disable it (or you conclude it should change), use the commitment tools.';

/**
 * Ensure the default daily morning brief exists for a chat (first boot only),
 * and keep a still-system-owned brief's body current across code updates. A
 * dropped row stays in the table as the marker, so a disabled brief is
 * respected, never recreated.
 */
export function ensureMorningBrief(chatId: number, morningHour: number): void {
  const existing = getAnyCommitmentByLabel(chatId, MORNING_BRIEF_LABEL);
  if (existing) {
    // The body ships with the code, not the row: refresh it while the brief
    // is still the system-seeded one (an open row created by 'system').
    if (existing.status === 'open' && existing.created_by === 'system' && existing.body !== MORNING_BRIEF_PROMPT) {
      setCommitmentBody(existing.id, MORNING_BRIEF_PROMPT);
      console.log(`[commitments] refreshed morning-brief body for chat ${chatId}`);
    }
    return;
  }
  const first = new Date();
  first.setHours(morningHour, 0, 0, 0);
  if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
  addCommitment(chatId, MORNING_BRIEF_LABEL, MORNING_BRIEF_PROMPT, toUtcDb(first), {
    recur: 'daily',
    createdBy: 'system',
  });
  console.log(`[commitments] seeded morning brief for chat ${chatId} at ~${morningHour}:00 local`);
}

/**
 * THE LEDGER SWEEPS (design proposal #1). Three scheduled concierge turns a
 * day over ledgerHeads() — a morning triage and two light daytime sweeps —
 * replace the per-item clock: a parked item in 'log' mode never pulses, and
 * what it would have said waits here. Seeded once per chat like the morning
 * brief; a dropped row is respected, never recreated. Local hours.
 */
export const LEDGER_SWEEPS: Array<{ label: string; hour: number; minute: number; prompt: string }> = [
  {
    label: 'ledger-triage-morning',
    hour: 8,
    minute: 30,
    prompt:
      '[LEDGER TRIAGE] Your first sweep of the day, and the ONLY place the morning is decided — nothing is pushed to the user on a clock any more. Read ledgerHeads(). For each item decide: ignore (ledgerAck), act (a worker, a commitment), or tell him. Also sweep listCommitments for watched items with NO machine check that are parked on his ball: set watchMode "log" on them so they stop pulsing — they live here now. ' +
      'Tell him ONLY what crosses the wake list (production breakage; CI red on a PR he is merging; a reply from someone he is blocked on; an appointment within hours) or what he must act on TODAY — as ONE short voice note (sendVoice), not a brief. Everything else waits for him to ask ("what needs me?"), which you answer from the heads. If nothing crosses, end silently.',
  },
  {
    label: 'ledger-sweep-midday',
    hour: 13,
    minute: 30,
    prompt:
      '[LEDGER SWEEP] Light daytime sweep: ledgerHeads(), ack what is noise, act on what moved, and speak only for the wake list (production breakage; CI red on a PR he is merging; a reply he is blocked on; a near appointment) — one short voice note at most. Otherwise end silently.',
  },
  {
    label: 'ledger-sweep-afternoon',
    hour: 17,
    minute: 0,
    prompt:
      '[LEDGER SWEEP] End-of-focus sweep: ledgerHeads(), ack the noise, act on what moved, and speak only for the wake list — one short voice note at most. Otherwise end silently.',
  },
];

export function ensureLedgerSweeps(chatId: number): void {
  for (const sw of LEDGER_SWEEPS) {
    const existing = getAnyCommitmentByLabel(chatId, sw.label);
    if (existing) {
      if (existing.status === 'open' && existing.created_by === 'system' && existing.body !== sw.prompt) setCommitmentBody(existing.id, sw.prompt);
      continue;
    }
    const first = new Date();
    first.setHours(sw.hour, sw.minute, 0, 0);
    if (first.getTime() <= Date.now()) first.setDate(first.getDate() + 1);
    addCommitment(chatId, sw.label, sw.prompt, toUtcDb(first), { recur: 'daily', createdBy: 'system' });
    console.log(`[commitments] seeded ${sw.label} for chat ${chatId} at ${sw.hour}:${String(sw.minute).padStart(2, '0')} local`);
  }
}

/** Split the due commitments into the two firing modes. */
export function splitDue(): { fire: CommitmentRecord[]; check: CommitmentRecord[] } {
  const fire: CommitmentRecord[] = [];
  const check: CommitmentRecord[] = [];
  for (const c of dueCommitments()) (c.how_to_check === null ? fire : check).push(c);
  return { fire, check };
}

/**
 * Drain due FIRE-mode commitments and hand each to the runner (a concierge
 * turn). Advance/finish BEFORE running so a crash mid-run can't refire.
 *
 * ## The work state is checked PER FIRING, not once for the batch
 *
 * It used to be checked once, by the caller, before the loop — with the
 * reasoning that refusing inside would consume a firing and lose it, since
 * `markCommitmentFired` has already advanced the row by then. That reasoning
 * was sound while the only way into a suspended state was a human typing
 * `/debug`, and it stopped being sound the moment `nightly-pipeline` — itself a
 * commitment in this very batch — became the thing that enters DREAMING. The
 * batch checked the state, changed the state, and carried on firing the rest of
 * itself against a permission that was true a few minutes earlier. On 2026-08-08
 * that put a worker and two concierge turns into a window where the night was
 * rewriting the memory they were reading.
 *
 * So the check moved here, and the objection is answered rather than accepted:
 * it happens BEFORE `markCommitmentFired`, so a refused commitment is never
 * advanced and never fired. Nothing is consumed and nothing is lost — the row
 * is simply still due, and fires on the next poll after the machine is free.
 */
export async function fireDueCommitments(
  run: (c: CommitmentRecord) => Promise<void>,
  /** May this fire right now? Injected so the guard can be exercised without
   *  claiming the process-wide work state, which is a single row that parallel
   *  test files would fight over. Production passes nothing. */
  mayFire: () => boolean = () => allowed('commitment'),
): Promise<void> {
  for (const c of splitDue().fire) {
    // Before each one, not before the loop: an earlier member of this batch may
    // have taken the machine.
    if (!mayFire()) {
      console.warn(`[commitments] "${c.label}" (#${c.id}) held back — ${refusal('commitment')}`);
      return;
    }
    markCommitmentFired(c);
    postEvent(c.chat_id, 'commitment', `fired: ${c.label}`);
    try {
      await run(c);
    } catch (e) {
      console.error(`[commitments] "${c.label}" (#${c.id}) failed:`, e);
    }
    // And after it, because THIS is the one that may have taken the machine:
    // the nightly claims the dream phase inside its own callback, and the next
    // member of the batch must not ride through on the check above.
    if (!mayFire()) {
      console.warn(`[commitments] batch stopped after "${c.label}" — ${refusal('commitment')}`);
      return;
    }
  }
}
