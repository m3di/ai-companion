import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { markDreamProcessed, pendingDreams } from './db.js';
import { chunkRaw, toTelegramMarkdown } from './format.js';
import { commitKnowledge, knowledgePath, rebuildIndex } from './knowledge.js';
import type { Buttons, ChatTransport } from './transport/types.js';

/**
 * "Grow" — the knowledge-base librarian (Phase 1). Operator-triggered (/grow):
 * it reads the unprocessed "dream" reflections plus the knowledge base itself,
 * then refines the notes (merge duplicates, fix stale facts, split, re-link,
 * tighten). It works ONLY inside the knowledge repo — its sandbox is that
 * directory, so it can never touch the bot's source — and lands one reviewable
 * commit, which the user can revert with a single tap.
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

/** Run a grow pass: refine the knowledge base from pending dreams, then commit. */
export async function runGrow(transport: ChatTransport, chatId: number): Promise<void> {
  const dreams = pendingDreams(chatId);
  const dreamBlock = dreams.length
    ? dreams.map((d) => `### Dream ${d.id} — ${d.created_at}\n${d.report}`).join('\n\n')
    : '(no new dream reflections since the last grow — do a light audit pass only)';
  const prompt =
    `Recent dream reflections to act on:\n\n${dreamBlock}\n\n` +
    `The knowledge base is your working directory: \`index.md\` (auto-generated — do NOT edit) plus one \`<key>.md\` per note. ` +
    `Survey it, then refine it per your instructions. End with the CHANGE SUMMARY.`;

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
      }
    }
  } catch (e) {
    ok = false;
    report = `(grow failed: ${e instanceof Error ? e.message : String(e)})`;
  }

  // Regenerate the index from whatever notes now exist, land one commit, and
  // mark the consumed dreams processed so the next grow starts fresh.
  let committed: Awaited<ReturnType<typeof commitKnowledge>> = null;
  if (ok) {
    rebuildIndex();
    const headline =
      report
        .split('\n')
        .map((s) => s.trim())
        .find(Boolean)
        ?.slice(0, 72) ?? 'refine knowledge base';
    committed = commitKnowledge(`grow: ${headline}`);
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

  if (committed) {
    const buttons: Buttons = [[{ text: '↩️ Revert this grow', data: `gr:${committed.hash}` }]];
    await transport
      .send(chatId, {
        text: `✅ Committed <code>${committed.hash.slice(0, 8)}</code> · ${committed.files.length} file(s) changed${dreams.length ? ` · ${dreams.length} dream(s) consumed` : ''}.`,
        format: 'tgHtml',
        buttons,
      })
      .catch(() => {});
  } else if (ok) {
    await transport
      .send(chatId, { text: 'No changes were needed — knowledge base left as-is.', format: 'plain' })
      .catch(() => {});
  }
}
