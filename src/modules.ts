import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { config } from './config.js';
import { functionHits, logModuleCall, noteRetrievalRefs, recordModuleUse } from './db.js';
import { noteCallFriction, normalizeExpression, touchedFunctions } from './friction.js';
import { currentRunId } from './runs.js';
import { SENTINEL } from './moduleProtocol.js';
import { pulse } from './pulse.js';
import { countStoryFollows } from './storyTree.js';

// Story follows are counted here because this is where a call's refs first
// exist — and BEFORE they land on the episode, because the dedupe reads the
// episode's refs as "already scored". The counter and its guards live beside
// the offered set in storyTree.ts (one implementation, two seams).

/**
 * KNOWLEDGE AS AN API (round 9, docs/plans/round-9-modules.md).
 *
 * Round 8 solved STORAGE and left RETRIEVAL untouched: `loadGraph()` reads every
 * row of every domain to answer anything, and the whole tree index is injected
 * into the concierge every turn. Context cost still grows with the size of
 * memory, which is the ceiling every memory system eventually hits.
 *
 * A module is the escape. It is plain TypeScript — exported functions with JSDoc
 * and concrete types — and what an agent reads is the CATALOG: signatures and
 * docs, not data. Context per turn becomes a function of the API surface instead
 * of how much the system remembers.
 *
 * Three things here are mechanical on purpose, because round 8 established that
 * a rule stated as an instruction does not hold:
 *   - a module with no `index.test.ts` is NOT LOADABLE (§6.2), so the night
 *     cannot ship a function it did not test;
 *   - every exported function must carry JSDoc and explicit types, or it never
 *     reaches the catalog and therefore never reaches an agent;
 *   - `tsc --noEmit` is the module compiler, run by `validate()` — tsx executes
 *     TypeScript without checking it, so without this the night can write
 *     type-broken code that only fails when someone calls it.
 */

/** Overridable so a run can be staged (and so the suite never writes the real
 *  tree); defaults to the one place the night is allowed to write. */
export const MODULES_DIR = resolve(process.env.MODULES_DIR || join(config.knowledgeDir, 'modules'));
const SHIM = '_companion.ts';
const REPO_SRC = resolve(new URL('.', import.meta.url).pathname);
const TSX = resolve(REPO_SRC, '..', 'node_modules', '.bin', 'tsx');
const HOST = join(REPO_SRC, 'moduleHost.ts');
/**
 * Every child runs from HERE, never from the module's own directory.
 *
 * `config` resolves `data/companion.db` and `data/knowledge` against
 * process.cwd(), so a child started anywhere else silently gets a DIFFERENT,
 * empty database and an empty tree — and then answers questions from it. That
 * is not a crash; it is confident nonsense, which is worse.
 */
const REPO_ROOT = resolve(REPO_SRC, '..');

/** Wall-clock budget for one module call. */
const CALL_TIMEOUT_MS = Number(process.env.MODULE_TIMEOUT_MS ?? 20_000);
/** Past this, the call is recorded as `slow` friction — the night's cue to look. */
const SLOW_MS = Number(process.env.MODULE_SLOW_MS ?? 4_000);
/** Cap on the JSON handed back to an agent. A module that wants to return the
 *  whole tree has misunderstood what it is for. */
const RESULT_CAP = Number(process.env.MODULE_RESULT_CAP ?? 20_000);
/** Hard memory bound on one module's output, independent of the context cap. */
const RAW_CEILING = 8 * 1024 * 1024;

export interface ModuleFn {
  module: string;
  name: string;
  /** The signature as written, e.g. `openLoops(domain?: string): OpenLoop[]`. */
  signature: string;
  /** First paragraph of the JSDoc — what the catalog shows. */
  doc: string;
  /** Marked `@mutates`: may be called by the day, but only appends to the
   *  journal; see §5. */
  mutates: boolean;
}

export interface ModuleInfo {
  name: string;
  dir: string;
  entry: string;
  fns: ModuleFn[];
  /** Non-empty means the module is refused — the reason is shown, not hidden. */
  problems: string[];
  loadable: boolean;
}

