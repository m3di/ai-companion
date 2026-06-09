import type { Api, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import {
  countSessions,
  getActiveSlot,
  getMemo,
  getSession,
  listSessions,
  recentMessages,
  sessionKey,
  setActiveSlot,
  setSessionStatus,
  touchSession,
} from './db.js';
import { chunkRaw, escapeHtml, toTelegramMarkdown } from './format.js';
import { LiveStatus } from './liveStatus.js';

/**
 * Many logical Claude sessions live inside one Telegram chat. Exactly one is
 * "attached" (its live stream is shown in the chat); the rest keep running but
 * stay quiet, surfacing only through badges on the bottom reply keyboard. This
 * module owns that multiplexing: session state, the keyboard, attach/switch,
 * and the per-turn output gating that decides what actually reaches the chat.
 */

export type Badge = 'idle' | 'running' | 'needsPerm' | 'asked' | 'error';

// The concierge lives at a reserved virtual slot: it has no chat_sessions row
// (so it stays out of work-thread lists, /close, /history and work-routing) but
// stores its session/messages under the key "<chatId>:-1" like any thread.
export const CONTROL_SLOT = -1;
const CONTROL_LABEL = '🎛️ Concierge';

const CATCHUP_LINES = 6;

// Transient per-session badge state, keyed by "<chatId>:<slot>". Rebuilt on
// restart from whatever the next turn does — never load-bearing.
const badges = new Map<string, Badge>();
// Live turn views, so a switch can attach/detach a turn that is mid-flight.
const views = new Map<string, RunningView>();

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

/**
 * Ensure a chat is initialised. New chats start at the concierge (home base);
 * the legacy ":0" work session is preserved for existing chats.
 */
export function ensureChat(chatId: number): void {
  // Home base: you always land in, and return to, the concierge.
  if (getActiveSlot(chatId) === undefined) setActiveSlot(chatId, CONTROL_SLOT);
  if (countSessions(chatId, 'active') > 0) return;
  const existing = getSession(chatId, 0);
  if (existing && existing.status === 'closed') setSessionStatus(chatId, 0, 'active');
}

export function activeSlot(chatId: number): number {
  ensureChat(chatId);
  return getActiveSlot(chatId) ?? 0;
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

async function sendAnswer(api: Api, chatId: number, text: string): Promise<void> {
  for (const piece of chunkRaw(text)) {
    try {
      await api.sendMessage(chatId, toTelegramMarkdown(piece), { parse_mode: 'MarkdownV2' });
    } catch {
      await api.sendMessage(chatId, piece);
    }
  }
}

/**
 * One running turn's bound output surface. Routes events to the chat only while
 * its session is attached; otherwise it just updates the badge. Held in `views`
 * so a switch can attach/detach it mid-flight.
 */
export class RunningView {
  private status?: LiveStatus;
  private typing?: NodeJS.Timeout;
  private lastAction = 'Thinking…';
  private blocked = false;

  constructor(
    private readonly ctx: Context,
    readonly chatId: number,
    readonly slot: number,
    // Post the final reply even when detached (a background concierge notice).
    private readonly forceVisible = false,
  ) {}

  get key(): string {
    return sessionKey(this.chatId, this.slot);
  }

  get title(): string {
    return titleOf(this.chatId, this.slot);
  }

  get api(): Api {
    return this.ctx.api;
  }

  isAttached(): boolean {
    return getActiveSlot(this.chatId) === this.slot;
  }

  async begin(): Promise<void> {
    views.set(this.key, this);
    if (!this.blocked) setBadge(this.key, 'running');
    if (this.isAttached()) await this.openLive();
  }

  private startTyping(): void {
    if (this.typing) return;
    void this.ctx.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    this.typing = setInterval(() => {
      void this.ctx.api.sendChatAction(this.chatId, 'typing').catch(() => {});
    }, 5000);
  }

  private stopTyping(): void {
    if (this.typing) {
      clearInterval(this.typing);
      this.typing = undefined;
    }
  }

  /** Open (or reopen) the live status message + typing for the attached view. */
  private async openLive(): Promise<void> {
    if (this.status) return;
    this.startTyping();
    this.status = new LiveStatus(this.ctx, this.chatId);
    await this.status.start(stopKeyboard());
    this.status.push(this.lastAction, '🧠');
  }

  /** Called by a switch when this turn's session becomes the attached one. */
  async attach(): Promise<void> {
    if (!this.status) await this.openLive();
  }

  /** Called by a switch when the user navigates away from this running turn. */
  async detach(): Promise<void> {
    this.stopTyping();
    if (this.status) {
      await this.status.freeze('↪️ <b>Moved to background</b> — running…');
      this.status = undefined;
    }
  }

  action(summary: string, emoji: string): void {
    this.lastAction = summary;
    if (!this.blocked) setBadge(this.key, 'running');
    if (this.isAttached()) {
      void this.openLive().then(() => this.status?.push(summary, emoji));
    }
  }

  async fileOp(html: string): Promise<void> {
    if (this.isAttached()) await this.api.sendMessage(this.chatId, html, { parse_mode: 'HTML' }).catch(() => {});
  }

  async answer(text: string): Promise<void> {
    if (this.isAttached() || this.forceVisible) await sendAnswer(this.api, this.chatId, text);
  }

  /** Mark the session blocked on a user interaction (permission / ask). */
  async block(badge: 'needsPerm' | 'asked', notice: string): Promise<void> {
    this.blocked = true;
    setBadge(this.key, badge);
    if (!this.isAttached()) await notifyBackground(this.api, this.chatId, notice);
  }

  unblock(): void {
    this.blocked = false;
    setBadge(this.key, 'running');
  }

  async finish(ok: boolean): Promise<void> {
    views.delete(this.key);
    this.stopTyping();
    setBadge(this.key, ok ? 'idle' : 'error');
    // Attached: finalize the live status. Detached: stay silent here — telegram
    // wakes the concierge to decide how to report a background completion.
    if (this.isAttached() && this.status) await this.status.finalize(ok);
  }
}

function stopKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🛑 Stop', 'stop');
}

/** Send a one-line background notice (and clear any stale bottom keyboard). */
export async function notifyBackground(api: Api, chatId: number, html: string): Promise<void> {
  await api
    .sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } })
    .catch(() => {});
}

