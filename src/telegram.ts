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
import { chunkRaw, describeTool, toTelegramMarkdown } from './format.js';
import { LiveStatus } from './liveStatus.js';
import { createCanUseTool, resetAutoAllow, resolvePermission } from './permissions.js';

/** Chosen permission mode for the current session, per chat. Cleared on /new. */
const sessionMode = new Map<number, PermissionMode>();
/** A message held while we wait for the user to pick a mode, per chat. */
const pendingPrompt = new Map<number, string>();

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

async function askForMode(ctx: Context): Promise<void> {
  await ctx.reply(
    '🆕 <b>New session.</b> How should I handle permissions?\n\n' +
      '⚡ <b>Auto</b> — I work autonomously; a safety classifier blocks risky actions.\n' +
      '✏️ <b>Accept edits</b> — file edits run automatically; commands ask you.\n' +
      '🔐 <b>Ask each</b> — I ask before every command and edit.',
    { parse_mode: 'HTML', reply_markup: modeKeyboard() },
  );
}

/** Send Claude's Markdown answer, converted to MarkdownV2, split to fit. */
async function sendAnswer(ctx: Context, text: string): Promise<void> {
  for (const piece of chunkRaw(text)) {
    try {
      await ctx.reply(toTelegramMarkdown(piece), { parse_mode: 'MarkdownV2' });
    } catch {
      await ctx.reply(piece);
    }
  }
}

function statusText(chatId: number): string {
  const sessionId = getSessionId(chatId);
  const mode = sessionMode.get(chatId);
  return (
    `Session: ${sessionId ?? 'none (starts on next message)'}\n` +
    `Permission mode: ${mode ? MODE_LABEL[mode] ?? mode : 'not chosen yet'}\n` +
    `Messages logged: ${messageCount(chatId)}\n` +
    `Working dir: ${config.workingDir}`
  );
}

function startFresh(chatId: number): void {
  clearSession(chatId);
  resetAutoAllow(chatId);
  sessionMode.delete(chatId);
  pendingPrompt.delete(chatId);
}

/** Run one user turn against Claude Code, rendering progress + answers. */
async function runTurn(ctx: Context, chatId: number, text: string): Promise<void> {
  const status = new LiveStatus(ctx, chatId);
  await status.start();
  const canUseTool = createCanUseTool(ctx, chatId);
  const permissionMode = sessionMode.get(chatId) ?? config.permissionMode;

  let ok = true;
  try {
    const resume = getSessionId(chatId);
    for await (const ev of askClaude({ prompt: text, resume, canUseTool, permissionMode })) {
      switch (ev.kind) {
        case 'session':
          setSessionId(chatId, ev.sessionId);
          break;
        case 'tool': {
          const view = describeTool(ev.name, ev.input);
          if (!view.mute) status.push(view.summary, view.subagent ? '🤖' : '⚙️');
          break;
        }
        case 'text':
          logMessage(chatId, 'assistant', ev.text);
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
    console.error('[claude] error', err);
    await ctx.reply(`⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await status.finalize(ok, actionKeyboard());
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
      'Connected. This chat is a single Claude Code session.\n' +
        '/new — start a fresh session (clears context + re-asks permission mode)\n' +
        '/status — session info',
    ),
  );

  bot.command('new', async (ctx) => {
    startFresh(ctx.chat.id);
    await ctx.reply('🔄 Fresh session.');
    await askForMode(ctx);
  });

  bot.command('status', (ctx) => ctx.reply(statusText(ctx.chat.id)));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Permission mode chosen for a fresh session.
    if (data.startsWith('mode:')) {
      const mode = data.slice('mode:'.length) as PermissionMode;
      sessionMode.set(chatId, mode);
      await ctx.answerCallbackQuery(`Mode: ${MODE_LABEL[mode] ?? mode}`);
      await ctx.editMessageText(`Permission mode: <b>${MODE_LABEL[mode] ?? mode}</b>`, {
        parse_mode: 'HTML',
      }).catch(() => {});
      const held = pendingPrompt.get(chatId);
      if (held !== undefined) {
        pendingPrompt.delete(chatId);
        await runTurn(ctx, chatId, held);
      }
      return;
    }

    // Tool approval buttons.
    if (resolvePermission(data)) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Completion action buttons.
    switch (data) {
      case 'new':
        startFresh(chatId);
        await ctx.answerCallbackQuery('Fresh session');
        await askForMode(ctx);
        return;
      case 'status':
        await ctx.answerCallbackQuery();
        await ctx.reply(statusText(chatId));
        return;
      default:
        await ctx.answerCallbackQuery('Expired');
    }
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    logMessage(chatId, 'user', text);

    // First message of a fresh session: pick a permission mode, then run.
    if (!sessionMode.has(chatId)) {
      pendingPrompt.set(chatId, text);
      await askForMode(ctx);
      return;
    }

    await runTurn(ctx, chatId, text);
  });

  bot.catch((err) => console.error('[bot] error', err));

  return bot;
}
