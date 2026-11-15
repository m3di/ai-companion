# The Charter — the Colleague

_Set down 2026-08-01, from the round-10 architecture statement and the design pass
that followed it. This document fixes the destination. Rounds move toward it;
this does not move with them._

Sibling docs: [BRAIN.md](BRAIN.md) is the running design log (why we changed our
minds). [ROADMAP.md](ROADMAP.md) is the historical phase plan, superseded from
round 10 onward by this file. `docs/plans/round-*.md` are the per-round working
plans.

---

## The destination

> A colleague at BA — hired, not installed.
>
> It works with everyone on the team, not just its operator. It builds its
> understanding of how the company actually works from the work it participates
> in, and holds that understanding as a **graph it maintains itself**. It
> reasons over that graph rather than re-reading the world, and touches a source
> only to verify a final fact. Its memory **converges** — it gets denser and
> more useful without growing without bound. Its nights are **self-healing,
> self-developing, self-expanding**: it audits its own machinery, repairs what
> broke, and extends its own capabilities where its own friction says it needs
> to. It is **provisionable by an operator** — Mehdi grants it access, sets its
> bounds, and can see everything it knows and everything it did.
>
> The Atlas is the operator's backdoor into all of it.

Name for the whole thing: **the Colleague**. The graph is its memory; the night
is its metabolism; the Atlas is its x-ray.

---

## The invariants

These are the load-bearing rules. Each one was bought with a real failure. A
change that breaks one is not a tradeoff — it is a regression, and needs this
document amended before the code.

**I1 · One home.** A fact lives in exactly one node. Everything else — `root.md`,
`_map.md`, a brief, a report — is a *render*. _Bought by:_ the Core-API client
list, wrong in six live files, correctable in none.
_Tested by:_ no fact string duplicated across domains.

**I2 · Authored or derived, never both.** Every field declares which it is.
Derived fields are never hand-written; authored fields are never regenerated.
`state` is probe-owned, `observed` is night-owned, `facts[]` are authored,
`_map.md` is generated. _Bought by:_ `renderMap()` nearly deleting four of
Mehdi's authored ideas.
_Tested by:_ a generator may not write outside its declared territory.

**I3 · A check has three outcomes.** A value, no answer, and a failure. **Only a
value may become state.** _Bought by:_ an empty probe result stored as a state,
freezing the layer for three days. _Shipped 2026-07-31._

**I4 · Everything carries refs.** Every event names the graph nodes it touched —
a note, a nightly write, a focus item, an agent's read. Refs are what make
memory auditable, attention measurable, and the Atlas's overlays a query rather
than a feature. _Bought by:_ three days of activity that reached the graph
nowhere, invisible until a human looked.
_Tested by:_ every write is journalled with its refs; every read is attributable.

**I5 · Growth is demand-driven.** No new function, domain, field, or subsystem
without a recorded demand — a friction row, an unattributable note, a failing
need. _Bought by:_ ten documented API functions, called three times, ever.
_Tested by:_ a new capability cites the row that asked for it.

**I6 · Memory converges.** The graph must be able to prove it is not growing
without bound: facts age and are confirmed or raised, closed work goes dormant
then archives, coverage is measured. _Bought by:_ 97 of 153 entities with no
probe, and no way to tell whether that was fine or a hole.
_Tested by:_ `stats()` answers "is this converging" with a number.

**I7 · Retrievable, not remembered.** Every fact is either re-derivable by a
command or provenance-linked to the evidence that made it. The agent reasons on
the graph and hits the source to verify, not to recall.
_Tested by:_ a fact with neither a probe nor provenance is a lint warning.

**I8 · A check may never block its own repair.** _Bought by:_ the lint that
detected corruption and thereby disabled the only mechanism that could fix it.

**I9 · If it must hold, it cannot be an instruction.** Mechanism over prompt
line. _Bought by:_ round 7's writing rule, and every mandate before it.

**I11 · An observer may not damage what it observes.** Health checks, audits,
snapshots and dashboards read; they do not write, delete, or reconfigure the
thing they are measuring. Any tool with a destructive step must verify its own
target rather than trust an ambient setting. _Bought by:_ M2's nightly audit
shelling out to `npm test`, whose snapshot step deleted its destination, whose
destination came from the environment, which in the bot named the LIVE database
— the night auditing its health destroyed 5,491 messages, recovered only from a
backup that existed by luck.
_Tested by:_ `test/prepare.ts` refuses when its destination resolves to its source.

**I12 · Nothing that moves goes in front of the transcript.** A system prompt is
a cache prefix: every byte of it sits ahead of the whole conversation, so a
value that ticks makes the entire history uncacheable and re-billed at roughly
twelve times what reading it costs. Injected context must be STABLE for the life
of the session — per-task, not per-clock and not per-probe. A surface that
changes underneath a running agent is passed in the turn, or not at all.
_Bought by:_ the focus set living in the worker's injected context, carrying a
per-item `checked <wall-clock>` stamp refreshed by a sweep that runs every few
minutes. On 2026-08-02 a single worker session spent **$86.42 of the day's
$116.89**; two calls 67 seconds apart — well inside the cache TTL — each
re-wrote ~614k tokens, and one of them produced 372 tokens of output for $3.87.
The work was never expensive; the prefix was. Note that this is I9 again in a
new place: "keep the injected context stable" cannot be an instruction, because
nothing that reads it can tell that it moved.
_Tested by:_ `test/workerPrompt.test.ts` — the worker's system prompt must be
byte-identical across builds with the world moved between them, and hold no
clock, no date and no directory; `test/workerContext.test.ts` — the one-time
session-open block renders the same brief byte-identically and names the day
the thread began exactly once (a snapshot may carry a date; a prefix may not).

**I10 · The operator can see everything.** Every write, every read, every night's
reach is inspectable — that is what makes an autonomous night safe to grant more
power to. The Atlas is not a nicety; it is the accountability surface.

