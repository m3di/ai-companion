import { escapeHtml } from './format.js';
import type { Buttons, ChatTransport, MessageRef } from './transport/types.js';

const EDIT_INTERVAL_MS = 1100;
const MAX_LOG_LINES = 12;
// Telegram caps a message at 4096; leave room for the header, count and log.
const MAX_ANSWER_CHARS = 2600;

/**
 * Owns a single chat message that is edited in place to reflect the latest state
 * of a turn: a header (current/last action + count) plus an expandable
 * blockquote holding the recent activity log. Edits are throttled so we never
 * trip the transport's rate limits, and a trailing edit always flushes the final
 * state.
 */
export class LiveStatus {
  private ref?: MessageRef;
  private readonly log: string[] = [];
  private header = '🧠 <b>Thinking…</b>';
  private answer = '';
  private done = false;

  private lastEditAt = 0;
  private timer?: NodeJS.Timeout;
  private rendering = false;
  private dirty = false;
  private keyboard?: Buttons;
  /** What finalize() last drew — so a brief can re-close the same box. */
  private finalKeyboard?: Buttons;

  constructor(
    private readonly transport: ChatTransport,
    private readonly chatId: number,
    // A worker title marker; omitted for the concierge (the default voice).
    private readonly label?: string,
  ) {}

  private get labelTag(): string {
    return this.label ? `🔧 <b>${escapeHtml(this.label)}</b> · ` : '';
  }

  async start(keyboard?: Buttons): Promise<void> {
    this.keyboard = keyboard;
    this.ref = await this.transport.send(this.chatId, {
      text: `${this.labelTag}${this.header}`,
      format: 'tgHtml',
      buttons: keyboard,
    });
  }

  /** Add an activity line and refresh the header to point at it. */
  push(summary: string, emoji = '⚙️'): void {
    this.log.push(summary);
    if (this.log.length > MAX_LOG_LINES) this.log.shift();
    this.header = `${emoji} <b>${escapeHtml(summary)}</b>`;
    this.schedule();
  }

  /**
   * Set the latest prose this turn has produced, shown above the activity log
   * and kept current as the turn goes on.
   *
   * This is what lets a worker occupy ONE message. It used to send each answer
   * as its own chat message, so a long task buried the thread and the user had
   * to scroll to find where it got to. Only the newest text is kept: a worker's
   * intermediate narration is progress, not a record — the record is the
   * transcript, and the concierge is what reports a completion.
   */
  say(text: string): void {
    this.answer = text.trim();
    this.schedule();
  }

  /** Whether anything at all was recorded this turn. */
  get hasActivity(): boolean {
    return this.log.length > 0 || this.answer.length > 0;
  }

  /** The answer block, trimmed to fit alongside the log in one message. */
  private answerBlock(): string {
    if (!this.answer) return '';
    const flat = this.answer.length > MAX_ANSWER_CHARS
      ? `${this.answer.slice(0, MAX_ANSWER_CHARS)}…`
      : this.answer;
    return `\n\n${escapeHtml(flat)}`;
  }

  private body(): string {
    const count = this.log.length;
    const countLine = count ? `\n<i>${count} action${count === 1 ? '' : 's'}</i>` : '';
    const quote = count
      ? `\n<blockquote expandable>${this.log.map((l) => escapeHtml(l)).join('\n')}</blockquote>`
      : '';
    return `${this.labelTag}${this.header}${countLine}${this.answerBlock()}${quote}`;
  }

  private schedule(): void {
    if (this.done || this.ref === undefined) return;
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
    if (this.ref === undefined || this.rendering) {
      this.dirty = true;
      return;
    }
    this.rendering = true;
    this.lastEditAt = Date.now();
    try {
      // edit() is best-effort: "message is not modified", rate limits, etc. are
      // swallowed by the transport.
      await this.transport.edit(this.ref, {
        text: this.body(),
        format: 'tgHtml',
        buttons: this.keyboard,
      });
    } finally {
      this.rendering = false;
      if (this.dirty && !this.done) {
        this.dirty = false;
        this.schedule();
      }
    }
  }

  /**
   * Flush a final state. Deletes the message if nothing happened.
   *
   * `headline` overrides the default Done/Stopped header — it is how a
   * cancellation, a timeout or an error names itself IN THE BOX. Those used to
   * be separate chat messages, which defeated the point of a turn owning one
   * message: the thing that went wrong ended up detached from the thing it went
   * wrong in.
   */
  async finalize(ok: boolean, keyboard?: Buttons, headline?: string): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.ref === undefined) return;

    if (!this.hasActivity && !headline) {
      await this.transport.delete(this.ref);
      return;
    }

    this.header = headline ?? (ok ? `✅ <b>Done</b>` : `⚠️ <b>Stopped</b>`);
    this.finalKeyboard = keyboard;
    await this.transport.edit(this.ref, { text: this.body(), format: 'tgHtml', buttons: keyboard });
  }

  /**
   * Re-close the box with the run's BRIEF as its answer. The worker's last
   * words were progress; the brief is the record the person actually wants to
   * find under a finished box — and it fits, where the raw tail was cut mid-
   * sentence at the message cap.
   */
  async showBrief(brief: string): Promise<void> {
    if (this.ref === undefined || !this.done) return;
    this.answer = brief.trim();
    await this.transport.edit(this.ref, { text: this.body(), format: 'tgHtml', buttons: this.finalKeyboard });
  }

  /** Stop updating and leave the message in a fixed state (used on detach). */
  async freeze(html: string): Promise<void> {
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.ref === undefined) return;
    await this.transport.edit(this.ref, { text: html, format: 'tgHtml' });
  }
}
