import { readFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { listNotes, upsertNote } from './db.js';

/**
 * Digest a source into the bot's knowledge base: read it, break it into compact,
 * self-contained NOTE units (key + one-line summary + body, with [[links]] to
 * related notes), and upsert them. Existing notes are passed in so the model
 * merges/updates rather than duplicating. The concierge then onboards from the
 * note index instead of re-reading raw documents.
 */

const DIGEST_SYSTEM = `You convert source material into compact MEMORY NOTES for an assistant's knowledge base. A fresh agent reads these to onboard quickly, so optimise for efficiency, not completeness.

Rules:
- Output ONLY a JSON array, nothing else. Each element: {"key": string, "summary": string, "content": string}.
- key: a short kebab-case slug, stable and specific (e.g. "tcp-pr-stack", "grinderlab-prod-bringup").
- summary: <= 12 words, the index line.
- content: a tight, self-contained unit of knowledge — facts, ids, current state. Reference related notes inline as [[their-key]] to capture connections. No fluff.
- Merge related facts into ONE note; do not fragment. Aim for a focused set of strong notes, not many weak ones.
- If existing notes are provided, UPDATE/extend them by reusing the same key; only add new keys for genuinely new topics. Fold in corrections.`;

export interface DigestResult {
  keys: string[];
  error?: string;
}

function parseNotes(text: string): Array<{ key: string; summary: string; content: string }> {
  const fenced = text.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '');
  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((n) => n as { key?: unknown; summary?: unknown; content?: unknown })
      .filter((n) => typeof n.key === 'string' && typeof n.content === 'string')
      .map((n) => ({
        key: String(n.key).slice(0, 60),
        summary: typeof n.summary === 'string' ? n.summary.slice(0, 120) : '',
        content: String(n.content),
      }));
  } catch {
    return [];
  }
}

/** Digest a file at `path` into notes. Returns the keys written, or an error. */
export async function digestFile(
  chatId: number,
  path: string,
  instructions?: string,
): Promise<DigestResult> {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return { keys: [], error: `Couldn't read ${path}` };
  }

  const existing = listNotes(chatId);
  const existingBlock = existing.length
    ? `Existing notes (reuse keys to update; don't duplicate):\n${existing.map((n) => `- ${n.key}: ${n.summary}`).join('\n')}\n\n`
    : '';
  const prompt =
    `${instructions ? `Focus / how to digest: ${instructions}\n\n` : ''}${existingBlock}` +
    `Source document:\n\n${source.slice(0, 80000)}`;

  let text = '';
  try {
    for await (const m of query({
      prompt,
      options: {
        systemPrompt: DIGEST_SYSTEM,
        allowedTools: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        ...(config.model ? { model: config.model } : {}),
      },
    }) as AsyncIterable<any>) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) text += b.text;
        }
      }
    }
  } catch (e) {
    return { keys: [], error: e instanceof Error ? e.message : String(e) };
  }

  const notes = parseNotes(text);
  if (notes.length === 0) return { keys: [], error: 'no notes extracted' };
  for (const n of notes) upsertNote(chatId, n.key, n.summary, n.content);
  return { keys: notes.map((n) => n.key) };
}
