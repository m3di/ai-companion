import { autoRetry } from '@grammyjs/auto-retry';

const SEND_TRIES = 3;
const SEND_RETRY_MS = 2000;
import { run, type RunnerHandle } from '@grammyjs/runner';
import { Bot, type Context, InlineKeyboard, InputFile, HttpError } from 'grammy';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { voiceDir } from '../transcribe.js';
import type {
  Buttons,
  ChatAdapter,
  CommandSpec,
  Inbound,
  MarkupFormat,
  MessageRef,
  OutgoingMessage,
  ReactEmoji,
} from './types.js';

/** The command menu advertised to Telegram clients. */
const COMMANDS: CommandSpec[] = [
  { command: 'sessions', description: 'Status board: your worker threads' },
  { command: 'capture', description: 'Toggle capture mode (queue notes for /process)' },
  { command: 'process', description: 'Triage & fan out everything you captured' },
  { command: 'cancel', description: 'Stop all running work in this chat' },
  { command: 'repos', description: 'List, add, or scan your workspace repos' },
  { command: 'dream', description: 'Run the nightly rewrite now' },
  { command: 'dreams', description: 'List nightly reports (/dreams <id> for one)' },

  { command: 'grows', description: 'List grow passes & what they changed (/grows <id>)' },
  { command: 'episodes', description: 'Work harvested from your local Claude Code sessions' },
  { command: 'find', description: 'Search past work — your sessions and the bot\'s threads' },
  { command: 'distill', description: 'Summarise harvested work episodes into recaps' },
  { command: 'focus', description: 'What deserves your attention now (ranked)' },
  { command: 'commitments', description: 'Reminders, routines & watched items' },
  { command: 'proposals', description: 'Operator-gated code/prompt proposals' },
  { command: 'stats', description: 'Usage & cost: workers, concierge, and the flywheel' },
  { command: 'status', description: 'Concierge + worker overview' },
  { command: 'voice', description: 'The bot\'s voice: samples, pick one, set the pace' },
];

function parseMode(format: MarkupFormat = 'tgHtml'): 'HTML' | 'MarkdownV2' | undefined {
  switch (format) {
    case 'tgHtml':
      return 'HTML';
    case 'tgMarkdownV2':
      return 'MarkdownV2';
    default:
      return undefined;
  }
}

/**
 * `undefined` means "no opinion"; an EMPTY array means "clear the keyboard".
 *
 * The distinction only matters on edit, and it mattered silently: Telegram
 * leaves the existing keyboard alone when `reply_markup` is omitted, so a live
 * status box that finished with no keyboard kept its 🛑 Stop button forever —
 * a button that, once the turn was over, could only ever answer "Nothing
 * running". Returning an empty inline keyboard is what actually removes it.
 */
function toKeyboard(buttons?: Buttons): InlineKeyboard | undefined {
  if (buttons?.length === 0) return new InlineKeyboard();
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  for (const row of buttons) {
    for (const b of row) {
      if (b.url) kb.url(b.text, b.url);
      else kb.text(b.text, b.data ?? 'noop');
    }
    kb.row();
  }
  return kb;
}

/** Build grammy send/edit options from a transport-agnostic message. */
function sendOptions(msg: OutgoingMessage): Record<string, unknown> {
  const mode = parseMode(msg.format);
  const keyboard = toKeyboard(msg.buttons);
  const reply_markup = msg.removeKeyboard ? { remove_keyboard: true } : keyboard;
  return {
    ...(mode ? { parse_mode: mode } : {}),
    ...(reply_markup ? { reply_markup } : {}),
  };
}

/**
 * Telegram implementation of ChatAdapter. Owns every grammy concern: the long-
 * poll runner, the stall-watchdog, command registration, the outbound API, the
 * access-control gate, and normalizing inbound updates into Inbound events. The
 * transport-agnostic dispatcher (dispatch.ts) consumes only those events.
 */
export class TelegramAdapter implements ChatAdapter {
  readonly name = 'telegram';
  private readonly bot: Bot;
  private runner?: RunnerHandle;
  private watchdog?: NodeJS.Timeout;
  private handler?: (e: Inbound) => void | Promise<void>;

