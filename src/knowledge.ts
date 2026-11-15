import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config } from './config.js';
import { allNotesForMigration } from './db.js';
import { applyWrite } from './entityWrite.js';
import { noteTouched } from './storyTree.js';

/**
 * The knowledge base — the companion's long-term memory. Each note is a markdown
 * file (`<key>.md`, frontmatter + body with [[links]]); a generated `index.md`
 * carries the protocol and the index. Files are the source of truth (SQLite stays
 * the firehose).
 *
 * Keys are relative paths, so the base is a TREE, not a flat list — e.g.
 * `work/affiliate-app/client-softdelete`. No taxonomy is prescribed in code: the
 * nightly act stage (grow) grows and reorganizes the structure from what the
 * data justifies. A folder may carry a `_map.md` — a few lines on what belongs
 * there — which the index surfaces, so agents navigate coarse-to-fine.
 *
 * This is plain, gitignored instance data — NOT a git repo. Edits are applied
 * directly to the files; `grow` records what it changed to the `grows` change-log
 * (db) rather than committing, so the knowledge never grows a parallel history.
 */

export interface Note {
  key: string;
  summary: string;
  content: string;
}

const DIR = config.knowledgeDir;
const MAX_DEPTH = 4;

const PROTOCOL = `# Knowledge base

This is the companion's long-term memory: compact, linked notes distilled from
real work, organized as a tree. Read this index to see what's known — folders
group related notes (a folder's \`_map.md\` says what belongs in it) — then open
\`<key>.md\` for a note's full content. Notes cross-reference each other inline
as \`[[key]]\` (a full path like \`[[work/foo/bar]]\`, or just the note's final
name when it's unique).

To add or update knowledge, write \`<key>.md\` (frontmatter: \`key\`, \`summary\`,
\`updated\`) with a tight, self-contained body — this index is then regenerated.
Keys are paths: put a note where it belongs in the tree (create folders as
topics emerge; don't force structure that isn't there). Keep notes focused;
merge related facts into one note rather than fragmenting.
`;

// `root.md` and `index.md` are structure, not notes — note ops must never
// resolve to or clobber them. `story.md` is the story tree's generated
// surface (round 11): wholly derived from story_nodes, so a note op landing
// on it would be hand-editing a render.
const RESERVED_KEYS = new Set(['root', 'index', 'story']);

/**
 * Clamp a key to a safe kebab path (also prevents path traversal).
 *
 * A leading underscore SURVIVES, and a folder's map is canonicalized to
 * `_map`. Both matter: the old rule stripped the underscore, so the key
 * `paperwork/_map` silently became `paperwork/map` and every note tool
 * wrote, read and deleted a SHADOW file next to the real domain map. On
 * 2026-07-26 a full rework of the paperwork map landed in `map.md` while
 * `_map.md` — the file the index, folder blurbs and [[folder/_map]] links all
 * resolve to — stayed nine days stale, and the agent was told it had succeeded.
 *
 * Canonicalizing means a folder has exactly ONE map node, reachable as either
 * `<folder>/_map` or `<folder>/map`, and the shadow cannot be recreated.
 */
function safeKey(key: string): string {
  const segs = key
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => {
      // Keep one leading underscore, kebab the rest.
      const lead = seg.startsWith('_') ? '_' : '';
      return (
        lead +
        seg
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60)
      );
    })
    .filter((s) => s && s !== '_')
    .slice(0, MAX_DEPTH);
  // Only inside a folder — a top-level "map" is an ordinary note.
  if (segs.length > 1 && segs[segs.length - 1] === 'map') segs[segs.length - 1] = '_map';
  return segs.join('/');
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

/** All .md files under the base as relative paths. Folder `_map.md`s and the
 *  root `index.md` are structure, not notes — included only when asked. */
function noteFiles(includeMaps = false): string[] {
  if (!existsSync(DIR)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(DIR, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) walk(relPath);
      } else if (e.name.endsWith('.md')) {
        if (relPath === 'index.md' || relPath === ROOT_FILE || relPath === 'story.md') continue;
        if (e.name === '_map.md' && !includeMaps) continue;
        out.push(relPath);
      }
    }
  };
  walk('');
  return out.sort();
}

