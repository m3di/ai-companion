import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { config, type PermissionMode } from './config.js';
import { askClaude } from './claude.js';
import { digestFile } from './digest.js';
import { runDream } from './dream.js';
import { runGrow } from './grow.js';
import {
  addPending,
  clearPending,
  clearSession,
  countPending,
  getMemo,
  getPrefs,
  getSessionId,
  getSharedMemory,
  isCapturing,
  listPending,
  listRepos,
  listSessions,
  logMessage,
  recentDreams,
  recentGrows,
  recentMessages,
  refreshAutoTitle,
  sessionForMessage,
  sessionKey,
  setCapturing,
  saveUsage,
  setRecap,
  setSessionId,
} from './db.js';
import { chunkRaw, describeTool, escapeHtml, fileOpMessage } from './format.js';
import { createCanUseTool, resolvePermission } from './permissions.js';
import {
  buildConciergeServer,
  conciergeSystemPrompt,
  CONCIERGE_TOOLS,
  resolveConfirm,
  takePendingDispatch,
  takePendingSeed,
  takePendingSwitch,
} from './concierge.js';
import { CONTROL_SLOT, ensureChat, RunningView, statusMarker, titleOf } from './sessions.js';
import { buildUiServer, resolveAsk, takeQuickReply } from './ui.js';
import { addRepos, scanWorkspace, workspaceContext } from './workspace.js';
import type { ChatAdapter, Inbound, InboundCallback, InboundCommand, InboundMessage } from './transport/types.js';

/** A resolved target: a chat and the session slot a turn should run against. */
interface Target {
  chatId: number;
  slot: number;
  key: string;
}

function targetForSlot(chatId: number, slot: number): Target {
  return { chatId, slot, key: sessionKey(chatId, slot) };
}

// The single chat transport for this process, set in registerDispatch().
let adapter!: ChatAdapter;

/**
 * Wire the dispatcher to a chat adapter: the bot's transport-agnostic core. All
 * grammy/Telegram specifics live behind the ChatAdapter; this module only sees
 * normalized inbound events and the outbound transport.
 */
export function registerDispatch(a: ChatAdapter): void {
  adapter = a;
  a.onEvent(handleEvent);
}

async function handleEvent(e: Inbound): Promise<void> {
  try {
    if (e.kind === 'command') await handleCommand(e);
    else if (e.kind === 'message') handleMessage(e);
    else await handleCallback(e);
  } catch (err) {
    console.error('[dispatch] error', err);
  }
}

// --- Turn execution ---------------------------------------------------------

// Per-session turn serialization: one running turn per session, the rest queue.
const busy = new Set<string>();
const queues = new Map<string, Array<{ text: string; visible: boolean; userMsgId?: number }>>();
const running = new Map<string, AbortController>();
// Abort a turn that emits no events for this long — a hung subprocess otherwise
// holds the session lock forever and silently blocks every queued message.
const TURN_IDLE_MS = 20 * 60 * 1000;

