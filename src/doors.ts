/**
 * DOORS THE DAY KEPT OPENING — what the day re-learned from disk.
 *
 * On 2026-08-27 a worker ran twenty Bash calls under ~/Projects/brain-fibery;
 * several were `cat scripts/fibery | grep -A 10 "doc-secret"`, `… "resolve_uuid"`,
 * `grep … api-reference.md` — reading the CLI's SOURCE for the document-secret
 * gotcha that the toolkit's own cache/INDEX.md documents. The graph held THAT
 * the CLI exists ([[fibery/cli]]) and nothing of how to operate it, so the day
 * paid for the same lesson four times in one thread, and would again tomorrow.
 *
 * The night could not see any of it: `tool_calls` is written by the day and
 * was read by nobody but auditCli. This module turns that ledger into a
 * FOLD-CANDIDATE block for the nightly digest — the same offer notes get in
 * the story worklist — so the operator decides, per door: fold (a reference
 * entity with the operating facts, or a pointer to the doc's own index — never
 * a copy of it, I1), pointer (one line in the domain story), or ignore.
 *
 * A READ is a door; a RUN is use. `./scripts/fibery show Task 2940` is the tool
 * doing its job and says nothing is missing; `cat scripts/fibery | grep doc-secret`
 * is the day looking for what it should already know (I5: the demand IS the
 * signal; I7: retrievable means it never has to be re-read). A file the day
 * EDITED is work in progress, not a lesson; a directory search is work; the
 * night's own reads while folding are neither.
 *
 * Every decision is recorded (`door_decisions`) so the number that matters can
 * be printed: whether the read count for a folded path falls to zero on the
 * days after the fold. Rows are stamped with the dream that made them; a pass
 * that is cancelled deletes its rows, one that fails leaves them unstamped,
 * and only stamped rows count.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  doorDecisionsBetween,
  doorsSettledBefore,
  hasOfferedDoor,
  supersedeDoorDecision,
  undecidedDoorPaths,
  listStoryNodes,
  recordDoorDecision,
  toolCallsBetween,
  type ToolCallRow,
} from './db.js';
import { loadGraph } from './entities.js';

export interface DoorRead {
  /** Absolute path being read. */
  path: string;
  /** What was looked for (grep/sed/awk programs), ` · `-joined. */
  pattern?: string;
  /** The door is a directory listing (`ls`), the one directory read that is a door. */
  listing?: boolean;
}

export interface BashReads {
  read: DoorRead | null;
  /** Paths the command line WROTE (redirects, tee, sed -i) — never doors. */
  writes: string[];
}

/** Commands whose first path argument is a file being READ, not run. */
const READERS = new Set(['cat', 'grep', 'rg', 'egrep', 'fgrep', 'sed', 'awk', 'head', 'tail', 'less', 'more', 'ls', 'wc', 'find', 'bat']);
/** Commands whose first non-flag argument is a PROGRAM, and the paths follow it. */
const PROGRAM_FIRST = new Set(['grep', 'rg', 'egrep', 'fgrep', 'sed', 'awk']);
/** Per-command flags that consume the next token. */
const ARG_FLAGS: Record<string, Set<string>> = {
  grep: new Set(['-A', '-B', '-C', '-e', '-f', '-m', '--include', '--exclude', '--exclude-dir']),
  rg: new Set(['-A', '-B', '-C', '-e', '-f', '-m', '-g', '-t', '--type', '--glob']),
  sed: new Set(['-e', '-f']),
  awk: new Set(['-F', '-v', '-f']),
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
  find: new Set(['-name', '-iname', '-path', '-type', '-maxdepth', '-mindepth', '-newer', '-mtime', '-size']),
};
for (const k of ['egrep', 'fgrep']) ARG_FLAGS[k] = ARG_FLAGS.grep!;

/** The companion's own repo root — its own files are not doors, they are the machine. */
const OWN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
/** The night's own session key (src/operator.ts NIGHT_SESSION) — its reads
 *  while folding are the fold, not a door, and never a re-read. */
export const NIGHT_SESSION_KEY = 'nightly';

