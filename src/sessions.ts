import {
  getActiveSlot,
  getSession,
  recordOutbound,
  sessionKey,
  setActiveSlot,
} from './db.js';
import { chunkRaw, toTelegramMarkdown } from './format.js';
import { LiveStatus } from './liveStatus.js';
import type { Buttons, ChatTransport } from './transport/types.js';

/**
 * Many logical Claude sessions live inside one chat. The user always talks to
 * the concierge (slot -1); workers (slots 0+) run in the background and surface
 * through the concierge — except a worker turn the concierge handed off to
 * "watch", which renders into the chat. There is no "active/attached" thread:
 * a turn's visibility is fixed when it starts (the `visible` flag), not by what
 * the user is looking at.
 *
 * A VISIBLE WORKER TURN OWNS EXACTLY ONE MESSAGE, edited in place — see
 * RunningView below. Only the concierge speaks in messages of its own, because
 * only the concierge is talking to the user.
 *
 * This module owns that per-turn output gating plus the worker status badges.
 */

export type Badge = 'idle' | 'running' | 'needsPerm' | 'asked' | 'error';

// The concierge lives at a reserved virtual slot: it has no chat_sessions row
// (so it stays out of work-thread lists, /close, /history and work-routing) but
// stores its session/messages under the key "<chatId>:-1" like any thread.
export const CONTROL_SLOT = -1;
const CONTROL_LABEL = '🎛️ Concierge';

// Transient per-session badge state, keyed by "<chatId>:<slot>". Rebuilt on
// restart from whatever the next turn does — never load-bearing.
const badges = new Map<string, Badge>();

function setBadge(key: string, badge: Badge): void {
  badges.set(key, badge);
}

function badgeOf(key: string): Badge {
  return badges.get(key) ?? 'idle';
}

function badgeIcon(badge: Badge): string {
  switch (badge) {
    case 'running':
      return '🟢';
    case 'needsPerm':
      return '❗';
    case 'asked':
      return '❓';
    case 'error':
      return '⚠️';
    default:
      return '•';
  }
}

/** Ensure a chat's state row exists (so settings/capture flags can persist). */
export function ensureChat(chatId: number): void {
  // setActiveSlot is the only upsert into chat_state; the slot value itself is
  // vestigial (there's no active thread), but it materializes the row.
  if (getActiveSlot(chatId) === undefined) setActiveSlot(chatId, CONTROL_SLOT);
}

export function titleOf(chatId: number, slot: number): string {
  if (slot === CONTROL_SLOT) return CONTROL_LABEL;
  return getSession(chatId, slot)?.title ?? `Session ${slot + 1}`;
}

/**
 * Mark a thread as having been cut off mid-turn.
 *
 * Badges live in memory and are rebuilt by whatever the next turn does, which
 * is exactly why a restart used to erase the difference between a thread that
 * finished and one that was killed mid-edit. Boot re-establishes that
 * difference from the durable turns_running rows.
 */
export function markInterrupted(key: string): void {
  setBadge(key, 'error');
}

/** A one-glyph status marker for a thread (running/needs-input), or '' if idle. */
export function statusMarker(chatId: number, slot: number): string {
  const badge = badgeOf(sessionKey(chatId, slot));
  return badge === 'idle' ? '' : badgeIcon(badge);
}

async function sendAnswer(
  transport: ChatTransport,
  chatId: number,
  text: string,
  sessionKey?: string,
  // Worker title prefix (a 🔧 marker), so the user can see which message is a
  // worker's — and which to reply to. Omitted for the concierge (the default voice).
  label?: string,
): Promise<void> {
  const tag = label ? `🔧 ${label}\n` : '';
  for (const piece of chunkRaw(text)) {
    let ref;
    try {
      ref = await transport.send(chatId, { text: toTelegramMarkdown(`${tag}${piece}`), format: 'tgMarkdownV2' });
    } catch {
      ref = await transport.send(chatId, { text: `${tag}${piece}`, format: 'plain' });
    }
    // Tag this message so a reply to it routes back to this session.
    if (sessionKey) recordOutbound(chatId, ref.messageId, sessionKey);
  }
}

/**
 * One running turn's bound output surface. When `visible`, it streams a live
 * status message, file-op notices, and the answer to the chat; when not, it
 * stays silent (a background worker) and only updates its badge — the concierge
 * reports such work on completion. Visibility is fixed for the turn's lifetime.
 */
export class RunningView {
  private status?: LiveStatus;
  private typing?: NodeJS.Timeout;
  private lastAction = 'Thinking…';
  private blocked = false;

  constructor(
    readonly transport: ChatTransport,
    readonly chatId: number,
    readonly slot: number,
    readonly visible: boolean,
    /**
     * True when the concierge dispatched this turn and is waiting to report it,
     * rather than the user having asked for it directly.
     *
     * This used to be the same bit as `visible`, which forced a false choice:
     * a dispatched worker was either reported by the concierge OR shown to the
     * user, never both. Now every worker turn gets a box and this only decides
     * who is told when it ends and when it gets stuck.
     */
    readonly background = false,
  ) {}

  get key(): string {
    return sessionKey(this.chatId, this.slot);
  }

  get title(): string {
    return titleOf(this.chatId, this.slot);
  }

  async begin(): Promise<void> {
    if (!this.blocked) setBadge(this.key, 'running');
    if (this.visible) await this.openLive();
  }