/** Abort the running turn for a session and drop anything queued behind it. */
function cancelSession(key: string): boolean {
  queues.delete(key);
  const controller = running.get(key);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Cancel every running turn in a chat. Returns how many were stopped. */
function cancelChat(chatId: number): number {
  let n = 0;
  const prefix = `${chatId}:`;
  for (const key of running.keys()) {
    if (key.startsWith(prefix) && cancelSession(key)) n++;
  }
  return n;
}

// Cap the concierge's resumed history: clear its session every N turns so the
// per-turn context stays bounded (it re-onboards from the lean system prompt).
const conciergeTurns = new Map<number, number>();
const CONCIERGE_RESET_AFTER = 30;
function maybeResetConcierge(chatId: number): void {
  const n = (conciergeTurns.get(chatId) ?? 0) + 1;
  if (n > CONCIERGE_RESET_AFTER) {
    clearSession(sessionKey(chatId, CONTROL_SLOT));
    conciergeTurns.set(chatId, 0);
  } else {
    conciergeTurns.set(chatId, n);
  }
}

/** Run one turn against Claude Code, rendering progress through the view. */
async function runTurn(
  target: Target,
  text: string,
  opts: { visible: boolean; userMsgId?: number },
): Promise<void> {
  const { visible, userMsgId } = opts;
  const { chatId, slot, key } = target;
  if (userMsgId !== undefined) await adapter.react(chatId, userMsgId, '✍');

  const isControl = slot === CONTROL_SLOT;
  // The concierge is an all-day session: its whole history re-sends every turn.
  // Periodically clear it so context (and cost) doesn't grow unbounded.
  if (isControl) maybeResetConcierge(chatId);

  const view = new RunningView(adapter, chatId, slot, visible);
  await view.begin();
  const canUseTool = createCanUseTool(view);
  const prefs = getPrefs(key);
  const permissionMode = isControl
    ? 'bypassPermissions'
    : (prefs.permissionMode as PermissionMode) ?? config.permissionMode;
  const cwd = prefs.cwd ?? config.workingDir;
  const mcpServers = isControl
    ? { bot: buildConciergeServer(view), telegram: buildUiServer(view) }
    : { telegram: buildUiServer(view) };
  const concierge = isControl
    ? { systemPrompt: conciergeSystemPrompt(chatId), allowedTools: CONCIERGE_TOOLS }
    : undefined;
  const appendContext = isControl
    ? undefined
    : [getSharedMemory(chatId).trim(), workspaceContext()].filter(Boolean).join('\n\n') || undefined;
  const abortController = new AbortController();
  running.set(key, abortController);

  // Watchdog: abort a turn that goes silent too long (a hung/dead subprocess) so
  // it can't hold the session lock forever. Re-armed on every event.
  let timedOut = false;
  const arm = () =>
    setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, TURN_IDLE_MS);
  let idle = arm();

  let ok = true;
  let lastText = '';
  try {
    const resume = getSessionId(key);
    for await (const ev of askClaude({
      prompt: text,
      resume,
      canUseTool: isControl ? undefined : canUseTool,
      permissionMode,
      cwd,
      mcpServers,
      concierge,
      appendContext,
      abortController,
    })) {
      clearTimeout(idle);
      idle = arm();
      switch (ev.kind) {
        case 'session':
          setSessionId(key, ev.sessionId);
          break;
        case 'tool': {
          const tv = describeTool(ev.name, ev.input);
          if (!tv.mute) view.action(tv.summary, tv.subagent ? '🤖' : '⚙️');
          const opMsg = fileOpMessage(ev.name, ev.input);
          if (opMsg) await view.fileOp(opMsg);
          break;
        }
        case 'text':
          logMessage(key, 'assistant', ev.text);
          lastText = ev.text;
          await view.answer(ev.text);
          break;
        case 'result':
          ok = ev.ok;
          if (ev.usage) saveUsage(key, ev.usage);
          if (!ev.ok && visible) {
            await adapter.send(chatId, { text: `⚠️ Run ended: ${ev.error ?? 'unknown error'}`, format: 'plain' });
          }
          break;
      }
    }
  } catch (err) {
    ok = false;
    if (abortController.signal.aborted) {
      if (visible) {
        await adapter.send(chatId, {
          text: timedOut ? '⌛ Timed out (no activity) — freed this thread.' : '🛑 Cancelled.',
          format: 'plain',
        });
      }
    } else {
      console.error('[claude] error', err);
      if (visible) {
        await adapter.send(chatId, {
          text: `⚠️ Error: ${err instanceof Error ? err.message : String(err)}`,
          format: 'plain',
        });
      }
    }
  } finally {
    clearTimeout(idle);
    running.delete(key);
    await view.finish(ok);
    if (userMsgId !== undefined)
      await adapter.react(chatId, userMsgId, abortController.signal.aborted ? '🤔' : ok ? '👍' : '😱');
    if (isControl) {
      applyConciergeMoves(chatId);
    } else if (!visible && !abortController.signal.aborted) {
      // A background worker finished → wake the concierge to decide whether and
      // how to report it.
      void notifyCompletion(target, ok);
    }
    if (!isControl) {
      // Refresh the auto recap (latest worker state) so "what's it doing?" is
      // answerable without re-reading the thread; and keep the title fresh from
      // Claude Code's free session summary.
      if (lastText.trim()) setRecap(chatId, slot, lastText.replace(/\s+/g, ' ').trim().slice(0, 200));
      void refreshThreadTitle(chatId, slot);
    }
  }
}

