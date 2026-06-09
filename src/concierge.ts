import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { config } from './config.js';
import {
  createSession,
  getChatSettings,
  getMemo,
  getSession,
  getSharedMemory,
  listSessions,
  recentMessages,
  sessionKey,
  setAutoRoute,
  setMemo,
  setPinned,
  setSessionStatus,
  setSessionTitle,
  setSharedMemory,
} from './db.js';
import { escapeHtml } from './format.js';
import type { RunningView } from './sessions.js';

/**
 * The concierge — a control agent for the bot itself. It runs in the reserved
 * control thread (slot -1) with these bot-management tools instead of coding
 * tools, so the user can manage threads, settings, and shared memory by talking.
 *
 * Switching/creating a thread is DEFERRED to after the concierge's reply (see
 * pendingSwitch) so changing the active thread mid-turn doesn't suppress the
 * concierge's own output. Closing a thread is destructive, so it self-confirms
 * with an inline button regardless of what the model decides.
 */

/** Tool names the concierge is allowed to use (an allowlist for its session). */
export const CONCIERGE_TOOLS = [
  'mcp__bot__listThreads',
  'mcp__bot__readThread',
  'mcp__bot__dispatchTask',
  'mcp__bot__newThread',
  'mcp__bot__switchThread',
  'mcp__bot__setThreadMemo',
  'mcp__bot__closeThread',
  'mcp__bot__getSharedMemory',
  'mcp__bot__setSharedMemory',
  'mcp__bot__setRouting',
  'mcp__telegram__send',
  'mcp__telegram__ask',
  'mcp__telegram__askUserQuestion',
];

// A thread switch the concierge requested, applied by telegram.ts once its turn
// ends. Keyed by chat id.
const pendingSwitch = new Map<number, number>();
export function takePendingSwitch(chatId: number): number | undefined {
  const slot = pendingSwitch.get(chatId);
  pendingSwitch.delete(chatId);
  return slot;
}

// A task to seed into a thread as its first turn after the switch — the
// concierge delegating work to a worker thread, so the user never re-pastes.
const pendingSeed = new Map<number, { slot: number; text: string }>();
export function takePendingSeed(chatId: number): { slot: number; text: string } | undefined {
  const seed = pendingSeed.get(chatId);
  pendingSeed.delete(chatId);
  return seed;
}

// Fire-and-forget tasks: run on a worker headless while the user stays with the
// concierge (the "dispatch + detach" move). Applied by telegram.ts after the
// concierge's turn, without switching the active thread.
const pendingDispatch = new Map<number, Array<{ slot: number; text: string }>>();
export function takePendingDispatch(chatId: number): Array<{ slot: number; text: string }> {
  const list = pendingDispatch.get(chatId) ?? [];
  pendingDispatch.delete(chatId);
  return list;
}

// Destructive-action confirmations, resolved by an inline button tap.
const pendingConfirm = new Map<string, (yes: boolean) => void>();
let cseq = 0;
export function resolveConfirm(id: string, yes: boolean): boolean {
  const resolve = pendingConfirm.get(id);
  if (!resolve) return false;
  pendingConfirm.delete(id);
  resolve(yes);
  return true;
}

