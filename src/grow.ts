import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { extractUsage } from './claude.js';
import { markDreamProcessed, pendingDreams, saveGrow, saveUsage } from './db.js';
import { chunkRaw, stripLoneSurrogates, toTelegramMarkdown } from './format.js';
import { knowledgePath, rebuildIndex, snapshotNotes } from './knowledge.js';
import type { ChatTransport } from './transport/types.js';

/**
 * "Grow" — the knowledge-base librarian (Phase 1). Operator-triggered (/grow):
 * it reads the unprocessed "dream" reflections plus the knowledge base itself,
 * then refines the notes (merge duplicates, fix stale facts, split, re-link,
 * tighten). It works ONLY inside the knowledge directory — its sandbox is that
 * directory, so it can never touch the bot's source.
 *
 * It applies edits DIRECTLY to the files (no git in the data dir) and records
 * what it changed to the `grows` change-log, viewable via /grows.
 */

const GROW_SYSTEM = `You are "grow" — the librarian of this companion's knowledge base, a directory of markdown notes that is its long-term memory. You are given recent "dream" reflections (observations about the bot's activity and memory) plus the notes themselves, and your job is to make the knowledge base better.

Concretely: merge duplicate or overlapping notes; fix stale, wrong, or contradictory facts (the dreams often flag these); split a note that has grown into several distinct topics; repair or add [[key]] cross-links; tighten summaries and bodies. Reorganize toward a clean structure (group related notes, consistent kebab-case keys) when it genuinely helps.

Rules:
- Work ONLY within your working directory (the knowledge base). Never read or write anything outside it.
- Each note is \`<key>.md\` with frontmatter (key, summary, updated) and a self-contained body; cross-reference related notes inline as [[their-key]]. Keep each note's frontmatter key + summary accurate — the index is regenerated from them, so do NOT edit index.md yourself.
- To rename or merge: write the target note and delete the obsolete file(s).
- Be conservative and grounded: improve only what the dreams and the notes actually justify. Don't churn, don't invent facts, don't delete knowledge you can't replace.
- Survey first (Glob/Read) before editing.
- Finish with a concise CHANGE SUMMARY — a few bullets on what you changed and why. If nothing needed changing, say so plainly.`;

interface FileChange {
  path: string;
  action: 'A' | 'M' | 'D';
  before: string;
  after: string;
}

/** Diff two note snapshots into a per-file change-log. */
function diffSnapshots(before: Record<string, string>, after: Record<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[path];
    const a = after[path];
    if (b === undefined && a !== undefined) changes.push({ path, action: 'A', before: '', after: a });
    else if (b !== undefined && a === undefined) changes.push({ path, action: 'D', before: b, after: '' });
    else if (b !== a && b !== undefined && a !== undefined) changes.push({ path, action: 'M', before: b, after: a });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/** Run a grow pass: refine the knowledge base from pending dreams, log changes. */
export async function runGrow(transport: ChatTransport, chatId: number): Promise<void> {
  const dreams = pendingDreams(chatId);
  const dreamBlock = dreams.length
    ? dreams.map((d) => `### Dream ${d.id} — ${d.created_at}\n${d.report}`).join('\n\n')
    : '(no new dream reflections since the last grow — do a light audit pass only)';
  const prompt = stripLoneSurrogates(
    `Recent dream reflections to act on:\n\n${dreamBlock}\n\n` +
      `The knowledge base is your working directory: \`index.md\` (auto-generated — do NOT edit) plus one \`<key>.md\` per note. ` +
      `Survey it, then refine it per your instructions. End with the CHANGE SUMMARY.`,
  );

  const before = snapshotNotes();
  let report = '';
  let ok = true;
  try {
    for await (const m of query({
      prompt,
      options: {
        cwd: knowledgePath(),
        systemPrompt: GROW_SYSTEM,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        disallowedTools: ['Bash', 'NotebookEdit', 'AskUserQuestion'],
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
        if (usage) saveUsage(`${chatId}:grow`, usage);
      }
    }
  } catch (e) {
    ok = false;
    report = `(grow failed: ${e instanceof Error ? e.message : String(e)})`;
  }

  // Regenerate the index, diff what changed, record the run, and consume the
  // dreams. Edits are already on disk — no commit.
  let changes: FileChange[] = [];
  let savedId: number | undefined;
  if (ok) {
    rebuildIndex();
    changes = diffSnapshots(before, snapshotNotes());
    savedId = saveGrow(chatId, report.trim() || '(no summary)', JSON.stringify(changes));
    for (const d of dreams) markDreamProcessed(d.id);
  }

  await transport
    .send(chatId, {
      text: '🌱 <b>Grow</b> — refined the knowledge base from recent reflections:',
      format: 'tgHtml',
    })
    .catch(() => {});
  for (const piece of chunkRaw(report.trim() || '(grow produced no summary)')) {
    await transport
      .send(chatId, { text: toTelegramMarkdown(piece), format: 'tgMarkdownV2' })
      .catch(() => transport.send(chatId, { text: piece, format: 'plain' }).catch(() => {}));
  }

  if (savedId !== undefined) {
    const counts = (['A', 'M', 'D'] as const).map((a) => changes.filter((c) => c.action === a).length);
    const [add, mod, del] = counts;
    const summary =
      [add && `+${add} new`, mod && `~${mod} edited`, del && `−${del} removed`].filter(Boolean).join(', ') ||
      'no file changes';
    const list = changes.length
      ? `\n<blockquote expandable>${changes.map((c) => `${c.action} ${c.path}`).join('\n')}</blockquote>`
      : '';
    await transport
      .send(chatId, {
        text:
          `✅ Applied to the knowledge base · ${summary} · saved as grow #${savedId}` +
          `${dreams.length ? ` · ${dreams.length} dream(s) consumed` : ''}${list}`,
        format: 'tgHtml',
      })
      .catch(() => {});
  }
}
