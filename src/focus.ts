import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  addFocusChange,
  checkableCommitments,
  deferCommitment,
  type CommitmentRecord,
  escalationsToday,
  focusBands,
  makeCommitmentDue,
  noteCheckMiss,
  openFocusChanges,
  postEvent,
  recordCheck,
  touchCheck,
  appendWatchLog,
  setWatchHead,
} from './db.js';
import { parseEmission, shouldWake, type CheckEmission } from './ledger.js';
import { fmtLocal, toUtcDb } from './commitments.js';
import { pulse } from './pulse.js';

/**
 * THE FOCUS SET (round 7) — a small, verified list of what deserves Mehdi's
 * attention, kept fresh WITHOUT paying a concierge turn to discover that
 * nothing happened.
 *
 * A focus item is not a new kind of thing: it is a watched commitment carrying
 * a `check_cmd` — a deterministic command whose scrubbed stdout is comparable
 * run to run. This module runs those commands out of process (same shape as
 * watch.ts), hashes the result, and does exactly one of two things:
 *
 *   unchanged → update the timestamp, push the item's fallback pulse out, and
 *               spend NOTHING. This is the common case, and it used to cost a
 *               full [PULSE] concierge turn every 4 hours per item.
 *   changed   → record the diff and set due_at = now, so the 60s poller raises
 *               ONE pulse that arrives with the before/after already in hand.
 *
 * The concierge is therefore woken by CHANGE, not by clock. Checking is code;
 * judging stays with the concierge.
 */

/** How stale a check may be before the sweep re-runs it. */
const CHECK_EVERY_MIN = Number(process.env.FOCUS_CHECK_MIN ?? 15);
/** Where an unchanged item's fallback pulse gets pushed to. The checker is the
 *  real trigger now; this is only a sanity net for a check that silently rots
 *  (a command that stopped working, an item nobody ever resolves). */
const QUIET_HOURS = Number(process.env.FOCUS_QUIET_H ?? 168);
/** Escalations per item per day before it is treated as noise. A flapping check
 *  (an output with a token we failed to scrub) must never become a token pump. */
const NOISE_CAP = 4;
const CMD_TIMEOUT_MS = 60_000;
const STATE_CAP = 800;

/**
 * Allowlist. This runs in the bot's own process, OUTSIDE the worker permission
 * sandbox — so it is a fixed set of read-only lookups, not a general shell,
 * exactly as watch.ts restricts itself to `gh`. `cd <path> &&` prefixes are
 * unwrapped first because that is how the real entries are written
 * ("cd ~/Projects/ops-tool && git fetch && gh pr checks 10").
 */
const ALLOWED = [
  'gh ',
  'git ',
  'grep ',
  'rg ',
  'ls ',
  'cat ',
  'test ',
  'jq ',
  `${homedir()}/Projects/brain-fibery/scripts/fibery `,
  '~/Projects/brain-fibery/scripts/fibery ',
];

/** Every `&&`-joined segment must be an allowed lookup (a bare `cd` is fine). */
export function checkCommandAllowed(command: string): boolean {
  const segments = command.split('&&').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((s) => s.startsWith('cd ') || ALLOWED.some((p) => s.startsWith(p)));
}

/**
 * Remove what changes on every run so a stable question gives a stable answer.
 * Without this, `gh pr checks` diffs against itself forever: its output carries
 * the elapsed time of each check, so every sweep would "detect a change" and
 * wake the concierge — the exact cost this module exists to remove.
 */
export function scrub(out: string): string {
  return out
    .replace(/\[[0-9;]*m/g, '') // ANSI colour
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?/g, '<ts>')
    .replace(/\b\d+(\.\d+)?\s*(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?|months?)\s+ago\b/gi, '<ago>')
    .replace(/\b\d+h\d+m\d+s\b|\b\d+m\d+s\b|\b\d+(\.\d+)?s\b/g, '<dur>')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
}

