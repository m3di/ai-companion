# Round 10 — one memory: the graph becomes the store

_Planned 2026-07-31 from three nights of live run data (2026-07-28 → 07-31), and
rewritten the same evening around the architecture Mehdi actually has in mind —
which turned out to be sharper than the one the evidence alone implied._

Round 9's plan said the night's audit should find what the day's friction
reveals. This pass is the human version of that audit, run once by hand, and it
found something the friction ledger could never have reported: **the ledger was
empty because nothing was calling the API at all.**

But the more useful output of the pass was not a finding. It was Mehdi stating
the target architecture out loud for the first time, in response to a stale fact
he spotted in the Atlas. That statement is now the top of this document, because
every finding below is a measurement of the distance to it.

---

## The target architecture

In Mehdi's words, condensed:

> Replace the md files with **graph read functions on top of graph data**.
>
> The **night agent** reads discomforts, errors, exceptions, skipped functions
> and direct graph-file reads; audits code + tests + build; updates `root.md` and
> the focus set — the day agent's consciousness.
>
> The **day** begins with a fresh `root.md` + what the graph is and how to use it
> (the read functions — call them; if one fails, report it; direct access is the
> fallback) + a focus set that says **which parts of the graph to fetch, why, and
> in what order.**

Three commitments follow from that, and they are the standard this round is
measured against.

### 1. The graph is the store. Prose is a view.

Not "the graph is also maintained" — the graph is where a fact lives, once.
Today the same five-name Core-API client list exists in **six live files** across
three domains, all of them wrong in the same way, because a fact has no single
home. Under this commitment that is impossible: one record, five renders.

**`root.md` stays markdown, and that is not an exception to the rule.** It is not
storage — it is the day agent's boot prompt, and prose is what an LLM boots from.
The change is that the night stops *authoring* it from memory and starts
*rendering* it from the graph. Everything else — `_map.md`, `index.md`,
`entities.md`, the depth notes — is generated or gone.

### 2. The night is an auditor, not just a writer.

Its inputs are the system's own discomfort: friction rows, unhandled exceptions,
skipped probes, blocked sweeps, raw tree reads, a red test suite, a failing
build. Today it reads none of these. It reads the day's *content* and rewrites
prose. A night that cannot see the machine limping cannot fix it, and three days
of a dead state layer is the proof.

### 3. The focus set is a reading plan, not just a work list.

Today the focus set answers "what is Mehdi waiting on". Mehdi's version also
answers "what should the day agent fetch, why, and in what order" — a ranked
pointer *into the graph*, carried in the opening context. This is the piece that
makes the read functions get called, because it names the call before the agent
has to think of it.

---

## Where we are against it

Measured, not estimated.

| the image | reality | gap |
|---|---|---|
| graph is the store | prose is the store; the graph is a write-once mirror | **the write path does not exist** |
| read functions on top | ✅ 10 documented functions, catalog injected everywhere | ❌ called 3 times ever, all on ship day |
| day boots on root + catalog + focus | ✅ already the shape (`concierge.ts:259–299`) | ⚠️ `notesIndex` sits beside the catalog as a shorter path |
| focus says what to fetch, why, in what order | ❌ does not exist in any form | new object |
| night reads friction / failures | ⚠️ collected since 2026-07-30; never read | one prompt section + one query |
| night audits code + tests + build | ❌ nothing | new pass |
| night writes the graph | ❌ no write function exists at all | **the hinge** |
| root.md rendered from the graph | ❌ authored from memory | last, after convergence |

**Everything marked ❌ is downstream of one thing.** A night that cannot write the
graph can only write prose; so prose stays the store; so the day reads prose; so
the API stays uncalled; so the friction ledger stays empty; so the night has
nothing to audit. `record()` is not step two of this round — it is the hinge the
whole picture turns on.

---

## What the run data actually says

Everything below is measured, not inferred. Dates are live.

### 1. The state layer was dead for three days, and the guard that detected it also prevented recovery

`entity_state.probed_at` stopped at **2026-07-28 22:18** and did not move again
until this pass. Every fifteen minutes for three days the log said:

```
[prober] skipping sweep — 1 lint error(s) in the entity graph
```

The full causal chain, because every link is a separate defect:

1. At 22:17:35 the probe for `client-onboarding/lumenlab-layer-c`
   (`fibery show Task 2601 … | jq -r .state`) **exited 0 and printed nothing** —
   a transient failure. Re-run today it returns `Done`, so the command was never
   wrong; the world was briefly unreachable.
2. The prober **wrote the empty string as that entity's state.** Absence of an
   answer was recorded as an answer.
3. The record file still said `Tested`. File vs. table now disagreed, which is
   a *fatal* lint error by design — the rule that keeps "only the prober writes
   state" true.
4. `sweepProbes()` refuses to run on a graph that fails lint. Correct in
   isolation.
5. **But the prober is the only thing that writes state back into the files.**
   The single mechanism that could restore agreement was disabled by the
   disagreement. A permanent deadlock, reachable from any interrupted sweep —
   a restart during a sweep is enough, and `tsx watch` restarts on every save.
6. Nobody was told. The escalation was a `console.warn`. The condition *was*
   surfaced into the concierge's focus block (`focusView.ts:148` withholds the
   derived focus and says why) — and it still sat for three days, because it was
   shown to an agent that has no tool to fix it.

Cost: 56 probes frozen, and when the sweep came back it immediately found **5
real changes, 4 of them status flips** — two Fibery tasks reaching `Done`, a PR
merging. Five entities had been silently closed for days. The graph was not
merely stale; it was confidently wrong, which is worse.

### 2. The same bug, one layer up: the focus checker cannot tell "changed" from "I failed"

`focus_changes` rows #32–#49 are not state transitions. They are outages:

| stored as the "state" of a focus item | what it actually was |
|---|---|
| `Post "https://api.github.com/graphql": dial tcp 10.10.34.35:443: i/o timeout` | a network blip |
| `jq: error (at <stdin>:1): Cannot index string with string "name"` | a malformed probe |
| `TRANSIENT` | the check's own "I could not answer" sentinel |
| `` (empty) | nothing at all |

Item #39 flapped `For Testing → TRANSIENT → For Testing` on consecutive hours.
Each flap queued a concierge pulse, and each flap burned down `NOISE_CAP` — so
the absorber then suppressed changes **because the checker was broken**, which is
precisely backwards: noise from a failing checker buys silence for the real
event. `|| echo TRANSIENT`, added to keep an empty answer from being read as a
change, converts every transient failure into a change instead.

The generalization, and it is the load-bearing conclusion of this pass:

> **A check has three outcomes, not two: a value, no answer, and a failure. Only
> a value may become state.** Anything that hashes a command's stdout and diffs
> it has silently merged the last two into the first.

### 3. The graph is write-once. Nothing ingests.

Between 2026-07-28 22:56 and this pass, `entities.jsonl` was not modified once —
across 303 Telegram messages, PR #150 merging after three review rounds, a
product hold from Nora on the Northwind epic, and the `media_partner_id` finding that
invalidated a whole runtime design.

All of it landed in prose. None of it reached the graph. The reason is in
`reformCli.ts`'s own doc comment: the reformer is deliberately a manual CLI,
"until the shape has been judged on real output." That was the right call in
round 8. Three days of live running is the judgment, and the verdict is that a
graph with no ingest path decays to a snapshot immediately.

Corollary: **97 of 153 entities have no probe at all.** "Each entity carries its
own clock" is true of 37% of the graph.

### 4. Two memories are running side by side, and only one is maintained

| | prose (rounds 5–7) | graph (rounds 8–9) |
|---|---|---|
| written by | the nightly operator, every night | a manual CLI, once |
| read by | every concierge + worker turn (root injected) | `mergedFocusLines`, one thin call |
| files | 29 depth notes + 17 `_map.md` | 10 `entities.jsonl` |
| last write | 2026-07-31 00:34 | 2026-07-28 22:56 |

`grep -n "entities\|loadGraph\|catalog\|friction\|module" src/operator.ts` returns
**nothing relevant**. The night rewrites root and maps; it does not know the
entity graph, the module API, or the friction ledger exist. Round 8 and round 9
built a memory the night cannot see and therefore cannot maintain.

This is not a missing feature. It is the reason findings 3, 5, 6 and 8 all exist.

### 5. The knowledge API has been called three times, ever — all on the day it shipped

`module_use` in full: two `evalInModule` expressions and one `find`, all between
20:35:55 and 20:35:57 on **2026-07-28**. Since then, across 303 messages: zero.
`friction` holds exactly one row, and its own `resolution` column says
`artifact of my own seeding test, not a real call`.

