import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { config, type PermissionMode } from './config.js';
import { askClaude } from './claude.js';
import {
  type ChatSession,
  createSession,
  getMemo,
  getPrefs,
  getSessionId,
  listSessions,
  logMessage,
  messageCount,
  sessionKey,
  setCwd,
  setMode,
  setSessionStatus,
  setSessionId,
  setSessionTitle,
} from './db.js';
import { describeTool, escapeHtml, fileOpMessage } from './format.js';
import { createCanUseTool, resolvePermission } from './permissions.js';
import {
  activeSlot,
  attachSession,
  buildKeyboard,
  ensureChat,
  matchButton,
  RunningView,
  titleOf,
} from './sessions.js';
import { buildUiServer, resolveAsk, takeQuickReply } from './ui.js';

/** A resolved target: a chat and the session slot a turn should run against. */
interface Target {
  chatId: number;
  slot: number;
  key: string;
}

function activeTarget(chatId: number): Target {
  const slot = activeSlot(chatId);
  return { chatId, slot, key: sessionKey(chatId, slot) };
}

function targetForSlot(chatId: number, slot: number): Target {
  return { chatId, slot, key: sessionKey(chatId, slot) };
}

// A message held while we wait for the mode pick, keyed by session key.
const pendingPrompt = new Map<string, string>();

function getMode(key: string): PermissionMode | undefined {
  return getPrefs(key).permissionMode as PermissionMode | undefined;
}

// Per-session turn serialization: one running turn per session, the rest queue.
const busy = new Set<string>();
const queues = new Map<string, Array<{ ctx: Context; text: string; userMsgId?: number }>>();
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

function expandPath(p: string): string {
  return resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
}

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

function statusText(target: Target): string {
  const sessionId = getSessionId(target.key);
  const prefs = getPrefs(target.key);
  const mode = prefs.permissionMode;
  const memo = getMemo(target.chatId, target.slot)?.summary;
  return (
    `Session: ${titleOf(target.chatId, target.slot)} (slot ${target.slot})\n` +
    (memo ? `Memo: ${memo}\n` : '') +
    `Claude session: ${sessionId ?? 'none (starts on next message)'}\n` +
    `Permission mode: ${mode ? MODE_LABEL[mode] ?? mode : 'not chosen yet'}\n` +
    `Working dir: ${prefs.cwd ?? config.workingDir}\n` +
    `Messages logged: ${messageCount(target.key)}`
  );
}

/** Create a fresh session in this chat, attach to it, and ask its mode. */
async function createAndAttach(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  ensureChat(chatId);
  const slot = createSession(chatId, 'New session');
  const def = basename(config.workingDir);
  setSessionTitle(chatId, slot, `${def} #${slot + 1}`);
  await attachSession(ctx.api, chatId, slot);
  await askForMode(ctx);
}

/** Switch the chat's attached session to `slot` (replays last messages). */
async function switchTo(ctx: Context, slot: number): Promise<void> {
  const chatId = ctx.chat!.id;
  await attachSession(ctx.api, chatId, slot);
}