/**
 * Output that means "I could not answer", not "the answer is this".
 *
 * Deliberately a short, literal list rather than a general heuristic: a checker
 * legitimately answers with arbitrary text, so anything clever here would start
 * swallowing real states. These are the shapes the live ledger actually produced
 * — the `|| echo TRANSIENT` sentinel the checks themselves use, a jq that could
 * not parse what it was handed, and the network-layer failures of `gh`/`fibery`.
 *
 * THIS LIST IS THE WHOLE GATE, because `runCommand` deliberately ignores exit
 * codes (a non-zero exit is a legitimate answer for `gh pr checks` and `grep`).
 * A tool that fails therefore arrives here indistinguishable from one that
 * succeeded, and anything this pattern misses becomes an entity's state.
 *
 * So match jq by its PREFIX, not by one of its messages. The first version of
 * this list spelled out `jq: error`, which is one of the several things jq
 * says: on 2026-08-02 the live log flapped
 * `To Do → jq: parse error: Invalid numeric literal → To Do` on three entities,
 * because a parse error is not an `error` by that spelling. jq writes every
 * diagnostic to stderr with a `jq: ` prefix and never writes that prefix to
 * stdout, so the prefix is the honest test and the enumeration was never going
 * to be complete. Same reasoning for Go's HTTP client, which is what `gh` and
 * the fibery script are built on: `Post "https://…": <cause>` is a transport
 * failure whatever the cause turns out to be.
 */
const UNANSWERED =
  /^TRANSIENT$|\bjq: |\b(Get|Post|Put|Delete) "https?:\/\/|\bi\/o timeout\b|\bdial tcp\b|\bconnection (refused|reset)\b|\bcould not resolve host\b|\bTLS handshake timeout\b|\bcurl: \(\d+\)|\bResolving timed out\b/i;

/**
 * THE THREE OUTCOMES OF A CHECK, in one place (Charter I3).
 *
 * A command that answers, a command that ran and could not answer, and a
 * command that could not run. Only the first may become state.
 *
 * This lives here rather than in each caller because it was written twice and
 * only once correctly. Round 10 diagnosed the class — an unanswerable check
 * being stored AS the answer — and fixed it in the focus checker alone; the
 * prober kept the empty-output guard it already had and nothing else. So on
 * 2026-08-02 the live log showed entities whose stored state was
 * `jq: error (at <stdin>:0): Cannot index o…`, healing only when a later probe
 * happened to succeed. Round 10's own plan called for exactly this helper and
 * it was the step that got skipped.
 *
 * A shared classifier is the point: the rule cannot hold on one path and not
 * the other, because the two paths are the same rule.
 */
export type CheckResult =
  | { kind: 'value'; value: string }
  | { kind: 'unanswered'; detail: string }
  | { kind: 'failed'; detail: string };

