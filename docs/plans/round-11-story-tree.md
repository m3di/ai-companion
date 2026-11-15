# Round 11 — The story tree, and memory that arrives instead of waiting

_Set down 2026-08-21, from the design conversation that read two and a half
months of live data and drew one conclusion from it. This plan is written so a
fresh agent can pick it up, plan a step, and build — read the Charter first
(`docs/CHARTER.md`), then this, then the code seams named at the bottom._

---

## The finding this round is built on

The machine measured its own central bet and the bet lost:

- **246 retrieval episodes: 228 `no-reach`, 6 `answered`, 5 `bypassed`,
  7 `tree-only`.** The day almost never reaches for the graph by choice.
- The reaches that DID happen were questions whose surface form announces the
  gap ("which documents do I sign and send to Iris"). The 228 misses are tasks
  where memory was *silently* relevant — nothing in the prompt said so, and a
  model cannot feel a gap it does not know it has. This is not laziness and it
  is not fixable with better tool descriptions: the failure happens before the
  tool list is consulted. 17/17 worker episodes `no-reach` proved the converse —
  a perfect graph entity corrects nothing if nothing reads it.
- Meanwhile the one memory surface with a *positive* track record is the one
  that is **injected**: the `## How to behave` render steers behavior nightly
  (Lena-as-reviewer, the handoff format, the Sasha correction all propagated
  through it).

**The conclusion: since the agent cannot know that it doesn't know, the system
must manufacture the gap.** Memory-as-a-tool-the-agent-reaches-for is the wrong
delivery mechanism; memory that arrives in front of the transcript, carrying
named pointers whose follow-up is cheap, is the right one. Reaching for a named
node ("see `paperwork/form-signing` for the two unsigned forms") is a
completely different decision from formulating a query out of nothing.

This round builds the artifact that delivers that: **the story tree.**

---

## The shape

### A strict tree of stories over the fact graph

