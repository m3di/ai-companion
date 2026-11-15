import { existsSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { loadGraph, reformedDomains, VIEW_FILE } from './entities.js';
import {
  ensureStoryNode,
  getStoryNode,
  hasOpenRetrievalEpisode,
  knownEntityIds,
  listStoryNodes,
  markStoryPathDirty,
  noteStoryFollowed,
  saveStoryText,
  type StoryNode,
} from './db.js';

/**
 * THE STORY TREE (round 11, P1) — the narrative render over the graph.
 *
 * The graph answers questions; nothing ever ASKED it any. 246 retrieval
 * episodes, 228 `no-reach`: a fresh session cannot feel the gap the graph
 * would fill, so an optional lookup is a lookup that does not happen. The one
 * memory surface with the opposite record is the injected render — so the
 * story is built to arrive, not to wait. A budgeted root narrative sits over
 * one sub-story per domain; the night rewrites what a day's writes dirtied.
 *
 * WHERE IT ARRIVES (P2b). Level 0 is `storyContext()`: the root story plus
 * one POINTER LINE per domain — that domain story's first sentence, ending in
 * the call that opens the rest (`readStory`). It is injected into every
 * concierge turn with a budget of its own. It used to be spliced into
 * root.md, where the 10k cap the behaviour rules already saturate starved it
 * to one sentence, and its drill-down named story.md — a file the day has no
 * tool to open. Three days of real use, 77 user questions, 0 graph reads: the
 * crumb could not manufacture a gap and the narrative had no door. story.md
 * stays as the operator-readable whole; root.md is left alone.
 *
 * THE STORY IS A RENDER, NEVER A STORE (I1/I2). Every claim carries a
 * [[full-id]] ref into the graph, enforced at the write tool by refusal —
 * a sentence with no node behind it is the root.md rot coming back in a
 * derived costume. A fact the night wants to narrate and cannot connect is a
 * missing edge, and that is a finding to file, not a licence to narrate.
 *
 * Structure is mechanical, prose is agentic (I9): nodes are created by
 * `ensureStoryNodes` (a pure function of the domain list), dirtiness moves up
 * the ancestor path on every graph write, and the night's job list is derived
 * from flags — the agent chooses no work, only words. Two levels today, on
 * purpose: depth is earned by volume (a P3 split), never designed in advance.
 */

const REF_RE = /\[\[([^\[\]\n]+)\]\]/g;

/** chars/4 — crude, stable, and cheap; the budget is a ceiling, not a meter. */
const tokenEstimate = (s: string): number => Math.ceil(s.length / 4);

/** The root story heads the injected block, so it is priced as a system
 *  prompt is priced: every byte sits ahead of the whole transcript. Domain
 *  stories are opened on demand, where the constraint is a reader's patience. */
const ROOT_BUDGET_TOKENS = 300;
const DOMAIN_BUDGET_TOKENS = 600;
/** The whole level-0 block: root story + pointer lines. Pointer lines shrink
 *  to fit; the root text never does — it was budgeted at the write tool. */
const CONTEXT_BUDGET_TOKENS = 900;
const POINTER_MAX_CHARS = 160;
const POINTER_MIN_CHARS = 60;

export const STORY_ROOT_ID = 'root';
export const storyNodeId = (domain: string): string => `domain:${domain}`;

/** P1 wrote this section into root.md; P2b takes it out again. The marker is
 *  kept for DETECTION only — a `## The story` someone authored by hand has no
 *  marker and is theirs, not ours to strip. */
const HEADING = '## The story';
const MARKER = 'GENERATED from the story tree';

function rootPath(): string {
  return join(config.knowledgeDir, 'root.md');
}
function storyPath(): string {
  return join(config.knowledgeDir, 'story.md');
}

/**
 * Create any missing node for the current domain list; never touch text.
 * Idempotent and additive — a domain that disappears keeps its story until a
 * human or a later phase retires it, because deletion of narrative is a
 * judgement, not a sync.
 */
export function ensureStoryNodes(): void {
  ensureStoryNode(STORY_ROOT_ID, null, 'root');
  for (const d of reformedDomains()) ensureStoryNode(storyNodeId(d), STORY_ROOT_ID, d);
}

/** The write path's hook: a graph write in `domains` dirties those stories and
 *  everything above them. Flags only — the rewrite is the night's. */
export function markDomainsDirty(domains: Iterable<string>): void {
  ensureStoryNodes();
  for (const d of domains) {
    ensureStoryNode(storyNodeId(d), STORY_ROOT_ID, d);
    markStoryPathDirty(storyNodeId(d));
  }
}

/**
 * A prose write is a bypass the story cannot see. A note lands in a domain's
 * folder and the graph does not move, so no dirt reaches the story and level 0
 * keeps narrating a world the note has already changed — the boiler note
 * of 2026-08-25 sat two nights beside a `personal` story that read as clean.
 * So a note dirties its domain the way an entity write does. Only for a folder
 * that IS a graph domain: a node minted for a mere note folder would be an
 * orphan the lint rightly flags, and a root-level note has no domain at all.
 */
export function noteTouched(key: string): void {
  const domain = key.includes('/') ? key.split('/')[0]! : '';
  if (domain && reformedDomains().includes(domain)) {
    markDomainsDirty([domain]);
    return;
  }
  // A note the graph has no domain for is M1's discovery signal arriving as
  // prose — the graph is missing a concept. It must not mint a node (an orphan
  // narrating nothing), but it must not be silent either: the root goes dirty
  // and the night sees the key in its root material.
  ensureStoryNodes();
  markStoryPathDirty(STORY_ROOT_ID);
}

export function extractRefs(text: string): string[] {
  return [...text.matchAll(REF_RE)].flatMap((m) => (m[1] ? [m[1].trim()] : []));
}

export function budgetFor(id: string): number {
  return id === STORY_ROOT_ID ? ROOT_BUDGET_TOKENS : DOMAIN_BUDGET_TOKENS;
}

/**
 * Validate a rewrite the way `record()` validates a write: by refusal, before
 * anything moves. Full ids only — string-matching the live set once gave one
 * exact hit and mostly garbage, and a wrong ref is worse than none because
 * the day follows it.
 */
export function validateStoryText(id: string, text: string): string | null {
  const node = getStoryNode(id);
  if (!node) return `no story node "${id}" — call storyWorklist for the real ids`;
  const est = tokenEstimate(text);
  const budget = budgetFor(id);
  if (est > budget) {
    return `over budget: ~${est} tokens against ${budget}. Cut — the story is a compression, not a report.`;
  }
  const refs = extractRefs(text);
  if (!refs.length) {
    return 'no [[ref]] at all — a story with no node behind it is a second store, and that is the rot this render replaced.';
  }
  const g = loadGraph();
  const storyIds = new Set(listStoryNodes().map((n) => n.id));
  const bad = refs.filter((r) => !g.entities.has(r) && !storyIds.has(r));
  if (bad.length) {
    return (
      `unresolvable ref(s): ${bad.join(', ')} — full entity ids only (e.g. people/mehdi). ` +
      'If the graph is missing the node, that is a finding to file, not a ref to invent.'
    );
  }
  // Story-node refs are navigation, not grounding: a text whose every ref
  // points back into the story layer is a narrative floating free of the
  // graph, which is the second-store failure with extra steps.
  if (!refs.some((r) => g.entities.has(r))) {
    return 'no ref resolves to a GRAPH entity — [[domain:*]] refs are navigation, not grounding. Name at least one entity the claim rests on.';
  }
  return null;
}

/** Save a validated rewrite and re-render the surfaces. */
export function applyStoryRewrite(id: string, text: string): { ok: boolean; problem?: string } {
  const problem = validateStoryText(id, text);
  if (problem) return { ok: false, problem };
  saveStoryText(id, text.trim());
  invalidateStoryRefs();
  const r = refreshStorySurfaces();
  return r.problem ? { ok: true, problem: `saved, but render failed: ${r.problem}` } : { ok: true };
}

/**
 * The first sentence of a story: the part that becomes its pointer line, so
 * the night is told to lead with the gap. Cut at a sentence end, then to the
 * pointer width — never inside a [[ref]], because a half ref is a broken
 * pointer and the whole line exists to be followed.
 */
export function firstSentence(text: string, maxChars = POINTER_MAX_CHARS): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  const m = flat.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let s = m ? m[0] : flat;
  if (s.length > maxChars) {
    let cut = s.slice(0, maxChars);
    const open = cut.lastIndexOf('[[');
    if (open !== -1 && cut.indexOf(']]', open) === -1) cut = cut.slice(0, open);
    s = `${cut.trimEnd()}…`;
  }
  return s;
}

