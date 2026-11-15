import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { botSessionIds, searchChatMessages, searchEpisodeText } from './db.js';
import { config } from './config.js';

/**
 * DISCOVERY (round 6 step 4, BRAIN.md §3.12) — finding work that already
 * happened.
 *
 * Mehdi's original ask, before any of this was built: "if I'm doing a bugfix
 * and in the future it happened again, the main agent [needs] some way to lead
 * to finding it — not a live index or a direct mention, just a discovery path
 * so the new agent can search sessions with some phrases and find it, then
 * collect information around it."
 *
 * So this is deliberately NOT an index. It is a search, cheapest-first, over
 * material that already exists:
 *
 *   1. EPISODES — the skeletons and recaps already in SQL. Instant, and it is
 *      the meaningful half: the user's own prompts plus the agent's narration.
 *      Almost every real question is answered here.
 *   2. TRANSCRIPTS — a scan of the raw JSONL for what the skeleton clipped
 *      (exact error strings, a file path mentioned once, a command). Slower,
 *      complete, and only worth reaching for when tier 1 misses.
 *
 * Then `resumeHint` answers the question that follows a hit: is it worth
 * resuming that session, or is its context so full that a fresh one is better?
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Hyphen/underscore-insensitive, so "dirty day aggregation" finds
 *  `task/2761-dirty-day-aggregation`. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_/.]+/g, ' ').replace(/\s+/g, ' ');
}

/** Every word must appear — a phrase query is an AND, not a substring. */
function tokens(term: string): string[] {
  return norm(term).split(' ').filter((t) => t.length > 1);
}

function matchesAll(text: string, terms: string[]): boolean {
  const n = norm(text);
  return terms.every((t) => n.includes(t));
}

/** A project dir the search must never surface. Covers the bot's own repo and
 *  its NESTED working dirs — the operator runs with cwd = the knowledge tree,
 *  which lands as `<repo>-data-knowledge`, so a plain equality check misses it
 *  and search returns the bot reasoning about the work instead of the work. */
function excludedProject(project: string): boolean {
  const p = project.toLowerCase();
  for (const ex of config.noHarvestProjects) {
    if (p === ex || p.startsWith(`${ex}-`)) return true;
  }
  return false;
}

export interface Hit {
  episodeId?: number;
  /** For thread hits: the message-log id, so the full message can be fetched. */
  messageId?: number;
  /** Matched only SOME of the query's words — a lead, not a confirmation. It
   *  never counts toward "we found enough, skip the deep scan". */
  partial?: boolean;
  sessionId: string;
  project: string;
  when: string;
  /** Where the term matched: a recap line, a prompt, or raw transcript text. */
  context: string;
  source: 'summary' | 'thread' | 'transcript';
}

/** Tier 1: search what has already been distilled. Instant. */
export function searchEpisodes(term: string, limit = 12): Hit[] {
  const terms = tokens(term);
  if (!terms.length) return [];
  // Query SQL on the longest token (most selective), then require the rest in
  // JS — LIKE cannot express "all of these words, ignoring hyphens".
  const anchor = terms.reduce((a, b) => (b.length > a.length ? b : a));
  return searchEpisodeText(anchor, limit * 4)
    .filter((r) => matchesAll(`${r.skeleton} ${r.recap ?? ''}`, terms))
    .slice(0, limit)
    .map((r) => ({
      episodeId: r.id,
      sessionId: r.session_id,
      project: r.project,
      when: r.started_at.slice(0, 16),
      context: excerpt(r.recap ? `${headlineOf(r.recap)} — ${r.skeleton}` : r.skeleton, terms),
      source: 'summary' as const,
    }));
}

function headlineOf(recap: string): string {
  try {
    return (JSON.parse(recap) as { headline: string }).headline;
  } catch {
    return '';
  }
}

