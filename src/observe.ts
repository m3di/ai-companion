import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { inboxDepth, saveObservation } from './db.js';
import { loadGraph, resolveRef } from './entities.js';
import { pulse } from './pulse.js';

/**
 * THE OBSERVATION INBOX — the DAY's write path into the graph (Charter M1).
 *
 * Round 10 handed the night a pen and left the day without one. A worker that
 * watched a PR merge, or a concierge told in passing that a hold was lifted,
 * had exactly two places to put it: prose, or nowhere. So the night's job was
 * to RE-DERIVE the day from three hundred messages and infer what had changed —
 * which is the most expensive moment to decide what a fact is, and the one with
 * the least context. Three days of live running produced 303 messages, a merged
 * PR, a product hold, an invalidated design, and not one graph write.
 *
 * `observe` moves the decision to where the context is. The agent that SAW it
 * writes one line and names the entities it is about, at the moment of seeing.
 * The night then compacts a typed queue rather than reconstructing a day.
 *
 * ## Why refs are the whole point
 *
 * A ref is resolved HERE, against the live graph, before the row is stored —
 * so a queued observation already knows which nodes it belongs to. That single
 * property is what makes the Atlas's overlays a query instead of a feature
 * (I4), what lets the night fold an observation without re-reading the day,
 * and what turns attention into something measurable.
 *
 * And a ref that resolves to NOTHING is not an error. It is the day reaching
 * for a node the graph does not have, which is the only honest signal for where
 * memory should grow (I5) — better than any nightly pass imagining which
 * domains might be useful. Those refs are kept, counted, and surfaced.
 *
 * ## What this deliberately does not do
 *
 * It does not write the graph. `observe` queues; `record()` lands. Keeping them
 * apart is what lets a fast, cheap, high-volume day capture feed a slow,
 * careful, low-volume night write — and it keeps every graph mutation behind
 * the one path that re-parses the tree and rolls back on any new diagnostic.
 *
 * The queue therefore has one failure mode, and it is the one this whole round
 * exists to avoid one level down: nobody drains it. That is why `inboxDepth()`
 * is surfaced rather than merely stored.
 */

export interface Captured {
  id: number;
  resolved: string[];
  unresolved: string[];
}

/** Resolve the refs, store the row. The only way into the inbox. */
export function captureObservation(o: {
  text: string;
  about: string[];
  evidence?: string;
  source: string;
}): Captured {
  const graph = loadGraph();
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const raw of o.about) {
    const ref = raw.trim();
    if (!ref) continue;
    const hit = resolveRef(graph, ref);
    // Store the CANONICAL id, never what the agent typed: an alias resolved at
    // capture time is a stable pointer, an alias stored raw is a second name to
    // maintain. Dedupe, because two aliases of one entity are one ref.
    if (hit) {
      if (!resolved.includes(hit.id)) resolved.push(hit.id);
    } else if (!unresolved.includes(ref)) unresolved.push(ref);
  }
  const id = saveObservation({
    text: o.text.trim(),
    refs: resolved,
    unresolved,
    evidence: (o.evidence ?? '').trim(),
    source: o.source,
  });
  pulse('observe', o.text.slice(0, 80), { refs: resolved, meta: { id, unresolved: unresolved.length } });
  return { id, resolved, unresolved };
}

const DESCRIPTION =
  'Record something you SAW that changes what the system should believe — a PR merged, a decision reversed, a hold lifted, a name or count that turns out to be wrong, a task finished. ' +
  'It is queued and folded into the knowledge graph overnight; it does NOT change anything now, and you should not follow up on it. ' +
  'ALWAYS name what it is about in `about` — entity ids, aliases, or short names ("pr-3181", "people/sasha", "the tracker_code bug"); the reply tells you which ones resolved. ' +
  'A name that resolves to nothing is still worth sending: that is how the system learns what it is missing. ' +
  'This is for what CHANGED. Use noteIdea for a possibility worth exploring, reportBlocked for something that stops YOUR task, and just answer normally for anything the user already knows.';

/**
 * The tool, one definition for both surfaces.
 *
 * The concierge hears things ("Nora put Northwind on hold"), and it reads what a
 * worker reports seeing (a merge, a failing check, a comment). Both are
 * observations and both must land in one queue, or the night is back to reading
 * two memories. The worker no longer calls this itself — it says what it saw in
 * its report and the concierge, the single writer, observes it.
 */
export function buildObserveTool(source: string) {
  return tool(
    'observe',
    DESCRIPTION,
    {
      text: z
        .string()
        .describe('What changed, self-contained in one or two sentences — a reader without your context must understand it'),
      about: z
        .array(z.string())
        .describe('The entities it is about: ids, aliases or short names. Send your best guesses; unresolved ones are kept as signal.'),
      evidence: z
        .string()
        .optional()
        .describe('The route back: a message id (msg#4193), a PR url, a file path — whatever proves it'),
    },
    async ({ text, about, evidence }) => {
      const { id, resolved, unresolved } = captureObservation({ text, about, evidence, source });
      const hit = resolved.length ? `about ${resolved.join(', ')}` : 'about nothing the graph knows yet';
      const miss = unresolved.length
        ? ` Unrecognized: ${unresolved.join(', ')} — kept as a signal that the graph may be missing them; if one was a typo, send it again correctly.`
        : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Observed (#${id}), ${hit}.${miss} The nightly pass folds it into the graph — do not follow up.`,
          },
        ],
      };
    },
  );
}

/**
 * One line for the awareness bulletin, or nothing when the queue is healthy.
 *
 * Silence is the default on purpose: a line that appears every turn stops being
 * read, and this one has to still work on the day it matters. It speaks when
 * the queue is deep or its head has gone stale — the two shapes of "nobody
 * drained it" — which is the failure mode a write-ahead log nobody replays has,
 * and the reason this is surfaced at all rather than merely stored.
 */
export function inboxLine(): string | null {
  const { pending, oldest, unattributable } = inboxDepth();
  if (!pending) return null;
  const ageHours = oldest ? (Date.now() - new Date(`${oldest}Z`).getTime()) / 3_600_000 : 0;
  if (pending < 25 && ageHours < 36) return null;
  const stale = ageHours >= 36 ? `, oldest ${Math.floor(ageHours / 24)}d old` : '';
  const blind = unattributable ? `, ${unattributable} naming nothing in the graph` : '';
  return `observation inbox: ${pending} unfolded${stale}${blind} — the nightly fold is not keeping up`;
}
