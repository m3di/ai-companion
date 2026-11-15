import { type Entity, type Graph, loadGraph } from './entities.js';

/**
 * THE MEMORY CUE — the graph raises its hand when a message names a node.
 *
 * Twelve days after M4 asked "did the DAY reach for memory?", the answer was
 * five module calls against the night's 217, and every cycle printed DAY 0.
 * The concierge answers from its transcript: nothing tells it, at the moment
 * a message arrives, that the thing being discussed IS a node with facts
 * newer than what it remembers. The root and the story are renders, so it
 * feels informed; readFocus is a list, so it feels current. Neither is the
 * node.
 *
 * So: on every human message to the concierge, the entities the text names
 * (id, alias, a task or PR number) are resolved HERE, mechanically, and one
 * line under the message says which nodes it names and asks for a find().
 * Pull, not push — the cards are not attached, because an injected copy is
 * exactly what pre-empted the reads before (the 2026-08-06 focus lesson, I7);
 * the cue points and the read is the concierge's, logged with refs like any
 * other, which is what lets the touch-watch ride on it. The refs are recorded
 * on the retrieval episode as `hinted`, so the number that matters can be
 * printed: of the messages that named a node, how many turns reached it.
 *
 * What it will NOT match: `people/mehdi` — every message is about him — and
 * anything shorter than three characters unless it is a #number.
 */

export interface Named {
  id: string;
  /** What in the text matched — for the ledger and the tests. */
  by: string;
}

const SKIP = new Set(['people/mehdi']);
const MAX_CUES = 5;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every entity the text names, most relevant first. Pure: takes the entities it should scan. */
export function namesInText(text: string, entities: Iterable<Entity>): Named[] {
  const t = text;
  const lower = t.toLowerCase();
  // Numbers the way people type them: #1299, PR 3760, task 2691, "the 2768 one".
  const numbers = new Set([...t.matchAll(/(?:#|\b(?:pr|task|bug|issue|epic)\s*#?)\s*(\d{2,6})\b/gi)].map((m) => m[1]!));
  const out: Named[] = [];
  for (const e of entities) {
    if (SKIP.has(e.id)) continue;
    let by: string | undefined;
    const tail = e.id.split('/')[1] ?? '';
    // The id itself, or its tail typed with spaces ("ewallet vertical persist").
    if (lower.includes(e.id.toLowerCase())) by = e.id;
    else if (tail.length >= 8 && new RegExp(`\\b${escapeRe(tail).replace(/-/g, '[- ]')}\\b`, 'i').test(t)) by = tail;
    if (!by) {
      for (const a of e.aka) {
        const m = a.match(/^#(\d+)$/);
        if (m) {
          if (numbers.has(m[1]!)) { by = a; break; }
          continue;
        }
        if (a.length < 3) continue;
        // A short all-caps alias (TCP, WW, GL) only matches as written; a
        // longer one matches as a whole phrase, case-insensitively.
        const re = new RegExp(`(?<![\\w-])${escapeRe(a)}(?![\\w-])`, /^[A-Z][A-Za-z]{1,4}$/.test(a) && a.length <= 5 ? '' : 'i');
        if (re.test(t)) { by = a; break; }
      }
    }
    if (!by) {
      // A task number in the id's tail: …-1299 ↔ "#1299".
      const n = tail.match(/-(\d{2,6})$/)?.[1];
      if (n && numbers.has(n)) by = `#${n}`;
    }
    if (by) out.push({ id: e.id, by });
  }
  return out;
}

/** The line to put under a message, and the ids it names — or nothing. */
export function memoryCue(text: string, g: Graph = loadGraph()): { refs: string[]; line: string } | undefined {
  let named = namesInText(text, g.entities.values());
  // A hub ("Fibery", "Launchpad", "Core-API") is named in most work messages;
  // it is the cue only when the message names nothing more specific.
  const specific = named.filter((n) => g.entities.get(n.id)?.kind !== 'system');
  if (specific.length) named = specific;
  if (!named.length) return undefined;
  const rank = (id: string) => {
    const e = g.entities.get(id)!;
    return (e.dormant ? 2 : 0) + (e.status === 'closed' ? 1 : 0);
  };
  const picked = named.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)).slice(0, MAX_CUES);
  const items = picked.map(({ id }) => {
    const e = g.entities.get(id)!;
    const flags = [e.kind, e.status === 'n/a' ? '' : e.status, e.dormant ? 'parked' : '', e.state ? `state ${e.state}` : ''].filter(Boolean).join(', ');
    return `${id} (${flags})`;
  });
  const more = named.length > picked.length ? ` +${named.length - picked.length} more` : '';
  return {
    refs: picked.map((n) => n.id),
    line:
      `[MEMORY — this message names ${picked.length} node(s) the graph holds: ${items.join('; ')}${more}. ` +
      `find(id) before answering about one: what you remember from this transcript may be older than the node, and a read is what lets the system see the topic is live.]`,
  };
}
