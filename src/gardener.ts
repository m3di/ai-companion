import { isAuthoredRel, loadGraph, type Entity, type Graph } from './entities.js';
import type { Write } from './entityWrite.js';
import { GOAL_RELS, lintGraph, type Finding } from './graphLint.js';
import { entityWrites, recordPacketDecision, standingPacketDecisions } from './db.js';

/**
 * THE GARDENER — the linter's findings, turned into work someone can do.
 *
 * The linter answers "what is wrong". That is not the same as "what should I
 * do", and the gap between them is where a finding list goes to die: 86 yellows
 * is a number, and a night that must re-derive the fix for each one from the
 * whole graph will fix none of them. The proposal queue taught this already —
 * a claim nobody can act on cheaply is a claim nobody acts on.
 *
 * So this precomputes the ACT. For each finding it gathers the offending text,
 * the candidates, the neighbours that bear on the decision, and the exact op
 * shape that would land the fix. What arrives at the night is a packet it can
 * read in a few lines and answer with one call, instead of a symptom it must
 * investigate from scratch.
 *
 * ## What it does NOT do
 *
 * It does not decide. That is a measurement, not a principle: on 2026-08-07 the
 * deterministically fixable classes were counted and came to almost nothing —
 * 0 exact duplicate facts, 0 redundant relates-to, 0 dangling edges, 0 subsumed
 * facts, and 12 symmetric edges. The graph is already clean of the defects an
 * algorithm can settle, because the write path's guards have been doing their
 * job. Every remaining yellow turns on a judgment — which fact to keep, what
 * the real relation is, what splits off a node — and an algorithm that made
 * those calls would be dressing judgment as determinism.
 *
 * The one exception is `SAFE_OPS` below, and it is deliberately tiny.
 *
 * ## Read-only, so it can run beside the day
 *
 * `plan()` touches nothing. That is what makes it safe to run while the
 * concierge is live — and it is the reason the gardener is shaped this way
 * rather than as a second writer.
 */

export interface Packet {
  /** The lint code this answers. */
  code: string;
  id: string;
  domain: string;
  /** What is wrong, in one line. */
  problem: string;
  /** Everything needed to decide, gathered so the night does not have to look. */
  context: string[];
  /** The call that would land the fix, as a sentence the night can act on. */
  suggest: string;
  /** True only when an algorithm can be certain it improves things. */
  safe: boolean;
  /**
   * The write, as DATA, for the safe class only.
   *
   * `suggest` is prose for a reader; parsing a machine instruction back out of
   * a human sentence is how a display change silently becomes a behaviour
   * change. A packet that can be applied carries the call itself.
   */
  op?: Write;
  /** Higher = fix this first. */
  weight: number;
}

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

function edgesOf(e: Entity): Array<[string, string]> {
  return Object.entries(e.edges)
    .filter(([r]) => isAuthoredRel(r))
    .flatMap(([r, ts]) => ts.map((t) => [r, t] as [string, string]));
}

/** Who points at this node — the half of its position it cannot see itself. */
function inboundOf(g: Graph, id: string): string[] {
  return [...g.entities.values()].filter((e) => edgesOf(e).some(([, t]) => t === id)).map((e) => e.id);
}

/**
 * The ONLY class an algorithm may commit unattended.
 *
 * A symmetric `relates-to` (A→B and B→A) says one thing twice. Collapsing it
 * loses nothing: `neighbours()` reads both directions, so the surviving arrow is
 * still found from either end. It is small and it is certain, which is the whole
 * bar for being here.
 *
 * Nothing else has cleared that bar. If a candidate needs a sentence explaining
 * why it is probably fine, it belongs in a packet for a reader, not here.
 */
function symmetricEdges(g: Graph): Packet[] {
  const out: Packet[] = [];
  for (const e of g.entities.values()) {
    for (const t of e.edges['relates-to'] ?? []) {
      // Keep the lexicographically first arrow, drop its mirror — an arbitrary
      // but STABLE choice, so two runs pick the same survivor.
      if (e.id <= t) continue;
      if (!(g.entities.get(t)?.edges['relates-to'] ?? []).includes(e.id)) continue;
      out.push({
        code: 'G001',
        id: e.id,
        domain: e.domain,
        problem: `relates-to ${t} is a mirror of ${t} relates-to ${e.id} — the same statement, twice`,
        context: [`neighbours() reads both directions, so the surviving arrow is still found from either end`],
        suggest: `record({op:'drop-edge', id:'${e.id}', rel:'relates-to', target:'${t}'}, "collapsing a symmetric relates-to; the ${t}→${e.id} arrow carries it")`,
        safe: true,
        op: { op: 'drop-edge', id: e.id, rel: 'relates-to', target: t },
        weight: 1,
      });
    }
  }
  return out;
}

