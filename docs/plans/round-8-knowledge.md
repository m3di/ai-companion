# Round 8 — knowledge as a formal entity graph; focus as a view over it

_Planned 2026-07-28. Mehdi's ask: "knowledge should be timeless and only about
discovered entities and activities — the quickest way to connect to the chain,
read a story and find the latest state. Focus is the active list of these leads.
We might lose something from the focus list but we can always pick up a fresh
thread from the knowledge index of entities, which itself is timeless but its
entities have time and a separate, self-sustained, self-growing state … it could
even have a formal language, like the algorithmic description in papers, so we
can apply simplification rules that flatten the problems."_

## The finding that shapes this round

Round 7's addendum tightened the note diet with a *writing rule* ("would this
sentence still be true after the PR merges?"). A rule is not a reform: nothing
validates it, nothing can be computed over its output, and it decayed the same
way the previous mandate did. The evidence is `personal/_map.md`, written under
the current regime:

> **sideapp** = a personal side project, now SUNSETTING (~1mo left, then
> intentional archive; the 07-19 stalled deploy + 3,300-row avatar cleanup
> dropped, watch #25 closed 07-24). Two apps (sideapp1 Laravel, sideapp2
> Laravel+Quasar), historic DB on server.example … Dig: [[personal/sideapp-sunset]]

One paragraph fusing a timeless identity, volatile state, a dead ledger
reference and retrieval anchors. Nothing here can be flattened, queried, probed,
or invalidated when watch #25 closed. **Prose cannot be simplified — only a
typed graph can.**

The second finding is from round 7 itself: the deterministic checker
(`check_cmd` → scrub → hash → diff) is the right mechanism attached to the wrong
object. It was bolted onto *commitments*. Self-sustaining state is a property of
the **entity**, and focus is what you get when you *ask the entity graph what is
open*.

## The principle

> Knowledge is a timeless index of entities. Each entity carries its own clock.
> Focus is a QUERY over that index, not a second ledger — losing it is a cache
> miss, never a data loss. Prose is unsimplifiable; the formal part must be
> machine-checked or it is prose with colons.

## Design

### 1. The unit: an entity record

