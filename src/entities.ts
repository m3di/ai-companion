import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { allEntityState, rebuildEntityIndex, syncFactProvenance } from './db.js';
import { checkCommandAllowed } from './focus.js';

/** The identity of a fact is its text. Correcting a fact therefore starts a new
 *  clock, which is the intended reading: a corrected fact is a new claim. */
export function factSha(fact: string): string {
  return createHash('sha1').update(fact).digest('hex').slice(0, 16);
}

/**
 * ENTITY RECORDS (round 8, docs/plans/round-8-knowledge.md) — knowledge as a
 * timeless index of entities, each carrying its own clock.
 *
 * Round 7's addendum tried to keep knowledge honest with a WRITING RULE ("would
 * this sentence still be true after the PR merges?"). A rule is not a reform:
 * nothing validated it and nothing could be computed over its output, so it
 * decayed exactly like the mandate before it. Prose cannot be simplified — only
 * a typed graph can.
 *
 * So this module is the teeth, not the schema. It defines a RESTRICTED grammar
 * (deliberately not YAML: the closed grammar IS the formal language, and a
 * hand-rolled parser can refuse what js-yaml would happily accept), parses each
 * domain's `entities.md`, and LINTS with fatal rules. Every diagnostic carries a
 * file and a line number, because the reformer's retry loop is only as good as
 * the errors it gets back.
 *
 * The split that makes an entity work, and why each part is where it is:
 *   id · kind · aka · facts   never perish — the timeless index
 *   probe · state · state_at  perish continuously and maintain THEMSELVES
 *   chain · edges             the route back into the traces, and the shape
 *                             everything downstream (simplify, focus) computes on
 *
 * Files stay the source of truth (authored, git-diffable, survivable). SQLite is
 * a DERIVED index rebuilt on every parse so graph queries are SQL.
 */

const DIR = config.knowledgeDir;

/** One record per entity; a domain's file is a stream of them. */
export interface Entity {
  id: string;
  domain: string;
  kind: EntityKind;
  aka: string[];
  facts: string[];
  edges: Record<string, string[]>;
  probe?: string;
  /** Free text as the probe last saw it. NEVER hand-written. */
  state?: string;
  state_at?: string;
  /**
   * What the NIGHT saw — the observed twin of `state` (round 10).
   *
   * `state` is probe-owned and mechanically enforced as such: only `prober.ts`
   * may write it, and the lint that keeps that true is what caught the 2026-07-28
   * corruption. That rule is worth keeping, and it had a cost nobody priced: an
   * entity whose truth changed for a reason no command can answer — a decision
   * reversed, a client list replaced, a hold lifted in a meeting — had NOWHERE to
   * land. So it landed in prose, and the graph stayed a snapshot of the day it
   * was reformed.
   *
   * This is that missing home. Written only through `record()`, always dated,
   * always journalled with the evidence that justified it. The prober never
   * reads or writes it, so the two clocks cannot corrupt each other.
   */
  observed?: string;
  observed_at?: string;
  /** Regex tested against `state`; a match means the entity has closed. */
  closed_when?: string;
  status: 'open' | 'closed' | 'n/a';
  /**
   * Open, but deliberately nobody's move. Orthogonal to `status`, which the
   * prober derives — dormancy is a human judgment a command cannot answer.
   *
   * The first cut had no way to say it, and it showed: `personal/sideapp-sunset`
   * reads "sunsetting, hands-off operationally, sunset plan (deferred)" — truly
   * open, truly not anyone's move — and landed at the TOP of the focus set,
   * because open + actor was the only vocabulary available. Deferred work has to
   * be able to stay in the index without shouting.
   */
  dormant: boolean;
  /** Who must act next — drives focus tier 1 ("Mehdi is the actor"). */
  actor?: string;
  /** A goal node terminates a critical path. */
  goal: boolean;
  chain: string[];
  note?: string;
  /** Source positions, for diagnostics. */
  file: string;
  line: number;
  factsLine: number;
  edgesLine: number;
}

