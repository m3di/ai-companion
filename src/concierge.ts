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
  setAutoRoute,
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
  'mcp__bot__newThread',
  'mcp__bot__switchThread',
  'mcp__bot__renameThread',
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

  return `You are the concierge for a Telegram bot that runs several parallel Claude Code threads for one user. You help them manage their threads and the bot's shared memory, and answer questions about the bot's state. You are NOT a coding agent — you only use the bot tools below.

Be concise and action-oriented. When asked to do something, use a tool rather than just describing it. Switching to or creating a thread takes effect right after your reply (tell the user). Closing a thread is confirmed with the user automatically by the tool. When offering the user choices or next steps, use the telegram ask / askUserQuestion / send tools to render tappable buttons.

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
    'Create a new work thread. It becomes active right after your reply.',
    { title: z.string().describe('Short thread title') },
    async (args) => {
      const slot = createSession(chatId, args.title.slice(0, 60));
      pendingSwitch.set(chatId, slot);
      return { content: [{ type: 'text' as const, text: `Created "${args.title}" (slot ${slot}). Switching after this reply.` }] };
    },
  );

  const switchThread = tool(
    'switchThread',
    'Switch the user to an existing thread. Takes effect right after your reply.',
    { slot: z.number().describe('Thread slot number') },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      pendingSwitch.set(chatId, args.slot);
      return { content: [{ type: 'text' as const, text: `Will switch to "${s.title}" after this reply.` }] };
    },
  );

  const renameThread = tool(
    'renameThread',
    "Rename a thread (changes its keyboard button label).",
    { slot: z.number(), title: z.string() },
    async (args) => {
      if (!getSession(chatId, args.slot)) {
        return { content: [{ type: 'text' as const, text: `No thread at slot ${args.slot}.` }], isError: true };
      }
      setSessionTitle(chatId, args.slot, args.title.slice(0, 60));
      return { content: [{ type: 'text' as const, text: `Renamed slot ${args.slot} to "${args.title}".` }] };
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
    tools: [listThreads, newThread, switchThread, renameThread, closeThread, getShared, setShared, setRouting],
  });
}