One file per DOMAIN — `<domain>/entities.md`, a multi-document YAML stream —
not one file per entity (the tree would explode from ~25 files to several
hundred, and the reformer's natural unit of work is a whole domain anyway).

```yaml
---
id:    affiliate-app/tracker-code-uniqueness   # timeless, stable, never rewritten
kind:  constraint        # system|component|constraint|task|pr|person|process|step|decision|project
aka:   ["#2830", "tracker_code unique", "CSV reuse across clients"]
facts:                   # TIMELESS ONLY — the validator rejects dates and status words
  - tracker_code is globally unique across clients
  - "=> generated tracker CSVs cannot be reused per client"
edges:
  blocks:     [affiliate-app/csv-import]
  tracked-by: [fibery/task-2830]
  found-in:   [affiliate-app/import-page]
probe: ~/Projects/brain-fibery/scripts/fibery show Task 2830 --json | jq -r .state
state: Idea              # WRITTEN BY THE PROBER, never by hand
state_at: 2026-07-28T18:24Z
chain: [msg#4908, episode#2347, "affiliate-app:vue/src/import.ts:61"]
---
```

The three-way split is a field split:

| field | Mehdi's phrasing | perishes? |
|---|---|---|
| `id` · `kind` · `aka` · `facts` | "timeless … discovered entities" | never |
| `probe` · `state` · `state_at` | "entities have time and a separate, self-sustained, self-growing state" | continuously, by itself |
| `chain` · `edges` | "quickest way to connect to the chain and read a story" | never (anchors are append-only) |

A short prose body may follow the frontmatter for what genuinely doesn't fit —
it is NOT where state goes.

**Depth notes survive unchanged** as prose files: cold-operational content
(access paths, exact commands, a dangerous mechanism + verify steps) is not
graph-shaped and should not be forced into one.

### 2. `_map.md` becomes GENERATED

Like `index.md` already is. The operator authors records; the renderer emits the
briefing from the simplified graph. This is what makes the formality load-bearing
rather than decorative — a human-readable map that cannot drift from the graph
because it *is* the graph.

### 3. The flow layer — only where a domain really is a process

Decided 2026-07-28 (hybrid): every domain gets the graph; **process-shaped**
domains (paperwork, client-onboarding) additionally carry one guarded flow
block over their own entity ids. `core-api` and `reference` are inventories and
get no flow — forcing algorithm syntax onto a roster produces fiction.

```
flow paperwork/permit:
  posting  <- [certificates.legalized, nora.approves-terms]
  permit   <- [posting.published + 30d]
  ? certificates.state == in-transit  => BLOCKED until ~mid-Aug
  goal: permit.issued
```

Every identifier must resolve to an entity id in the same domain — that is a
validator rule, and it is what keeps the flow honest.

### 4. The teeth: parser + validator (`src/entities.ts`)

**This is the deliverable. Without it the round is another stricter prompt.**
Files are the source of truth (authored, git-diffable, survivable); a SQLite
table is a DERIVED index rebuilt on every parse, so graph queries are SQL.

Lint rules, all fatal:
- `id` unique tree-wide; `kind` from the closed set; `edges` targets resolve
- `facts` entries contain no date, no status word (`filed`, `not done`, `next
  step`, `waiting`, `merged`, `closed`, `WIP`, `~N days`) — the temporal test,
  now enforced instead of requested
- `state` may not be hand-edited: the writer sets `probe`, the prober sets
  `state`/`state_at` (diff detects hand-edits and rejects them)
- every entity has a non-empty `chain` — an entity with no route back to the
  traces is a dead end
- flow identifiers resolve; the flow is acyclic

### 5. Simplification (`src/simplify.ts`) — cheap, provable, code

Rewrites over the typed DAG. Nothing here is a judgment call:
- **transitive reduction** — drop `A→C` when `A→B→C`
- **collapse resolved chains** — a run of closed entities blocking nothing folds
  to one `done` node
- **prune** closed entities with no open dependents (they stay in the file; they
  leave the rendered map)
- **critical path** — longest open chain to a `goal` node. `paperwork/_map.md`
  maintains "the ONE critical path" BY HAND today; this computes it.
- **merge candidates** — identical edge sets + overlapping `aka` → flag for the
  reformer (never auto-merge; identity is the one thing worth a human-ish call)

### 6. Focus becomes a projection

Round 7's stored tier (`commitments.focus` / `focus_band`) retires to an
*override*. The set is DERIVED from the graph each time it is surfaced:

| tier | derivation |
|---|---|
| 1 | open · every blocking edge resolved · Mehdi is the actor |
| 2 | open · blocked on a named person or event |
| 3 | open · on no active path to any goal |

This is a stronger answer to "the system decides how many tiers" than round 7's:
the count follows the **graph's shape**, not the concierge's taste. It also
makes Mehdi's recovery property literally true — a lost focus item is a
re-run of a query.

Consequence: round 7's intake plumbing collapses into ONE rule. A session that
opens something **mints an entity**; appearing in focus follows for free.
`trackOpenLoop` becomes `mintEntity`. Time-based commitments (reminders, the
morning brief, recurring routines) stay exactly as they are — they are promises
to the future self, not entities, and this round does not touch them.

### 7. The reformer (`src/reform.ts`) — "a mechanism to put it in shape"

Mehdi's spec, taken literally: *read each domain entirely, read all retrievable
resources and entities — messages, episodes, workers — then write the formal
shape.*

One domain per nightly pass, round-robin, resumable:
1. Read the domain's every file, plus its `_map.md` leads.
2. Pull all evidence that mentions it: `searchMessages` over each entity's `aka`,
   episodes whose project maps to the domain, worker traces from its threads.
3. Resolve identity FIRST (existing ids + `aka`) — mint nothing that already
   exists under another name.
4. Emit the whole `entities.md`, plus a flow block if the domain is a process.
5. Parse + lint. **On any fatal error the write is rejected and retried once
   with the errors**; a domain that fails twice keeps its previous file.
6. Re-render `_map.md` from the simplified graph.

Bounded on purpose: one domain a night is ~11 nights for a full sweep, and the
cost lands on the domain the evidence actually moved.

### 8. Migration

Additive and reversible. The existing tree stays until a domain is reformed —
`_map.md` prose remains authoritative for un-reformed domains, so the system
never has a gap. `affiliate-app` goes first (it has the most notes and the
`tracker_code` case that started this), paperwork second (the reference shape,
and the only real process). No big-bang `/defrag`.

## What building it changed (2026-07-28)

Three corrections, all of them found by running against the real tree rather
than by reasoning about it.

### 1. "Timeless" is a permanence test, not a keyword test

The first cut of the linter rejected any fact containing a date or a status
word. It cried wolf immediately on rules that merely *mention* status —
"publishing the vacancy starts the statutory WAITING window", "must stay OPEN
for a fixed period" — and a validator with false positives trains the writer to
fight it, which is worse than no validator.

Fixing that was not enough. Two full reform runs then died on:

- `report_ingest_mode was dropped, replaced by a ClientReport enum`
- `shipped in PR #91, merged to main by alizshow 2026-07-05`
- `Fibery epic #2772, Hard, authored by Mehdi, created 2026-07-20`

Every one is **permanently true**. The rule was wrong, not the draft. The real
test is **"could this sentence ever become FALSE?"** — a completed past event
never can, a present-tense status can. So past tense passes, absolute dates pass
(they are anchors), and what fails is time measured FROM NOW: "~3 weeks left",
"2 days ago", "next week".

The lesson for the round: **the grammar is the easy part; the semantics of
"timeless" is the hard part, and it can only be calibrated against real
knowledge.** Both corrections came from evidence, neither from design.

### 2. Evidence resolution is not free

Episodes are keyed by project directory (`affiliate-app`, `Core-API`), which is not
the vocabulary a knowledge domain uses. The first implementation matched the
domain's search terms directly, found ZERO sessions for every domain, and the
reformer silently ran on prose alone — the exact blindness it exists to fix. A
reform that reads only the prose it is replacing cannot recover anything the
prose dropped, which is most of the point.

Watch for the same class of bug in message search: `config.allowedChatIds` is a
`Set`, and indexing it returned `undefined`.

### 3. Migration ORDER matters — leaves before hubs

`personal` failed with four of its six errors being edges into `paperwork`,
`core-api`, `affiliate-app` and `fibery` — it is the hub domain, and it genuinely
relates to everything. A domain reformed while its neighbours are still prose
has nothing legal to point at, so it either invents dangling ids or loses the
relationship.

So the migration runs **leaf domains first, hubs last**, and each pass feeds the
already-reformed entity ids forward (`reformCli` does this for `--live` runs) so
a later domain can link to an earlier one for real. On this tree that means
roughly: `core-api`, `launchpad`, `fibery`, `reference` → `affiliate-app`,
`ops-tool`, `client-onboarding`, `reporting` → `paperwork` → `personal`.

Until a neighbour exists, the rule is: relate through `note` or `chain`, never
through an invented edge.

### 4. Repair, don't regenerate

The first retry design re-asked for the whole file with the diagnostics
appended. It did not converge — a real run went **25 errors → 4 → 14**, because
regenerating sixty records to fix four rewrites the fifty-six that were already
right. Retries now send only the failing records and splice corrections back by
id, so passing records are untouched and each pass can only improve.

The same run then went 25 → 5 → 6 → **clean**, at a third of the cost
($0.88 vs $2.43) and a third of the time (270s vs 778s).

### 5. Cost, and what it implies for the migration

~$1.40 and ~7 minutes per domain, 25→2 lint errors across attempts. Eleven
domains ≈ $15 and ~1.5 hours. That is cheap as a one-time migration and far too
expensive to run on a schedule — which confirms one domain per nightly pass, and
confirms that the reform must stay an explicit operation (`reformCli.ts` refuses
to run without `--out` or `--live`) rather than something the nightly discovers
it can do.

Drafts converge fast (25 → 2), so the attempt budget is 3: a 60-record domain
dying on its last two lines throws away a pass that was nearly right.

## Explicitly NOT doing

- **One file per entity.** File count would 10× for no gain; the reformer's unit
  of work is a domain.
- **Auto-merging entities.** Identity resolution is where a wrong call silently
  destroys a distinct thing. Flag, never merge.
- **Full flowcode (control flow, loops, partial evaluation).** Considered and
  rejected 2026-07-28: most domains are inventories, not algorithms, and an LLM
  writing valid procedural code every night is a losing bet. Guarded dependency
  flow gets the critical path — which is the only thing the flow was for.
- **Retiring prose depth notes.** Cold-operational content is not graph-shaped.
- **Replacing the traces.** The graph indexes messages, episodes and transcripts;
  it never copies them. §3.9's ladder is unchanged.