// --- The shim ---------------------------------------------------------------

/**
 * Generate `modules/_companion.ts`: the ONLY bot API a module may import.
 *
 * Modules live under `data/knowledge/` because that is the boundary the night is
 * allowed to write inside (§9), which puts them outside this repo's source tree
 * — and `data/` is instance data that moves (a PVC in prod). A generated shim
 * pins the absolute path at generation time, so relocating the tree is a
 * regeneration rather than a hand-edit of every module.
 *
 * It is also a deliberate seam. The night can only reach what this file
 * re-exports, so widening what modules may touch is an explicit edit HERE, in
 * the bot's own source, which stays proposal-gated.
 */
export function writeShim(): void {
  mkdirSync(MODULES_DIR, { recursive: true });
  const src = REPO_SRC.replace(/\/$/, '');
  const body = `// GENERATED by src/modules.ts — do not edit; it is rewritten on every load.
//
// The bot API a knowledge module is allowed to import. Anything not re-exported
// here is out of reach by construction, which is what keeps "the night may write
// code" from meaning "the night may do anything".
export type { Entity, EntityKind, Diagnostic, Graph } from '${src}/entities.js';
export { loadGraph, reformedDomains, formatDiagnostics, resolveRef } from '${src}/entities.js';
export type { Simplified } from '${src}/simplify.js';
export { simplify, renderMap } from '${src}/simplify.js';
export type { FocusBand, FocusItem } from '${src}/focusView.js';
export { focusView } from '${src}/focusView.js';
export { openEntityChanges, factProvenance, staleFacts, entityWrites } from '${src}/db.js';
export type { EntityWriteRow, FactSeenRow } from '${src}/db.js';
// Round 10: the WRITE path. Widening the seam this far is the whole round —
// until now a module could answer any question about memory and change none of
// it, which is why the graph sat unmodified through three days of live work.
// \`applyWrite\` is safe to expose because its guarantees are structural, not
// contractual: no op can touch probe-owned state, every write re-parses the
// tree and rolls back on any new diagnostic, and every applied write is
// journalled with the reason that justified it.
export { applyWrite, confirmFacts } from '${src}/entityWrite.js';
export type { Write, WriteResult } from '${src}/entityWrite.js';
export { factSha } from '${src}/entities.js';
`;
  const path = join(MODULES_DIR, SHIM);
  // Only write when it changed: a no-op rewrite on every load would make the
  // knowledge tree look dirty in every diff.
  if (!existsSync(path) || readFileSync(path, 'utf8') !== body) writeFileSync(path, body);
}

// --- The catalog ------------------------------------------------------------

/** Pull the exported, documented, fully-typed functions out of a module file. */
function readFns(moduleName: string, entry: string, problems: string[]): ModuleFn[] {
  const text = readFileSync(entry, 'utf8');
  const sf = ts.createSourceFile(entry, text, ts.ScriptTarget.ES2022, true);
  const out: ModuleFn[] = [];

  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    const name = st.name.text;

    const jsdoc = ts.getJSDocCommentsAndTags(st).find(ts.isJSDoc);
    const doc = typeof jsdoc?.comment === 'string' ? jsdoc.comment.trim() : '';
    if (!doc) {
      // Undocumented means uncallable, not merely untidy: the catalog IS the
      // documentation an agent gets, so a function without one cannot be used
      // correctly and must not be advertised.
      problems.push(`${name}: no JSDoc — an undocumented function cannot reach the catalog`);
      continue;
    }
    const untypedParam = st.parameters.find((p) => !p.type);
    if (untypedParam) {
      problems.push(`${name}: parameter \`${untypedParam.name.getText(sf)}\` has no type`);
      continue;
    }
    if (!st.type) {
      problems.push(`${name}: no explicit return type — the catalog shows the signature, so it must say what comes back`);
      continue;
    }

    const params = st.parameters.map((p) => p.getText(sf).replace(/\s+/g, ' ')).join(', ');
    out.push({
      module: moduleName,
      name,
      signature: `${name}(${params}): ${st.type.getText(sf).replace(/\s+/g, ' ')}`,
      doc: doc.split('\n\n')[0]!.replace(/\s+/g, ' ').trim(),
      mutates: (jsdoc?.tags ?? []).some((t) => t.tagName.text === 'mutates'),
    });
  }
  return out;
}

