import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { dropFrozenPrompt, sessionKey } from './db.js';
import { loadGraph } from './entities.js';

/**
 * `## How to behave`, RENDERED FROM THE GRAPH (M5, F3 step 2).
 *
 * The section used to be authored prose: twenty-one hand-written lines that
 * `recordRootHabit` appended to. Resolving F3 showed what that cost — the root
 * was not a summary of the graph, it was a SECOND STORE, and the more valuable
 * half lived in the one nobody could query. `people/mehdi`, the graph's hub,
 * held a single fact while everything the system had learned about working with
 * him sat in this section. Three habits were also verbatim duplicates of facts
 * the graph already held (I1).
 *
 * So the facts moved to their homes and this renders them back. One home, one
 * copy, a derived view (I1 + I2) — and because it emits full TEXT, workers keep
 * receiving every rule despite having no graph access. That is the whole reason
 * "render" comes before "pointers" in the plan.
 *
 * THE RULES THIS FILE OBEYS ARE THEMSELVES IN THE GRAPH, on `self/root-render`,
 * written before this code existed so they could not be rediscovered by being
 * broken. In short:
 *
 * - **Only `self/*`.** Domain knowledge does not come back into the behaviour
 *   section however useful it would be there — a fact about a person, platform
 *   or case belongs to `## Global facts` or to its own domain. This section was
 *   a dumping ground once (Sasha's gender, Mehdi's breakfast slot) and the
 *   partition is what stops it recurring.
 * - **Structure decides membership, not a list in code.** The source is
 *   `self/companion` plus whatever is `part-of` it. `self/root-render` is
 *   deliberately `relates-to` instead: it is about how this file is BUILT, the
 *   day never acts on it, and injecting it every turn would be waste. Excluding
 *   it costs no special case — it simply is not a child.
 * - **Stable across turns (I12).** root.md sits in the injected prefix, so a
 *   section that reorders itself invalidates the whole conversation cache. The
 *   order is (companion first, then children by id, facts in authored order),
 *   which is a pure function of the graph — no clock, no counter, no ranking.
 */

const HEADING = '## How to behave';
const MARKER =
  '<!-- GENERATED from the self/ domain. Do not edit these lines: they are rewritten\n' +
  '     from the graph. To change a habit, change the fact on its self/* entity\n' +
  '     (record add-fact / correct-fact / drop-fact). -->';

function rootPath(): string {
  return join(config.knowledgeDir, 'root.md');
}

/** The behaviour facts, in render order. Exported for the test that pins I12. */
export function behaviourFacts(): Array<{ id: string; fact: string }> {
  const g = loadGraph();
  const root = g.entities.get('self/companion');
  if (!root) return [];

  const children = [...g.entities.values()]
    .filter((e) => (e.edges['part-of'] ?? []).includes('self/companion'))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The root node first — it carries the delivery rules, which read as the
  // system's voice — then its children alphabetically. Alphabetical is not
  // meaningful ordering, but it is STABLE, and stability is the property that
  // matters here (I12); a "most important first" ranking would move whenever
  // the graph changed underneath a running session.
  return [root, ...children].flatMap((e) => e.facts.map((fact) => ({ id: e.id, fact })));
}

/** The section body, exactly as it will appear in root.md. */
export function renderBehaviourSection(): string {
  const rows = behaviourFacts();
  if (!rows.length) return `${HEADING}\n${MARKER}\n\n(the self/ domain holds no behaviour facts)\n`;
  return `${HEADING}\n${MARKER}\n\n${rows.map((r) => `- ${r.fact}`).join('\n')}\n`;
}

export interface RefreshResult {
  changed: boolean;
  facts: number;
  /** Set when the section could not be written — never thrown, so a render
   *  problem cannot take down a turn that only wanted to read the root. */
  problem?: string;
}

/**
 * Splice the rendered section into root.md, leaving every other section alone.
 *
 * root.md stays AUTHORED for `## Domains`, `## Global facts` and `## Now`;
 * only this one section is derived. That is the partition, and it is why this
 * rewrites a block rather than the file.
 *
 * Idempotent: identical output is not rewritten, so an unchanged graph leaves
 * the file's mtime alone and the tree does not look dirty in every diff.
 */
export function refreshRootBehaviour(): RefreshResult {
  const rows = behaviourFacts();
  try {
    const path = rootPath();
    if (!existsSync(path)) return { changed: false, facts: rows.length, problem: 'no root.md' };
    const raw = readFileSync(path, 'utf8');
    const start = raw.search(new RegExp(`^${HEADING}\\s*$`, 'mi'));
    if (start === -1) return { changed: false, facts: rows.length, problem: 'root.md has no "## How to behave" heading' };

    // The section runs to the next top-level heading, or to the end of file.
    const after = raw.slice(start + HEADING.length);
    const nextRel = after.search(/^##\s/m);
    const end = nextRel === -1 ? raw.length : start + HEADING.length + nextRel;

    const next = `${raw.slice(0, start)}${renderBehaviourSection()}\n${raw.slice(end)}`;
    if (next === raw) return { changed: false, facts: rows.length };
    writeFileSync(path, next);
    // The root render is part of the concierge's FROZEN system prompt
    // (src/sessionPrompt.ts). Who moves it, and whether the concierge knows:
    //   the concierge itself (recordBehavior → applyWrite) — it knows, but the
    //     frozen prompt would still show the old habit until the next clear;
    //   workers — cannot write the root at all;
    //   the prober — writes state only, never a habit;
    //   the night — clears the concierge session anyway;
    //   the Atlas's revertRun and gardenCli's applyWrite — neither clears it.
    // So the one seam that sees every root move drops the frozen prompt: the
    // next turn rebuilds it under the SAME transcript (no snapshot — the
    // session lived the state), one cache miss, which is the right price.
    // -1 is CONTROL_SLOT (src/sessions.ts), not imported to keep this leaf
    // module free of the session layer.
    for (const chatId of config.allowedChatIds) dropFrozenPrompt(sessionKey(chatId, -1));
    return { changed: true, facts: rows.length };
  } catch (e) {
    return { changed: false, facts: rows.length, problem: e instanceof Error ? e.message : String(e) };
  }
}