export const ENTITY_KINDS = [
  'system',
  'component',
  'constraint',
  'task',
  'pr',
  'person',
  'process',
  'step',
  'decision',
  'project',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * The closed edge vocabulary. `blocks`/`blocked-by` are inverses and get
 * normalized both ways in the derived index, so a dependency written from
 * either end produces the same graph — the simplifier and the focus projection
 * must never have to ask which direction the author happened to pick.
 */
export const EDGE_RELS = [
  'blocks',
  'blocked-by',
  'part-of',
  'owned-by',
  'tracked-by',
  'found-in',
  'implements',
  'supersedes',
  'evidence-for',
  'relates-to',
] as const;

/**
 * Relations the loader COMPUTES. Deliberately not in `EDGE_RELS`, which is the
 * authorable vocabulary — the parser, the write path and the reformer's prompt
 * all validate against that list, so keeping these out makes them unwritable in
 * every one of those places at once, without a rule anyone has to remember.
 *
 * `acted-by` is the first, and it is the graph's centre (M0). 56 of 153
 * entities carry `actor: mehdi`; eleven `person` entities exist; and the two
 * were joined nowhere, so the most-pointed-at node in the system was a bare
 * string the renderer could not follow. That is the empty middle of the Atlas.
 * Deriving it rather than migrating it is invariant I2: the hub cannot drift
 * from the field it is computed from, because it is recomputed on every load.
 */
export const DERIVED_RELS = ['acted-by'] as const;
/** What an author may write. A derived relation is not in here, by design. */
export type AuthoredRel = (typeof EDGE_RELS)[number];
export type EdgeRel = AuthoredRel | (typeof DERIVED_RELS)[number];

/**
 * Where every `person` lives, and the only domain that is named in code.
 *
 * People are the graph's connective tissue — `actor` points at one from 66
 * entities across nine domains — so filing them inside a work domain makes the
 * hub look like that domain's leaf. One home, pointed at from everywhere.
 */
export const PEOPLE_DOMAIN = 'people';

/** The one gate every authoring path runs through — parser, write op, reformer. */
export function isAuthoredRel(rel: string): rel is AuthoredRel {
  return (EDGE_RELS as readonly string[]).includes(rel);
}

const INVERSE: Partial<Record<EdgeRel, EdgeRel>> = { blocks: 'blocked-by', 'blocked-by': 'blocks' };

const SCALAR_FIELDS = [
  'id', 'kind', 'probe', 'state', 'state_at', 'observed', 'observed_at',
  'closed_when', 'status', 'dormant', 'actor', 'goal', 'note',
];
const LIST_FIELDS = ['aka', 'facts', 'chain'];

export interface Diagnostic {
  file: string;
  line: number;
  id?: string;
  /**
   * A machine-readable class, set only where a caller must ACT on the kind of
   * failure rather than merely report it. `state-drift` is the one that matters:
   * the file and the prober's table disagree, which is repairable by rewriting
   * the file from the table — unlike a grammar error, which needs an author.
   */
  code?: 'state-drift';
  message: string;
}

// --- Grammar ---------------------------------------------------------------

interface RawField {
  value?: string;
  list?: string[];
  map?: Map<string, string[]>;
  /** Line the field was written on — diagnostics point HERE, not at the record
   *  fence, so the reformer's retry can find what to fix. */
  line: number;
}

interface RawRecord {
  fields: Map<string, RawField>;
  line: number;
}

/**
 * Unwrap a quoted scalar.
 *
 * A double-quoted value is read as a JSON string, so escapes survive. That is
 * not decoration: `renderRecords` has to quote any fact containing `: `, and a
 * real fact reads `Two edits precede sending — add "Employment: full-time…"`.
 * With a naive strip, rendering the view and reading it back turned every inner
 * quote into a literal backslash-quote — the data silently degrading each time
 * it passed through its own presentation layer.
 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1);
  return t;
}

/**
 * `[a, "b c", d]` → ['a','b c','d']. Inline lists keep short records readable.
 *
 * Escapes are honoured, and that is not cosmetic: `renderRecords` writes `aka`
 * and `chain` as inline lists via JSON.stringify, so an alias containing a quote
 * came back with its escapes literal — the same silent degradation the block
 * form already had, one code path over. Found by the round-trip test, which is
 * the only thing that can find it.
 */
function parseInlineList(s: string): string[] {
  const inner = s.trim().slice(1, -1).trim();
  if (!inner) return [];
  // Split on top-level commas, keeping every item VERBATIM (quotes included),
  // then hand each to the same unquote() a scalar goes through. One decoder,
  // one behaviour — the bug was two code paths disagreeing about escapes.
  const items: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) cur += ch + inner[++i]!;
      else {
        cur += ch;
        if (ch === quote) quote = '';
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map(unquote).filter(Boolean);
}

/**
 * Split a file into records on `---` fences and parse each into raw fields.
 *
 * Indentation is meaningful to exactly two levels: a bare `key:` opens either a
 * block list (`  - item`) or, for `edges` only, a map of lists (`  rel:` then
 * `    - id`). Anything deeper is a syntax error rather than a silent
 * reinterpretation — the whole point is that malformed input is REFUSED.
 */
function parseRecords(text: string, file: string, errors: Diagnostic[]): RawRecord[] {
  const lines = text.split('\n');
  const records: RawRecord[] = [];
  let cur: RawRecord | undefined;
  let openList: string[] | undefined;
  let openMap: Map<string, string[]> | undefined;
  let openMapKey: string | undefined;

  const err = (line: number, message: string) => errors.push({ file, line, message });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === '---') {
      // A fence both closes the open record and opens the next one.
      cur = { fields: new Map(), line: lineNo };
      records.push(cur);
      openList = undefined;
      openMap = undefined;
      openMapKey = undefined;
      continue;
    }
    if (!cur) {
      err(lineNo, `content before the first \`---\` fence: ${trimmed.slice(0, 60)}`);
      continue;
    }

    const indent = raw.length - raw.trimStart().length;

    // A list item belongs to whatever container is open at its indent.
    if (trimmed.startsWith('- ')) {
      const item = unquote(trimmed.slice(2));
      if (indent >= 4 && openMap && openMapKey) openMap.get(openMapKey)!.push(item);
      else if (openList) openList.push(item);
      else err(lineNo, `list item with no open field: ${trimmed.slice(0, 60)}`);
      continue;
    }

    const m = trimmed.match(/^([a-z_-]+):\s*(.*)$/);
    if (!m) {
      err(lineNo, `not a \`key: value\` line: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const key = m[1]!;
    const rest = m[2]!.trim();

    // Nested key under `edges:` — a relation name opening its own list.
    if (indent >= 2 && openMap) {
      const list = rest.startsWith('[') ? parseInlineList(rest) : [];
      openMap.set(key, list);
      openMapKey = rest.startsWith('[') ? undefined : key;
      continue;
    }

    openList = undefined;
    openMap = undefined;
    openMapKey = undefined;

    if (cur.fields.has(key)) err(lineNo, `duplicate field \`${key}\``);

    if (key === 'edges') {
      if (rest) {
        err(lineNo, '`edges:` takes a nested map of relations, not an inline value');
        continue;
      }
      openMap = new Map();
      cur.fields.set(key, { map: openMap, line: lineNo });
    } else if (LIST_FIELDS.includes(key)) {
      if (rest.startsWith('[')) {
        cur.fields.set(key, { list: parseInlineList(rest), line: lineNo });
      } else if (rest) {
        err(lineNo, `\`${key}\` is a list — use \`[a, b]\` or indented \`- \` items`);
      } else {
        const list: string[] = [];
        openList = list;
        cur.fields.set(key, { list, line: lineNo });
      }
    } else if (SCALAR_FIELDS.includes(key)) {
      if (!rest) err(lineNo, `\`${key}\` needs a value`);
      cur.fields.set(key, { value: unquote(rest), line: lineNo });
    } else {
      err(lineNo, `unknown field \`${key}\` (known: ${[...SCALAR_FIELDS, ...LIST_FIELDS, 'edges'].join(', ')})`);
    }
  }
  return records.filter((r) => r.fields.size > 0);
}