/** The note index (key + one-line summary), sorted by key (path). */
export function listNotes(): Array<{ key: string; summary: string }> {
  return noteFiles().map((f) => {
    const key = f.slice(0, -3);
    const { summary } = parse(readFileSync(join(DIR, f), 'utf8'));
    return { key, summary };
  });
}

/** Resolve a key to an existing note file: exact path, else a unique final-name
 *  match anywhere in the tree (so [[links]] survive moves). */
function resolveKey(key: string): string | undefined {
  const k = safeKey(key);
  if (!k || RESERVED_KEYS.has(k)) return undefined;
  if (existsSync(join(DIR, `${k}.md`))) return k;
  // Include folder maps: `_map` is a real, writable node, so a lookup that
  // skipped maps would report a live domain map as missing.
  const name = k.split('/').pop()!;
  const matches = noteFiles(true).filter((f) => basename(f, '.md') === name);
  return matches.length === 1 ? matches[0]!.slice(0, -3) : undefined;
}

export function getNote(key: string): Note | undefined {
  const k = resolveKey(key);
  if (!k) return undefined;
  const { summary, content } = parse(readFileSync(join(DIR, `${k}.md`), 'utf8'));
  return { key: k, summary, content };
}

/** A folder's one-line blurb from its _map.md: the frontmatter summary if
 *  present, else the first non-empty, non-heading body line. */
function folderBlurb(folder: string): string {
  const p = join(DIR, folder, '_map.md');
  if (!existsSync(p)) return '';
  const { summary, content } = parse(readFileSync(p, 'utf8'));
  // Map summaries tend to open with "Map of <folder>/ —", which just repeats
  // the heading the blurb is rendered next to.
  if (summary) return summary.replace(/^map of \S+\s*[—–-]+\s*/i, '');
  const line = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  return line ?? '';
}

/** Top-level folders that carry a _map.md (domains), whether or not they hold notes. */
function mapFolders(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(DIR, e.name, '_map.md')))
    .map((e) => e.name);
}

/**
 * Compact tree index for prompts (concierge state block, dream digest): folder
 * blurbs first — a domain's whole content may live in its map — then per-note
 * summary lines.
 */
export function treeIndex(): string {
  const notes = listNotes();
  const groups = new Map<string, Array<{ key: string; summary: string }>>();
  for (const n of notes) {
    const top = n.key.includes('/') ? n.key.split('/')[0]! : '';
    groups.set(top, [...(groups.get(top) ?? []), n]);
  }
  const lines: string[] = [];
  for (const n of groups.get('') ?? []) lines.push(`- ${n.key}: ${n.summary}`);
  const tops = [...new Set([...[...groups.keys()].filter(Boolean), ...mapFolders()])].sort();
  for (const top of tops) {
    const blurb = folderBlurb(top);
    lines.push(`- ${top}/${blurb ? ` — ${blurb}` : ''}`);
    for (const n of groups.get(top) ?? []) lines.push(`  - ${n.key}: ${n.summary}`);
  }
  return lines.join('\n');
}

/** Dangling [[links]] and duplicate final names — the act stage must keep this
 *  clean (it's included in grow's prompt and appended to its report if dirty). */