/**
 * Apply the concierge's deferred moves after its reply (so they don't suppress
 * its own output). DISPATCH = run a worker in the background (quiet); the
 * "watch" move (newThread/switchThread with a task) = run the seed visibly so
 * the user sees it and can continue by replying to the worker.
 */
function applyConciergeMoves(chatId: number): void {
  for (const d of takePendingDispatch(chatId)) {
    const wt = targetForSlot(chatId, d.slot);
    logMessage(wt.key, 'user', d.text);
    void enqueueTurn(wt, d.text, { visible: false });
  }
  const sw = takePendingSwitch(chatId);
  if (sw !== undefined) {
    const seed = takePendingSeed(chatId);
    if (seed && seed.slot === sw) {
      const wt = targetForSlot(chatId, sw);
      logMessage(wt.key, 'user', seed.text);
      void enqueueTurn(wt, seed.text, { visible: true });
    }
    // A switch with no task has nothing to run — the worker is reachable by reply.
  }
}

/**
 * Pull Claude Code's free per-session summary (no LLM call) and use it as the
 * thread's title unless it was explicitly renamed. Best-effort.
 */
async function refreshThreadTitle(chatId: number, slot: number): Promise<void> {
  if (slot === CONTROL_SLOT) return;
  const key = sessionKey(chatId, slot);
  const sessionId = getSessionId(key);
  if (!sessionId) return;
  const cwd = getPrefs(key).cwd ?? config.workingDir;
  try {
    const info = await getSessionInfo(sessionId, { dir: cwd });
    const summary = info?.summary?.trim();
    if (summary && summary.length > 3) refreshAutoTitle(chatId, slot, summary.slice(0, 60));
  } catch {
    /* session file not found / no summary — ignore */
  }
}

/**
 * Wake the concierge after a background worker completes: hand it the worker's
 * result and let it decide whether to notify the user. Runs as a normal
 * (visible) concierge turn, so its reply reaches the chat. Fire-and-forget.
 */
async function notifyCompletion(worker: Target, ok: boolean): Promise<void> {
  const title = titleOf(worker.chatId, worker.slot);
  const msgs = recentMessages(worker.key, 8);
  const lastIdx = msgs.length - 1;
  const recent = msgs
    .map((m, i) => {
      const cap = i === lastIdx ? 4000 : 500;
      const body = m.content.length > cap ? `${m.content.slice(0, cap)}…[truncated]` : m.content;
      return `${m.role === 'user' ? 'Task' : 'Worker'}: ${body}`;
    })
    .join('\n');
  const prompt =
    `[SYSTEM EVENT] The background worker "${title}" just ${ok ? 'finished' : 'stopped with an error'}. ` +
    `Its recent activity:\n${recent}\n\n` +
    `If this is worth telling the user, deliver ONE concise notice with the telegram send tool — what got done, ` +
    `and offer a sensible next step as an inline reply button if useful. If it's trivial or just an acknowledgement, do nothing.`;
  await enqueueTurn(targetForSlot(worker.chatId, CONTROL_SLOT), prompt, { visible: true });
}

/** Serialize turns per session: run now if idle, else queue. */
async function enqueueTurn(
  target: Target,
  text: string,
  opts: { visible: boolean; userMsgId?: number },
): Promise<void> {
  if (busy.has(target.key)) {
    const q = queues.get(target.key) ?? [];
    q.push({ text, visible: opts.visible, userMsgId: opts.userMsgId });
    queues.set(target.key, q);
    if (opts.userMsgId !== undefined) await adapter.react(target.chatId, opts.userMsgId, '👀');
    return;
  }
  busy.add(target.key);
  try {
    await runTurn(target, text, opts);
    for (;;) {
      const next = queues.get(target.key)?.shift();
      if (!next) break;
      await runTurn(target, next.text, { visible: next.visible, userMsgId: next.userMsgId });
    }
  } finally {
    busy.delete(target.key);
    queues.delete(target.key);
  }
}

// --- Inbound messages -------------------------------------------------------

// Telegram caps a message at 4096 chars and splits a long paste into several
// messages with no "these are one" marker. We coalesce a burst into a single
// prompt: each arrival resets a short debounce; a near-max chunk waits longer.
const COALESCE_MS = 600;
const COALESCE_SPLIT_MS = 2500;
const SPLIT_LEN = 4000;