// --- Lint ------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;

/**
 * The temporal test, enforced instead of requested. Round 7's addendum asked
 * the writer "would this still be true after the task closes?"; these patterns
 * are what that question catches in practice, and a fact that trips one is
 * REJECTED rather than merely discouraged.
 */
// A bare word list does not work here, and testing proved it: "publishing the
// vacancy starts the statutory WAITING window" and "must stay OPEN for a fixed
// period" are timeless RULES that merely contain status words. A validator that
// cries wolf trains the writer to fight it, which is worse than no validator.
// So a fact trips only when it ASSERTS state — a copula plus a status word, or
// a phrase that cannot mean anything else.
// A RULE describes how the world always works; a STATE describes how it happens
// to be. The copula test alone cannot tell them apart — "must stay open for a
// fixed period" and "branches are merged via squash" are rules that read like
// status. These markers say "this sentence is generic", and they suppress the
// copula rule (never the unambiguous ones). Erring toward a false negative is
// deliberate: the reformer is also TOLD the rule, so lint is the backstop, and a
// backstop that cries wolf gets worked around.
const GENERIC =
  /\b(must|should|shall|can|could|may|might|always|never|every|each|any|whenever|typically|generally|usually|by default|via|in order to|required|requires?)\b/i;
// PAST TENSE IS HISTORY, AND HISTORY IS TIMELESS. Two real reform runs were
// rejected over "report_ingest_mode was dropped, replaced by a ClientReport" and
// "shipped in PR #91, merged to main by alizshow" — both permanently true, both
// exactly the durable knowledge the tree exists to hold. The real test is not
// "does this mention a status" but "will this sentence ever become FALSE?" A
// completed past event never does; a present-tense status does. So the copula
// list carries only present and future forms.
const STATE_ASSERT =
  /\b(is|are|has been|have been|will be|remains?|stays?)\s+(not\s+|now\s+)?(done|open|closed|merged|blocked|pending|filed|shipped|landed|deployed|parked|dropped|resolved|fixed|in progress|underway|live)\b/i;
const STATE_ALWAYS = [
  // "already" is NOT here on purpose: a real run was rejected over "external_id
  // already exists on Affiliate with a find-or-create by it", which is a
  // permanent design fact, and over an open question that used the word in
  // passing. It marks emphasis far more often than status.
  /\b(not done|next step|as of|so far|to date|currently|at present|for now|right now|no longer|just landed|just merged|in progress|wip|todo|tbd)\b/i,
  /\b(waiting|blocked|parked|pending)\s+(on|for)\b/i,
  // Bookkeeping about where the work is tracked. This is exactly what the
  // `tracked-by` edge is for — a fact that names a ticket is a pointer wearing
  // a fact's clothes.
  /\b(filed as|tracked as|reopened|unassigned|re-?assigned)\b/i,
  /\b(today|yesterday|tomorrow|last week|this week|next week|recently|soon|upcoming)\b/i,
];
// An ABSOLUTE date is a historical anchor, not state: "epic #2772, created
// 2026-07-20" and "merged to main 2026-07-05" stay true forever, and rejecting
// them cost two whole reform runs. What genuinely rots is time measured FROM
// NOW — "~3 weeks left", "2 days ago" — because the sentence quietly changes
// meaning every day nobody rewrites it.
const DATE_LIKE = [
  /(~\s*\d+|\b\d+)\s*(days?|weeks?|months?|mo|years?)\s*(left|remaining|ago|from now|out|to go)\b/i,
  /\b(left|remaining)\s*:?\s*~?\s*\d+\s*(days?|weeks?|months?|years?)\b/i,
  /\b(next|last|this)\s+(week|month|quarter|year)\b/i,
];

