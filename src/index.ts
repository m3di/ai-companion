import { config } from './config.js';
import { type CommitmentRecord, consumeFocusChanges, deferCommitment, foreignPulses, latestPulseId, openFocusChanges } from './db.js';
import { sweepFocusChecks, renderChanges } from './focus.js';
import { sweepProbes } from './prober.js';
import { startAtlas } from './atlas.js';
import { claimInstance } from './instance.js';
import { startBody, stopBody } from './body.js';
import { startPulseRelay } from './pulse.js';
import { harvestAll } from './harvest.js';
import { distillPending, type OpenLoop } from './distill.js';
import { recoverAfterRestart, registerDispatch, runConciergeSystemTurn } from './dispatch.js';
import { allowed } from './mode.js';
import { describeDebt, NIGHT_HOUR, nightOwed } from './night.js';
import { clearOpenRetrievalEpisodes, clearStaleDreamPhase } from './db.js';
import { runRewrite } from './operator.js';
import { initKnowledge } from './knowledge.js';
import {
  ensureLedgerSweeps,
  ensureMorningBrief,
  fireDueCommitments,
  retireNightlyPipeline,
  splitDue,
  toUtcDb,
} from './commitments.js';
import { TelegramAdapter } from './transport/telegram.js';
import { rearmWatches } from './watch.js';

// One bot per machine, decided before anything with a side effect: a second
// instance is refused here, by name, instead of polling Telegram for a few
// seconds and then dying on the Atlas port (2026-11-08).
const releaseInstance = claimInstance();

// Prepare the knowledge base (and migrate any legacy SQLite notes into it on
// first run).
initKnowledge();

// The chat surface is chosen here and nowhere else. Swap TelegramAdapter for
// another ChatAdapter (e.g. Slack) and the rest of the app is unchanged.
const adapter = new TelegramAdapter();
registerDispatch(adapter);

await adapter.start();

// Re-arm any background watches that were still running when the process last
// stopped — the child died with it, but the external run (CI/deploy) did not.
rearmWatches();

// A rewrite pass dies with the process that ran it, so a dream hold present at
// boot is debris — and debris that would greet the day with a bot refusing to
// answer and no way to tell it otherwise (I8).
clearStaleDreamPhase();

// Account for turns that were still running or queued when the process last
// stopped. A person's turn is replayed — they asked and were never answered
// (2026-08-27: a two-hour hang, a restart, and a message that had to be
// retyped). A machine turn that was in flight is reported, not retried:
// half-applied work lives in a repo, not in an external run. AFTER the debris
// clear above, because it is gated by the mode: while the day may not run
// (debug, a night owed) the rows stay put, and the tick below retries until
// the gate opens. Fire-and-forget: boot must not wait on an LLM turn.
void recoverAfterRestart().catch((e: unknown) => console.error('[dispatch] restart recovery failed', e));

// An episode open at boot belongs to a turn that died with the last process.
// Score it on what it managed rather than leaving it unscored forever — an
// unclosed episode is invisible to every query that reads the workload.
clearOpenRetrievalEpisodes();

// Commitments: the bot's single prospective store. The nightly reflect→act
// pipeline and the morning brief are seeded as daily FIRE commitments (first
// boot only — a dropped one stays dropped). Rows are durable and polled every
// minute, so a missed schedule (laptop asleep at 04:00, process restart)
// fires on the next poll after wake.
const MORNING_HOUR = Number(process.env.MORNING_HOUR ?? 8);
for (const chatId of config.allowedChatIds) {
  // The nightly was a commitment row until 2026-08-15. It is a DEBT now
  // (src/night.ts) — retire the row so it cannot fire a second fold minutes
  // after the debt was already paid, which is exactly what it did on 08-12.
  retireNightlyPipeline(chatId);
  ensureMorningBrief(chatId, MORNING_HOUR);
  ensureLedgerSweeps(chatId);
}
if (config.allowedChatIds.size) console.log(`[companion] the night is owed from ~${NIGHT_HOUR}:00 local; the day waits for it`);

// One firing loop, two modes (split on how_to_check):
//  - FIRE: run the stored body as a concierge turn (the nightly pipeline is
//    code-dispatched by its label). Advance-before-run lives in
//    fireDueCommitments.
//  - CHECK: batch due entries into one [PULSE] turn per chat — the concierge
//    judges each (check / notify / defer / resolve). Every due entry is
//    deferred FIRST so a crashed or lazy pulse can't refire it every minute.
/**
 * PAY THE NIGHT FIRST.
 *
 * The debt is checked before anything else in the tick, and it has to be
 * settled here rather than by a commitment, for the reason the commitment
 * could not be: `allowed('commitment')` is FALSE while a night is owed, so a
 * nightly that rides the commitment queue can no longer reach the queue that
 * would run it. That is not a bug in the gate — it is the gate working. The
 * thing that pays a debt cannot be one of the things the debt blocks.
 *
 * `allowed('dream')` still gates it, so a debug session or a pass already in
 * flight is respected.
 */
