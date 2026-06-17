import { autoRetry } from '@grammyjs/auto-retry';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { type Api, type Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import type {
  Buttons,
  ChatAdapter,
  CommandSpec,
  MarkupFormat,
  MessageRef,
  OutgoingMessage,
  ReactEmoji,
} from './types.js';

/** The command menu advertised to Telegram clients. */
const COMMANDS: CommandSpec[] = [
  { command: 'sessions', description: 'List your threads, tap to switch' },
  { command: 'new', description: 'Start another thread' },
  { command: 'capture', description: 'Toggle capture mode (queue notes for /process)' },
  { command: 'process', description: 'Triage & fan out everything you captured' },
  { command: 'bot', description: 'Manage threads & memory (the concierge)' },
  { command: 'pin', description: 'Keep messages in the current thread (toggle)' },
  { command: 'auto', description: 'Turn auto-routing on/off' },
  { command: 'close', description: 'Close the current thread' },
  { command: 'history', description: 'Reopen a closed thread' },
  { command: 'cancel', description: 'Stop the current thread’s turn' },
  { command: 'cwd', description: 'Show or set the working directory' },
  { command: 'repos', description: 'List, add, or scan your workspace repos' },
  { command: 'status', description: 'Current session info' },
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
 * poll runner, the stall-watchdog, command registration, and the outbound API.
 * The handler wiring still lives in `createBot()` (telegram.ts) and is passed in
 * here; later seam slices move those handlers behind normalized inbound events.
 */
export class TelegramAdapter implements ChatAdapter {
  readonly name = 'telegram';
  private runner?: RunnerHandle;
  private watchdog?: NodeJS.Timeout;

  constructor(private readonly bot: Bot) {
    this.bot.api.config.use(autoRetry());
  }

  /** Transitional: raw grammy Api, for code not yet ported onto the transport. */
  get api(): Api {
    return this.bot.api;
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

    this.runner = run(this.bot);
    this.armWatchdog();
  }

  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.runner?.isRunning()) await this.runner.stop();
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
            this.runner = run(this.bot);
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
