# The Charter — the Colleague

_Set down 2026-08-01, from the round-10 architecture statement and the design pass
that followed it. This document fixes the destination. Rounds move toward it;
this does not move with them._

This file is what does not move: the destination, the invariants, the shape,
the milestones, and how to work against them. What moves lives beside it:
[DECISIONS.md](DECISIONS.md) — every idea measured, with its verdict;
[CHANGELOG.md](CHANGELOG.md) — one dated entry per step; `plans/` — the live
round's working plan; [history/](history/) — the design log and the plans of
landed rounds.

---

## The destination

> A colleague on a team — hired, not installed.
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

**I13 · An observer may not damage what it observes.** Health checks, audits,
snapshots and dashboards read; they do not write, delete, or reconfigure the
thing they are measuring. Any tool with a destructive step must verify its own
target rather than trust an ambient setting. _Bought by:_ M2's nightly audit
shelling out to `npm test`, whose snapshot step deleted its destination, whose
destination came from the environment, which in the bot named the LIVE database
— the night auditing its health destroyed 5,491 messages, recovered only from a
backup that existed by luck.
_Tested by:_ `test/prepare.ts` refuses when its destination resolves to its source.

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
brain, one focus set, one root. Bringing a second person in forces the question: does each
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

### Where it stands — 2026-11-16

Read from the machine (`auditCli`, `cycleCli`, `vitalsCli`), not from memory.
Re-read it the same way before trusting this table; replace it, dated, when a
row moves.

| | milestone | status | the number |
|---|---|---|---|
| M0 | The center | ✅ 2026-08-02 | one connected graph; `people/` hub |
| M1 | The inbox | ✅ 2026-08-02 | folded nightly; depth is a reported number |
| M2 | The night audits | ✅ 2026-08-02 | 18 audit inputs, every one reported; suite 647 green |
| M3 | Attention + backdoor | ◐ partial | reads are ref-tagged episodes; runs panel, live write halos, mode chip shipped. **Auth not started — gated on F1** |
| M4 | Focus as a reading plan | ⏳ **live, test not met** | the day reaches the graph on ~3–4% of questions; last full cycle `DAY 0 / NIGHT 20`; memory cue followed 2 of 7 |
| M5 | Convergence | ◐ mechanism landed | story tree + rendered behaviour shipped (round 11), but `root.md` is still ~10k chars and the most-read raw file (185 bypass rows) |
| M6 | Bounded memory | ◐ partial | dormancy, silence→park, W213 and rot are mechanisms; rot 275 and rising — not yet "denser, not larger" |
| M7 | The colleague | ◐ second transport in progress | round 12, the body (`plans/round-12-the-body.md`); F1 still open, multi-user not started |
| M8 | Self-extending | ⬜ | — |
| M9 | The graph answers | ⬜ gated on M4 | retrieval episodes logged since 2026-08-15; no restructure proposed yet |

**The reading.** Three months on, the number M4 turns on has not moved: the
night reads and writes the graph, the day mostly does not. Every mechanism
aimed at it has landed — the memory cue, the story push, the touch-watch —
and each made the gap *measurable* rather than smaller. Meanwhile the recent
rounds (the life page, the body) advanced M7 and the day's surface, not M4's
number. That is not wrong, but it is the thing to decide on purpose: either
the next steps go at the day's reach for memory directly, or M4's test is
amended to say what "reaching for memory" means once the story is pushed
rather than pulled. Cost belongs on the same line: a 7-day average of ~$140 a
day, most of it workers.

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
milestone, take it, and add a dated entry to [CHANGELOG.md](CHANGELOG.md). Small is the
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

An idea that survives all four gets a row in [DECISIONS.md](DECISIONS.md) and
enters a milestone. One that doesn't gets a row too, with the reason — a rejected idea with its reason
recorded is worth more than a forgotten one.
