import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { extractUsage } from './claude.js';
import { episodeForDistill, episodesToDistill, markEpisodeDistilled, postEvent, recordBotSession, saveUsage } from './db.js';
import { stripLoneSurrogates } from './format.js';

/**
 * DISTILLATION (round 6 step 2, BRAIN.md §3.12) — skeletons in, recaps out.
 *
 * The expensive version of this would hand an agent a transcript. It never
 * does: step 1 already reduced a 620KB session to a ~5k-char skeleton (title,
 * the user's prompts, the agent's own narration, the milestones that landed).
 * So this model only has to COMPRESS something already legible — no tools, no
 * investigation, no filesystem. The whole distillable corpus is ~460k chars.
 *
 * The output answers what Mehdi actually asked of this layer: what was worked
 * on, how deep it went, is it finished, does it need follow-up — plus the
 * TOPICS, because a long burst wanders and one headline cannot hold a day that
 * opened on a syncer inventory and ended in a shipped PR.
 */

const SYSTEM = `You compress one work session into a factual record. You are given a SKELETON of a real coding session: how it was titled at the start, a timeline of what the user asked and what the agent narrated doing, the milestones that actually landed (branches, commits, PRs), and the work anchors it touched.

Return ONLY a JSON object, no prose around it:
{
  "headline": "one sentence: what this session ACTUALLY was, in plain past tense",
  "topics": ["short phrase per distinct piece of work, in the order they happened"],
  "status": "done" | "open" | "cut-short",
  "followUp": "the specific thing left undone, or null",
  "openLoops": ["one line per thing this session OPENED and did not close — a task/issue filed, a PR opened, a bug hit and not fixed, a decision deferred. Name its anchor (task id, PR number, file:line). Empty array if the session closed everything it opened."],
  "crossProject": "another project/repo this work implicates, or null"
}

Rules that matter:
- THE TITLE IS WHERE IT STARTED, NOT WHAT IT BECAME. It is set once, early, and never revised. If the timeline shows the work moved on, the headline must describe where it ENDED UP. A session titled "investigate X" that ends with a merged PR for Y is a session about Y.
- SEPARATE THE TOPICS. Long sessions wander — a design discussion, then a planning doc, then a PR, then an unrelated bug. List them separately rather than blending them into one vague summary. One topic is fine if the session really was one thing.
- "cut-short" means the record shows it stopped rather than finished (a session limit, an unresolved error, a dangling plan). "open" means it was progressing with work clearly left. "done" means it reached its end.
- GROUND EVERY WORD IN THE SKELETON. Never infer what the user was "trying to achieve" beyond what is written. WHY the work was started is usually NOT in the record — if it isn't there, leave it out. Do not invent a rationale; a fabricated one is worse than a missing one.
- Name concrete anchors (task ids, PR numbers, files, branches) where the record has them.
- OPEN LOOPS ARE THE POINT OF THE RECORD. A session that files a task, opens a PR, or hits a bug it does not fix has handed the user something that is still open — and the tracker it landed in will not remind anyone that HE was the one who touched it. List each one separately, even when the session's overall status is "done": finishing what you set out to do and leaving three new things open are both true at once. Only what the record actually shows was left open — do not invent follow-ups.
- Be terse. This is an index entry, not a report.`;

export interface DistillResult {
  distilled: number;
  failed: number;
  costUsd: number;
  /** Everything the newly distilled sessions left open (see OpenLoop). */
  openLoops: OpenLoop[];
}

/** Called after each episode so a caller can show live progress. A long run
 *  with no feedback is indistinguishable from a hung one — 88 episodes is
 *  ~20 minutes of silence otherwise. */
export type DistillProgress = (p: {
  done: number;
  total: number;
  costUsd: number;
  etaSeconds: number;
  latest?: string;
}) => void;

interface Recap {
  headline: string;
  topics: string[];
  status: string;
  followUp?: string | null;
  openLoops?: string[];
  crossProject?: string | null;
}

