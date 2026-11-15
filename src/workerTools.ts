import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { addCommitment, getMessageById, postEvent, searchChatMessages } from './db.js';
import { locateThreadTraces, renderTraces } from './traces.js';
import { findWork, resumeHint } from './discovery.js';
import { fmtLocal, parseLocalWhen, toUtcDb } from './commitments.js';
import { startWatch } from './watch.js';

/** The worker's whole bot-facing surface, by name — asserted in the tests, so
 *  a tool sliding back in has to be a deliberate act rather than an import. */
export const WORKER_TOOL_NAMES = [
  'reportBlocked',
  'watchRun',
  'searchMessages',
  'readMessage',
  'locateThreadTrace',
  'findPastWork',
  'shouldResume',
] as const satisfies readonly string[];

/**
 * The bot-facing toolset a WORKER carries — deliberately the smallest one in
 * the system (the concierge has its own, rich server).
 *
 * A worker used to reach into the shared brain from the middle of a task: write
 * the focus set (trackOpenLoop), escalate against it (noticeFocusChange), append
 * to the knowledge tree (noteIdea), and feed the entity graph (observe, the
 * module tools). Every one of those made the worker a second writer of a store
 * the night is supposed to own, and each needed the corresponding store injected
 * into the worker's system prompt so it could name what it was writing to — the
 * mutating context that made a resumed worker turn cost dollars to say nothing.
 *
 * So the worker is now execute-and-report. It waits on external runs, it says
 * when it is blocked, and it can dig up past work rather than re-derive it. What
 * its work leaves OPEN goes in its final answer as prose; the concierge reads
 * the completion and is the one that records it. One writer, one door.
 */
