import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { config, type PermissionMode } from './config.js';
import { askClaude } from './claude.js';
import {
  clearSession,
  getSessionId,
  logMessage,
  messageCount,
  setSessionId,
} from './db.js';
import { chunkRaw, describeTool, escapeHtml, toTelegramMarkdown } from './format.js';
import { LiveStatus } from './liveStatus.js';
import { createCanUseTool, resetAutoAllow, resolvePermission } from './permissions.js';
import { buildUiServer, resolveAsk, takeQuickReply } from './ui.js';

/**
 * A session target: one Telegram chat, or one forum topic within it. Each maps
 * to an independent Claude Code session keyed by `<chatId>:<threadId>`.
 */
interface Target {
  chatId: number;
  threadId?: number;
  key: string;
}

function targetOf(ctx: Context): Target {
  const chatId = ctx.chat!.id;
  const msg = ctx.msg;
  const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
  return { chatId, threadId, key: `${chatId}:${threadId ?? 0}` };
}

// Per-session state (in memory, cleared on /new). Keyed by Target.key.
const sessionMode = new Map<string, PermissionMode>();
const sessionCwd = new Map<string, string>();
const pendingPrompt = new Map<string, string>();

// Per-session turn serialization: one running turn per session, the rest queue.
// Button taps are handled outside this lock so approvals never deadlock.
const busy = new Set<string>();
const queues = new Map<string, Array<{ ctx: Context; text: string; userMsgId?: number }>>();
// AbortController for the turn currently running in each session, for /cancel.
const running = new Map<string, AbortController>();

/** Abort the running turn for a session and drop anything queued behind it. */
function cancelSession(key: string): boolean {
  queues.delete(key);
  const controller = running.get(key);
  if (!controller) return false;
  controller.abort();
  return true;
}

const MODE_LABEL: Record<string, string> = {
  auto: '⚡ Auto',
  acceptEdits: '✏️ Accept edits',
  default: '🔐 Ask each',
};

function modeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚡ Auto', 'mode:auto')
    .text('✏️ Accept edits', 'mode:acceptEdits')
    .row()
    .text('🔐 Ask each', 'mode:default');
}

function actionKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🆕 New session · clears memory', 'new');
}

function stopKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🛑 Stop', 'stop');
}

function expandPath(p: string): string {
  return resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
}

/**
 * Set a reaction on the user's message as an atomic state indicator:
 * ✍️ working · 👀 queued · 👍 done · 🤔 cancelled · 😱 errored.
 * Best-effort — reactions need permission and are never load-bearing.
 */
type ReactEmoji = '✍' | '👀' | '👍' | '🤔' | '😱';

async function react(
  ctx: Context,
  chatId: number,
  msgId: number | undefined,
  emoji: ReactEmoji,
): Promise<void> {
  if (msgId === undefined) return;
  try {
    await ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji }]);
  } catch {
    /* ignore */
  }
}

async function askForMode(ctx: Context): Promise<void> {
  await ctx.reply(
    '🆕 <b>New session.</b> How should I handle permissions?\n\n' +
      '⚡ <b>Auto</b> — I work autonomously; a safety classifier blocks risky actions.\n' +
      '✏️ <b>Accept edits</b> — file edits run automatically; commands ask you.\n' +
      '🔐 <b>Ask each</b> — I ask before every command and edit.',
    { parse_mode: 'HTML', reply_markup: modeKeyboard() },
  );
}

async function sendAnswer(ctx: Context, text: string): Promise<void> {
  for (const piece of chunkRaw(text)) {
    try {
      await ctx.reply(toTelegramMarkdown(piece), { parse_mode: 'MarkdownV2' });
    } catch {
      await ctx.reply(piece);
    }
  }
}