function firstMatch(patterns: RegExp[], text: string): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return undefined;
}

function lintFacts(e: Entity, out: Diagnostic[]): void {
  for (const f of e.facts) {
    const sw = firstMatch(GENERIC.test(f) ? STATE_ALWAYS : [STATE_ASSERT, ...STATE_ALWAYS], f);
    if (sw) {
      out.push({
        file: e.file,
        line: e.factsLine,
        id: e.id,
        message: `fact ASSERTS state ("${sw}") — facts are timeless; move this to the entity's state/probe or drop it: "${f.slice(0, 70)}"`,
      });
    }
    const dl = firstMatch(DATE_LIKE, f);
    if (dl) {
      out.push({
        file: e.file,
        line: e.factsLine,
        id: e.id,
        message: `fact is anchored in TIME ("${dl}") — facts are timeless; a date belongs in state_at or chain: "${f.slice(0, 70)}"`,
      });
    }
  }
}

/**
 * A chain entry naming this entity (or any entity path) is not a route back —
 * it points at the record you are already reading. The real run emitted
 * `chain: [msg#4193, …, "personal/sideapp-sunset"]`, where the last entry was
 * the old prose note key: self-referential, and useless to a future agent.
 * Shared by the record grammar, the data loader and the `correct-chain` op —
 * one rule, every door (the round-trip caught
 * `affiliate-app/stage-email-recipient-rule.md` on 2026-11-12 only because the
 * data loader did not ask this).
 */
export function chainEntryProblem(c: string, id: string, domain: string): string | undefined {
  if (c === id || c === `[[${id}]]` || (c.startsWith(`${domain}/`) && !c.includes(':') && !c.includes('#'))) {
    return `chain entry "${c}" points at an entity, not at a trace — a chain is msg#/episode# ids, files, PRs or urls`;
  }
  return undefined;
}

function buildEntity(rec: RawRecord, file: string, domain: string, out: Diagnostic[]): Entity | undefined {
  const g = (k: string) => rec.fields.get(k)?.value;
  const gl = (k: string) => rec.fields.get(k)?.list ?? [];
  /** Point at the field that is actually wrong, falling back to the record's
   *  fence when the complaint is about a field that is MISSING. */
  const at = (...keys: string[]) => keys.map((k) => rec.fields.get(k)?.line).find((l) => l !== undefined) ?? rec.line;
  const err = (message: string, id?: string, line = rec.line) => out.push({ file, line, id, message });

  const id = g('id');
  if (!id) {
    err('record has no `id`');
    return undefined;
  }
  if (!ID_RE.test(id)) {
    err(`id "${id}" is not a kebab path (e.g. affiliate-app/tracker-code-uniqueness)`, id, at('id'));
    return undefined;
  }
  if (!id.startsWith(`${domain}/`)) {
    err(`id "${id}" does not live in its own domain — it is in ${domain}/entities.md`, id, at('id'));
  }

  const kind = g('kind');
  if (!kind || !ENTITY_KINDS.includes(kind as EntityKind)) {
    err(`kind "${kind ?? '(missing)'}" is not one of: ${ENTITY_KINDS.join(', ')}`, id, at('kind'));
    return undefined;
  }

  const edges: Record<string, string[]> = {};
  const rawEdges = rec.fields.get('edges')?.map;
  if (rawEdges) {
    for (const [rel, targets] of rawEdges) {
      if (!isAuthoredRel(rel)) {
        err(`unknown edge relation "${rel}" (known: ${EDGE_RELS.join(', ')})`, id, at('edges'));
        continue;
      }
      // An empty relation is no relation. Keeping it would put `{"relates-to":[]}`
      // in the data and `{}` back out of the view — a difference with no meaning
      // that still makes the round-trip inexact, and an inexact round-trip is
      // how you stop trusting the check that would catch a real one.
      if (!targets.length) continue;
      edges[rel] = targets;
    }
  }

  const probe = g('probe');
  if (probe && !checkCommandAllowed(probe)) {
    err(`probe is not allowlisted (it runs outside the sandbox): ${probe.slice(0, 70)}`, id, at('probe'));
  }

  const chain = gl('chain');
  if (!chain.length) {
    err('chain is empty — an entity with no route back to the traces is a dead end', id, at('chain'));
  }
  for (const c of chain) {
    const problem = id ? chainEntryProblem(c, id, domain) : undefined;
    if (problem) err(problem, id, at('chain'));
  }

  const state = g('state');
  const stateAt = g('state_at');
  if ((state === undefined) !== (stateAt === undefined)) {
    err('state and state_at must appear together (both are written by the prober)', id, at('state', 'state_at'));
  }

  const declared = g('status');
  if (declared && !['open', 'closed', 'n/a'].includes(declared)) {
    err(`status "${declared}" is not one of: open, closed, n/a`, id, at('status'));
  }
  // An entity with a probe does not get to declare its own status: the prober
  // derives it from `state` via `closed_when`. Letting both write it is how the
  // hand-written value and the machine-derived one silently diverge.
  if (probe && declared) {
    err('status is derived from the probe (via closed_when) — remove it, or remove the probe', id, at('status'));
  }
  const closedWhen = g('closed_when');
  if (closedWhen && !probe) err('closed_when has no meaning without a probe', id, at('closed_when'));
  if (closedWhen) {
    try {
      new RegExp(closedWhen, 'i');
    } catch {
      err(`closed_when is not a valid regex: ${closedWhen.slice(0, 60)}`, id, at('closed_when'));
    }
  }

  const status: Entity['status'] = probe
    ? state && closedWhen && new RegExp(closedWhen, 'i').test(state)
      ? 'closed'
      : 'open'
    : ((declared as Entity['status']) ?? 'n/a');

  const goalRaw = g('goal');
  if (goalRaw && !['true', 'false'].includes(goalRaw)) err(`goal must be true or false, got "${goalRaw}"`, id, at('goal'));
  const dormantRaw = g('dormant');
  if (dormantRaw && !['true', 'false'].includes(dormantRaw)) err(`dormant must be true or false, got "${dormantRaw}"`, id, at('dormant'));
  if (dormantRaw === 'true' && g('actor')) {
    err('an entity nobody is moving cannot also name the person moving it — drop `actor` or drop `dormant`', id, at('dormant'));
  }

  const e: Entity = {
    id,
    domain,
    kind: kind as EntityKind,
    aka: gl('aka'),
    facts: gl('facts'),
    edges,
    probe,
    state,
    state_at: stateAt,
    observed: g('observed'),
    observed_at: g('observed_at'),
    closed_when: closedWhen,
    status,
    actor: g('actor'),
    goal: goalRaw === 'true',
    dormant: dormantRaw === 'true',
    chain,
    note: g('note'),
    file,
    line: rec.line,
    factsLine: at('facts'),
    edgesLine: at('edges'),
  };
  lintFacts(e, out);
  return e;
}

