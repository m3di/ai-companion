import { autoRetry } from '@grammyjs/auto-retry';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
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
  { command: 'dream', description: 'Offline self-reflection over recent activity' },
  { command: 'status', description: 'Concierge + worker overview' },
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

function toKeyboard(buttons?: Buttons): InlineKeyboard | undefined {
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
    this.bot = new Bot(config.telegramToken);
    this.bot.api.config.use(autoRetry());
    this.bindHandlers();
  }

  onEvent(handler: (e: Inbound) => void | Promise<void>): void {
    this.handler = handler;
  }

  async send(chatId: number, msg: OutgoingMessage): Promise<MessageRef> {
    const sent = await this.bot.api.sendMessage(chatId, msg.text, sendOptions(msg));
    return { chatId, messageId: sent.message_id };
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