The facts below stay a graph (cross-domain edges are real). The **story layer
above them is a strict tree**: every story node has exactly one parent, and
every *active* fact is narrated by **exactly one leaf story**. A fact narrated
in two stories is the I1 failure one level up ("wrong in six live files,
correctable in none"). Cross-references live in the graph and appear in stories
only as refs.

A story node:

```
story-node:
  scope     — which fact-set / which children it covers        (authored)
  text      — the narrative, BUDGETED (~300–600 tokens),
              every claim carrying refs                        (agent-written)
  children  — sub-stories                                      (structure, deterministic)
  facts     — leaf case: the graph nodes it narrates           (refs)
  dirty     — staleness flag                                   (mechanical)
  heat      — read counter, fed by retrieval episodes (I4)     (mechanical)
```

The fixed per-node text budget is what produces the resolution gradient
automatically: the root sees everything at one sentence per child; each jump
down re-spends the budget at narrower scope. A shallow cross-domain task never
leaves level 0; a root-cause dig follows refs to the floor. (Prior art, worth
reading not adopting: RAPTOR's summary tree, GraphRAG's hierarchical community
summaries, Letta's sleep-time compute.)

**The story is a RENDER (I1/I2), never a store.** Regenerated from the graph,
droppable without loss, provenance inline. The moment the storyteller writes a
sentence with no node behind it, we have an authored store in a derived costume
and it will rot exactly as root.md did. Corollary that makes it a convergence
driver: a fact the night *wants* to narrate but cannot connect is a missing
edge; a paragraph it cannot source is a missing node — **the story's failures
are the night's work queue.**

### Operations — structure mechanical, prose agentic (I9/I2)

- **Insert (routing descent).** A new/changed fact routes down the tree: at each
  level, embedding similarity *proposes* the child, the agent *confirms*. Two
  deterministic rules complete it:
  - **No child fits** → not an error: the M1 discovery signal arriving at the
    story layer. The tree is missing a branch.
  - **Leaf over budget** → **split** (B-tree style): the agent partitions the
    facts into 2–3 coherent sub-stories. Split and merge are the ONLY
    operations that change structure, both triggered by a deterministic
    condition (the budget), both executed by the agent. **Depth is earned by
    volume, never designed in advance** — at 169 entities the tree is two
    levels (root story over domain stories), and level three creates itself the
    first night a domain story genuinely overflows.
- **Propagation: up always, down only on rewrite, siblings never.** A touched
  fact marks its leaf dirty; dirtiness propagates up the ancestor path (a flag,
  instant, mechanical). The nightly rewrite runs **bottom-up along dirty paths
  only**: dirty leaves from their facts, dirty parents from their children's
  current texts, up to the root. Work per night is O(dirty leaves × depth).
  Siblings are only ever affected through the shared parent — and that is the
  feature: **the parent rewrite is where a cross-story contradiction becomes
  visible**, because the parent is the one context reading all its children at
  once. The rewrite prompt asks "do these children disagree" explicitly.
- **Consistency, honestly split.**
  - *Structural* consistency is a deterministic lint, no agent: every active
    fact reachable root→leaf and narrated by exactly one leaf; every ref in
    every story resolves to a live node; no dirty flag survives the night; no
    node over budget. This is `graphLint` extended one layer up; it runs
    nightly and is free.
  - *Semantic* fidelity (does the story faithfully compress its facts) cannot
    be deterministic and we do not pretend otherwise: a verifier agent reads
    ONE story plus its refs and votes, sampled nightly so every node is audited
    over a period. Per-node checkable is what lets a bad story be located
    instead of suspected.
- **The night's job list is a deterministic function of the tree's state.** The
  mechanical pass emits the worklist (dirty paths, over-budget nodes,
  unroutable facts, cold demotion candidates); the agent never chooses *what*
  to work on, only *how to write it*. Same property that made the run, not the
  write, the unit of operator review: two nights become comparable.

### Forgetting — generations, stubs, heat

Three generations, LSM-flavored:

1. **Active** — narrated in a leaf, reachable from the root.
2. **Dormant** — the story releases it, leaving a one-line **stub** with a ref
   ("there was a Lumenlab onboarding, spring '26 →
   `client-onboarding/lumenlab`"). A curious agent follows the ref into the
   graph and the logs, which never delete.
3. **Archived** — the stub gone too; the fact survives in the graph/journal,
   findable by search, carrying no storyline.

Rules: **demotion is driven by measured heat, not age alone** (episodes already
attribute reads per node — I4), so the root's scarce budget is allocated by
query frequency — *Huffman, not histogram*. **An open obligation is never
evicted regardless of heat**: a dormant fact with a live commitment or an
unresolved contradiction stays pinned. Forgetting by disuse is health;
forgetting a promise because nobody asked lately is the failure this rule
blocks. Promotion is symmetric: a dug-up dormant fact that gets read returns to
a leaf story.

### Delivery — render-push primary, MCP secondary

- **Primary: the level-0 story is pushed**, not fetched. For the companion's
  own day it is injected (per-task, stable for the session — I12: no clocks, no
  ticking values). For foreign agents it is written into the project's
  `AGENTS.md` by the nightly pass, so the unavoidable read is the file the
  harness already loads. "Always call orient() first" as an instruction would
  decay (round 8); a file the harness injects has probability 1.
- **Secondary: MCP**, two honest roles:
  - the **write path** — `observe`/`record` corrections from anywhere (a
    correction is an event the agent knows it is having);
  - the **drill-down** — story-node fetch, `find`, `graph`, `neighbours`, for
    the follow-up the story's refs make cheap.
- **The protocol is the portable capture seam** (not Claude-Code-only):
  - *Tier 0, automatic:* we own the MCP server; every read/write from ANY
    client lands in the HTTP log with subject, timing, depth.
  - *Tier 1, protocol:* `orient(task)` at session start, `debrief(outcome)` at
    close. The negative space — orient called, nothing else, task was X — is
    the no-reach signal reconstructed without transcripts.
  - *Tier 2, opt-in where the harness allows:* hooks / OTel export;
    transcript-derived signal ("what was said that left no trace") stays a
    bonus, never a dependency. Feature matrix per team, not a blocker.

### Measurement — stated before building (working rule 4)

- **Drill-through rate**: refs followed / refs offered, per story node.
- **Downstream honesty**: bypass + user-correction rate after a drill-through
  (guards against clickbait-for-agents — a storyteller judged on reach alone
  learns to bait; the pair of numbers is the metric).
- **The M4 number** (`cycleCli` day-reads), whose mechanism this round changes:
  the target is no longer "the day chooses to call the API" but "the day
  follows the pointers the story hands it."
- **Story heat distribution** — the falsifiable version of I6: a story that
  keeps failing to interest the day is a graph growing in the wrong direction.
- (Team phase) per-team read/render usage from the HTTP log, from hour zero.

### Team version — the constraints, named now

- **F1 must be resolved before the first byte is served.** Proposed resolution
  to take to the Charter when the team phase opens: **shared core + per-person
  private subgraphs**, visibility at the domain level. The live graph is
  radioactive (paperwork, personal domains) — the team instance starts
  FRESH, seeded only from shareable domains (`reference/`, `people/`,
  per-project conventions). No scrubbing of the live instance.
- **Auth before HTTP** (M3's unshipped half). Atlas privacy is cosmetic, not
  security. Per-audience stories are rendered from the visibility-FILTERED
  subgraph — the filter is the security; the story is just honest about what it
  was allowed to read. Story-as-obscurity is worth nothing and is claimed
  nowhere.
- **Server host.** The night moves to an always-on box; this *deletes* the
  laptop-sleep bug genre (multi-hour folds, expiring holds, killed
  subprocesses) rather than patching it again.
- **Night throughput becomes an SLO.** 41/60 folds wrote no graph node; one
  user's trickle was survivable, ten agents' inbox is not. Inbox depth is
  already reported; it becomes a number with a ceiling.

### Build vs buy — decided 2026-08-21

The 2026 landscape (Mem0, Zep/Graphiti, Letta, Cognee, Vertex Memory Bank) all
ship memory-as-a-retrieval-API — the exact mechanism the 246 episodes refuted.
None ships render-push, the story tree, curation-over-extraction, or the
measurement layer. **Build the thin distinctive layer** (story tree +
operations, render pipeline, episode/heat measurement, tenancy over the
existing store); **buy the commodity** (embedding index — derived and droppable
per I2, so the vendor choice is low-stakes and reversible; MCP SDK; standard
auth). **Do not** swap the store for Graphiti (re-porting every invariant
enforcement into someone else's data model for a temporal graph we mostly
have), and **do not** build a platform — the moat is delivery + measurement,
not storage. Read Letta's sleep-time compute notes to steal scars, not code.

---

## The roadmap

One phase per session-sized step where possible; each lands, survives nights of
real use, and its number is read before the next starts (working rules). Each
phase names its acceptance test in Charter style.

**P1 · The tree exists and root.md is its render.** Two levels only: one root
story over per-domain stories, node budgets, refs on every claim, dirty flags,
the structural lint. The nightly pass rewrites dirty paths bottom-up. `root.md`'s
narrative sections become the level-0 render — this IS M5's "root becomes a
render," reached by mechanism instead of resolve.
→ _The lint is green nightly, the root render regenerates from the tree alone,
and deleting every story and regenerating reproduces it (droppable proven)._

**P2 · The story manufactures the gap, and the machine watches whether it
works.** Level-0 story injected per-task (I12-stable); story refs made
followable (the drill-down call named inline); episodes correlate offer →
follow → outcome, so drill-through and downstream-honesty are reported by
`cycleCli` beside the M4 number.
→ _Drill-through rate is a number on a dashboard that exists, read after ≥3
nights, and the M4 day-read number moves off zero by pointer-following._

**P3 · Split, heat, stubs — when the data asks.** The split operation (the only
deeper-tree machinery needed on day one of overflow), heat-fed demotion to
stubs, the obligation pin, promotion on demand. Gated on P2's data: a node
actually overflowing, or heat actually skewed.
→ _A story node splits itself on overflow with the lint staying green, and a
cold fact demotes to a stub that a live read promotes back._

**P4 · The similarity layer.** Embedding index over facts + story scopes as a
DERIVED, droppable layer; used by routing descent and by drill-down search.
→ _Routing proposals come from the index and the agent's override rate is
measured; deleting the index loses nothing but speed._

**P5 · The door for foreign agents — own projects first.** MCP server over
`modules/entities` + story-node fetch + `orient`/`debrief`; tier-0 logging.
First clients are Mehdi's OWN other-project agents (AGENTS.md snippet + the
rendered level-0 story committed into 1–2 repos), before any teammate is asked.
→ _A foreign agent in another repo orients, follows one story ref through MCP,
and the episode appears in the same ledger as the day's._

**P6 · The team instance.** F1 resolved and amended into the Charter (its own
commit, per the working rules); auth; fresh shared graph seeded from shareable
domains; server deployment; per-audience renders. Pilot with 1–2 teammates.
→ _M7's test, unchanged: someone who is not Mehdi works with it for a week and
the graph gets better, not noisier._

**P7 · Deep capture where offered.** Tier-2 hooks/OTel package, consent-gated;
night-throughput SLO enforced.
→ _A tier-2 team's "left no trace" report exists; a tier-0 team's convergence
still works without it._

Deliberately NOT in this roadmap (I5, until a row asks): N-level generality
beyond what splits create; a manager console beyond the Atlas; "collect more
data / ask the user questions" directives to foreign agents; any platformization.

---

## Idea-test verdicts (logged in the Charter's table, 2026-08-21)

1. **Which invariant?** Serves I7 (reason on the graph, verify at the source —
   the story is the reasoning surface), I4 (heat and drill-through are
   ref-queries), I6 (heat + stubs make convergence measurable), I12 (the render
   is per-task-stable by construction). Strains I1/I2 hardest — resolved by the
   story being a strict-tree render with inline provenance, regenerated, never
   authored.
2. **Which milestone?** This IS the mechanism for M5 (root as render) and the
   amended M4 (the day reads by following, not by choosing); P5–P6 are the road
   to M7. M9's materialized-answers idea becomes the story tree's drill-down
   layer. No queue-jumping: P1–P2 precede everything team-facing.
3. **What does it delete?** Hand-maintained root.md structure (becomes level-0
   render); the assumption that better tool descriptions fix no-reach; the
   laptop as the night's host (P6); eventually `notesIndex`-style shorter
   paths, as M4 always intended.
4. **How will we know?** Drill-through × downstream-honesty, stated in P2
   before P3+ builds on them; every phase carries its acceptance test above.

---

## Code seams for the builder

- `src/operator.ts` — the nightly pass: where the mechanical worklist + rewrite
  passes mount. `src/rootBehavior.ts` — the existing (working) render pipeline
  to generalize, not replace.
- `modules/entities/` — the callable knowledge API; story-node fetch and
  `orient`/`debrief` join it; `record()` stays the only write path.
- `src/observe.ts`, `src/focus.ts` — the day's write path and the pointer
  surface P2 extends.
- `retrieval_episodes` (+ `src/traces.ts`, `noteToolCall` seam) — where
  offer→follow→outcome correlation lands. `src/graphLint.ts` — the structural
  lint's home.
- `src/cycleCli.ts` / `src/auditCli.ts` — where the new numbers must appear;
  a number not in these is a number nobody reads.
- Storage: story nodes are graph-adjacent rows (SQLite, like everything
  derived), NOT entities — they are renders, and `entities.jsonl` holds only
  authored records.

_Working rules apply unchanged: one small step per session, a dated Charter
changelog line per landing, typecheck + suite green before finishing, and no
invariant broken silently._