/**
 * Attach a chat to a session: mark it active, replay the last few messages, and
 * if a turn is mid-flight, hand the live view over so it streams from here on.
 */
export async function attachSession(api: Api, chatId: number, slot: number): Promise<void> {
  const prev = activeSlot(chatId);
  if (prev !== slot) await views.get(sessionKey(chatId, prev))?.detach();

  setActiveSlot(chatId, slot);
  touchSession(chatId, slot);

  const title = titleOf(chatId, slot);
  const msgs = recentMessages(sessionKey(chatId, slot), CATCHUP_LINES);
  const transcript = msgs.length
    ? msgs
        .map((m) => {
          const who = m.role === 'user' ? '🧑' : '🤖';
          const body = m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content;
          return `${who} ${escapeHtml(body)}`;
        })
        .join('\n\n')
    : '<i>No messages yet.</i>';

  const running = views.has(sessionKey(chatId, slot));
  const here = slot === CONTROL_SLOT ? "You're now talking to the" : "You're now in";
  const head = `📍 ${here} <b>${escapeHtml(title)}</b>${running ? ' · 🟢 running' : ''}`;
  const memo = getMemo(chatId, slot)?.summary;
  const memoLine = memo ? `\n<i>${escapeHtml(memo)}</i>` : '';
  await api.sendMessage(
    chatId,
    `${head}${memoLine}\n<blockquote expandable>${transcript}</blockquote>`,
    { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } },
  );

  if (running) await views.get(sessionKey(chatId, slot))?.attach();
}