interface Inbox {
  target: Target;
  texts: string[];
  firstMsgId?: number;
  timer?: NodeJS.Timeout;
}
const inbox = new Map<string, Inbox>();

function bufferMessage(target: Target, text: string, msgId: number): void {
  let buf = inbox.get(target.key);
  if (!buf) {
    buf = { target, texts: [], firstMsgId: msgId };
    inbox.set(target.key, buf);
  }
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  const wait = text.length >= SPLIT_LEN ? COALESCE_SPLIT_MS : COALESCE_MS;
  buf.timer = setTimeout(() => void flushInbox(target.key), wait);
}

async function flushInbox(key: string): Promise<void> {
  const buf = inbox.get(key);
  if (!buf) return;
  inbox.delete(key);
  if (buf.timer) clearTimeout(buf.timer);
  await submitTo(buf.target, buf.texts.join('\n'), buf.firstMsgId);
}

/** Log the prompt to its thread and run it (always a visible, user-driven turn). */
async function submitTo(target: Target, text: string, firstMsgId?: number): Promise<void> {
  logMessage(target.key, 'user', text);
  await enqueueTurn(target, text, { visible: true, userMsgId: firstMsgId });
}

/**
 * Resolve which session a message addresses. A reply to a tagged bot message →
 * that message's session (a momentary direct line to a worker, or back to the
 * concierge); anything else → the concierge (home base).
 */
function resolveTarget(chatId: number, replyToMessageId?: number): Target {
  if (replyToMessageId !== undefined) {
    const key = sessionForMessage(chatId, replyToMessageId);
    if (key) {
      const slot = Number(key.split(':')[1]);
      if (Number.isFinite(slot)) return targetForSlot(chatId, slot);
    }
  }
  return targetForSlot(chatId, CONTROL_SLOT);
}

function handleMessage(e: InboundMessage): void {
  ensureChat(e.chatId);

  // Capture mode: queue the message for /process instead of running it. A reply
  // pre-addresses its fragment to that worker; everything else is left for the
  // concierge to triage. Acked with a reaction — no agent turn, no cost.
  if (isCapturing(e.chatId)) {
    let targetKey: string | undefined;
    if (e.replyToMessageId !== undefined) {
      const k = sessionForMessage(e.chatId, e.replyToMessageId);
      if (k && Number(k.split(':')[1]) !== CONTROL_SLOT) targetKey = k;
    }
    addPending(e.chatId, e.messageId, e.text, targetKey);
    void adapter.react(e.chatId, e.messageId, '👀');
    return;
  }

  const target = resolveTarget(e.chatId, e.replyToMessageId);
  bufferMessage(target, e.text, e.messageId);
}

// --- Commands ---------------------------------------------------------------