export function readModule(name: string): ModuleInfo {
  ensureTree();
  const dir = join(MODULES_DIR, name);
  const entry = join(dir, 'index.ts');
  const problems: string[] = [];
  let fns: ModuleFn[] = [];

  if (!existsSync(entry)) {
    problems.push('no index.ts');
  } else {
    // A module without tests is not loadable (§6.2). The night rewrites
    // functions the day depends on; untested, that is a coin flip on every
    // retrieval — and "please write tests" is an instruction, so it is a gate.
    const test = join(dir, 'index.test.ts');
    if (!existsSync(test) || readFileSync(test, 'utf8').trim().length < 20) {
      problems.push('no index.test.ts — a module the night can rewrite must carry its own contract tests');
    }
    try {
      fns = readFns(name, entry, problems);
    } catch (e) {
      problems.push(`unparseable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!fns.length && !problems.length) problems.push('exports no documented, fully typed function');
  }

  return { name, dir, entry, fns, problems, loadable: problems.length === 0 };
}

/**
 * Copy the modules this repo SHIPS into the instance tree, when they are not
 * there yet.
 *
 * Modules have to live under `data/knowledge/` — that is the boundary the night
 * writes inside — and `data/` is gitignored instance data, which would leave the
 * first module untracked, unreviewable, and gone with any wipe of the volume.
 * So the repo holds the canonical copy and an instance is seeded from it.
 *
 * Once a module is in the tree it belongs to the night, and silently reverting
 * its work every boot would make the whole "the night maintains this"
 * arrangement a lie. But the original rule — copy only when ABSENT — read that
 * as "never touch it again", and so it also protected copies the night had
 * never opened. On 2026-08-07 the live `entities` module turned out to be two
 * days behind the repo: its `record` doc listed neither `move` nor `retire`, so
 * the night could not reach for ops the write path had already given it, and the
 * 2026-08-04 pass left a NOTE about a misfiled entity it could have moved.
 * Nothing reported this. It had to be found by diffing.
 *
 * So the rule is now stated against EVIDENCE rather than presence: we stamp
 * what we hand over, and on boot the live copy is one of three things —
 * identical (nothing to do), byte-for-byte the stock copy we last wrote (ours,
 * stale, safe to update), or something else (the night's, left alone and
 * reported). Only the middle case is overwritten, and only because the stamp
 * proves nobody else's work is in it.
 */
export function seedModules(): void {
  const seedDir = join(REPO_ROOT, 'modules');
  if (!existsSync(seedDir)) return;
  mkdirSync(MODULES_DIR, { recursive: true });
  for (const e of readdirSync(seedDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const target = join(MODULES_DIR, e.name);
    if (!existsSync(target)) {
      cpSync(join(seedDir, e.name), target, { recursive: true });
      writeStamp(e.name, fingerprint(join(seedDir, e.name)));
      console.log(`[modules] seeded ${e.name} into ${MODULES_DIR}`);
      continue;
    }
    const shipped = fingerprint(join(seedDir, e.name));
    const live = fingerprint(target);
    if (live === shipped) {
      // Identical but unstamped — an instance seeded before stamps existed. Say
      // so now, or the first repo change would make this look like the night's
      // work and be left behind forever, which is the bug this whole mechanism
      // is here to end.
      if (readStamp(e.name) !== shipped) writeStamp(e.name, shipped);
      continue;
    }
    // THE LIVE COPY IS BEHIND, AND THE NIGHT NEVER TOUCHED IT — so "it belongs
    // to the night" is not true of this one, and refusing to update it protects
    // nobody. It is exactly how the instance ran for three days on a module
    // whose `record` doc listed neither `move` nor `retire`: the night could not
    // reach for ops it had, and the 2026-08-04 pass could only leave a NOTE
    // about a misfiled entity it was able to move all along.
    if (readStamp(e.name) === live) {
      cpSync(join(seedDir, e.name), target, { recursive: true, force: true });
      writeStamp(e.name, shipped);
      console.log(`[modules] ${e.name} was the stock copy and out of date — updated from the repo`);
      continue;
    }
    // The night HAS edited this one. Its work outranks ours; say so and stop.
    console.warn(
      `[modules] ${e.name} has diverged from the repo AND been edited in the tree — leaving it alone. ` +
        `Reconcile by hand, then re-stamp; nothing here will overwrite the night's work.`,
    );
  }
}

/**
 * WHAT WE LAST HANDED OVER — the difference between "the night changed this" and
 * "we changed the repo and this is stale".
 *
 * Without it `seedModules` had one rule, "never overwrite", which is right for
 * the first case and silently wrong for the second: a module improved in the
 * repo never reached the running instance, and nothing said so. The stamp is
 * the only thing that makes the two cases distinguishable, so it is written at
 * exactly the moments we copy and never otherwise.
 */
function stampPath(name: string): string {
  // Dot-prefixed, so `listModules` skips it and it can never be read as a module.
  return join(MODULES_DIR, '.seeded', `${name}.txt`);
}

function readStamp(name: string): string | undefined {
  const p = stampPath(name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined;
}

function writeStamp(name: string, fp: string): void {
  mkdirSync(join(MODULES_DIR, '.seeded'), { recursive: true });
  writeFileSync(stampPath(name), fp);
}

/** A content hash of every file in a module directory, path included, so a
 *  rename counts as a change. */
function fingerprint(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), `${rel}/`);
      else h.update(rel).update(readFileSync(join(d, e.name)));
    }
  };
  walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