/** Build the live state block injected into the concierge's system prompt. */
export function conciergeSystemPrompt(chatId: number): string {
  const threads = listSessions(chatId, 'active');
  const closed = listSessions(chatId, 'closed');
  const settings = getChatSettings(chatId);
  const shared = getSharedMemory(chatId).trim();

  const threadLines = threads.length
    ? threads
        .map((t) => {
          const memo = getMemo(chatId, t.slot)?.summary;
          return `- slot ${t.slot}: ${t.title}${memo ? ` — ${memo}` : ''}`;
        })
        .join('\n')
    : '(none)';

  return `You are the concierge — the director and home base of a Telegram bot that runs several parallel Claude Code worker threads for one user. The user talks to YOU; you decide what reaches the workers. You are NOT a coding agent yourself — you only use the bot tools below. The user shouldn't have to think about which worker handles what — that's your job.

For each message, choose ONE of three moves:
1. HANDLE IT YOURSELF — questions about the bot, thread status (use readThread / listThreads), managing threads, or updating shared memory. Just answer.
2. DISPATCH + DETACH (dispatchTask) — hand a task to a worker that runs in the background while the user stays here with you. Use for fire-and-forget work, or when the user wants to keep talking to you rather than dive in. Give the worker the FULL task plus any context from other threads it would need. The user can ask you for its status later.
3. CONNECT THROUGH (switchThread / newThread with a task) — switch the user into a worker so they converse with it directly. Use for interactive, iterative work they'll want to watch.

Default: for substantial work the user will want to follow, CONNECT THROUGH; for quick or background tasks, DISPATCH. When unsure, ask with the ask tool. Before handing a worker new context, consider reading its current state (readThread) — if the new task doesn't fit or would derail it, prefer a fresh worker.

Be concise and action-oriented. Use a tool rather than just describing what you'd do — and don't ask permission for non-destructive actions like setting a memo or renaming; just do them (only closing a thread confirms, automatically).

Always refer to threads by their TITLE, never by slot number — slot numbers are internal and confuse the user. If the user names a thread ambiguously, confirm which title you mean before acting.

When the user describes hands-on work (writing/editing code, running a task), that belongs in a worker thread, not here. DELEGATE it: pick the right existing thread or create one with newThread, and pass the full task (with all the context the user gave you — links, decisions, constraints) plus a memo. The worker starts on the task automatically — never tell the user to paste a summary themselves.

CRITICAL: if your reply will switch the user to another thread, do NOT end it with a question that needs a follow-up message — they won't be in this thread to answer it. Decide and act, or ask first with the ask tool (which blocks for the answer) BEFORE switching. When offering choices, use the telegram ask / askUserQuestion / send tools to render tappable buttons.

You can see what each thread is about: a thread with a memo below already has a summary; for one without, call readThread(slot) to read its logged messages before you describe or rename it — do NOT guess from the name. When you work out what a thread is, call setThreadMemo(slot, title, summary) so the name and memo reflect reality (this also makes auto-routing accurate). If the user asks what their threads are about, read the ones that lack a memo and answer from their actual content.

Shared memory holds facts true across every thread (the user's preferences, defaults, ongoing context). When the user tells you something worth remembering, fold it into the shared memory via setSharedMemory (read it first, merge, write the whole thing back — keep it tidy and deduplicated).

Current state
- Working dir: ${config.workingDir}
- Auto-routing: ${settings.autoRoute ? 'on' : 'off'}${settings.pinned ? ' · pinned to active thread' : ''}
- Closed threads: ${closed.length}
Active threads:
${threadLines}
Shared memory:
${shared || '(empty)'}`;
}