The catalog is not broken — it renders 10 documented functions in 1,899
characters and is injected into both the concierge prompt (`concierge.ts:283`)
and every worker brief (`dispatch.ts:204`). It is simply not being used.

Two mechanical causes, both fixable, and one that is not:

- **The biggest reader of the tree is not instrumented at all.** `noteToolCall`
  is wired only into the dispatch loop (`dispatch.ts:252`). The nightly operator
  runs its own `query()` (`operator.ts:759`) and reads the knowledge tree
  exhaustively every single night — the single richest source of bypass signal in
  the system, recorded nowhere. *(Fixed 2026-07-30; unread as of this writing.)*
- **Workers can't produce bypass rows by design.** They are told to use
  `recallNotes`/`readNote` (MCP tools), so their reads never look like a raw
  `Read` of `data/knowledge`. The detector watches a door nobody uses.
- **The API answers questions about a graph that was three days stale.** An agent
  that called `openLoops()` last week would have been told about entities that
  had already closed. Round 9's premise — no friction means the code is good —
  cannot distinguish "good" from "nobody called it", and this pass shows the
  system sitting in the second case while reporting the first.

### 6. Three smaller findings, each with a live cost

- **`root.md` has been over budget for at least four consecutive nights** (dreams
  #39, #40, #46, #47; measured 10,129 / 10,000 chars). The operator flags it
  every night and re-trims it every night. The truncation drops the **tail**, and
  the tail is `## Now` — so the cap silently removes the single most current
  section from every concierge turn. The section that should be protected is the
  one being cut.
- **One grammar, two rule sets.** `dormant` + `actor` is fatal in the restricted
  `.md` grammar and was silently legal in the `.jsonl` parser, so
  `ops-tool/pr-10-review-threads` sat in the tree lint-clean while the
  round-trip test went red — the failure surfaced two parsers away from its cause.
- **A generator was one command away from destroying authored content.**
  `noteIdea` (round 5, live in the concierge and every worker) appends dated
  `## Open possibilities` lines to `_map.md`; round 8 made `_map.md` a generated
  view whose header says "Edits here are overwritten"; `renderMap()` did not
  carry the section. The documented cure for a stale view —
  `reformCli.ts --render` — would have deleted four of Mehdi's 2026-07-28
  video-pipeline ideas. The operator's own prompt still instructs it to curate a
  section living in a file the graph regenerates.

### 7. What worked

Worth recording, because it is the argument for the mechanical-over-instruction
rule holding a second time:

- **The lint caught the corruption instantly**, refused to build on it, and named
  the file, the line and the entity. Its blast radius was wrong; its judgment was
  not.
- **`npm test` went red at the same moment and for the same reason** (the golden
  load asserts the real tree lints clean). Round 9's "tests as a hard
  precondition" earned itself here — the suite was the only thing that stated the
  problem in a form a human could act on.
- **The nightly operator's reports are genuinely good.** Dream #47 correctly
  ranked the day, distinguished a product hold from a QA gate, re-tiered a merged
  PR off Mehdi's ball, and declined to invent focus items for follow-ups that
  were downstream of an unanswered question. The night's *judgment* is not the
  problem. Its *reach* is.

### 8. A fact in `facts[]` is immortal, and the day has a shorter path than the API

Found by Mehdi in the Atlas, 2026-07-31, and the reason this document was
rewritten. `reference/repos-and-platforms` states:

> Core-API is the legacy Scala + Play monolith hosting network clients Tailspin,
> Wingwallet, Lumenlab, Fabrikam, Adatum

The real list is **contoso, litware, proseware, northwind**. Not one name
survives. Two things about that:

- **Nothing in the system could ever have corrected it.** The prober writes only
  `state`; `facts[]` is in the never-perishes half by design. The focus checker
  works on commitments. The operator does not open `entities.jsonl`. There is no
  path — the fact would still be there in a year.
- **The same wrong list is in six live files** (`root.md:38`, `core-api/_map.md`,
  and the `entities.{jsonl,md}` pairs in `reference`, `core-api` and
  `client-onboarding`). Correcting it is not one edit, and no single edit is
  authoritative over the others.

It was found **in the Atlas and nowhere else**, after sitting in `root.md` — the
most-read text in the system — for weeks. Isolating a fact is what makes it
inspectable; embedding it in a paragraph is what makes it invisible.

And the second half of the finding, from re-reading the concierge's context: the
day's opening prompt is *already* root + catalog + focus, close to the target
shape. But `notesIndex` — the tree index with `readNote(key)` — is injected right
beside the catalog. The day doesn't ignore the API because the API is bad. It
ignores it because there is a shorter path in the same context window, and a
markdown file needs no argument.

---

## Fixes applied in this pass

All landed, `npm run typecheck` clean, `npm test` **132/132 green** (was 125/130).
Backup at `data/backups/2026-07-31-pre-render/`.

1. **`prober.ts` — an empty probe result is not a state.** Treated exactly like a
   failure to run: touch the clock, leave the last real state standing. This is
   the root cause of the three-day outage.
2. **`prober.ts` — the deadlock is now self-healing.** `Diagnostic` gained a
   machine-readable `code`; when *every* lint error is `state-drift` (file and
   probe table disagree), the sweep repairs the files from the table — which the
   DB is already declared the authority for — and re-loads. Any other error class
   still waits for an author.
3. **`prober.ts` — a halted sweep reaches a person.** After four consecutive
   blocked sweeps (~1h) it posts an event naming the hours lost and the first
   error, and repeats hourly while broken; it logs a resume line when it clears.
4. **`focus.ts` — an unanswerable check is not a change.** Empty output, the
   `TRANSIENT` sentinel, and the network/parse failures the ledger actually
   produced (`dial tcp`, `i/o timeout`, `jq: error`, connection reset, DNS, TLS
   timeout) are classified as *no answer*: touch the clock, escalate nothing.
   Verified against all nine real strings from `focus_changes` — the three
   non-answers classify as unanswered, all six real states pass through.
5. **`entities.ts` — one grammar, one rule set.** The `.jsonl` parser now
   enforces the `dormant`+`actor` exclusion its own generated view enforces.
6. **`simplify.ts` — a generator may not destroy what it does not own.**
   `renderMap()` carries the existing `## Open possibilities` section through.
7. **`moduleHost.ts` — results larger than the 64KB stdout pipe no longer
   truncate** (`process.exit` after an async write); `RAW_CEILING` split from
   `RESULT_CAP` so an oversized answer truncates for the agent instead of
   failing as a corrupt envelope. Two tests.
8. **The operator is instrumented.** Its tool stream now routes through
   `noteToolCall`, so the system's heaviest tree-reader finally produces bypass
   signal.
9. **Data repairs:** cleared the corrupt empty state row; dropped `actor` from
   the closed-and-dormant `ops-tool/pr-10-review-threads`; re-rendered all ten
   domains' views (now current, ideas intact).

Effect within minutes of landing: all 56 probes ran, **5 changes / 4 status
flips** recovered, closed entities 26 → 31.

**Also shipped ahead of schedule:** the Atlas
(`docs/plans/atlas-visualization.md`) — the live graph view, reading exclusively
through `callModule`. It was meant to be step 6 of this round. It became step 0
by accident, and immediately earned itself by surfacing finding 8.

---

## The target shape

### The graph

**The night must write it.** This is the round, and everything else is detail.
The reformer stays the expensive whole-domain rewrite; what is missing is the
cheap incremental path — the operator already extracts exactly the right material
every night (dream #47 names a merged PR, a product hold, a resolved semantic
question) and has nowhere to put it.

- **`record(observation)` — the first WRITE function in the catalog.** The night
  appends a typed observation to an entity, or mints one, through the module API,
  never by editing files. This is what makes the API the path of least resistance
  for the one agent that reads memory hardest.
- **`state` gains a source.** Today `state` means "what the probe saw" and only
  the prober may write it, which is why an *observed* fact has no home and lands
  in prose. Split it: `state` (probe-owned, mechanical, unchanged) and
  `observed` (night-owned, dated, evidence-linked). The lint rule keeping authors
  out of `state` survives intact — it is the rule that caught this pass's
  corruption — and the night stops needing to violate it.
- **`facts[]` gains provenance.** A fact is currently a bare string with no age,
  so "stale" is not even expressible (finding 8). Each fact carries `since` and
  `last_confirmed`. This is the precondition for both mechanisms below.
- **A probe result becomes typed** — `{ value } | { unanswered } | { failed }` —
  in one shared helper for the prober and the focus checker, replacing the two
  string-hashing paths that each independently merged the three cases. Fixes 1
  and 4 above are the behaviour; this is the shape that stops it recurring.
- **`opened_at`, with provenance.** Still the gap round 9 left deliberately
  undone (`firstSeen`) — and the wrong answer that earned it is still reachable.
- **Probe coverage is a measured property.** 97 unprobed entities is either fine
  (they are timeless facts) or a hole (they are tasks nobody is watching); today
  nothing can tell you which. `stats()` should say.
- **One tree, not two.** 29 depth notes and 17 maps beside 10 data files. The end
  state is that `_map.md` is purely generated (ideas having become records),
  depth notes are either entities or gone, and `root.md` is *rendered* from the
  graph rather than authored. That last one is the completion of commitment 1 and
  the last thing to land.

**How a stale fact gets corrected.** Two mechanisms, because there are two kinds
of staleness, and they need opposite triggers:

- **Contradiction — for facts the day's work touches.** The night reads the graph
  for every domain it touched *before* it writes prose, and where the day's
  material disagrees with a stored fact (a different count, a name not in the
  list, a state that cannot also be true) it records the contradiction instead of
  silently preferring either. This is not a subsystem — it is three sentences in
  the operator prompt, and it comes free the moment the night can read and write.
  Mehdi's framing: distill says "11 clients", the graph says 8, and the night
  stops and asks why it is unaware of three.
- **Age — for facts nothing ever touches.** Nothing in a day's work mentions
  Core-API's client list, so no contradiction ever fires and it never gets
  checked. For those, surface by age: a fact past N months that no night has
  confirmed gets raised **to Mehdi**, one per night, as "still true?". That is
  not the machine discovering it — it is the machine admitting what it has not
  looked at, which is cheaper and more honest than pretending it could.

*Rejected: a standing per-domain question list.* It was the first shape
considered and it rots the same way facts do — twelve questions per domain
re-read nightly, answered "no change", burning exactly the kind of budget the
focus absorber's noise cap already showed goes bad. A question that cannot be
answered from what happened tonight should not cost anything tonight. Triggers
beat schedules.

### The API

Growth stays demand-driven, but demand has to be *observable* first:

- **~~Instrument the operator~~** ✅ shipped 2026-07-30. One night of the
  operator's reads is worth more bypass signal than a week of worker traffic.
  **Now the night has to read that ledger** — it currently writes to a file
  nobody opens.
- **Record absence as a signal.** A day with zero `module_use` rows is data, and
  right now it is indistinguishable from no data. The nightly should see "the API
  was not called yesterday" as a finding about the API, not silence about it.
- **`record(observation)`** — the write path above. The first function that makes
  the night a *client* rather than a bystander.
- **Retire `notesIndex` from the day's context** (finding 8), or demote it to
  a fallback the catalog explicitly names. As long as a shorter path than the API
  is injected beside the API, the call counts stay at three. This is the cheapest
  single lever on API adoption in the whole round and it is a deletion.
- **`graph()`, `neighbours(ref)`, `stats(ref)`** ✅ — earned by the Atlas, which
  reads through this API and nothing else, so its gaps land in the friction
  ledger like any agent's.
- **`firstSeen(ref)`** — still unbuilt, still earned.

Silent substitution — the concierge confidently hand-rolling a wrong answer
rather than failing — remains only half-solved, exactly as round 9's plan said.
`module_use` catches it when the API is used at all; it caught nothing here
because the API was not used at all.

### The night's audit pass

New in this rewrite, and absent from the system entirely. The night's first act
should be to read the machine's own discomfort, before it reads a word of the
day's content:

| input | exists? | today |
|---|---|---|
| friction ledger (bypass rows, `module_use`) | ✅ | written, never read |
| blocked/halted prober sweeps | ✅ | an event since 2026-07-30 |
| unanswered/failed checks (focus + probe) | ✅ | classified since 2026-07-30, not aggregated |
| entities with no probe / a stale clock | ⚠️ | derivable, not surfaced |
| `npm test` | ❌ | red for three days with nobody told |
| `npm run typecheck` / build | ❌ | — |
| unhandled exceptions in the bot process | ❌ | `console.warn` |

The rule: **each of these gets a line in the night's report whether or not it
found anything**, because "nothing to report" and "nobody looked" are the exact
pair this whole round exists to separate. A failure the night finds in code,
tests or build escalates the way a proposal does — the operator cannot change the
bot's own code, so it queues, and Mehdi sees it in the morning.

### The focus set as a reading plan

Also new. Today the focus set is a ranked list of open work with `checkCmd`s —
the attention spine, and it works. Mehdi's version adds a second axis: for each
item, **which entities to fetch, why, and in what order.**

The mechanism is nearly free, because the graph already knows: a focus item that
is a watched commitment usually corresponds to an entity, and `neighbours(ref)`
already returns its immediate shape. What is missing is that the day's opening
context says *fetch these, in this order, for this reason* rather than leaving
the agent to notice a catalog and think of a call unprompted.

This is the answer to "why is the API never called" that is not a deletion. The
deletion (`notesIndex`) removes the shorter path; this one supplies the reason.
Both are needed, and this one should be measured: if API calls do not rise after
it lands, the problem is not the prompt and the whole demand-driven premise needs
re-examining.

### The tests

The suite is the reason this pass had ground truth, and it should be extended
along the axis that actually failed:

- **A check-contract test.** A command that fails, times out, or returns nothing
  must never produce a state change or a focus escalation — asserted against the
  real strings from `focus_changes`, which are now a fixture rather than an
  anecdote.
- **A recovery test.** Corrupt the state table, run a sweep, assert the graph is
  lint-clean afterwards. The three-day outage was a *recovery* failure, not a
  detection failure, and nothing tested recovery.
- **A liveness assertion.** No entity's `probed_at` older than N hours while its
  probe is allowlisted; no focus item unchecked for N hours. A frozen layer
  should be a red test, not a log line.
- **A single-home assertion.** No fact string duplicated across domains — the
  mechanical form of commitment 1, and the thing that would have caught finding 8
  the day the second copy appeared.
- **Run it where a human sees it.** The suite went red on 2026-07-28 and stayed
  red for three days. Part of the audit pass above.

---

## Sequence

1. **Typed check result**, shared by the prober and the focus checker. Fixes 1
   and 4 collapse into it; the check-contract and recovery tests land with it.
2. **`observed` on the entity, `since`/`last_confirmed` on facts, and
   `record()` in the module API.** The write path. **This is the hinge — nothing
   below is reachable without it.**
3. **Wire the night to the graph** — the operator reads via `callModule`, writes
   via `record()`, and gains the contradiction rule. This is the round's centre:
   after it, the graph is maintained by the same loop that maintains root.
4. **The audit pass** — friction, failures, tests, build, coverage; every input
   reported whether or not it fired.
5. **Delete `notesIndex` from the day's context, and give the focus set its
   reading plan.** The two halves of API adoption, landed together so the effect
   is measurable against a single before/after.
6. **Liveness + escalation**: probe clock, focus clock and suite all report to
   the morning brief.
7. **Root cap protects `## Now`** instead of truncating it — small, four nights
   overdue.
8. **Age-based fact review** — one "still true?" per night, once facts have
   provenance.
9. **Then converge the two trees** — ideas become records, depth notes become
   entities, `_map.md` becomes purely generated, and finally `root.md` becomes a
   *render* of the graph rather than an authored document. That last step is
   commitment 1 completed, and it is the end of round 10.

Step 2 is the hinge, step 3 is the round. Steps 1 exists to make it safe, 4–6 to
make its failures audible, and 9 is what "one memory" actually means.

~~Step: the Atlas~~ — done, ahead of schedule, and it paid for itself before the
round started.

---

## The lesson, stated mechanically

Round 8's lesson was *if it must hold, it cannot be an instruction*. This pass
adds its complement, and every finding above is an instance:

> **A layer that cannot be seen failing will fail silently, and the check that
> detects a fault must never be the thing that blocks its repair.**

The prober detected corruption and thereby prevented its own recovery. The focus
absorber detected noise and thereby suppressed signal. The friction ledger
detected nothing and thereby reported health. The root cap detected an overflow
and cut the newest section. In every case the mechanism was right and its failure
mode was invisible.

And the rewrite adds a third, from finding 8:

> **A fact that lives in six places is maintained in none. Nothing gets corrected
> until something is authoritative.**
