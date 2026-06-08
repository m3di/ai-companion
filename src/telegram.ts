import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Context, InlineKeyboard } from 'grammy';
import { config, type PermissionMode } from './config.js';
import { askClaude } from './claude.js';
import {
  type ChatSession,
  createSession,
  getChatSettings,
  getMemo,
  getPrefs,
  getSessionId,
  getSharedMemory,
  listSessions,
  logMessage,
  logRoute,
  messageCount,
  recentCorrections,
  recentRoutes,
  sessionKey,
  setAutoRoute,
  setCwd,
  setMode,
  setPinned,
  setSessionStatus,
  setSessionId,
  setSessionTitle,
} from './db.js';
import { describeTool, escapeHtml, fileOpMessage } from './format.js';
import { createCanUseTool, resolvePermission } from './permissions.js';
import { routeMessage } from './router.js';
import {
  buildConciergeServer,
  conciergeSystemPrompt,
  CONCIERGE_TOOLS,
  resolveConfirm,
  takePendingSeed,
  takePendingSwitch,
} from './concierge.js';
import {
  activeSlot,
  attachSession,
  buildKeyboard,
  CONTROL_SLOT,
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
  const s = getChatSettings(target.chatId);
  const routing = s.pinned ? 'pinned here' : s.autoRoute ? 'auto' : 'off';
  return (
    `Session: ${titleOf(target.chatId, target.slot)} (slot ${target.slot})\n` +
    (memo ? `Memo: ${memo}\n` : '') +
    `Routing: ${routing}\n` +
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
  // A manual switch right after an auto-route teaches the router it was wrong.
  noteManualSwitch(chatId, slot);
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

  const isControl = target.slot === CONTROL_SLOT;
  const view = new RunningView(ctx, target.chatId, target.slot);
  await view.begin();
  const canUseTool = createCanUseTool(view);
  const prefs = getPrefs(target.key);
  const permissionMode = isControl
    ? 'bypassPermissions'
    : (prefs.permissionMode as PermissionMode) ?? config.permissionMode;
  const cwd = prefs.cwd ?? config.workingDir;
  const mcpServers = isControl
    ? { bot: buildConciergeServer(view), telegram: buildUiServer(view) }
    : { telegram: buildUiServer(view) };
  const concierge = isControl
    ? { systemPrompt: conciergeSystemPrompt(target.chatId), allowedTools: CONCIERGE_TOOLS }
    : undefined;
  const appendContext = isControl ? undefined : getSharedMemory(target.chatId).trim() || undefined;
  const abortController = new AbortController();
  running.set(target.key, abortController);

  let ok = true;
  try {
    const resume = getSessionId(target.key);
    for await (const ev of askClaude({
      prompt: text,
      resume,
      // The concierge runs bypassPermissions with a fixed safe toolset — no gate.
      canUseTool: isControl ? undefined : canUseTool,
      permissionMode,
      cwd,
      mcpServers,
      concierge,
      appendContext,
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
    // The concierge defers thread switches until after its reply, so changing
    // the active thread mid-turn doesn't suppress its own output. Apply it now,
    // then hand the worker its seeded task (delegation) as a fresh turn.
    if (isControl) {
      const sw = takePendingSwitch(target.chatId);
      if (sw !== undefined) {
        await attachSession(ctx.api, target.chatId, sw);
        const seed = takePendingSeed(target.chatId);
        if (seed && seed.slot === sw) {
          await submitTo(ctx, targetForSlot(target.chatId, sw), seed.text);
        }
      }
    }
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

/** Combine a burst into one prompt, route it to a thread, and run it. */
async function flushInbox(key: string): Promise<void> {
  const buf = inbox.get(key);
  if (!buf) return;
  inbox.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  const text = buf.texts.join('\n');

  const target = await decideRoute(buf.ctx, buf.ctx.chat!.id, text, buf.firstMsgId);
  if (!target) return; // a thread picker was shown; resumes via the route: callback
  await submitTo(buf.ctx, target, text, buf.firstMsgId);
}

/** Log the prompt to its thread and run it (asking for a mode first if new). */
async function submitTo(ctx: Context, target: Target, text: string, firstMsgId?: number): Promise<void> {
  logMessage(target.key, 'user', text);
  // The concierge runs with a fixed permission mode — never ask for one.
  if (target.slot !== CONTROL_SLOT && getMode(target.key) === undefined) {
    pendingPrompt.set(target.key, text);
    await askForMode(ctx);
    return;
  }
  await enqueueTurn(ctx, target, text, firstMsgId);
}

// Short messages and acknowledgements are almost always a follow-up to whatever
// the user is looking at — route them to the active thread without paying for a
// classifier call.
const ACK = /^(y(es|ep|eah|up)?|no(pe)?|ok(ay)?|k|sure|thanks|thank you|ty|go(\s|$)|go on|go ahead|continue|do it|please|stop|wait|cancel|nvm|got it|cool|nice|perfect|great)\b/i;
function isFollowup(text: string): boolean {
  const t = text.trim();
  return t.length <= 24 || ACK.test(t);
}

// Phase 1 routing: a message held while we wait for the user to pick a thread.
let routeSeq = 0;
const nextRouteId = () => (++routeSeq).toString(36);
// guessSlot: the router's low-confidence guess, so a different picker pick is a
// recorded correction.
const pendingRoute = new Map<string, { text: string; firstMsgId?: number; guessSlot?: number }>();

// The last high-confidence auto-route that SWITCHED threads, pending the user's
// next action. If they manually switch elsewhere before sending another
// message, that's a correction; if they send a follow-up, the route was good.
const lastAutoRoute = new Map<number, { message: string; slot: number; ts: number }>();
// Short window: a switch this soon after an auto-route is likely a correction;
// later switches are probably just normal navigation, so we don't mislabel them.
const CORRECTION_WINDOW_MS = 45 * 1000;

/** Record an implicit correction if a manual switch follows a bad auto-route. */
function noteManualSwitch(chatId: number, toSlot: number): void {
  const last = lastAutoRoute.get(chatId);
  lastAutoRoute.delete(chatId);
  if (!last || toSlot === last.slot || toSlot === CONTROL_SLOT) return;
  if (Date.now() - last.ts > CORRECTION_WINDOW_MS) return;
  logRoute(chatId, last.message, toSlot, titleOf(chatId, toSlot), {
    slot: last.slot,
    title: titleOf(chatId, last.slot),
  });
}

/**
 * Decide which thread a message belongs to. Returns the target to run against,
 * or null when a thread picker was posted and we're waiting on the user's tap.
 */
async function decideRoute(
  ctx: Context,
  chatId: number,
  text: string,
  firstMsgId?: number,
): Promise<Target | null> {
  ensureChat(chatId);
  // A new message arrived without a manual switch → the prior auto-route stuck.
  lastAutoRoute.delete(chatId);
  const active = activeTarget(chatId);
  const settings = getChatSettings(chatId);
  const threads = listSessions(chatId, 'active');

  // Already in the concierge: talk to it directly, don't work-route.
  if (active.slot === CONTROL_SLOT) return active;
  // Nothing to decide: routing off, pinned, a single thread, or an obvious
  // follow-up (short message / acknowledgement) that stays in the active thread.
  if (!settings.autoRoute || settings.pinned || threads.length <= 1) return active;
  if (isFollowup(text)) return active;

  await ctx.replyWithChatAction('typing').catch(() => {});
  const route = await routeMessage(
    text,
    threads.map((t) => ({ slot: t.slot, title: t.title, summary: getMemo(chatId, t.slot)?.summary })),
    active.slot,
    { recent: recentRoutes(chatId, 6), corrections: recentCorrections(chatId, 5) },
  );

  // Classifier failed or unsure → let the user decide (a misroute is costly).
  if (!route) return askRoute(ctx, chatId, text, threads, firstMsgId, 'Which thread is this for?');

  // About the bot itself → the concierge. A wrong control route is cheap (it
  // just answers / confirms), so we don't gate it on confidence.
  if (route.target === 'control') {
    if (active.slot !== CONTROL_SLOT) await attachSession(ctx.api, chatId, CONTROL_SLOT);
    return targetForSlot(chatId, CONTROL_SLOT);
  }
  if (route.confidence === 'low') {
    const guessSlot = typeof route.target === 'number' ? route.target : undefined;
    return askRoute(ctx, chatId, text, threads, firstMsgId, 'Not sure which thread — pick one:', guessSlot);
  }

  if (route.target === 'new') {
    const slot = createSession(chatId, 'New thread');
    setSessionTitle(chatId, slot, `${basename(config.workingDir)} #${slot + 1}`);
    await attachSession(ctx.api, chatId, slot);
    logRoute(chatId, text, slot, titleOf(chatId, slot));
    return targetForSlot(chatId, slot);
  }

  if (route.target !== active.slot) {
    await attachSession(ctx.api, chatId, route.target);
    const reason = route.reason ? ` · <i>${escapeHtml(route.reason)}</i>` : '';
    await ctx.reply(`🧭 → <b>${escapeHtml(titleOf(chatId, route.target))}</b>${reason}`, {
      parse_mode: 'HTML',
    });
    // Remember this switch so a quick manual correction can be learned.
    lastAutoRoute.set(chatId, { message: text, slot: route.target, ts: Date.now() });
  }
  logRoute(chatId, text, route.target, titleOf(chatId, route.target));
  return targetForSlot(chatId, route.target);
}

/** Post a thread picker, hold the message, and return null (resumes on tap). */
function askRoute(
  ctx: Context,
  chatId: number,
  text: string,
  threads: ChatSession[],
  firstMsgId: number | undefined,
  prompt: string,
  guessSlot?: number,
): null {
  const id = nextRouteId();
  const kb = new InlineKeyboard();
  threads.forEach((t, i) => {
    kb.text(t.title.slice(0, 40), `route:${id}:${t.slot}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('➕ New thread', `route:${id}:new`);
  pendingRoute.set(id, { text, firstMsgId, guessSlot });
  void ctx.reply(`🧭 <b>${escapeHtml(prompt)}</b>`, { parse_mode: 'HTML', reply_markup: kb });
  return null;
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
      'Connected. This chat runs several Claude threads at once. Just talk — I route each message to the matching thread (and tell you when I switch). The buttons below switch manually; every thread keeps running.\n' +
        'Tap ⚙️ Bot (or /bot) to manage threads & memory by talking to the bot itself.\n' +
        '/new — start another thread\n' +
        '/sessions — show the thread keyboard\n' +
        '/pin — keep messages in the current thread (toggle)\n' +
        '/auto — turn auto-routing on/off\n' +
        '/close — close the current thread\n' +
        '/history — reopen a closed thread\n' +
        '/cancel — stop the current thread’s turn\n' +
        '/cwd [path] — show or set this thread’s working directory\n' +
        '/status — current thread info',
      { reply_markup: buildKeyboard(ctx.chat!.id) },
    );
  });

  bot.command('sessions', (ctx) => {
    ensureChat(ctx.chat!.id);
    return ctx.reply('🗂 Your sessions — tap to switch:', { reply_markup: buildKeyboard(ctx.chat!.id) });
  });

  bot.command('bot', (ctx) => switchTo(ctx, CONTROL_SLOT));

  bot.command('new', (ctx) => createAndAttach(ctx));

  bot.command('close', async (ctx) => {
    const chatId = ctx.chat!.id;
    const slot = activeSlot(chatId);
    if (slot === CONTROL_SLOT) {
      return ctx.reply('The ⚙️ Bot thread can’t be closed. Tap a thread to switch to it.');
    }
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

  bot.command('pin', (ctx) => {
    const chatId = ctx.chat!.id;
    ensureChat(chatId);
    const next = !getChatSettings(chatId).pinned;
    setPinned(chatId, next);
    return ctx.reply(
      next
        ? `📌 Pinned to <b>${escapeHtml(titleOf(chatId, activeSlot(chatId)))}</b> — messages stay here until you /pin again.`
        : '📌 Unpinned — messages route to the matching thread again.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('auto', (ctx) => {
    const chatId = ctx.chat!.id;
    ensureChat(chatId);
    const next = !getChatSettings(chatId).autoRoute;
    setAutoRoute(chatId, next);
    return ctx.reply(
      next
        ? '🧭 Auto-routing on — I pick the matching thread for each message.'
        : '🧭 Auto-routing off — messages go to the active thread.',
    );
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

    // Thread picker (routing) — user chose where a held message should go.
    if (data.startsWith('route:')) {
      const [, id, sel] = data.split(':');
      const pend = id ? pendingRoute.get(id) : undefined;
      await ctx.answerCallbackQuery();
      if (!pend) {
        await ctx.editMessageText('🧭 (expired)').catch(() => {});
        return;
      }
      pendingRoute.delete(id!);
      let routed: Target;
      if (sel === 'new') {
        const slot = createSession(chatId, 'New thread');
        setSessionTitle(chatId, slot, `${basename(config.workingDir)} #${slot + 1}`);
        await attachSession(ctx.api, chatId, slot);
        routed = targetForSlot(chatId, slot);
      } else {
        const slot = Number(sel);
        await attachSession(ctx.api, chatId, slot);
        routed = targetForSlot(chatId, slot);
      }
      await ctx
        .editMessageText(`🧭 → <b>${escapeHtml(titleOf(chatId, routed.slot))}</b>`, {
          parse_mode: 'HTML',
        })
        .catch(() => {});
      // Log the pick — as a correction if it contradicts the router's guess.
      const wrong =
        pend.guessSlot !== undefined && pend.guessSlot !== routed.slot
          ? { slot: pend.guessSlot, title: titleOf(chatId, pend.guessSlot) }
          : undefined;
      logRoute(chatId, pend.text, routed.slot, titleOf(chatId, routed.slot), wrong);
      await submitTo(ctx, routed, pend.text, pend.firstMsgId);
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

    // Concierge destructive-action confirmation (e.g. close a thread).
    if (data.startsWith('cfm:')) {
      const [, id, yes] = data.split(':');
      await ctx.answerCallbackQuery();
      if (id && resolveConfirm(id, yes === '1')) {
        await ctx
          .editMessageText(yes === '1' ? '✅ Confirmed.' : 'Cancelled.', {})
          .catch(() => {});
      }
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
    if (btn === 'control') return void switchTo(ctx, CONTROL_SLOT);
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