interface StoryContextParts {
  text: string;
  /** Domains with a pointer line in the block — exactly the readStory scopes offered. */
  domains: string[];
}

function pointerLine(scope: string, sentence: string): string {
  return `- **${scope}** — ${sentence} → readStory("${scope}")`;
}

/**
 * Level 0, as one block. PURE and stable (I12): the same rows render the same
 * bytes — no clock, no date, nothing that ticks inside a night — because this
 * sits in front of the transcript and a byte that moves re-bills the whole
 * history. That is also why unwritten domains are NOT listed here: a write
 * that mints a domain creates its empty node at once, and a "not yet
 * narrated" line would move under a running session. The audit reports them.
 */
function storyContextParts(): StoryContextParts {
  const nodes = listStoryNodes();
  const root = nodes.find((n) => n.id === STORY_ROOT_ID)?.text.trim() ?? '';
  const children = nodes.filter((n) => n.id !== STORY_ROOT_ID).sort((a, b) => a.scope.localeCompare(b.scope));
  const told = children.filter((n) => n.text.trim());
  if (!root && !told.length) return { text: '', domains: [] };

  const budgetChars = CONTEXT_BUDGET_TOKENS * 4;
  const assemble = (width: number, keep: number): string => {
    const lines = told.slice(0, keep).map((n) => pointerLine(n.scope, firstSentence(n.text, width)));
    const more = told.length - keep;
    if (more > 0) lines.push(`- ${more} more domain(s) — readStory names them: ${told.slice(keep).map((n) => n.scope).join(', ')}`);
    return [root, lines.join('\n')].filter(Boolean).join('\n\n');
  };
  // Shrink the pointers first, then the list — the root text is never cut
  // here, because it was refused at the write tool if it did not fit.
  let width = POINTER_MAX_CHARS;
  let keep = told.length;
  let text = assemble(width, keep);
  while (text.length > budgetChars && width > POINTER_MIN_CHARS) {
    width -= 20;
    text = assemble(width, keep);
  }
  while (text.length > budgetChars && keep > 0) {
    keep -= 1;
    text = assemble(width, keep);
  }
  return { text, domains: told.slice(0, keep).map((n) => n.scope) };
}