async function payTheNight(): Promise<boolean> {
  const owed = nightOwed();
  if (!owed) return false;
  if (!allowed('dream')) return true; // owed, but someone else has the machine
  console.log(`[night] ${describeDebt(owed)} Folding now — the day is held until it lands.`);
  for (const chatId of config.allowedChatIds) {
    try {
      await runRewrite(adapter, chatId, 'nightly');
    } catch (e) {
      console.error('[night] fold failed; the night stays owed and the next tick retries', e);
    }
  }
  return true;
}

let ticking = false;
const poll = setInterval(() => {
  // Ticks must not overlap: a fold takes minutes, and a second tick entering
  // `payTheNight` while the first is mid-pass would see the debt still owed
  // and be refused by the phase lock once a minute for the whole pass.
  if (ticking) return;
  ticking = true;
  void (async () => {
    try {
      if (await payTheNight()) return;
      // Recovery refused at boot (debug, a night owed) is retried here — the
      // gate opening is the only door it needs.
      await recoverAfterRestart().catch((e: unknown) => console.error('[dispatch] restart recovery failed', e));
      // A cheap early-out, and no longer the real guard. `fireDueCommitments`
      // checks per firing now, because entering DREAMING mid-batch used to let
      // the rest of the batch through on a permission that was already stale.
      if (!allowed('commitment')) return;
      await fireDueCommitments(async (c) => {
        if (!config.allowedChatIds.has(c.chat_id)) return;
        await runConciergeSystemTurn(c.chat_id, `[COMMITMENT · ${c.label}] Your scheduled commitment fired. Instruction:\n${c.body}`);
      });
      firePulses();
    } finally {
      ticking = false;
    }
  })();
}, 60_000);

const PULSE_DEFAULT_DEFER_H = 4;
function firePulses(): void {
  const byChat = new Map<number, CommitmentRecord[]>();
  for (const c of splitDue().check) {
    if (!config.allowedChatIds.has(c.chat_id)) continue;
    byChat.set(c.chat_id, [...(byChat.get(c.chat_id) ?? []), c]);
  }
  for (const [chatId, entries] of byChat) {
    const fallback = toUtcDb(new Date(Date.now() + PULSE_DEFAULT_DEFER_H * 3_600_000));
    for (const c of entries) deferCommitment(c.id, chatId, fallback);
    // Round 7: an entry woken by the focus checker (or by a worker's incidental
    // observation) arrives WITH its diff, so the concierge judges what changed
    // instead of re-fetching what code already fetched.
    let changed = 0;
    const list = entries
      .map((c) => {
        const rows = openFocusChanges(c.id);
        if (rows.length) {
          changed++;
          consumeFocusChanges(c.id);
        }
        return (
          `#${c.id} ${c.label}\n   ${c.body.replace(/\n/g, '\n   ')}\n   how to check: ${c.how_to_check}` +
          (rows.length ? `\n${renderChanges(rows)}` : '')
        );
      })
      .join('\n');
    const header = changed
      ? `[PULSE] ${changed} focus item(s) MOVED — the system detected the change already:`
      : `[PULSE] ${entries.length} watched commitment(s) due for a check:`;
    void runConciergeSystemTurn(
      chatId,
      `${header}\n${list}\n\n` +
        `Entries carrying a CHANGED/WORKER OBSERVED block have ALREADY been checked by the system — act on the diff, do not re-run the check (a worker observation is a lead, so trust the verified diff over the wording). For the rest: check per its how-to-check (yourself or via dispatchTask). ` +
        `Message the user only if it needs them or something genuinely moved, and set each entry's future with updateCommitment (defer / done / dropped). Each entry was auto-deferred +${PULSE_DEFAULT_DEFER_H}h as a fallback — override that with your judgment; an item with a machine check does not need a clock. An entry that is parked on the user's ball with NO machine check should not be waking you at all: set watchMode "log" on it (updateCommitment) and it moves to the ledger, read on your own sweeps. If nothing is actionable, end silently.`,
    );
  }
}

// THE ATLAS (docs/plans/atlas-visualization.md): the entity graph drawn, and the
// system's own activity animated on top of it. Read-only, loopback, and entirely
// optional — with no ATLAS_PORT set, nothing here runs and the bot is unchanged.
const atlas = startAtlas();
// Pull in pulses from other processes (a CLI, the gardener) so the Atlas shows
// EVERY change to the graph, not only the ones this process made. Without it a
// gardening pass run from a terminal is invisible on the page it exists to be
// watched on.
const stopPulseRelay = atlas ? startPulseRelay(foreignPulses, latestPulseId) : undefined;

let stopping = false;
// THE BODY (round 12): Companion.app as a child of this process — one command,
// one lifetime. When the app quits, so does the bot, with the app's code.
const body = startBody({
  atlasUrl: process.env.ATLAS_PORT ? `http://127.0.0.1:${process.env.ATLAS_PORT}` : undefined,
  onExit: (code, signal) => {
    if (stopping) return;
    console.log('[body] the app is gone — stopping the bot with it');
    shutdown();
    setTimeout(() => process.exit(signal ? 1 : (code ?? 0)), 1500).unref();
  },
});