// --- Tree-wide load --------------------------------------------------------

export interface Graph {
  entities: Map<string, Entity>;
  /** Normalized edge triples, inverses materialized. */
  edges: Array<{ src: string; rel: EdgeRel; dst: string }>;
  errors: Diagnostic[];
}

/**
 * DATA LAYER (Mehdi, 2026-07-28): "let's divide this presentation into two
 * parts — one data, the raw bytes themselves just living on disc; one logic, of
 * presenting it."
 *
 * `entities.jsonl` is the data: one entity per line, appendable, streamable,
 * and cheap to read a slice of. `entities.md` is a generated VIEW of it, like
 * `_map.md` — readable, diffable, never authoritative.
 *
 * The point is that memory can grow without agents paying for the growth. A
 * record file has to be read whole to answer anything; rows can be filtered
 * before they ever reach a prompt. It also decouples a schema change from a
 * re-reform: adding a field becomes a code edit rather than a $7 rewrite of
 * every domain.
 */
export const DATA_FILE = 'entities.jsonl';
export const VIEW_FILE = 'entities.md';

/** Domains carrying entity data — i.e. the reformed ones. */
export function reformedDomains(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        (existsSync(join(DIR, e.name, DATA_FILE)) || existsSync(join(DIR, e.name, VIEW_FILE))),
    )
    .map((e) => e.name)
    .sort();
}

/** Serialize one entity as a data row. Source positions are presentation, not
 *  data, so they never land on disk. */
export function toRow(e: Entity): string {
  const { file: _f, line: _l, factsLine: _fl, edgesLine: _el, domain: _d, ...rest } = e;
  return JSON.stringify(rest);
}

