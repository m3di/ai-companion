import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bumpRetrieval, getCard, latestContextInfo, listSessions, sessionKey, storedSessionId } from './db.js';

/**
 * Traces — the read side of "work leaves traces". A worker session's FULL
 * record (every prompt, tool call, and tool result) is a local JSONL
 * transcript under ~/.claude/projects/<project-slug>/<session-id>.jsonl, with
 * no expiry. The retrieval ladder for past detail, cheap → expensive:
 * note conclusion → thread recap/memo → searchMessages (SQL) → code/git →
 * Read/Grep the transcript → (last resort, judgment-only) resume the worker.
 * Reading a transcript costs nothing and never touches the live session —
 * which is why "ask the agent" is the wrong primitive for fact retrieval.
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Locate a session's transcript file by scanning the projects dir (the
 *  project slug depends on the session's cwd, so search rather than derive). */
export function transcriptPath(sessionId: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface ThreadTrace {
  slot: number;
  title: string;
  brief?: string;
  recap?: string;
  sessionId?: string;
  transcript?: string;
  /** e.g. "3% of 1000000" — how full the live context is (compaction risk). */
  contextUse?: string;
}

/** Resolve threads matching a title fragment (or all, if empty) to their
 *  traces: brief/recap + session id + transcript path + context fullness. */
export function locateThreadTraces(chatId: number, titleQuery: string): ThreadTrace[] {
  const q = titleQuery.trim().toLowerCase();
  return listSessions(chatId, 'active')
    .filter((t) => !q || t.title.toLowerCase().includes(q))
    .map((t) => {
      // Attention data for the operator — only targeted lookups count (an
      // empty query lists everything and says nothing about interest).
      if (q) bumpRetrieval('trace', t.title);
      const key = sessionKey(chatId, t.slot);
      const c = getCard(chatId, t.slot);
      const sessionId = storedSessionId(key);
      const ctx = latestContextInfo(key);
      return {
        slot: t.slot,
        title: t.title,
        brief: c?.brief,
        recap: c?.recap,
        sessionId,
        transcript: sessionId ? transcriptPath(sessionId) : undefined,
        contextUse: ctx && ctx.window ? `${Math.round((ctx.tokens / ctx.window) * 100)}% of ${ctx.window}` : undefined,
      };
    });
}

/** Render traces for a tool result. */
export function renderTraces(traces: ThreadTrace[]): string {
  if (!traces.length) return '(no matching active threads)';
  return traces
    .map((t) => {
      const lines = [
        `slot ${t.slot}: ${t.title}`,
        t.brief ? `  brief: ${t.brief.replace(/\s+/g, ' ').slice(0, 200)}` : '',
        t.recap ? `  recap: ${t.recap}` : '',
        t.transcript
          ? `  transcript (full trace incl. tool calls — Read/Grep it, do NOT resume the session for facts): ${t.transcript}`
          : '  transcript: (none yet)',
        t.contextUse ? `  live context: ${t.contextUse}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n');
}