/**
 * Claim the live copy as ours — the "then re-stamp" the drift warning promises.
 *
 * After reconciling an edited module by hand, this is what tells the next boot
 * that the night's work has been absorbed and the copy is stock again. It is a
 * deliberate, named act, because the alternative is the boot guessing.
 */
export function stampSeeded(name: string): void {
  const target = join(MODULES_DIR, name);
  if (!existsSync(target)) throw new Error(`no live module "${name}" to stamp`);
  writeStamp(name, fingerprint(target));
}

/**
 * Modules whose live copy differs from what the repo ships, and whether the
 * difference is ours or the night's. Reported by the audit — a running instance
 * quietly behind its own source is not something to discover by diffing.
 */
export function moduleDrift(): Array<{ name: string; edited: boolean }> {
  const seedDir = join(REPO_ROOT, 'modules');
  if (!existsSync(seedDir) || !existsSync(MODULES_DIR)) return [];
  const out: Array<{ name: string; edited: boolean }> = [];
  for (const e of readdirSync(seedDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const target = join(MODULES_DIR, e.name);
    if (!existsSync(target)) continue;
    const live = fingerprint(target);
    if (live === fingerprint(join(seedDir, e.name))) continue;
    out.push({ name: e.name, edited: readStamp(e.name) !== live });
  }
  return out;
}

/**
 * Bring the tree up to date once per process: the shim regenerated, the shipped
 * modules seeded. Every entry point runs through here, because a module reached
 * by one path and not another is how "it works from the CLI but not from a turn"
 * happens.
 */
let ensured = false;
function ensureTree(): void {
  if (ensured) return;
  ensured = true;
  writeShim();
  seedModules();
}

/** Every module in the tree, loadable or not. */
export function listModules(): ModuleInfo[] {
  ensureTree();
  if (!existsSync(MODULES_DIR)) return [];
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => readModule(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The catalog an agent reads — signatures and docs, never data.
 *
 * This is the round's whole economic argument in one function: what a turn pays
 * for memory becomes proportional to the API surface, not to how much has been
 * remembered. A module that is refused says so, with its reason, rather than
 * silently not existing.
 */
export function renderCatalog(): string {
  const mods = listModules();
  if (!mods.length) return '';
  const out: string[] = [];
  for (const m of mods) {
    if (!m.loadable) {
      out.push(`### ${m.name} — NOT LOADABLE: ${m.problems.join('; ')}`);
      continue;
    }
    out.push(`### ${m.name}`);
    for (const f of m.fns) out.push(`- ${f.signature}${f.mutates ? '  [@mutates]' : ''}\n    ${f.doc}`);
  }
  return out.join('\n');
}

export function findFn(module: string, fn: string): { info: ModuleInfo; def?: ModuleFn } {
  const info = readModule(module);
  return { info, def: info.fns.find((f) => f.name === fn) };
}

// --- Running ----------------------------------------------------------------

export interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Anything the module wrote to stdout/stderr before returning. */
  logs?: string;
  ms: number;
  truncated?: boolean;
  /** Entity ids the call named or returned — what it TOUCHED (I4). */
  refs?: string[];
}

function spawnHost(
  entry: string,
  request: unknown,
  cap: number = RESULT_CAP,
  /**
   * WHO THIS CALL IS FOR.
   *
   * A module runs in its own process, so everything ambient in the caller —
   * including which run is open and whose it is — is invisible inside it.
   * `record()` had no way to know, so it journalled every write as actor
   * "module" with a null run_id, and `currentRunId('module')` matched the open
   * run of nobody.
   *
   * The cost was silent and severe: a debug-agent turn wrote the graph, the run
   * ledger showed the run with ZERO writes, and "revert this run" was a button
   * that would have reverted nothing while reporting success. The attribution
   * that makes it safe to let an agent write at all was missing exactly where
   * it was being claimed.
   */
  caller?: string,
  /** Refuse every write in the child. Per-CALLER, not per-mode: the nightly
   *  writes while the bot is live and must not be caught by this. */
  readOnly = false,
): Promise<{ raw: string; timedOut: boolean }> {
  return new Promise((res) => {
    const env =
      caller || readOnly
        ? { ...process.env, ...(caller ? { BOT_CALLER: caller } : {}), ...(readOnly ? { BOT_READONLY: '1' } : {}) }
        : process.env;
    const child = spawn(TSX, [HOST, entry], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '';
    // TWO DIFFERENT LIMITS, previously one. This bound is about MEMORY — a
    // runaway module must not grow the bot's heap — and it has to stay well
    // above the context cap, because a result that overshoots must arrive whole
    // enough to be parsed and then truncated with a message that says so.
    // Sharing one number meant an oversized answer came back as
    // "unreadable result envelope" instead of "…narrow the query".
    const ceiling = Math.max(cap * 2, RAW_CEILING);
    const absorb = (b: Buffer) => {
      out = (out + b.toString()).slice(0, ceiling);
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CALL_TIMEOUT_MS);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      res({ raw: out, timedOut });
    };
    child.on('error', (e) => {
      out += `\nfailed to spawn: ${e.message}`;
      settle();
    });
    child.on('close', settle);
    child.stdin.end(JSON.stringify(request));
  });
}

/** Split the host's stdout into what the module logged and what it returned. */
function parseHostOutput(raw: string, timedOut: boolean, started: number): CallResult {
  const ms = Date.now() - started;
  if (timedOut) return { ok: false, error: `timed out after ${CALL_TIMEOUT_MS}ms`, logs: raw.slice(0, 2000), ms };
  const i = raw.lastIndexOf(SENTINEL);
  if (i < 0) return { ok: false, error: `the module produced no result:\n${raw.slice(0, 1000)}`, ms };
  const logs = raw.slice(0, i).trim();
  try {
    const env = JSON.parse(raw.slice(i + SENTINEL.length)) as { ok: boolean; value?: unknown; error?: string };
    return { ...env, logs: logs || undefined, ms };
  } catch (e) {
    // Name the likely cause rather than the symptom. A JSON error at the very
    // END of the payload means the envelope was CUT — the module answered and
    // the answer did not survive the pipe — which is a different bug from a
    // module emitting malformed JSON, and sends you to a different file.
    const body = raw.slice(i + SENTINEL.length);
    const msg = e instanceof Error ? e.message : String(e);
    const truncated = /Unterminated|Unexpected end of (JSON|input)/i.test(msg);
    return {
      ok: false,
      error: truncated
        ? `result envelope was TRUNCATED at ${body.length} chars (${msg}) — the module answered but the answer did not survive the pipe; narrow the query`
        : `unreadable result envelope: ${msg}`,
      logs,
      ms,
    };
  }
}

/** Did this call answer nothing? — `empty` friction, per §4. */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/**
 * Call one module function, out of process.
 *
 * Every failure mode here writes to the friction ledger, which is what makes the
 * night's audit evidence-driven rather than speculative — an error, an empty
 * answer, a slow call and a call to something that does not exist are each a
 * different thing to fix, and none of them requires the agent to say a word.
 */
export async function callModule(
  module: string,
  fn: string,
  args: unknown[] = [],
  sessionKey?: string,
  /**
   * How much result the CALLER can take.
   *
   * The default exists to protect an agent's context window — a function that
   * hands back the whole graph has cost the very tax this layer removes. But the
   * cap belongs to the caller, not to the module: the Atlas
   * (`docs/plans/atlas-visualization.md`) reads through this same API and is a
   * RENDERER, not an agent, so a megabyte of nodes is exactly what it asked for.
   * Agent-facing callers never pass this and keep the small cap.
   */
  resultCap: number = RESULT_CAP,
  /** Refuse writes for this call. The caller decides; the write path enforces. */
  readOnly = false,
): Promise<CallResult> {
  const started = Date.now();
  const { info, def } = findFn(module, fn);

  if (!info.loadable) {
    const error = `module "${module}" is not loadable: ${info.problems.join('; ')}`;
    noteCallFriction('unknown_fn', module, fn, error, sessionKey);
    return { ok: false, error, ms: Date.now() - started };
  }
  if (!def) {
    const error = `no function "${fn}" in ${module}. Available: ${info.fns.map((f) => f.signature).join(' · ')}`;
    // The most valuable row in the ledger after `bypass`: an agent naming a
    // function it expected to exist is a specification, written by the caller.
    noteCallFriction('unknown_fn', module, fn, error, sessionKey);
    return { ok: false, error, ms: Date.now() - started };
  }

  const { raw, timedOut } = await spawnHost(info.entry, { fn, args }, resultCap, sessionKey, readOnly);
  const r = parseHostOutput(raw, timedOut, started);

  if (!r.ok) noteCallFriction('error', module, fn, `${JSON.stringify(args).slice(0, 200)} → ${r.error ?? 'unknown'}`, sessionKey);
  else if (isEmpty(r.value)) noteCallFriction('empty', module, fn, `${JSON.stringify(args).slice(0, 200)} → nothing`, sessionKey);
  if (r.ms > SLOW_MS) noteCallFriction('slow', module, fn, `${JSON.stringify(args).slice(0, 200)} → ${r.ms}ms`, sessionKey);

  // Success is data too — it is what tells the night which functions earn their
  // place in the catalog and which have not been called in weeks (§8).
  recordModuleUse({ module, fn, shape: fn, example: JSON.stringify(args).slice(0, 200), ms: r.ms, ok: r.ok, sessionKey });
  const refs = entityRefs(args, r.value);
  // The per-call row. `recordModuleUse` keeps the running total; this keeps WHO,
  // WHEN and WHAT WAS TOUCHED, which the aggregate overwrites and the pulse drops.
  logModuleCall({ sessionKey, module, fn, args: JSON.stringify(args), ok: r.ok, ms: r.ms, refs, runId: currentRunId(sessionKey) });
  // The same refs onto the open retrieval episode (I4). Attached HERE and not
  // at the tool seam because this is the first place they exist: the tool knows
  // the arguments, and only the call knows which of them resolved to a node.
  countStoryFollows(sessionKey, refs, readOnly);
  if (sessionKey) noteRetrievalRefs(sessionKey, refs);
  pulse('call', `${module}.${fn}(${args.map(brief).join(', ')}) — ${r.ms}ms`, {
    refs,
    loud: !r.ok,
    meta: { module, fn, ms: r.ms, ok: r.ok, sessionKey },
  });

  return { ...capped(r, resultCap), refs };
}

/** One argument, short enough for a ticker line. */
function brief(a: unknown): string {
  const s = typeof a === 'string' ? a : JSON.stringify(a);
  return (s ?? 'undefined').slice(0, 40);
}

/**
 * Which entities a call was ABOUT — so the Atlas can light the nodes a question
 * actually touched rather than just the module that answered it.
 *
 * Deliberately shallow and forgiving: it scans the arguments and the shape of
 * the result for anything that looks like an entity id (`domain/slug`). A miss
 * costs an unlit node, which is why this may never be more than a heuristic —
 * the moment the renderer depends on it being exact, it stops being free.
 */
function entityRefs(args: unknown[], value: unknown): string[] {
  const found = new Set<string>();
  const ID = /^[a-z0-9-]+\/[a-z0-9-]+$/i;
  const walk = (v: unknown, depth: number): void => {
    if (found.size >= 40 || depth > 3) return;
    if (typeof v === 'string') {
      if (ID.test(v)) found.add(v);
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, 60)) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // Only the fields that NAME entities — walking every value would drag in
      // free text that happens to contain a slash.
      for (const k of ['id', 'goal', 'ids', 'path', 'blockedBy', 'members']) walk(o[k], depth + 1);
    }
  };
  for (const a of args) walk(a, 0);
  walk(value, 0);
  return [...found];
}

