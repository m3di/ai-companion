import { statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { openGoalQuestions, parkedBySilence } from './touch.js';
import {
  conciergeSession,
  countMessagesSince,
  dreamVitals,
  lastSettledNight,
  focusOpenCount,
  inboxDepth,
  latestPulseId,
  openFriction,
  pendingFindings,
  recentGraphRuns,
  rotHistory,
} from './db.js';
import { loadGraph } from './entities.js';
import { currentMode, debugState, dreamState } from './mode.js';
import { nightOwed } from './night.js';
import { houseHealth } from './life.js';
import { lifeItems, lifeLogCounts, lifeParams } from './db.js';

/**
 * VITAL SIGNS — everything worth knowing about this machine, cheaply.
 *
 * The audit answers "is anything broken" and pays for it: it runs the suite,
 * the typecheck and every proposal's verify command, which is a minute. This
 * answers a different question — *what state is this thing in right now* — and
 * it has to be free, because it runs at the top of every operator session and
 * something you pay a minute for is something you check less than you should.
 *
 * So: no subprocesses, no model, no network. Counts and clocks, all from the
 * database and one graph parse. Everything here is a number an operator can
 * hold in their head and compare against last time.
 *
 * The rule for adding a sign: it must be CHEAP, and it must change. A constant
 * is not a vital sign, and neither is a number nobody would act on.
 */

export interface Vitals {
  mode: string;
  debug?: { since: string; reason: string };
  /** A rewrite pass holding the machine. Outranks `debug` — the session under
   *  it is intact, but nothing may act until the pass lands. */
  dream?: { scope: string; since: string };
  graph: { entities: number; domains: number; open: number; lintErrors: number; rot: number | null; rotAt: string | null };
  memory: {
    pendingObservations: number;
    oldestObservation: string | null;
    proposals: number;
    openFriction: number;
    frictionLast24h: number;
    /** Plans whose goal the night could not find: waiting on the day to ask. */
    goalQuestions: { open: number; asked: number; parked: number };
  };
  day: { messages24h: number; focusOpen: number; conciergeSince: string | null; contextChars: number | null };
  life: { logged7d: number; voice7d: number; health: number | null; coverage: number; threshold: number };
  night: {
    dreams: number;
    lastDream: string | null;
    hoursSinceDream: number | null;
    /** A night not yet folded — the day is HELD while this is set. */
    owed?: { boundary: string; overdueMin: number };
    /** How the last accounted-for night ended: dreamt, quiet, or cancelled. */
    settled?: { boundary: string; how: string };
  };
  runs: { total: number; last: { id: number; kind: string; trigger: string; prompt: string; at: string } | null };
  pulseId: number;
}

const hoursSince = (iso: string | null): number | null =>
  iso ? Math.round(((Date.now() - Date.parse(`${iso.replace(' ', 'T')}Z`)) / 3_600_000) * 10) / 10 : null;

export function vitals(): Vitals {
  const g = loadGraph();
  const entities = [...g.entities.values()];
  const rot = rotHistory(1)[0];
  const inbox = inboxDepth();
  const friction = openFriction();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const runs = recentGraphRuns(1);

  // The concierge's context is a FILE — root.md is what it re-onboards from —
  // so its size is the cheapest honest proxy for what a turn costs before a
  // word is exchanged. I12 makes this the number that matters most.
  let contextChars: number | null = null;
  try {
    contextChars = statSync(join(config.knowledgeDir, 'root.md')).size;
  } catch {
    /* no root yet */
  }

  const d = debugState();
  const dr = dreamState();
  return {
    mode: currentMode(),
    debug: d ? { since: d.since, reason: d.reason } : undefined,
    dream: dr ? { scope: dr.scope, since: dr.since } : undefined,
    graph: {
      entities: entities.length,
      domains: new Set(entities.map((e) => e.domain)).size,
      open: entities.filter((e) => e.status === 'open' && !e.dormant).length,
      lintErrors: g.errors.length,
      rot: rot?.rot ?? null,
      rotAt: rot?.at ?? null,
    },
    memory: {
      pendingObservations: inbox.pending,
      oldestObservation: inbox.oldest ?? null,
      proposals: pendingFindings([...config.allowedChatIds][0] ?? 0, 'proposal').length,
      openFriction: friction.length,
      frictionLast24h: friction.filter((f) => f.last_at >= yesterday && f.kind !== 'bypass').length,
      goalQuestions: (() => {
        const q = openGoalQuestions();
        return { open: q.length, asked: q.filter((d) => d.nudges > 0).length, parked: parkedBySilence().length };
      })(),
    },
    day: {
      messages24h: countMessagesSince(yesterday),
      focusOpen: focusOpenCount(),
      conciergeSince: conciergeSession([...config.allowedChatIds][0] ?? 0)?.since ?? null,
      contextChars,
    },
    life: (() => {
      const week = lifeLogCounts(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '));
      const h = houseHealth(lifeItems(), new Date());
      return { logged7d: week.total, voice7d: week.voice, health: h.health, coverage: h.coverage, threshold: lifeParams().threshold };
    })(),
    night: (() => {
      const d = dreamVitals();
      const owed = nightOwed();
      const settled = lastSettledNight();
      return {
        dreams: d.count,
        lastDream: d.last,
        hoursSinceDream: hoursSince(d.last),
        ...(owed ? { owed: { boundary: owed.boundary, overdueMin: owed.overdueMin } } : {}),
        ...(settled ? { settled: { boundary: settled.boundary, how: settled.how } } : {}),
      };
    })(),
    runs: {
      total: recentGraphRuns(1000).length,
      last: runs[0]
        ? { id: runs[0].id, kind: runs[0].kind, trigger: runs[0].trigger, prompt: runs[0].prompt, at: runs[0].started_at }
        : null,
    },
    pulseId: latestPulseId(),
  };
}


/** One screen. Ordered by how likely each line is to change what you do next. */
export function renderVitals(v: Vitals): string {
  const L: string[] = [];
  const n = (x: number | null) => (x === null ? '—' : String(x));
  L.push('='.repeat(72));
  L.push(`VITAL SIGNS — ${v.mode.toUpperCase()}${v.debug ? `  (since ${v.debug.since}: ${v.debug.reason})` : ''}`);
  // Every number below was read while a pass was rewriting the thing it counts.
  // Saying so is the difference between a reading and a misreading.
  if (v.dream) L.push(`  a ${v.dream.scope} pass has held the machine since ${v.dream.since} — these counts are mid-rewrite`);
  L.push('='.repeat(72));
  L.push('');
  L.push(`GRAPH      ${v.graph.entities} entities in ${v.graph.domains} domains, ${v.graph.open} open`);
  L.push(`           rot ${n(v.graph.rot)}${v.graph.rotAt ? ` (as of ${v.graph.rotAt})` : ''}, lint errors ${v.graph.lintErrors}`);
  L.push('');
  L.push(`MEMORY     ${v.memory.pendingObservations} observation(s) unfolded${v.memory.oldestObservation ? `, oldest ${v.memory.oldestObservation}` : ''}`);
  L.push(`           ${v.memory.proposals} proposal(s) pending, ${v.memory.frictionLast24h} live friction fault(s) of ${v.memory.openFriction} open`);
  if (v.memory.goalQuestions.open || v.memory.goalQuestions.parked) {
    L.push(`           ${v.memory.goalQuestions.open} plan(s) with a goal only Mehdi can name, ${v.memory.goalQuestions.asked} asked so far, ${v.memory.goalQuestions.parked} parked by silence (touchCli)`);
  }
  L.push('');
  L.push(`DAY        ${v.day.messages24h} message(s) in 24h, ${v.day.focusOpen} focus slot(s) open`);
  L.push(`           concierge session ${v.day.conciergeSince ? `open since ${v.day.conciergeSince}` : 'fresh'}, root.md ${n(v.day.contextChars)} chars`);
  L.push(
    `LIFE       ${v.life.logged7d} upkeep done-event(s) in 7d (${v.life.voice7d} by voice); house ${
      v.life.health === null ? 'no data yet' : `${Math.round(v.life.health * 100)}% over ${Math.round(v.life.coverage * 100)}% of it${v.life.health < v.life.threshold ? ' — below threshold' : ''}`
    }`,
  );
  L.push('');
  L.push(`NIGHT      ${v.night.dreams} dream(s), last ${v.night.lastDream ?? 'never'}${v.night.hoursSinceDream !== null ? ` (${v.night.hoursSinceDream}h ago)` : ''}`);
  if (v.night.settled) L.push(`           last settled night ${v.night.settled.boundary} — ${v.night.settled.how}`);
  // Loud, because it is the one condition that stops every day activity while
  // the mode above reads LIVE.
  if (v.night.owed) {
    L.push(`           ⚠ NIGHT OWED since ${v.night.owed.boundary} (${v.night.owed.overdueMin}m) — THE DAY IS HELD until it folds`);
    L.push(`           take it back: npx tsx src/modeCli.ts cancel-dream "<why>"`);
  }
  L.push('');
  L.push(`RUNS       ${v.runs.total} recorded`);
  if (v.runs.last) L.push(`           #${v.runs.last.id} ${v.runs.last.kind}/${v.runs.last.trigger} — ${v.runs.last.prompt.slice(0, 60)}`);
  return L.join('\n');
}