function expandPath(p: string): string {
  return resolve(p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
}

async function handleCommand(e: InboundCommand): Promise<void> {
  const { chatId, command, args } = e;
  ensureChat(chatId);

  switch (command) {
    case 'start':
      await adapter.send(chatId, {
        text:
          "Hi — I'm your concierge. Just tell me what you need; I spin up worker threads, run the work, and report back. " +
          'To talk to a worker directly, reply to one of its messages.\n\n' +
          '/sessions — your worker threads (status)\n' +
          '/capture — collect notes through the day\n' +
          '/process — triage & fan out what you captured\n' +
          '/cancel — stop all running work\n' +
          '/repos — your workspace repos\n' +
          '/dream — offline self-reflection\n' +
          '/status — concierge + worker overview',
        format: 'plain',
        removeKeyboard: true,
      });
      return;

    case 'sessions': {
      const active = listSessions(chatId, 'active');
      const closed = listSessions(chatId, 'closed');
      if (!active.length) {
        await adapter.send(chatId, {
          text: "No worker threads yet. Tell me what you need and I'll start one.",
          format: 'plain',
        });
        return;
      }
      const lines = active.map((s) => {
        const mark = statusMarker(chatId, s.slot) || '•';
        const m = getMemo(chatId, s.slot);
        const status = m?.recap ?? m?.summary;
        return `${mark} <b>${escapeHtml(s.title)}</b>${status ? ` — ${escapeHtml(status)}` : ''}`;
      });
      const tail = closed.length ? `\n<i>${closed.length} closed</i>` : '';
      await adapter.send(chatId, {
        text: `🗂 <b>Worker threads</b>\n${lines.join('\n')}${tail}\n\n<i>Reply to a worker's message to talk to it.</i>`,
        format: 'tgHtml',
      });
      return;
    }

    case 'cancel': {
      const n = cancelChat(chatId);
      await adapter.send(chatId, {
        text: n ? `🛑 Stopping ${n} running ${n === 1 ? 'turn' : 'turns'}…` : 'Nothing is running.',
        format: 'plain',
      });
      return;
    }

    case 'status': {
      const active = listSessions(chatId, 'active').length;
      const cid = getSessionId(sessionKey(chatId, CONTROL_SLOT));
      await adapter.send(chatId, {
        text:
          `Concierge session: ${cid ?? 'none (starts on next message)'}\n` +
          `Active workers: ${active}\n` +
          `Working dir: ${config.workingDir}`,
        format: 'plain',
      });
      return;
    }

    case 'reset':
      clearSession(sessionKey(chatId, CONTROL_SLOT));
      conciergeTurns.set(chatId, 0);
      await adapter.send(chatId, {
        text: '🧹 Cleared the concierge’s context. It’ll re-onboard from memos + notes on your next message.',
        format: 'plain',
      });
      return;

    case 'capture': {
      const on = !isCapturing(chatId);
      setCapturing(chatId, on);
      await adapter.send(chatId, {
        text: on
          ? '🟢 Capturing. Drop notes, forwards, and replies all day — they queue silently (👀), no agent runs. Reply to a worker to pre-address a fragment to it. Run /process to fan everything out; /capture again to stop.'
          : `⚪ Capture off. ${countPending(chatId)} item(s) waiting — /process to handle them.`,
        format: 'plain',
      });
      return;
    }

    case 'process':
      await runProcess(chatId);
      return;

    case 'dream':
      await adapter.send(chatId, {
        text: '🌙 Dreaming — reviewing recent activity and the code. This takes a couple of minutes…',
        format: 'plain',
      });
      void runDream(adapter, chatId);
      return;

    case 'dreams':
      await handleDreams(chatId, args);
      return;

    case 'grow':
      await adapter.send(chatId, {
        text: '🌱 Growing — refining the knowledge base from recent reflections. A couple of minutes…',
        format: 'plain',
      });
      void runGrow(adapter, chatId);
      return;

    case 'grows':
      await handleGrows(chatId, args);
      return;

    case 'repos':
      await handleRepos(chatId, args);
      return;

    case 'digest': {
      if (!args) {
        await adapter.send(chatId, {
          text: 'Usage: /digest <absolute path> — digests a file into the knowledge base.',
          format: 'plain',
        });
        return;
      }
      await adapter.send(chatId, { text: `📥 Digesting ${args} into notes…`, format: 'plain' });
      const res = await digestFile(expandPath(args));
      await adapter.send(chatId, {
        text: res.error ? `⚠️ ${res.error}` : `✅ Digested into ${res.keys.length} notes:\n${res.keys.join('\n')}`,
        format: 'plain',
      });
      return;
    }

    default:
      // Unknown command — stay quiet (avoids noise from typos / other bots).
      return;
  }
}

/** Triage & fan out everything captured for a chat (the /process batch flow). */
async function runProcess(chatId: number): Promise<void> {
  const items = listPending(chatId);
  if (!items.length) {
    await adapter.send(chatId, {
      text: 'Nothing captured to process. (/capture to start collecting.)',
      format: 'plain',
    });
    return;
  }
  setCapturing(chatId, false);
  clearPending(chatId);

  // Reply-pre-addressed fragments go straight to their worker; the rest go to
  // the concierge to triage and fan out (one batch → many threads).
  const addressed = new Map<string, string[]>();
  const toTriage: string[] = [];
  for (const it of items) {
    if (it.target_key) {
      const arr = addressed.get(it.target_key) ?? [];
      arr.push(it.text);
      addressed.set(it.target_key, arr);
    } else {
      toTriage.push(it.text);
    }
  }

  const routed: string[] = [];
  for (const [key, texts] of addressed) {
    const slot = Number(key.split(':')[1]);
    routed.push(`• ${titleOf(chatId, slot)} ← ${texts.length} item(s)`);
    await submitTo(targetForSlot(chatId, slot), texts.join('\n\n'));
  }

  await adapter.send(chatId, {
    text:
      `📥 Processing ${items.length} item(s).` +
      (routed.length ? `\nRouted directly by reply:\n${routed.join('\n')}` : '') +
      (toTriage.length ? `\nTriaging ${toTriage.length} with the concierge…` : ''),
    format: 'plain',
  });

  if (toTriage.length) {
    const list = toTriage.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt =
      `[PROCESS BATCH] I captured these ${toTriage.length} fragment(s) through the day and pressed /process. ` +
      `Work out what each means and where it belongs.\n\n${list}\n\n` +
      'First present a short fan-out PLAN — fragment(s) → destination (an existing thread by title / a new thread / shared memory / a note) — with a tappable confirm, and only dispatch after I confirm. ' +
      'Then fan out: dispatchTask to each target thread (you can dispatch several in one turn), update memos, and fold standing facts into shared memory or notes. ' +
      "Cluster related fragments. Flag anything ambiguous instead of guessing, and park whatever needs my input for when I'm back.";
    await submitTo(targetForSlot(chatId, CONTROL_SLOT), prompt);
  }
}

async function handleRepos(chatId: number, arg: string): Promise<void> {
  const fmt = (rs: Array<{ name: string; branch: string | null; conventions: string | null }>): string =>
    rs
      .map((r) => `• ${r.name}${r.branch ? ` (${r.branch})` : ''}${r.conventions ? ` · ${r.conventions}` : ''}`)
      .join('\n');

  if (arg.startsWith('add')) {
    const paths = arg
      .slice(3)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => expandPath(p));
    if (!paths.length) {
      await adapter.send(chatId, { text: 'Usage: /repos add <path> [path…]', format: 'plain' });
      return;
    }
    const added = addRepos(paths);
    await adapter.send(chatId, {
      text: added.length ? `✅ Registered ${added.length}:\n${fmt(added)}` : 'None of those are git repos.',
      format: 'plain',
    });
    return;
  }
  if (arg === 'scan') {
    await adapter.send(chatId, {
      text: `🔎 Scanning ${config.workspaceDir} (this grabs every git repo there)…`,
      format: 'plain',
    });
    const found = scanWorkspace();
    await adapter.send(chatId, {
      text: found.length
        ? `✅ Registered ${found.length} repos:\n${fmt(found)}`
        : `No git repos found under ${config.workspaceDir}.`,
      format: 'plain',
    });
    return;
  }
  const repos = listRepos();
  if (!repos.length) {
    await adapter.send(chatId, {
      text: 'No repos registered. Use /repos add <path…> for your work repos, or /repos scan for everything in your workspace.',
      format: 'plain',
    });
    return;
  }
  const lines = repos.map((r) => `• ${r.name} → ${r.path}${r.branch ? ` (${r.branch})` : ''}`);
  await adapter.send(chatId, { text: `Workspace repos (${repos.length}):\n${lines.join('\n')}`, format: 'plain' });
}