/** Evaluate an expression with the module's namespace bound to `m`. */
export async function evalInModule(
  module: string,
  expr: string,
  sessionKey?: string,
  readOnly = false,
): Promise<CallResult> {
  const started = Date.now();
  const info = readModule(module);
  if (!info.loadable) {
    const error = `module "${module}" is not loadable: ${info.problems.join('; ')}`;
    noteCallFriction('unknown_fn', module, '(eval)', error, sessionKey);
    return { ok: false, error, ms: Date.now() - started };
  }
  // eval is read-only, but it carries the caller anyway: the guarantee is
  // enforced elsewhere, and a second spawn path that quietly loses attribution
  // is how the first one got it wrong.
  const { raw, timedOut } = await spawnHost(info.entry, { expr }, RESULT_CAP, sessionKey, readOnly);
  const r = parseHostOutput(raw, timedOut, started);
  // An expression that failed is friction on the CATALOG, not on the caller:
  // composition breaking is how a missing or awkward function announces itself.
  if (!r.ok) noteCallFriction('error', module, '(eval)', `${expr.slice(0, 200)} → ${r.error ?? 'unknown'}`, sessionKey);
  if (r.ms > SLOW_MS) noteCallFriction('slow', module, '(eval)', `${expr.slice(0, 200)} → ${r.ms}ms`, sessionKey);

  // An expression that SUCCEEDED is the more valuable record. It is a
  // specification written by the caller: work the API made them do by hand.
  const touched = touchedFunctions(expr, info.fns.map((f) => f.name));
  recordModuleUse({
    module,
    fn: '(eval)',
    shape: touched.join('+') || '(none)',
    example: normalizeExpression(expr),
    ms: r.ms,
    ok: r.ok,
    sessionKey,
  });
  const evalRefs = entityRefs([expr], r.value);
  logModuleCall({ sessionKey, module, fn: '(eval)', args: expr, ok: r.ok, ms: r.ms, refs: evalRefs, runId: currentRunId(sessionKey) });
  countStoryFollows(sessionKey, evalRefs, readOnly);
  if (sessionKey) noteRetrievalRefs(sessionKey, evalRefs);
  pulse('call', `${module} eval: ${expr.slice(0, 60)} — ${r.ms}ms`, {
    refs: evalRefs,
    loud: !r.ok,
    meta: { module, fn: '(eval)', touched, ms: r.ms, ok: r.ok, sessionKey },
  });
  return { ...capped(r), refs: evalRefs };
}

