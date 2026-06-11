import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Api } from 'grammy';
import { config } from './config.js';
import {
  chatTimeline,
  getMemo,
  getSession,
  getSharedMemory,
  listSessions,
  recentCorrections,
} from './db.js';
import { chunkRaw, toTelegramMarkdown } from './format.js';

/**
 * "Dreaming" — an offline self-reflection pass. While the user is away, the bot
 * reviews recent interactions, its memory, and its own code, and proposes how to
 * improve. In this DRY-RUN form it runs with read-only tools only (it physically
 * cannot edit, run commands, or push) and just reports what it WOULD do. Act-mode
 * (committing, restarting into new code) comes later, once the reports look good.
 */

const DREAM_SYSTEM = `You are this Telegram bot, dreaming. While the user sleeps you reflect on the day to make the whole system of interaction better. You are in DRY-RUN: you only PROPOSE — you have read-only tools and must not (and cannot) change anything.

Review the digest, the bot's memory, and — where a concrete code improvement seems worth proposing — its own TypeScript source in ./src. The digest's conversation timeline is CHRONOLOGICAL (interleaved across threads, the way the user actually experienced it, with a [thread] tag showing where each message was routed) — read it that way to see real behaviour: how the user jumps topics, where routing/handoffs were smooth vs clumsy, where the bot was inefficient or made them repeat themselves. Reflect across these lenses:
- Memory hygiene: memos or shared-memory facts that are stale, wrong, duplicated, contradictory, or missing.
- Interaction & routing: friction in the timeline — misroutes, repeats, clumsy handoffs, the user fighting the bot.
- Code / UX: specific, small changes to the bot's code that would reduce that friction (name the file and the change).
- Mornings & priorities: anything the user should be reminded of, or work that should be reprioritized.

Output a concise, scannable report: what you noticed and the specific action you'd take for each, ranked by impact (highest first). Be concrete and honest — if the day was quiet and nothing needs doing, say so briefly. Do NOT pad. Make no changes.

Output ONLY the report content — no preamble about your process, and no title/header line (a "Dream report" header is added for you). Start straight with the highest-impact item.`;

/** A compact digest of recent activity for the dreaming agent. */
function buildDigest(chatId: number): string {
  const shared = getSharedMemory(chatId).trim() || '(empty)';

  const threads = listSessions(chatId, 'active');
  const threadIndex =
    threads.map((t) => `- ${t.title}${getMemo(chatId, t.slot)?.summary ? ` — ${getMemo(chatId, t.slot)!.summary}` : ''}`).join('\n') ||
    '(none)';

  const titleFor = (key: string): string => {
    const slot = Number(key.split(':')[1]);
    if (slot === -1) return 'Concierge';
    return getSession(chatId, slot)?.title ?? `thread ${slot}`;
  };
  // Interleaved, time-ordered — how the user actually experienced it. The
  // [thread] tag shows where the concierge routed each message.
  const timeline = chatTimeline(chatId, 180)
    .map((m) => `[${titleFor(m.session_key)}] ${m.role === 'user' ? 'You' : 'Bot'}: ${m.content.replace(/\s+/g, ' ').slice(0, 260)}`)
    .join('\n');

  const corrections =
    recentCorrections(chatId, 12)
      .map((c) => `- "${c.message}" belonged to ${c.title}, not ${c.wrong_title}`)
      .join('\n') || '(none)';

  return `## Shared memory\n${shared}\n\n## Threads (for reference)\n${threadIndex}\n\n## Routing corrections (auto-routing mistakes)\n${corrections}\n\n## Conversation timeline — chronological, the way the user actually experienced it; [thread] = where each message was routed\n${timeline}`;
}

/** Run a dry-run dreaming pass and post the report to the chat. Read-only. */
export async function runDream(api: Api, chatId: number): Promise<void> {
  const digest = buildDigest(chatId);
  const prompt = `Digest of recent activity:\n\n${digest}\n\nThe bot's own TypeScript source is in ./src and its SQLite database is at data/companion.db (binary — use the digest above for data; read the code for code proposals). You have read-only tools (Read/Grep/Glob). Produce your dream report now.`;

  let report = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        cwd: process.cwd(),
        systemPrompt: DREAM_SYSTEM,
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'AskUserQuestion'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        ...(config.model ? { model: config.model } : {}),
      },
    }) as AsyncIterable<any>) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) report += b.text;
        }
      }
    }
  } catch (e) {
    report = `(dream failed: ${e instanceof Error ? e.message : String(e)})`;
  }

  await api
    .sendMessage(chatId, '🌙 <b>Dream report</b> — reflections on recent activity (dry-run, nothing changed):', {
      parse_mode: 'HTML',
    })
    .catch(() => {});
  for (const piece of chunkRaw(report.trim() || '(the dream produced nothing)')) {
    await api
      .sendMessage(chatId, toTelegramMarkdown(piece), { parse_mode: 'MarkdownV2' })
      .catch(() => api.sendMessage(chatId, piece).catch(() => {}));
  }
}