  /** Typing belongs to the concierge alone: it is the chat-level "someone is
   *  replying to you" hint, and the user is only ever talking to the concierge.
   *  A worker running in the background must not make the chat look like it is
   *  about to answer. */
  private startTyping(): void {
    if (this.slot !== CONTROL_SLOT || this.typing) return;
    void this.transport.typing(this.chatId);
    this.typing = setInterval(() => {
      void this.transport.typing(this.chatId);
    }, 5000);
  }

  private stopTyping(): void {
    if (this.typing) {
      clearInterval(this.typing);
      this.typing = undefined;
    }
  }

  /** Open the live status message + typing for a visible turn. */
  private async openLive(): Promise<void> {
    if (this.status) return;
    this.startTyping();
    this.status = new LiveStatus(this.transport, this.chatId, this.label);
    await this.status.start(runningKeyboard(this.slot));
    this.status.push(this.lastAction, '🧠');
  }

  action(summary: string, emoji: string): void {
    this.lastAction = summary;
    if (!this.blocked) setBadge(this.key, 'running');
    if (this.visible) {
      void this.openLive().then(() => this.status?.push(summary, emoji));
    }
  }

  /** A worker title marker for messages, so the user can tell whose output it is. */
  private get label(): string | undefined {
    return this.slot === CONTROL_SLOT ? undefined : this.title;
  }

  /**
   * A WORKER OCCUPIES ONE MESSAGE.
   *
   * The concierge is the voice the user reads, so its answers are still real
   * chat messages. A worker's output is progress on a task the concierge
   * dispatched: it folds into the single live-status message this turn already
   * owns, edited in place. A long worker run is now one line in the thread that
   * keeps changing, instead of a wall of narration the user scrolls past to find
   * the concierge again.
   */
  private get inlineOnly(): boolean {
    return this.slot !== CONTROL_SLOT;
  }

  /** File-op notices carry an expandable diff, which cannot fold into the live
   *  message — and `action()` has already logged the same op by name. So for a
   *  worker this is dropped: the diff is in the repo, not the chat. */
  async fileOp(html: string): Promise<void> {
    if (!this.visible || this.inlineOnly) return;
    await this.transport.send(this.chatId, { text: html, format: 'tgHtml' }).catch(() => {});
  }

  async answer(text: string): Promise<void> {
    if (!this.visible) return;
    if (this.inlineOnly) {
      await this.openLive();
      this.status?.say(text);
      return;
    }
    await sendAnswer(this.transport, this.chatId, text, this.key, this.label);
  }

  /** Mark the session blocked on a user interaction (permission / ask). A
   *  dispatched worker still shouts, because nobody is watching its box on
   *  purpose — the user asked the concierge, not it. */
  async block(badge: 'needsPerm' | 'asked', notice: string): Promise<void> {
    this.blocked = true;
    setBadge(this.key, badge);
    if (this.background) await notifyBackground(this.transport, this.chatId, notice);
  }

  unblock(): void {
    this.blocked = false;
    setBadge(this.key, 'running');
  }

  /**
   * Close the box. `headline` names an ending that was not an ordinary finish —
   * a cancel, a timeout, an error — so it lands IN the box instead of as a
   * loose message next to it.
   */
  /** After finish(): put the run's brief under the closed box in place of the cut tail. */
  async showBrief(brief: string): Promise<void> {
    if (this.visible && this.status) await this.status.showBrief(brief);
  }

  async finish(ok: boolean, headline?: string): Promise<void> {
    this.stopTyping();
    // A turn that ended while blocked (it posted a question and returned) keeps
    // its 'asked' badge — the thread is waiting on the user, not idle.
    if (!this.blocked) setBadge(this.key, ok ? 'idle' : 'error');
    if (this.visible && this.status) await this.status.finalize(ok, restKeyboard(this.slot), headline);
  }
}

/** While a turn runs, the only useful action is to call it off. */
function runningKeyboard(slot: number): Buttons {
  return [[{ text: '🛑 Stop', data: `stop:${slot}` }]];
}

/**
 * Once a WORKER's turn ends its box becomes a small control panel, because the
 * user can no longer reply into the thread — everything they might want to do
 * with it has to be reachable from here or through the concierge.
 *
 * Both buttons are free in the sense that matters: they call functions that
 * already exist. Continue is `enqueueTurn` with a nudge, the same path a
 * dispatch takes. Recap reads the rolling one-liner the system already
 * maintains after every worker turn, and fits a callback toast.
 *
 * The concierge gets no buttons: the user simply types at it.
 */
function restKeyboard(slot: number): Buttons {
  // Empty, not undefined: the concierge's finished box must CLEAR its Stop
  // button rather than keep a dead one (see toKeyboard in the telegram adapter).
  if (slot === CONTROL_SLOT) return [];
  return [[
    { text: '▶️ Continue', data: `cont:${slot}` },
    { text: '📋 Recap', data: `recap:${slot}` },
  ]];
}

/** Send a one-line background notice (and clear any stale bottom keyboard). */
export async function notifyBackground(
  transport: ChatTransport,
  chatId: number,
  html: string,
): Promise<void> {
  await transport.send(chatId, { text: html, format: 'tgHtml', removeKeyboard: true }).catch(() => {});
}
