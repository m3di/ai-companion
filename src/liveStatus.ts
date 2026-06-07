import type { Context, InlineKeyboard } from 'grammy';
import { escapeHtml } from './format.js';

const EDIT_INTERVAL_MS = 1100;
const MAX_LOG_LINES = 12;

/**
 * Owns a single Telegram message that is edited in place to reflect the latest
 * state of a turn: a header (current/last action + count) plus an expandable
 * blockquote holding the recent activity log. Edits are throttled so we never
 * trip Telegram's rate limits, and a trailing edit always flushes the final
 * state.
 */
export class LiveStatus {
  private messageId?: number;
  private readonly log: string[] = [];
  private header = '🧠 <b>Thinking…</b>';
  private done = false;

  private lastEditAt = 0;
  private timer?: NodeJS.Timeout;
  private rendering = false;
  private dirty = false;
  private keyboard?: InlineKeyboard;

  constructor(
    private readonly ctx: Context,
    private readonly chatId: number,
  ) {}

  async start(keyboard?: InlineKeyboard): Promise<void> {
    this.keyboard = keyboard;
    const msg = await this.ctx.reply(this.header, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    this.messageId = msg.message_id;
  }

  /** Add an activity line and refresh the header to point at it. */
  push(summary: string, emoji = '⚙️'): void {
    this.log.push(summary);
    if (this.log.length > MAX_LOG_LINES) this.log.shift();
    this.header = `${emoji} <b>${escapeHtml(summary)}</b>`;
    this.schedule();
  }

  /** Whether any activity was recorded this turn. */
  get hasActivity(): boolean {
    return this.log.length > 0;
  }

  private body(): string {
    const count = this.log.length;
    const countLine = count ? `\n<i>${count} action${count === 1 ? '' : 's'}</i>` : '';
    const quote = count
      ? `\n<blockquote expandable>${this.log.map((l) => escapeHtml(l)).join('\n')}</blockquote>`
      : '';
    return `${this.header}${countLine}${quote}`;
  }

  private schedule(): void {
    if (this.done || this.messageId === undefined) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEditAt));
    if (wait === 0) {
      void this.render();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.render();
      }, wait);
    } else {
      this.dirty = true;
    }
  }

  private async render(): Promise<void> {
    if (this.messageId === undefined || this.rendering) {
      this.dirty = true;
      return;
    }
    this.rendering = true;
    this.lastEditAt = Date.now();
    try {
      await this.ctx.api.editMessageText(this.chatId, this.messageId, this.body(), {
        parse_mode: 'HTML',
        reply_markup: this.keyboard,
      });
    } catch {
      // "message is not modified", rate limits, etc. — safe to ignore.
    } finally {
      this.rendering = false;
      if (this.dirty && !this.done) {
        this.dirty = false;
        this.schedule();
      }
    }
  }

  /** Flush a final state. Deletes the message if nothing happened. */
  async finalize(ok: boolean, keyboard?: InlineKeyboard): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.messageId === undefined) return;

    if (!this.hasActivity) {
      await this.ctx.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
      return;
    }

    const count = this.log.length;
    this.header = ok ? `✅ <b>Done</b>` : `⚠️ <b>Stopped</b>`;
    const text =
      `${this.header}\n<i>${count} action${count === 1 ? '' : 's'}</i>` +
      `\n<blockquote expandable>${this.log.map((l) => escapeHtml(l)).join('\n')}</blockquote>`;
    await this.ctx.api
      .editMessageText(this.chatId, this.messageId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch(() => {});
  }

  /** Stop updating and leave the message in a fixed state (used on detach). */
  async freeze(html: string): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.messageId === undefined) return;
    await this.ctx.api
      .editMessageText(this.chatId, this.messageId, html, { parse_mode: 'HTML' })
      .catch(() => {});
  }
}