function capped(r: CallResult, cap: number = RESULT_CAP): CallResult {
  if (!r.ok) return r;
  const json = JSON.stringify(r.value ?? null);
  if (json.length <= cap) return r;
  return {
    ...r,
    value: `${json.slice(0, cap)}…[truncated ${json.length - cap} chars — narrow the query]`,
    truncated: true,
  };
}

/** Render a call result for an agent: the value, plus anything that went wrong. */
export function renderResult(r: CallResult): string {
  if (!r.ok) return `ERROR (${r.ms}ms): ${r.error}${r.logs ? `\n--- module output ---\n${r.logs}` : ''}`;
  const body = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
  return `${body}${r.logs ? `\n--- module output ---\n${r.logs}` : ''}`;
}

/**
 * Functions nothing has called — the half of the loop that pushes back (§8).
 *
 * Friction drives ADDITION and nothing drives REMOVAL, so a catalog only ever
 * grows, and a growing catalog becomes the very context tax this round exists to
 * escape. A function nobody has called in weeks is a retirement candidate, the
 * same treatment "Open possibilities" already gets in the tree.
 *
 * `neverCalled` is separated from merely stale on purpose: one has never earned
 * its place, the other has and may simply be seasonal.
 */
export function unusedFunctions(days: number = 21): Array<{ module: string; fn: string; lastCalled?: string; neverCalled: boolean }> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const out: Array<{ module: string; fn: string; lastCalled?: string; neverCalled: boolean }> = [];
  for (const m of listModules()) {
    if (!m.loadable) continue;
    const hits = functionHits(m.name);
    for (const f of m.fns) {
      const h = hits.get(f.name);
      if (!h) out.push({ module: m.name, fn: f.name, neverCalled: true });
      else if (h.last_at < cutoff) out.push({ module: m.name, fn: f.name, lastCalled: h.last_at, neverCalled: false });
    }
  }
  return out;
}