function statusText(target: Target): string {
  const sessionId = getSessionId(target.key);
  const mode = sessionMode.get(target.key);
  return (
    `Session key: ${target.key}\n` +
    `Claude session: ${sessionId ?? 'none (starts on next message)'}\n` +
    `Permission mode: ${mode ? MODE_LABEL[mode] ?? mode : 'not chosen yet'}\n` +
    `Working dir: ${sessionCwd.get(target.key) ?? config.workingDir}\n` +
    `Messages logged: ${messageCount(target.key)}`
  );
}

function startFresh(key: string): void {
  clearSession(key);
  resetAutoAllow(key);
  sessionMode.delete(key);
  pendingPrompt.delete(key);
  // sessionCwd is intentionally kept — a topic's workspace survives /new.
}

/** Run one user turn against Claude Code, rendering progress + answers. */
async function runTurn(
  ctx: Context,
  target: Target,
  text: string,
  userMsgId?: number,
): Promise<void> {
  await react(ctx, target.chatId, userMsgId, '✍');
  await ctx.replyWithChatAction('typing').catch(() => {});
  const typing = setInterval(() => {
    void ctx.replyWithChatAction('typing').catch(() => {});
  }, 5000);

  const status = new LiveStatus(ctx, target.chatId);
  await status.start(stopKeyboard());
  const canUseTool = createCanUseTool(ctx, target.chatId, target.key);
  const permissionMode = sessionMode.get(target.key) ?? config.permissionMode;
  const cwd = sessionCwd.get(target.key) ?? config.workingDir;
  const mcpServers = { telegram: buildUiServer(ctx, target.chatId, target.threadId) };
  const abortController = new AbortController();
  running.set(target.key, abortController);

  let ok = true;
  try {
    const resume = getSessionId(target.key);
    for await (const ev of askClaude({
      prompt: text,
      resume,
      canUseTool,
      permissionMode,
      cwd,
      mcpServers,
      abortController,
    })) {
      switch (ev.kind) {
        case 'session':
          setSessionId(target.key, ev.sessionId);
          break;
        case 'tool': {
          const view = describeTool(ev.name, ev.input);
          if (!view.mute) status.push(view.summary, view.subagent ? '🤖' : '⚙️');
          break;
        }
        case 'text':
          logMessage(target.key, 'assistant', ev.text);
          await sendAnswer(ctx, ev.text);
          break;
        case 'result':
          ok = ev.ok;
          if (!ev.ok) await ctx.reply(`⚠️ Run ended: ${ev.error ?? 'unknown error'}`);
          break;
      }
    }
  } catch (err) {
    ok = false;
    if (abortController.signal.aborted) {
      await ctx.reply('🛑 Cancelled.');
    } else {
      console.error('[claude] error', err);
      await ctx.reply(`⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    clearInterval(typing);
    running.delete(target.key);
    await status.finalize(ok, actionKeyboard());
    await react(ctx, target.chatId, userMsgId, abortController.signal.aborted ? '🤔' : ok ? '👍' : '😱');
  }
}

/** Serialize turns per session: run now if idle, else queue. */
async function enqueueTurn(
  ctx: Context,
  target: Target,
  text: string,
  userMsgId?: number,
): Promise<void> {
  if (busy.has(target.key)) {
    const q = queues.get(target.key) ?? [];
    q.push({ ctx, text, userMsgId });
    queues.set(target.key, q);
    await react(ctx, target.chatId, userMsgId, '👀');
    await ctx.reply('⏳ Queued — running after the current task.');
    return;
  }
  busy.add(target.key);
  try {
    await runTurn(ctx, target, text, userMsgId);
    for (;;) {
      const next = queues.get(target.key)?.shift();
      if (!next) break;
      await runTurn(next.ctx, target, next.text, next.userMsgId);
    }
  } finally {
    busy.delete(target.key);
    queues.delete(target.key);
  }
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  // Access control: only allow-listed chats may drive Claude Code.
  bot.use(async (ctx, next) => {
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

  bot.command('start', (ctx) =>
    ctx.reply(
      'Connected. This chat (or each forum topic) is one Claude Code session.\n' +
        '/new — fresh session (clears context + re-asks permission mode)\n' +
        '/cancel — stop the turn running in this session\n' +
        '/cwd [path] — show or set this session’s working directory\n' +
        '/status — session info',
    ),
  );

  bot.command('cancel', (ctx) => {
    const target = targetOf(ctx);
    return ctx.reply(cancelSession(target.key) ? '🛑 Cancelling…' : 'Nothing is running.');
  });

  bot.command('new', async (ctx) => {
    const target = targetOf(ctx);
    startFresh(target.key);
    await ctx.reply('🔄 Fresh session.');
    await askForMode(ctx);
  });

  bot.command('cwd', (ctx) => {
    const target = targetOf(ctx);
    const arg = ctx.match.trim();
    if (!arg) {
      return ctx.reply(
        `Working dir: ${sessionCwd.get(target.key) ?? config.workingDir}\nSet with /cwd <path>`,
      );
    }
    const dir = expandPath(arg);
    sessionCwd.set(target.key, dir);
    return ctx.reply(`📁 Working dir for this session: ${dir}`);
  });

  bot.command('status', (ctx) => ctx.reply(statusText(targetOf(ctx))));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (ctx.chat === undefined) return;
    const target = targetOf(ctx);

    // Permission mode chosen for a fresh session.
    if (data.startsWith('mode:')) {
      const mode = data.slice('mode:'.length) as PermissionMode;
      sessionMode.set(target.key, mode);
      await ctx.answerCallbackQuery(`Mode: ${MODE_LABEL[mode] ?? mode}`);
      await ctx
        .editMessageText(`Permission mode: <b>${MODE_LABEL[mode] ?? mode}</b>`, { parse_mode: 'HTML' })
        .catch(() => {});
      const held = pendingPrompt.get(target.key);
      if (held !== undefined) {
        pendingPrompt.delete(target.key);
        await enqueueTurn(ctx, target, held);
      }
      return;
    }

    // tg_ask: user picked an option.
    if (data.startsWith('ask:')) {
      const [, id, idxStr] = data.split(':');
      const result = id ? resolveAsk(id, Number(idxStr)) : null;
      await ctx.answerCallbackQuery(result?.chosen ?? 'Expired');
      if (result?.messageId !== undefined) {
        await ctx.api
          .editMessageText(
            target.chatId,
            result.messageId,
            `❓ <b>${escapeHtml(result.question)}</b>\n✅ ${escapeHtml(result.chosen)}`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }
      return;
    }

    // Quick-reply button: feed its text back as a new user turn.
    if (data.startsWith('qr:')) {
      const replyText = takeQuickReply(data.slice('qr:'.length));
      await ctx.answerCallbackQuery();
      if (replyText !== undefined) {
        logMessage(target.key, 'user', replyText);
        await enqueueTurn(ctx, target, replyText);
      }
      return;
    }

    if (data === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    // Stop button on the live status message.
    if (data === 'stop') {
      const cancelled = cancelSession(target.key);
      await ctx.answerCallbackQuery(cancelled ? '🛑 Cancelling…' : 'Nothing running');
      return;
    }

    // Tool approval buttons.
    if (resolvePermission(data)) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Completion action button.
    if (data === 'new') {
      startFresh(target.key);
      await ctx.answerCallbackQuery('Fresh session');
      await askForMode(ctx);
      return;
    }

    await ctx.answerCallbackQuery('Expired');
  });

  bot.on('message:text', async (ctx) => {
    const target = targetOf(ctx);
    const text = ctx.message.text;
    logMessage(target.key, 'user', text);

    // First message of a fresh session: pick a permission mode, then run.
    if (!sessionMode.has(target.key)) {
      pendingPrompt.set(target.key, text);
      await askForMode(ctx);
      return;
    }

    await enqueueTurn(ctx, target, text, ctx.message.message_id);
  });

  bot.catch((err) => console.error('[bot] error', err));

  return bot;
}