/** What a freshly distilled session handed the user and did not close. This is
 *  the intake the focus set was missing: work that passes through a session and
 *  into a tracker is otherwise never seen again. */
export interface OpenLoop {
  episodeId: number;
  project: string;
  headline: string;
  loop: string;
}

/** Clip to a word boundary — a hard slice ends topics mid-word ("…recommen"). */
function clip(v: unknown, max = 220): string {
  const t = String(v).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Pull the JSON object out of a model reply that may carry stray prose. */
function parseRecap(text: string): Recap | undefined {
  const raw = text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Partial<Recap>;
    if (!o.headline) return undefined;
    return {
      headline: clip(o.headline, 300),
      // NOT .map(clip) — Array.map passes (value, index), so the index lands
      // in `max` and topic N gets clipped to N characters ("…", "d…", "wr…").
      topics: Array.isArray(o.topics) ? o.topics.map((t) => clip(t)).slice(0, 12) : [],
      status: ['done', 'open', 'cut-short'].includes(String(o.status)) ? String(o.status) : 'open',
      followUp: o.followUp ? clip(o.followUp, 300) : null,
      openLoops: Array.isArray(o.openLoops) ? o.openLoops.map((l) => clip(l, 300)).slice(0, 8) : [],
      crossProject: o.crossProject ? clip(o.crossProject, 80) : null,
    };
  } catch {
    return undefined;
  }
}

/** One compression call. No tools — the skeleton is the entire world. */
async function distillOne(
  chatId: number,
  ep: { id: number; project: string; started_at: string; skeleton: string },
): Promise<{ recap?: Recap; costUsd: number }> {
  let text = '';
  let costUsd = 0;
  for await (const m of query({
    prompt: stripLoneSurrogates(
      `PROJECT: ${ep.project}\nWHEN: ${ep.started_at} UTC\n\nSKELETON:\n${ep.skeleton}`,
    ),
    options: {
      systemPrompt: SYSTEM,
      allowedTools: [],
      disallowedTools: ['Bash', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      ...(config.distillModel ? { model: config.distillModel } : {}),
    },
  }) as AsyncIterable<any>) {
    // Every distill call is a fresh session and writes its own transcript into
    // the bot's own project dir. Record the id so the harvest excludes it —
    // otherwise the system reads its own summarising back as Mehdi's work.
    if (m.session_id) recordBotSession(String(m.session_id), 'distill');
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) text += b.text;
    } else if (m.type === 'result') {
      const usage = extractUsage(m);
      if (usage) {
        saveUsage(`${chatId}:distill`, usage);
        costUsd += usage.costUsd;
      }
      if (m.subtype !== 'success') throw new Error(String(m.subtype ?? 'error'));
    }
  }
  return { recap: parseRecap(text), costUsd };
}

/**
 * Distil the pending queue. `episodesToDistill` is the only door in, so the
 * exclusions (live episodes, no-distill projects, already-done) hold here
 * without this function having to remember them.
 */
export async function distillPending(
  chatId: number,
  limit = 20,
  onProgress?: DistillProgress,
): Promise<DistillResult> {
  const res: DistillResult = { distilled: 0, failed: 0, costUsd: 0, openLoops: [] };
  // Three callers now share this queue (the nightly, /distill, and round 7's
  // hourly daytime pass), and the queue is only cleared as each episode
  // finishes — so two overlapping runs would summarise the same episodes twice
  // and pay twice. One at a time; a skipped daytime pass just runs an hour later.
  if (distilling) {
    console.log('[distill] another pass is already running — skipping this one');
    return res;
  }
  distilling = true;
  try {
    return await distillQueue(chatId, limit, onProgress, res);
  } finally {
    distilling = false;
  }
}

let distilling = false;

/** The loops a recap hands over — openLoops plus the session's own followUp. */
export function recapLoops(recap: Recap | string | null | undefined): string[] {
  let r: Recap | null = null;
  if (typeof recap === 'string') {
    try {
      r = JSON.parse(recap) as Recap;
    } catch {
      return [];
    }
  } else r = recap ?? null;
  if (!r) return [];
  return [...(Array.isArray(r.openLoops) ? r.openLoops : []), ...(r.followUp ? [r.followUp] : [])].filter((l): l is string => typeof l === 'string' && l.trim() !== '');
}