// --- The compiler + the test gate -------------------------------------------

function run(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    const absorb = (b: Buffer) => {
      out = (out + b.toString()).slice(0, 20_000);
    };
    child.stdout.on('data', absorb);
    child.stderr.on('data', absorb);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      out += `\nfailed to spawn: ${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      res({ ok: code === 0, out });
    });
  });
}

export interface Validation {
  module: string;
  ok: boolean;
  problems: string[];
  typecheck?: string;
  tests?: string;
}

/**
 * The gate the night must pass before its work counts: it compiles, and its own
 * tests are green.
 *
 * `tsx` executes TypeScript without type-checking it, so a module can be written,
 * called, and appear to work while carrying a type error that only surfaces on
 * the argument nobody tried. `tsc --noEmit` is therefore not a nicety here —
 * it is the compiler the design asks for ("checks, lints, limits, measures").
 */
export async function validateModule(name: string): Promise<Validation> {
  const info = readModule(name);
  if (info.problems.length && !existsSync(info.entry)) return { module: name, ok: false, problems: info.problems };

  const tsc = resolve(REPO_SRC, '..', 'node_modules', '.bin', 'tsc');
  // `--ignoreConfig` because a module sits under data/, so tsc walks up and
  // finds the BOT's tsconfig — which excludes data/ and would refuse the files
  // it was just handed. A module is compiled on its own terms, strictly.
  const type = await run(
    tsc,
    [
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--skipLibCheck',
      // Named explicitly rather than discovered: the tree can live anywhere
      // (a PVC in prod), and type resolution must not depend on how many
      // directories happen to sit between a module and this repo.
      '--typeRoots',
      resolve(REPO_SRC, '..', 'node_modules', '@types'),
      '--types',
      'node',
      join(info.dir, 'index.ts'),
      join(info.dir, 'index.test.ts'),
    ],
    REPO_ROOT,
  );
  const tests = existsSync(join(info.dir, 'index.test.ts'))
    ? await run(TSX, ['--test', join(info.dir, 'index.test.ts')], REPO_ROOT)
    : { ok: false, out: 'no tests' };

  const problems = [...info.problems];
  if (!type.ok) problems.push('does not typecheck');
  if (!tests.ok) problems.push('tests are red');
  return { module: name, ok: problems.length === 0, problems, typecheck: type.ok ? undefined : type.out, tests: tests.ok ? undefined : tests.out };
}
