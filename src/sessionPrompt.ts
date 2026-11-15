/**
 * ONE PROMPT PER SESSION (I12: "injected context must be STABLE for the life
 * of the session").
 *
 * The concierge's system prompt is a cache prefix: every byte of it sits ahead
 * of the whole transcript. Until 2026-08-27 it was rebuilt on every turn with
 * live state inlined — the attention set, today's events, open commitments —
 * and any changed byte moved the prefix, so the transcript behind it was
 * re-uploaded on the first call of every turn. The ledger read it as
 * cache_read = 13,573 tokens (the tool schemas, the only stable part) against
 * 60k–160k cache_written per turn; three isolation experiments proved the SDK
 * caches a resumed transcript across processes whenever the prefix holds.
 *
 * So: the prompt is built ONCE when a session opens, stored, and reused
 * byte-for-byte until the session is cleared (the night, a rotation, /reset,
 * a debug exit — every path goes through `clearSession`, which drops it). The
 * state the prompt used to carry goes into the FIRST TURN as a one-time
 * snapshot; after that the concierge learns by living its turns and asks for
 * the rest. A session's contract (the tool set it was built under) is stored
 * with the prompt: a new contract is a new session, and the prompt is rebuilt.
 *
 * Two things this resolver has to tell apart, because they look alike:
 *   OPENED    — no prompt AND no session: the snapshot is owed, and stays owed
 *               until a turn carrying it ENDS ok (`settleSnapshot`, from the
 *               turn's finally — never from the session acknowledgement, which
 *               fires at init and would settle a debt a dying turn never paid).
 *   REFRESHED — no prompt but a session exists: the root render moved under a
 *               live transcript (src/rootBehavior.ts dropped the prompt). The
 *               prompt is rebuilt — one cache miss, the right price — and NO
 *               snapshot is sent: the transcript already lived the state.
 */
import { conciergeStaticPrompt, sessionOpenSnapshot } from './concierge.js';
import { freezePrompt, frozenPrompt, getCard, getSessionId, setSnapshotOwed } from './db.js';
import { workerOpenSnapshot, workerStaticPrompt } from './workerPrompt.js';

export type PromptResolution = 'stored' | 'opened' | 'refreshed';

export interface ResolvedPrompt {
  /** The system prompt for this turn — frozen for the session. */
  systemPrompt: string;
  /** The one-time state block for THIS turn, when one is owed. */
  sessionOpen?: string;
  /** How the prompt was obtained. */
  resolution: PromptResolution;
}

/**
 * The prompt for a concierge turn. A stored prompt under the same contract is
 * returned unchanged, whatever the world did since; if a snapshot is still
 * owed it rides along. Otherwise the prompt is built now and frozen: with the
 * snapshot when the session is new, without it when only the prompt moved.
 */
export function resolveConciergePrompt(chatId: number, sessionKey: string, contract: string): ResolvedPrompt {
  const stored = frozenPrompt(sessionKey);
  if (stored && stored.contract === contract) {
    if (stored.snapshotOwed === 0) return { systemPrompt: stored.prompt, resolution: 'stored' };
    const variant = stored.snapshotOwed === 2 ? 'resent' : 'open';
    return { systemPrompt: stored.prompt, sessionOpen: sessionOpenSnapshot(chatId, variant), resolution: 'stored' };
  }
  const systemPrompt = conciergeStaticPrompt(chatId);
  // A live transcript UNDER THIS CONTRACT and no prompt: the prompt was
  // dropped under it (the root render moved), not the session. Rebuild, owe
  // nothing. The contract matters: at a contract rollover every warm session
  // has an id the resume will refuse, and "refreshed, owe nothing" would open
  // a fresh transcript that never sees the snapshot (review, 2026-08-28).
  if (getSessionId(sessionKey, contract)) {
    freezePrompt(sessionKey, contract, systemPrompt, 0);
    return { systemPrompt, resolution: 'refreshed' };
  }
  freezePrompt(sessionKey, contract, systemPrompt, 1);
  return { systemPrompt, sessionOpen: sessionOpenSnapshot(chatId, 'open'), resolution: 'opened' };
}

/**
 * A turn that carried the snapshot ENDED ok: it is in the transcript now.
 * Called from the turn's finally, on the control slot, only when the turn
 * both sent a snapshot and finished without error.
 */
export function settleSnapshot(sessionKey: string): void {
  setSnapshotOwed(sessionKey, 0);
}

/**
 * Called when the SDK acknowledges the session for a turn. If the turn
 * RESUMED a session and the SDK answered with a different id, the transcript
 * is a new one that never saw the snapshot: owe one (variant "resent") for the
 * next turn. Returns whether the session was replaced, so the caller can say so.
 */
export function noteSessionReplaced(sessionKey: string, resumed: string | undefined, acked: string): boolean {
  if (resumed && acked !== resumed) {
    setSnapshotOwed(sessionKey, 2);
    return true;
  }
  return false;
}

/**
 * THE WORKER'S PROMPT, by the same rules and the same table (src/workerPrompt.ts
 * lists what the preset it replaces used to move). Two differences, both
 * because a worker has no root render behind it:
 *   - the static text is COMPARED, not dropped: prompts/system.md is edited by
 *     hand with no writer in code to hook, so a stored prompt whose bytes no
 *     longer match the current build is refreshed under the live transcript —
 *     one cache miss, the history kept, and the snapshot debt carried as it was;
 *   - the snapshot is the brief plus the facts the preset carried (date, cwd,
 *     platform), rebuilt from the CURRENT brief every time it is owed, so a
 *     brief that changes before the first turn settles is the one that lands;
 *     and a brief changed AFTER it settled (dispatchTask onto a warm slot,
 *     switchThread with a brief) re-owes the block as [BRIEF UPDATED] — the
 *     old per-turn append delivered that for free, the frozen prompt cannot
 *     (`setBrief` in src/db.ts owes it, by mechanism).
 */
export function resolveWorkerPrompt(
  chatId: number,
  slot: number,
  sessionKey: string,
  contract: string,
  cwd: string,
): ResolvedPrompt {
  const built = workerStaticPrompt();
  const stored = frozenPrompt(sessionKey);
  // A build with prompts/system.md unreadable (an editor mid-save) is not a
  // change: keep the stored bytes rather than freezing a style-less prompt.
  const systemPrompt = built ?? stored?.prompt ?? workerStaticPrompt(true);
  const snapshot = (owed: 1 | 2 | 3) =>
    workerOpenSnapshot({
      brief: getCard(chatId, slot)?.brief,
      cwd,
      variant: owed === 2 ? 'resent' : owed === 3 ? 'brief-updated' : 'open',
    });
  if (stored && stored.contract === contract) {
    let resolution: PromptResolution = 'stored';
    if (stored.prompt !== systemPrompt) {
      // prompts/system.md moved under a live session: rebuild, debt unchanged.
      freezePrompt(sessionKey, contract, systemPrompt, stored.snapshotOwed);
      resolution = 'refreshed';
    }
    if (stored.snapshotOwed === 0) return { systemPrompt, resolution };
    return { systemPrompt, sessionOpen: snapshot(stored.snapshotOwed), resolution };
  }
  if (getSessionId(sessionKey, contract)) {
    freezePrompt(sessionKey, contract, systemPrompt, 0);
    return { systemPrompt, resolution: 'refreshed' };
  }
  freezePrompt(sessionKey, contract, systemPrompt, 1);
  return { systemPrompt, sessionOpen: snapshot(1), resolution: 'opened' };
}