const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Split a command line at unquoted `|`, `||`, `&&`, `;` — a `\|` inside a
 *  grep pattern, quoted or backslashed, is not a pipe. */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? '';
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += cmd[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (cmd[++i] ?? '');
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '|' || c === ';' || c === '\n' || (c === '&' && cmd[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if (cmd[i + 1] === c) i++;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function tokens(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s\\]|\\.)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.map((t) => t.replace(/^\(+/, '').replace(/\)+$/, '')).filter(Boolean);
}

/** `~`, `$HOME`, a base for relative paths; undefined when the path cannot be made absolute. */
function expand(p: string, base?: string): string | undefined {
  let x = p.replace(/^~(?=\/|$)/, homedir()).replace(/^\$HOME(?=\/|$)/, homedir()).replace(/^\$\{HOME\}(?=\/|$)/, homedir());
  if (!x.startsWith('/')) {
    if (!base) return undefined;
    x = `${base}/${x}`;
  }
  const done = x.replace(/\/\.\//g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  // A token still carrying '$' is an unexpanded shell variable (`manifests/$f`
  // in a for-loop) — not a path anyone can open, so not a door.
  return /\$/.test(done) ? undefined : done;
}

const REDIRECT = /^\d?>{1,2}$|^\d?>&\d$|^<{1,3}$/;

/**
 * What a Bash command line READS and WRITES. Pure. `cd X &&` rebases relative
 * paths; the first read path in a pipeline is THE door, and the programs
 * handed to grep/sed/awk anywhere in it are the evidence of what was looked
 * for. Any segment with an output redirection is a write, not a door.
 */
export function bashReads(cmd: string): BashReads {
  let base: string | undefined;
  let rest = cmd.trim();
  const cd = /^\(?\s*cd\s+(\S+)\s*(?:&&|;)\s*/.exec(rest);
  if (cd) {
    base = expand(cd[1] ?? '');
    rest = rest.slice(cd[0].length);
  }
  let path: string | undefined;
  let listing = false;
  const patterns: string[] = [];
  const writes: string[] = [];
  for (const seg of segments(rest)) {
    const raw = tokens(seg.trim());
    // A cd anywhere in the chain moves the base for what follows (`date &&
    // echo … && cd X && cat f` — the cd is rarely the first thing said).
    if (raw[0] === 'cd') {
      const moved = expand(raw[1] ?? '', base);
      if (moved) base = moved;
      continue;
    }
    // Redirections: `> f`, `>f`, `2>/dev/null`, `<<EOF`. An output target is a
    // write; a segment that writes is not reading anything for a lesson.
    const t: string[] = [];
    let writesHere = false;
    for (let k = 0; k < raw.length; k++) {
      const a = raw[k] ?? '';
      const inline = /^(\d?>{1,2})(.+)$/.exec(a);
      if (REDIRECT.test(a)) {
        if (a.startsWith('<')) {
          k++;
          continue;
        }
        const target = raw[++k];
        if (target && !/^&/.test(target) && target !== '/dev/null') {
          const w = expand(target, base);
          if (w) writes.push(w);
          writesHere = true;
        }
        continue;
      }
      if (inline) {
        if (inline[2] !== '/dev/null') {
          const w = expand(inline[2] ?? '', base);
          if (w) writes.push(w);
          writesHere = true;
        }
        continue;
      }
      if (/^\d?<+/.test(a)) continue;
      t.push(a);
    }
    let i = 0;
    while (i < t.length) {
      const w = t[i] ?? '';
      if (w === 'sleep') i += 2;
      else if (/^[A-Z_]+=/.test(w) || w === 'sudo') i += 1;
      else break;
    }
    const cmdName = (t[i] ?? '').replace(/^.*\//, '');
    if (cmdName === 'tee') {
      for (const a of t.slice(i + 1)) if (!a.startsWith('-')) {
        const w = expand(a, base);
        if (w) writes.push(w);
      }
      continue;
    }
    if (!cmdName || !READERS.has(cmdName)) continue;
    const argFlags = ARG_FLAGS[cmdName] ?? new Set<string>();
    const programFirst = PROGRAM_FIRST.has(cmdName);
    let program: string | undefined;
    const paths: string[] = [];
    for (let j = i + 1; j < t.length; j++) {
      const a = t[j] ?? '';
      if (a.startsWith('-') && a !== '-') {
        if (cmdName === 'sed' && (a === '-i' || a.startsWith('-i'))) writesHere = true;
        if (argFlags.has(a)) {
          const v = t[j + 1];
          if ((a === '-e' || (cmdName === 'awk' && a === '-f')) && v !== undefined) program ??= v;
          j++;
        }
        continue;
      }
      if (programFirst && program === undefined) {
        program = a;
        continue;
      }
      paths.push(a);
    }
    if (program && cmdName !== 'find') patterns.push(program.slice(0, 40));
    if (cmdName === 'sed' && writesHere) {
      for (const p of paths) {
        const w = expand(p, base);
        if (w) writes.push(w);
      }
    }
    if (writesHere || path !== undefined) continue;
    const p = paths.find((x) => !/^\d+$/.test(x));
    const resolved = p !== undefined ? expand(p, base) : cmdName === 'ls' ? base : undefined;
    if (resolved) {
      path = resolved;
      listing = cmdName === 'ls';
    }
  }
  const read: DoorRead | null = path
    ? { path, ...(patterns.length ? { pattern: patterns.join(' · ') } : {}), ...(listing ? { listing } : {}) }
    : null;
  return { read, writes };
}

/**
 * What a pass is shown and asked to decide: this window's doors, plus every
 * door a PAST pass was offered and never decided — a skimmed door does not
 * expire, it comes back marked until someone folds, points or ignores it
 * (2026-09-03: night 84 was offered 8 doors and decided 3; cache/INDEX.md
 * stayed a daily read for a week because nothing brought it back).
 */
export function doorsForPass(from: string, to: string): Door[] {
  const doors = doorsSince(from, to);
  const have = new Set(doors.map((d) => d.path));
  const carried = undecidedDoorPaths(from).filter((p) => !have.has(p));
  if (!carried.length) return doors;
  const lookback = toolCallsBetween(shiftDays(from, -LOOKBACK_DAYS), to);
  const wide = groupDoors(lookback, lookback);
  for (const p of carried) {
    const w = wide.find((d) => d.path === p);
    doors.push(w ? { ...w, carried: true } : { path: p, count: 0, sessions: [], patterns: [], days: [], carried: true });
  }
  return doors;
}

/** Back-compat name: the door a Bash line reads, or null. */
export function readTargetOfBash(cmd: string): DoorRead | null {
  return bashReads(cmd).read;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Never a door: the machine's own files, scratch, logs, dependencies. */
function excluded(p: string): boolean {
  return (
    p.includes('/node_modules/') ||
    p.includes('/data/knowledge') ||
    p.includes('/.claude/') ||
    p === OWN_ROOT ||
    p.startsWith(`${OWN_ROOT}/`) ||
    p.startsWith('/tmp/') ||
    p.startsWith('/private/tmp/') ||
    p.startsWith('/var/folders/') ||
    p.startsWith('/dev/') ||
    /\.log$/i.test(p)
  );
}

/** A tool_calls row as a door read, or null when it is a run, a write, a
 *  directory search, or one of ours. Read/Grep/Glob targets are only doors
 *  when they LOOK like a path — friction.ts falls back to the pattern. */
export function doorOf(tool: string, target: string): DoorRead | null {
  let d: DoorRead | null = null;
  if (tool === 'Bash') d = bashReads(target).read;
  else if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const first = target.trim().split(/\s+/)[0] ?? '';
    if (/^(\/|~\/|\$HOME\/)/.test(first) && !/[*?[]/.test(first)) {
      const p = expand(first);
      if (p) d = { path: p };
    }
  }
  if (!d || excluded(d.path)) return null;
  // `grep -r X dir/` is a search over a repo the day is WORKING in, not a
  // lesson re-read; only an explicit listing of a directory is a door.
  if (!d.listing && isDir(d.path)) return null;
  return d;
}

export interface Door {
  path: string;
  /** Offered on a past pass and never decided — shown again until it is. */
  carried?: boolean;
  /** Reads inside the window. */
  count: number;
  /** Distinct sessions that read it, in the window. */
  sessions: string[];
  /** Distinct grep patterns seen (evidence of what was looked for). */
  patterns: string[];
  /** Distinct calendar days (UTC) on which it was read, across the lookback. */
  days: string[];
}

/** Paths the day WROTE in these rows — editor tools and shell redirects alike. */
function writtenPaths(rows: ToolCallRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (WRITERS.has(r.tool)) {
      const p = expand(r.target.trim().split(/\s+/)[0] ?? '');
      if (p) out.add(p);
    } else if (r.tool === 'Bash') {
      for (const w of bashReads(r.target).writes) out.add(w);
    }
  }
  return out;
}

/** Pure grouping: rows in the window (and a wider lookback for `days`) → doors read ≥ min times, top N. */
export function groupDoors(
  windowRows: ToolCallRow[],
  lookbackRows: ToolCallRow[] = windowRows,
  opts: { min?: number; top?: number } = {},
): Door[] {
  const { min = 3, top = 8 } = opts;
  const day = (r: ToolCallRow) => r.session_key !== NIGHT_SESSION_KEY;
  const acc = new Map<string, Door>();
  // A file the day EDITED is work in progress, not a lesson it keeps re-reading.
  const written = writtenPaths(lookbackRows.filter(day));
  for (const r of windowRows.filter(day)) {
    const d = doorOf(r.tool, r.target);
    if (!d || written.has(d.path)) continue;
    const door = acc.get(d.path) ?? { path: d.path, count: 0, sessions: [], patterns: [], days: [] };
    door.count++;
    const s = r.session_key ?? '(none)';
    if (!door.sessions.includes(s)) door.sessions.push(s);
    if (d.pattern && !door.patterns.includes(d.pattern) && door.patterns.length < 6) door.patterns.push(d.pattern);
    acc.set(d.path, door);
  }
  for (const r of lookbackRows.filter(day)) {
    const d = doorOf(r.tool, r.target);
    const door = d && acc.get(d.path);
    if (!door) continue;
    const dd = r.at.slice(0, 10);
    if (!door.days.includes(dd)) door.days.push(dd);
  }
  return [...acc.values()]
    .filter((d) => d.count >= min)
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, top);
}

const LOOKBACK_DAYS = 7;

function shiftDays(iso: string, days: number): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Doors read ≥3 times in [from, to], with the 7-day day-count for the evidence bar. */
export function doorsSince(from: string, to: string): Door[] {
  return groupDoors(toolCallsBetween(from, to), toolCallsBetween(shiftDays(from, -LOOKBACK_DAYS), to));
}

/**
 * Text from the ledger goes into a prompt: a grep pattern is whatever the day
 * typed, and a newline in it is a line the operator would read as its own.
 * One line, no control characters, fenced.
 */
export function fence(s: string, max = 60): string {
  const flat = s
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return `\`${flat || '-'}\``;
}

/** What the graph and the story already say about a path, by its last two segments. */
function known(path: string, graph: ReturnType<typeof loadGraph> | undefined): string[] {
  const parts = path.split('/').filter(Boolean);
  const terms = [...new Set(parts.slice(-2).map((s) => s.replace(/\.[a-z]+$/i, '')).filter((s) => s.length > 3))];
  const out: string[] = [];
  const stories = listStoryNodes();
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const term of terms) {
    const re = new RegExp(`\\b${esc(term)}\\b`, 'i');
    for (const n of stories) {
      if (out.length >= 2) break;
      const sentence = n.text.split(/(?<=[.!?])\s+/).find((s) => re.test(s));
      if (sentence) out.push(`${n.id}: "${sentence.trim().slice(0, 90)}…"`);
    }
    if (!graph) continue;
    let hits = 0;
    for (const e of graph.entities.values()) {
      if (hits >= 2) break;
      if (re.test([e.id, ...e.aka, ...e.facts, e.note ?? ''].join(' '))) {
        out.push(`[[${e.id}]]`);
        hits++;
      }
    }
  }
  return [...new Set(out)].slice(0, 3);
}

const BLOCK_CHAR_CAP = 2400; // ≈600 tokens, header included

const HEADER =
  `## Doors the day kept opening — files it RE-READ from disk (fold candidates)\n` +
  `A read is the day looking for what memory should have handed it; a run is not listed. For EACH door call doorDecision with the path exactly as printed: ` +
  `FOLD — write or extend a reference entity in the owning domain with the operating facts (open the file if you must; NEVER copy an external doc — when the doc has its own index, a pointer to it IS the fold); ` +
  `POINTER — one keyword-bearing line in the domain story naming where the answer lives; ` +
  `IGNORE — say why. Evidence bar as for habits: a door seen on ONE day earns at most a pointer; a fold needs two different days. ` +
  `Decide EVERY door listed — an undecided door comes back tomorrow, marked as carried.\n`;

/**
 * The digest section, PURE — nothing is recorded here, because the digest is
 * built before the pass knows whether it will run (a quiet window skips it).
 * Empty string when nothing qualifies: a quiet day is not a section.
 */
export function doorsBlock(from: string, to: string, doors: Door[] = doorsForPass(from, to)): string {
  if (!doors.length) return '';
  let graph: ReturnType<typeof loadGraph> | undefined;
  try {
    graph = loadGraph();
  } catch {
    /* a graph that cannot load tonight is the audit's problem, not this block's */
  }
  const lines = doors.map((d) => {
    const k = known(d.path, graph);
    return (
      `- ${fence(d.path, 200)} — read ${d.count}× by ${d.sessions.map((s) => fence(s, 30)).join(', ')}; seen on ${d.days.length} day(s) in the last ${LOOKBACK_DAYS}` +
      (d.carried ? ' — offered on an earlier pass, STILL UNDECIDED: decide it tonight' : '') +
      (d.patterns.length ? `\n  looked for: ${d.patterns.map((p) => fence(p)).join(' · ')}` : '') +
      `\n  graph already says: ${k.length ? k.join(' | ') : 'nothing'}`
    );
  });
  let cut = 0;
  while (HEADER.length + lines.join('\n').length > BLOCK_CHAR_CAP && lines.length > 1) {
    lines.pop();
    cut++;
  }
  return HEADER + lines.join('\n') + (cut ? `\n(truncated: ${cut} more door(s) below the cap — the ledger has them)` : '') + '\n\n';
}

/** The doors the running pass was shown — what doorDecision accepts. */
let offeredThisPass = new Set<string>();

/**
 * Record what the night is about to be SHOWN — called once the prompt is
 * really being sent, never from the digest builder. Idempotent per
 * (path, window): a pass that fails and re-renders the same window does not
 * offer the door twice.
 */
export function offerDoors(from: string, to: string, doors: Door[] = doorsForPass(from, to)): Set<string> {
  offeredThisPass = new Set(doors.map((d) => d.path));
  const windowKey = `window:${from}`;
  for (const d of doors) {
    if (hasOfferedDoor(d.path, windowKey)) continue;
    recordDoorDecision(d.path, 'offered', `${windowKey} ${d.count} reads, ${d.days.length} day(s)`);
  }
  return offeredThisPass;
}

export function offeredDoors(): ReadonlySet<string> {
  return offeredThisPass;
}

export type DoorDecision = 'fold' | 'pointer' | 'ignore';

/** A decision on a door the pass was shown, or the reason it was refused. */
export function decideDoor(path: string, decision: DoorDecision, note: string): { ok: true } | { ok: false; problem: string } {
  const p = expand(path.trim()) ?? path.trim();
  if (!offeredThisPass.has(p)) {
    const valid = [...offeredThisPass];
    return {
      ok: false,
      problem: `"${path}" was not offered this pass. Valid doors: ${valid.length ? valid.join(', ') : '(none — the block was empty)'}`,
    };
  }
  supersedeDoorDecision(p);
  recordDoorDecision(p, decision, note);
  return { ok: true };
}

export interface DoorsTally {
  offered: number;
  folded: number;
  pointed: number;
  ignored: number;
  /** Decision rows never stamped with a dream — a pass that failed after deciding. */
  unlanded: number;
  /** Paths folded/pointed BEFORE the window that the day still read in it, with counts. */
  reReads: Array<{ path: string; n: number }>;
}

/**
 * The cycle's DOORS line. `reReads` is the number that matters: a path the
 * night folded or pointed that the day still opened afterwards means the fold
 * did not take — the reference is wrong, unfindable, or the story never says
 * it exists. Only decisions a dream STAMPED count; the night's own reads never do.
 */
export function doorsTally(from: string, to: string): DoorsTally {
  const rows = doorDecisionsBetween(from, to);
  const landed = rows.filter((r) => r.dream_id !== null);
  const count = (d: string) => landed.filter((r) => r.decision === d).length;
  const reads = new Map<string, number>();
  for (const r of toolCallsBetween(from, to)) {
    if (r.session_key === NIGHT_SESSION_KEY) continue;
    const d = doorOf(r.tool, r.target);
    if (d) reads.set(d.path, (reads.get(d.path) ?? 0) + 1);
  }
  const reReads = doorsSettledBefore(from)
    .map((s) => ({ path: s.path, n: reads.get(s.path) ?? 0 }))
    .filter((x) => x.n > 0);
  return {
    offered: count('offered'),
    folded: count('fold'),
    pointed: count('pointer'),
    ignored: count('ignore'),
    unlanded: rows.filter((r) => r.dream_id === null && r.decision !== 'offered').length,
    reReads,
  };
}
