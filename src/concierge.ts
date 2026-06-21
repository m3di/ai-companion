import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from './config.js';
import {
  createSession,
  getMemo,
  getSession,
  getSharedMemory,
  listSessions,
  markTitleExplicit,
  recentMessages,
  sessionKey,
  setMemo,
  setMode,
  setSessionStatus,
  setSessionTitle,
  setSharedMemory,
} from './db.js';
import { deleteNote, getNote, listNotes, upsertNote } from './knowledge.js';
import { digestFile } from './digest.js';
import { escapeHtml } from './format.js';
import { workspaceManifest } from './workspace.js';
import { clearPendingApprovals } from './permissions.js';
import type { RunningView } from './sessions.js';

/** Truncate to n chars with an explicit marker, so the model knows it was cut. */
function capAt(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[truncated ${s.length - n} chars]` : s;
}

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
  'mcp__bot__setThreadMode',
  'mcp__bot__closeThread',
  'mcp__bot__getSharedMemory',
  'mcp__bot__setSharedMemory',
  'mcp__bot__digestSource',
  'mcp__bot__readNote',
  'mcp__bot__writeNote',
  'mcp__bot__deleteNote',
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
  const shared = getSharedMemory(chatId).trim();
  const repos = workspaceManifest();
  const routingLine =
    '- Routing: reply-based — every plain message reaches YOU (home base); the user addresses a worker by replying to one of its messages';
  const notes = listNotes();
  const notesIndex = notes.length
    ? notes.map((n) => `- ${n.key}: ${n.summary}`).join('\n')
    : '(empty — digest a source or write notes to build it)';

  const threadLines = threads.length
    ? threads
        .map((t) => {
          const m = getMemo(chatId, t.slot);
          // Prefer the auto recap (latest worker state) over the curated memo;
          // truncate here — readThread for the rest.
          const status = m?.recap ?? m?.summary;
          const short = status ? ` — ${status.length > 140 ? `${status.slice(0, 140)}…` : status}` : '';
          return `- slot ${t.slot}: ${t.title}${short}`;
        })
        .join('\n')
    : '(none)';

  return `You are the concierge — the director and home base of a Telegram bot that runs several parallel Claude Code worker threads for one user. The user talks to YOU; you decide what reaches the workers. You are NOT a coding agent yourself — you only use the bot tools below. The user shouldn't have to think about which worker handles what — that's your job.

How the user reaches threads: the user ALWAYS talks to you — there is no "active thread" and no switching. Every plain message comes to YOU. To address a worker directly, the user REPLIES to one of that worker's messages (a one-off direct line); their next plain message is back with you. So a message landing here just means they didn't reply to a worker.

Two more things the user can do: (1) /capture — collect notes, forwards, and replies through the day; they queue silently and run nothing. (2) /process — hand you everything captured at once; you receive it as a [PROCESS BATCH] (handled below). If the user is firehosing many separate notes at you and asking you to sort them later, point them at /capture + /process.

For each message, choose ONE of these moves:
1. HANDLE IT YOURSELF — questions about the bot, thread status (use readThread / listThreads), managing threads, or updating shared memory. Just answer.
2. DISPATCH (dispatchTask) — hand a task to a worker that runs in the BACKGROUND. Use for fire-and-forget work, or when the user doesn't need to watch. Give the worker the FULL task plus any context from other threads it would need. It reports back to you when done; the user can ask you for its status anytime.
3. DELEGATE & SHOW (newThread / switchThread with a task) — hand a worker a task and let its work STREAM into the chat so the user can watch and continue by REPLYING to it. Use for interactive, iterative work they'll want to follow. The user is NOT moved anywhere — they stay with you, and the worker's output simply appears (tagged with its title).

Default: for substantial work the user will want to follow, DELEGATE & SHOW; for quick or background tasks, DISPATCH. When unsure, ask with the ask tool. Before handing a worker new context, consider reading its current state (readThread) — if the new task doesn't fit or would derail it, prefer a fresh worker.

When a message begins with [PROCESS BATCH], it is a batch of fragments the user captured through the day and wants triaged in one go. Cluster related ones, then present a short fan-out PLAN — fragment(s) → destination (an existing thread by title / a new thread / shared memory / a note) — with a tappable confirm BEFORE acting. Once confirmed, fan out: dispatchTask can be called several times in one turn to seed multiple threads at once; update memos and fold standing facts into shared memory/notes. Flag ambiguous fragments and park anything that needs the user's input rather than guessing.

Permission modes: a DISPATCHED worker is set to "auto" automatically — it runs tools without stopping for approval, since the user isn't watching it. If a worker is stuck asking permission for every command (the user will say things like "it's not in auto mode" / "put it in auto"), use setThreadMode(slot, "auto") — it takes effect immediately, even mid-run, and unsticks it. Use "default" only when the user wants to approve each step.

Be concise and action-oriented. Use a tool rather than just describing what you'd do — and don't ask permission for non-destructive actions like setting a memo or renaming; just do them (only closing a thread confirms, automatically).

Always refer to threads by their TITLE, never by slot number — slot numbers are internal and confuse the user. If the user names a thread ambiguously, confirm which title you mean before acting.

When the user describes hands-on work (writing/editing code, running a task), that belongs in a worker thread, not here. DELEGATE it: pick the right existing thread or create one with newThread, and pass the full task (with all the context the user gave you — links, decisions, constraints) plus a memo. The worker starts on the task automatically — never tell the user to paste a summary themselves.

The user's projects are cloned locally (see "Workspace repos" below). Workers operate on them with LOCAL git per repo (git checkout / pull), following each repo's own CLAUDE.md / AGENTS.md conventions; they avoid git worktrees unless strictly necessary, and prefer the GitHub API (gh) for read-only lookups over cloning/checkout. When you dispatch repo work, name the repo and its path so the worker starts in the right place.

When offering choices, use the telegram ask / askUserQuestion / send tools to render tappable buttons. The user always stays here with you, so ending on a question is fine — they'll answer in their next message.

The thread list below is an INDEX — each line is a thread's title plus its latest auto-recap (a one-line snapshot of the worker's most recent output) or, if none yet, its curated memo. The recap auto-refreshes after every worker turn, so it's current — good enough to answer "what's X doing?" without re-reading. But it's a snapshot, not full history: when you need detail — before changing its status/memo, closing it, or acting on it — call readThread(slot) to read its recent activity. Don't rely on a stale memo or the user's passing remark; they often mention one slice while the thread is mid-flight on more. Keep memos current via setThreadMemo so this index stays trustworthy. For a thread with no memo, readThread before describing/renaming it.