export function classifyCheck(run: RunResult, cap: number): CheckResult {
  if (!run.ok) return { kind: 'failed', detail: run.output.slice(0, 200) };
  const value = scrub(run.output).slice(0, cap);
  // Empty first: a command that succeeds while saying nothing has told us
  // nothing, and that is what froze the state layer for three days in July.
  if (!value) return { kind: 'unanswered', detail: 'exited 0 and printed nothing' };
  if (UNANSWERED.test(value)) return { kind: 'unanswered', detail: value.slice(0, 200) };
  return { kind: 'value', value };
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export interface RunResult {
  ok: boolean;
  output: string;
}

/** Run one check command and return its combined output (capped). Shared with
 *  the entity prober (round 8) — same sandbox rules, same output cap. */
export function runCommand(command: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, output: `failed to launch: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let out = '';
    const absorb = (b: Buffer) => {
      out = (out + b.toString()).slice(0, 8000);
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    const killer = setTimeout(() => child.kill('SIGTERM'), CMD_TIMEOUT_MS);
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ ok, output: out });
    };
    child.on('error', (e) => {
      absorb(Buffer.from(`\nspawn error: ${e.message}`));
      settle(false);
    });
    // A non-zero exit is NOT a failure here: `gh pr checks` exits 8 while checks
    // are pending, `grep` exits 1 on no-match — both are legitimate ANSWERS.
    // Only an unlaunchable command is a failure.
    child.on('exit', () => settle(true));
  });
}

/**
 * Check ONE item now. Returns whether a change was escalated.
 *
 * The first check of an item is a BASELINE, never news — otherwise every newly
 * created focus item would immediately wake the concierge to report the state
 * that was just written by hand.
 */
export async function checkItem(c: CommitmentRecord, reason: 'sweep' | 'verify' = 'sweep'): Promise<boolean> {
  if (!c.check_cmd) return false;
  if (!checkCommandAllowed(c.check_cmd)) {
    console.warn(`[focus] #${c.id} check_cmd not allowlisted, skipping: ${c.check_cmd.slice(0, 80)}`);
    touchCheck(c.id);
    return false;
  }
  const run = await runCommand(c.check_cmd);
  // THE LEDGER PATH (design proposal #1): a check that emits `{head, detail?}`
  // keeps its own structured state, and the wake is its mode's decision —
  // never the hash-diff below. Plain-text checks are untouched.
  if (run.ok) {
    const em = parseEmission(run.output);
    if (em) return ledgerCheck(c, em, reason);
  }
  const outcome = classifyCheck(run, STATE_CAP);
  if (outcome.kind !== 'value') {
    // A CHECK THAT COULD NOT ANSWER IS NOT A CHANGE. Exit code alone does not
    // tell us this: a `gh` call that dies on a network timeout still exits 0
    // through a pipeline, and `|| echo TRANSIENT` — the idiom these checks use
    // to avoid an empty answer — converts a blip into a brand-new "state". The
    // live evidence (focus_changes #32-#49, 2026-07-30/31) is a checker
    // flapping between real values and `TRANSIENT`, a `dial tcp … i/o timeout`
    // stored AS the state of a PR, and a `jq: error …` stored as the state of a
    // Fibery task — each one waking the concierge, and each one burning down the
    // noise cap that then suppressed the REAL change when it came. An
    // unanswerable check must be indistinguishable from a check that did not run.
    console.warn(`[focus] #${c.id} ${c.label}: check ${outcome.kind} — ${outcome.detail.slice(0, 80)}`);
    touchCheck(c.id);
    noteCheckMiss('focus', `#${c.id} ${c.label}`, outcome.kind, outcome.detail);
    return false;
  }
  const state = outcome.value;
  const h = hash(state);

  if (!c.last_seen) {
    recordCheck(c.id, state, h);
    console.log(`[focus] #${c.id} ${c.label}: baseline recorded`);
    return false;
  }
  if (h === c.last_seen) {
    touchCheck(c.id);
    // Nothing moved: push the fallback pulse out rather than letting the clock
    // fire a turn that would find exactly what we just found for free.
    if (reason === 'sweep') {
      deferCommitment(c.id, c.chat_id, toUtcDb(new Date(Date.now() + QUIET_HOURS * 3_600_000)));
    }
    return false;
  }

  // CHANGED.
  const before = c.check_state ?? '(no stored state)';
  recordCheck(c.id, state, h);
  if (escalationsToday(c.id) >= NOISE_CAP) {
    console.warn(`[focus] #${c.id} ${c.label}: ${NOISE_CAP}+ changes in 24h — absorbing silently (noisy check)`);
    return false;
  }
  addFocusChange(c.chat_id, c.id, 'checker', { before, after: state });
  makeCommitmentDue(c.id);
  postEvent(c.chat_id, 'focus', `changed: ${c.label}`);
  pulse('focus', `#${c.id} ${c.label}: ${before.slice(0, 24)} → ${state.slice(0, 24)}`, {
    loud: true,
    meta: { commitmentId: c.id, label: c.label, before, after: state },
  });
  console.log(`[focus] #${c.id} ${c.label}: CHANGED — pulse queued`);
  return true;
}

/**
 * A check that spoke JSON. The head is overwritten, the detail (if any) is
 * logged, and the mode decides whether this is news. The first head is a
 * baseline like any first check. A 'log' item defers its clock out to the
 * quiet horizon so the fallback pulse never fires for it; a predicate item
 * wakes only when the predicate holds on the NEW head and the head moved
 * (a rule that stays true is one alert, not one per sweep).
 */
async function ledgerCheck(c: CommitmentRecord, em: CheckEmission, reason: 'sweep' | 'verify'): Promise<boolean> {
  const headJson = JSON.stringify(em.head);
  const h = hash(headJson);
  const first = !c.last_seen;
  const changed = !first && h !== c.last_seen;
  setWatchHead(c.id, em.head);
  recordCheck(c.id, headJson.slice(0, STATE_CAP), h);
  if (em.detail !== undefined) appendWatchLog(c.id, changed ? 'change' : first ? 'baseline' : 'sample', em.detail);
  if (first) {
    console.log(`[focus] #${c.id} ${c.label}: ledger baseline recorded`);
    return false;
  }
  const verdict = shouldWake(c.watch_mode, changed, em.head);
  if (verdict.error) {
    // A predicate that cannot be read is an unanswered check, not a wake and
    // not a silence to trust: it is recorded where unanswered checks go.
    noteCheckMiss('focus', `#${c.id} ${c.label}`, 'unanswered', `watch_mode: ${verdict.error}`);
  }
  if (!verdict.wake || !changed) {
    if (reason === 'sweep') deferCommitment(c.id, c.chat_id, toUtcDb(new Date(Date.now() + QUIET_HOURS * 3_600_000)));
    return false;
  }
  if (escalationsToday(c.id) >= NOISE_CAP) {
    console.warn(`[focus] #${c.id} ${c.label}: ${NOISE_CAP}+ wakes in 24h — absorbing (a flapping predicate is as buggy as a flapping check)`);
    return false;
  }
  const before = c.watch_head ?? '(no stored head)';
  addFocusChange(c.chat_id, c.id, 'checker', { before, after: headJson });
  makeCommitmentDue(c.id);
  postEvent(c.chat_id, 'focus', `ledger wake: ${c.label}`);
  pulse('focus', `#${c.id} ${c.label}: head crossed ${c.watch_mode ?? 'changed'}`, {
    loud: true,
    meta: { commitmentId: c.id, label: c.label, before, after: headJson },
  });
  console.log(`[focus] #${c.id} ${c.label}: LEDGER WAKE (${c.watch_mode ?? 'changed'}) — pulse queued`);
  return true;
}