**I11 · A day begins only after its night has ended.** The fold is the day's
termination routine, so it is a PRECONDITION of the next day, not an appointment
inside it. While a night is unfolded, nothing that belongs to the day may run —
no turn, no worker, no commitment, no sweep — however late it has become. And
because a mandatory thing that cannot be given up on is a trap, the night is
always cancellable: the pass stops, its writes roll back, the boundary is marked
settled, and the day opens (this is I8 applied to the night).
_Bought by:_ three days of one failure wearing three faces. **08-12** — an
induced `/dream` folded the window and the scheduled row, which could not see
that, folded it again three minutes later (dreams #66 and #67). **08-13** — the
pass landed 2h45m late. **08-15** — the morning routine fired at 05:15 and the
fold meant to CLOSE the previous day landed at 05:48, so the morning was written
into yesterday's session and then rewritten underneath by the night that was
supposed to end it. A schedule is a time at which something is *attempted*;
nothing else in the machine could ask whether it had actually happened.
_Tested by:_ `test/night.test.ts` — the debt holds every day activity, and holds
none of the four things that pay or cancel it.

_Amended 2026-10-05: the fold is also the next day's INITIALIZATION._ The night
clears the concierge's transcript, so whatever the day agreed about a NAMED DAY
reaches the next morning only through what the night files — and the only
surface the session-open snapshot reads from before is the commitments due
that day. _Bought by:_ Lisbon, 2026-10-03: checkout, film and flight for the
next day agreed over twelve turns, judged "transient logistics, nothing to
file" (dream #121), and the departure morning offered sightseeing, on a
"Saturday" that was a Sunday — the snapshot carried no date either.
_Tested by:_ `test/dated.test.ts` — every human message naming a day or a time
is offered to the night and carried until it gets a verdict; the snapshot's
first line names today and yesterday.

---

## The shape

### Settled

- Entities are the store. A domain is a file of records; `.jsonl` is data, `.md`
  is a generated view, SQLite is a derived index rebuilt on parse.
- A restricted, hand-rolled grammar — not YAML — so the parser can refuse.
- `state` (probe-owned) and `observed` (night-owned) are separate clocks.
- Facts carry `since` / `last_confirmed`.
- `record()` is the only write path into the graph. Nothing edits entity files
  by hand.

### Open forks — decide before the shape sets

**F1 · One brain or many.** Today: `chatId` was deliberately dropped, one shared
brain, one focus set, one root. Hiring at BA forces the question: does each
person get a subgraph over a shared core, or does one graph carry `person` edges
and per-person *views*? This decides node identity, focus-set ownership, notes
routing, and auth. **It is the largest unmade decision in the system and it
gates M7.** Deadline: before M3 ships auth.

**~~F2 · Domain as folder, or domain as an edge.~~** **Resolved 2026-08-02:
folder.** A node that belongs to every domain gets a folder of its own rather
than the grammar growing a second membership mechanism — `people/`, enforced by
a lint that refuses a `person` filed anywhere else. The cheap direction, and
reversible: ids live in files.

**~~F3 · Behavior as facts, or behavior as prose.~~** **Resolved 2026-08-05:
facts — but DISTRIBUTED, not collected.** Three were converted by hand as this
fork prescribed, and the exercise showed the question was posed too narrowly.
There is no single "self node" answer because the habits are not one kind of
thing. They partition three ways:

- **Facts about entities, mis-filed as behavior.** "Sasha is MALE — short for
  Marko" is not a rule about behaving, it is a fact about a person, and it lived
  only in the root. Likewise Mehdi's rhythms, the Fibery-description rule, the
  paperwork grounding rule. The tell is stark: `people/mehdi` is the graph's
  hub (57 cross-domain neighbours, M0) and held **one** fact — everything the
  system has learned about working with him was prose.
- **Already in the graph, duplicated in the root.**
  `affiliate-app/launchpad-check-qa-gate` states its habit almost verbatim, and
  `reference/link-conventions` states another. Live I1 violations. The night
  invented this migration itself on 08-04 ("pushing down domain-specific
  mechanism from a root habit line") and could not finish it, because it cannot
  safely edit root prose.
- **Genuinely self-referential operating rules** — watchRun over held turns,
  deliver silent, focus intake is manual, a handoff is a pointer, tier 1 means
  actionable-now. These had no home in the graph at all, which is the real gap
  this fork existed to find. `self/` is now a domain and `self/companion` holds
  them.

So **`root.md` becomes a render** and I1 completes — but a render over a
distributed set, not over one node. Provenance stays inline in the fact text
(`(07-12)`), as the existing entities already do; `facts[]` has no per-fact
provenance field and does not need one.

**The dependency that decides sequencing:** `## How to behave` is injected into
**workers**, and workers have no graph access. So root cannot become *pointers*
until they can follow one. It can become a *render* immediately — generated
text, one home, derived view (I1 + I2) — and workers never notice. Render
first; pointers are a later optimisation, not a prerequisite.

**F4 · Procedural knowledge.** 29 depth notes hold *how* and *why*. Do they
become `process`/`step` entities (2 exist today), or does a `note` blob on an
entity stay legitimate? This is the real cost of retiring the tree.

---

## The milestones

Each has one acceptance test. Not done until the test passes.

**M0 · The center.** ✅ _2026-08-02._ `actor` becomes an edge; person nodes hoist
into `people/`; the hub is whatever the graph points at most.
→ _The Atlas shows one connected graph with a heart._

_Amended while building: the original test said "and no `actor` string remains",
which had the design backwards. `actor` STAYS as the authored field and
`acted-by` is derived from it on every load — that is what makes the hub
unable to drift (I2). Migrating the strings into edges would have been the
authored version of the same thing, and it would rot. Result: 66 derived edges,
`people/mehdi` at 57 cross-domain neighbours against 7 for the next non-person
node. Outstanding: the settled sky needs Mehdi's eye — see the last commit._

**M1 · The inbox.** ✅ _2026-08-02._ Notes carry
refs at capture time. The night drains a typed queue instead of re-deriving the
day. An unattributable note is the signal that the graph is missing a node.
→ _`entities.jsonl` is modified every night, and inbox depth is a reported
number._

_Landed: the `observations` table, `observe(text, about, evidence)` on both the
concierge and workers, refs resolved against the live graph at capture time,
unresolved refs kept and counted as the discovery signal, depth surfaced into
the bulletin once it goes deep or stale, `src/inboxCli.ts`, and the nightly
fold — the inbox is the night's FIRST graph job, before a line of the timeline,
with `foldObservation` required on every row including the ones needing no
write. Still to prove on live data: that the fold actually runs and the queue
does not grow._

**M2 · The night reads, writes, and audits.** ✅ _2026-08-02._ (round 10 steps
3–4.) The operator reads the graph via `callModule`, writes via `record()`,
carries the contradiction rule, and opens its night by reading the machine's own
discomfort —
friction, halted sweeps, unanswered checks, coverage, tests, build.
→ _Every audit input gets a line whether or not it fired, and a red suite reaches
Mehdi by morning._

_The audit runs before the empty-window skip, so a quiet chat day cannot hide a
broken machine. It earned itself on its first run by catching a genuinely flaky
suite — every `ADD COLUMN` was check-then-act and the suite runs one process per
file against one database, so 2 runs in 6 died on `duplicate column name`.
Outstanding: nothing captures unhandled exceptions in the bot process yet, so
that row of round 10's audit table is still unbuilt._

**M3 · Attention, and the operator's backdoor.** ⏸ _gated on run data — see
below._ Reads become ref-tagged, so
"what did the day look at" is a query. The Atlas gains **auth** and four overlays
that are one mechanism, not four features: select a **dream** → highlight what
that night touched; a **session** → the attention heatmap; the **focus set** →
the reading plan lit on the graph; the **notes inbox** → what is queued and where
it will land. Refs (I4) make all four the same query.
→ _Select last night's dream and see exactly what it touched._

_**The gate, agreed 2026-08-02.** M0–M2 shipped in one day and not one of them
has survived a night. M1's whole premise is that agents REACH FOR `observe` —
the same bet round 9 lost with ten functions called three times — and if they
do not, M2's fold has nothing to fold and M3's attention data is empty. M3 also
opens with F1, the largest unmade decision in the system, which should not be
guessed at before a real multi-agent day has been measured. Run 2–3 nights,
then read `src/auditCli.ts`, `src/inboxCli.ts` and `--missing`, and let those
answers shape M3 rather than this document._

_Shipped ahead of it, because they touch no agent and no graph: private domains
(a screenshare guard — shape kept, content hidden, `web/src/privacy.ts`) and
real URL routing (`/`, `/domain/{id}`, `?details=`), so back and forward are the
browser's and any view can be pasted._

**M4 · Focus as a reading plan.** Each focus item points at an entity;
`neighbours(ref)` supplies what to fetch, why, in what order. `notesIndex` is
deleted from the day's context so no shorter path than the API remains.
→ _API call counts rise, measured against a single before/after._

_**The number, read 2026-08-15, and it is zero.** `cycleCli` reports
`DAY 0 / NIGHT 18` and `DAY 0 / NIGHT 29` on two consecutive cycles: the day has
never once reached into the graph. Meanwhile the day's reads go to prose —
`note` 105 retrievals, `message` 53 — and the friction ledger holds **30
`bypass` rows**, each one an agent that had a question and read `root.md`
instead of asking. The graph is written by the night and read by nobody, which
is worse than an unused feature: nothing selects for its quality, so the loop
closes on itself — the day reads the tree because the graph is not good enough,
and the graph does not improve because nothing reads it and finds it wanting.
That loop is what blocks M5, and it is why M4 is the live milestone._

_**Amended 2026-08-15: log the read path as EPISODES, not calls.** M9 optimizes
against this workload, and `module_use` cannot serve it — it aggregates by shape
and discards ordering, grouping and outcome. The unit is the **question**
(trigger → the ordered calls → answered or bypassed), for the same reason the
run and not the write became the unit of operator review: a judgement about a
path cannot be made from a bag of steps. This must land WITH M4 rather than
after it — the grouping cannot be reconstructed later, so retrofitting it means
discarding the first weeks of workload, which are the only ones that exist._

**M5 · Convergence.** Procedural knowledge enters the graph (F4). `_map.md` is
purely generated, depth notes are entities or gone, and `root.md` becomes a
*render* — hub, facts, habits, focus.
→ _The night clears the day's session, the day boots on root + catalog + focus
alone, and loses nothing._

**M6 · Bounded memory.** Age-based fact review, dormancy, archival, coverage as a
measured property.
→ _`stats()` shows the graph denser than last month and not larger without a
reason._

**M7 · The colleague.** F1 resolved. Multi-user identity, a second transport,
per-person views, operator provisioning and access grants.
→ _Someone who is not Mehdi works with it for a week and the graph gets better,
not noisier._

**M8 · Self-extending.** The night may propose and land new **module** functions —
never `src/` — when a friction row asked for one, gated on a green suite.
→ _A function exists that Mehdi did not ask for, that gets called, whose demand
row can be pointed at._

**M9 · The graph answers.** ⏸ _gated on M4 producing a workload._ The shape is
derived from the questions, not authored ahead of them. Retrieval episodes are
ranked by give-up (`bypass`) and then by cost; recurring paths are collapsed —
mechanically detected as call n-grams, proposed by the night. Output splits in
two, and the split is the whole safety argument (I2): **derived** materialized
answers that `find`/`graph` consult transparently, regenerable and droppable;
and **authored** structural changes, which mean the graph is missing a concept
and therefore go through `record()` as a reviewed proposal.
→ _A recorded episode is replayed against the restructured graph and takes
strictly fewer steps, with the before/after on the same query._

_Why this one is different from every previous "the night improves the graph"
idea: it is falsifiable per change. The optimizer does not get to report its own
success — the query log is the test set, and the same question is re-run against
the old shape and the new. M6 asks whether the graph got denser; this asks
whether it got FASTER TO ASK, which is the property a memory is actually for._

---

## How to work against this

**Every session:** read this file, pick the smallest step inside the current
milestone, take it, and add a dated line to the changelog below. Small is the
point — the system runs live between sessions, and every step should survive a
night of real use before the next one lands.

**Every change** names the invariant it serves or the milestone it advances. A
change that serves neither is either a bug fix or does not belong yet.

**The idea test.** Before building anything new — including anything in this
document — answer four questions:

1. **Which invariant does it serve, or which does it strain?**
2. **Which milestone does it advance, and does it jump the queue?**
3. **What does it delete?** The strongest levers in this system have been
   deletions (`notesIndex`) and joins over existing data (`actor` → edge).
   A new subsystem should be the last resort.
4. **How will we know it worked?** State the measurement before building. "The
   API is not called" was invisible for three days because nobody had named the
   number.

An idea that survives all four gets logged below and enters a milestone. One
that doesn't gets logged too, with the reason — a rejected idea with its reason
recorded is worth more than a forgotten one.

---

## Ideas measured

| date | idea | verdict |
|---|---|---|
| 2026-08-01 | Identity as the missing center | **Accepted → M0.** But derived, not dreamed: the hub is a join over `actor`, and only the *behavioral* half is authored (F3). A nightly-authored hub would repeat root.md's rot. |
| 2026-08-01 | Notes as a ref-carrying inbox the night drains | **Accepted → M1.** The day's write path, and the missing half of `record()`. Unattributable notes become domain discovery — satisfies I5. |
| 2026-08-01 | Delete the md tree entirely | **Accepted as destination → M5.** Not yet: the graph cannot hold procedural knowledge (F4), and `root.md` stays as a *render* — prose is what an LLM boots from. |
| 2026-08-01 | Focus as a formal graph-traversal language | **Deferred.** Take the cheap 90% first (M4: a ref + `neighbours()`). A DSL is earned when hand-written fetch orders start repeating, not before — the focus set's failures were checker bugs, not missing expressiveness. |
| 2026-08-01 | The night writes its own API + tests | **Accepted → M8, gated.** Viable because `modules/` is a real sandbox with a suite; dangerous without I5's binding rule. Must follow M2, which is what makes demand visible. |
| 2026-08-01 | Night ends on green build + clears the day session | **Accepted, as an acceptance test → M5.** Not a step. The day can only start empty once nothing it needs lives outside the graph. |
| 2026-08-02 | Atlas: private domains, shape kept and content hidden | **Accepted, shipped.** View-only, localStorage, never the graph — a viewing preference that could change what the system BELIEVES would be a memory bug wearing a UI hat. Explicitly not security; that is server-side and belongs to M3's auth. |
| 2026-08-02 | Atlas: the URL holds the view | **Accepted, shipped.** Back and forward stop being a hand-written ladder and become the browser's, and a view becomes something you can send someone. |
| 2026-08-02 | Atlas: `?moved` — make the camera navigable | **Rejected after shipping, same evening.** Detecting "the user moved the camera" means telling a gesture apart from the app's own `zoomToFit`, which fires the same event. The heuristic read a stale baseline after each settle, decided the user had moved, pushed history and re-fit — the app manufacturing its own gestures on a loop. A state derived by guessing which of two indistinguishable events happened is wrong sometimes, and a feedback loop is what "sometimes" looks like. |
| 2026-08-02 | Migrate `actor` strings into authored edges | **Rejected while building M0.** It is the authored version of a derivable fact, so it can drift from the field it duplicates — I1 and I2 both. Derived on every load instead, which also made the migration nine lines instead of a rewrite of 56 records. |
| 2026-08-05 | An agentic graph-optimizer: an agent that reads the graph structurally and reshapes it | **Accepted as direction → M6; first step redirected.** It *is* what I6 promises, and the demand rows are real (a duplicate pair nothing could detect, a node misfiled two days, 44% of authored edges vague). But it failed two legs of the test as proposed: it deletes nothing, and it named no measurement — while M6's acceptance test *is* a number that did not exist. An optimizer built first would have had no evidence it helped except its own report, which is the failure the graph exists to avoid. So the measurements ship first (`modules/graph`), as a join over existing data rather than a new subsystem, and the agent is a thin layer over them next. Authority scoped to move + re-edge (ops that exist and are ref-preserving); merge/retire/split stay refusals the night folds. |
| 2026-08-05 | Run the optimizer BEFORE the night's fold | **Rejected — order inverted.** An observation's refs are resolved at capture time (M1's premise), so restructuring first invalidates the queue it is about to be folded from. Proven the same day: the first `move` this system ran left observation #12 pointing at an id that no longer existed. Worse than a dangling ref, it *lies* — "resolved to nothing" is the signal reserved for a node the graph is MISSING (I5). Order is **fold → garden → refine**, and `move` now carries pending refs as mechanism rather than instruction (I9). |
| 2026-08-15 | **The graph's shape is derived from the questions asked of it.** Log the read path (which calls, in what order, did it answer), and let the night propose restructures that shorten recurring paths | **Accepted → M9, gated on M4.** _(1) Invariant:_ serves I4 — refs already make "what did the day look at" a query, and this is the same data read as a workload rather than an audit trail. **Strains I2 hard**, and that decides the design: the optimizer's output must be DERIVED and droppable (materialized answers `find`/`graph` consult transparently), never authored facts. Where the honest fix is a missing *concept*, it goes through `record()` as a reviewed proposal — caching never needs approval, a new node always does. _(2) Milestone:_ new M9; it cannot jump M4, because an index advisor with an empty query log recommends nothing, and the workload is **literally zero today** (day reads: 0 calls, two cycles running). _(3) Deletes:_ hand-tuned prompt guidance about which calls to make in which order — the path becomes measured instead of instructed. Also folds `module_use`'s shape aggregation into the episode, rather than adding a store beside it. _(4) Measurement:_ **replay.** Every recorded episode can be re-run against the restructured graph and its steps counted before and after — falsifiable per change, which is the property every previous "the night improves the graph" idea lacked. Rank by `bypass` (the agent gave up and read prose — 30 rows already, the highest-signal row in the ledger) ahead of cost, because a slow answer beats no answer. Prior art is mature and worth reading rather than re-deriving: index advisors (Chaudhuri & Narasayya 1997), materialized-view selection (Harinarayan et al. 1996), database cracking (Idreos et al. 2007), and ACT-R's knowledge compilation (Anderson 1982) for the "collapse a recurring chain into one step" mechanism. Known failure mode, from the same literature: overfitting to last week's workload — which is what the derived/droppable rule above is for. |
| 2026-08-15 | Model memory as continuous / embeddings instead of discrete facts | **Rejected.** It buys the wrong axis at the cost of the whole point. The felt problem — "a few discrete lines, not a distribution" — is not discrete-vs-continuous representation, it is **instance vs estimate**: "on 08-12 he deferred eight packets" versus "defers structural edge work when evidence is thin, 8 of 9 across 3 nights". Both are discrete text, both auditable, and only the second answers a question it was not told. Vectors would forfeit I4 and I10 — a vector cannot be argued with, corrected with a reason, or shown in the Atlas — to solve a problem that support-counts on facts solve while staying inspectable. Stay discrete in representation; go distributional in semantics. And the distribution that should shape the STORE is the query distribution, not the fact distribution (see the row above): Huffman, not histogram. |
| 2026-08-15 | Make the night mandatory — no day activity before or during the fold | **Accepted → I11.** It deletes a whole scheduling path (the nightly commitment row) rather than adding one, and the number it moves is countable: folds per boundary, which was 2 on 08-12 and 0-before-the-morning on 08-15, and must be exactly 1. The risk was named in the same breath as the idea — "if we go so strict it will bite, something urgent will come up" — which is why the cancel shipped in the same step rather than after the first time it bit. A mandatory routine without an escape hatch is not strictness, it is a bot nobody can reach. |
| 2026-08-01 | Atlas auth + dream / session / focus / notes overlays | **Accepted → M3.** Four asks, one mechanism: they are all "which nodes did X touch", which is I4. Half-built already (`record()` journals, `history(ref)` exists); what's missing is refs on *reads*. |
| 2026-08-21 | **The story tree: a budgeted, strict-tree narrative render over the graph, maintained by the night, delivered by push.** Since the day cannot know that it doesn't know (228/246 episodes `no-reach`, and the only surface with a positive record is the injected render), the system manufactures the gap: a level-0 story with named refs whose follow-up is cheap, drilling down a tree whose depth is earned by node-budget splits. | **Accepted → round 11** (`docs/plans/round-11-story-tree.md`). _(1)_ Serves I7/I4/I6/I12; strains I1/I2 hardest, resolved by the story being a RENDER — regenerated, droppable, every claim ref-carrying, each active fact narrated by exactly one leaf. _(2)_ It is the mechanism for M5 (root becomes a render) and amends M4's success mechanism: the day reads by FOLLOWING pointers, not by choosing to call an API — the number stays `cycleCli`'s day-reads, joined by drill-through × downstream bypass/correction (the pair, so a storyteller judged on reach alone cannot learn to bait). _(3)_ Deletes hand-maintained root structure and the belief that better tool descriptions fix no-reach. _(4)_ Measured before built: P2 lands the offer→follow→outcome correlation before P3+ builds on it. Structure stays mechanical (route, split on budget, dirty-up, rewrite bottom-up along dirty paths, structural lint), prose stays agentic (I9/I2); contradictions surface at the lowest common ancestor's rewrite; forgetting is heat-driven demotion to stubs with open obligations pinned — Huffman, not histogram. |
| 2026-08-21 | Serve the memory to the team over MCP so everyone's agents converge | **Accepted as direction → M7 via round 11 P5–P6, with the delivery inverted.** The team's felt pain is real (divergent handoff/review quality), but memory-as-MCP-the-agent-reaches-for is the mechanism the episode data already refuted — so render-push (the nightly level-0 story written into each project's AGENTS.md) is primary, and MCP is the write path + drill-down. The `orient`/`debrief` protocol doubles as a harness-agnostic capture seam (tier 0: HTTP log; tier 1: protocol; tier 2: opt-in hooks). Hard gates named now: F1 resolved first (proposed: shared core + per-person private subgraphs), auth before HTTP, a FRESH team instance seeded from shareable domains (the live graph is private and is not scrubbed), the night on an always-on host, inbox depth as an SLO. Build-vs-buy decided: the 2026 platforms (Mem0, Zep/Graphiti, Letta, Cognee) all ship the refuted mechanism and none ships render-push, curation, or measurement — build the thin distinctive layer, buy embeddings/MCP SDK/auth, do not swap the store, do not platformize. |
| 2026-08-21 | The story as a privacy layer ("they have to predict the data instead of direct access") | **Rejected.** Obscurity-by-narration protects nothing — a synthesized story leaks facts by inclusion. The real mechanism falls out of the architecture free: access control lives at the subgraph (F1 visibility), and per-audience stories are rendered from the FILTERED subgraph. The filter is the security; the story is just honest about what it was allowed to read. |
| 2026-08-26 | **The night compresses and reorganizes but never UPGRADES.** A single mention stays a single mention; commentary an agent generated never becomes something Mehdi said. (Named by the claude.ai side of the 08-25 courier conversation, catching it live: the no-caffeine line was the bot's commentary and reached the note as fact.) | **Accepted → M6, as a measured number first.** _(1)_ I2 exactly — testimony and inference are authored-vs-derived inside one fact. The mechanism already exists: `chain[]`. A fact with a `msg#` (or URL) in its chain is testimony; one without is inference. _(2)_ M6 (bounded, honest memory) and the story tree's rewrite discipline. _(3)_ Deletes nothing yet; it refuses a class of night edits. _(4)_ A blue lint count — facts without a testimony chain, per domain — trended, never charged (the I3xx pattern), and the storyteller told which is which. Support counts ("8 of 9 across 3 nights") remain the only honest upgrade path, per the 08-15 instance-vs-estimate row. |
| 2026-08-26 | **The asker announces its gap.** The best retrieval this system has produced was answering a foreign agent that said what it HAD (the scan read) and what it NEEDED (four numbered items). | **Accepted → round 11 P5 (`orient`'s shape).** `orient(task)` takes "what I already know / what I need", not a bare task string. Manufacture-the-gap from the other side: a day agent cannot feel a gap it does not know it has, but an asking agent can be made to state one. _(4)_ Measured by the episode: orient-with-gap turns vs bare-task turns, by outcome. |
| 2026-08-27 | **Rotate the day's session at idle, not on a counter — and hand off from rows, not from memory.** On 08-25 `CONCIERGE_RESET_AFTER = 30` cleared the concierge between two messages one minute apart, at ~204k of a 1M window (first misread as 612k — the per-run sum); the bot said "Welcome back" to someone mid-sentence; no event, no friction row, the night saw nothing. | **Accepted, built same session.** _(1)_ I12 in a new place: after ~5 min idle the prompt cache is cold, so rotating THERE costs nothing extra, while rotating mid-thread costs the conversation; I4/I9: the handoff is derived from the database (last user messages, recent commitments and notes) — regenerable and inspectable — where the SDK's auto-compaction would be a model-written summary nobody can audit, so it is not enabled. _(2)_ Serves the day's cost guard the counter was meant to be (a turn at 150k costs a third of one at 600k). _(3)_ Deletes the turn counter. _(4)_ Rotations per cycle, mid-thread rotations (must be zero), context at rotation — all in `cycleCli`; a mid-thread rotation is a friction row. |
| 2026-08-27 | **The wake-up is a brief; detail is on demand. The concierge chooses each worker's model and effort; cost is a line the day reads.** Mehdi hit his session limit; the ledger showed $373 in seven days — the concierge $206 at ~292k billed tokens per turn (the prefix, not the model), workers $129 on the 1M window at 1.0–1.6M per turn, the night $39 — and one `CLAUDE_MODEL` for every role, no effort setting anywhere. | **Accepted, built same session.** _(1)_ I12/I7: the concierge's biggest variable injection was a worker's raw last messages; a generated brief (Haiku, marked as a render — I2) replaces the readout, the 200-char recap and the box's cut tail — one artifact, three surfaces — and the thread stays the source. I9: generated by mechanism at run end, never asked of the worker that just truncated itself; on failure the old readout ships (I8). _(2)_ Serves the day's cost bound; per-dispatch `model`/`effort` stored on the thread lets the concierge spend judgment where it is needed. _(3)_ Deletes the 16k readout and the slice-recap. _(4)_ `COST:` by role and model in `cycleCli`, an audit line when yesterday ran 1.5× the week's average — the number the change is judged by. Night untouched. |
| 2026-08-27 | **Nothing is sent every turn. The system prompt is built once at session open and frozen; state arrives as a one-time snapshot in the first turn, and after that the concierge learns by living the turns.** Mehdi's principle, after each message cost 6–7% of a session: everything volatile is either changed by the concierge itself or by a worker that wakes it, so re-injecting it teaches nothing and re-bills the transcript. | **Accepted, built same session.** _(1)_ I12 taken literally — "stable for the life of the session" — where the code rebuilt the prompt every turn: the ledger showed cache read pinned at 13,573 tokens (the tool schemas) and 60k–160k WRITTEN per turn, the prompt plus the whole history. Three isolation experiments proved the SDK caches resumed history across processes when the prefix holds; the bot's prompt interpolated live state (attention set, today's events, commitments, inbox line). _(2)_ The day's cost bound. _(3)_ Deletes per-turn injection as a category, and — by restricting the concierge's built-in tools — the raw-file bypass path the friction ledger has counted for weeks (I9 out of a decayed instruction). _(4)_ Cache-written per turn on the ledger, before and after; a suite test that the prompt is byte-identical across two builds with state changed between them. Workers next, same principle. |
| 2026-08-28 | **Workers, same principle: the preset system prompt moves per process.** Every worker turn is a new CLI process, and the `claude_code` preset it ran on is assembled per process — today's date, the working directory, a git-status snapshot (branch, status, last commits), the model name and cutoff. A worker that commits moves its own prefix; every worker moves it at midnight. | **Accepted, built same session.** _(1)_ I12 for the other half of the fleet: `test/workerContext.test.ts` guarded the appended brief since the $86 session of 08-02, while the preset in front of it was never covered. I9: prompts/system.md is edited by hand with no writer to hook, so the stored prompt is COMPARED to the current build at resolve and refreshed under the live transcript — a mechanism, not a rule to remember. _(2)_ The day's cost bound. _(3)_ Deletes the preset for workers and the `workerContext` append; the brief rides once in the first turn's `[SESSION OPEN]` block with the date, cwd and platform. _(4)_ Worker usage rows: cache_creation per turn falls to a few thousand and cache_read climbs toward context; `cycleCli`'s COST line by role, before and after. The SDK's own `excludeDynamicSections` was the alternative — it strips cwd/memory/git status but not the date, and re-injects them as a user message on the SDK's terms; the frozen custom prompt reuses the concierge's seam instead. **Not closed by this:** the CLI prepends its userContext (loaded CLAUDE.md, email, the current date) as the first message of every call regardless of the system prompt, so the prefix still moves at midnight and on a target-repo CLAUDE.md edit — one full miss per worker per day is the expected floor; only a per-day rotation would remove it, and it is not worth one. **From the review:** the "refreshed, owe nothing" branch keyed on the session id regardless of contract, so at the `worker:2→3` rollover every warm worker would have opened a fresh transcript with no brief — both resolvers now key on the contract; a brief rewritten on a warm slot (dispatchTask, switchThread) is re-owed as `[BRIEF UPDATED]` by `setBrief` itself; the operator agent's brief had been passed as `appendContext` beside a custom prompt and silently dropped since it was written — `askClaude` now refuses that combination and the brief rides in the prompt. |
| 2026-08-28 | **The night reads the day's doors: files the day RE-READ from disk are offered as fold candidates.** On 08-27 a worker ran `cat scripts/fibery \| grep -A 20 "doc-secret"` (and `resolve_uuid`, `sub_show`, `grep … api-reference.md`) — re-learning from the CLI's source the document-secret gotcha that brain-fibery's own `cache/INDEX.md` documents; that index itself was read on 7 of the last 7 days by four different threads. The graph held THAT the CLI exists ([[fibery/cli]]) and nothing of how to operate it. The night could not see any of this: `tool_calls` is written by the day and was read by nobody but auditCli. | **Accepted, built same session.** _(1)_ I5 — the demand is the signal, and a read repeated across threads and days is the clearest demand there is; I7 — retrievable means never re-read; I1 — the fold is a reference entity with the operating facts or a POINTER to the doc's own index, never a copy of it (the block says so, and the two-day evidence bar from habits applies: one day earns a pointer, a fold needs two). _(2)_ Round 11's measurement — the story tree is only as good as what the graph holds, and this is how the graph learns what it is missing. _(3)_ Deletes the day's repeated disk reads — and the human noticing them in the ledger. _(4)_ `src/doors.ts` normalises the ledger (a READ is a door; a RUN of the tool is use; a file the day EDITED is work; a directory search is work, only a listing counts; the companion's own repo, node_modules, the knowledge tree and .claude are never doors), keeps paths read ≥3× in the window with the 7-day day-count, and shows next to each what the story and graph ALREADY say. The operator records one `doorDecision` per door (fold / pointer / ignore, with the entity or the reason) — refused unless the path was offered THIS pass; doors are offered only once the prompt is really sent (the digest is built before the quiet-window skip), idempotently per window; `door_decisions` is stamped with the dream that saved, a cancelled pass deletes its unstamped rows with the tree rollback, and only stamped rows count as folded (a failed pass shows as UNLANDED). Ledger text — paths, grep patterns, session keys — is fenced to one line before it enters the prompt; the night's own reads while folding are never doors and never re-reads. The number that matters is on the DOORS line of `cycleCli` and the audit: reads of a folded/pointed path on the days AFTER the decision — it must fall to 0, and the audit fires when it does not, or when doors were offered and no decision was recorded (the block was skimmed). First render against 08-27: 8 doors, `brain-fibery/cache/INDEX.md` (4 threads, 7 days) and `scripts/fibery` at the top — the finding, found by the machine. |
| 2026-09-05 | **A plan must hang off a goal, or the night backfills one — or hands the question to the day.** Two months of live use: on 07-12 Mehdi asked for a life-director and the concierge recorded a FIXED PLAN — buy walnuts, add salad — as `personal/daily-quest-system`. It was replayed every morning, unanswered every morning, and nothing in the machine could age it, retire it, re-derive it or ask why: the graph held the plan and no node said what the plan was FOR. Telling the bot "re-evaluate periodically" would have landed as one more commitment or behaviour line (I9). Mehdi's diagnosis, and the sequence agreed: the missing thing is a clock and a goal edge, not a question generator — an open-ended "understand my motives and open new paths" engine fails I5. | **Accepted, step one built same session.** _(1)_ I9 — the detector is a graph query, not a rule to remember; I5 — the question is opened by a real plan with no outcome, never invented; I4 — the packet carries the chain and the journal reasons as the evidence to backfill from; I2 — a goal the night mints from the chain is a derived proposal through `record()`, journalled and revertible. _(2)_ M6 — bounded memory begins with the first mechanical reason a plan can be revised or dropped. _(3)_ Deletes the scripted "why are you ignoring my walnut question", which would have been the walnut in a different hat. _(4)_ **W213** (yellow, rot): an open task/project, or a process, that reaches no `goal: true` node along `blocks`/`part-of` — 25 on first run, the quest system and `personal/car-service` among them, and `personal` has no goal at all. A **`goal` write op** (and `goal` on `mint`), because until today no op could set the flag: all six goals were written by the reform. A **gardener packet** with three answers — attach to a goal in reach, mint the outcome the chain and the write reasons name, or decline — and the decline is DURABLE: `packet_decisions` holds `reference` (a runbook, a convention, a pressure-free hobby lane — not a plan) and `unknown` (the evidence does not say), keyed on the chain so a grown chain reopens the question, so 25 findings do not take the same 8 slots every night. **`unknown` is the handoff**: the day's cue to ask, in the flow, when the topic next comes up — step two (a touch-watch on the entity, asked once in context, never by schedule) and step three (silence → `dormant`, quests stop drawing on it) are next; voice input lands beside them because voice is the channel where the answer actually gets given. The number that matters: W213 falling night over night, and how many of the falls are `record()` writes against how many are `unknown` rows. |
| 2026-09-05 | **Voice in: a spoken note is transcribed locally and walks through the same door.** Mehdi: "I don't like to sit and type about my diet or health concerns every day — I did it once because I was testing, the second time I'm not interested." The topics the machine most needs answers on are the ones a keyboard makes too expensive to answer; a voice note is the channel in which "please stop with the walnuts" actually gets said, and that sentence is what lets the day ask "then what about the goal?". Telegram's own transcription is Premium, and a feature bought from the transport is lost with the transport. | **Accepted, built same session.** _(1)_ I5 — the demand is two months of an unanswered plan; I10 — the transcript carries the note tagged as spoken, so the operator and the night see what kind of evidence it is; not I12 — nothing is injected per turn, the note is a message like any other. _(2)_ It is the channel step 2 of the goal work (ask in the flow) depends on; M7's second transport is unaffected — this is a modality, and the transport's whole job is to fetch a file. _(3)_ Deletes the keyboard from the health conversation, and a Premium dependency before it was taken. _(4)_ `src/transcribe.ts`: ffmpeg → 16 kHz wav → `whisper-cli` (whisper.cpp 1.9.1, Metal) with `ggml-large-v3-turbo` under `~/whisper-models`, language `auto` so a note may cross Persian and English; a subprocess with a timeout, like a probe, so a hung model cannot hold the door; the wav is deleted, the original kept under `data/voice/` for a better model later. The Telegram adapter subscribes to voice notes, downloads the file, and emits a message with `voice: {path, durationSec}` and empty text; dispatch reacts ✍, transcribes, and re-enters the text as `🎤 [voice note, m:ss, transcribed locally — names and numbers may be misheard]`. The MLX copy of the same model already in the HF cache was left alone: it needs a Python runtime in the bot for the same words. The number to watch: user messages that are voice notes per day on `cycleCli`, and whether the topics they carry are the ones text never answered. Voice OUT is deliberately later — gated on step 2's selection, because the walnut loop spoken is worse than the walnut loop typed. |
| 2026-09-05 | **The touch-watch: a goal question is asked when the topic is live, never on a clock.** Step two of the goal work. The first sketch had the night script the question and the day recite it; Mehdi, before it shipped: "it will become 'why are you ignoring my questions about walnut' and I will ignore it too." A scheduled question is the walnut in a different hat. | **Accepted, built same session.** _(1)_ I5 — the cue fires only on a real read of the node, so an untouched topic costs nothing and asks nothing; I12 — nothing is injected per turn, the line rides on the tool result of the read that touched it; I4 — refs on reads, which M3/M4 built, are exactly what makes "the topic is live" a mechanical fact rather than a guess; I9 — an ask count on the ledger, not a rule to remember. _(2)_ M6 — the ask count is the silence clock step three (dormancy) reads; M4 — the cue rides on memory use, so a day that never reaches for memory never asks, which is the honest coupling. _(3)_ Deletes the scripted question, and any commitment/wakeup for it. _(4)_ `src/touch.ts`: when the concierge's `callModule`/`evalInModule` result names an entity with a standing `unknown` W213 verdict, and the graph still shows no goal above it, the result carries one ⚑ line — no goal, the night could not find one, ask once in your own words if the topic is live, say nothing if not — at most once a day per plan; `packet_decisions.nudges`/`last_nudged_at` count the asks; a `goal` or edge recorded since closes it without anyone tidying the row. Workers, the night and the debug agent are never cued. `vitalsCli` prints open questions and how many have been asked. Number that matters: asks against answers (a `goal`/edge write after a nudge), and how many plans reach step three's threshold unanswered. |
| 2026-09-05 | **Silence → dormant: a plan asked about three times with no answer stops competing for attention.** Step three of the goal work. The ask count the touch-watch keeps is the silence clock; this is what the clock is for. | **Accepted, built same session.** _(1)_ I9 — "asked three times, no answer" is a measured fact and the park is a mechanical, journalled `dormant` write, not a judgment; I6 — the first age-based review that can actually retire something: a plan that nobody will say the purpose of stops being surfaced, asked about, and charged to W213; I10 — the park posts to the awareness feed, so Mehdi hears that a topic was dropped instead of feeling the bot forgot; I8 — one message revives it (`dormant:false`), and reading a parked plan cues the revival rather than a re-park. _(2)_ M6. _(3)_ Deletes the plan that can only be repeated. _(4)_ `src/silence.ts` runs in the nightly pass before the model reads anything, beside the doors; the `dormant` write op exists now (parking clears the actor the grammar forbids on a parked node, and the journal keeps it); `packet_decisions` gains the `parked` verdict; `touchCli` lists questions, asks and parks, `--park` runs the step by hand. **Said plainly, because it is the gap that matters:** the morning worker composes its quests from the slot-30 BRIEF, prose the concierge wrote on 07-12, not from the graph — workers have no graph access — so a parked plan stops being surfaced by memory and not by that prose until the brief says to check. The park event names this; the fix is the brief (data, the concierge's to rewrite) or the convergence M5 is for. Number that matters: plans parked per week, and how many are revived by Mehdi within a month — a revival is the "bot forgot" feeling caught; a park nobody revives was a plan nobody wanted. |
| 2026-09-05 | **Voice out: the bot speaks, in a voice Mehdi picked by ear.** Mehdi: "I don't need to read endless text messages and choose what to respond to; the system can decide when to send me a voice message after observing things worth communicating about, stack related subjects, and think about how to bring them up." First he wants to calibrate the voice. | **Accepted, built same session.** _(1)_ Same argument as voice in: the transport carries a FILE, so the voice survives a change of transport and nothing spoken leaves this machine; I9 — when to speak is stated once in the concierge prompt as a rule of scarcity and its cost is visible per message on the ledger, so a chatty voice shows as a number. _(2)_ The interface half of M6's loop: the channel in which "is the walnut plan still what you want?" gets an answer. _(3)_ Deletes reading for the few things worth a conversation. _(4)_ `src/speak.ts`: Piper (rhasspy) in an isolated venv under `~/piper` — the prebuilt macOS binary ships without its speech library, so the venv is the honest route and it stays a subprocess like whisper-cli — five voices under `~/piper/voices` (four English, one Persian), text cleaned into speech (no markup, links said as "a link"), wav → opus via ffmpeg; `voice_prefs` holds the pick per chat; `/voice samples · use · rate · say` calibrates by ear; the concierge's `sendVoice` tool speaks and logs the message as `🔊 [voice message …]` so the transcript, the night and `readMessage` all see what was said; the transport gains `sendVoice`. Round-tripped: the sample spoken by Piper and heard back by Whisper word for word, except "Mehdi" → "matey" — the English voices do not know the name, which is a thing to hear in the samples, not to fix in code. Number that matters: voice messages sent per day and how many are answered by voice — a voice that is not answered is a bulletin with a worse interface. |
| 2026-09-17 | **The memory cue: the graph raises its hand when a message names a node.** Twelve days of `cycleCli` printed DAY 0 / NIGHT n: five concierge module calls against the night's 217, the touch-watch fired once, and the concierge answered "tell me about Core-API" from its transcript while the node sat unread. Nothing tells it, at the moment a message arrives, that the thing being discussed IS a node with facts newer than what it remembers. | **Accepted, built same session.** _(1)_ I9 — resolution is mechanical (id, alias, task/PR number, against the graph) and the cue is a fact about the message, not a rule to remember; I7 — pull, not push: the cards are NOT attached, the line points and the read is the concierge's, because an injected copy is exactly what pre-empted the reads on 08-06; I12 — nothing enters the system prompt, the line rides under the human message in the turn only (the logged message stays what Mehdi wrote); I4 — the read is a module call with refs, so the touch-watch rides on it and the story follow counts it. _(2)_ M4 directly — this is the first mechanism that makes the day's reads a function of what is being discussed; unblocks the goal work's step two, which had no reads to ride on. _(3)_ Deletes "the day did not reach for memory once" as a mystery: after this the number says whether it was told and read, or told and ignored. _(4)_ `src/recall.ts`: `namesInText` (whole-word alias match, short all-caps aliases case-sensitive, `#1299`/"task 1299"/"PR 3760" against `#N` aliases and id tails, never `people/mehdi`), `memoryCue` (at most five, open before closed, a `*/system` hub only when nothing more specific was named); `retrieval_episodes.hinted` holds what was cued, `hintTally` counts followed against ignored, `cycleCli` prints MEMORY CUES with a warning when cued and never followed. Dry run on the last 37 human messages: 17 would carry a cue, the paperwork ones naming `paperwork/documents`, `criminal-record`, `people/iris`. The number that matters: followed/cued per cycle. If it stays near zero, the day is told and still does not read, and that is a prompt problem the cue has made measurable. |

---
| 2026-10-05 | **The night writes tomorrow: a plan bound to a date is a third kind of thing, beside facts and open loops.** Mehdi's observation after Lisbon: four days planned with the bot, and on departure morning it offered sightseeing — "it doesn't have any conception of time or day being a new day"; his proposal was that the old session or the night should put what matters into the next day's startup, and the new session should know today is today. | **Accepted, built same session — as a snapshot line and a mandatory night verdict, not a startup document.** _(1)_ I12 as written: a prefix may not carry a clock, a snapshot may — the concierge snapshot now opens with today, the time and yesterday in local words (the off-day and standup rules were keying on a weekday the model guessed). I9: the night is not asked to remember tomorrow; its digest gains a WHAT MEHDI DATED block (his messages naming a day or a time, with what the commitments table already holds for that day) and `datedVerdict` makes a verdict per row mandatory — committed / tracked / declined — offered when the prompt is sent, stamped by the dream that saved, deleted with a cancelled pass, carried marked until judged: the door_decisions shape. I1: no new store of plans — a dated plan IS a commitment due that day, which the snapshot already lists. I11 amended: the fold is also the next day's initialization. _(2)_ No milestone squarely owns time; it is the day/night seam, I11's territory. _(3)_ Deletes nothing yet; what it refuses to add is a "startup document" — root.md prose in a new costume — and a reminder to the day to write things down. _(4)_ `cycleCli` DATED line and an audit input: offered against judged, which must not be N / 0; and assistant messages stating a wrong weekday, two in the Lisbon window, which must read zero. Not built: the night-boundary handoff (yesterday in one paragraph, from the database, the way a mid-day rotation already does it) — the next step if the verdicts alone do not move the morning. |
| 2026-10-05 | **The body: a Swift app as a second transport that knows where Mehdi is.** His framing after Lisbon: Telegram means away from the laptop; a native app means next to it, and the system should know which — binary presence — so it can call out loud when allowed, fall back to Telegram when not, run the morning routine as a conversation at the desk, stop pushing worker state and scheduled triggers to the phone unless asked there, and show everything in one main UI with a canvas. Alternatives weighed: Python/Qt (no on-device speech, more idle cost), a game engine or 3D view (nothing for a 188-node graph's legibility), porting the session UI to Swift (a second brain with its own state — reflex already proved that path and he retired it himself). | **Accepted → M7, as round 12 (`docs/plans/round-12-the-body.md`).** _(1)_ I12 — presence ticks, so it lives at the delivery funnel and never in a prefix or snapshot; I9 — routing is a class-by-presence table at ONE `deliver()` (72 `adapter.send(` sites today), not a channel-picking paragraph; I1/I2 — the canvas is the Atlas in a WKWebView, lenses over the store, holding nothing; I10 — "everything visible in the main UI" is I10 in his words, a deliveries feed makes the router's choices visible; I8 — an unheard call-out falls through to Telegram by mechanism. _(2)_ M7's "second transport", the half that needs no F1 decision — one person, two doors. Telegram STAYS: the phone is why Lisbon worked at all. _(3)_ Deletes reflex's planner, scribe, conductor, pulse and prompts (a second brain), and the notice traffic on Telegram; keeps Ear, Voice, Orb, CommandBar, presence. _(4)_ Turns per day by transport and seconds from his last word to its first (`cycleCli`); Telegram messages per day by class, `notice` falling to the asked-for ones; call-outs answered vs fallen through; idle CPU under 2 % and first paint from a cached layout for the canvas. Steps 1 and 3 touch no Swift and collapse to "send it" with one transport, so they can land first and survive nights alone. |
| 2026-10-30 | Watched-item ledger: give a check memory, split recording from waking (proposal #1) | **Accepted → M3/M4 — attention: what deserves the human, read on the day's own cadence.** The right fix for the 2026-10-20 storm: a check gets accumulating state and the wake becomes a predicate the concierge authors, so recording a change and judging it are two jobs again. Build v1 as the document's last paragraph says — table, head column, JSON head, log mode, one real item — and switch off the morning push in the same step, because a ledger nobody sweeps is a file. _(1) Invariant:_ I3 (a check's three outcomes gain accumulated state), I9 (the wake is a mechanism, not a clock or a hand-set due date), I12 (the head rides in as a tool result, never in the prefix) _(2) Milestone:_ M3/M4 — attention: what deserves the human, read on the day's own cadence _(3) Deletes:_ the hardwired hash-diff wake at focus.ts, the clock-fired pulse for check-less items, the manual re-dating that is holding the storm down today, and the pushed morning-routine / standup-cheatsheet messages _(4) Measured by:_ deferral-only concierge turns per day (49, 16, 16, 34, 8, 53, 19, 5, 0, 1, 2 on 20–30 Oct) under ~3 for seven days with no hand re-dating; verify: grep -l watch_ledger src/db.ts |
| 2026-11-04 | Session-distiller re-emits already-captured open loops every cycle — dedupe against recorded loops/focus items (proposal #2) | **Accepted → M4.** Root cause confirmed on the live rows: forked kube transcripts share anchors, dedupe tie-break (id DESC) deleted the distilled twin and the next harvest re-inserted the loser fresh. Fixed structurally: tie goes to the distilled row, an owned anchor is never inserted, a re-summary hands over only new loops. _(1) Invariant:_ I6 convergence (a pass over unchanged input must change nothing) _(2) Milestone:_ M4 _(3) Deletes:_ the hourly [SESSIONS] re-emit of the same loops (~15 concierge turns/day) and the duplicate focus items it bred _(4) Measured by:_ [SESSIONS] turns per day for the two open kube sessions: ~15 → ≤1 after their next real change |
| 2026-11-04 | Workers cannot be interrupted: guidance waits for the run to end and cancellation depends on the user (proposal #3) | **Accepted → M4.** The abort machinery existed (per-turn AbortController, /cancel, the Stop button) but the concierge had no door to it and reported a queued re-dispatch as done. v1 gives it stopWorker and makes dispatchTask say MID-RUN/QUEUED when the worker is busy. Brief-delivery ack is left open on the proposal. _(1) Invariant:_ I10 the operator sees everything (a queued task must not be reported as delivered) _(2) Milestone:_ M4 _(3) Deletes:_ the ask-Mehdi-to-tap-Stop path and the false 'switched' reply _(4) Measured by:_ minutes between a cancel and the worker's last tool call: 96 on 2026-11-02 → under 1 |
| 2026-11-12 | Life-state domain + 7-day timeline view (tiered personal upkeep) (proposal #7) | **Accepted → M4 — a domain the day itself writes and reads every day.** Accepted narrowed — and narrowed again while building: no `life/` domain and no node per chore (a chore node holds no facts, and a numeric half-life on a node would grow the grammar), so item definitions, params and done-events are TABLES (`life_items`, `life_params`, `life_log`) and the concept is one node, `personal/house-upkeep`; concierge capture (`lifeDone`/`lifeState`/`lifeTune`), house health derived on read, never-logged items excluded from the score rather than counted as zero. Tier-3 sessions and the 7-day timeline deferred until two weeks of real logging; the view, when it comes, is an Atlas lens. Retires personal/daily-quest-system. _(1) Invariant:_ I5 (recorded demand msg#16935/#5486); I2 (health/freshness derived on read, never stored); I1 (events and numbers in tables, the concept in one node) _(2) Milestone:_ M4 — a domain the day itself writes and reads every day _(3) Deletes:_ personal/daily-quest-system (the walnut plan) and the morning quest picks _(4) Measured by:_ life_log done-events per week, by voice vs text; dead if zero by week two |

## Changelog

- **2026-11-13** — **Proposal #7: the timeline is the day session's board.**
  Mehdi's feedback on the first view: today is a line, items sit on it saying
  what is next, and the DAY SESSION decides what goes there — from work and
  conversation (a meeting books an afternoon appointment; it lands on the
  line), carried from earlier days. Chores are allowed item types, not the
  subject. Tier 3 (sessions) shapes the days without sitting on an hour, so it
  is bullets beside the line. And it must not be blank when the agent has done
  nothing: an AUTOMATIC layer is derived every read (I2) — dated commitments
  that could be for him (not `system`, not a watched check, not a `[CHECK-IN]`),
  chores at one half-life with overdue ones carried into today and untimed ones
  given a default slot, the fixed work block — and the concierge's `board`
  table holds only PATCHES over it (add, adjust, hide; each with a reason; a
  later patch on the same key wins; a patch on a vanished item is moot). "Fix
  it, not override it", as mechanism. Hidden items are listed with the reason
  (I10). A dated plan stays a commitment (I1), so `boardAdd` tells the
  concierge to `commit()` first. Tools: `boardRead/Add/Adjust/Hide/Revoke`.
  Never-logged chores are named, not drawn — the day-one wall is gone. What the
  data showed: commitments mix things he attends with the bot's own nudges, and
  a nudge's due time is when the bot speaks, not when the thing happens — the
  automatic layer cannot tell those apart, which is the day session's first job.
  Open: a session marks its days but does not yet change them (a trip still
  draws the work block), and nothing yet PROMPTS the day session to curate —
  today it acts when asked or when it reads the board on its own.

- **2026-11-13** — **Proposal #7, the view first.** Mehdi turned the order
  round — "it's the other end of the whole design" — so the 7-day timeline
  landed before the two weeks of logging that were to gate it: `/life` in the
  Atlas (a page, not a lens: a day is not a row lighting the graph), fed by
  `/api/life`, a render over the same tables and maths as `lifeState`. Today on
  an hour axis with a lane per tier, the fixed work block (Sun–Thu 10–18, a
  constant until he tunes it) and the session; the next six days as reminder
  dots with the house's projected health if nothing is done; last week as a
  done-grid. Look, don't edit. `?demo=1` draws a generated week in memory with
  its clock pinned at 16:30 — nothing reaches `life_log`, so #7's verify still
  counts only him. Building it changed the model once: a chore was "due" when
  its own freshness crossed the 75% HOUSE threshold, which made vacuuming due
  every 2.9 days and nearly everything overdue — now a chore is due at one
  half-life and the threshold judges the house. Lane hues validated as a set on
  the dark panel. The life seed now takes its write lock up front; the schema
  test's six-process race is a pre-existing flake (2 of 5 at 89e19f2), not this.

- **2026-11-13** — **A chain can be corrected, and a broken graph accepts its
  own repair (I8).** The round-trip red on `affiliate-app/stage-email-recipient-rule`
  was a nightly mint whose chain named the node's own old note key; the VIEW
  parser refused that, the DATA loader did not, so the write guard let it in —
  the `dormant`+`actor` split again. `chainEntryProblem` is now one rule at
  every door (grammar, loader, op), and `correct-chain` (drop / add / replace,
  never empties, revertible) exists because provenance had no write op at all.
  Enforcing it at the loader surfaced two more such rows, and the fix for them
  was REFUSED: the pre-write gate turned away every write while any lint error
  stood, including the one repairing it — a check blocking its own repair, there
  since the gate was written and latent only because the tree happened to be
  clean. A single-entity write at an entity carrying an error now passes the
  gate and must leave strictly fewer errors and no new one. Runs #53–54, three
  entries dropped; graph lints clean. `canonicalRef` also folds `msg #N` →
  `msg#N` (four live rows still carry the spaced form; followable, left).

- **2026-11-13** — **Proposal #7, step 1: tiered personal upkeep, and the quest
  system retired.** Mehdi's ask (msg#16935): daily basics, a house-health score,
  sessions, a 7-day view. Built only the part that needs nothing but his one
  sentence: `life_items`/`life_log`/`life_params` (seeded from the 1 Aug list),
  `src/life.ts` deriving tier-1 due/done and tier-2 freshness `0.5^(age/half-life)`
  with health as the weighted mean of LOGGED items, and three concierge tools —
  `lifeDone` (resolves a phrase to exactly one item or refuses with the list;
  voice vs text read from the message it answers), `lifeState`, `lifeTune`. All
  tool results, nothing in the prefix (I12). `personal/house-upkeep` minted as
  the concept (goal, pointer to the tables); `personal/daily-quest-system` made
  dormant with the reason — its delivery had already died with the morning push
  (run #52). `LIFE` lines in `vitalsCli` and `cycleCli`; verify on #7 is ≥5
  done-events in 7 days. Deferred: the morning-triage line, tier-3 sessions, the
  timeline (an Atlas lens when it comes). Suite: 626/628 — the two reds are live
  data from 11-12, not this change: three `self/companion` facts stamped with
  today's date (the I12 render test, clears at midnight UTC but is a real
  prefix-stamping habit) and a nightly mint whose chain names an entity file
  (`affiliate-app/stage-email-recipient-rule`), which the write guard let through
  and the round-trip catches.

- **2026-11-08** — **The Telegram retry that never ended, again.** The
  concierge answered nothing from 08:45 to the evening; a message sat under
  👀 while the turn lock was free and the queue empty. Inside the live
  process (Node inspector, read-only) six Telegram API calls were asleep in
  hour-long retry waits: grammy's `autoRetry` bounds only its rate-limit
  loop, and a NETWORK failure (fetch threw, or the 500 s default timeout)
  is retried in a second loop, 3 s doubling to an hour, forever — the loop
  the 2026-08-27 fix thought it had bounded. `rethrowHttpErrors: true`
  closes it, the client timeout drops to 60 s, and `send` retries a bounded
  three times before the turn fails and frees its lock (I8). Open: WHY the
  requests failed while polling worked — the terminal has the lines.
- **2026-11-08** — **One bot per machine.** A detached `npm run start` from a
  dev session was still alive when Mehdi ran `npm run start`; the second
  instance polled Telegram for a few seconds, then died on the Atlas port
  (EADDRINUSE as an unhandled `'error'` event) and took its Companion.app with
  it. `claimInstance()` (`src/instance.ts`) now takes a pid-file lock before
  anything with a side effect and refuses a second instance by name — pid,
  start time, the `kill` that frees it (I8: the refusal explains itself; I9:
  a mechanism, not a README rule). A stale file from a crash is reclaimed by
  `kill -0`. The Atlas bind error is caught and reported; the bot runs on
  without the page. Suite 616 → 619.
- **2026-11-04** — **Proposals #2 and #3 land: the fork that would not stay folded, and a door to the abort.**
  #2: two forked kube transcripts share episode anchors; `dedupeEpisodes`
  broke the tie by newest id, so each harvest re-inserted the loser with an
  empty `distilled_at`, summarised it again, re-emitted its loops as a
  `[SESSIONS]` batch (~15 concierge turns a day, two duplicate focus items)
  and deleted the distilled twin. Now the tie goes to the distilled row, an
  anchor owned by another transcript is never inserted
  (`anchorOwnedElsewhere`, decided before the write — I6), and a re-summary
  of a grown burst hands over only the loops its previous recap did not
  (`newLoops`). #3: the per-turn AbortController, `/cancel` and the Stop
  button all existed; the concierge had no door to them and answered a
  queued re-dispatch with "dispatched". It now has `stopWorker(slot, why)`,
  and `dispatchTask` says MID-RUN / QUEUED when the worker is busy (I10). A
  delivered-brief ack stays open on the proposal. Suite 612 → 616.

- **2026-11-02** — **The day moves to Opus 5.5.** `@anthropic-ai/claude-agent-sdk`
  0.3.168 → 0.3.316: the bundled Claude Code 2.1.168 refused `claude-opus-5-5`
  ("version 2.1.280 or newer is required"), so the concierge had been on Opus
  4.8 and the workers on Haiku 4.5 by default, not by choice. `CLAUDE_MODEL`
  stays empty: the SDK default now resolves to Opus 5.5 / Haiku 5.5 (probed
  with a one-turn query, both by id and by default). A dependency bump, not
  a shape change; serves M4 (the day that reaches for memory should be the
  strongest day we can run) and is measured the way every turn is: the usage
  ledger's `model` column from the next boot on. One known non-issue: the
  behaviour-render test "carries no today-stamp" reads live data, and a fact
  the bot recorded today quotes Mehdi with today's date in it, so 611/612
  until midnight — a test that reads the live tree is a test with a clock in
  it (I12), to be fixed on its own.

- **2026-10-30** — **The ledger, v1 (design proposal #1).** A watched item
  gets accumulating state: a `watch_head` the check overwrites and a
  `watch_ledger` log it appends to, written only from a parsed value (I3). A
  check that prints `{"head": …, "detail": …}` owns its own stability instead
  of `scrub()` guessing. The wake is no longer the hash-diff: `watch_mode` is
  `log` (never wake), a predicate over the head (`src/ledger.ts` — a total,
  parenthesis-free grammar that cannot throw or reach anything but the head,
  per I8), or absent (wake on change, as before). A log-mode item is excluded
  from the pulse's due set by the query, not by a prompt line (I9). The
  concierge reads heads through `ledgerHeads`/`ledgerLog`/`ledgerAck` — a
  moving value that rides in as a tool result, never in the prefix (I12) — on
  three seeded sweeps a day (`ensureLedgerSweeps`: a morning triage and two
  light passes) and when asked "what needs me?". The pushed `morning-routine`
  and `standup-cheatsheet` rows are dropped: nothing is sent on a clock; what
  crosses the wake list goes as one short voice note. Lands dark: zero items
  use it until the concierge sets a mode, and the triage prompt tells it to
  move every check-less "his ball" item to `log`. The number: deferral-only
  concierge turns per day, under ~3 for a week with no hand re-dating.
- **2026-10-30** — **The proposal channel.** A design-level proposal — how the
  SYSTEM should work, as opposed to the night's one-file `findings` — now has a
  home: `design_proposals` + append-only `proposal_evidence` (I1, I4). The day
  opens one from a conversation (`proposeDesign`), the night from friction;
  both attach evidence, amend with a trail, and merge duplicates. **Only a
  developer session moves a row past `open`** (`proposalCli accept|reject|
  land`), enforced by which actors hold which tools (I9); accept/reject takes
  the four idea-test answers and APPENDS the *Ideas measured* row, so the table
  is a render of the rows. A landed row is verified by its own command in the
  nightly audit (I3), and every decision reaches the concierge as an event, so
  the next conversation adds evidence instead of re-proposing. Demand: the
  2026-10-20 ledger proposal, which the concierge could only produce as an
  untracked file through a worker — it is now proposal #1, with the four
  decisions that conversation reached and the document omitted. 598 → 604
  tests.
- **2026-10-30** — **Harvest draws its boundary by who drove the session, not
  by project.** Every transcript line names its `entrypoint` (`cli`,
  `claude-desktop`, `sdk-ts`, `sdk-py`, `sdk-cli`); an SDK-driven session is a
  program's work — the bot's fleet, montaj's pipeline, storysim's simulator —
  and `harvestable()` now refuses it (`NO_HARVEST_ENTRYPOINTS`, default
  `sdk-*`) before the project list is consulted. Demand (I5): storysim runs a
  simulator through the Agent SDK from the same directory Mehdi develops it in,
  so a per-project exclusion would have hidden his own work with the
  simulation's. Same invariant as excluding bot sessions by id: the system may
  not read a program's output back as evidence of his activity. A transcript
  with no entrypoint is treated as typed — dropping HIS work is the failure to
  avoid. `test/harvest.test.ts` is the first test the harvester has had.
- **2026-10-05** — **The body, part 1: Companion.app's shell.** `body/`, a Swift package beside the bot: the stage in the middle, widgets snapped around it (move, resize, collapse, anchored re-layout), each a live render of an Atlas endpoint, and a "This app" widget that is the app's own observability — stream state, pulses per minute, presence from HID idle, the layout file, a log of what the hand did. Reads the Atlas exactly as the web does (byte-level SSE; `.lines` silently buffered). Gate: `./companion test`, 53 checks. See the round-12 plan's *Landed*.
- **2026-10-05** — **The night writes tomorrow.** The concierge's session-open snapshot opens with today's date, weekday, local time and yesterday (`todayLine`); the nightly digest gains WHAT MEHDI DATED (`src/dated.ts`): his messages naming a day or a time, each with the commitments already due on the named day, and a mandatory `datedVerdict` (committed / tracked / declined) with offer, stamp, cancel and carry semantics copied from doors. `cycleCli` prints a DATED line and the audit fires when a block was offered and nothing judged. Dry-run against the Lisbon window: 5 rows, three naming 2026-10-04 with nothing but two silent check-ins due that day — the finding, found by the machine. Suite green.
- **2026-09-17** — **The memory cue.** Twelve days of DAY 0 in `cycleCli`. A human message to the concierge that names a node (id, alias, task or PR number) now carries one `[MEMORY — …]` line under it in the turn, listing the nodes and asking for `find(id)`; hubs only when nothing more specific is named, never `people/mehdi`. The cued ids land on the retrieval episode as `hinted`; `cycleCli` prints followed against ignored. Pull, not push: nothing is attached, nothing enters the system prompt. Also the twelve-day read: the night declined 15 of 22 W213 packets as `reference`, the quest system and the car service among them (the escape hatch to close next); voice was used in the first week and not since the 13th; a worker wrote a script into the repo root on 09-07 and ran it against the live database to add commitments; the concierge ran a shell command through `evalInModule`. Suite 586 green.
- **2026-09-05** — **Voice out.** Piper in its own venv under `~/piper`, five voices; `/voice samples` sends the same paragraph in each, `/voice use NAME` and `/voice rate N` store the pick, `/voice say` tries a sentence; the concierge gains `sendVoice` and a VOICE paragraph in its prompt gating it to the few things worth a conversation. Spoken messages are logged as `🔊 [voice message …]`. The transport contract gains `sendVoice`. Suite 582 green.
- **2026-09-05** — **Silence → dormant.** The night parks a plan the touch-watch has asked about three times with no answer: a `dormant` write (new op; parking clears the actor), a `parked` verdict on the ledger, and an event on the awareness feed so the concierge knows the topic was dropped. Reading a parked plan cues a revival in the same breath as the question. `src/silence.ts`, `src/touchCli.ts`. The morning worker's quests come from its brief, not the graph — parking does not reach that prose; the event says so. Suite 579 green.
- **2026-09-05** — **The touch-watch.** An `unknown` W213 verdict becomes a cue on the next READ: when the concierge's module call names the plan, the result carries one ⚑ line asking it to find out what the plan is for, once, in the flow, and to record the answer; at most once a day, never to a worker, the night or the debug agent, and never once a goal is reachable. `packet_decisions` counts the asks. `src/touch.ts`; call results now carry their refs. Suite 576 green.
- **2026-09-05** — **Voice in.** A Telegram voice note is fetched by the transport as a file, transcribed on this machine by whisper.cpp (`ggml-large-v3-turbo`, `~/whisper-models`), and re-enters dispatch as text tagged `🎤 [voice note …]` — same door, same buffer, same log. Transcription is its own module (`src/transcribe.ts`) so it survives a change of transport and never uses Telegram's Premium feature; a failure is a plain reply, never a throw. Config: `WHISPER_BIN`, `WHISPER_MODEL`, `WHISPER_LANGUAGE` (auto), `VOICE_DIR`. Suite 574 green.
- **2026-09-05** — **A plan reaches a goal, or the night is asked to find one.** `W213` (yellow, rot) finds an open task/project or a process with no path along `blocks`/`part-of` to a `goal: true` node — 25 on the live graph, `personal/daily-quest-system` (the walnut plan replayed daily for two months) among them, and no goal at all in `personal`. The `goal` write op exists now (and `goal` on `mint`): every goal in the graph had been written by the reform and no op could set one since. The gardener's W213 packet carries facts, chain, the journal's write reasons, what the node points at and the domain's goals, and offers attach / mint-the-outcome / decline; a decline is recorded in `packet_decisions` as `reference` or `unknown` (night tool `gardenSkip`, `gardenCli skip` by hand), holds while the chain is unchanged, and `unknown` is the day's cue for the next step. Suite 571 green; the audit's rot series restarts on the new ruleset id, as designed.
- **2026-09-03** — **Doors, week one: the fold took; four leaks fixed.** Six days of live decisions: night 84 folded `api-reference.md` + `scripts/fibery` into [[fibery/cli]] and the day's re-learning reads of those exact sources fell 4 → 1 → 1 → 0 → 0 — the metric the block exists to move, moving. Same ledger showed the leaks: a multi-line command glued the next line into a path (`head -8\necho` minted `…/echo` — newline is now a separator), an unexpanded `$f` became a door (a path still carrying `$` is rejected), a mid-chain `cd` never moved the base (`date && echo && cd X && cat f` lost its door — cd is now honoured per segment), a reconsidered verdict doubled its rows (a pass's later verdict now replaces its earlier one), and — the real miss — night 84 was offered 8 doors and decided 3, with nobody bringing the skimmed five back: `cache/INDEX.md`, read on 7 of 7 days, stayed undecided and daily for another week. An undecided door is now CARRIED into every following pass, marked, until someone folds, points or ignores it (mechanism, not a prompt plea — I9).
- **2026-08-28** — **Bug fix: restart recovery was recovering the living.** The 08-27 landing ('What a restart must not lose') had the minute tick call `recoverAfterRestart` so a recovery refused at boot (night owed, debug) drains when the gate opens — but the take swept EVERY `turns_running`/`turn_queue` row, this process's live ones included. Any turn longer than a minute was marked "killed by restart" and replayed: this morning one message was answered twice (05:28:12 and 05:28:24 UTC, twelve seconds apart) and the running morning-routine worker was declared cut off and re-dispatched under itself (six `turn replayed by restart` events at :10 past each minute, no process restart). A row is stranded only when nobody alive owns it: both tables now carry a `boot_id`, written by the process that owns the turn, and recovery takes only rows from another boot (the pre-fix empty default counts as dead, so nothing already stranded is lost). `test/replay.test.ts` asserts a live turn is never stranded next to a dead one that is. The number to watch: `restart` events on `cycleCli` while the process uptime is unbroken must be zero.
- **2026-08-28** — **The night reads the doors.** The Fibery finding from the
  ledger — a worker re-reading the CLI's source for a gotcha the toolkit's own
  index documents, and that index read every day of the week by four threads —
  was invisible to the night because nothing fed it `tool_calls`. `src/doors.ts`
  now normalises the day's reads (a read is a door, a run is use, an edited file
  is work) and the nightly digest carries a "Doors the day kept opening" block:
  path, count, threads, what was grepped for, and what the graph already says.
  The operator answers each with `doorDecision` (fold / pointer / ignore; the
  habits evidence bar — one day earns a pointer, a fold needs two), rows are
  stamped with the dream, and `cycleCli`/the audit print a DOORS line whose
  number is re-reads of a folded path afterwards, which must be zero.
- **2026-08-28** — **Workers stop moving too.** The concierge's frozen prompt
  landed a day earlier with a note that workers showed the same pattern through
  the preset system prompt. Read out of the CLI binary, the preset's moving
  parts are the model line, the knowledge cutoff, today's date, the environment
  block (cwd, "is a git repository", platform, OS) and a git-status snapshot
  taken at process start — and each worker turn is a new process. So the worker
  now runs on a static custom prompt (`src/workerPrompt.ts`: the role, the
  durable working norms the preset used to supply, and `prompts/system.md`
  verbatim), frozen per session in the same `session_prompts` table by
  `resolveWorkerPrompt`; the date, working directory, platform and the BRIEF
  ride once in the first turn as a `[SESSION OPEN]` block, owed until the turn
  that carries it ends well, rebuilt from the current brief while owed so a
  steer before the first turn settles is the one that lands. The contract is
  `worker:3`: no transcript built on the preset is resumed. `prompts/system.md`
  changes semantics — next session, or a live worker's next turn at one cache
  miss, by byte comparison at resolve rather than a hook. Settings sources are
  left at the SDK default, as they were under the preset, so the project's
  CLAUDE.md still loads for workers. The number to read: worker rows' cache
  written per turn, which should fall from the full history to a few thousand
  — with one full miss per worker per day as the floor, because the CLI
  prepends CLAUDE.md, email and the current date as the first message of
  every call whatever the system prompt says. The review then caught the
  contract-rollover blocker (a warm session's id satisfied "refreshed, owe
  nothing" under a contract the resume would refuse — fixed in both
  resolvers), the brief that a warm-slot rewrite would have left stale (now
  `[BRIEF UPDATED]`, owed by `setBrief`), the UTC date on a +0330 machine, and
  the operator agent's brief silently dropped as `appendContext` beside a
  custom prompt since the day it was written.
- **2026-08-27** — **Measured: what moves per message.** Asked why every
  message burned 6–7% of a session, the ledger answered in three columns.
  Cache read: 13,573 tokens on every concierge turn — the tool schemas.
  Cache written: 60k–160k per turn, nine seconds apart or ninety minutes —
  the system prompt (12.2k) and the entire history, re-uploaded on the
  first call of every turn. Three controlled runs (plain; with an MCP
  server and permissions bypassed; with forty tools) all cached resumed
  history fully, so the SDK was innocent; `conciergeSystemPrompt` rebuilt
  per turn and interpolated the attention set, today's events, commitments
  and the inbox line, and any changed byte there invalidated everything
  after it. The prompt was byte-stable across two builds four seconds apart
  and moved with state — the test that should have existed did not.
  Mehdi's reframing became the design: the prompt is built once at session
  open and frozen in `session_prompts`, the volatile blocks appear once as a
  `[SESSION OPEN]` snapshot in the first turn, and the concierge's built-in
  tools are restricted so the schema block shrinks and the raw-file bypass
  closes by mechanism. The number to read tomorrow: cache-written per turn
  on the COST/usage rows, which should be a few thousand, not a hundred
  thousand. Workers show the same pattern through the preset system prompt
  (date, environment) — the next step.
  **From the review and the ledger, before landing:** the snapshot is a
  DEBT settled only when the turn that carried it ends well — as first
  written it was marked paid before the turn ran, so a first turn lost to an
  overload would have left the session blind all day with nothing saying so
  (the handoff had already solved this shape; the snapshot now copies its
  durability). Two writers move root behind the concierge's back — the
  Atlas's revert and `gardenCli` — so a root re-render drops the frozen
  prompt and the next turn rebuilds it without a snapshot; the concierge's
  own writes, the prober (state only), workers (cannot write root) and the
  night (clears the session) are covered by "it knows". The built-in
  default is `Bash,WebFetch`, not nothing: the ledger shows Bash 60× in
  seven days — `gh pr view`, `gh run view`, `fibery show … --json` — the
  "ground before asserting" habit, while `Read`, the bypass path, ran 0×.
  And 104 `ToolSearch` calls in the same week were the concierge loading its
  OWN core tools (`send`, `updateCommitment`, `observe`, `commit`), deferred
  by the CLI past ~30 schemas; the bot and telegram servers are now
  `alwaysLoad` — a stable, cached ~10k-token read in place of a model call.
  Noted for the record: restricting built-ins removes the involuntary half
  of the day's `bypass` signal by construction — a zero there now means the
  tool is gone, not that the API is complete; `reportFriction` remains the
  voluntary half.

- **2026-08-27** — **Cost, read off the ledger before touching a model.**
  Seven days: $373 — concierge $206 over 278 turns, workers $129 over 96,
  night $39 over 12; everything on Opus 4.8 through one env var, workers on
  the 1M window, no thinking-effort setting anywhere. The concierge's cost
  is its prefix (~292k billed per turn against ~2.8k output), so the levers
  are what it re-reads, not what it is. Built: a Haiku-generated handoff
  BRIEF at the once-per-run point — DID / CONCLUDED / OPEN / WHERE — as the
  wake-up, the recap and the box's final render, marked as a render with
  the thread as the source; `dispatchTask(model, effort)` stored on the
  thread with a default of sonnet/medium for workers and medium effort for
  the concierge; and a `COST:` line by role and model beside the day's other
  numbers, with an audit line for a day 1.5× over the week. The night keeps
  Opus by Mehdi's own framing: the smartest, most-access role is the right
  place to spend.
  **The review's security catch, recorded so it is never re-learned:** in
  this SDK `allowedTools` pre-approves tools, it does not restrict which
  exist — `tools` does. As first written the brief call ran a cheap model
  with the full built-in toolset and permissions bypassed, in the repo's
  working directory, fed verbatim worker text (PR bodies, tickets, web
  pages): prompt injection to shell. It ships with `tools: []`, a deny-all
  gate, a budget cap and the transcript fenced as data. Also from the
  review: one role classifier for the ledger (`distill`/`digest` are night
  spend, `brief` is never a worker); existing warm threads are backfilled to
  the model that built their transcripts rather than silently continuing
  on Sonnet; `usage.effort_asked` is named for what it is — the SDK may
  downgrade silently and the resolved value is not on the result; and the
  concierge's default effort is now `medium` (the SDK default was `high`),
  a live change to the judgment seat that `CONCIERGE_EFFORT=high` reverts.
  Follow-up, not built: the debug/operator agent never writes a usage row,
  so its spend is off the ledger the COST line claims to summarise.

- **2026-08-27** — **A preview is not evidence, and a run reports once.** Mehdi
  asked what "the output is truncated" means when a worker wakes the
  concierge. It is not Telegram: `notifyCompletion` hands the concierge a
  render of the worker thread's last eight messages, 500 chars each and
  4,000 for the last — and a worker's closing report is routinely longer, so
  the concierge reasoned from the cut before reading the thread. That is the
  whole "Roadmap Description isn't a field" episode: nobody lied, the preview
  was the wrong size, and nothing said a truncated readout is not evidence of
  absence. The final message now arrives whole up to 16k chars, a cut names
  its lengths and the `readThread` door, and the prompt says the rule. The
  second half was the steer: `updateBrief` queues a `[GUIDANCE]` turn behind
  the running one, and until this morning a queued turn lost its
  `background` flag on the way through the queue — the guidance turn finished
  and reported to nobody (fixed in the durability pass, finding #5). What was
  left was its mirror: the original turn woke the concierge "finished" while
  the guidance was still queued, then the guidance woke it again. A worker's
  drain is now one unit — a background turn that finishes with turns still
  queued owes a report instead of sending one, paid once when the queue is
  empty. Serves I8's cousin: a report that arrives early is a report that is
  wrong.

- **2026-08-27** — **What a restart must not lose.** The outage's two
  leftovers, built the same day: the turn queue and the in-flight turn become
  rows (`turn_queue`; `turns_running` gains the text and whether a person
  asked), and on boot a killed HUMAN turn is replayed once with a framing
  that says so, a killed machine turn is logged and dropped (a re-run
  commitment could act twice), and queued messages run oldest-first. A
  rotation's handoff is persisted (`pending_handoff`) and consumed only when
  the new session acknowledges it, expiring after six hours — so a restart
  between the nap and the reply no longer re-onboards, which was the failure
  the nap exists to prevent. Turns killed by restart are counted in
  `cycleCli`, zero as zero.
  **Landed** (`main`, fresh-eyes reviewed, ten findings applied; suite
  479/479). Two of them were the kind a feature has to be told about itself:
  as first written, a turn that THREW — now a likely event, since the
  Telegram retry bound makes a bad send fail the turn — reached `release()`,
  which deleted every message still queued: the 08-27 scenario re-run with
  messages 2–4 lost, 👀 still on them. The holder now drains with a per-turn
  catch and `release()` leaves rows alone; dropping them is what `cancel`
  means. And recovery bypassed the mode gate — a source edit during a debug
  session would have replayed a person's turn into the sedated concierge, so
  it is refused (rows kept) until `allowed('day-turn')`, and retried from
  every tick. Also landed: the exact context now comes from the last
  assistant message's own usage (input + cache read + cache written of the
  final API call) — the SDK control request turned out to be closed by the
  time the result arrives in single-shot mode, so the first live rows read
  `context_tokens = 0` and the policy silently ran on the estimate.

- **2026-08-27** — **A retry that never gives up is a lock that never opens.**
  Mehdi reported the bot "typing" every few seconds and reacting 👀 to a
  message it never answered. Read off the machine, not the terminal: no
  usage row after 08:18, no stored session, no SDK subprocess, no socket, the
  process idle — and the 👀 is sent only when the turn lock is already HELD.
  The holder was the 09:15 commitment turn: it rotated the session
  (correctly — 213k, 58 min idle), constructed its view, and awaited the
  status message's send through grammy's `autoRetry`, whose installed
  defaults are `maxDelaySeconds = Infinity`, `maxRetryAttempts = Infinity`,
  errors swallowed. The typing keepalive beside it kept ticking, so the chat
  looked alive while nothing could move; the watchdog's abort does not reach
  a Telegram round-trip. Restarted via the runner, then bounded: three
  attempts, thirty seconds each — a send fails within two minutes, the turn
  fails with it, and the lock's `finally` releases (I8). Two things it leaves
  behind: the in-memory turn queue dies with the process (the 10:47 message
  has to be resent), and a rotation's handoff is not persisted, so a restart
  between rotation and reply re-onboards after all — both small, both next.

- **2026-08-27** — **Amnesia was scheduled.** Mehdi caught the concierge
  re-onboarding mid-conversation on 08-25 ("After daily" → "Welcome back").
  The usage ledger answered both of his questions: it was the 30-turn counter
  at `dispatch.ts:139`, blind to context and to the thread. The context was
  first read as "612k of 1M" and that number was WRONG — the usage row is per
  run, summing cache tokens across the turn's internal calls (`num_turns` was
  3); the real per-call context was ~204k, a fifth of the window. The
  fresh-eyes review caught it with a row whose "context" exceeded the window
  itself, and the fix measures instead of estimating: the SDK's
  `getContextUsage()` at the end of every turn. `clearSession` is silent, so
  nothing could have noticed the reset. Replaced by a policy (`src/rotation.ts`): rotate when the
  context is above a threshold AND the user has been idle — where the cache
  has expired anyway — or at a hard ceiling regardless; the new session's
  first turn carries a handoff rendered from the database, framed so the bot
  knows its predecessor is gone; every rotation is an event, a mid-thread one
  is a friction row, and `cycleCli` counts them. Also read off the same
  ledger and NOT chased here: the concierge's cache-creation column reads
  120–200k per run, growing through the day — inflated by the same per-run
  summing, so the true per-call figure is smaller, but the day still costs
  $22–45 at ~$0.9/turn. Whether a prefix moves is its own session, and the
  exact context column lands with this change makes it answerable.
  **Landed** (`main`, fresh-eyes reviewed; suite 455/455). The review's live
  numbers: as first written the policy would have fired on 22% of turns and
  forced ~8 mid-thread resets a week — the regression it targets — and would
  have "rotated" the empty session every morning after the nightly clear.
  Both fixed; thresholds re-derived from 235 concierge turns (per-call
  context p50 92k · p90 150k · p99 209k · max 237k): rotate above 200k at
  idle, force at 600k. Messages now carry `source` (human/machine) instead
  of being sniffed for a leading bracket. To confirm on the first live turns:
  `usage.context_tokens` fills (the event body says `src=exact`), and
  `cycleCli`'s ROTATIONS line stays at zero mid-thread.

- **2026-08-26** — **The pyramid narrates the graph, and a prose write is a
  bypass.** The 08-25 three-way conversation (claude.ai ↔ Mehdi-as-courier ↔
  the bot) read as data: episode #454 ran five `searchMessages` before
  anything else — the concierge's retrieval ladder never mentioned the story
  or the graph — found the repair in the MESSAGE LOG, called `readStory`
  once with a scope that resolved to nothing (target unlogged), and then
  saved what it learned with `writeNote` into `personal/`: prose. Two nights
  later the graph holds no dental entity and the personal story is clean and
  unchanged since 08-22, because prose writes do not dirty stories. "My bot
  already knows it" was true of the transcript and false of the memory. What
  the bot did best — listing the surfaces it searched so the gaps were real
  gaps — it did by hand; that belongs to the episode row, derived (I9). Two
  idea-test rows above (never upgrade; the asker announces its gap). Same
  session: prose writes dirty their domain's story and reach the worklist,
  the ladder goes story-first with `searchMessages` demoted to verification
  (I7), and `readStory` logs its scope.
  **Landed** (`106765f`, fresh-eyes reviewed, seven findings applied). The
  review's design catch: a note in a folder the graph does not know was going
  to produce NO signal — the M1 discovery signal made silent — so it now
  dirties the root, reaches the root's material, and is counted in the lint;
  the first run of that count named `testing/ba-flow-e2e`, a whole project
  folder the graph has no domain for. Also caught: a domain with notes but no
  entities was mechanically cleared instead of offered, and the ladder's rung
  1 pointed at a `## The story` heading the prompt no longer rendered. The
  boiler note predates the hook, so `personal` was dirtied once by hand
  — tonight's worklist offers it with the note as material. Suite 428/428.

- **2026-08-24** — **The bet was never run.** Three days of real use over the
  story tree, read off the instruments: the NIGHT half works — all 13 nodes
  written by 08-22/24, dirt drains after every day's writes, the domain
  stories are dense ~2k-char narratives with every claim ref'd. The DAY half:
  user-initiated questions since 08-22 ran **77 no-reach, 10 tree-only, 0 graph
  reads**. And the drill-through metric was TAUTOLOGICAL — 113 of 169 entities
  "on offer" across all stories, so any graph read counted as following. What
  the day could actually see explains the zero: a 285-char root story with
  THREE refs, starved by root.md's 10k cap (which the behaviour render already
  saturates — the file is over cap again at 10,096 despite the night's trims),
  and a drill-down line pointing at story.md, which our own review fix fenced
  out of the note API and no tool can open. The 23k chars of narrative were
  dark to the concierge. Questions whose context sat verbatim in the
  unreachable affiliate-app story ("are we sure migration 44 will succeed?",
  "if we deploy stagebox, Northwind + Fabrikam fail") ended no-reach. Round 8's lesson
  in a new place: delivery was judged by what the night WROTE, not by what the
  day could SEE. Next step, same session: the level-0 story gets its own
  injected budget outside root.md (root text + one pointer line per domain),
  a `readStory(scope)` door to level-1 named in each pointer, the metric
  narrowed to refs actually injected, and the root.md splice deleted.
  **Landed the same session** (`f80a741`, reviewed fresh-eyes, ten findings
  applied): the injected block is ~600 tokens with twelve `readStory` doors;
  the strip of root.md's old section fires only under its GENERATED marker (an
  authored section is left byte-for-byte — the review caught a heading-only
  match that would have deleted one); the metric can lose again — entity
  follows and story reads are two numbers, an unknown scope is no step, and
  the prompt describes the pointer rather than ordering it followed; and an
  "unnarrated domains" line was dropped from the block because a mid-day mint
  would have moved the cache prefix (I12). Suite 418/418. The pointer lines
  are still "what X is" definitions — the night's new guidance (lead with the
  gap, no navigation in the text) sharpens them as nodes go dirty. Read
  `cycleCli` after 2–3 nights: the first honest drill-through number.

- **2026-08-21** — **P2 and the shell's own /dream, same day.** Following a
  pointer is now a number: the story's refs are the OFFERED set (resolved
  against the derived entities table — the review caught `storyRefs()` calling
  `loadGraph()`, whose parse WRITES, inside a cycleCli that promises it writes
  nothing), day episodes score `story_followed` deduped so the ratio cannot
  exceed 1, and cycleCli reports drill-through + downstream honesty beside the
  M4 number. The audit's story line also fires on a tree offering zero
  pointers, because a story with nothing to follow is not health. And
  `dreamCli` induces the fold from a shell — same `runRewrite`, gates consulted
  never forced, legal as a second process because the phase lock lives in the
  database. Suite 408/408; the launchpad state drift healed itself when the
  prober re-ran. Next: the first induced dream over the story tree.

- **2026-08-21** — **Round 11 opened: the story tree** (`docs/plans/
  round-11-story-tree.md`). A design session read the machine's own numbers —
  246 episodes, 228 `no-reach`, 6 answered; the injected behavior render the
  only memory surface that demonstrably steers — and drew the conclusion the
  data had been holding since M4's zero: the day cannot know that it doesn't
  know, so the system must manufacture the gap. The plan: a budgeted strict-tree
  narrative render over the graph (depth earned by splits, dirtiness up,
  rewrites bottom-up along dirty paths, structural lint deterministic, semantic
  fidelity verifier-sampled, forgetting heat-driven with obligations pinned),
  push-delivered per-task and — in later phases — into other projects'
  AGENTS.md, with MCP demoted to write path + drill-down and an
  `orient`/`debrief` protocol as the harness-agnostic capture seam. Three
  idea-test verdicts logged above, one a rejection (story-as-privacy). This is
  the mechanism for M5's "root becomes a render" and an amendment to M4's
  success mechanism: the day reads by following, not by choosing. P1 landed the
  same session, built by an agent in an isolated worktree and reviewed by a
  second with no shared context (verdict fix-then-merge; all ten findings
  applied): `story_nodes` + dirty propagation from both write paths (applyWrite
  AND the prober, whose bypass of applyWrite was finding #2), the worklist +
  mechanism-validated `storyRewrite` operator tools, the `## The story` splice
  into root.md costed against `rootBudget()` before saving, story.md fenced out
  of the note tree (RESERVED_KEYS + noteFiles + linkHealth — a live I2 break
  caught in review), the structural lint in the audit, and 22 tests. The first
  root story cannot land until the night trims root.md under its cap — the
  worklist line says so with the char count. What the first nights must prove:
  the night reaches for the worklist, the dirt drains, and the lint line stays
  quiet. The worker
  fix worked on its first live test — the concierge checked the durable store,
  found it clean, concluded the record was not what was wrong, and reached for
  `resetThread`; the dispatch branch fired 21 seconds later
  (`worker slot 30 starts fresh`) and the standup re-derived with the closed
  #2613 line gone. The one piece no unit test could reach is confirmed.
  But its *durable* fix was a hope. `fresh` could only be set by DISPATCHING,
  and the concierge was deciding the policy at 16:32 without dispatching — so
  it wrote "dispatch this with fresh:true" into two commitment bodies instead.
  That is a reminder addressed to a context that gets cleared every night. It
  held only because the flag had been set by hand the evening before.
  So the switch now lives where the decision is: `resetThread(slot, why,
  fresh)`. And the tool's reply states the DURABLE state in both directions, so
  a caller cannot believe it made a permanent fix it did not make.
  *Also corrected:* the concierge diagnosed the cause as "the graph had no
  #2613 entity, that's why nothing corrected the worker". Workers cannot read
  the graph at all — 17 of 17 episodes `no-reach`, and no tools to reach it. A
  perfect entity would have corrected nothing. It did file an observation whose
  refs resolved to nothing, which is the discovery signal working exactly as
  M1 intends.

- **2026-08-19** — **A worker's memory of itself is now a choice.** The Morning
  Routine emitted a standup line about stagebox PROD and Fabrikam #2613 that Mehdi
  had explicitly closed the day before. Every durable store was correct —
  commitment #108 closed on 08-16, the tree note fixed by the concierge, both
  observations folded into the graph that night. The worker read none of them:
  it resumes the same session every morning and rebuilt the sheet from its own
  previous output. Workers logged 17 retrieval episodes that day and **every one
  scored `no-reach`**, so nothing written anywhere could have reached it.
  Until now there was **no path to reset a worker's context at all** —
  `clearSession` was called on the concierge slot and nowhere else. So the
  concierge did every correct thing available to it and none of them touched the
  cause. Three parts now: `resetThread(slot, why)` (the missing capability,
  keeps the brief), `chat_sessions.fresh` (the policy), and enforcement **at
  dispatch** rather than at the moment someone remembers.
  The flag lives on the THREAD and not in the concierge's head for the same
  reason the night's conclusions had to become rows: that head is cleared every
  night. Warm stays the default because work that spans days must not forget;
  recurring work is where warm is simply wrong, and the tool descriptions say so
  with the failure attached.
  *Still missing, deliberately:* the concierge cannot SEE that a worker has gone
  stale — it has `pendingFindings` but no window onto the friction ledger. It
  can act on a complaint; it cannot notice. That signal (recurring worker +
  resumed session + `no-reach` turn) is the next step, and is what would make
  this fix itself without Mehdi reporting it.

- **2026-08-18** — **Two wall clocks, one sleeping laptop.** The audit's own
  inspection of three real nights found both, and they are the same bug wearing
  two hats: a fold spans 4-6 hours because the machine SLEEPS through it, and
  every wall-clock assumption around it breaks.
  **The audit cried RED on a green typecheck.** `npmRun` returned `ok: !err`,
  so a subprocess killed by `execFile`'s 180-second wall-clock timeout — which
  is what a suspended process gets on wake — was indistinguishable from a
  compiler saying "broken". It filed proposal #33, "TYPECHECK RED", against a
  tree that typechecks clean at that exact commit (verified in a worktree).
  That is **I3 violated by the audit whose job is to enforce it**: a check has
  three outcomes and only a VALUE may become state. Runs now report
  pass / fail / **could-not-be-run**, and the third says explicitly that it is
  not a red suite and must not become a proposal. The cost of getting this
  wrong is precise — the audit's one promise is that a red suite reaches Mehdi
  by morning (M2), and a check that cries wolf is one nobody reads on the
  morning it is right.
  **The dream hold still expired mid-fold**, even after the morning's
  heartbeat: a suspended process emits no beats, so on wake the hold looked
  hours-silent and was discarded while the pass was alive. No threshold fixes
  that, because a sleep can be any length. Liveness is now the PROCESS — a live
  pid holds, a dead one clears instantly (far faster than any timeout) — with a
  twelve-hour ceiling kept as I8's automatic escape, since a pid alone cannot
  tell a working pass from a wedged one. `test/mode.test.ts`'s threshold moved
  from 3h to 13h and says why.

- **2026-08-18** — **The night is handed the needles instead of asked to find
  them.** On 08-16 Mehdi asked which documents he had to sign and send to Iris.
  The concierge looked up `paperwork/form-signing` — retrieval WORKED — and
  filed nothing. Three more messages in the same window said the same thing,
  one of them *"I will sign the forms today and send her scans"*. The night had
  every one inside dream #72's window, alongside its own standing instruction in
  capitals that every open loop belongs in the focus set, and filed none. The
  next morning a worker faithfully reported the set: *"waiting on Bram, not
  you."* Nobody lied; nothing had been written down.
  Three components had it and only the **worker** behaved correctly — it read
  the set exactly as written. The measurement behind it: **the concierge has
  written to the graph 4 times ever, last on 08-13.**
  The instruction to catch this already existed and failed, which is round 8's
  lesson in a new place: a rule stated decays, a rule made mechanical holds. So
  the night now receives `## WHAT MEHDI SAID THAT LEFT NO TRACE` — user-initiated
  turns that produced no observation, no commitment and no graph write, derived
  from the episode log rather than from any agent's account of itself. On the
  window that missed the signing thread it is **14 rows against 86 turns**, with
  the proving row carrying `it READ: paperwork/form-signing — and recorded
  nothing`. Same three-way verdict as the blocks that already work (already
  tracked · file it now · genuinely nothing), and silence is not one of them.
  *The framing that makes it judgeable:* a question is EVIDENCE. "Which
  documents am I supposed to sign?" is not only a request for an answer, it is
  the fact that he HAS documents to sign, arriving in the shape of a question.
  First-person obligations are the highest-value lines and the ones actually
  being lost.

- **2026-08-18** — **A pass proves it is alive, and prose stops counting as
  nothing.** Two nights of real data closed two holes that only real data could
  find.
  **The dreaming guarantee was void for four hours every night.** Dreams #71,
  #72 and #73 spanned 5.0h, 5.9h and 3.8h between the window stamp and the
  report landing — a laptop that sleeps mid-fold advances the wall clock without
  advancing the pass — while `DREAM_MAX_MS` discarded the hold as debris 45
  minutes in. So every night, the machine went back to reporting `live` while
  the fold was still writing, and I11 held only because nobody happened to
  message at 2am. Raising the timeout would trade one wrong answer for another;
  liveness is now PROVEN instead of assumed. The pass beats every two seconds on
  the cancel poll it was already running, staleness is measured from the last
  beat, and the threshold drops to five minutes — strictly better in both
  directions than any timeout measured from the start.
  **`readNote` counted as neither a reach nor a bypass**, so 12 real prose reads
  hid inside 84 `no-reach` rows and a turn answered entirely from memory looked
  identical to one that consulted none. Outcomes now split four ways —
  `answered` (graph) · `tree-only` (prose) · `bypassed` (gave up) · `no-reach`
  (needed nothing). That split IS M5's question, and a single number could never
  have answered it.
  *The M4 number, first real day:* **86 day questions, 2 reached the graph**, and
  focus refs moved 0 → 1/14. The two that reached were both domain questions
  ("Which documents do I sign and send to Iris" → `paperwork/form-signing`),
  which says the door works and the traffic is not there yet.

- **2026-08-16** — **The nights and the findings join the lenses, and dreams
  stop being two panels.** `dreams` and `grows` are ONE event — the same pass
  writes the report and the change-log one line apart, and they join exactly on
  `created_at` across all 60 rows — so they are one lens, not two. Two panels
  would have shown every night twice and left the operator correlating them by
  timestamp, which is the manual join the whole surface exists to abolish. A
  night carries two granularities on purpose: `refs` are the ENTITIES it wrote
  (joined on the pass window, since a write cannot carry the id of a dream that
  has not ended yet), `domains` are the tree files it edited. **41 of 60 folds
  wrote no graph node at all** — the clearest statement yet of why M5 is still
  blocked.
  `findings` is the first deliberately-dark lens: a finding is a proposal about
  `src/`, and `src/` is not in the graph. 6 of 32 name a real entity outright
  and link by EXACT full-id match; the other 26 render dark rather than being
  given invented links. A lens that admits what it cannot point at is worth
  more than one that looks busy.
  *Two bugs the live output caught, both invisible to typecheck and 351 green
  tests:* the panel said `0 still open` directly above rows tagged `pending`,
  because it tested `status === 'open'` and this table's vocabulary is
  pending/applied/delivered/dismissed; and every night was titled `I'll start
  with the mandatory first jobs…`, since a report OPENS with the agent
  narrating its plan and the night report is written last. Titles now come from
  the tail, minus the warnings `rewritePass` appends after the pass ends.

- **2026-08-15** — **Every context store is a lens, and the drawing is what
  enforces I4.** The focus set, the observation inbox, the friction ledger and
  the retrieval episodes were all readable only by opening SQLite by hand. They
  are now four lists in the Atlas, in the shape the run ledger proved: rows on
  the left, hover lights what that row touched, the graph goes grey as evidence.
  One route (`/lens/:name`), one payload, one component — six bespoke panels
  would be six places to fix the next time the halo changes.
  **The point is not the UI.** A store with no refs renders as a visibly dead
  list with its blind count in alarm colour, which turns I4 from an invariant
  nothing checked into one that fails loudly on a screen someone reads daily.
  It proved itself immediately: `retrieval_episodes`, shipped hours earlier in a
  commit that *cited I4*, recorded `find→neighbours→openLoops` and not one node
  id. It could not be drawn. Nothing else had ever needed to draw it, so nothing
  caught it. Episodes now carry refs, attached where they first exist — inside
  the module call, since only the call knows which argument resolved to a node.
  Three tones, because a halo was asserting three unlike things: `changed` (this
  row edited the node), `read` (it looked at it), and `missing` — a name the
  graph cannot answer to, drawn as a dashed chip on the row because **there is
  nothing to light**. That last case is the highest-value thing on the surface:
  85 distinct names in the inbox resolve to no node, and the focus set reads
  `21 rows · 21 blind`. Both were true yesterday and neither was visible.
  *Also caught by driving it:* the inbox lens read `pendingObservations` — the
  night's work QUEUE, which empties itself by design — and rendered zero rows
  against 50 real observations whose entire payload lives in the folded half. A
  queue and a record are different questions about one table.

- **2026-08-15** — **The focus set points into the graph, and every question is
  now a recorded path.** M4's first step. A focus item gains `ref` — the entity
  it is about — and `readFocus`, the one memory surface the day already calls by
  habit, hands that pointer over with its own coverage stated (`1/21 point at an
  entity`). The line carries the ref and NOTHING ELSE: no facts, no neighbours.
  A fat line would re-create what was deleted on 2026-08-06 for I7/I12, and
  worse, would pre-empt the very read this milestone exists to create. The
  pointer is the invitation; following it is the episode.
  `ref` is AUTHORED (I2), never matched — measured before building, string
  matching the live set gave 1 exact hit and mostly garbage, with
  `launchpad-release-candidate-conflict` "matching" `launchpad/system`. A wrong
  ref is worse than none because the day follows it. An item pointing at nothing
  is the same discovery signal M1 built for unattributed observation refs,
  arriving from the other side.
  Alongside it, `retrieval_episodes`: one row per question — trigger, the
  ORDERED path (`find→neighbours→openLoops`), steps, bypasses, outcome. Recorded
  at `noteToolCall`, the single seam that already sees every tool a session
  uses, which is why it can see the half that matters: a bypass is not a module
  call, and an episode log that records only successful reaches cannot tell a
  question the graph answered from one that drove someone to the filesystem.
  Outcomes are `answered` / `bypassed` / `no-reach`, and telling the last two
  apart is the whole point.
  *Caught by driving it:* the column typechecked, passed 339 tests, and rendered
  nothing. `commitments` is read through four prepared statements; the column
  reached three, and the focus set is loaded by the fourth, whose SELECT list
  wraps onto a second line and escaped the edit. Fourth time this session that
  green meant inert. The regression test asserts the RENDERED LINE and was
  confirmed to fail against the reintroduced bug.

- **2026-08-15** — **The day has never read the graph, and that is the finding.**
  Asked whether the graph is helping or is a fancy visualization, the machine's
  own instruments answered before any opinion could: `DAY 0 / NIGHT 18` and
  `DAY 0 / NIGHT 29`, two cycles running, against 105 `note` retrievals and 30
  `bypass` rows. Written by the night, read by nobody. No entry in *Ideas
  measured* below is worth anything until that number moves, because nothing
  currently selects for the graph's quality — which also explains why the shape
  feels like discrete samples: an append is always locally cheaper than a
  compression, and no reader has ever complained. Two consequences recorded:
  **M4** is amended to log the read path as *episodes* rather than calls (the
  grouping cannot be reconstructed later), and **M9** is opened for the
  query-driven optimizer that episode log makes possible. Also noted, because it
  is the lever nobody was pulling: `FACTS_MAX: 6` already exists in the lint
  ruleset and `I308` is documented in the source as *"counted, trended, never
  charged"* — the system has been measuring the bloat it declines to bill for.

- **2026-08-15** — **The night reads its own last report.** Every pass ends by
  narrating what it INTENDS — "I'll skip these eight tonight", "compress it on
  the next pass", "keep an eye on that" — and not one of those lines reached the
  next pass. The digest carried root, the graph, the focus set, the inbox, the
  events and the timeline; the report went to Telegram and the journal, both
  read by a human and by nothing else. So the night could form an intention
  every night and act on one never. It now gets **exactly one** report, last
  night's, framed as a reconciliation rather than a recap: each forward-looking
  line is already durable, still worth doing (file it now — this is its last
  showing), or dead (say so and drop it). One and not seven, deliberately —
  handing over a week would make the night's own prose a store it answers to,
  which is the failure `root.md` already had (I1). The report becomes a funnel:
  an intention gets one night on prose and then has to become a focus item, a
  commitment or a graph fact to survive a second.

- **2026-08-15** — **The night is a debt, not an appointment.** New invariant
  **I11**, bought by three days of the same failure (08-12 double fold, 08-13
  2h45m late, 08-15 the morning firing *before* the fold that was meant to close
  the previous day). The nightly commitment row is retired; `src/night.ts` holds
  a boundary and a ledger of nights ACCOUNTED FOR, and `allowed()` refuses every
  day activity while one is owed. Two things this exposed. First, the debt
  cannot be paid by anything the debt blocks — `allowed('commitment')` is false
  while a night is owed, so a fold riding the commitment queue can no longer
  reach the queue that would run it; the tick pays it directly. Second, the
  ledger needs its own table: a pass that runs and finds a QUIET window writes
  no `dreams` row, so reading the debt off the journal would treat an empty
  night as an unpaid one and re-fold every 60 seconds forever. And the escape
  hatch is part of the design, not a concession — `/cancelnight`, the Atlas
  chip, or `modeCli cancel-dream` stop the pass, roll its writes back from a
  snapshot taken at claim time, and open the day.
  *Found by shipping it:* the first process to boot with this code started an
  unscheduled fold at 09:44 on a day that had already dreamt at 09:18 — an empty
  ledger honestly reporting "no night has ever been settled", which reproduced
  the exact double-fold the change exists to prevent. A new ledger about a
  machine with 70 nights of history must not claim the history did not happen;
  it now backfills from the dream journal.

- **2026-08-09** — **The turn you are in holds the graph.** The footprint grew
  node by node while the agent worked and then vanished the instant it finished
  — so the answer arrived beside an empty graph, and the only way to see what it
  had touched was to go hunting for the row it had just written. What the graph
  shows is now one ladder, highest match wins: **hover** (the transient probe,
  always wins, always ends with the pointer) → **the open turn** (holds from the
  moment you ask until you close its card) → **expansion** (the fallback once
  the card is dismissed). Expansion sits below the open turn deliberately: while
  you are in a conversation, opening an old row is reading, not switching.
  Once a turn lands, its footprint comes from the ledger row rather than the
  live `reached` list — the row counts every entity the turn's calls touched,
  where `reached` only sees ids that appeared in tool ARGUMENTS.
  Exactly one row is ever open, so it now looks it: a rail, a brighter ground
  and a lifted prompt. A 5% tint sat two pixels from the 3% hover tint, which
  meant the panel gave no answer to *which one am I reading*.
  **Also fixed, and it was not from this change:** `observe.test.ts` went red
  because `unattributedRefs()` caps at 20 and the graph has grown to 61 distinct
  unresolved refs, pushing the case's one-hit row off the ranking. The suite
  runs against a snapshot of the LIVE database, so a case that never named its
  limit passed for months and then failed for the one reason unreadable from the
  failure: there is more real data now. It asks for an explicit limit, and the
  ranking-and-cap behaviour it had been relying on by accident is now asserted
  on purpose. 316 green.
  Advances M4.
- **2026-08-08** — **Asking is free; changing is what debug buys.** The
  operator's agent required debug outright, which meant that asking the machine
  a question about its own memory cost the whole day: turns, workers, probes and
  the nightly all suspended, to read a node. That is an enormous price for a
  question, and the effect was that the question did not get asked. Reading was
  always free; what debug actually buys is the right to change memory under a
  concierge whose context was built on the old version. So `operator-turn` is
  permitted while live and `operator-write` is not.
  **Enforced at `applyWrite`, not in the prompt.** The agent is told it is
  read-only and that is worth doing, but a rule a model is asked to follow is a
  suggestion — it can be confused about which mode it is in, or simply wrong.
  `callModule` sets `BOT_READONLY` for a read-only caller and the write path
  refuses, so being wrong costs nothing. Scoped to the CALLER rather than the
  mode, because the nightly writes while the bot is live — that is its job — and
  a blanket "no writes while live" would break the night to protect the day.
  Verified across the process hop, and verified that a normal caller is
  untouched.
  A plan offered while live gets **sedate & apply**: one click that opens the
  debug session with the plan as its reason and carries it out. Making the
  operator flip a switch first only creates a window in which they forget why.
  **Grey came back to the ledger.** Two days ago colour was tied to the work
  state on the argument that grey should mean one thing — the bot is sedated.
  The argument was right about the danger and wrong about the remedy: reading a
  run while the bot was LIVE left the graph in full colour, so hovering a row
  highlighted a footprint invisible against twelve hues. The one view whose
  whole purpose is *everything greys out except what this attempt touched* had
  no grey. Two facts, two signals: **grey graph** = you are reading the ledger;
  **tinted top bar** = the machine is sedated (amber) or dreaming (violet).
  Also: the two chips that both read "live" became one — the dot is the feed,
  the label is the work state. 315 green.
  Advances M4.
- **2026-08-08** — **"Yes please do that" is now a button — and driving the UI
  found three bugs no test would have.** The shape of nearly every operator
  conversation was: ask what something costs, read the answer, type *yes please
  do that*. That message carried no information — the plan was in the agent's
  context one turn earlier — and typing it was the only thing between a
  considered plan and a performed one. The agent now ends a planning turn with
  `propose(summary, steps)`; the panel renders **apply**/**discard**; approving
  sends the plan back into the same session as a new turn.
  Approval is a ROW, not a chat message, because it is the moment worth being
  able to audit: what was approved, when, and by which run. And apply does not
  execute the steps server-side — they are prose written for a person to judge,
  so a server that ran them would need machine-readable ops, i.e. a second write
  path around `applyWrite` with its own bugs and no journal. The agent carries
  out its own plan through `record()` like anything else.
  **Then it was driven in a browser, and that is where the real findings were:**
  - **Every agent write was unattributed.** A module runs in its own process and
    calls `record()` with the actor `"module"` — so `currentRunId("module")`
    matched the open run of nobody, and every write landed with a null
    `run_id`. The ledger showed run #31 with **zero writes** while the graph had
    changed, and *"revert this run"* was a button that would have reverted
    nothing and reported success. Per-run revert is the entire reason it is safe
    to let an agent write, and it was resting on attribution that was not there.
    `callModule` now passes the caller in the child's environment. Verified
    live: writes 196–197 are `debug-agent`/run 33 where 195 and everything
    before it is `module`/null.
  - **The exit dialog said "nothing was written" over three real writes.** The
    count was derived in the browser by filtering runs on `started_at >= since`
    — SQLite writes `2026-08-08 13:20:00`, `toISOString` gives
    `2026-08-08T13:20:00Z`, and a space sorts before `T`, so the filter matched
    nothing. It offered to wake the bot with no way to discard. The server now
    counts it off journal ids and reports it with the session, so the dialog and
    `exitDebug` cannot disagree.
  - The proposal never recorded WHICH run carried it out — half an audit trail.
  All three were invisible to typechecking and to 308 green tests. 311 green.
  Advances M4.
- **2026-08-08** — **The turn is watched, not awaited.** `/api/agent/ask` held
  the request open for the whole turn, and the comment defended that as "the
  honest shape — the client shows it is thinking". It was honest and blind:
  forty seconds of a spinner, then everything at once. It now returns the run id
  as soon as the run exists, and the turn streams — tool calls as they are made,
  the answer token by token (`includePartialMessages`), the footprint growing on
  the graph node by node as the agent reaches for them.
  **Not on the pulse bus,** which was the obvious move and is wrong for the same
  reason its own header gives: bounded, lossy, *"nothing here may ever become
  load-bearing"*. A dropped pulse costs an animation frame; a dropped delta
  costs a sentence out of the middle of an answer, and the reader cannot tell a
  lossy answer from a complete one. `agentTurns` is a separate small registry
  where every fragment is buffered as well as published, so a client that
  connects late or reconnects mid-turn replays the whole answer so far and then
  goes live. It stays in-process deliberately — unlike the work state and the
  open run, a live turn has exactly one writer and no second party to disagree
  with.
  Watching a turn is also what made **stopping** one necessary: the value of
  seeing it reach for the wrong node on step two is being able to say so before
  step nine, so an abort tears down the query and the run closes normally with
  whatever it wrote still attributed.
  **Two bugs found by running it rather than reading it.** The refs extraction
  used a flat `Object.values` over the tool input, but the knowledge API is
  reached through `callModule('entities','find',[id])` — the id is two levels
  down. Every step arrived with `refs: []`, so a turn that read six nodes lit
  none of them: the feature looked implemented and did nothing. And `refusal()`
  assumed a refusal could only come from a suspended state, so asking the agent
  a question while the bot was LIVE was answered *"DEBUG MODE — suspended"* —
  the opposite of the truth, prescribing the opposite of the fix. All three
  states can refuse, and each sends the operator somewhere different. 308 green.
  Advances M4 (the operator surface); serves I8.
- **2026-08-08** — **A batch outlived its own permission, and a hold could not
  be escaped.** Both found within an hour of shipping the three states, by
  running the thing rather than reading it.
  Exiting debug released the night's suppressed `nightly-pipeline`, which fired
  at 12:36, took the machine, and — from inside the same commitment batch — let
  `morning-routine`, `standup-cheatsheet` and a dispatched worker run against a
  permission granted before the machine was taken. A worker read memory while
  the night was rewriting it. The firing loop checked the work state ONCE per
  batch, deliberately: `markCommitmentFired` advances the row before the
  callback, so refusing halfway would have consumed a firing. That reasoning was
  correct while a human typing `/debug` was the only way into a suspended state,
  and it died the moment a commitment became something that can take the
  machine. The check now sits per firing and BEFORE the row is advanced, so a
  held-back commitment is neither fired nor consumed — the objection is answered
  rather than accepted.
  **Honest limit:** the tick-level guard should also have blocked the 12:39 and
  12:40 firings, and in isolation it provably does. Why the live process behaved
  otherwise is still unexplained. The fix is the guard at the point of use plus
  a log line on every held-back firing, so a next occurrence is read off a log
  instead of inferred — but it is a guard, not a diagnosis, and saying so is the
  point (I8).
  **And the hold could wedge.** `dreamPhase()` was a plain read; only the CLAIM
  path checked for debris. A pass that ended without releasing would therefore
  report DREAMING to every caller forever — blocking turns, sweeps, the next
  night, and the operator's own way back in. Staleness moved onto the read (age,
  since the holder is usually the bot itself, so its pid is alive by
  construction after a restart and pids are reused), boot clears any hold from a
  dead process, and `modeCli.ts clear-dream` is the manual door. A lock you
  cannot leave is the exact shape I8 forbids, and this one was written to serve
  I8.
  **Also recorded, because it cost the most:** while diagnosing, the live hold
  was read as debris on a timezone misreading (`since` in UTC against a process
  start in +0330) and DELETED — while the pass was still writing. It was a
  guess acted on as a finding, which is the failure CLAUDE.md's first working
  rule names outright. 301 green.
  Serves I8.
- **2026-08-08** — **Three states, one machine.** The bot may now be in exactly
  one of `live | dreaming | debug`, and the page can say which. Dreaming is not
  a peer of debug: **debug is a SESSION** (snapshot + baseline write id) and
  **dreaming is a PHASE** over it, so `currentMode()` reports dreaming > debug >
  live and the operator's induced dream — the main *"did that change help?"*
  instrument — stays legal. While a pass holds the machine NOTHING runs: not a
  turn, not a sweep, and not a gardening prompt either, because a dream is the
  day's termination routine and anything writing memory during one is writing
  into a context being replaced under it.
  This also fixed a live bug rather than only adding a state. The "one pass at a
  time" guard added on 08-02 after the double-nightly (`core-api/ci-robustness-38`
  minted twice) was a **module variable**, and a module variable is not a lock:
  the scheduled nightly runs inside the bot, an induced `/dream` runs in its own
  process, and neither could see the other's flag. The exact overlap that comment
  describes was still reachable through the door the operator uses most. The
  phase now lives in the database, with the holder's pid so a pass killed with
  `^C` is recognised as stale rather than wedging the night shut (I8). Third time
  the interesting boundary turned out to be between processes, after the pulse
  bus and the open run — that is a pattern now, not a coincidence.
  **Grey stopped meaning two things.** The Atlas's monochrome painting keyed off
  the run ledger being open, conflating *I opened a panel* with *the bot is
  suspended*. The proposal on the table was to lean into that and have opening
  the panel sedate the bot; rejected, because reading last night's ledger from a
  phone would then silently stop the bot answering with nothing on screen saying
  so — I8 in the interface. The ledger now opens read-only while live, grey means
  **sedated** and nothing else, and the mode chip is the only door. Reading the
  state and changing it are one control, so they cannot disagree.
  **The night is told.** Keeping a debug session's writes clears the concierge's
  context, which from the night's side looked like an unexplained hole in the day
  next to graph writes by hands that were not the day's — and a pass that
  reconstructs a reason for that reconstructs the wrong one. Closed sessions are
  filed to `debug_history` and appear in the digest as *"the machine was worked
  ON, not with"*. 296 green.
  Serves I8; unblocks the operator-surface work under M4.
- **2026-08-07** — **First debug session: gardening, watched.** Entered debug,
  worked the graph, exited keeping 9 writes. What the session found is worth
  more than what it fixed.
  - **A CLI write did not reach the Atlas.** The pulse bus is a per-process
    `EventEmitter`, so the gardener changed the graph and the page showed
    nothing — which defeats most of the reason to run one while watching. Every
    pulse is now also written to a `pulses` table, and the bot relays anything
    from another pid into its own bus. Registered from `db.ts` so EVERY process
    with a database publishes automatically: wiring it per-entry-point fails
    silently, which is the same bug reintroduced one command at a time.
  - **My first two attempts to prove that were both invalid**, and one took the
    bot down. The test used `timeout`, which macOS does not have, so the capture
    file was empty and "no pulses reached the Atlas" was a command-not-found. The
    fix then used `require()` in an ESM module and crashed the process on
    restart. The conclusion happened to be right — the bus IS per-process, read
    from the code — but the evidence was worthless twice over.
  - **W201 over-reported by half.** It counted only AUTHORED edges, so three of
    six "isolated" nodes (`people/eleanora`, `people/kian`,
    `personal/content-reward`) were reachable the whole time through derived
    `acted-by`. I2 says derived is not authored; it does not say derived is not
    real, and `neighbours()` traverses both. The mint checklist now accepts an
    `actor` for the same reason: the rule is that a node arrives FINDABLE, not
    that it carries a particular field.
  - The three genuinely isolated nodes were linked from what their own facts
    said. **Birth defects: 6 → 0.** Every node in the graph is now reachable.
  - **An `edge` write now lights both ends.** The renderer runs a light ALONG
    the link when a pulse names more than one node, so refs of `[source]` drew a
    dot where the relation coming into existence should have been drawn — the
    most legible thing a gardening pass produces.
  - rot 86 → **78**. 290 tests green. Exiting KEPT the writes, so the concierge
    context was cleared: memory moved under it.


- **2026-08-07** — **Work state: live, or debug.** The bot's normal condition is
  also the condition under which it is impossible to work ON it — everything
  moves while you look, and an experiment lands in a concierge context that has
  since absorbed it. DEBUG is defined by what it forbids: no day turn, no
  worker, no commitment, no wakeup, no probe or focus sweep, no harvest, no
  distil, no automatic nightly, and **nothing added to the concierge's context**.
  What stays: gardening, an INDUCED dream, and every read — so the graph can be
  worked iteratively and watched, since every write already pulses and the Atlas
  already halos the node.
  - **Rollback is a snapshot, not a journal replay.** `entity_writes` holds a
    `before` for every op, so an inverse-op undo is possible and it is the wrong
    choice: it fails halfway on dependencies (revert the mint before the edge
    pointing at it), it cannot undo anything that did not go through `record()`,
    and a half-completed rollback leaves a state nobody designed. The tree is
    740K across 89 files. Verified end to end against a real write: tree hash
    byte-identical before and after.
  - **Exiting has two doors, and the difference is the concierge's context.**
    ROLLBACK leaves it alone — the tree is as it was, so its picture is still
    accurate, and that is the point: the experiment cost the day nothing. KEEP
    clears it, because memory moved underneath a context built on the old one,
    which is exactly what had it emailing Iris an answered question.
  - **The state lives in the database**, not a variable: the runner restarts the
    process on every source edit, which is precisely what one does while
    debugging, and an in-memory mode would silently revert to live mid-session
    and let the day back in.
  - **Commands still work in debug** — a mode you cannot leave from the same
    place you entered is a trap (I8). `/debug`, `/live`, `/live rollback`, and
    `src/modeCli.ts` for the terminal.
  - The audit's FIRST line is now the work state, and it fires in debug: a still
    inbox and unrun probes are alarming while live and expected while suspended,
    and an audit that could not tell them apart would report a healthy pause as
    a fault every time. `/api/mode` exposes it to the Atlas. 289 tests green.


- **2026-08-07** — **The gardener: it prepares, the agent decides.** The premise
  going in was a "sudo mode" that commits structural change on its own. The
  measurement killed that half and kept the better one. Deterministically
  fixable classes across the whole graph: **0** exact duplicate facts, **0**
  redundant relates-to, **0** dangling edges, **0** subsumed facts, **12**
  symmetric edges. There is no heavy mechanical gardening available — the write
  path's guards have already prevented all of it — and every remaining yellow
  turns on a judgment (which fact to keep, what the real relation is, what
  splits off a node). An algorithm making those calls would be dressing judgment
  as determinism, which is the failure this whole round has been correcting.
  - **So the gardener precomputes the ACT, not the decision.** Each yellow
    becomes a PACKET carrying the offending text, the candidate targets, the
    inbound edges, and the exact `record()` call — so a fix costs the night a
    few lines instead of a survey of the graph. That is the difference between
    "86 yellows" (a number nobody acts on, the proposal queue's failure one
    layer down) and work someone can do. Exposed as `gardenPlan`.
  - **`plan()` is read-only**, which is what lets it run beside a live day.
  - **The write path had no cross-process lock, and that was a real hole.**
    `applyWrite` is fully synchronous, so inside the bot it was already atomic —
    which is exactly why nobody saw it: every writer lived in one process. A
    gardener run from a CLI does not, and two processes doing read → mutate →
    `writeFileSync` over one domain file means the second silently ERASES the
    first. Not a corrupt graph (each write lints clean alone) but a lost one,
    with the journal recording both as successful. Now an advisory lock, with a
    stale-lock takeover so a crashed writer cannot wedge the graph (I8).
  - **A heavy pass ran against the live tree**: 12 symmetric `relates-to`
    collapsed, 0 refused, all journalled through the normal write path and
    revertible row by row. **rot 86 → 81.** Backup in `data/backups/`.
  - A packet that is not `safe` carries no op, and only `drop-edge` is ever
    mechanical — both pinned by tests, because widening that set is a decision
    and not a refactor. 279 tests green.


- **2026-08-07** — **The live test disqualified a rule, and the fixes it
  produced.** Predictions were pinned in
  `docs/plans/test-2026-08-07-linter-and-mint.md` BEFORE the run, so the result
  could falsify them. Then the scheduled nightly fired unattended, which made it
  a better test than a watched one. **5 hit, 2 missed, 1 untested.**
  - **P1 hit cleanly.** The first mint under the birth checklist
    (`personal/learning-software-testing`) carried `owned-by: people/mehdi` —
    no refusal, no retry, no friction row. The night simply supplied the edge.
  - **P3 missed, and it is the finding.** That node was minted with three facts
    and **all three tripped W208**. A rule that fires on 100% of fresh, careful,
    correct output measures HOUSE STYLE, not decay; in a budget it would charge
    the night for every fact it ever writes and the ratchet would fail on night
    one. It is not wrong about the shape — that fact really is three claims
    welded together — it is wrong about severity. Splitting compound facts is
    gardening work for an agent that can read the evidence, never a gate.
    Demoted to I308. **Rot 145 → 86**, which is a budget the night can hold.
  - **P5 hit, and I had predicted it would miss.** DAY 2 / NIGHT 17, with
    `readFocus` and `callModule` in the day's doors. After a run of DAY 0–1
    against NIGHT 15–40, the day reached for memory unprompted. One cycle is not
    a trend, but it is the first movement on the number M4 turns on.
  - **Two findings no prediction covered.** The night wrote the fact TWICE — the
    graph node and `personal/learning-software-testing.md`, then read the md
    back through a bypass; eight entities now have two homes (I309, blue,
    because the fix is M5's migration and not a refusal). And the chain read
    `message#6497` where the graph's other ~250 entries say `msg#` — unfollowable,
    and `chain` has no write op, so nothing could ever have repaired it.
    Normalised at the write path (`canonicalRef`).
  - **A trend across a changed ruleset is now refused, not silently wrong.**
    Demoting W208 moved rot 145 → 86 with the graph untouched; a reader
    comparing those two readings would conclude a night of gardening had
    happened. `graph_rot` carries a ruleset fingerprint and a mismatch reports
    "fresh baseline" instead of a delta.
  - **The friction ledger stopped crying wolf**, twice over: the Atlas calls
    `blockers`/`stats` on every node it draws and produced 252 of 303 empty rows
    — a renderer finding nothing is a Tuesday, so empties from it are no longer
    recorded (errors still are). And the line now fires on FAULTS only: a bypass
    is the second-store signal (I1/M5), true every night and fixable by no
    single night, so it is reported and never alarms. 303 → 111 hits.
  - 266 tests green; the audit is 2 of 11 firing, both legitimately.

- **2026-08-07** — **The graph gets a typology, and the budget gets a fair
  denominator.** A deterministic linter over `entities.jsonl` — stable codes,
  three severities, no model — because the existing 24 rules are all fatal, so
  every shape problem we could measure was inexpressible as a rule. The
  measurement pass came first, and it earned its keep: **four rules were wrong
  on their own first run**, including two of mine that would have gated.
  - `E103` forbade a closed entity from keeping its probe. 32 hits, every one
    correct behaviour — a probe is how a REOPEN is noticed, and the 08-07 bug
    was the sweep's cadence, not the probe's existence. I turned a fix I had
    just shipped into a rule without re-deriving what it forbade.
  - `W202` "nothing points at it" was the biggest number in the first run (77)
    and the premise was wrong: `neighbours()` returns `direction: 'out' | 'in'`,
    so a node with only outbound edges is reached fine from its target. An edge
    is one-way to WRITE and two-way to READ; I measured the writing side and
    called it reachability. Real isolation is 6.
  - `W211` scored 6 on name accidents (`eleanora` ends with `nora`) while
    MISSING the pair it was written for — `ci-robustness-38` and
    `ci-robustness-initiative-38` fail `startsWith` in both directions.
  - `W210` (open, no probe) was neither birth nor rot, which is the tell that it
    is not a defect: most of the 25 close only when a person acts.
  - **The split (birth vs rot) is what makes a ratchet possible.** A flat "no
    more yellows than you started with" fails on contact — the night minted 9
    nodes on 08-05, and rules that fire the instant a node exists would charge
    it ~20 for doing its job. So a yellow declares WHY it exists: *birth*
    (true the moment the node exists → **refused at the write**) or *rot*
    (accrues from ordinary editing → **the budget**). The test is: could a node
    be born violating it through no fault of the author?
  - **The mint checklist is wired.** `mint` now takes `edges` and requires at
    least one — which also names the root cause of W201: **a mint could not
    express an edge at all**, so every node was born isolated and six never got
    linked. That was never carelessness; the op had no way to say it.
  - Rot: **142** of 163 entities, recorded per audit in `graph_rot` so the trend
    accrues. Reported, **not yet blocking** — a budget needs a series before it
    can have a threshold, or the night ends up defending the number instead of
    the graph. 266 tests green.

- **2026-08-07** — **A report that could not tell a fixed bug from a live one
  (I3, I8).** Dream #59 was a good pass — it caught a marital-status wording
  that had misled Mehdi himself, folded the inbox to zero — and then opened by
  naming bugs that no longer existed. Four separate signals were at fault, all
  the same mistake: **every one of these tables records that something failed
  ONCE, and only a timestamp says whether it still does.**
  - **The proposal queue is the one claim nothing re-checked.** All five pending
    rows had already shipped, and the night read them as live — including #28,
    whose success was in the evidence directly above it (`readFocus` firing 13×
    *is* the injected copy being gone). It counted a win as an outstanding task.
    A proposal now carries `verify`: the command that passes once the fix has
    landed. The audit runs them and reports three outcomes (I3) — `shipped`,
    `not-yet`, or *cannot be checked*, which must never read as either. The rule
    it buys: **a proposal that cannot name what would prove it done is not a
    proposal yet.** All five backfilled, verified shipped, resolved.
  - **Frozen misses read as live ones.** 36 of the 40 `check_misses` rows had not
    moved since the 429 fix landed at 10:54 that morning; the 2 still ticking had
    a different cause the aggregate hid — both are *closed* entities whose
    archived Fibery tasks can never answer again. The audit now splits STILL
    FAILING from STOPPED and only fires on the first, and the sweep probes a
    closed entity every 12h instead of every 15min (reopening is real, so rarely,
    not never). That is 33 of 57 probed entities off the hot path.
  - **Two more of the same, found while fixing the first two.** The friction
    ledger showed `entities.graph` failing 5× with no date — from 2026-07-31, six
    days after the fix, and it briefly convinced *me* the bug was back. The API
    line said "87× entities.graph (5 failed)" because `module_use` is a lifetime
    aggregate filtered by `last_at`; it now reads the per-call log. Real failures
    in 24h: three, two of them fixed below.
  - **The write path crashed inside its own error message.** The night sent
    `correct-fact` as `{before, after}`; `mutate` reached for `w.from.slice(60)`
    in the branch that builds the friendly "no such fact" diagnostic and threw.
    Shapes are now validated at the door, naming both the fields wanted and the
    fields received — because the wrong field *name* is the likeliest mistake at
    a boundary an LLM composes JSON across. `resolveRef` accepts `{id}` too,
    which had killed a `find` call the same day.
  - **`cycleCli` reported "FOCUS SET — 0 change(s)"** for the cycle in which the
    night closed #104 and rescoped #84: it counted `focus_changes`, the
    *checker's* output diffs, not membership. It now names what entered and left.
  - 242 tests green. `test/staleSignals.test.ts` pins the property the four
    lines share, against the rendered text — the only surface where the bug was
    ever visible.
  - **The running instance was two days behind its own source (I8).** Found
    while fixing the above: `seedModules` copied a module only when ABSENT,
    which is right for "the night owns it" and silently wrong for "we improved
    the repo". The live `entities` module's `record` doc listed neither `move`
    nor `retire`, so **the night could not reach for ops the write path had
    already given it** — which is why the 2026-08-04 pass left a *note* about a
    misfiled entity it was able to move all along, and why the duplicate pair
    sat unmergeable for two days. Nothing reported it; it took a hand diff.
    The rule is now stated against evidence instead of presence: we stamp what
    we hand over, and a live copy is identical (nothing to do), byte-identical
    to our last stamp (ours, stale, updated), or something else (the night's,
    left alone and reported). Only the middle case is ever overwritten, and only
    because the stamp proves no other work is in it. `moduleDrift()` is an audit
    line, so a behind instance announces itself. Reconciled, `retire` documented,
    backup in `data/backups/`. 249 tests green.

- **2026-08-06** — **Clearing the audit's list.** Six items, taken in the order
  the machine ranked them.
  - **The focus set left the prefix (M4, I12).** The audit recommended it in its
    own words — *"readFocus() called 13×, so dropping the injected copy is now
    safe to try"* — and it was the worst I12 offender in the system:
    **24,967 characters rewritten by a probe sweep every fifteen minutes**, so it
    invalidated the session cache four times an hour whether or not the
    conversation had moved. With yesterday's tree index that is ~30k of prefix
    gone. Pinned by `test/conciergeContext.test.ts`.
  - **`entities.graph` was truncating ~7% of calls, and its own safety net was
    the cause.** `moduleHost`'s drain guard fired at 5s and called
    `process.exit(0)` regardless of how much of the envelope had been written —
    recreating the corrupt envelope it existed to prevent. The parent already
    owns the deadline, so the net now sits beyond it; and a cut envelope is
    reported as TRUNCATED rather than "unreadable", which sends you to a
    different file. 12 concurrent whole-graph calls, 0 failures.
  - **`retire` — the last structural gap.** The graph could gain a node and
    never lose one, so the duplicate pair two overlapping nightly passes minted
    on 08-05 sat there, visible to `similar()` and removable by nothing.
    `retire` refuses while anything still points at the node unless given
    `into`, which repoints them first — so it cannot leave a dangling edge — and
    journals the ENTIRE row in `before`, which is what makes deletion allowable:
    it is recorded completely, not made safe. `ci-robustness-initiative-38` is
    folded into its twin; `similar()`'s top hit is now a known false positive.
  - **`graph.stuck()`** names the entities nothing can close: open, no probe, so
    no command will ever move them. 25 of 44, but most are paperwork and
    personal items that close when a PERSON acts — the two with RESOLVED already
    in their own facts sort to the front, because there the answer is to give
    the entity a probe.
  - **`## Global facts` audited, and it is not the map.** It is authored, small
    (1,471 chars) and points at its sources, so it never claimed a completeness
    it lacked. Of the whole roster line exactly one role was missing from the
    graph — Amin is Tech Lead — now on his node. Reported small rather than
    inflated into work.
  - **The turn lock is its own module with its own tests.** Fifty lines of Set
    and Map that have taken the bot down twice, both times from the same blind
    spot: a session can hold the lock with nothing to abort. The property under
    test is not "cancel aborts things" but **release is reachable from every
    state**. Nine tests, including the two exact failure shapes from this
    morning. 231 green.
- **2026-08-06** — **The state clock was broken for 40 entities, and the audit
  was the only thing that knew.** `auditCli` reported 40 checks unable to answer,
  with hit counts of 17–20 — a quarter of the graph's probes failing for a full
  day. Every one showed a jq error, and the probes ran fine by hand. Measured:
  **10 sequential calls → 0 failures; 8 concurrent → 2–4.** The cause is Fibery
  answering **HTTP 429 with the plain-text body `Too Many Requests`**, which jq
  reports as `Invalid numeric literal at line 1, column 4` — it reads `Too`, then
  hits the space. Nothing in the error names a rate limit, which is why it sat
  for a day looking like a broken query.
  The prober's loop is sequential, so it was not the culprit alone: two
  sequential loops overlapping — the prober, the focus checker, an agent — is
  enough. Fixed in `~/Projects/brain-fibery` (the toolkit, where every caller
  benefits): `cmd`/`gql_raw` now retry **on 429 only**, five times, exponential
  backoff with jitter. Safe by construction — a rate-limited request was
  rejected, not processed, so a retry cannot double-post a comment. Verified at
  16 concurrent calls, 0 failures; learning saved to that repo's `cache/`.
  Worth naming: this is I6's "a stale value looks identical to a current one" in
  its sharpest form. `prober.ts` already refuses to store an error AS state
  (bought 2026-07-28), so nothing was corrupted — the entities simply kept their
  last real state while the world moved. The failure was invisible everywhere
  except the audit block, which is the argument for the audit block.
- **2026-08-06** — **A summary that contradicted its source.** The concierge
  drafted an email asking Iris whether documents should be translated to English
  first or straight to Portuguese — a question `paperwork/translation-model`
  records as **RESOLVED the previous day**. Mehdi's read was "conflicting facts
  in different nodes". It was not: both the graph and the note carry the
  resolution, and they agree. The cause is mechanical and one line long.
  `simplify.ts:321` rendered `e.facts[0]` and nothing else, and **facts append**
  — so the newest knowledge, which is disproportionately the corrections, was
  the least likely thing to appear. Measured across the graph:
  - **445 of 609 facts (73%) reached no map at all**; 86% of entities have more
    than one fact.
  - On **20 entities** the fact that OVERRULED `facts[0]` was among the hidden
    ones, so the map actively misled rather than merely omitted.
  - `paperwork/translation-model` was one of the twenty. So was `people/sasha`,
    whose map line showed the QA role and hid "Sasha is MALE — he/him, never
    she/her" — the same failure, one keystroke away, on the fact whose whole
    point is that misgendering is a SILENT error.
  The tool that found it was `tool_calls`, added the day before: it showed the
  concierge opened `paperwork/_map` and an external memos file, and never the
  note or the graph. Without that row this would have been another hand-read of
  a transcript.
  Fixed by promoting overriding facts into the summary and **counting whatever
  is still hidden** (`_(+N more facts — find("id"))_`). Coverage 27% → 30%, all
  twenty misleading entities corrected, maps grew ~35% (paperwork 4.6k → 6.2k).
  The count matters more than the coverage: a lossy render that does not
  announce its lossiness leaves a reader unable to tell "this is all of it" from
  "this is the first line of it". Pinned by `test/mapCompleteness.test.ts`.
  Scoped honestly while writing it: 40 entities appear on no map, all of them
  CLOSED, which is the briefing working as intended — the contract is about what
  a map shows, not what it omits. 214 green.
- **2026-08-06** — **A recovery command that could not recover.** Mehdi's
  messages got the queued-👀 and no reply for hours; the process was healthy the
  whole time (the 15-minute prober kept ticking) and `turns_running` was empty.
  The lock explains it: `enqueueTurn` takes `busy` BEFORE `runTurn` registers its
  AbortController, so a turn that hangs in SETUP — `view.begin()`'s Telegram
  round-trip, or building the system prompt — sits in a window with the session
  locked, nothing to abort, and the idle watchdog (armed later still) never
  started. Three faults, each of which alone would have been survivable:
  - `cancelSession` returned early when it found no controller, **leaving `busy`
    set** — so `/cancel` answered "Nothing is running", which was technically
    true and maximally unhelpful.
  - `cancelChat` iterated `running` only, so the session that needed rescuing —
    busy, no controller — was **not even visited**.
  - The watchdog was armed after the blocking setup, so nothing timed it out.
  Now: `cancelSession` always releases the lock and `/cancel` reports "released a
  stuck lock" distinctly from "stopped a turn"; `cancelChat` walks `busy ∪
  running`; the controller and watchdog are created before anything that can
  block; and `/status` prints the turn locks with a `STUCK in setup` marker.
  **This is I8** — a check may never block its own repair — in a new place: the
  only escape was restarting the process, and the thing that restarted it was an
  unrelated source edit. Left undone deliberately, mid-day on a live bot: the
  lock is still module-private state in `dispatch.ts` with no unit test. It has
  now failed twice and deserves to be its own module with one. 211 green.
- **2026-08-05** — **`## How to behave` is a render, and the leak is closed.**
  F3 steps 2 and 3, which had to ship together: the moment the section became
  generated, `recordRootHabit`'s appended prose line became data-loss — it would
  shape one turn and then be silently overwritten by the next `self/*` write.
  - **`src/rootBehavior.ts`** renders the section from `self/companion` plus its
    `part-of` children, splicing one block and leaving `## Domains`, `## Global
    facts` and `## Now` authored. Membership is decided by graph STRUCTURE, not
    a list in code: `self/root-render` is deliberately `relates-to` rather than
    `part-of`, so the node describing the renderer is excluded from what the
    renderer emits, at no special case.
  - **`recordRootHabit` now writes a fact** to `self/companion`, and a refusal
    is reported to the model instead of swallowed — the write path rejects a
    habit phrased as state, and an agent told its habit landed when it did not
    will never rephrase. This is what makes the twenty-one-line migration a
    one-off rather than a standing chore (I9).
  - **The root fits its budget for the first time: 10,496 → 8,905 against a
    10,000 cap.** It had been over, silently dropping the tail of `## Now` —
    the most volatile section — which is why `rootContext()` carries a
    provenance-stripping fitter at all. 17 facts render where 21 prose lines
    were; the other five went to their domains and did not come back.
  Two corrections made while building, both worth keeping:
  - **A fact I had written into `self/root-render` an hour earlier was wrong.**
    It justified "full text, not pointers" by saying workers carry the root
    without graph access. They do not carry it at all — `concierge.ts:235` is
    explicit that a worker's injection is its brief and nothing else. The
    conclusion survives for a different reason (the concierge is the reader),
    and the stale "(workers receive this section too)" line in the concierge
    prompt was fixed with it. The graph correcting itself, on the day it
    acquired the ability.
  - **Five habits left the injected prompt** when they moved to their domains.
    Two have SILENT failure modes — misgendering Sasha, and asserting paperwork
    facts Iris never confirmed — so they were preserved in `## Global facts`,
    which is where the partition puts them. The other three (Mehdi's rhythm, the
    breakfast slot, the Fibery-description rule) are recoverable by asking and
    were let go deliberately. 211 green.
- **2026-08-05** — **The root's sections partition the graph.** Mehdi, deciding
  it while planning the render: *"don't put domain knowledge back in the
  behavior section."* So `## How to behave` renders **only** from `self/*`, and
  a fact about a person, platform or case goes to `## Global facts` (which
  already carries the People and Platforms lines) or stays in its domain. The
  behavior section became a dumping ground once — holding Sasha's gender and
  Mehdi's breakfast slot beside actual operating rules — and the partition is
  what stops it recurring.
  Written into the graph as `self/root-render`, not into a plan doc, together
  with the two constraints the renderer must not rediscover by breaking: it
  emits full TEXT rather than pointers for as long as workers carry the root
  without graph access, and its order and content stay STABLE across turns
  because root.md sits in the injected prefix (I12). A decision that lives only
  in prose gets re-litigated by whoever builds the thing — including the night.
- **2026-08-05** — **The habits are in the graph.** F3's migration, step 1 of 3:
  15 writes, root prose deliberately untouched, so nothing can break until the
  renderer exists. Where each went:
  - `people/mehdi` +2 — his working rhythm and his mornings. The hub node went
    from **one** fact to three.
  - `fibery/system`, `paperwork/renewal-case` +1 each — the never-clobber-a-
    description rule and "requirements come only from Iris's emails", both of
    which were rules about a system, not about behaving.
  - `self/` — five nodes, not one: `companion` (delivery), `grounding`,
    `focus-discipline`, `work-boundaries`, `external-waits`, joined by `part-of`.
  **Splitting was not tidiness.** Piling all thirteen self-referential habits
  onto one node would have made it the fattest in the graph by 2× — the exact
  failure `heavy()` was built to name a day earlier. Split, `self/` sits at 3.4
  facts per node against a graph median of 3, cohesion 1.0, and does not enter
  the top four.
  **More of the root was already duplicated than estimated.**
  `reference/source-of-truth` already stated "Done means Sasha has verified it"
  and the org spelling; `reference/fibery-state-vs-deploy` already stated the
  fresh-git-fetch rule. So several habits migrated only their *general* half and
  now point at the twin instead of restating it — which is I1 arriving in
  practice rather than in principle.
  **The write path refused one fact and was right to.** "…items (waiting on a
  person, event or delivery)…" tripped the state-assertion lint. The phrase
  named a category, not this entity's state, but the guard is deliberately blunt
  and the rewording is clearer; a guard loosened to fit one sentence is not a
  guard. 163 entities, lint clean, 203 green.
- **2026-08-05** — **F3 resolved: behavior is facts, distributed.** Three habits
  converted by hand, as the fork prescribed, and the conversion answered a
  different question than the one asked — see the fork above for the three-way
  split. What landed: `people/sasha` finally states that Sasha is male (a fact
  about a person that had lived in the bot's behavior list since 07-09), and the
  `self/` domain now exists with `self/companion` holding the two habits that
  are genuinely about how this system operates. The write path created the new
  domain's `_map.md` and `entities.md` itself — the map-render fix from earlier
  today paying for itself on its first new domain. Lint clean, 203 green.
  The finding that reframes M5: **the root is not a summary of the graph, it is
  a second store.** `people/mehdi` — the hub — held one fact, while everything
  learned about working with him sat in prose. Root-as-render is not tidying;
  it is the graph acquiring what it never had.
- **2026-08-05** — **First measured cycle (#55), and M4's premise is wrong.**
  Mehdi ran a live test: `/dream`, then a substantial block of real paperwork
  news, then a worker, then `/dream`. The report said **DAY 0 / NIGHT 31** — the
  day never called the knowledge API, with the tree index already removed.
  That reading was false, and finding out cost a hand-read of the conversation.
  The concierge grounded itself **twice, deliberately and correctly**: it read
  `paperwork/legalization-and-docs` and `paperwork/process-and-timeline` at
  15:12, and Iris's actual emails (#1804, #4526, #2903) at 15:45 — visible only
  in `retrievals`, and in the transcript saying *"I must ground on what Iris
  actually said"*.
  **The graph was never competing with the index I deleted.** It competes with
  `root.md`'s habit lines, which carry `[[note-key]]` wikilinks — `root.md:15`
  points at exactly the note the concierge opened — and with the message log,
  which holds the verbatim source. For *this* task the message log is arguably
  the right door (I7: hit the source to verify). So M4's assumption that the
  index was the shorter path was wrong; the shorter path was the root itself,
  and it is a better one. The real finding is **two memories**: the day works
  from notes and messages, the night maintains a graph holding the same
  knowledge, and nothing points the day at it. That is M5/F4, not M4.
  Two instrument repairs, both the same class as the bug they found:
  - **`tool_calls`** — `noteToolCall` pulsed every call and persisted only
    bypasses; its own comment named the loss ("a turn that reads six files and
    calls nothing is exactly the picture that explains why the API ledger is
    empty") and sent that picture to a lossy ring. Now persisted, so the cycle
    report answers **which door**, not just "did it call the API" — an empty
    ledger means two opposite things and they need opposite fixes.
  - **Cycle windows were off by one night.** `covers_to` is stamped at the TOP
    of `runRewrite`, so a dream's own execution fell into the NEXT cycle, and
    the first reports credited a night's work to a night that had not run. A
    cycle now ends at the dream's `created_at` — the day plus the night that
    folded it, which is what the word means. 202 green.
- **2026-08-05** — **M4 opens: the shortcut is gone, and reads are on the
  record.** Two changes and a mechanism.
  1. **`notesIndex` is no longer injected into the concierge.** The concierge
     has carried the knowledge API since round 9 and never called it — across
     the whole ledger `module_use.last_session` only ever names `atlas` or
     `nightly`, and the concierge appears in the friction ledger exactly once.
     It was not bypassing to files either; it was answering from its injected
     context without reaching for memory at all. That is I9: the catalog said
     "CALL it, do not read it" while the same prompt handed over 6,532
     characters of browsable index, so the shortcut won. Only removing the path
     can settle it. Notes remain reachable via `readNote`; what went is the
     list. The prose that told it to "skim the index below" went too — a
     dangling instruction is how a prompt decays into noise.
  2. **`module_calls`** — the per-call log. `module_use` is an upsert that
     overwrites `last_session`, so it could say `find` had been called 243 times
     and not whether the *day* called it once, nor which nodes any call touched.
     Three things wanted that same row: M4's measurement, I4's "every read is
     attributable" (its own stated test), and M3's overlay. The refs were
     already computed by `entityRefs()` and handed to `pulse`, which is
     explicitly lossy — its own comment says if a fact matters it belongs in a
     table, and it is not that table. Now it does.
  3. **`src/cycleCli.ts`** — a cycle is a day plus the night that folded it, and
     it needed no new concept: `dreams.covers_from`/`covers_to` already bound
     exactly that window, so every surface joins to it. Prints API callers split
     day/night, graph writes, inbox flow, focus changes, friction, and the union
     of nodes read or written — the **cycle footprint**, which is precisely the
     set an Atlas overlay lights up when a cycle is selected.
  **A test may no longer open the live database.** Building the above, running
  a single test file directly (no `DB_PATH`) put 80 fixture journal rows for
  `demo/alpha` and five `test:` call rows into the live memory; they were backed
  up and deleted by hand. `test/prepare.ts` refuses to *delete* the live DB
  (2026-08-02) but nothing stopped a test *writing* to it. `src/db.ts` now
  refuses to open it when `NODE_TEST_CONTEXT` is set — the runner sets it, the
  bot never does, so it is mechanism rather than a rule someone must remember
  (I9, I11). 202 green.
- **2026-08-05** — **The graph can be measured.** `modules/graph` — six
  read-only functions that answer questions about the GRAPH rather than about
  the work: `shape`, `domains`, `heavy`, `loose`, `similar`, `hierarchy`. Built
  as the first step of the graph-gardener idea (see *Ideas measured*), because
  I6's acceptance test is a number and no number existed. First run on the live
  graph, 157 entities / 234 authored edges:
  - **44% of authored edges are `relates-to`.** Nearly half the structure is
    "connected, unspecified". `personal`, `reference` and `reporting` are at
    100%. Density can be raised to any figure by adding vague edges, so this is
    the honesty check on any convergence claim.
  - **67 of 157 nodes (43%) have nothing pointing at them.** An agent navigates
    by following edges from something it already holds, so those nodes are
    effectively unreachable however good their content is. This is the number
    M4 should be judged against.
  - `similar()` ranked the known `ci-robustness-38` duplicate pair first (0.54),
    which is the detector earning its place — that pair was invisible to every
    per-node check. It also surfaced four `core-api/infra-*` nodes sharing one
    boilerplate sentence: an I1 violation, not a duplicate pair.
  - Hierarchy is healthy: depth 5, no cycles, no multi-parent. `core-api/monolith`
    carries 23 direct children — a list more than a hierarchy.
  Corrected while building: reachability measures first excluded derived edges,
  which reported `people/eleanora` as isolated while twenty `acted-by` edges
  pointed at it. Authored-structure measures exclude derived (I2); reachability
  measures must not — a derived edge is a real edge. 197 green.
- **2026-08-05** — **The graph can correct where a thing belongs, and one night
  runs at a time.** Mehdi reported that his 08-03 correction to
  `affiliate-app/northwind-payment-method-2297` ("this is Core-API work") had not
  taken. It had: the night of 08-04 diagnosed it exactly, could only leave a
  note, and wrote *"the record API has no domain-move op … flagging for a
  mechanism"*. Pulling that thread found four defects of one family — **the
  write path could change what an entity says and nothing else about it.**
  1. **No `move`.** A domain is the id's prefix, so "filed in the wrong place"
     was unwritable. Added: relocates the entity, drags every inbound edge
     across, carries the state and confirmation clocks (they are keyed by id and
     are *not* derived), and snapshots/rolls back every file it touches.
  2. **No `drop-edge`.** The graph could gain a wrong relation and never lose
     one, which made `move` half an op — the moved node kept `part-of` its old
     domain. Added as the `drop-fact` of edges.
  3. **The write path never re-rendered `_map.md`.** The briefing a reader
     actually reads is generated, and only the *prober* maintained it. So the
     08-04 correction of the paperwork vacancy landed in the entities while
     the map went on naming the dead "Software Engineer – Bioinformatics"
     draft. This is Mehdi's "I don't see any changes" — the changes were real
     and the view was stale. I2.
  4. **`entities.jsonl` accepted a record its own view rejects** — again. The
     comment recording that lesson sat six lines above the hole: the empty-chain
     rule ran only in the record grammar, so the 08-04 mints of
     `launchpad-check-qa-gate` and `ci-shared-evolution-gotcha` went in with no
     route back to the traces, the write guard passed, and the suite went red
     two parsers away. The rule now runs on the way in, `mint` refuses a
     chainless entity up front, and both rows were repaired from the provenance
     their own journal reasons recorded.
  Separately: **the nightly ran twice, concurrently** (dreams #52 and #53, both
  covering from `2026-08-04 00:30:30`). Both read `lastDreamCoveredTo` before
  either reached `saveDream`, so both built the same digest from the same
  *pending* inbox and folded it twice — `ci-robustness-38` minted under two ids,
  three observations written twice. The window and the inbox are only marked
  consumed at the END of a pass, so any overlap duplicates everything. A pass is
  not idempotent and cannot cheaply be made so, so `runRewrite` now refuses
  while another is in flight, loudly (I8 — a silently-dropped nightly is the
  failure the refusal must not become). **What fired the second invocation is
  still unidentified**; the guard makes it harmless, not explained. 195 green.
- **2026-08-02** — **A session records the world it was built in.** The worker
  strip shipped without answering what happens to the 49 sessions already
  stored, and the answer mattered within the hour: slot 46 held a 629k-token
  transcript full of calls to five tools that had just been deleted, assembled
  from surfaces the worker could no longer see. Resuming it would have paid full
  price to re-cache a history that then lies to the model about what it can do.
  `sessions` now carries the `contract` it was written under — a literal shape
  tag plus a hash of the tool list — and a session whose contract no longer
  matches is not resumed; it starts fresh from its brief. The tool list is
  hashed rather than described so that changing the tools IS the invalidation
  (I9). The id survives the refusal, so `locateThreadTrace` and `findPastWork`
  still read the transcript — history is kept, only continuation is refused.
  Found because the bot's `tsx watch` restarted on the strip commit and killed
  slot 46's in-flight turn silently: no usage row, no notice, and a concierge
  that went on telling Mehdi the worker was "actively running" for 34 minutes.
- **2026-08-02** — **A dispatched worker gets a box, and `visible` stops
  meaning two things.** `visible` had been overloaded into a false choice: a
  dispatched worker was either reported by the concierge OR shown to the user,
  never both, so background work ran completely dark. Split into `visible` (the
  turn owns a live box) and `background` (the concierge is woken at the end, and
  shouts if it gets stuck) — every worker turn now renders, and dispatch still
  reports. The box carries Stop while running and Continue/Recap once finished,
  both wired to functions that already existed; a worker's box is now the only
  handle the user has on it, since replies go to the concierge.
  Two bugs fell out of looking properly. Typing was chat-level and fired for any
  visible turn, so a background worker made the chat look like it was about to
  answer — it belongs to the concierge alone, which is the only thing the user
  is talking to. And `toKeyboard` returned `undefined` for an empty button list,
  which Telegram reads on edit as "keep the current keyboard": every finished
  box had kept a dead 🛑 Stop button that could only ever answer "Nothing
  running". An empty array now clears it.
  Cancels, timeouts and errors moved INTO the box as its closing headline
  instead of arriving as loose messages beside it — a failure detached from the
  thing that failed is how a run "ends" three messages above a box still saying
  Thinking.
- **2026-08-02** — **`readFocus`, and the gate that decides whether the
  injection can go.** I12 was fixed for the worker and left standing for the
  concierge, whose system prompt is rebuilt every turn at 61,205 chars (~15.3k
  tokens) — of which ~24k chars are volatile: the focus set (20,511 chars,
  rewritten by a probe sweep every 15 minutes), the attention set, the event
  feed. Result: 3.07M cache WRITES against 4.89M reads across 40 concierge calls
  in a day, roughly $19 of its $24. Mehdi's read of it was the right one and it
  is already in this document as **I7** — the set should be *retrievable*, not
  stapled to every prompt.
  Deliberately shipped as step ONE of two: the tool lands while the injection
  STAYS. Unlike a worker, the concierge acts on this set, so removing the
  surface and hoping the tool gets reached for would risk a concierge that
  quietly stops volunteering focus items — the exact failure the set exists to
  prevent. `audit` now carries a `focus re-reads` line that fires while
  `readFocus()` goes uncalled; step two is gated on it going quiet. The prompt
  labels the injected copy a SNAPSHOT and names what makes it stale.
  Adding the tool also proved the contract mechanism from earlier today without
  anyone doing anything: the concierge's tool hash changed, so its stored
  session stopped being resumable on its own.
- **2026-08-02** — **An interrupted turn now says so.** The other half of the
  above. Liveness lived only in memory, so a turn killed with its process left
  nothing: no result event, therefore no usage row, and badges rebuild from
  scratch, so after a restart an interrupted thread and an idle one are the same
  thread. `turns_running` holds a row from the moment a turn starts until it
  ends by ANY path, so a row that survives a restart is proof of a turn that did
  not. Boot reports them to the concierge as `[INTERRUPTED]`.
  It REPORTS rather than retries, and that asymmetry with `rearmWatches` is the
  design: a watch can be re-armed because `gh run watch` re-attaches and the
  external world holds the state, whereas a turn's work was half-applied to a
  working tree, so replaying its prompt could redo something destructive. The
  concierge is told to establish what landed from the WORLD — git, the PR, the
  tracker — because a turn can die after committing and before saying so, which
  is exactly what slot 46 did. Noticing is code; judging stays with the
  concierge.
  Also closed here: replying to a worker's message. Workers no longer send
  messages, but `message_routes` outlived the feature, so a reply to any old
  worker message would have opened a turn on a slot whose session no longer
  resumes — a brand-new empty worker, mid-task, with no memory of it. Replies
  now always reach the concierge.
- **2026-08-02** — **`jq: parse error` is not a state.** I3 was shipped on
  07-31 into the focus checker only; the prober kept the empty-output guard it
  already had, so an unanswerable probe still became truth on the graph side.
  Both paths now go through one `classifyCheck`, because the rule cannot hold on
  one path and not the other. The near-miss inside the fix is the part worth
  remembering: the list of "could not answer" shapes spelled out `jq: error`,
  which does not match `jq: parse error`, and three entities spent the day
  flapping `To Do → jq: parse error → To Do` (61 state changes, 551 the day
  before). jq is now matched by its `jq: ` prefix and Go's HTTP client by its
  `Post "https://…"` shape — a prefix is honest where an enumeration was never
  going to be complete. This matters twice over: `runCommand` ignores exit codes
  on purpose (a non-zero exit is a real answer from `gh pr checks` and `grep`),
  so this list is the *whole* gate; and every flip it lets through used to
  rewrite a system prompt and invalidate a cache prefix (**I12**).
  `syncStateIntoFiles` now also refreshes the `_map.md` it invalidates — a
  writer maintains its own views (I2), and not doing so turned an ordinary
  status flip into a red suite.
- **2026-08-02** — **The worker was stripped to a brief, and the bill halved
  itself.** The day's usage table read $116.89 across 61 calls, $86.42 of it in
  one worker session — against $1,313.89 for the trailing month. The shape was
  not "agents are expensive": 38 of the 61 calls did three turns or fewer and
  cost $45.93 between them, and the worker's transcript had grown 184k → 629k
  tokens over four days without ever rotating. The cause was that the injected
  context sat in the SYSTEM PROMPT, ahead of everything, and it moved — the
  focus set carried a wall-clock `checked <time>` per item, and the prober was
  writing probe *error text* into `state` and flipping it back (61 changes that
  day, 551 the day before). So every resume re-wrote the whole transcript to
  cache instead of reading it. Recorded as **I12**.
  The fix went past the symptom, per Mehdi: a worker now receives its BRIEF and
  nothing else — no root section, no focus set, no module catalog, no awareness
  feed — and has no tool to fetch any of them (`trackOpenLoop`,
  `noticeFocusChange`, `noteIdea`, `observe` and the module tools are gone from
  `buildWorkerServer`). It is execute-and-report; what its work leaves open goes
  in its final answer, and the **concierge** records it, which makes the
  concierge the single writer of the focus set as well as the single door. A
  worker also stopped being a voice in the chat: its output now folds into ONE
  message, edited in place (`LiveStatus.say`), so a long run is a line that
  keeps changing instead of a wall of narration to scroll past — and there is no
  worker message left to reply to, which retires reply-routing into a worker.
  The concierge's prompt was corrected in the same commit, since it still
  described the old machine in four places.
- **2026-08-02** — **The audit deleted the database it was auditing.** `.env`
  names the live DB in `DB_PATH`; `test/prepare.ts` deletes its destination and
  reads it from that variable; `npm test` set it only for the test run, not for
  prepare; M2's audit shelled out to `npm test` with the bot's environment.
  5,491 messages, 48 sessions, 48 dreams — recovered whole from a backup that
  existed only because M0 had needed one four minutes earlier. Fixed at three
  layers (prepare refuses, npm sets it, the audit scrubs it) and recorded as
  **I11**. The compounding failure was human: `openFriction()` was watched going
  12 rows → 0 → 1 and explained away as live churn, three hours before anyone
  looked. Also today: `src/auditCli.ts`, so the audit is a command and not only
  a line in a report nobody may read.
- **2026-08-02** — **The Atlas grew a settings panel and a real address bar.**
  Private domains keep their shape and lose their content (labels, hover,
  ticker text, modal — all four leaks closed); the view lives in the URL so
  back/forward are the browser's. `?moved` was tried and removed the same
  evening; the reason is in the ideas table and is worth more than the feature.
- **2026-08-02** — **M2 done, and M1 with it.** The night now folds the
  observation inbox as its first graph job, and opens on `src/audit.ts` — every
  health input reported whether or not it fired, before the empty-window skip so
  a quiet chat day cannot hide a broken machine. The third check outcome is
  recorded (`check_misses`) instead of only handled. The audit's first run found
  a flaky suite nobody had noticed: 14 racy `ADD COLUMN` migrations, now one
  tolerant `addColumn` plus a test that boots six processes at a fresh database.
  165 tests green.
- **2026-08-02** — **M1 capture.** The day's write path: `observe()` queues an
  observation with its refs resolved at the moment of seeing, so the night can
  compact a log instead of re-deriving a day. Unresolved refs are kept as the
  demand signal for new entities (I5). Inbox depth is surfaced, not just
  stored — the queue's failure mode is that nobody drains it. 164 tests green.
- **2026-08-02** — **M0 done.** `acted-by` derived from `actor` in `graphOf`
  (66 edges, 233 → 299), a `DERIVED_RELS` list that keeps it unwritable in the
  parser, the write op and the reformer's prompt at once, all eleven people
  hoisted into `people/` behind a lint, and the Atlas sky drawn around the
  heart. F2 resolved (folder). 156 tests green. M0's acceptance test amended —
  see the milestone.
- **2026-08-01** — Charter set down. Destination named (**the Colleague**), ten
  invariants recorded with the failure that bought each, four open shape forks
  identified (F1 multi-user is the largest unmade decision), milestones M0–M8
  with acceptance tests. Round 10's steps 1–2 (typed check result, `record()`)
  are landed; its step 3 becomes M2.