/** Render the readable VIEW from rows — the same move `_map.md` already made. */
export function renderRecords(entities: Entity[]): string {
  // `#` comments, not an HTML comment: the grammar skips `#` lines, and any
  // content before the first `---` fence is a parse ERROR. A header the parser
  // refuses would make the view unreadable by the very code that renders it.
  const out: string[] = [
    '# GENERATED from entities.jsonl — edits here are NOT read back.',
    '# entities.jsonl is the data; this file is a readable view of it.',
  ];
  for (const e of entities) {
    out.push('---');
    out.push(`id: ${e.id}`);
    out.push(`kind: ${e.kind}`);
    if (e.aka.length) out.push(`aka: [${e.aka.map((a) => JSON.stringify(a)).join(', ')}]`);
    if (e.facts.length) {
      out.push('facts:');
      for (const f of e.facts) out.push(`  - ${/^[[\-#*&!|>%@`]/.test(f) || f.includes(': ') ? JSON.stringify(f) : f}`);
    }
    const rels = Object.entries(e.edges).filter(([, t]) => t.length);
    if (rels.length) {
      out.push('edges:');
      for (const [rel, targets] of rels) out.push(`  ${rel}: [${targets.join(', ')}]`);
    }
    if (e.probe) out.push(`probe: ${e.probe}`);
    if (e.closed_when) out.push(`closed_when: ${e.closed_when}`);
    if (e.state !== undefined) out.push(`state: ${/[:#]/.test(e.state) ? JSON.stringify(e.state) : e.state}`);
    if (e.state_at) out.push(`state_at: ${e.state_at}`);
    if (e.observed !== undefined) out.push(`observed: ${/[:#]/.test(e.observed) ? JSON.stringify(e.observed) : e.observed}`);
    if (e.observed_at) out.push(`observed_at: ${e.observed_at}`);
    if (!e.probe) out.push(`status: ${e.status}`);
    if (e.dormant) out.push('dormant: true');
    if (e.actor) out.push(`actor: ${e.actor}`);
    if (e.goal) out.push('goal: true');
    out.push(`chain: [${e.chain.map((c) => (/[:,\s]/.test(c) ? JSON.stringify(c) : c)).join(', ')}]`);
    if (e.note) out.push(`note: ${e.note}`);
  }
  return `${out.join('\n')}\n`;
}

/** Read a domain's rows. Falls back to parsing the record VIEW for a domain
 *  written before the split, so no domain has to be re-reformed to be read. */
function readDomain(domain: string, errors: Diagnostic[]): Entity[] {
  const dataPath = join(DIR, domain, DATA_FILE);
  if (!existsSync(dataPath)) {
    const viewPath = join(DIR, domain, VIEW_FILE);
    if (!existsSync(viewPath)) return [];
    return parseRecordFile(readFileSync(viewPath, 'utf8'), `${domain}/${VIEW_FILE}`, domain, errors);
  }
  const out: Entity[] = [];
  const text = readFileSync(dataPath, 'utf8');
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const o = JSON.parse(t) as Partial<Entity>;
      if (!o.id) throw new Error('row has no id');
      // The DATA file must not accept a record its own generated VIEW would
      // reject. It did: `dormant` + `actor` is fatal in the restricted grammar
      // and was silently legal here, so `ops-tool/pr-10-review-threads` sat
      // in the tree lint-clean while `npm test`'s round-trip went red — the
      // failure surfaced two parsers away from the record that caused it. One
      // grammar, one rule set; anything enforced on the way out is enforced on
      // the way in.
      for (const c of o.chain ?? []) {
        const problem = chainEntryProblem(c, o.id, domain);
        if (problem) errors.push({ file: `${domain}/${DATA_FILE}`, line: i + 1, id: o.id, message: problem });
      }
      if (o.dormant && o.actor) {
        errors.push({
          file: `${domain}/${DATA_FILE}`,
          line: i + 1,
          id: o.id,
          message: 'an entity nobody is moving cannot also name the person moving it — drop `actor` or drop `dormant`',
        });
      }
      const built: Entity = {
        ...(o as Entity),
        // Defaults AFTER the spread: a row that omits an optional field means
        // "empty", and a JSON round-trip legitimately drops empty collections.
        aka: o.aka ?? [],
        facts: o.facts ?? [],
        edges: Object.fromEntries(Object.entries(o.edges ?? {}).filter(([, t]) => (t as string[]).length)),
        chain: o.chain ?? [],
        goal: o.goal ?? false,
        dormant: o.dormant ?? false,
        status: o.status ?? 'open',
        domain,
        file: `${domain}/${DATA_FILE}`,
        line: i + 1,
        factsLine: i + 1,
        edgesLine: i + 1,
      };
      // The fact rules run here too. They were previously reachable only through
      // the record grammar, so a fact asserting state was fatal when authored in
      // `entities.md` and silently legal in `entities.jsonl` — the same split
      // that let `dormant`+`actor` through, found the same way: a guard in the
      // round-10 write path relied on a rule the data parser never ran.
      lintFacts(built, errors);
      // Same hole as `dormant`+`actor` above, found the same way and one rule
      // later: the record grammar rejects a chainless entity, this reader did
      // not, and on 2026-08-04 the night minted `affiliate-app/launchpad-check-
      // qa-gate` with `chain: []`. The write path's guard passed — it only asks
      // `loadGraph` — and `npm test` went red two parsers away, on the view.
      // Anything enforced on the way out is enforced on the way in.
      if (!built.chain.length) {
        errors.push({
          file: `${domain}/${DATA_FILE}`,
          line: i + 1,
          id: o.id,
          message: 'chain is empty — an entity with no route back to the traces is a dead end',
        });
      }
      out.push(built);
    } catch (e) {
      errors.push({
        file: `${domain}/${DATA_FILE}`,
        line: i + 1,
        message: `unreadable data row: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
  return out;
}

/** Parse a record-format file (the authored/view shape) into entities. */
export function parseRecordFile(text: string, file: string, domain: string, errors: Diagnostic[]): Entity[] {
  const out: Entity[] = [];
  for (const rec of parseRecords(text, file, errors)) {
    const e = buildEntity(rec, file, domain, errors);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Assemble parsed entities into a graph: unique ids, resolvable edge targets,
 * inverses materialized, no `blocks` cycles.
 *
 * Both entry points below run through here — the reformer's pre-landing gate
 * (`lintText`) and the tree-wide load. They used to carry their own copies,
 * which had already drifted: one deduplicated edges and the other did not, so a
 * draft and the same file on disk could produce different graphs. A rule that
 * holds in one path and not the other is not a rule.
 *
 * `knownIds` are entities defined elsewhere: an edge may point at them, and a
 * record may not redefine them.
 */
export function graphOf(parsed: Entity[], knownIds: string[] = []): Graph {
  const entities = new Map<string, Entity>();
  const errors: Diagnostic[] = [];
  const edges: Graph['edges'] = [];
  const known = new Set(knownIds);

  for (const e of parsed) {
    const clash = entities.get(e.id);
    if (clash) {
      errors.push({ file: e.file, line: e.line, id: e.id, message: `duplicate id — already defined at ${clash.file}:${clash.line}` });
      continue;
    }
    if (known.has(e.id)) {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        message: 'this id already exists in another domain — point an edge at it instead of redefining it',
      });
      continue;
    }
    entities.set(e.id, e);
  }

  const seen = new Set<string>();
  const push = (src: string, rel: EdgeRel, dst: string) => {
    const k = `${src}|${rel}|${dst}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ src, rel, dst });
  };
  for (const e of entities.values()) {
    for (const [rel, targets] of Object.entries(e.edges)) {
      for (const dst of targets) {
        if (!entities.has(dst)) {
          // A target in another domain resolves but is not in THIS graph, so it
          // yields no edge — there is no node at the far end to walk to.
          if (!known.has(dst)) {
            errors.push({ file: e.file, line: e.edgesLine, id: e.id, message: `edge ${rel} → "${dst}" does not resolve to any entity` });
          }
          continue;
        }
        push(e.id, rel as EdgeRel, dst);
        const inv = INVERSE[rel as EdgeRel];
        if (inv) push(dst, inv, e.id);
      }
    }
  }

  // People live in one domain (M0, and the resolution of the Charter's fork F2:
  // a domain stays a FOLDER, and a node that belongs to every domain gets its
  // own instead of the grammar growing a second membership mechanism). Mehdi
  // sat in `core-api/` because that is where he was first written down, so the
  // node the whole graph points at rendered as a Core-API leaf. This rule is why
  // that cannot come back: a person is filed with the people or it does not
  // parse.
  for (const e of entities.values()) {
    if (e.kind === 'person' && e.domain !== PEOPLE_DOMAIN) {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        message: `a person belongs in the ${PEOPLE_DOMAIN}/ domain, not ${e.domain}/ — people are pointed at from every domain, so they cannot live inside one`,
      });
    }
  }

  // The actor join (M0). Resolution is by id BASENAME because that is the only
  // key available on BOTH paths through this function: the tree-wide load holds
  // every entity, the reformer's per-domain gate holds one domain's entities
  // plus everyone else's bare ids. A basename collision is therefore fatal —
  // and that error is exactly the pressure that puts people in one domain.
  const byBasename = new Map<string, string[]>();
  for (const id of [...entities.keys(), ...known]) {
    const base = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base)!.push(id);
  }
  for (const e of entities.values()) {
    const actor = e.actor?.trim().toLowerCase();
    if (!actor) continue;
    const matches = byBasename.get(actor) ?? [];
    if (!matches.length) {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        message: `actor "${e.actor}" resolves to no entity — an actor names a person the graph knows, so add that person as a person entity or use the name of one that exists`,
      });
      continue;
    }
    if (matches.length > 1) {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        message: `actor "${e.actor}" is ambiguous — ${matches.join(', ')} all end in it. A person must exist once, in one domain.`,
      });
      continue;
    }
    const target = matches[0]!;
    // Same rule the authored edges follow: a target that resolves but is not in
    // THIS graph yields no edge, because there is no node at the far end.
    if (target === e.id || !entities.has(target)) continue;
    const person = entities.get(target);
    if (person && person.kind !== 'person') {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        message: `actor "${e.actor}" resolves to ${target}, which is a ${person.kind}, not a person`,
      });
      continue;
    }
    push(e.id, 'acted-by', target);
  }

  for (const cycle of findCycles(entities, edges)) {
    const at = entities.get(cycle[0]!)!;
    errors.push({ file: at.file, line: at.line, id: at.id, message: `dependency cycle: ${cycle.join(' → ')} → ${cycle[0]}` });
  }

  return { entities, edges, errors };
}