/** The injected block — what the concierge meets before the user's message. */
export function storyContext(): string {
  return storyContextParts().text;
}

/** The story-node id a readStory scope opens — only when that story EXISTS
 *  and is written. A typo, or a domain the night has not reached, resolves to
 *  nothing, so the episode log never records a refused read as a reach. */
export function storyIdFor(scope: string): string | undefined {
  const bare = scope.trim().replace(/^domain:/, '');
  if (!bare) return undefined;
  const id = bare === 'root' ? STORY_ROOT_ID : storyNodeId(bare);
  return getStoryNode(id)?.text.trim() ? id : undefined;
}

/**
 * Open one story for the day. Text with its [[refs]] intact, or a refusal
 * naming the scopes that exist — a wrong scope is a question the graph can
 * answer, not a dead end.
 */
export function readStory(scope: string): { text: string } | { problem: string } {
  const bare = scope.trim().replace(/^domain:/, '');
  const id = bare === 'root' ? STORY_ROOT_ID : storyNodeId(bare);
  const node = getStoryNode(id);
  if (node?.text.trim()) return { text: node.text.trim() };
  const scopes = listStoryNodes()
    .filter((n) => n.text.trim())
    .map((n) => n.scope)
    .sort();
  const why = node ? `"${bare}" has no story yet — the night has not narrated it` : `no story "${bare}"`;
  return { problem: `${why}. Scopes with a story: ${scopes.join(', ') || '(none yet)'}.` };
}

