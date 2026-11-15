import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { config } from './config.js';

/**
 * THE WORKER'S SYSTEM PROMPT, FROZEN (I12 for the other half of the fleet).
 *
 * Until 2026-08-28 a worker ran on the SDK's `claude_code` preset with
 * prompts/system.md and its brief appended. The preset is not one text: the
 * CLI assembles it per PROCESS, and every turn here is a new process. Read
 * out of the 2.1.246 binary, the moving parts are:
 *
 *   - "You are powered by the model named …" — moves with the dispatch's model
 *   - "Assistant knowledge cutoff is …"       — moves with the model
 *   - "Today's date is …"                     — moves at midnight
 *   - # Environment: primary working directory, "Is a git repository",
 *     platform, shell, OS version               — moves with prefs.cwd
 *   - gitStatus: current branch, status, last five commits — a snapshot taken
 *     at process start, i.e. moves on every turn a worker COMMITS in
 *   - the auto-memory path and the loaded CLAUDE.md files
 *
 * What a custom prompt does NOT remove: the CLI (2.1.168 as bundled) prepends
 * a userContext block — the loaded CLAUDE.md files, the user's email and the
 * current date — as the first message of EVERY model call, whatever the
 * system prompt is. So the prefix still moves once a day and on an edit to
 * the target repo's CLAUDE.md; expect one full cache miss per worker per day.
 * Only a per-day rotation would close that, and it is not worth a rotation.
 *
 * Any changed byte there sits ahead of the whole transcript in the prompt
 * cache, so a resumed worker re-uploads its history — the pattern the
 * concierge ledger showed as cache_read pinned at the schemas and 60k–160k
 * written per turn (src/sessionPrompt.ts). test/workerContext.test.ts guarded
 * the APPENDED block for the same reason since 08-02; the preset in front of
 * it was never covered.
 *
 * So the worker gets what the concierge got: ONE static prompt, identical for
 * every worker (so the prefix is shared across threads too), frozen per
 * session in `session_prompts`; the volatile facts — date, cwd, platform, the
 * brief — ride ONCE in the first turn as a `[SESSION OPEN]` block. The
 * durable norms the preset used to supply are restated here; a preset section
 * that only makes sense in an interactive terminal is not.
 *
 * prompts/system.md is part of the static text. It used to take effect on
 * the next TURN; it now takes effect on the next session — or, for a live
 * session, on its next turn at the price of one cache miss: `resolveWorkerPrompt`
 * compares the stored bytes with the current build and refreshes under the
 * same transcript. No hook, no contract bump, no lost history (I9).
 */

/** prompts/system.md, or undefined when it cannot be read right now — an
 *  editor mid-save must not re-freeze a style-less prompt (the caller keeps
 *  the stored bytes instead). */
function companionPrompt(): string | undefined {
  try {
    return readFileSync(config.systemPromptPath, 'utf8').trim();
  } catch {
    return undefined;
  }
}

const ROLE = `You are a WORKER thread of a Telegram-fronted Claude Code companion: one background task, started by the concierge (the thread that talks to the user) on the user's behalf.

## What a worker is
- You do ONE task, stated in your brief. Stay inside it; when the task needs a decision that is not yours, say so plainly in your answer rather than widening the scope.
- The user sees your progress box and your final text, nothing else. Your final message is what the concierge reads to report back: lead with the outcome, then what is left open, then what you touched. Keep it short and factual — a generated brief, not a diary.
- Steering arrives as later turns marked [GUIDANCE]; treat it as the brief amended. A [SESSION OPEN] block in your first turn is a snapshot of the moment you started and is never refreshed; the date, directory and brief it carries are the ones you work under.
- You cannot write the companion's memory. What your work leaves open goes in your final answer as prose; the concierge records it. If you are blocked on something only the user can resolve, say it through reportBlocked and end the turn — never wait in a loop.

## How to work in the user's repositories
- Read before editing; prefer the dedicated file and search tools over shell one-liners for reading and editing; use Bash for commands.
- Verify with the real command (the test, the build, the CLI) and report what it printed. Never state a result you did not observe, and never claim a step ran when it was skipped — say what was skipped and why.
- Small, focused changes; match the surrounding style; no unrequested refactors, no unrequested commits or pushes.
- A long task deserves a one-line note now and then on what you are doing — the user cannot see your tool output, only your text.
- No code comments unless asked; the code should say it.
- Security work is defensive only: analysis, hardening, detection, CTF and authorized testing are fine; refuse to build destructive tooling, credential harvesting or evasion for malicious use, and say so in one line.`;

/** The whole static prompt: the role, then prompts/system.md verbatim.
 *  Undefined when the file is unreadable, unless `bare` — then the role alone. */
export function workerStaticPrompt(bare?: false): string | undefined;
export function workerStaticPrompt(bare: true): string;
export function workerStaticPrompt(bare = false): string | undefined {
  const extra = companionPrompt();
  if (extra === undefined) return bare ? ROLE : undefined;
  return extra ? `${ROLE}\n\n${extra}` : ROLE;
}

export type WorkerSnapshotVariant = 'open' | 'resent' | 'brief-updated';

const HEAD: Record<WorkerSnapshotVariant, string> = {
  open: '[SESSION OPEN — the facts at the moment this thread began. This block is a snapshot and is NOT refreshed; later guidance arrives as turns.]',
  'brief-updated':
    '[BRIEF UPDATED — the concierge rewrote your brief after this thread began. The brief below replaces the one you were opened with; the other facts are as they were. This block is a snapshot and is NOT refreshed.]',
  resent:
    '[STATE RE-SENT — your previous turn was answered without this block: the SDK opened a new transcript under a resume. These are the facts you work under; it is a snapshot and is NOT refreshed.]',
};

/** The checked-out branch in `cwd`, or undefined when it is not a repository. */
function repoBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** The one-time block that carries what the preset used to put in the prefix. */
export function workerOpenSnapshot(
  opts: { brief?: string; cwd: string; variant?: WorkerSnapshotVariant; now?: Date },
): string {
  const now = opts.now ?? new Date();
  // Local, not UTC: the machine runs at +0330 and a UTC date is yesterday
  // until 03:30 (the concierge's fmtLocal makes the same choice).
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const brief = opts.brief?.trim();
  const branch = repoBranch(opts.cwd);
  return [
    HEAD[opts.variant ?? 'open'],
    `Today's date: ${date}`,
    `Working directory: ${opts.cwd}${branch ? ` (branch: ${branch})` : ''}`,
    `Platform: ${platform()} ${release()}`,
    'Your brief (from the concierge — your task context; stay inside it):',
    brief || '(none given — the first message of the turn is the task)',
  ].join('\n');
}