export function buildWorkerServer(chatId: number, slot: number) {
  const reportBlocked = tool(
    'reportBlocked',
    'Record that this work is BLOCKED/waiting on a person, event, or time — so the system re-checks it later instead of the user having to remember. Say concretely how to check whether it unblocked (a command, a query, "ask the user").',
    {
      what: z.string().describe('What is waiting, in one line (include ids/links)'),
      blockedOn: z.string().describe('Who/what it waits for, e.g. "alizshow review on PR #73"'),
      howToCheck: z.string().describe('How a future check can tell it unblocked, e.g. "gh pr view 73 --json reviews"'),
      nextCheck: z.string().optional().describe('When to first re-check, local: "+4h", "HH:mm", "YYYY-MM-DD HH:mm". Default tomorrow morning.'),
    },
    async ({ what, blockedOn, howToCheck, nextCheck }) => {
      const at = (nextCheck ? parseLocalWhen(nextCheck) : undefined) ?? parseLocalWhen('09:00') ?? new Date(Date.now() + 86_400_000);
      // Blocked work IS an open loop the user touched, so it enters the focus
      // set — at a quiet band, because a worker is not the one who decides how
      // loud something should be. The concierge re-tiers it when it judges the
      // set; leaving it out entirely is how work used to vanish into the ledger.
      const id = addCommitment(chatId, what.slice(0, 40), `${what}\nblocked on: ${blockedOn}`, toUtcDb(at), {
        howToCheck,
        threadSlot: slot,
        createdBy: 'worker',
        focus: 3,
        focusBand: 'waiting on someone',
      });
      postEvent(chatId, 'commitment', `blocked: ${what} (on ${blockedOn})`);
      return {
        content: [{ type: 'text' as const, text: `Recorded watched commitment #${id}; first re-check ~${fmtLocal(toUtcDb(at))} local.` }],
      };
    },
  );

  const watchRun = tool(
    'watchRun',
    'Wait on an external CI / deploy / e2e run WITHOUT holding your turn open. Launch a blocking `gh` watch command here; then END YOUR TURN. The system keeps the run alive across turns and session limits and re-invokes you the instant it finishes, with the pass/fail verdict and output tail. This is the ONLY reliable way to wait — a foreground watch in your own turn is lost when the turn or session ends. Use for `gh run watch <id> --exit-status` or `gh pr checks <pr> --watch --fail-fast`.',
    {
      command: z.string().describe('The `gh` watch command to run to completion, e.g. "gh pr checks 3181 --repo acme/core-api --watch --fail-fast"'),
      label: z.string().describe('One line naming what you are waiting on (a PR/run + what you will do next), shown when you are re-invoked'),
    },
    async ({ command, label }) => {
      const r = startWatch(chatId, slot, command, label);
      if (!r.ok) {
        return { content: [{ type: 'text' as const, text: r.reason ?? 'Could not start the watch.' }], isError: true };
      }
      postEvent(chatId, 'watch', `watching: ${label}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Watch #${r.id} started for: ${label}. END YOUR TURN now — do not keep waiting or polling here. You will be re-invoked automatically when it finishes.`,
          },
        ],
      };
    },
  );

  const searchMessagesTool = tool(
    'searchMessages',
    'Search the FULL chat history across every thread (free, SQL + full-text; ranked, stemmed, any-word matching). Use when past work is referenced that your own context does not hold — before guessing or re-deriving. Results are truncated and carry a #id — readMessage(id) for the whole message.',
    {
      term: z.string().describe('Words to search for (a PR number, a filename, a person, a phrase). Multi-word is fine — matching is per-word, not one literal string.'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
    async ({ term, limit }) => {
      const rows = searchChatMessages(chatId, term, Math.min(limit ?? 20, 50)).map((m) => {
        const flat = m.content.replace(/\s+/g, ' ');
        const shown = flat.slice(0, 200);
        const more = flat.length > 200 ? ` …[+${flat.length - 200} chars — readMessage(${m.id})]` : '';
        return `#${m.id} [${m.session_key}] ${m.role} @ ${m.created_at}: ${shown}${more}`;
      });
      return { content: [{ type: 'text' as const, text: rows.join('\n') || `(no messages matching "${term}")` }] };
    },
  );

  const readMessageTool = tool(
    'readMessage',
    'Read ONE logged message in FULL by its #id, untruncated — the way out of any excerpt that got cut. A long paste (a document, a spec, a stack trace) only ever shows its first few hundred characters in a search result.',
    { id: z.number().describe('The message id, e.g. 1234 from "#1234" in a search result') },
    async ({ id }) => {
      const m = getMessageById(chatId, id);
      if (!m) return { content: [{ type: 'text' as const, text: `No message #${id} in this chat.` }] };
      return {
        content: [
          { type: 'text' as const, text: `#${m.id} [${m.session_key}] ${m.role} @ ${m.created_at} (${m.content.length} chars)\n\n${m.content}` },
        ],
      };
    },
  );

  const locateThreadTrace = tool(
    'locateThreadTrace',
    'Resolve another thread (by title fragment; empty = all) to its traces: memo, latest recap, and the path of its FULL session transcript (a local JSONL with every tool call and result). Read/Grep that file for deep detail — never resume a session just to retrieve facts.',
    { title: z.string().describe('Thread title fragment, or "" for all threads') },
    async ({ title }) => ({
      content: [{ type: 'text' as const, text: renderTraces(locateThreadTraces(chatId, title)) }],
    }),
  );

  const findPastWork = tool(
    'findPastWork',
    'Search EVERYTHING the system has seen for work like this: the user\'s own local terminal sessions AND the bot\'s past threads. Use it before re-deriving anything — "have we hit this error / touched this file / solved this before?". Returns where it happened, when, and how to reach the full record.',
    {
      query: z.string().describe('Phrase to look for — an error string, a file, a task id, a feature name. All words must appear; hyphens are ignored.'),
    },
    async ({ query }) => {
      const { hits, scannedTranscripts } = findWork(chatId, query, 8);
      if (!hits.length) {
        return { content: [{ type: 'text' as const, text: `Nothing found for "${query}"${scannedTranscripts ? ' (searched summaries, threads and raw transcripts)' : ''}.` }] };
      }
      const lines = hits.map((h) => {
        const where =
          h.source === 'thread'
            ? `bot ${h.project}`
            : `${h.project}${h.episodeId ? ` · episode #${h.episodeId}` : ''}`;
        const how =
          h.source === 'thread'
            ? h.messageId
              ? `full message: readMessage(${h.messageId})`
              : 'searchMessages for more of this thread'
            : `full record: locateThreadTrace, or the transcript for session ${h.sessionId}`;
        return `- [${h.source}${h.partial ? ' · partial match' : ''}] ${h.when} ${where}\n    ${h.context}\n    ${how}`;
      });
      return { content: [{ type: 'text' as const, text: `Found ${hits.length} for "${query}":\n${lines.join('\n')}` }] };
    },
  );

  const shouldResume = tool(
    'shouldResume',
    'Given a local session id (from findPastWork), say whether resuming it is worth it or whether reading its transcript is better. Measured from the session\'s own recorded context size, not guessed.',
    { sessionId: z.string() },
    async ({ sessionId }) => {
      const h = resumeHint(sessionId);
      return { content: [{ type: 'text' as const, text: h.found ? `${h.contextTokens.toLocaleString()} tokens of context, last active ${h.lastActive}. ${h.verdict}` : h.verdict }] };
    },
  );

  const tools = [reportBlocked, watchRun, searchMessagesTool, readMessageTool, locateThreadTrace, findPastWork, shouldResume];
  // The exported name list is what the tests assert against, so it must not
  // drift from what is actually handed to the worker.
  const built = tools.map((t) => t.name);
  if (built.join(',') !== WORKER_TOOL_NAMES.join(',')) {
    throw new Error(`worker tools drifted from WORKER_TOOL_NAMES: built [${built}], listed [${WORKER_TOOL_NAMES}]`);
  }

  return createSdkMcpServer({
    // Never deferred behind tool search — see buildConciergeServer (2026-08-27).
    alwaysLoad: true,
    name: 'bot',
    version: '1.0.0',
    instructions:
      'A worker\'s only side-channels: wait on an external run, report what blocked you, and dig up past work. ' +
      'You cannot read or write the system\'s memory — no notes, no entity graph, no focus set. ' +
      'Everything your task needs is in your brief; anything your work leaves open goes in your final answer, and the concierge records it.',
    tools,
  });
}