/**
 * Name → entity, the one way anything in the system turns a REF into a node.
 *
 * Exact id first, then a unique `aka`, then a unique id tail — so `mehdi`,
 * `people/mehdi` and `"the tracker_code bug"` all land, and an ambiguous name
 * lands nowhere rather than on a guess. Ambiguity returning `undefined` is the
 * point: a wrong node is worse than an unresolved one, because only the second
 * is visible.
 *
 * It lives here, beside the grammar, because it now has two callers — the
 * knowledge API and the day's `observe` tool — and round 8's lesson about
 * `graphOf` applies to resolution too: a rule that holds on one path and not
 * the other is not a rule.
 */
export function resolveRef(graph: Graph, ref: string): Entity | undefined {
  // Every caller that matters reaches this across a module boundary carrying
  // JSON, so `ref` is a guess, not a type. `find({id: "x"})` — the shape the
  // whole rest of the API uses — died here on 2026-08-06 with `ref.trim is not
  // a function`, four frames deep. Accepting the obvious wrapper costs one
  // line; a TypeError from inside the resolver costs a caller its turn.
  const raw = typeof ref === 'string' ? ref : (ref as { id?: unknown } | null)?.id;
  if (typeof raw !== 'string') return undefined;
  const q = raw.trim().toLowerCase();
  const all = [...graph.entities.values()];
  const exact = all.find((e) => e.id.toLowerCase() === q);
  if (exact) return exact;
  const byAlias = all.filter((e) => e.aka.some((a) => a.toLowerCase() === q));
  if (byAlias.length === 1) return byAlias[0];
  const byTail = all.filter((e) => e.id.toLowerCase().endsWith(`/${q}`));
  return byTail.length === 1 ? byTail[0] : undefined;
}