/** The background sweep. Sequential on purpose: a handful of `gh` lookups every
 *  quarter hour should be invisible, not a thundering herd. */
export async function sweepFocusChecks(): Promise<void> {
  const cutoff = toUtcDb(new Date(Date.now() - CHECK_EVERY_MIN * 60_000));
  const due = checkableCommitments(cutoff);
  for (const c of due) {
    try {
      await checkItem(c);
    } catch (e) {
      console.error(`[focus] #${c.id} sweep error`, e);
    }
  }
}

/**
 * Verify one item immediately — the path a worker's incidental observation
 * takes. A worker saying "TCP3 looks merged" is a lead, not a fact: `gh` is
 * what confirms it. If the item has no machine check, the observation still
 * reaches the concierge, flagged unverified.
 */
export async function verifyFocusItem(item: CommitmentRecord): Promise<void> {
  if (item.check_cmd) {
    try {
      await checkItem(item, 'verify');
    } catch (e) {
      console.error(`[focus] #${item.id} verify error`, e);
    }
  }
  makeCommitmentDue(item.id);
}

/** Render the pending change rows for a pulse entry (and mark them consumed by
 *  the caller). Empty string when the entry is firing on its fallback clock. */
export function renderChanges(rows: ReturnType<typeof openFocusChanges>): string {
  return rows
    .map((r) => {
      if (r.source === 'worker') {
        return `   WORKER OBSERVED (${r.created_at} UTC): ${r.observation ?? ''}`;
      }
      return `   CHANGED (${r.created_at} UTC)\n   was: ${(r.before ?? '').replace(/\n/g, ' | ').slice(0, 300)}\n   now: ${(r.after ?? '').replace(/\n/g, ' | ').slice(0, 300)}`;
    })
    .join('\n');
}

/**
 * One compact line for one item — the shape the concierge sees.
 *
 * NO WALL-CLOCK STAMP. This text lands in a system prompt, so a value that
 * ticks makes the whole cached prefix behind it worthless — the sweep runs
 * every few minutes, so a per-item `checked 14:32` guaranteed a full re-cache
 * on essentially every turn. What a reader needs is whether the item verifies
 * itself and whether it has ever answered, and neither of those changes when
 * the clock does. The exact time is still on the item and in the Atlas.
 */
function focusLine(c: CommitmentRecord): string {
  const state = (c.check_state ?? '').replace(/\s+/g, ' ').slice(0, 120);
  const how = c.check_cmd ? 'auto-checked' : 'manual';
  const seen = c.last_checked_at ? '' : ' · never checked';
  // THE REF, AND DELIBERATELY ONLY THE REF (M4).
  //
  // Not the entity's facts, not its neighbours. A fat line here would re-create
  // exactly what was deleted on 2026-08-06 for I7/I12 — a pre-computed snapshot
  // standing in for a retrieval — and it would pre-empt the very read this
  // milestone exists to create. The pointer is the invitation; following it is
  // the episode, and the episode is what M9 optimizes.
  const ref = c.ref ? `\n    graph: ${c.ref} — find("${c.ref}") for what is known, neighbours() for what it touches` : '';
  return `- #${c.id} ${c.label} — ${c.body.split('\n')[0]}${state ? `\n    last seen: ${state}` : ''}${ref}\n    [${how}${seen}]`;
}

/**
 * The focus set as text, grouped into the bands it actually has.
 *
 * The bands are not a fixed ladder. Tier 1 is whatever is closest to the user
 * right now and the numbers climb as items get quieter; how many exist is
 * decided per-set by the concierge, so a set that is all one thing prints as
 * one group and a spread-out one prints as several.
 */
export function focusLines(chatId: number): string[] {
  const bands = focusBands(chatId);
  if (bands.length <= 1) return (bands[0]?.items ?? []).map(focusLine);
  return bands.flatMap((b) => [`### ${b.tier}. ${b.title}`, ...b.items.map(focusLine)]);
}
