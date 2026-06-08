import type { Api, Context } from 'grammy';
import { InlineKeyboard, Keyboard } from 'grammy';
import {
  countSessions,
  createSession,
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

const NEW_LABEL = '➕ New session';
const HISTORY_LABEL = '🗂 Closed sessions';

const CATCHUP_LINES = 6;

// Transient per-session badge state, keyed by "<chatId>:<slot>". Rebuilt on
// restart from whatever the next turn does — never load-bearing.
const badges = new Map<string, Badge>();
// Live turn views, so a switch can attach/detach a turn that is mid-flight.
const views = new Map<string, RunningView>();
// The labels last rendered onto each chat's reply keyboard, mapped back to the
// action they trigger. Matched against incoming text to detect a button tap.
const lastLabels = new Map<number, Map<string, number | 'new' | 'history'>>();

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

/** Ensure a chat has at least one session; preserve the legacy ":0" session. */
export function ensureChat(chatId: number): void {
  if (countSessions(chatId, 'active') > 0) return;
  const existing = getSession(chatId, 0);
  if (!existing) createSession(chatId, 'Session 1');
  else if (existing.status === 'closed') setSessionStatus(chatId, 0, 'active');
  if (getActiveSlot(chatId) === undefined) setActiveSlot(chatId, 0);
}

export function activeSlot(chatId: number): number {
  ensureChat(chatId);
  return getActiveSlot(chatId) ?? 0;
}

export function titleOf(chatId: number, slot: number): string {
  return getSession(chatId, slot)?.title ?? `Session ${slot + 1}`;
}

/** Build the bottom reply keyboard for a chat and record its label→action map. */
export function buildKeyboard(chatId: number): Keyboard {
  ensureChat(chatId);
  const active = activeSlot(chatId);
  const sessions = listSessions(chatId, 'active');
  const labels = new Map<string, number | 'new' | 'history'>();
  const kb = new Keyboard();

  sessions.forEach((s, i) => {
    const key = sessionKey(chatId, s.slot);
    const marker = s.slot === active ? '▶ ' : '';
    const label = `${marker}${badgeIcon(badgeOf(key))} ${s.title}`;
    labels.set(label, s.slot);
    kb.text(label);
    if (i % 2 === 1) kb.row();
  });

  kb.row().text(NEW_LABEL);
  labels.set(NEW_LABEL, 'new');
  if (countSessions(chatId, 'closed') > 0) {
    kb.text(HISTORY_LABEL);
    labels.set(HISTORY_LABEL, 'history');
  }

  lastLabels.set(chatId, labels);
  return kb.resized().persistent();
}

/** Resolve an incoming text against the last keyboard shown. */
export function matchButton(chatId: number, text: string): number | 'new' | 'history' | undefined {
  return lastLabels.get(chatId)?.get(text);
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
    if (this.isAttached()) await sendAnswer(this.api, this.chatId, text);
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
    if (this.isAttached()) {
      if (this.status) await this.status.finalize(ok);
    } else {
      const icon = ok ? '✅' : '⚠️';
      await notifyBackground(
        this.api,
        this.chatId,
        `${icon} <b>${escapeHtml(this.title)}</b> ${ok ? 'finished' : 'stopped'} — tap to view.`,
      );
    }
  }
}

function stopKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🛑 Stop', 'stop');
}

/** Send a one-line notice that also refreshes the chat's bottom keyboard. */
export async function notifyBackground(api: Api, chatId: number, html: string): Promise<void> {
  await api
    .sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: buildKeyboard(chatId) })
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
  const head = `📎 <b>${escapeHtml(title)}</b>${running ? ' · 🟢 running' : ''}`;
  const memo = getMemo(chatId, slot)?.summary;
  const memoLine = memo ? `\n<i>${escapeHtml(memo)}</i>` : '';
  await api.sendMessage(
    chatId,
    `${head}${memoLine}\n<blockquote expandable>${transcript}</blockquote>`,
    { parse_mode: 'HTML', reply_markup: buildKeyboard(chatId) },
  );

  if (running) await views.get(sessionKey(chatId, slot))?.attach();
}