/** List recent persisted dreams, or show one in full (/dreams <id>). */
async function handleDreams(chatId: number, arg: string): Promise<void> {
  const dreams = recentDreams(chatId, 20);
  if (!dreams.length) {
    await adapter.send(chatId, { text: 'No dreams saved yet. Run /dream to reflect.', format: 'plain' });
    return;
  }
  const id = Number(arg);
  if (arg && Number.isFinite(id)) {
    const d = dreams.find((x) => x.id === id);
    if (!d) {
      await adapter.send(chatId, { text: `No dream #${id} in the recent list.`, format: 'plain' });
      return;
    }
    await adapter.send(chatId, {
      text: `🌙 Dream #${d.id} · ${d.created_at}${d.processed_at ? ' · processed' : ''}`,
      format: 'plain',
    });
    for (const piece of chunkRaw(d.report)) {
      await adapter.send(chatId, { text: piece, format: 'plain' });
    }
    return;
  }
  const lines = dreams.map((d) => {
    const first = (d.report.split('\n').find((l) => l.trim()) ?? '').replace(/[*#_`>]/g, '').slice(0, 70);
    return `#${d.id} · ${d.created_at.slice(0, 16)}${d.processed_at ? ' ✓' : ''} — ${first}`;
  });
  await adapter.send(chatId, {
    text: `🌙 Recent dreams (/dreams <id> for the full report):\n${lines.join('\n')}`,
    format: 'plain',
  });
}

/** List recent grow passes, or show one in full (/grows <id>). */
async function handleGrows(chatId: number, arg: string): Promise<void> {
  const grows = recentGrows(chatId, 20);
  if (!grows.length) {
    await adapter.send(chatId, {
      text: 'No grow passes yet. Run /grow to refine the knowledge base from recent reflections.',
      format: 'plain',
    });
    return;
  }
  const parseChanges = (raw: string): Array<{ action: string; path: string }> => {
    try {
      return JSON.parse(raw) as Array<{ action: string; path: string }>;
    } catch {
      return [];
    }
  };
  const id = Number(arg);
  if (arg && Number.isFinite(id)) {
    const g = grows.find((x) => x.id === id);
    if (!g) {
      await adapter.send(chatId, { text: `No grow #${id} in the recent list.`, format: 'plain' });
      return;
    }
    const changes = parseChanges(g.changes);
    const fileList = changes.length ? changes.map((c) => `${c.action} ${c.path}`).join('\n') : '(no file changes)';
    await adapter.send(chatId, {
      text: `🌱 Grow #${g.id} · ${g.created_at}\nChanges:\n${fileList}`,
      format: 'plain',
    });
    for (const piece of chunkRaw(g.summary)) {
      await adapter.send(chatId, { text: piece, format: 'plain' });
    }
    return;
  }
  const lines = grows.map((g) => {
    const n = parseChanges(g.changes).length;
    const first = (g.summary.split('\n').find((l) => l.trim()) ?? '').replace(/[*#_`>]/g, '').slice(0, 60);
    return `#${g.id} · ${g.created_at.slice(0, 16)} · ${n} change(s) — ${first}`;
  });
  await adapter.send(chatId, {
    text: `🌱 Recent grow passes (/grows <id> for the full log):\n${lines.join('\n')}`,
    format: 'plain',
  });
}

// --- Callbacks --------------------------------------------------------------

async function handleCallback(e: InboundCallback): Promise<void> {
  const { chatId, data } = e;

  if (data.startsWith('stop:')) {
    const slot = Number(data.slice('stop:'.length));
    const cancelled = Number.isFinite(slot) && cancelSession(sessionKey(chatId, slot));
    await e.answer(cancelled ? '🛑 Cancelling…' : 'Nothing running');
    return;
  }

  if (data.startsWith('qr:')) {
    const entry = takeQuickReply(data.slice('qr:'.length));
    await e.answer();
    if (entry !== undefined) {
      const [cid, slotStr] = entry.key.split(':');
      const t = targetForSlot(Number(cid), Number(slotStr));
      logMessage(t.key, 'user', entry.text);
      await enqueueTurn(t, entry.text, { visible: true });
    }
    return;
  }

  if (data.startsWith('ask:')) {
    const [, id, idxStr] = data.split(':');
    const result = id ? resolveAsk(id, Number(idxStr)) : null;
    await e.answer(result?.chosen ?? 'Expired');
    if (result?.messageId !== undefined) {
      await adapter.edit(
        { chatId, messageId: result.messageId },
        {
          text: `❓ <b>${escapeHtml(result.question)}</b>\n✅ ${escapeHtml(result.chosen)}`,
          format: 'tgHtml',
        },
      );
    }
    return;
  }

  // Concierge destructive-action confirmation (e.g. close a thread).
  if (data.startsWith('cfm:')) {
    const [, id, yes] = data.split(':');
    await e.answer();
    if (id && resolveConfirm(id, yes === '1') && e.messageId !== undefined) {
      await adapter.edit({ chatId, messageId: e.messageId }, { text: yes === '1' ? '✅ Confirmed.' : 'Cancelled.', format: 'plain' });
    }
    return;
  }

  if (data === 'noop') {
    await e.answer();
    return;
  }

  if (resolvePermission(data)) {
    await e.answer();
    return;
  }

  await e.answer('Expired');
}
