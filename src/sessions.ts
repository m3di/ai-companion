import type { Buttons, ChatTransport } from './transport/types.js';
import {
  countSessions,
  getActiveSlot,
  getMemo,
  getSession,
  listSessions,
  recentMessages,
  recordOutbound,
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

async function sendAnswer(
  transport: ChatTransport,
  chatId: number,
  text: string,
  sessionKey?: string,
): Promise<void> {
  for (const piece of chunkRaw(text)) {
    let ref;
    try {
      ref = await transport.send(chatId, { text: toTelegramMarkdown(piece), format: 'tgMarkdownV2' });
    } catch {
      ref = await transport.send(chatId, { text: piece, format: 'plain' });
    }
    // Tag this message so a reply to it routes back to this session.
    if (sessionKey) recordOutbound(chatId, ref.messageId, sessionKey);
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
    readonly transport: ChatTransport,
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

  /** Open (or reopen) the live status message + typing for the attached view. */
  private async openLive(): Promise<void> {
    if (this.status) return;
    this.startTyping();
    this.status = new LiveStatus(this.transport, this.chatId);
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
    if (this.isAttached())
      await this.transport.send(this.chatId, { text: html, format: 'tgHtml' }).catch(() => {});
  }

  async answer(text: string): Promise<void> {
    if (this.isAttached() || this.forceVisible) await sendAnswer(this.transport, this.chatId, text, this.key);
  }

  /** Mark the session blocked on a user interaction (permission / ask). */
  async block(badge: 'needsPerm' | 'asked', notice: string): Promise<void> {
    this.blocked = true;
    setBadge(this.key, badge);
    if (!this.isAttached()) await notifyBackground(this.transport, this.chatId, notice);
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

function stopKeyboard(): Buttons {
  return [[{ text: '🛑 Stop', data: 'stop' }]];
}

/** Send a one-line background notice (and clear any stale bottom keyboard). */
export async function notifyBackground(
  transport: ChatTransport,
  chatId: number,
  html: string,
): Promise<void> {
  await transport
    .send(chatId, { text: html, format: 'tgHtml', removeKeyboard: true })
    .catch(() => {});
}

/**
 * Attach a chat to a session: mark it active, replay the last few messages, and
 * if a turn is mid-flight, hand the live view over so it streams from here on.
 */
export async function attachSession(transport: ChatTransport, chatId: number, slot: number): Promise<void> {
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
  await transport.send(chatId, {
    text: `${head}${memoLine}\n<blockquote expandable>${transcript}</blockquote>`,
    format: 'tgHtml',
    removeKeyboard: true,
  });

  if (running) await views.get(sessionKey(chatId, slot))?.attach();
}