/** Turn one finding into a packet a reader can answer in one call. */
function packetFor(f: Finding, g: Graph): Packet | undefined {
  const e = g.entities.get(f.id);
  if (!e) return undefined;
  const base = { code: f.code, id: f.id, domain: f.domain, safe: false };

  // A judgment packet never carries an op: there is nothing to apply.
  switch (f.code) {
    // ISOLATED — the six that predate the mint checklist. The decision is what
    // it belongs to, so the packet's job is to offer candidates.
    case 'W201': {
      const words = new Set(f.id.split(/[/-]/).filter((w) => w.length > 3));
      const near = [...g.entities.values()]
        .filter((o) => o.id !== e.id && o.domain === e.domain)
        .map((o) => ({ id: o.id, hits: [...words].filter((w) => o.id.includes(w) || o.facts.join(' ').toLowerCase().includes(w)).length }))
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 5);
      return {
        ...base,
        problem: 'nothing joins it to the graph — it is findable only by knowing its name',
        context: [`facts: ${short(e.facts[0] ?? '(none)')}`, `same-domain candidates: ${near.map((n) => n.id).join(', ') || '(none obvious — try another domain)'}`],
        suggest: `record({op:'edge', id:'${e.id}', rel:'part-of'|'relates-to'|…, target:'<one of the candidates>'}, "<what makes them related>")`,
        weight: 10,
      };
    }

    // VAGUE STRUCTURE — the packet's value is showing WHICH edges are vague and
    // what the targets are, so the real relation can be named without lookups.
    case 'W203': {
      const vague = edgesOf(e).filter(([r]) => r === 'relates-to');
      return {
        ...base,
        problem: f.detail,
        context: vague.map(([, t]) => `relates-to ${t} — ${short(g.entities.get(t)?.facts[0] ?? '?', 70)}`),
        suggest:
          `for each edge above: record({op:'drop-edge', id:'${e.id}', rel:'relates-to', target:'<target>'}, "…") then ` +
          `record({op:'edge', id:'${e.id}', rel:'blocks'|'part-of'|'implements'|'evidence-for'|'tracked-by'|…, target:'<same target>'}, "<what is actually true between them>"). ` +
          `Leave any where 'relates-to' really is all that holds.`,
        weight: 6,
      };
    }

    // TOO MANY FACTS / A DOCUMENT — the decision is what splits off, so show
    // the facts numbered and ready to quote back.
    case 'W204':
    case 'W206':
      return {
        ...base,
        problem: f.detail,
        context: e.facts.map((x, i) => `${i + 1}. ${short(x, 110)}`),
        suggest:
          `if TWO subjects are mixed, split them — record({op:'mint', id:'${e.domain}/<new-slug>', kind:'${e.kind}', ` +
          `facts:['<the facts that belong to the second subject>'], chain:['<msg# or url>'], edges:[{rel:'part-of', target:'${e.id}'}]}, "…") ` +
          `then record({op:'drop-fact', id:'${e.id}', fact:'<each moved fact, verbatim>'}, "moved to the new node"). ` +
          `If it is ONE subject told at length, leave it — length is not a defect.`,
        weight: 5,
      };

    // A PARAGRAPH-LENGTH FACT — quote it in full; the fix is a rewrite and the
    // text IS the context.
    case 'W205': {
      const long = e.facts.filter((x) => x.length > 320);
      return {
        ...base,
        problem: f.detail,
        context: long.map((x) => `"${x}"`),
        suggest: `record({op:'correct-fact', id:'${e.id}', from:'<the text above, verbatim>', to:'<the durable claim, shortened>'}, "<why it is the same claim>") — and add-fact any second claim it was carrying`,
        weight: 4,
      };
    }

    // TWO FACTS SAYING THE SAME THING — both texts, so the choice is visible.
    case 'W207':
      return {
        ...base,
        problem: f.detail,
        context: e.facts.map((x, i) => `${i + 1}. ${short(x, 110)}`),
        suggest: `keep the one that is more specific or better sourced: record({op:'drop-fact', id:'${e.id}', fact:'<the redundant one, verbatim>'}, "<what the survivor already says>")`,
        weight: 8,
      };

    // NAME TWINS, UNLINKED — two ids sharing a prefix with nothing joining them.
    // Either a duplicate to merge or a relation nobody stated.
    case 'W211': {
      const other = f.detail.match(/with (\S+),/)?.[1];
      const twin = other ? g.entities.get(other) : undefined;
      return {
        ...base,
        problem: f.detail,
        context: [
          `${e.id}: ${short(e.facts[0] ?? '?', 90)}`,
          twin ? `${twin.id}: ${short(twin.facts[0] ?? '?', 90)}` : '(twin not found)',
          `inbound to ${e.id}: ${inboundOf(g, e.id).join(', ') || 'none'}`,
        ],
        suggest: `if they are ONE thing: record({op:'retire', id:'<the lesser>', into:'<the survivor>'}, "…") — carry any unique fact across FIRST. If two things: record({op:'edge', …}) to state how they relate.`,
        weight: 9,
      };
    }

    // A PLAN THAT REACHES NO GOAL — the decision is what it is FOR. Three
    // outcomes, and the packet carries what each needs: the goals already in
    // reach (attach), the chain and the journal reasons that say why the node
    // was written (mint the outcome they name), or neither (SKIP — and the skip
    // is the day's cue to ask, in the flow, when the topic next comes up).
    case 'W213': {
      const goals = [...g.entities.values()].filter((o) => o.goal);
      const sameDomain = goals.filter((o) => o.domain === e.domain);
      // What it already points at, one hop: the parent is usually where the
      // goal is, or where it should be minted.
      const parents = edgesOf(e)
        .filter(([r]) => (GOAL_RELS as readonly string[]).includes(r) || r === 'relates-to')
        .map(([r, t]) => `${r} ${t} — ${short(g.entities.get(t)?.facts[0] ?? '?', 70)}${g.entities.get(t)?.goal ? ' (GOAL)' : ''}`);
      const reasons = entityWrites(e.id, 5)
        .map((w) => w.reason)
        .filter((r): r is string => !!r && r.length > 10)
        .map((r) => `"${short(r, 100)}"`);
      return {
        ...base,
        problem: `${f.detail} — nothing says what it is for, so it can only be repeated`,
        context: [
          `facts: ${e.facts.slice(0, 2).map((x) => short(x, 100)).join(' · ') || '(none)'}`,
          `chain: ${e.chain.join(', ') || '(none)'}`,
          `written because: ${reasons.join('; ') || '(no journal — predates the write path)'}`,
          `points at: ${parents.join('; ') || '(nothing along ' + GOAL_RELS.join('/') + ')'}`,
          `goals in ${e.domain}: ${sameDomain.map((o) => `${o.id} — ${short(o.facts[0] ?? '', 60)}`).join('; ') || '(none — the domain has no stated outcome)'}`,
        ],
        suggest:
          `if one of the goals above IS what this is for: record({op:'edge', id:'${e.id}', rel:'part-of'|'blocks', target:'<that goal>'}, "<what the evidence says it is for>"). ` +
          `If the chain or the reasons NAME an outcome no node holds: record({op:'mint', id:'${e.domain}/<outcome-slug>', kind:'project', goal:true, facts:['<what done looks like, in the words of the evidence>'], chain:[<the same chain>], edges:[{rel:'part-of', target:'<its parent>'}]}, "…") then the edge above. ` +
          `If it is a how-to or a standing lane with no outcome by design (a runbook, a convention, a hobby kept pressure-free): gardenSkip({code:'W213', id:'${e.id}', decision:'reference', reason:'…'}). ` +
          `If the evidence does not say what it is for: gardenSkip({code:'W213', id:'${e.id}', decision:'unknown', reason:'…'}) — that is the day's cue to ask when the topic next comes up, not yours to guess.`,
        weight: 7,
      };
    }

    // A NOTE HOLDING FACTS.
    case 'W212':
      return {
        ...base,
        problem: f.detail,
        context: [`note: "${e.note}"`],
        suggest:
          `record({op:'add-fact', id:'${e.id}', fact:'<each durable claim from the note>'}, "lifted from the note") for each, then ` +
          `record({op:'note', id:'${e.id}', note:'<the short aside that is left>'}, "…")`,
        weight: 3,
      };

    default:
      return undefined;
  }
}