  constructor() {
    // A request that hangs (a keep-alive socket dead after sleep or a network
    // change) fails in a minute, not grammy's default 500 s. The long poll
    // asks Telegram for 30 s, so 60 leaves it room.
    this.bot = new Bot(config.telegramToken, { client: { timeoutSeconds: 60 } });
    // BOUNDED — in BOTH of autoRetry's loops. maxRetryAttempts bounds only the
    // rate-limit / 5xx loop; a NETWORK error (HttpError: fetch threw, or the
    // request timed out) is retried in a separate loop that the attempt count
    // never touches — 3 s, 6, 12 … doubling to a one-hour cap, FOREVER, and the
    // caller awaits it. On 2026-08-27 the concierge's status message entered
    // that loop and held the session lock for two hours while every message
    // queued behind it with an eyes reaction; the fix that day bounded the
    // wrong loop. On 2026-11-08 six requests were found asleep in hour-long
    // waits while the concierge answered nothing all day. `rethrowHttpErrors`
    // closes the second loop: a network failure throws at once, `send` below
    // retries it a bounded three times, and a turn whose box cannot be sent
    // fails and releases its lock — the queue moves on (I8).
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30, rethrowHttpErrors: true }));
    this.bindHandlers();
  }

  onEvent(handler: (e: Inbound) => void | Promise<void>): void {
    this.handler = handler;
  }

  async send(chatId: number, msg: OutgoingMessage): Promise<MessageRef> {
    // Three tries, a few seconds apart, then the error reaches the caller: a
    // turn's box is the one Telegram call a turn awaits, so this is where a
    // network blip is forgiven and a network outage is reported (I8).
    for (let attempt = 1; ; attempt++) {
      try {
        const sent = await this.bot.api.sendMessage(chatId, msg.text, sendOptions(msg));
        return { chatId, messageId: sent.message_id };
      } catch (e) {
        if (!(e instanceof HttpError) || attempt >= SEND_TRIES) throw e;
        console.warn(`[telegram] sendMessage failed (${e.message}) — retry ${attempt}/${SEND_TRIES - 1} in ${SEND_RETRY_MS * attempt}ms`);
        await new Promise((r) => setTimeout(r, SEND_RETRY_MS * attempt));
      }
    }
  }

  async edit(ref: MessageRef, msg: OutgoingMessage): Promise<void> {
    await this.bot.api
      .editMessageText(ref.chatId, ref.messageId, msg.text, sendOptions(msg))
      .catch(() => {});
  }

  async delete(ref: MessageRef): Promise<void> {
    await this.bot.api.deleteMessage(ref.chatId, ref.messageId).catch(() => {});
  }

  async react(chatId: number, messageId: number, emoji: ReactEmoji): Promise<void> {
    await this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]).catch(() => {});
  }

  async typing(chatId: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  }

  async sendVoice(chatId: number, path: string, caption?: string): Promise<MessageRef> {
    await this.bot.api.sendChatAction(chatId, 'record_voice').catch(() => {});
    const sent = await this.bot.api.sendVoice(chatId, new InputFile(path), caption ? { caption } : undefined);
    return { chatId, messageId: sent.message_id };
  }

  /** Wire the access gate and translate grammy updates into Inbound events. */
  private bindHandlers(): void {
    // Access control: only allow-listed chats may drive the bot.
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!config.allowedChatIds.has(chatId)) {
        console.warn(`[auth] denied chat ${chatId} (add it to ALLOWED_CHAT_IDS to allow)`);
        if (ctx.callbackQuery) await ctx.answerCallbackQuery('Not authorized');
        else await ctx.reply(`Not authorized. Your chat ID is ${chatId}.`);
        return;
      }
      await next();
    });

    this.bot.on('message:text', (ctx) => this.emitMessage(ctx));
    this.bot.on('message:voice', (ctx) => void this.emitVoice(ctx));
    this.bot.on('callback_query:data', (ctx) => this.emitCallback(ctx));
    this.bot.catch((err) => console.error('[bot] error', err));
  }

  private emitMessage(ctx: Context): void {
    if (!this.handler || ctx.chat === undefined || ctx.message?.text === undefined) return;
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const messageId = ctx.message.message_id;
    const text = ctx.message.text;

    if (text.startsWith('/')) {
      const head = text.slice(1).split(/\s+/, 1)[0] ?? '';
      const command = head.split('@')[0] ?? head; // strip @botname in group chats
      const args = text.slice(1 + head.length).trim();
      void this.handler({ kind: 'command', chatId, userId, command, args, messageId });
      return;
    }

    void this.handler({
      kind: 'message',
      chatId,
      userId,
      text,
      messageId,
      replyToMessageId: ctx.message.reply_to_message?.message_id,
    });
  }

  /**
   * A voice note: fetch the audio (free on every Telegram account — only the
   * transcription is Premium, and we do not use theirs) and hand the file over.
   * The link Telegram issues is good for an hour; the file goes under data/.
   */
  private async emitVoice(ctx: Context): Promise<void> {
    const voice = ctx.message?.voice;
    if (!this.handler || ctx.chat === undefined || !voice) return;
    const chatId = ctx.chat.id;
    const messageId = ctx.message!.message_id;
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('Telegram returned no file_path');
      const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const ext = file.file_path.split('.').pop() || 'oga';
      const path = join(voiceDir(), `${chatId}-${messageId}.${ext}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      void this.handler({
        kind: 'message',
        chatId,
        userId: ctx.from?.id,
        text: '',
        messageId,
        replyToMessageId: ctx.message?.reply_to_message?.message_id,
        voice: { path, durationSec: voice.duration },
      });
    } catch (err) {
      console.error('[telegram] voice note not fetched', err);
      await this.send(chatId, { text: `Could not fetch that voice note: ${err instanceof Error ? err.message : String(err)}`, format: 'plain' }).catch(() => {});
    }
  }

  private emitCallback(ctx: Context): void {
    if (!this.handler || ctx.chat === undefined || ctx.callbackQuery?.data === undefined) return;
    void this.handler({
      kind: 'callback',
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      data: ctx.callbackQuery.data,
      messageId: ctx.callbackQuery.message?.message_id,
      answer: (t?: string) => ctx.answerCallbackQuery(t ? { text: t } : undefined).then(() => {}).catch(() => {}),
    });
  }

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    await this.bot.api.setMyCommands(COMMANDS).catch(() => {});

    console.log(`[companion] working dir: ${config.workingDir}`);
    console.log(`[companion] default permission mode: ${config.permissionMode}`);
    console.log(
      config.allowedChatIds.size
        ? `[companion] allowed chats: ${[...config.allowedChatIds].join(', ')}`
        : '[companion] no allowed chats yet — message the bot to learn your chat ID',
    );
    console.log(`[companion] @${me.username} polling (concurrent runner)`);

    this.startRunner();
    this.armWatchdog();
  }

  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.runner?.isRunning()) await this.runner.stop();
  }

  /**
   * Start the long-poll runner and handle a fatal source error gracefully. A
   * 409 Conflict (a second instance polling the same token) or any other
   * unrecoverable fetch error rejects the runner task; without this it surfaces
   * as an uncaught exception with a full stack dump. We log one clear line and
   * exit cleanly so a supervisor (or the developer) can restart a single
   * instance.
   */
  private startRunner(): void {
    this.runner = run(this.bot);
    this.runner.task()?.catch((err) => void this.onRunnerError(err));
  }

  private async onRunnerError(err: unknown): Promise<void> {
    const code =
      (err as { error_code?: number })?.error_code ??
      (err as { error?: { error_code?: number } })?.error?.error_code;
    if (code === 409) {
      console.error(
        '[companion] 409 Conflict: another instance is already polling this bot token. ' +
          'Stop the other one (e.g. `pkill -f src/index.ts`) and start a single instance. Exiting.',
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[companion] polling stopped with an unrecoverable error — exiting: ${msg}`);
    }
    await this.stop().catch(() => {});
    process.exit(1);
  }

  /**
   * Stall-watchdog: the long-poll can silently die (the process stays "polling"
   * but stops consuming updates, so messages pile up at Telegram). Every minute,
   * check the pending-update backlog; if it stays above zero across consecutive
   * checks, the poller has stalled — restart it. getWebhookInfo doesn't conflict
   * with getUpdates, so this is a safe, in-process self-heal.
   */
  private armWatchdog(): void {
    let stalls = 0;
    this.watchdog = setInterval(async () => {
      try {
        const info = await this.bot.api.getWebhookInfo();
        const pending = info.pending_update_count ?? 0;
        if (pending > 0) {
          stalls += 1;
          if (stalls >= 2) {
            console.warn(`[watchdog] poll stalled (${pending} pending) — restarting runner`);
            try {
              if (this.runner?.isRunning()) await this.runner.stop();
            } catch {
              /* ignore */
            }
            this.startRunner();
            stalls = 0;
          }
        } else {
          stalls = 0;
        }
      } catch {
        /* getWebhookInfo failed (transient network) — ignore */
      }
    }, 60_000);
  }
}