/** A window of text around the first match, so a hit shows WHY it matched. */
function excerpt(text: string, terms: string[], width = 160): string {
  const n = norm(text);
  const i = terms.map((t) => n.indexOf(t)).filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (i === -1) return text.replace(/\s+/g, ' ').slice(0, width);
  const start = Math.max(0, i - Math.floor(width / 3));
  const flat = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${flat}${start + width < text.length ? '…' : ''}`;
}

/**
 * Tier 2: scan the raw transcripts. For the detail a skeleton clipped — an
 * exact stack trace, a one-off path, a command that was run once.
 *
 * Node rather than ripgrep on purpose: `rg` here is a shell function, not a
 * binary on PATH, so shelling out to it is not portable. At ~100 files this
 * takes about a second.
 */
export function searchTranscripts(term: string, limit = 12): Hit[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const terms = tokens(term);
  if (!terms.length) return [];
  const botIds = botSessionIds();
  const hits: Hit[] = [];

  const files: Array<{ path: string; mtime: number }> = [];
  for (const dir of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const project = dir.name.replace(/^-Users-[^-]+-Projects-/, '');
    if (excludedProject(project)) continue;
    for (const f of readdirSync(join(PROJECTS_DIR, dir.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      if (botIds.has(basename(f.name, '.jsonl'))) continue;
      const p = join(PROJECTS_DIR, dir.name, f.name);
      files.push({ path: p, mtime: statSync(p).mtimeMs });
    }
  }
  // Newest first: recent work is what a "has this happened before?" question
  // is usually reaching for, and it lets the limit cut the tail cheaply.
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path } of files) {
    if (hits.length >= limit) break;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!matchesAll(raw, terms)) continue;
    const sessionId = basename(path, '.jsonl');
    const project = basename(path, '.jsonl') && path.split('/').slice(-2, -1)[0]!.replace(/^-Users-[^-]+-Projects-/, '');
    let when = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o: { timestamp?: string; type?: string; message?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.timestamp && !when) when = o.timestamp.slice(0, 16).replace('T', ' ');
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? JSON.stringify(c) : '';
      if (matchesAll(text, terms)) {
        hits.push({ sessionId, project, when: when || '?', context: excerpt(text, terms), source: 'transcript' });
        break;
      }
    }
  }
  return hits;
}

/** Work the FLEET did — bot threads, in the chat message log. Episodes only
 *  cover Mehdi at his own terminal, so a search without this misses everything
 *  a worker discovered. The TypeScript-6 `downlevelIteration` gotcha is the
 *  proving case: found by a worker, so it exists nowhere in the episodes. */
export function searchThreads(chatId: number, term: string, limit = 6): Hit[] {
  const terms = tokens(term);
  if (!terms.length) return [];
  // searchChatMessages is now full-text and ranked, so hand it the WHOLE term
  // rather than one anchor word. All-words hits still lead — that is the strong
  // signal — but partial hits are kept as a tail instead of being thrown away:
  // an AND filter is why a question phrased differently from the message
  // returned nothing at all.
  const rows = searchChatMessages(chatId, term, limit * 4);
  const strong: Hit[] = [];
  const weak: Hit[] = [];
  for (const m of rows) {
    const slot = m.session_key.split(':')[1];
    const hit: Hit = {
      messageId: m.id,
      sessionId: m.session_key,
      project: `thread ${slot === '-1' ? '(concierge)' : slot}`,
      when: m.created_at.slice(0, 16),
      context: excerpt(m.content, terms),
      source: 'thread' as const,
    };
    if (matchesAll(m.content, terms)) strong.push(hit);
    else weak.push({ ...hit, partial: true });
  }
  return [...strong, ...weak].slice(0, limit);
}

/**
 * The ladder: both cheap surfaces first, then the expensive one only if they
 * come up short. Episodes are Mehdi's own terminal work; threads are the
 * fleet's. Either alone answers half of "have we hit this before?".
 */
export function findWork(
  chatId: number,
  term: string,
  limit = 10,
): { hits: Hit[]; scannedTranscripts: boolean } {
  const cheap = [...searchEpisodes(term, limit), ...searchThreads(chatId, term, Math.ceil(limit / 2))];
  // Only FULL matches earn skipping the deep scan; partial full-text hits are
  // leads, and treating three of them as "found it" would hide the transcripts.
  if (cheap.filter((h) => !h.partial).length >= 3) {
    return { hits: cheap.slice(0, limit), scannedTranscripts: false };
  }
  const seen = new Set(cheap.map((h) => h.sessionId));
  const deep = searchTranscripts(term, limit - cheap.length).filter((h) => !seen.has(h.sessionId));
  return { hits: [...cheap, ...deep], scannedTranscripts: true };
}

export interface ResumeHint {
  sessionId: string;
  found: boolean;
  contextTokens: number;
  lastActive?: string;
  /** Whether picking this session back up is worth it, and why. */
  verdict: string;
}

/**
 * Should this session be resumed, or is a fresh one better?
 *
 * The transcript records real per-message usage, so unlike the bot's own
 * sessions (where context must be estimated from run totals) this is the
 * actual number: the last assistant message's cache_read + input is what that
 * turn carried. A session near its window will compact on resume — oldest
 * detail first — so reading its transcript is often better than reviving it.
 */
export function resumeHint(sessionId: string, window = 1_000_000): ResumeHint {
  const path = transcriptPathFor(sessionId);
  if (!path) return { sessionId, found: false, contextTokens: 0, verdict: 'No transcript on disk — nothing to resume.' };

  let tokens = 0;
  let lastActive: string | undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      };
      if (o.timestamp) lastActive = o.timestamp.slice(0, 16).replace('T', ' ');
      const u = o.message?.usage;
      if (o.type === 'assistant' && u) {
        tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    } catch {
      // partial trailing line
    }
  }

  const pct = Math.round((tokens / window) * 100);
  const verdict =
    tokens === 0
      ? 'No usage recorded — safe to resume.'
      : pct >= 80
        ? `~${pct}% of its window. Resuming will compact it and lose the oldest detail — READ the transcript instead, or start fresh with a brief.`
        : pct >= 50
          ? `~${pct}% of its window. Resumable, but it will compact before long — carry anything durable out first.`
          : `~${pct}% of its window. Warm and cheap to resume: claude --resume ${sessionId}`;
  return { sessionId, found: true, contextTokens: tokens, lastActive, verdict };
}

function transcriptPathFor(sessionId: string): string | undefined {
  if (!existsSync(PROJECTS_DIR)) return undefined;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}