/** The two refusals that outlive the finding — see `packet_decisions`. */
export const SKIP_DECISIONS = ['reference', 'unknown'] as const;
export type SkipDecision = (typeof SKIP_DECISIONS)[number];

/** What a decision was made ON: the chain. A longer chain reopens the question. */
function evidenceOf(e: Entity | undefined): string {
  return e ? e.chain.join(',') : '';
}

/**
 * Decline a packet durably. Only for the two answers whose finding never stops
 * firing; a packet the evidence settles is fixed with record(), not skipped.
 * Returns the refusal, if any, so a tool can hand it back verbatim.
 */
export function skipPacket(
  spec: { code: string; id: string; decision: string; reason: string; actor?: string },
  g: Graph = loadGraph(),
): { ok: true } | { ok: false; problem: string } {
  if (!(SKIP_DECISIONS as readonly string[]).includes(spec.decision)) {
    return { ok: false, problem: `decision must be one of ${SKIP_DECISIONS.join(', ')} — 'reference' (it is a how-to, not a plan) or 'unknown' (the evidence does not say what it is for)` };
  }
  const e = g.entities.get(spec.id);
  if (!e) return { ok: false, problem: `no entity ${spec.id}` };
  if (!spec.reason.trim()) return { ok: false, problem: 'a skip needs a reason — say what you read and why it did not settle it' };
  if (!lintGraph(g).findings.some((f) => f.code === spec.code && f.id === spec.id)) {
    return { ok: false, problem: `${spec.code} does not fire on ${spec.id} — there is nothing to decline` };
  }
  recordPacketDecision({ code: spec.code, entity_id: spec.id, decision: spec.decision, reason: spec.reason, evidence: evidenceOf(e), actor: spec.actor ?? 'nightly' });
  return { ok: true };
}

