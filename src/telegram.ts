import { Bot } from 'grammy';
import { config } from './config.js';
import { askClaude } from './claude.js';
import {
  clearSession,
  getSessionId,
  logMessage,
  messageCount,
  setSessionId,
} from './db.js';

const TELEGRAM_LIMIT = 4096;

function chunk(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_LIMIT) {
    // Prefer a newline break near the limit, fall back to a hard cut.
    let cut = rest.lastIndexOf('\n', TELEGRAM_LIMIT);
    if (cut < TELEGRAM_LIMIT * 0.5) cut = TELEGRAM_LIMIT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  // Access control: only allow-listed chats may drive Claude Code.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!config.allowedChatIds.has(chatId)) {
      console.warn(`[auth] denied chat ${chatId} (add it to ALLOWED_CHAT_IDS to allow)`);
      await ctx.reply(`Not authorized. Your chat ID is ${chatId}.`);
      return;
    }
    await next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      'Connected. This chat is a single Claude Code session.\n' +
        '/new — start a fresh session (clears context)\n' +
        '/status — session info',
    ),
  );

  bot.command('new', (ctx) => {
    clearSession(ctx.chat.id);
    return ctx.reply('Started a fresh session. Previous context cleared.');
  });

  bot.command('status', (ctx) => {
    const sessionId = getSessionId(ctx.chat.id);
    return ctx.reply(
      `Session: ${sessionId ? sessionId : 'none (will start on next message)'}\n` +
        `Messages logged: ${messageCount(ctx.chat.id)}\n` +
        `Working dir: ${config.workingDir}\n` +
        `Permission mode: ${config.permissionMode}`,
    );
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    logMessage(chatId, 'user', text);

    const send = async (body: string) => {
      for (const part of chunk(body)) await ctx.reply(part);
    };

    // Keep the typing indicator alive for the duration of the turn.
    await ctx.replyWithChatAction('typing');
    const typing = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, 4000);

    try {
      const resume = getSessionId(chatId);
      let produced = false;

      for await (const ev of askClaude({ prompt: text, resume })) {
        switch (ev.kind) {
          case 'session':
            setSessionId(chatId, ev.sessionId);
            break;
          case 'tool':
            await ctx.reply(`🔧 ${ev.name}`);
            break;
          case 'text':
            produced = true;
            logMessage(chatId, 'assistant', ev.text);
            await send(ev.text);
            break;
          case 'result':
            if (!ev.ok) await ctx.reply(`⚠️ Run ended: ${ev.error ?? 'unknown error'}`);
            break;
        }
      }

      if (!produced) await ctx.reply('(no response)');
    } catch (err) {
      console.error('[claude] error', err);
      await ctx.reply(`⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearInterval(typing);
    }
  });

  bot.catch((err) => console.error('[bot] error', err));

  return bot;
}
