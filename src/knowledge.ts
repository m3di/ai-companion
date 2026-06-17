import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { allNotesForMigration } from './db.js';

/**
 * The knowledge base — the companion's git-tracked long-term memory. Each note
 * is a markdown file (`<key>.md`, frontmatter + body with [[links]]); a generated
 * `index.md` carries the protocol and the index. Files are the source of truth
 * (SQLite stays the firehose), so a future "grow" pass can diff/commit the base.
 *
 * The base is its own git repo, separate from the app code — grow's sandbox is
 * literally this directory, so it can never touch the bot's source.
 */

export interface Note {
  key: string;
  summary: string;
  content: string;
}

const DIR = config.knowledgeDir;

const PROTOCOL = `# Knowledge base

This is the companion's long-term memory: compact, linked notes distilled from
real work. Read this index to see what's known, then open \`<key>.md\` for a
note's full content. Notes cross-reference each other inline as \`[[other-key]]\`.

To add or update knowledge, write \`<key>.md\` (frontmatter: \`key\`, \`summary\`,
\`updated\`) with a tight, self-contained body — this index is then regenerated.
Keep notes focused; merge related facts into one note rather than fragmenting.
`;

/** Clamp a key to a safe kebab slug (also prevents path traversal). */
function safeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function notePath(key: string): string {
  return join(DIR, `${safeKey(key)}.md`);
}

function serialize(key: string, summary: string, content: string): string {
  return `---\nkey: ${key}\nsummary: ${summary.replace(/\n/g, ' ')}\nupdated: ${new Date().toISOString()}\n---\n\n${content.trim()}\n`;
}

function parse(raw: string): { summary: string; content: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { summary: '', content: raw.trim() };
  const fm = m[1] ?? '';
  const body = (m[2] ?? '').replace(/^\n+/, '');
  const sm = fm.match(/^summary:\s*(.*)$/m);
  return { summary: sm?.[1]?.trim() ?? '', content: body.trim() };
}

/** Best-effort git in the knowledge dir — never throws into the caller. */
function git(...args: string[]): void {
  try {
    execFileSync('git', args, { cwd: DIR, stdio: 'ignore' });
  } catch {
    /* best-effort: git missing, nothing to commit, etc. */
  }
}

function noteFiles(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'index.md');
}

/** The note index (key + one-line summary), sorted by key. */
export function listNotes(): Array<{ key: string; summary: string }> {
  return noteFiles()
    .map((f) => {
      const key = f.slice(0, -3);
      const { summary } = parse(readFileSync(join(DIR, f), 'utf8'));
      return { key, summary };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function getNote(key: string): Note | undefined {
  const p = notePath(key);
  if (!existsSync(p)) return undefined;
  const { summary, content } = parse(readFileSync(p, 'utf8'));
  return { key: safeKey(key), summary, content };
}

/** Regenerate index.md from the note files (the index is always derived). */
function rebuildIndex(): void {
  const notes = listNotes();
  const list = notes.length
    ? notes.map((n) => `- [${n.key}](${n.key}.md) — ${n.summary}`).join('\n')
    : '_(empty — digest a source or write a note to start)_';
  writeFileSync(join(DIR, 'index.md'), `${PROTOCOL}\n## Notes\n\n${list}\n`);
}

export function upsertNote(key: string, summary: string, content: string): void {
  const k = safeKey(key);
  writeFileSync(notePath(k), serialize(k, summary, content));
  rebuildIndex();
  git('add', '-A');
  git('commit', '-m', `knowledge: update ${k}`);
}

export function deleteNote(key: string): void {
  const p = notePath(key);
  if (existsSync(p)) rmSync(p);
  rebuildIndex();
  git('add', '-A');
  git('commit', '-m', `knowledge: delete ${safeKey(key)}`);
}

/**
 * Prepare the knowledge base at boot: create the dir, make it a git repo, and —
 * the first time only — migrate any notes still living in SQLite into files.
 * Idempotent.
 */
export function initKnowledge(): void {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(join(DIR, '.git'))) {
    git('init', '-q');
    git('config', 'user.email', 'companion@local');
    git('config', 'user.name', 'ai-companion');
  }

  if (noteFiles().length === 0) {
    const legacy = allNotesForMigration();
    for (const n of legacy) {
      writeFileSync(notePath(n.key), serialize(safeKey(n.key), n.summary, n.content));
    }
    rebuildIndex();
    git('add', '-A');
    git('commit', '-m', `knowledge: migrate ${legacy.length} notes from sqlite`);
    if (legacy.length) console.log(`[knowledge] migrated ${legacy.length} notes from sqlite → ${DIR}`);
  } else {
    rebuildIndex();
  }
}