Shared memory is injected into EVERY worker turn, so keep it SMALL — only standing facts/preferences that genuinely apply everywhere (e.g. "wants clickable links", "prefers terse replies"). It is not a scratchpad. Detailed or per-topic knowledge belongs in NOTES (indexed, read on demand), not here. When the user tells you a standing preference, fold it in via setSharedMemory (read first, merge, dedupe, keep it short).

You also have a KNOWLEDGE BASE of notes — compact, linked units the index below lets you skim, reading full content with readNote(key) only when needed. To onboard a document into it, use digestSource(path). Capture or correct a unit with writeNote(key, summary, content) — keep notes tight and self-contained, linking related ones inline as [[their-key]]. Prune obsolete ones with deleteNote. Shared memory = small always-on facts; notes = the deeper, browsable map.

Current state
- Working dir: ${config.workingDir}
${routingLine}
- Closed threads: ${closed.length}
Workspace repos (local clones — workers use local git here):
${repos || '(none registered — the user can run /repos scan)'}
Active threads:
${threadLines}
Shared memory:
${shared || '(empty)'}
Knowledge notes (index — read full content with readNote(key)):
${notesIndex}`;
}

/** Build the bot-management MCP server bound to the concierge's live view. */
export function buildConciergeServer(view: RunningView) {
  const { chatId } = view;

  const listThreads = tool(
    'listThreads',
    'List the active work threads with their titles and memos, plus the routing settings.',
    {},
    async () => {
      const threads = listSessions(chatId, 'active');
      const body =
        threads.map((t) => `slot ${t.slot}: ${t.title} — ${getMemo(chatId, t.slot)?.summary ?? '(no memo)'}`).join('\n') ||
        '(no threads)';
      const text = `Routing: reply-based (the user replies to a worker's message to address it)\n${body}`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const newThread = tool(
    'newThread',
    'Create a new work thread and DELEGATE & SHOW: hand it a task whose work streams into the chat for the user to watch. Pass a memo (what it is about) and a task (the full instruction, with all context) — the worker starts automatically, so the user never re-pastes. The user is not moved; the worker output appears tagged with its title and they continue by replying to it.',
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
      const tail = args.task ? ', starting the task — its work will stream into the chat' : ' (no task yet)';
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
      // Dispatched = unattended, so it must run autonomously or it would stall
      // on permission prompts the user isn't here to answer.
      setMode(sessionKey(chatId, slot), 'auto');
      const list = pendingDispatch.get(chatId) ?? [];
      list.push({ slot, text: args.task });
      pendingDispatch.set(chatId, list);
      return { content: [{ type: 'text' as const, text: `Dispatched to "${label}" (auto mode) — running in the background. Ask me for its status anytime.` }] };
    },
  );

  const setThreadMode = tool(
    'setThreadMode',
    'Set a worker thread\'s permission mode: "auto" (runs tools autonomously without asking — use for background/unattended work), "acceptEdits" (auto-accepts file edits, asks before commands), or "default" (asks before each tool). Takes effect immediately, even on a turn already running.',
    { slot: z.number(), mode: z.enum(['auto', 'acceptEdits', 'default']) },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active worker at slot ${args.slot}.` }], isError: true };
      }
      setMode(sessionKey(chatId, args.slot), args.mode);
      // If it was stuck waiting on a permission, auto is the user's answer.
      if (args.mode === 'auto') clearPendingApprovals(sessionKey(chatId, args.slot));
      return { content: [{ type: 'text' as const, text: `Set "${s.title}" to ${args.mode} mode.` }] };
    },
  );

  const switchThread = tool(
    'switchThread',
    'DELEGATE & SHOW on an EXISTING worker: hand it a task whose work streams into the chat for the user to watch (they continue by replying to it). Pass the full task with all context so it starts without the user re-pasting. The user is not moved anywhere.',
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
      const tail = args.task ? ', its work will stream into the chat' : ' (no task given — nothing to run)';
      return { content: [{ type: 'text' as const, text: `Showing "${s.title}"${tail}.` }] };
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
      // The findings live at the END of a report, so don't blanket-cap: the most
      // recent message (the report) stays generous; older context lines trim.
      const last = msgs.length - 1;
      const text = msgs
        .map((m, i) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${capAt(m.content, i === last ? 4000 : 500)}`)
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
      else {
        setSessionTitle(chatId, args.slot, args.title.slice(0, 60));
        markTitleExplicit(chatId, args.slot);
      }
      return { content: [{ type: 'text' as const, text: `Updated slot ${args.slot} → "${args.title}".` }] };
    },
  );

  const closeThread = tool(
    'closeThread',
    'Close (archive) a thread. Asks the user to confirm first.',
    { slot: z.number() },
    async (args) => {
      const s = getSession(chatId, args.slot);
      if (!s || s.status !== 'active') {
        return { content: [{ type: 'text' as const, text: `No active thread at slot ${args.slot}.` }], isError: true };
      }
      const id = (++cseq).toString(36);
      await view.transport.send(chatId, {
        text: `⚠️ Close <b>${escapeHtml(s.title)}</b>?`,
        format: 'tgHtml',
        buttons: [
          [
            { text: '✅ Close', data: `cfm:${id}:1` },
            { text: 'Cancel', data: `cfm:${id}:0` },
          ],
        ],
      });
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

  const digestSource = tool(
    'digestSource',
    'Read a file and digest it into the knowledge base as compact note units (merging with existing notes). Use to onboard a document (e.g. a knowledge map) into memory so it can be skimmed efficiently later.',
    { path: z.string().describe('Absolute path to the file to digest'), instructions: z.string().optional().describe('Optional: how to focus the digest') },
    async (args) => {
      const res = await digestFile(chatId, args.path, args.instructions);
      if (res.error) return { content: [{ type: 'text' as const, text: `Digest failed: ${res.error}` }], isError: true };
      return { content: [{ type: 'text' as const, text: `Digested into ${res.keys.length} notes: ${res.keys.join(', ')}` }] };
    },
  );

  const readNote = tool(
    'readNote',
    'Read the full content of a knowledge note by key (the index of keys + summaries is in your context).',
    { key: z.string() },
    async (args) => {
      const n = getNote(args.key);
      return { content: [{ type: 'text' as const, text: n ? n.content : `No note "${args.key}".` }] };
    },
  );

  const writeNote = tool(
    'writeNote',
    'Create or update a knowledge note (compact, self-contained; reference related notes inline as [[their-key]]). Use to capture or correct a unit of knowledge.',
    { key: z.string().describe('Short kebab-case slug'), summary: z.string().describe('<=12 word index line'), content: z.string() },
    async (args) => {
      upsertNote(args.key.slice(0, 60), args.summary.slice(0, 120), args.content);
      return { content: [{ type: 'text' as const, text: `Saved note "${args.key}".` }] };
    },
  );

  const removeNote = tool(
    'deleteNote',
    'Delete a knowledge note by key (e.g. it is obsolete or merged into another).',
    { key: z.string() },
    async (args) => {
      deleteNote(args.key);
      return { content: [{ type: 'text' as const, text: `Deleted note "${args.key}".` }] };
    },
  );

  return createSdkMcpServer({
    name: 'bot',
    version: '1.0.0',
    instructions: 'Tools to manage the bot: threads, routing, shared memory, and the knowledge base.',
    tools: [
      listThreads, readThread, dispatchTask, newThread, switchThread, setThreadMemo, setThreadMode, closeThread,
      getShared, setShared,
      digestSource, readNote, writeNote, removeNote,
    ],
  });
}