/**
 * THE OFFERED SET (P2): the refs the day was actually SHOWN — every [[ref]]
 * in the injected block that resolves to a graph entity, plus the story-node
 * id of each domain the block points at, so opening one with readStory is a
 * follow. Exactly the injected text and nothing more: the first version
 * counted refs in every story body, 113 of 169 entities, and any graph read
 * at all "followed" — a number that could not lose.
 *
 * Resolution goes against the DERIVED entity index, never `loadGraph()`: a
 * parse rebuilds the index and syncs provenance — writes — and this set is
 * read from read-only paths (cycleCli's I11 promise, the Atlas, readOnly
 * module calls). Two SELECTs per refresh is the true cost.
 *
 * Cached because the check runs on every module call: rewrites in this
 * process invalidate explicitly, and a short TTL covers a rewrite from another
 * process (a CLI, an induced pass) — stale for seconds at worst, never for a
 * night.
 */
const STORY_REFS_TTL_MS = 30_000;
let refsCache: { at: number; refs: ReadonlySet<string> } | null = null;

export function invalidateStoryRefs(): void {
  refsCache = null;
}

export function storyRefs(): ReadonlySet<string> {
  const now = Date.now();
  if (refsCache && now - refsCache.at < STORY_REFS_TTL_MS) return refsCache.refs;
  const known = knownEntityIds();
  const parts = storyContextParts();
  const refs = new Set<string>();
  for (const r of extractRefs(parts.text)) if (known.has(r)) refs.add(r);
  for (const d of parts.domains) refs.add(storyNodeId(d));
  refsCache = { at: now, refs };
  return refs;
}

/**
 * Score a call's reached refs against the offered set — the ENTITY follows
 * (a name the block showed, reached through the graph API: spontaneous, and
 * the half of the thesis the door cannot prove). Called where refs first
 * exist and BEFORE they land on the episode, because the dedupe reads the
 * episode's refs as "already scored". Guard order matters: a readOnly caller
 * must not reach a set whose refresh reads the database (the Atlas polls
 * through the module seam every few seconds), and nobody outside an open
 * episode pays for building it. Measuring never costs the call.
 */
export function countStoryFollows(sessionKey: string | undefined, refs: string[], readOnly = false): void {
  if (readOnly || !sessionKey || !refs.length) return;
  try {
    if (!hasOpenRetrievalEpisode(sessionKey)) return;
    const offered = storyRefs();
    noteStoryFollowed(sessionKey, refs.filter((r) => offered.has(r) && !r.startsWith('domain:')));
  } catch {
    // A broken story read loses one data point, not the answer.
  }
}

const NOTE_EXCERPT_CHARS = 400;
const NOTES_BLOCK_CHARS = 3000;

/**
 * Notes as the night's material: key plus the first paragraph of the body.
 * Read from disk here rather than through knowledge.ts, which imports
 * entityWrite, which imports this file — the note format is six lines of
 * frontmatter and this is the one place outside knowledge.ts that reads it.
 * Generated views (`_map.md`, the entities view) are not notes. Never throws:
 * a file that will not read is skipped, a folder that will not list is empty —
 * the worklist must reach the night whatever one note did to itself.
 */
type NoteExcerpt = { key: string; excerpt: string };