function sessionListKeyboard(chatId: number, sessions: ChatSession[], prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  sessions.forEach((s, i) => {
    kb.text(s.title, `${prefix}:${s.slot}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

/** Run one user turn against Claude Code, rendering progress through the view. */
async function runTurn(ctx: Context, target: Target, text: string, userMsgId?: number): Promise<void> {
  await react(ctx, target.chatId, userMsgId, '✍');

  const view = new RunningView(ctx, target.chatId, target.slot);
  await view.begin();
  const canUseTool = createCanUseTool(view);
  const prefs = getPrefs(target.key);
  const permissionMode = (prefs.permissionMode as PermissionMode) ?? config.permissionMode;
  const cwd = prefs.cwd ?? config.workingDir;
  const mcpServers = { telegram: buildUiServer(view) };
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
          const tv = describeTool(ev.name, ev.input);
          if (!tv.mute) view.action(tv.summary, tv.subagent ? '🤖' : '⚙️');
          const opMsg = fileOpMessage(ev.name, ev.input);
          if (opMsg) await view.fileOp(opMsg);
          break;
        }
        case 'text':
          logMessage(target.key, 'assistant', ev.text);
          await view.answer(ev.text);
          break;
        case 'result':
          ok = ev.ok;
          if (!ev.ok && view.isAttached()) {
            await ctx.reply(`⚠️ Run ended: ${ev.error ?? 'unknown error'}`);
          }
          break;
      }
    }
  } catch (err) {
    ok = false;
    if (abortController.signal.aborted) {
      if (view.isAttached()) await ctx.reply('🛑 Cancelled.');
    } else {
      console.error('[claude] error', err);
      if (view.isAttached()) {
        await ctx.reply(`⚠️ Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    running.delete(target.key);
    await view.finish(ok);
    await react(ctx, target.chatId, userMsgId, abortController.signal.aborted ? '🤔' : ok ? '👍' : '😱');
  }
}

/** Serialize turns per session: run now if idle, else queue. */
async function enqueueTurn(ctx: Context, target: Target, text: string, userMsgId?: number): Promise<void> {
  if (busy.has(target.key)) {
    const q = queues.get(target.key) ?? [];
    q.push({ ctx, text, userMsgId });
    queues.set(target.key, q);
    await react(ctx, target.chatId, userMsgId, '👀');
    await ctx.reply('⏳ Queued — running after the current task in this session.');
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

// Telegram caps a message at 4096 chars and the client splits a long paste into
// several separate messages with no "these are one" marker. We coalesce a burst
// of messages into a single prompt: each arrival resets a short debounce, and a
// near-max-length chunk (almost certainly mid-split) waits longer for the rest.
const COALESCE_MS = 600;
const COALESCE_SPLIT_MS = 2500;
const SPLIT_LEN = 4000;

interface Inbox {
  ctx: Context;
  target: Target;
  texts: string[];
  firstMsgId?: number;
  timer?: NodeJS.Timeout;
}
const inbox = new Map<string, Inbox>();

/** Buffer a message and (re)arm the debounce that flushes the coalesced turn. */
function bufferMessage(ctx: Context, target: Target, text: string, msgId: number): void {
  let buf = inbox.get(target.key);
  if (!buf) {
    buf = { ctx, target, texts: [], firstMsgId: msgId };
    inbox.set(target.key, buf);
  }
  buf.ctx = ctx;
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  const wait = text.length >= SPLIT_LEN ? COALESCE_SPLIT_MS : COALESCE_MS;
  buf.timer = setTimeout(() => void flushInbox(target.key), wait);
}

/** Combine a burst into one prompt and run it (or ask for a mode first). */
async function flushInbox(key: string): Promise<void> {
  const buf = inbox.get(key);
  if (!buf) return;
  inbox.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  const text = buf.texts.join('\n');
  logMessage(buf.target.key, 'user', text);

  if (getMode(buf.target.key) === undefined) {
    pendingPrompt.set(buf.target.key, text);
    await askForMode(buf.ctx);
    return;
  }
  await enqueueTurn(buf.ctx, buf.target, text, buf.firstMsgId);
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);
  bot.api.config.use(autoRetry());

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

  bot.command('start', async (ctx) => {
    ensureChat(ctx.chat!.id);
    await ctx.reply(
      'Connected. This chat can hold several Claude sessions at once — the buttons below switch between them; they all keep running.\n' +
        '/new — start another session\n' +
        '/sessions — show the session keyboard\n' +
        '/close — close the current session\n' +
        '/history — reopen a closed session\n' +
        '/cancel — stop the current session’s turn\n' +
        '/cwd [path] — show or set this session’s working directory\n' +
        '/status — current session info',
      { reply_markup: buildKeyboard(ctx.chat!.id) },
    );
  });

  bot.command('sessions', (ctx) => {
    ensureChat(ctx.chat!.id);
    return ctx.reply('🗂 Your sessions — tap to switch:', { reply_markup: buildKeyboard(ctx.chat!.id) });
  });

  bot.command('new', (ctx) => createAndAttach(ctx));

  bot.command('close', async (ctx) => {
    const chatId = ctx.chat!.id;
    const slot = activeSlot(chatId);
    cancelSession(sessionKey(chatId, slot));
    const title = titleOf(chatId, slot);
    setSessionStatus(chatId, slot, 'closed');
    await ctx.reply(`🗂 Closed <b>${escapeHtml(title)}</b>. Reopen it any time with /history.`, {
      parse_mode: 'HTML',
    });
    const remaining = listSessions(chatId, 'active');
    if (remaining.length > 0) {
      await attachSession(ctx.api, chatId, remaining[0]!.slot);
    } else {
      await createAndAttach(ctx);
    }
  });

  bot.command('history', (ctx) => {
    const chatId = ctx.chat!.id;
    const closed = listSessions(chatId, 'closed');
    if (closed.length === 0) return ctx.reply('No closed sessions.');
    return ctx.reply('🗂 Closed sessions — tap to reopen:', {
      reply_markup: sessionListKeyboard(chatId, closed, 'reopen'),
    });
  });

  bot.command('cancel', (ctx) => {
    const target = activeTarget(ctx.chat!.id);
    return ctx.reply(cancelSession(target.key) ? '🛑 Cancelling…' : 'Nothing is running in this session.');
  });

  bot.command('cwd', (ctx) => {
    const chatId = ctx.chat!.id;
    const target = activeTarget(chatId);
    const arg = ctx.match.trim();
    if (!arg) {
      return ctx.reply(
        `Working dir: ${getPrefs(target.key).cwd ?? config.workingDir}\nSet with /cwd <path>`,
      );
    }
    const dir = expandPath(arg);
    setCwd(target.key, dir);
    setSessionTitle(chatId, target.slot, `${basename(dir)} #${target.slot + 1}`);
    return ctx.reply(`📁 Working dir for this session: ${dir}`, { reply_markup: buildKeyboard(chatId) });
  });

  bot.command('status', (ctx) => ctx.reply(statusText(activeTarget(ctx.chat!.id))));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (ctx.chat === undefined) return;
    const chatId = ctx.chat.id;
    const target = activeTarget(chatId);

    if (data.startsWith('mode:')) {
      const mode = data.slice('mode:'.length) as PermissionMode;
      setMode(target.key, mode);
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

    if (data.startsWith('reopen:')) {
      const slot = Number(data.slice('reopen:'.length));
      setSessionStatus(chatId, slot, 'active');
      await ctx.answerCallbackQuery('Reopened');
      await attachSession(ctx.api, chatId, slot);
      return;
    }

    if (data.startsWith('ask:')) {
      const [, id, idxStr] = data.split(':');
      const result = id ? resolveAsk(id, Number(idxStr)) : null;
      await ctx.answerCallbackQuery(result?.chosen ?? 'Expired');
      if (result?.messageId !== undefined) {
        await ctx.api
          .editMessageText(
            chatId,
            result.messageId,
            `❓ <b>${escapeHtml(result.question)}</b>\n✅ ${escapeHtml(result.chosen)}`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }
      return;
    }

    if (data.startsWith('qr:')) {
      const entry = takeQuickReply(data.slice('qr:'.length));
      await ctx.answerCallbackQuery();
      if (entry !== undefined) {
        const [cid, slotStr] = entry.key.split(':');
        const t = targetForSlot(Number(cid), Number(slotStr));
        logMessage(t.key, 'user', entry.text);
        await enqueueTurn(ctx, t, entry.text);
      }
      return;
    }

    if (data === 'noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    if (data === 'stop') {
      const cancelled = cancelSession(target.key);
      await ctx.answerCallbackQuery(cancelled ? '🛑 Cancelling…' : 'Nothing running');
      return;
    }

    if (resolvePermission(data)) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery('Expired');
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    ensureChat(chatId);
    const text = ctx.message.text;

    // A tap on the bottom reply keyboard arrives as a normal text message.
    const btn = matchButton(chatId, text);
    if (btn === 'new') return void createAndAttach(ctx);
    if (btn === 'history') {
      const closed = listSessions(chatId, 'closed');
      if (closed.length === 0) return void ctx.reply('No closed sessions.');
      return void ctx.reply('🗂 Closed sessions — tap to reopen:', {
        reply_markup: sessionListKeyboard(chatId, closed, 'reopen'),
      });
    }
    if (typeof btn === 'number') return void switchTo(ctx, btn);

    // Coalesce back-to-back messages (e.g. a long paste Telegram split) into one
    // turn instead of starting on the first and queueing the rest.
    bufferMessage(ctx, activeTarget(chatId), text, ctx.message.message_id);
  });

  bot.catch((err) => console.error('[bot] error', err));

  return bot;
}