// The deterministic focus checker: runs each item's check_cmd out of process,
// hashes the result, and wakes nobody unless it moved (see focus.ts).
const FOCUS_SWEEP_MIN = Number(process.env.FOCUS_SWEEP_MIN ?? 5);
const focusSweep = setInterval(() => {
  if (!allowed('focus-sweep')) return;
  void sweepFocusChecks().catch((e) => console.error('[focus] sweep failed', e));
}, FOCUS_SWEEP_MIN * 60_000);
void sweepFocusChecks().catch((e) => console.error('[focus] initial sweep failed', e));

// The ENTITY prober (round 8): the same bargain one layer down. Every entity
// carrying a `probe` re-derives its own state out of process, so knowledge stays
// timeless AND current without anyone writing a status by hand. An unchanged
// probe costs a subprocess, which is what makes a complete index affordable —
// the quiet tail of the graph is nearly free, so nothing has to be dropped to
// keep the focus set small.
const ENTITY_SWEEP_MIN = Number(process.env.ENTITY_SWEEP_MIN ?? 5);
const entitySweep = setInterval(() => {
  // The prober writes state back INTO the tree, so leaving it running during
  // debug would dirty the very files a rollback restores — and the rollback
  // would then look like it had reverted the operator's own work.
  if (!allowed('probe-sweep')) return;
  void sweepProbes().catch((e) => console.error('[prober] sweep failed', e));
}, ENTITY_SWEEP_MIN * 60_000);
void sweepProbes().catch((e) => console.error('[prober] initial sweep failed', e));

// DAYTIME FRESHNESS. harvestAll() is a filesystem scan — free — so the day's
// local work no longer stays invisible until 04:00. The distil is bounded and
// pays for episodes the nightly would have distilled anyway; it just makes a
// new distilled session a live trigger instead of a nightly-only one.
const HARVEST_MIN = Number(process.env.HARVEST_MIN ?? 20);
const DAY_DISTILL_MIN = Number(process.env.DAY_DISTILL_MIN ?? 60);
const DAY_DISTILL_CAP = Number(process.env.DAY_DISTILL_CAP ?? 3);
const dayHarvest = setInterval(() => {
  if (!allowed('harvest')) return;
  try {
    harvestAll();
  } catch (e) {
    console.error('[harvest] daytime pass failed', e);
  }
}, HARVEST_MIN * 60_000);
const dayDistill = setInterval(() => {
  if (DAY_DISTILL_CAP <= 0 || !allowed('distill')) return;
  for (const chatId of config.allowedChatIds) {
    void distillPending(chatId, DAY_DISTILL_CAP)
      .then((r) => {
        if (r.distilled) console.log(`[distill] daytime: ${r.distilled} episode(s), $${r.costUsd.toFixed(2)}`);
        if (r.openLoops.length) foldOpenLoopsIntoFocus(chatId, r.openLoops);
      })
      .catch((e) => console.error('[distill] daytime pass failed', e));
  }
}, DAY_DISTILL_MIN * 60_000);

/**
 * THE INTAKE THE FOCUS SET WAS MISSING.
 *
 * Round 7 built the maintenance of the set — a deterministic checker, worker
 * escalation, a ranked surface — and every one of those assumes the item is
 * already there. Nothing created items from work flowing through the system, so
 * a bug hit in a live session could be filed in Fibery, written into a note and
 * put on a thread, and still never reach the one surface the user reads.
 *
 * This closes it: when a session is distilled and the record shows it left
 * something open, the concierge is woken ONCE with the candidates and decides
 * what enters the set and at which tier. It is a judgment call, so it costs a
 * turn — but only when a real session actually produced something, which is the
 * same bargain the checker makes.
 */
function foldOpenLoopsIntoFocus(chatId: number, loops: OpenLoop[]): void {
  const list = loops
    .map((l) => `- [${l.project}, session #${l.episodeId}] ${l.loop}\n  (that session: ${l.headline})`)
    .join('\n');
  void runConciergeSystemTurn(
    chatId,
    `[SESSIONS] ${loops.length} open loop(s) came out of the user's own work sessions just now — things his sessions OPENED and did not close:\n${list}\n\n` +
      `For each, decide whether it is already in the focus set (check the set below before adding — sessions repeat, and a duplicate is worse than a miss) and if not, whether it belongs there. The bar for ENTERING is "an open loop he touched", not "he is waiting on it right now" — a bug he hit and filed belongs in the set at a quiet tier, not nowhere. Attach a checkCmd wherever a command can answer it, so it verifies itself from then on. Put a durable one-line FACT in a note if the loop taught one, with the anchor as a pointer — never the status or the plan, which live here. ` +
      `Do NOT message the user about this; it is bookkeeping. End silently unless something here genuinely needs him now.`,
  );
}

const shutdown = () => {
  if (stopping) return;
  stopping = true;
  console.log('\n[companion] stopping…');
  stopBody(body);
  clearInterval(poll);
  clearInterval(focusSweep);
  clearInterval(entitySweep);
  atlas?.stop();
  stopPulseRelay?.();
  clearInterval(dayHarvest);
  clearInterval(dayDistill);
  void adapter.stop();
  releaseInstance();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