/** Build the bot-management MCP server bound to the concierge's live view. */
export function buildConciergeServer(view: RunningView) {
  const { api, chatId } = view;

  const listThreads = tool(
    'listThreads',
    'List the active work threads with their titles and memos, plus the routing settings.',
    {},
    async () => {
      const threads = listSessions(chatId, 'active');
      const settings = getChatSettings(chatId);
      const body =
        threads.map((t) => `slot ${t.slot}: ${t.title} — ${getMemo(chatId, t.slot)?.summary ?? '(no memo)'}`).join('\n') ||
        '(no threads)';
      const text = `Auto-routing: ${settings.autoRoute ? 'on' : 'off'}${settings.pinned ? ', pinned' : ''}\n${body}`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const newThread = tool(
    'newThread',
    'Create a new work thread and switch to it after your reply. To delegate work, pass a memo (what it is about) and a task (the full instruction for the worker, with all context) — the worker starts on the task automatically, so the user never re-pastes anything.',
    {
      title: z.string().describe('Short thread title'),
      memo: z.string().optional().describe('1-2 line summary of what this thread is about'),
      task: z.string().optional().describe('Full first instruction to hand the worker, with all context'),
    },
    async (args) => {
      const slot = createSession(chatId, args.title.slice(0, 60));
      if (args.memo) setMemo(chatId, slot, args.title.slice(0, 60), args.memo);
      if (args.task) pendingSeed.set(chatId, { slot, text: args.task });
      pendingSwitch.set(chatId, slot);
      const tail = args.task ? ', switching there and starting the task' : ', switching after this reply';
      return { content: [{ type: 'text' as const, text: `Created "${args.title}" (slot ${slot})${tail}.` }] };
    },
  );

  const dispatchTask = tool(
    'dispatchTask',
    'DISPATCH + DETACH: hand a task to a worker that runs in the BACKGROUND while the user stays here with you — they are NOT switched into it. Use for fire-and-forget work, or when the user wants to keep talking to you. Give the full task with all context. Pass slot for an existing worker, or title to spin up a new one. The worker reports back when done; the user can ask you for its status anytime.',
    {
      slot: z.number().optional().describe('Existing worker slot (omit to create a new one)'),
      title: z.string().optional().describe('Title for a new worker (if no slot given)'),
      task: z.string().describe('Full instruction to hand the worker, with all context'),
      memo: z.string().optional().describe('1-2 line summary of what this worker is about'),
    },
    async (args) => {
      let slot: number;
      let label: string;
      if (args.slot !== undefined) {
        const s = getSession(chatId, args.slot);
        if (!s || s.status !== 'active') {
          return { content: [{ type: 'text' as const, text: `No active worker at slot ${args.slot}.` }], isError: true };
        }
        slot = args.slot;
        label = s.title;
        if (args.memo) setMemo(chatId, slot, s.title, args.memo);
      } else if (args.title) {
        slot = createSession(chatId, args.title.slice(0, 60));
        label = args.title;
        if (args.memo) setMemo(chatId, slot, args.title.slice(0, 60), args.memo);
      } else {
        return { content: [{ type: 'text' as const, text: 'Give a slot (existing worker) or a title (new worker).' }], isError: true };
      }
      const list = pendingDispatch.get(chatId) ?? [];
      list.push({ slot, text: args.task });
      pendingDispatch.set(chatId, list);
      return { content: [{ type: 'text' as const, text: `Dispatched to "${label}" — running in the background. Ask me for its status anytime.` }] };
    },
  );

  const switchThread = tool(
    'switchThread',
    'CONNECT THROUGH: switch the user into an existing thread after your reply so they talk to that worker directly. Optionally pass a task to hand it (with full context) so it starts without the user re-pasting. Use when the work is interactive and they will want to watch and iterate.',
    {
      slot: z.number().describe('Thread slot number'),
      task: z.string().optional().describe('Full instruction to hand the worker, with all context'),
    },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      if (args.task) pendingSeed.set(chatId, { slot: args.slot, text: args.task });
      pendingSwitch.set(chatId, args.slot);
      const tail = args.task ? ' and handing it the task' : '';
      return { content: [{ type: 'text' as const, text: `Will switch to "${s.title}"${tail} after this reply.` }] };
    },
  );

  const readThread = tool(
    'readThread',
    "Read the recent messages logged in a thread, so you can tell what it's actually about. Use this before describing or renaming a thread instead of guessing from its name.",
    { slot: z.number(), limit: z.number().optional().describe('How many recent messages (default 12)') },
    async (args) => {
      if (!getSession(chatId, args.slot)) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      const msgs = recentMessages(sessionKey(chatId, args.slot), Math.min(args.limit ?? 12, 30));
      if (msgs.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no messages logged in this thread yet)' }] };
      }
      const text = msgs
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const setThreadMemo = tool(
    'setThreadMemo',
    "Set a thread's title (its keyboard label) and optionally a memo (1-2 line summary of what it's about). Use after readThread so names/memos reflect reality; this also makes future auto-routing accurate.",
    { slot: z.number(), title: z.string(), summary: z.string().optional() },
    async (args) => {
      if (!getSession(chatId, args.slot)) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      if (args.summary) setMemo(chatId, args.slot, args.title.slice(0, 60), args.summary);
      else setSessionTitle(chatId, args.slot, args.title.slice(0, 60));
      return { content: [{ type: 'text' as const, text: `Updated slot ${args.slot} → "${args.title}".` }] };
    },
  );

  const closeThread = tool(
    'closeThread',
    'Close (archive) a thread. Asks the user to confirm first; reopenable via /history.',
    { slot: z.number() },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      const id = (++cseq).toString(36);
      const kb = new InlineKeyboard().text('✅ Close', `cfm:${id}:1`).text('Cancel', `cfm:${id}:0`);
      await api.sendMessage(chatId, `⚠️ Close <b>${escapeHtml(s.title)}</b>?`, { parse_mode: 'HTML', reply_markup: kb });
      const yes = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pendingConfirm.delete(id);
          resolve(false);
        }, 2 * 60 * 1000);
        pendingConfirm.set(id, (v) => {
          clearTimeout(timeout);
          resolve(v);
        });
      });
      if (!yes) return { content: [{ type: 'text' as const, text: `Kept "${s.title}".` }] };
      setSessionStatus(chatId, args.slot, 'closed');
      return { content: [{ type: 'text' as const, text: `Closed "${s.title}".` }] };
    },
  );

  const getShared = tool(
    'getSharedMemory',
    'Read the bot-wide shared memory.',
    {},
    async () => ({ content: [{ type: 'text' as const, text: getSharedMemory(chatId) || '(empty)' }] }),
  );

  const setShared = tool(
    'setSharedMemory',
    'Replace the bot-wide shared memory with new content (read it first and merge).',
    { content: z.string() },
    async (args) => {
      setSharedMemory(chatId, args.content);
      return { content: [{ type: 'text' as const, text: 'Shared memory updated.' }] };
    },
  );

  const setRouting = tool(
    'setRouting',
    'Toggle auto-routing on/off, or pin/unpin messages to the active thread.',
    { autoRoute: z.boolean().optional(), pinned: z.boolean().optional() },
    async (args) => {
      if (args.autoRoute !== undefined) setAutoRoute(chatId, args.autoRoute);
      if (args.pinned !== undefined) setPinned(chatId, args.pinned);
      const s = getChatSettings(chatId);
      return {
        content: [{ type: 'text' as const, text: `Auto-routing ${s.autoRoute ? 'on' : 'off'}${s.pinned ? ', pinned' : ''}.` }],
      };
    },
  );

  return createSdkMcpServer({
    name: 'bot',
    version: '1.0.0',
    instructions: 'Tools to manage the bot: threads, routing, and shared memory.',
    tools: [listThreads, readThread, dispatchTask, newThread, switchThread, setThreadMemo, closeThread, getShared, setShared, setRouting],
  });
}
