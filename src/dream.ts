import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { extractUsage } from './claude.js';
import type { ChatTransport } from './transport/types.js';
import {
  chatTimelineBetween,
  dbNow,
  getMemo,
  getSession,
  getSharedMemory,
  lastDreamCoveredTo,
  listSessions,
  recentCorrections,
  saveDream,
  saveUsage,
} from './db.js';
import { chunkRaw, stripLoneSurrogates, toTelegramMarkdown } from './format.js';

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

/**
 * A compact digest of the activity within a window (from, to]. Shared memory,
 * the thread index, and routing corrections are current-state context; only the
 * conversation timeline is time-scoped, so each dream reflects on its own slice.
 * Returns the digest and how many messages fell in the window (0 = quiet).
 */
function buildDigest(chatId: number, from: string, to: string): { digest: string; messages: number } {
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
  const rows = chatTimelineBetween(chatId, from, to, 250);
  const timeline = rows
    .map((m) => `[${titleFor(m.session_key)}] ${m.role === 'user' ? 'You' : 'Bot'}: ${m.content.replace(/\s+/g, ' ').slice(0, 260)}`)
    .join('\n');

  const corrections =
    recentCorrections(chatId, 12)
      .map((c) => `- "${c.message}" belonged to ${c.title}, not ${c.wrong_title}`)
      .join('\n') || '(none)';

  const digest = `## Window\nThis reflection covers activity from ${from} to ${to} (UTC).\n\n## Shared memory\n${shared}\n\n## Threads (for reference)\n${threadIndex}\n\n## Routing corrections (auto-routing mistakes)\n${corrections}\n\n## Conversation timeline — chronological, the way the user actually experienced it; [thread] = where each message was routed\n${timeline}`;
  return { digest, messages: rows.length };
}

/** Run a dry-run dreaming pass and post the report to the chat. Read-only. */
export async function runDream(transport: ChatTransport, chatId: number): Promise<void> {
  // Each dream covers a specific, non-overlapping window: from where the last
  // dream ended, to now. Nightly → ~a day each; a missed/failed night is picked
  // up next time because the window only advances when a dream is saved.
  const to = dbNow();
  const from = lastDreamCoveredTo(chatId) ?? '1970-01-01 00:00:00';

  // Slicing message content can split an emoji's surrogate pair; a lone surrogate
  // makes the request body invalid JSON, so strip them before sending.
  const { digest: rawDigest, messages } = buildDigest(chatId, from, to);
  if (messages === 0) {
    await transport
      .send(chatId, {
        text: `🌙 Nothing new to dream about since the last reflection (${from} → ${to} UTC). Skipped.`,
        format: 'plain',
      })
      .catch(() => {});
    return;
  }
  const digest = stripLoneSurrogates(rawDigest);
  const prompt = `Digest of recent activity:\n\n${digest}\n\nThe bot's own TypeScript source is in ./src and its SQLite database is at data/companion.db (binary — use the digest above for data; read the code for code proposals). You have read-only tools (Read/Grep/Glob). Produce your dream report now.`;

  // One generation attempt — accumulates the report and records usage. Throws on
  // failure so the retry wrapper can decide whether to try again.
  const attempt = async (): Promise<string> => {
    let report = '';
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
      } else if (m.type === 'result') {
        const usage = extractUsage(m);
        if (usage) saveUsage(`${chatId}:dream`, usage);
        // A result with is_error means the run failed (e.g. a transient socket
        // close); surface it so the retry wrapper can try again.
        if (m.subtype !== 'success') throw new Error(String(m.subtype ?? 'error'));
      }
    }
    return report;
  };

  // The dream runs unattended nightly, so a transient blip (socket close, 5xx)
  // shouldn't cost a whole night — retry a couple of times before giving up.
  const MAX_ATTEMPTS = 3;
  let report = '';
  let ok = true;
  let lastErr = '';
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      report = await attempt();
      ok = true;
      break;
    } catch (e) {
      ok = false;
      lastErr = e instanceof Error ? e.message : String(e);
      console.warn(`[dream] attempt ${i}/${MAX_ATTEMPTS} failed: ${lastErr}`);
      if (i < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
  if (!ok) report = `(dream failed after ${MAX_ATTEMPTS} attempts: ${lastErr})`;

  // Persist the reflection + the window it covered, so "grow" consumes it and the
  // next dream starts where this one ended. Only advance the window on success —
  // a failed pass leaves it unsaved so the next dream re-covers the same span.
  let savedId: number | undefined;
  if (ok && report.trim()) savedId = saveDream(chatId, report.trim(), from, to);

  await transport
    .send(chatId, {
      text:
        '🌙 <b>Dream report</b> — reflections on recent activity (dry-run, nothing changed)' +
        (savedId !== undefined ? ` · saved #${savedId}` : '') +
        `\n<i>covers ${from} → ${to} UTC</i>:`,
      format: 'tgHtml',
    })
    .catch(() => {});
  for (const piece of chunkRaw(report.trim() || '(the dream produced nothing)')) {
    await transport
      .send(chatId, { text: toTelegramMarkdown(piece), format: 'tgMarkdownV2' })
      .catch(() => transport.send(chatId, { text: piece, format: 'plain' }).catch(() => {}));
  }
}