function noteExcerpt(relPath: string): NoteExcerpt | undefined {
  try {
    const raw = readFileSync(join(config.knowledgeDir, relPath), 'utf8');
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    const body = (m?.[1] ?? raw).trim();
    const para = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
    const excerpt = para.length > NOTE_EXCERPT_CHARS ? `${para.slice(0, NOTE_EXCERPT_CHARS - 1)}…` : para;
    return { key: relPath.slice(0, -3), excerpt };
  } catch {
    return undefined;
  }
}

function walkNotes(rel: string, out: NoteExcerpt[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(config.knowledgeDir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith('.')) walkNotes(relPath, out);
      continue;
    }
    if (!e.name.endsWith('.md') || e.name === '_map.md' || e.name === VIEW_FILE) continue;
    const n = noteExcerpt(relPath);
    if (n) out.push(n);
  }
}

function notesUnder(scope: string): NoteExcerpt[] {
  if (!existsSync(join(config.knowledgeDir, scope))) return [];
  const out: NoteExcerpt[] = [];
  walkNotes(scope, out);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Notes filed nowhere the graph knows: at the top level (minus the structure
 *  files) or under a folder that is not a domain. Each is a concept the graph
 *  is missing, arriving as prose. */
export function undomainedNotes(): NoteExcerpt[] {
  const domains = new Set(reformedDomains());
  const out: NoteExcerpt[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(config.knowledgeDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !domains.has(e.name)) walkNotes(e.name, out);
      continue;
    }
    if (!e.name.endsWith('.md') || ['root.md', 'index.md', 'story.md'].includes(e.name)) continue;
    const n = noteExcerpt(e.name);
    if (n) out.push(n);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One bounded block of notes for the night. The cap counts EXCERPTED lines
 *  only: once it is hit, every remaining note still appears by key (a note
 *  cannot vanish from the worklist), and those key-only lines sit outside the
 *  cap by design — they cost a line each, not a paragraph. */
function notesBlock(title: string, notes: NoteExcerpt[]): string {
  if (!notes.length) return '';
  const lines: string[] = [];
  let used = 0;
  let elided = 0;
  for (const n of notes) {
    const line = `- ${n.key}: ${n.excerpt || '(empty)'}`;
    if (used + line.length > NOTES_BLOCK_CHARS) {
      lines.push(`- ${n.key}`);
      elided++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }
  const tail = elided ? `\n(${elided} note(s) listed by key only — readNote for the body)` : '';
  return `\n\n## ${title}\n${lines.join('\n')}${tail}`;
}

export interface StoryWorkItem {
  id: string;
  scope: string;
  budgetTokens: number;
  currentText: string;
  material: string;
}

const POINTER_NOTE =
  'THE FIRST SENTENCE IS THE POINTER: it is what the day sees of this story in its injected level-0 block, ' +
  'ending in readStory("<domain>"). Lead with the sentence that names what a fresh session would not know.';

/**
 * The night's prepared worklist: dirty nodes bottom-up — every domain story
 * before the root, so the root is rewritten from children that are already
 * current. Each item carries its material so the rewrite costs words, not a
 * survey (the gardenPlan lesson).
 */
export function storyWorklist(): StoryWorkItem[] {
  ensureStoryNodes();
  const g = loadGraph();
  let nodes = listStoryNodes();
  const hasEntities = (scope: string): boolean => [...g.entities.keys()].some((id) => id.startsWith(`${scope}/`));
  // A node whose domain holds no entities can never be rewritten — the gate
  // demands a graph ref and there is nothing to ref — so a worklist that
  // offered it would offer permanent dirt. Empty is its correct text, and
  // clearing it is structure, so it happens here, mechanically.
  for (const n of nodes) {
    // A domain with notes but no entities is OFFERED, never cleared: the note is
    // the fold candidate the night is meant to mint from (retiring the last
    // entity leaves an empty entities.jsonl beside a live note).
    if (n.id !== STORY_ROOT_ID && n.dirty && !hasEntities(n.scope) && notesUnder(n.scope).length === 0) {
      saveStoryText(n.id, '');
      invalidateStoryRefs();
    }
  }
  nodes = listStoryNodes();
  const dirty = nodes.filter((n) => n.dirty);
  const domains = dirty.filter((n) => n.id !== STORY_ROOT_ID).sort((a, b) => a.id.localeCompare(b.id));
  const root = dirty.find((n) => n.id === STORY_ROOT_ID);

  const domainMaterial = (scope: string): string => {
    const rows = [...g.entities.values()]
      .filter((e) => e.id.startsWith(`${scope}/`))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!rows.length) return '(no entities in this domain)';
    return rows
      .map((e) => {
        const edges = Object.entries(e.edges)
          .flatMap(([rel, dsts]) => (dsts as string[]).map((d) => `${rel}→${d}`))
          .join(', ');
        return `- ${e.id}: ${e.facts.join(' | ') || '(no facts)'}${edges ? `  [${edges}]` : ''}`;
      })
      .join('\n');
  };

  const domainNotes = (scope: string): string => notesBlock('Notes in this domain', notesUnder(scope));

  const rootMaterial = (): string =>
    nodes
      .filter((n) => n.id !== STORY_ROOT_ID)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => `### ${n.scope}${n.dirty ? ' (dirty — rewrite it first)' : ''}\n${n.text || '(no story yet)'}`)
      .join('\n\n') + notesBlock('Notes with no domain in the graph', undomainedNotes());

  const items: StoryWorkItem[] = domains.map((n) => ({
    id: n.id,
    scope: n.scope,
    budgetTokens: budgetFor(n.id),
    currentText: n.text,
    material: `${POINTER_NOTE}\n\n${domainMaterial(n.scope)}${domainNotes(n.scope)}`,
  }));
  if (root) {
    items.push({
      id: root.id,
      scope: 'root',
      budgetTokens: budgetFor(root.id),
      currentText: root.text,
      material:
        `${rootMaterial()}\n\n` +
        `WHERE IT LANDS: the root story is INJECTED into every concierge turn as level 0, above one pointer line per ` +
        `domain (each domain story's first sentence). Its budget is its own (~${ROOT_BUDGET_TOKENS} tokens); it no longer ` +
        `competes with root.md's cap. Compress the children — it is what a fresh session reads first.`,
    });
  }
  return items;
}

/** story.md, wholly generated: the root story plus every domain story — the
 *  operator's view of the whole tree; the day opens one story with readStory. */
export function renderStoryFile(): string {
  const nodes = listStoryNodes();
  const root = nodes.find((n) => n.id === STORY_ROOT_ID);
  const children = nodes.filter((n) => n.id !== STORY_ROOT_ID).sort((a, b) => a.id.localeCompare(b.id));
  const child = (n: StoryNode) =>
    `## ${n.scope}\n\n${n.text.trim() || '(no story yet — the night has not reached this domain)'}\n`;
  return (
    `# The story\n` +
    `<!-- GENERATED from story_nodes — the whole tree. Do not edit; the night rewrites it.\n` +
    `     [[domain/slug]] refs are live graph entities — follow one with find(ref).\n` +
    `     [[domain:name]] refs are story nodes — their sections are in this file. -->\n\n` +
    `${root?.text.trim() || '(no root story yet)'}\n\n` +
    children.map(child).join('\n')
  );
}

export interface StoryRefreshResult {
  changed: boolean;
  problem?: string;
}

/**
 * Pure: root.md with P1's GENERATED `## The story` section removed, or the
 * same bytes back. Only a section carrying the generated marker is ours to
 * take out — an authored `## The story` survives untouched — and the section
 * ends at the next `## ` heading, so a `###` inside it is part of it. Runs
 * once on the live file and is a no-op forever after.
 */
export function stripStorySection(raw: string): string {
  const start = raw.search(new RegExp(`^${HEADING}[ \\t]*\\r?$`, 'm'));
  if (start === -1) return raw;
  const after = raw.slice(start + HEADING.length);
  const nextRel = after.search(/^## /m);
  const end = nextRel === -1 ? raw.length : start + HEADING.length + nextRel;
  if (!raw.slice(start, end).includes(MARKER)) return raw;
  const before = raw.slice(0, start).replace(/(\r?\n)+$/, '');
  const rest = raw.slice(end).replace(/^(\r?\n)+/, '');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  if (!rest) return before ? `${before}${nl}` : '';
  return before ? `${before}${nl}${nl}${rest}` : rest;
}

/**
 * Rewrite story.md, and take the P1 section out of root.md if it is still
 * there. Best-effort like every other view maintainer: a render problem is
 * reported, never thrown into a write path.
 */
export function refreshStorySurfaces(): StoryRefreshResult {
  try {
    let changed = false;

    const sPath = storyPath();
    const nextStory = renderStoryFile();
    if (!existsSync(sPath) || readFileSync(sPath, 'utf8') !== nextStory) {
      writeFileSync(sPath, nextStory);
      changed = true;
    }

    const rPath = rootPath();
    if (!existsSync(rPath)) return { changed, problem: 'no root.md' };
    const raw = readFileSync(rPath, 'utf8');
    const next = stripStorySection(raw);
    if (next !== raw) {
      writeFileSync(rPath, next);
      changed = true;
    }
    return { changed };
  } catch (e) {
    return { changed: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

export interface StoryLintReport {
  nodes: number;
  dirty: number;
  /** Notes filed outside every graph domain — measured, never a problem:
   *  each is a concept the graph is missing, and the night's root material
   *  lists them as fold candidates. */
  undomained: number;
  problems: string[];
}

/**
 * The structural half of consistency — deterministic, no agent, run by the
 * audit so a broken tree is a line someone reads whether or not it fired.
 * Semantic fidelity (does the story compress its facts honestly) cannot live
 * here; that is a sampled verifier, and it is P3's to build.
 */
export function storyLint(): StoryLintReport {
  // The tree self-seeds before it is judged: a fresh database is fourteen
  // missing nodes for exactly one boot, and an audit that cries BROKEN over
  // "nobody has run ensure yet" is a wolf-cry on the machine's first morning.
  ensureStoryNodes();
  const problems: string[] = [];
  const nodes = listStoryNodes();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const g = loadGraph();
  const domains = new Set(reformedDomains());

  if (!byId.has(STORY_ROOT_ID)) problems.push('no root story node');
  for (const d of domains) {
    if (!byId.has(storyNodeId(d))) problems.push(`domain ${d} has no story node`);
  }
  for (const n of nodes) {
    if (n.id !== STORY_ROOT_ID && !domains.has(n.scope)) {
      problems.push(`${n.id}: scope "${n.scope}" is no longer a domain — an orphan narrating nothing`);
    }
  }
  for (const n of nodes) {
    if (n.id === STORY_ROOT_ID) continue;
    // Walk to root — a chain that cycles or dangles is a tree no rewrite
    // order can be derived from.
    const seen = new Set<string>();
    let cur: StoryNode | undefined = n;
    while (cur && cur.id !== STORY_ROOT_ID && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    if (!cur || cur.id !== STORY_ROOT_ID) problems.push(`${n.id}: parent chain never reaches root`);
  }
  const storyIds = new Set(byId.keys());
  for (const n of nodes) {
    if (!n.text) continue;
    const est = tokenEstimate(n.text);
    if (est > budgetFor(n.id)) problems.push(`${n.id}: over budget (~${est} of ${budgetFor(n.id)} tokens)`);
    for (const r of extractRefs(n.text)) {
      if (!g.entities.has(r) && !storyIds.has(r)) problems.push(`${n.id}: ref [[${r}]] resolves to nothing`);
    }
  }
  return { nodes: nodes.length, dirty: nodes.filter((n) => n.dirty).length, undomained: undomainedNotes().length, problems };
}