/**
 * Lint ONE domain's text without it being on disk — the reformer's gate.
 *
 * A draft has to face the same rules as a committed file, and it has to face
 * them BEFORE it lands: a half-formal domain is worse than a prose one, because
 * everything downstream computes on it as if it were true.
 */
export function lintText(text: string, domain: string, knownIds: string[] = []): { entities: Entity[]; errors: Diagnostic[] } {
  const file = `${domain}/entities.md`;
  const parseErrors: Diagnostic[] = [];
  const parsed = parseRecordFile(text, file, domain, parseErrors);
  const g = graphOf(parsed, knownIds);
  return { entities: [...g.entities.values()], errors: [...parseErrors, ...g.errors] };
}

/**
 * Parse + lint every reformed domain into one graph.
 *
 * Cross-record rules (unique ids, resolvable edge targets, acyclicity) can only
 * run once EVERY file is in, which is why linting is not per-file: a domain that
 * points at another domain's entity is normal and must still be checked.
 */
export function loadGraph(): Graph {
  const parsed: Entity[] = [];
  const errors: Diagnostic[] = [];
  for (const domain of reformedDomains()) parsed.push(...readDomain(domain, errors));

  const { entities, edges, errors: graphErrors } = graphOf(parsed);
  errors.push(...graphErrors);

  // The state a file claims must be the state the PROBER last saw. A record
  // whose state was hand-edited is rejected outright — this is the rule that
  // keeps "entities have their own self-sustaining state" true rather than
  // aspirational, and it is only checkable against the prober's own table.
  const probed = allEntityState();
  for (const e of entities.values()) {
    const row = probed.get(e.id);
    if (!row || row.state === null) continue;
    if (e.state !== undefined && e.state !== row.state) {
      errors.push({
        file: e.file,
        line: e.line,
        id: e.id,
        code: 'state-drift',
        message: `state was hand-edited — the file says "${e.state.slice(0, 40)}" but the last probe (${row.probed_at} UTC) saw "${(row.state ?? '').slice(0, 40)}". Only the prober writes state; fix the probe or drop the field.`,
      });
    }
  }

  // The derived index only ever reflects a CLEAN parse. Indexing a graph that
  // failed lint would put diagnosed-bad data behind SQL queries that look
  // authoritative — better to leave the last good index in place.
  if (!errors.length) {
    rebuildEntityIndex([...entities.values()], edges);
    // Provenance tracks the files rather than being maintained alongside them:
    // a fact that appears gets a clock, a fact that leaves loses one, and no
    // writer has to remember either. Same load, so it can never drift.
    for (const e of entities.values()) syncFactProvenance(e.id, e.facts.map(factSha));
  }

  return { entities, edges, errors };
}

/** Cycles over `blocks` only — the one relation the simplifier and the focus
 *  projection walk, and the only one where a cycle means the graph is a lie. */
function findCycles(entities: Map<string, Entity>, edges: Graph['edges']): string[][] {
  const next = new Map<string, string[]>();
  for (const { src, rel, dst } of edges) {
    if (rel !== 'blocks') continue;
    if (!next.has(src)) next.set(src, []);
    next.get(src)!.push(dst);
  }
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const walk = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const n of next.get(id) ?? []) {
      if (state.get(n) === 1) {
        cycles.push(stack.slice(stack.indexOf(n)));
      } else if (!state.get(n)) {
        walk(n);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of entities.keys()) if (!state.get(id)) walk(id);
  return cycles;
}

/** Render diagnostics for a human or for the reformer's retry. */
export function formatDiagnostics(errors: Diagnostic[]): string {
  return errors.map((e) => `${e.file}:${e.line}${e.id ? ` [${e.id}]` : ''} — ${e.message}`).join('\n');
}
