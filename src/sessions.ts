import {
  getActiveSlot,
  getSession,
  recordOutbound,
  sessionKey,
  setActiveSlot,
} from './db.js';
import { chunkRaw, escapeHtml, toTelegramMarkdown } from './format.js';
import { LiveStatus } from './liveStatus.js';
import type { Buttons, ChatTransport } from './transport/types.js';

/**
 * Many logical Claude sessions live inside one chat. The user always talks to
 * the concierge (slot -1); workers (slots 0+) run in the background and surface
 * through the concierge — except a worker turn the user triggered directly (by
 * replying to one of its messages, or one the concierge handed off to "watch"),
 * which streams to the chat. There is no "active/attached" thread: a turn's
 * visibility is fixed when it starts (the `visible` flag), not by what the user
 * is looking at. This module owns that per-turn output gating plus the worker
 * status badges.
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

  private startTyping(): void {
    if (this.typing) return;
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
    await this.status.start(stopKeyboard(this.slot));
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

  async fileOp(html: string): Promise<void> {
    if (!this.visible) return;
    const tag = this.label ? `🔧 <b>${escapeHtml(this.label)}</b> · ` : '';
    await this.transport.send(this.chatId, { text: `${tag}${html}`, format: 'tgHtml' }).catch(() => {});
  }

  async answer(text: string): Promise<void> {
    if (this.visible) await sendAnswer(this.transport, this.chatId, text, this.key, this.label);
  }

  /** Mark the session blocked on a user interaction (permission / ask). */
  async block(badge: 'needsPerm' | 'asked', notice: string): Promise<void> {
    this.blocked = true;
    setBadge(this.key, badge);
    if (!this.visible) await notifyBackground(this.transport, this.chatId, notice);
  }

  unblock(): void {
    this.blocked = false;
    setBadge(this.key, 'running');
  }

  async finish(ok: boolean): Promise<void> {
    this.stopTyping();
    setBadge(this.key, ok ? 'idle' : 'error');
    // Visible: finalize the live status. Background: stay silent — the dispatcher
    // wakes the concierge to decide how to report the completion.
    if (this.visible && this.status) await this.status.finalize(ok);
  }
}

function stopKeyboard(slot: number): Buttons {
  return [[{ text: '🛑 Stop', data: `stop:${slot}` }]];
}

/** Send a one-line background notice (and clear any stale bottom keyboard). */
export async function notifyBackground(
  transport: ChatTransport,
  chatId: number,
  html: string,
): Promise<void> {
  await transport.send(chatId, { text: html, format: 'tgHtml', removeKeyboard: true }).catch(() => {});
}