export function linkHealth(): string[] {
  // Folder maps are legal FULL-PATH link targets ([[folder/_map]]) and carry
  // links themselves, so include them — but keep them out of bare-name
  // resolution (every folder has one; the name is ambiguous by design).
  const files = noteFiles(true);
  const keys = new Set(files.map((f) => f.slice(0, -3)));
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const name = basename(f, '.md');
    if (name === '_map') continue;
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  const problems: string[] = [];
  for (const [name, fs] of byName) {
    if (fs.length > 1) problems.push(`duplicate note name "${name}": ${fs.join(', ')} — [[${name}]] links are ambiguous`);
  }
  // The root node carries links too (it's a link SOURCE, never a target).
  const sources = existsSync(rootPath()) ? [...files, ROOT_FILE] : files;
  for (const f of sources) {
    let body = readFileSync(join(DIR, f), 'utf8');
    // Migration residue (round 11 P2b): root.md no longer carries a generated
    // `## The story` section — level 0 is injected from story_nodes — but a
    // tree not yet visited by refreshStorySurfaces still has P1's, whose
    // [[refs]] are GRAPH ids, not note links. A no-op on a migrated file;
    // story.md never enters `files`.
    if (f === ROOT_FILE) {
      body = body.replace(/^## The story\s*$[\s\S]*?(?=^##\s|(?![\s\S]))/m, '');
    }
    for (const m of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const raw = m[1]!.trim();
      // safeKey would strip the underscore in "_map", so match map links as-is.
      if (raw.toLowerCase().endsWith('_map')) {
        if (!keys.has(raw.toLowerCase().replace(/\\/g, '/'))) problems.push(`dangling link [[${raw}]] in ${f}`);
        continue;
      }
      const target = safeKey(raw);
      if (!target) continue;
      const name = target.split('/').pop()!;
      if (!keys.has(target) && (byName.get(name)?.length ?? 0) !== 1) {
        problems.push(`dangling link [[${raw}]] in ${f}`);
      }
    }
  }
  return problems;
}

/** Regenerate index.md from the note files (the index is always derived). */
export function rebuildIndex(): void {
  const notes = listNotes();
  let body: string;
  if (!notes.length) {
    body = '_(empty — digest a source or write a note to start)_';
  } else {
    // Group by top-level folder; root notes first, then folders alphabetically.
    // Deeper nesting stays visible in each entry's path.
    const groups = new Map<string, typeof notes>();
    for (const n of notes) {
      const top = n.key.includes('/') ? n.key.split('/')[0]! : '';
      groups.set(top, [...(groups.get(top) ?? []), n]);
    }
    const render = (ns: typeof notes, prefix: string): string =>
      ns
        .map((n) => {
          const label = prefix ? n.key.slice(prefix.length + 1) : n.key;
          return `- [${label}](${n.key}.md) — ${n.summary}`;
        })
        .join('\n');
    const parts: string[] = [];
    const root = groups.get('');
    if (root) parts.push(render(root, ''));
    // A domain may be map-only (its whole content is the briefing + leads in
    // _map.md) — render it too, or the domain vanishes from the index.
    const tops = [...new Set([...[...groups.keys()].filter(Boolean), ...mapFolders()])].sort();
    for (const top of tops) {
      const blurb = folderBlurb(top);
      const notes_ = groups.get(top);
      parts.push(`### ${top}/${blurb ? ` — ${blurb}` : ''}\n${notes_ ? render(notes_, top) : `- [_map](${top}/_map.md) — the domain briefing (no depth notes)`}`);
    }
    body = parts.join('\n\n');
  }
  writeFileSync(join(DIR, 'index.md'), `${PROTOCOL}\n## Notes\n\n${body}\n`);
}

/** Write a note; returns the key it ACTUALLY landed on (keys are normalized,
 *  so an agent told only "saved <what you asked for>" cannot tell that its edit
 *  went somewhere else). */
export function upsertNote(key: string, summary: string, content: string): string {
  const k = safeKey(key);
  if (RESERVED_KEYS.has(k)) throw new Error(`"${k}" is reserved (structure, not a note) — pick another key`);
  mkdirSync(dirname(notePath(k)), { recursive: true });
  writeFileSync(notePath(k), serialize(k, summary, content));
  rebuildIndex();
  touchStory(k);
  return k;
}

/** A note write moves a domain the story narrates; tell the story so (see
 *  storyTree.noteTouched). Best-effort: a story problem never fails a note. */
function touchStory(key: string): void {
  try {
    noteTouched(key);
  } catch (e) {
    console.error('[knowledge] story dirty-marking failed (the note write stands)', e);
  }
}

/** Remove now-empty directories left behind by a delete/move, up to the root. */
function pruneEmptyDirs(from: string): void {
  let dir = from;
  while (dir !== DIR && dir.startsWith(DIR) && existsSync(dir)) {
    const entries = readdirSync(dir).filter((e) => e !== '_map.md');
    if (entries.length) break;
    const map = join(dir, '_map.md');
    if (existsSync(map)) rmSync(map);
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

/**
 * The ROOT node — `root.md`, the single always-on core of the memory. Reserved
 * like `index.md` (structure, NOT a note: no frontmatter, excluded from
 * noteFiles). Exact, code-parsable `## ` sections:
 *   ## How to behave  — standing habits (the old identity layer), with provenance
 *   ## Domains        — one line per domain folder in the tree
 *   ## Global facts   — standing facts true everywhere (absorbs shared memory)
 *   ## Now            — a few volatile lines (active focus, open commitments)
 * The concierge is injected with the WHOLE root; workers get only the behave
 * section. Only the nightly rewrite operator and /defrag write it — plus
 * recordRootHabit, the one interactive write path (explicit user corrections).
 */
export const ROOT_FILE = 'root.md';
const ROOT_CAP = 10_000;
export const ROOT_SECTIONS = ['How to behave', 'Domains', 'Global facts', 'Now'] as const;
export type RootSection = (typeof ROOT_SECTIONS)[number];

export function rootPath(): string {
  return join(DIR, ROOT_FILE);
}

function readRoot(): string {
  return existsSync(rootPath()) ? readFileSync(rootPath(), 'utf8') : '';
}

/**
 * The whole root, fitted to budget — the concierge's per-turn block.
 *
 * A blind `slice(0, CAP)` cut the TAIL, and the tail is `## Now`: the section
 * the nightly rewrites every single pass, holding the day's active focus and
 * open commitments. On 2026-07-26 the root sat 819 chars over and the concierge
 * could not see a single Now bullet — the most volatile knowledge in the system
 * was the first thing thrown away, silently, every time habits grew.
 *
 * So overflow now comes out of the least volatile place instead: the PROVENANCE
 * parentheticals on habit lines ("(why: … — 2026-07-12)"). Each habit's
 * PRINCIPLE — the part that actually steers behaviour — survives, and the
 * dropped provenance is recoverable from the message log (searchMessages /
 * readMessage). Only if stripping every provenance still overflows do we fall
 * back to cutting, and even then `## Now` is kept whole.
 */
export function rootContext(): string {
  const raw = readRoot().trim();
  if (!raw || raw.length <= ROOT_CAP) return raw;

  // The flag is part of what the concierge is charged for, so it comes out of
  // the same budget — a cap the fitter itself overshoots is not a cap.
  const flag = (kind: string, n: number) =>
    `\n…[root over budget: ${kind}. ${n} habit provenance note(s) dropped here — the principles stand; their provenance is in the message log. The nightly rewrite must compress the root.]`;
  const BUDGET = ROOT_CAP - flag('hard-cut', 999).length;

  // Longest provenance first: fewest habits damaged per char reclaimed.
  const lines = raw.split('\n');
  const provenance = /\s*\((?:why:\s*)?[^()]*\d{4}-\d{2}-\d{2}[^()]*\)\s*$/;
  const order = lines
    .map((l, i) => ({ i, m: provenance.exec(l) }))
    .filter((x): x is { i: number; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => b.m[0].length - a.m[0].length);

  let trimmed = 0;
  let out = raw;
  for (const { i } of order) {
    if (out.length <= BUDGET) break;
    lines[i] = lines[i]!.replace(provenance, '');
    trimmed++;
    out = lines.join('\n');
  }
  if (out.length <= BUDGET) return trimmed ? `${out}${flag('fitted', trimmed)}` : out;

  // Still over with every provenance gone: cut, but never into ## Now.
  const nowAt = out.search(/^##\s+Now\s*$/mi);
  if (nowAt === -1) return `${out.slice(0, BUDGET)}${flag('hard-cut', trimmed)}`;
  const kept = '\n…[earlier sections cut to fit — ## Now is kept whole]\n\n';
  const now = out.slice(nowAt);
  const room = Math.max(0, BUDGET - now.length - kept.length);
  return `${out.slice(0, nowAt).slice(0, room)}${kept}${now}${flag('hard-cut', trimmed)}`;
}

/** One section's body (without its heading). Tolerant of heading case/spacing. */
export function rootSection(heading: RootSection): string {
  const raw = readRoot();
  if (!raw) return '';
  const m = new RegExp(`^##\\s+${heading}\\s*$`, 'mi').exec(raw);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = raw.slice(start);
  const next = rest.search(/^##\s/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * Record a standing habit — into the GRAPH, which is where habits now live.
 *
 * This used to append a prose line to root.md's "## How to behave". That
 * section is now RENDERED from the `self/` domain (see `rootBehavior.ts`), so an
 * appended line would be silently overwritten by the next `self/*` write — the
 * habit would appear to land, shape one turn, and vanish. Writing the fact is
 * both the correct home (I1) and the only version that survives.
 *
 * It also closes the loop F3 opened. The migration of twenty-one habits out of
 * prose was finite work; what guaranteed it would come back was this function
 * appending prose every time Mehdi corrected the system. Fixing the intake is
 * what makes the cleanup a one-off rather than a standing chore — mechanism
 * over instruction (I9).
 *
 * `self/companion` is the default home because a habit's finer home is a
 * judgement (`self/grounding`? `self/work-boundaries`? a person node?) and the
 * night is better placed to make it, with `move` and `correct-fact` in hand,
 * than the concierge is mid-conversation. Landing it correctly beats landing it
 * precisely.
 */
export function recordRootHabit(habit: string, trigger: string): { ok: boolean; problem?: string } {
  const today = new Date().toISOString().slice(0, 10);
  const fact = `${habit.trim().replace(/\s+/g, ' ')} (${trigger.trim().replace(/\s+/g, ' ')} — ${today})`;
  const r = applyWrite(
    { op: 'add-fact', id: 'self/companion', fact },
    `Explicit behavioural correction from Mehdi: ${trigger.trim().replace(/\s+/g, ' ')}`,
    'concierge',
  );
  return { ok: r.ok, problem: r.problem };
}

/** Top-level domain folders that carry a _map.md — for tool errors/UX. */
export function listDomains(): string[] {
  return mapFolders();
}

/**
 * Jot an idea as an "Open possibilities" line on a domain's map (round 5 —
 * this replaced the ideas/ ledger). The nightly operator ages these lines:
 * matures what deepens, drops what stays cold. Throws if the domain has no
 * map — the caller shows the available domains.
 */
export function addPossibility(domain: string, idea: string): string {
  const dom = safeKey(domain).split('/')[0]!;
  const p = join(DIR, dom, '_map.md');
  if (!existsSync(p)) {
    throw new Error(`no domain "${dom}" — available: ${mapFolders().join(', ') || '(none)'}`);
  }
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${idea.replace(/\s+/g, ' ').trim()}`;
  const raw = readFileSync(p, 'utf8');
  const m = /^##\s+Open possibilities\s*$/mi.exec(raw);
  const updated = m
    ? // Append at the end of the existing section (before the next ## heading).
      (() => {
        const start = m.index + m[0].length;
        const nextRel = raw.slice(start).search(/^##\s/m);
        const at = nextRel === -1 ? raw.length : start + nextRel;
        return `${raw.slice(0, at).trimEnd()}\n${line}\n${nextRel === -1 ? '' : `\n${raw.slice(at)}`}`;
      })()
    : `${raw.trimEnd()}\n\n## Open possibilities\n${line}\n`;
  writeFileSync(p, updated);
  return `${dom}/_map`;
}

/**
 * Move/rename a note to a new key (path): rewrites its frontmatter key, writes
 * it at the new path, removes the old file, prunes emptied folders, and
 * regenerates the index. Returns the resolved destination key.
 */
export function moveNote(fromKey: string, toKey: string): string {
  const from = resolveKey(fromKey) ?? safeKey(fromKey);
  if (RESERVED_KEYS.has(from)) throw new Error(`"${from}" is reserved (structure, not a note)`);
  const src = join(DIR, `${from}.md`);
  if (!existsSync(src)) throw new Error(`no note at "${fromKey}"`);
  const to = safeKey(toKey);
  if (!to) throw new Error(`unusable target key "${toKey}"`);
  if (RESERVED_KEYS.has(to)) throw new Error(`"${to}" is reserved (structure, not a note)`);
  const { summary, content } = parse(readFileSync(src, 'utf8'));
  mkdirSync(dirname(notePath(to)), { recursive: true });
  writeFileSync(notePath(to), serialize(to, summary, content));
  if (to !== from) {
    rmSync(src);
    pruneEmptyDirs(dirname(src));
  }
  rebuildIndex();
  touchStory(from);
  touchStory(to);
  return to;
}

/** Delete a note; returns the key actually removed, or undefined if nothing was
 *  there (a delete that hit nothing must not read as a successful delete). */
export function deleteNote(key: string): string | undefined {
  const k = resolveKey(key) ?? safeKey(key);
  if (RESERVED_KEYS.has(k)) throw new Error(`"${k}" is reserved (structure, not a note)`);
  const p = join(DIR, `${k}.md`);
  let removed: string | undefined;
  if (existsSync(p)) {
    rmSync(p);
    pruneEmptyDirs(dirname(p));
    removed = k;
  }
  rebuildIndex();
  if (removed) touchStory(removed);
  return removed;
}

/**
 * Prepare the knowledge base at boot: create the dir and — the first time only —
 * migrate any notes still living in SQLite into files. Idempotent.
 */
export function initKnowledge(): void {
  mkdirSync(DIR, { recursive: true });
  if (noteFiles().length === 0) {
    const legacy = allNotesForMigration();
    for (const n of legacy) {
      writeFileSync(notePath(n.key), serialize(safeKey(n.key), n.summary, n.content));
    }
    rebuildIndex();
    if (legacy.length) console.log(`[knowledge] migrated ${legacy.length} notes from sqlite → ${DIR}`);
  } else {
    rebuildIndex();
  }
}

/** The knowledge base's absolute path (a worker/grow agent's working dir). */
/** Chars the root currently occupies, and its budget. The concierge is
 *  injected with the whole root every turn, so going over does not error — it
 *  SILENTLY TRUNCATES THE TAIL, which is ## Now, the most volatile and most
 *  operationally useful section. */
export function rootBudget(): { chars: number; cap: number; over: number } {
  const chars = existsSync(rootPath()) ? readFileSync(rootPath(), 'utf8').length : 0;
  return { chars, cap: ROOT_CAP, over: Math.max(0, chars - ROOT_CAP) };
}

export function knowledgePath(): string {
  return DIR;
}

/** Write a file back into the tree verbatim — the nightly guard's undo for a
 *  node deleted out from under a live root link (see restoreOrphanedMaps). */
export function restoreFile(relPath: string, content: string): void {
  const dest = join(DIR, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

// --- Reconstruction (defrag) support ------------------------------------------

const ARCHIVE = '.archive';

/**
 * Archive the WHOLE tree for RECONSTRUCTION into `.archive/` (dot-dir →
 * invisible to noteFiles/listNotes/linkHealth, but readable by the
 * reconstructing agent): root.md, every domain, and any legacy identity/ or
 * ideas/ folders. An editor stays in the distribution of what it edits; an
 * empty directory forces re-encoding from understanding — that's where
 * compression happens.
 */
export function archiveTreeForReconstruction(): string {
  const dest = join(DIR, ARCHIVE);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(DIR, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'index.md') continue;
    renameSync(join(DIR, e.name), join(dest, e.name));
  }
  rebuildIndex();
  return dest;
}

/** Undo a reconstruction attempt: restore the archived tree (originals win). */
export function restoreArchivedTree(): void {
  const dest = join(DIR, ARCHIVE);
  if (!existsSync(dest)) return;
  // A root.md written by the FAILED reconstruction is partial: drop it unless
  // the archive holds an original to restore over it.
  if (existsSync(rootPath()) && !existsSync(join(dest, ROOT_FILE))) rmSync(rootPath());
  for (const name of readdirSync(dest)) {
    const target = join(DIR, name);
    rmSync(target, { recursive: true, force: true });
    renameSync(join(dest, name), target);
  }
  rmdirSync(dest);
  rebuildIndex();
}

/**
 * A snapshot of the knowledge files (relative path → content), excluding the
 * generated index but including folder `_map.md`s and the root node. `grow`
 * takes one before and after a pass to compute its change-log.
 */
export function snapshotNotes(): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const f of noteFiles(true)) snap[f] = readFileSync(join(DIR, f), 'utf8');
  if (existsSync(rootPath())) snap[ROOT_FILE] = readFileSync(rootPath(), 'utf8');
  return snap;
}