export interface Plan {
  packets: Packet[];
  safe: Packet[];
  /** Rot at the time of planning, so a caller can measure what a pass achieved. */
  rot: number;
}

/**
 * Prepare the work. READ-ONLY — safe to run beside a live day.
 *
 * `limit` bounds a pass on purpose. "Normal to heavy" is a real setting and
 * unbounded is not: a gardening run that rewrites forty nodes in one night is
 * indistinguishable from a bad night, and the journal it leaves is too large to
 * review. Bounded means the diff stays readable.
 */
export function plan(limit = 12, g: Graph = loadGraph()): Plan {
  const report = lintGraph(g);
  const safe = symmetricEdges(g);
  // A standing refusal holds while the evidence it was made on holds: the same
  // chain means nothing new to read, and re-offering it teaches nothing.
  const declined = new Set(
    standingPacketDecisions()
      .filter((d) => (SKIP_DECISIONS as readonly string[]).includes(d.decision))
      .filter((d) => d.evidence === evidenceOf(g.entities.get(d.entity_id)))
      .map((d) => `${d.code}|${d.entity_id}`),
  );
  const packets = report.findings
    .filter((f) => f.severity === 'yellow' && !declined.has(`${f.code}|${f.id}`))
    .map((f) => packetFor(f, g))
    .filter((p): p is Packet => !!p);

  // One packet per node per code: several findings of the same kind on one node
  // are one piece of work, and listing them separately makes a tidy node look
  // like a disaster.
  const seen = new Set<string>();
  const deduped = packets.filter((p) => {
    const k = `${p.code}|${p.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  return { packets: deduped.slice(0, limit), safe, rot: report.rot };
}

/** Render a plan for an agent: compact, and complete enough to act without a lookup. */
export function renderPlan(p: Plan): string {
  if (!p.packets.length && !p.safe.length) return 'The graph has no open gardening work.';
  const out: string[] = [
    `GARDENING PLAN — ${p.packets.length} packet(s), rot ${p.rot}.`,
    `Each packet carries everything needed to decide. Do the ones you can answer`,
    `from the evidence; SKIP any that needs information you do not have — an`,
    `unsure fix is worse than an untouched node. A skip that will still be true`,
    `tomorrow (a process that is a how-to, not a plan; a goal the evidence does`,
    `not name) is recorded with gardenSkip so it is not offered again.`,
    '',
  ];
  for (const k of p.packets) {
    out.push(`[${k.code}] ${k.id}`);
    out.push(`  problem: ${k.problem}`);
    for (const c of k.context) out.push(`  · ${c}`);
    out.push(`  → ${k.suggest}`);
    out.push('');
  }
  if (p.safe.length) out.push(`${p.safe.length} mechanical fix(es) available (G001, symmetric edges) — apply with \`gardenCli --apply\`.`);
  return out.join('\n');
}