/** Case, punctuation and whitespace are not information in a one-line loop;
 *  two phrasings of the same anchor compare equal. */
function loopKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

/** The loops in `next` that `prev` did not already hand over. Pure. */
export function newLoops(prev: string[], next: string[]): string[] {
  const seen = new Set(prev.map(loopKey));
  const out: string[] = [];
  for (const l of next) {
    const k = loopKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

async function distillQueue(
  chatId: number,
  limit: number,
  onProgress: DistillProgress | undefined,
  res: DistillResult,
): Promise<DistillResult> {
  const queue = episodesToDistill(limit);
  const startedAt = Date.now();
  let seen = 0;
  for (const ep of queue) {
    let latest: string | undefined;
    try {
      const { recap, costUsd } = await distillOne(chatId, ep);
      res.costUsd += costUsd;
      if (!recap) {
        res.failed += 1;
        continue;
      }
      const before = recapLoops(ep.recap);
      markEpisodeDistilled(ep.id, JSON.stringify(recap));
      res.distilled += 1;
      latest = recap.headline;
      // followUp and openLoops overlap by design — the first is the session's
      // own thread left dangling, the rest are things it handed off. Both are
      // open loops the user touched, so both go to the caller as candidates —
      // but only the ones the previous summary of this same episode did not
      // already hand over: a live burst is re-summarised as it grows, and its
      // old loops are not new work (design proposal #2).
      for (const loop of newLoops(before, recapLoops(recap))) {
        res.openLoops.push({ episodeId: ep.id, project: ep.project, headline: recap.headline, loop });
      }
    } catch (e) {
      // A failed episode stays in the queue — distilled_at is only stamped on
      // success, so the next pass retries it rather than losing it silently.
      console.warn(`[distill] episode #${ep.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      res.failed += 1;
    } finally {
      seen += 1;
      const perItem = (Date.now() - startedAt) / seen;
      onProgress?.({
        done: seen,
        total: queue.length,
        costUsd: res.costUsd,
        etaSeconds: Math.round((perItem * (queue.length - seen)) / 1000),
        latest,
      });
    }
  }
  if (res.distilled) {
    postEvent(chatId, 'distill', `distilled ${res.distilled} work episode(s)`);
  }
  return res;
}


/**
 * Summarise ONE episode on demand, whether or not it has closed and whether or
 * not it already has a recap.
 *
 * The nightly queue deliberately withholds live bursts — a recap of a running
 * session is wrong an hour later. But that made the freshest work the emptiest
 * thing on screen, which is backwards: what Mehdi just did is what he most
 * wants described. So a summary can always be demanded for a specific episode,
 * and regenerated when it has gone stale.
 *
 * `distillable` is still enforced: it is the privacy boundary Mehdi drew
 * (pandoc_resume), not a scheduling rule, so no on-demand path may cross it.
 */
export async function distillEpisodeNow(
  chatId: number,
  episodeId: number,
): Promise<{ ok: boolean; reason?: string; costUsd: number }> {
  const ep = episodeForDistill(episodeId);
  if (!ep) return { ok: false, reason: `No episode #${episodeId}.`, costUsd: 0 };
  if (!ep.distillable) {
    return { ok: false, reason: `Episode #${episodeId} is in a project you excluded from summarising.`, costUsd: 0 };
  }
  if (!ep.skeleton) return { ok: false, reason: `Episode #${episodeId} has nothing to summarise.`, costUsd: 0 };
  try {
    const { recap, costUsd } = await distillOne(chatId, ep);
    if (!recap) return { ok: false, reason: 'The model returned nothing usable.', costUsd };
    markEpisodeDistilled(ep.id, JSON.stringify(recap));
    return { ok: true, costUsd };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), costUsd: 0 };
  }
}
