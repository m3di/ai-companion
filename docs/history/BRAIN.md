# The brain — memory, attention, and the nightly loop

> A living design doc, sibling to [ROADMAP.md](ROADMAP.md). It captures **why**
> we redesign the dream/grow/knowledge system: what the data showed, the framing
> we chose, the proposals on the table, and the decisions as we make them.
> Started 2026-07-04 from a design discussion; update it whenever a decision
> lands or a mechanism changes.

---

## 1. What the data actually shows (2026-07-04 audit)

Grounded in the live database (2,518 messages over ~4 weeks, 28 threads,
15 dreams, 1 grow, 30 knowledge notes):

1. **Dreams are good. Nothing consumes them.** The dream reports are genuinely
   insightful — they catch stale memos, contradictory shared memory, missing
   knowledge notes, morning priorities, and concrete code fixes. But dream is
   read-only and its only consumer (`grow`) has been run **once, on June 21**.
   11 dreams sit unprocessed. Result: the same problems get re-flagged night
   after night — e.g. the *"WingWallet prod admin baseline"* contradiction in
   shared memory was flagged in dream #11 **and again** in dream #14, and is
   *still* wrong in shared memory today. The flywheel is drawn as a loop but
   runs as an open pipe.

2. **Dream output is prose addressed to nobody.** A typical dream contains ~5
   ranked items of ~4 different kinds: memory fixes, missing knowledge, morning
   reminders, code/prompt proposals. Each kind has a different natural actuator
   (grow / grow / the morning concierge / the operator), but the report is one
   markdown blob, so every item's fate is "hope somebody reads it."

3. **The knowledge base is a flat list that navigates by filename.** 30 notes,
   heavily work-dominated (BA), navigable only via one-line summaries in
   `index.md`. Quality per-note is decent; there's no topology — no grouping,
   no levels, no "map of what I know." At 30 notes it's readable; at 100 it
   won't be.

4. **Shared memory is silting up.** It's specced as "small, always-on
   preferences" but already carries per-topic state blocks (Lumenlab
   bring-up, job-posting saga) that belong in notes — exactly what dream #11
   said. Because it's injected into *every* worker turn, its noise is a tax on
   every context.

5. **Workers are blind to each other.** A worker turn gets: shared memory +
   repo context + its own history + on-demand `recallNotes`. It does **not**
   see what other threads exist, what they did today, or what the user was
   just told elsewhere. The concierge sees the thread index; workers see
   nothing. This is the direct cause of "different contexts are confused about
   what I'm talking about."

6. **Nothing watches the clock.** Pending items (a PR waiting on alizshow, a
   task waiting on Sasha QA, a certificate clock) live inside thread recaps and
   dream prose. No mechanism re-checks them or notifies — the user is the
   scheduler.

---

## 2. Framing: one organism, four memory layers

The guiding decision (2026-07-04): stop treating dream/grow/notes/shared-memory
as separate features and treat the system as **one organism with a layered
memory**, where every mechanism is a read or write path between layers:

| Layer | Holds | Today | Analogy |
|---|---|---|---|
| **Working memory** | a worker/concierge session context | sessions table | what you're focused on now |
| **Awareness** | what's happening across the system *today* | recaps (concierge-only) | ambient awareness of the room |
| **Long-term memory** | curated knowledge tree | `knowledge/` (flat) | what you know |
| **Consolidation** | the nightly transform between them | dream (read-only) + grow (never run) | sleep |

Design rules that fall out of this framing:

- **Localized attention, shared awareness.** A context stays focused on its
  task (working memory) but always carries a *cheap, compact* picture of the
  rest (awareness). Confusion is an awareness failure, not a routing failure.
- **Consolidation must act, not advise.** Sleep that only writes a diary entry
  isn't consolidation. The nightly pass must *apply* the mechanical part of
  what it concludes.
- **Structure is emergent, mandate is explicit.** We never hardcode the
  knowledge taxonomy (a doctor's bot should grow a different tree than a
  dev's) — but we explicitly give the consolidator the *mandate and the
  primitives* (folders, moves, merges) to grow one.
- **Fresh contexts are a feature.** Any agent should be able to cold-start
  from the knowledge tree alone and reach competence quickly (human
  short-term memory refreshes; long-term memory reloads it). This makes
  knowledge quality *testable* (see §3.7).

---

## 3. Proposals

### 3.1 Close the loop: one nightly pipeline, typed dream output  ★ first

**Problem:** observations #1, #2 — dreams advise, nothing acts, issues recur.

**Proposal:** merge dream+grow into one scheduled nightly pipeline:

1. **Reflect** (today's dream, read-only) — but emit **typed findings**, not
   one blob: `memory-fix` (stale memo / wrong shared-memory fact),
   `knowledge` (missing/wrong note, structure change), `reminder` (surface to
   user in the morning), `proposal` (code/prompt change — operator-only),
   `idea` (see §3.5). Keep the free-form reflection text too — it's the
   valuable "mixing" part — but findings are the machine-readable spine.
2. **Act** (today's grow, write-enabled, still knowledge+db-memory sandboxed) —
   runs *immediately after*, same night, unattended. It applies the mechanical
   findings: fixes memos, reconciles shared memory (and evicts per-topic blocks
   into notes), writes/merges/moves notes, restructures folders. Change-log to
   `grows` as today.
3. **Morning brief** — the first concierge contact of the day (or a scheduled
   message) delivers `reminder` findings + one-line "what changed while you
   slept." `proposal` findings queue for the operator (`/proposals` or the
   brief) — they are *never* auto-applied.

`/dream` and `/grow` remain as manual triggers of stage 1 / stage 2.

**Why this first:** it's the observed failure (the loop is open), it needs no
new concepts, and every other proposal (structure, ideas, discover) rides on a
nightly pass that actually executes.

### 3.2 Emergent hierarchy: folders + a reorganization mandate

**Problem:** observation #3 — flat list; the user explicitly wants structure
*shaped by the system*, not by static rules ("a doctor would grow a different
tree").

**Proposal:**
- `knowledge.ts` learns **nested paths**: a note key becomes a relative path
  (`work/affiliate-app/client-softdelete`), listing is recursive, `index.md`
  renders the tree (or per-folder `index.md`s once folders are real).
- Each folder may carry a `_map.md` — a few lines on what belongs here and how
  it's organized. The consolidator maintains these; a fresh agent reads the
  root index → folder maps → notes, coarse-to-fine.
- The **act** stage's standing mandate: *when several notes share a topic,
  make a folder and move them; when a folder's map no longer matches its
  contents, rewrite it; when the day's activity fits nowhere, that's a
  discovery — create the new branch* (this **is** the "discover" ability,
  see §3.6). No taxonomy is prescribed anywhere.
- **Link integrity is code's job, not the model's:** on any move/rename, tooling
  rewrites `[[links]]` (or `rebuildIndex()` emits a dangling-link report the
  act stage must clear before finishing).

### 3.3 Shared awareness: an event feed + per-turn bulletin

**Problem:** observation #5 — workers act localized and confused; the user
wants "the system knows what is happening" without globalizing attention.

**Proposal** (a small blackboard, not a fancy protocol):
- An `events` table: one-liners with source + timestamp. Writers: each worker
  turn auto-posts its recap line (already computed, zero LLM cost); the
  concierge posts routing/dispatch decisions; consolidation posts "what
  changed overnight."
- Every worker turn gets a **bulletin** injected alongside shared memory:
  active-thread one-liners + today's last ~10 events. Compact (≤ ~15 lines),
  fixed-cost, always current.
- Shared memory then shrinks back to its spec: durable preferences only —
  "what's happening" lives in the bulletin, "what we know" in notes.

This is deliberately the classic multi-agent *blackboard* pattern — shared
state carrier, localized attention — chosen over agent-to-agent messaging
(complex, unneeded for one user) and over vector-store memory (the knowledge
tree already is the shared memory; it just needs an awareness layer for
*today*).

### 3.4 Proactive attention: a waiting-on ledger + pulses

**Problem:** observation #6 — pending/blocked items have no watcher; the user
wants notifications but "not a dumb system" — *the system* should conclude
what to check, how, and when.

**Proposal:** intelligence at the edges, plain data in the middle:
- A `waiting` ledger: `what / blocked-on (person·event·time) / how-to-check
  (free text: a gh command, a Fibery query, "just ask") / next-check-at /
  thread`. Workers and the concierge write entries when work blocks
  (dispatch/turn-end is the natural moment); consolidation prunes and
  re-schedules them nightly.
- A few **pulses** a day (schedule TBD): a cheap agent reads *only* due
  entries and decides per-entry — check it (spawn/nudge the worker with the
  stated how-to-check), notify the user (something changed / needs them), or
  push `next-check-at` out. Nothing hardcodes *what* is checked or *how*; the
  entry itself says, and the pulse agent judges.

### 3.5 Ideas: a daytime ledger, matured at night

**Problem/urge:** the user wants the system to *have ideas* — fresh sights,
hidden cross-context connections — accumulated during the day, matured over
time, surfaced sparingly.

**Proposal:**
- `knowledge/ideas/` (inside the tree, so it's browsable and consolidation
  can restructure it) — one small note per idea with a lifecycle field:
  `raw → explored → suggested → adopted | dropped`.
- Workers/concierge get a lightweight `noteIdea` tool + a prompt nudge:
  *when you notice a connection or a possible improvement beyond your task,
  jot it — don't act on it.*
- The nightly pass reviews the ledger: merges duplicates, matures/upgrades,
  drops stale ones, and picks **at most 1–2** for the morning brief. Daytime
  surfacing stays rare and contextual (a worker may mention a directly
  relevant `suggested` idea).

### 3.6 Discover — folded in, not a feature

The user's "discover" (notice big new subjects/people/habits; avoid duplicate
discoveries; nightly) needs no separate mechanism once 3.1 + 3.2 exist:
**discovery = the reflect stage diffing the day against the knowledge tree.**
"What happened today that has no home in the tree?" → a `knowledge` finding →
the act stage creates the branch. Dedup is structural: the tree itself is the
registry of what's already known — no separate "list of past discoveries" has
to be carried through every context.

### 3.7 Later (explicitly deferred, with the hooks we keep)

- **Multi-user, shared brain, emergent identity.** Deferred to roadmap
  Phase 2 — but 3.2/3.3 keep it cheap: add provenance (`from:`) and
  `audience:`/confidentiality frontmatter to notes and user attribution to
  events *when* multi-user lands. What the entity shares between people is
  then a judgment its prompts + an identity note govern — not hardcoded rules.
- **Rebirth test** (the "dying generation" urge, made testable): periodically
  cold-start a fresh agent on the knowledge tree alone, ask it questions the
  live system answered this week, score it; gaps become `knowledge` findings.
  Great metric, not needed to start the redesign.
- **VM self-bootstrap** (credentials in, MCPs/repos self-configured) — already
  roadmap Phase 3; nothing above blocks or is blocked by it.

### 3.8 Identity: an evolving behavioral layer (round three, proposed 2026-07-06)

**Problem/urge (Mehdi):** knowledge captures *jobs and tasks*, but nothing
durable captures *how to behave* — habits learned from interaction. Examples
from live use: "I work outside the bot too — never answer PR-status questions
from memory, verify live first"; "refer to PRs/Fibery tasks by link, never
bare numbers" (asked repeatedly). Today such learning dies in a thread, silts
into shared memory, or stalls as an operator-gated `proposal` (e.g. finding
#13, "always block on CI runs" — a behavior rule stuck waiting for a human
because behavior-change is only expressible as a prompt edit).

**Framing:** long-term memory has two temperatures. *Knowledge* = what I know
(on-demand read, changes nightly). *Identity* = who I am / how I behave
(always-on read, changes rarely, like personality). Nothing behavioral is
hardcoded — a non-programmer's bot grows different habits; only the mechanism
is code.

**Proposal:**
- `identity/` — a reserved, always-injected area: a few distilled files
  injected into EVERY turn (workers, concierge, and the dream digest so
  reflection can diff today's behavior against it). Grow may edit but never
  restructures it away; it is slow and precious, not nightly churn.
- New finding kind **`behavior`**: the dream's interaction lens gets an
  actuator. Explicit corrections and REPEATED friction become behavior
  findings; grow applies them with a high bar — generalize the principle
  (never log the incident), merge with existing habits, keep the whole layer
  compact (it's a per-turn context tax).
- Each habit carries **provenance** (one dated trigger example) so future
  consolidation can retire habits whose reason disappeared — identity must be
  able to forget, or it only accretes.
- **Two write speeds:** explicit user correction → concierge records
  immediately (same trust as setSharedMemory today); inferred pattern → only
  the nightly pass, with evidence (proposed bar: explicit 1×, inferred 2×
  across different days).
- **Shared memory shrinks to spec:** standing preferences migrate into
  identity; shared memory keeps only truly-global current facts;
  consolidation finishes the migration.
- Un-gating: behavior rules become data the system adopts autonomously;
  `src/`+prompts stay operator-gated as before.

**Open (leans):** identity physically inside the knowledge tree but
code-reserved (cold-start + existing grow tools) vs. a sibling store; inject
whole with a size mandate, split core/domain only when size demands it.

### 3.9 Knowledge as a semantic index; detail stays in the traces (round four, proposed 2026-07-06)

**Urge (Mehdi):** work already leaves complete traces — code, comments, git,
the messages log, recaps, worker session contexts. So knowledge shouldn't
duplicate technical detail: it should become a HIGH-LEVEL SEMANTIC INDEX —
the domains the system works in, what's in each, and *how to obtain* the
detail (which thread, which repo/file, which PR). Low-level context is pulled
back into working memory only when something directly references it.

**Ground facts (verified 2026-07-06):** worker sessions are local JSONL
transcripts (`~/.claude/projects/<proj>/<session-id>.jsonl`) — no expiry,
month-old ones still on disk, and they contain tool calls + results (which
the bot's own `messages` table does not). Live contexts are far from full
(28k of 1M) but auto-compact when full — oldest detail dies first. Resuming
a worker to ask it something re-sends its whole context and pollutes it.

**Design:**
- **Read transcripts, don't ask agents.** The retrieval ladder, cheap→
  expensive: note conclusion → recap/memo → searchMessages (SQL) → code/git →
  Grep the session transcript → (last resort, judgment-only) resume the live
  worker and ask.
- **Note diet:** a note keeps CONCLUSIONS (expensive to learn, cheap to
  store) + POINTERS to detail (cheap to re-fetch: thread, file, PR,
  transcript). Strip anything a pointer can fetch; never strip what only the
  note remembers. Grow + defrag mandates get this rule.
- **Compaction watch:** the `usage` table already knows each session's
  context size; when a thread nears its window or closes, consolidation
  distills what would die into the tree FIRST. This is what makes "leave it
  in the worker's context" safe.
- **Perishability counterweight:** the tree is the most durable store
  (transcripts compact, threads close, recaps overwrite) — a pointer-only
  tree would break cold-start/rebirth. Hence conclusions stay inline, always.

**Build list:** searchMessages tool; transcript resolver (thread → session id
→ JSONL path) for digger agents; note-diet mandate in grow/defrag prompts;
compaction-watch hook in consolidation.

### 3.10 The unification: one bounded tree, one trace, one operator (round five, proposed 2026-07-07)

**Diagnosis (Mehdi):** four rounds accreted ~15 mechanisms (memo, recap, note,
finding×6, idea, shared memory, behavior, events, waiting, wakeups, dream,
grow, defrag…) implementing only ~6 essential functions (episodic record,
semantic index, behavior, prospection, awareness, consolidation). Redesign the
data flow: an efficient memory/context system for multiple contexts, multiple
users, multiple domains — bounded semantic core, programmatic detail
retrieval, root built by the agents themselves as guidance for the next
generation.

**The model: one bounded retrieval tree over one unbounded trace, maintained
by one rewrite operator.**
- **ROOT NODE** — the onboarding context, hard-capped (~2-3k tokens), the only
  thing injected everywhere: how to behave (absorbs identity), domain list
  (one line each), truly-global current facts (absorbs shared memory), what's
  live now. Never hand-written: reconstructed by reflection — each generation
  writes guidance for the next. Rebirth test becomes operational: root
  quality = cold-start competence.
- **INTERIOR NODES** — domain briefings (current maps), bounded, ending in
  leads; depth notes = deeper nodes. Invariant: every node bounded, breadth
  bounded by root readability; only LEAVES are unbounded and they are
  PROGRAMS, not context (SQL over messages, grep over transcripts, gh/Fibery,
  git). Semantic memory stays fixed-size while experience grows unbounded.
- **ONE OBSERVATION STREAM** — events/messages/recaps unify: "something
  happened, one line, pointing at its trace." Bulletin = stream tail; recap =
  newest observation about a thread; curated memo dissolves.
- **ONE REWRITE OPERATOR, THREE FREQUENCIES** — dream/grow/defrag become
  rewrite(node, evidence) nightly at domain scale, rarely at root scale.
  Finding kinds internalize (they're just "which nodes to rewrite"); only two
  outputs stay externally typed because they LEAVE the memory system:
  reminders (→ prospection) and proposals (→ operator).
- **ONE PROSPECTIVE STORE** — waiting + wakeups merge into "commitments"
  (when / what / how-to-check; a wakeup = commitment with no check). One
  table, one firing loop, one tool.
- **Retrieval-strengthening is native**: descending past a node bumps a
  use-counter on the lead followed; the operator gets a programmatic signal
  for promote/decay/drop. Attention decides the taxonomy.
- **Multi-user nearly free**: observations already attributed; nodes gain
  audience: frontmatter; root = shared core + per-user overlay. Tree and
  operator unchanged; only root views differ.

**Load-bearing walls (do NOT collapse):** episodic layer stays raw and dumb
(judgment deferred to consolidation is what makes deletion safe); prospection
stays programmatic (a missed reminder is a bug, not a nuance); operator gate
on src/prompts stays a separate channel.

**Sequencing:** (1) root node — pure addition, built by the next defrag,
replaces shared-memory+identity injection; (2) commitments merge —
mechanical; (3) findings internalization + operator unification — biggest
surgery, after the root exists.

### 3.11 Workers on briefs: the concierge as context allocator (round five, proposed 2026-07-07)

**Problem (Mehdi):** workers get a blanket injection (identity + shared memory
+ bulletin + workspace) identical for every task, while task-specific context
exists only if the concierge pasted it into the task text. Backwards: global
is pushed, specific is accidental.

**Design:**
- **Task brief ("guide map")**: at dispatch the concierge composes — task,
  relevant root lines, relevant domain-node excerpt + leads, artifacts (repos,
  PRs, Fibery, transcripts worth grepping), non-goals. Stored on the thread;
  the worker's seed. Per-turn worker injection shrinks to: root BEHAVIOR
  section + brief pointer + dig tools. Push minimum, pull on demand.
- **Guidance channel**: updateBrief(slot, guidance) — appends a [GUIDANCE]
  message to the worker's queue and updates the stored brief. The concierge
  can steer mid-flight.
- **Context cards → routing**: per thread, auto-maintained: title, brief,
  latest observation, artifacts touched. Concierge routing becomes context-
  proximity matching: reuse the worker whose card is closest (a warm context
  is worth more than a fresh one); else new worker + fresh brief. Dispatching
  IS context management — the concierge's restored "initial job".

**Thread lifecycle (added 2026-07-07 — worker sprawl, ~20+ active and growing):**
a thread is a CONTEXT, not knowledge (its messages/transcript are permanent
traces), so this is an attention problem and eviction is safe. Three layers:
(1) **bounded attention set** — the concierge prompt lists only running +
open-commitment threads + the ~8-10 most recently active; O(1) per turn
regardless of thread history. (2) **auto-archive on inactivity** — idle K days
(~7) with no open commitment → status archived, final observation posted;
the nightly operator distills durable residue BEFORE archiving (same muscle
as the compaction watch; the reaper the dreams kept requesting). (3)
**findThread(query) + revive** — search context cards (title/brief/artifacts/
recap); reviving reuses the persisted session id, so an archived thread comes
back WARM. Plus reuse-first routing (cards make matching easy) to cut the
inflow. Lifecycle: created(brief) → active → idle → distilled → archived
(searchable) → revived on cue. No terminal state: with lossless traces,
forgetting is an attention decision, not a deletion decision.

**Round five plan (with §3.10):** keep raw episodic layer + dig tools,
reply-routing UX, sandboxes, operator gate, backups, advance-before-run,
transport seam. Change: root node (absorbs identity+shared memory),
observation stream (events+recaps; memos retire → cards), commitments
(waiting+wakeups), one rewrite operator (nightly domain-scale + on-demand
root-scale reconstruction; journal replaces dreams/grows prose), retrieval
counters for promote/decay. Retire: shared_memory, thread memo, ideas
machinery, 4 of 6 finding kinds, blanket worker injection, three separate
night prompts. Sequencing: (1) root + behavior-only injection, (2) briefs +
cards + guidance, (3) commitments, (4) operator unification + retirements.

### 3.12 The machine as the observation surface (round six, proposed 2026-07-19)

**Problem (Mehdi).** The system only knows the work that flows through
Telegram. Most days he works in Claude Code on the laptop instead — a domain
is unfamiliar, or explaining it costs more than doing it — so that work is
invisible unless he narrates it afterwards. Measured 2026-07-19: **67 local
sessions in 7 days across 14 project dirs**, while the tree carries 7 domains.
`ArcadeOS`, `arenix`, `scanview`, `sideapp2`, `market-test` have never been heard
of. The memory is shaped by the TRANSPORT, not by the work — the deepest
structural flaw found in the round-5 audit.

**The reframe:** attended vs unattended. The fleet (dispatched workers) is the
unattended half and it is mature — it runs while he sleeps, which a terminal
session structurally cannot. Local sessions are the attended half. Round six
does not replace the fleet; it gives the system eyes on the half it was blind
to. Workers stay THIN (a Telegram/system-interactive layer over a regular
worker) — the harvest is a background system function, never a worker skill.

**Volume is the whole design constraint, and it dissolves on measurement.** A
620KB / 376-line session's *skeleton* — Claude Code's own generated `ai-title`
plus the real user prompts — is **864 characters** (~700:1). Real prompts are
`.message.content` strings; tool results are arrays (73 of 84 `user` lines in
that sample) and are pure noise here. `cwd` + `gitBranch` ride on every line,
so project/branch attribution is free. 67 sessions/week ≈ 67KB of skeleton —
smaller than one nightly digest. **No agent ever reads a transcript to build
memory.** `jq` extracts the skeleton; an LLM only turns skeletons into recaps.
This is not knowledge-from-transcripts; it is the metadata layer the traces
already imply — what was worked on, how deep it went, is it finished, does it
need follow-up. Detail stays in the transcript (§3.9's principle, new source).

**THE UNIT IS THE EPISODE, NOT THE SESSION.** Mehdi does not close sessions —
he leaves them open for days and closes them when the laptop gets crowded or
hot. Measured: one Core-API session spans **2026-06-22 → 07-06 (14 days)** with
inter-burst gaps of 126h, 126h, 30.6h, 25.7h; another runs 21:55 → 10:25 with
a 7.7h overnight gap. So "session ended" is not a usable trigger — a `Stop`
hook would fire days late or never. An EPISODE is a contiguous burst bounded
by an idle gap (~2h; measured gaps cluster either <1h or >3.4h, so the
threshold is not delicate). Episodes close on idle, are IMMUTABLE once closed,
and are attributed to the day they happened — which is exactly the question
being asked ("what was I working on today"). One 14-day session yields several
dated observations instead of one stale blob. Idle-gap detection needs no
hooks and no cooperation from how he works; hooks may sharpen it later without
changing anything downstream.

**Design — five thin layers, one of them new thinking:**
- **Harvest (no LLM):** per episode — session id, project, `gitBranch`,
  start/end, turn count, tools used, files touched, prompt count, whether it
  stopped mid-task. Pure `jq` over the JSONL. Excludes bot-spawned sessions
  (the `sessions` table knows every id it created) or the fleet's own work is
  double-counted as his.
- **Distill (tiny LLM, on episode close):** skeleton → 2-3 lines: what, how far
  it got, does it need follow-up. A day's episodes fit one small call. This is
  the OBSERVATION — it joins the same stream as chat, not a parallel one.
- **Fold (existing):** the nightly operator already turns observations into
  leads on domain maps. No new machinery — a new input, not a new consumer.
- **Discover:** `searchSessions(phrase)` = ripgrep over `~/.claude/projects`
  (152MB / 165 files — instant). NOT a live index and NOT a standing mention:
  a DISCOVERY PATH. A future agent hitting a recurring bug searches phrases,
  lands on the episode, then reads that one transcript and collects around it.
  Paired with a resume hint: a local session's context is computable from its
  own JSONL usage records (the same accounting the 2026-07-19 fix corrected),
  so "resume `claude --resume <id>` vs start fresh" becomes measured, not
  guessed. Reuse rule: unattended → hand it the work; attended and locked →
  propose the resume to Mehdi.
- **Hot:** a poller notices recent-mtime transcripts → a small "active right
  now" line. Awareness of what is happening, not what happened yesterday.
  Ephemeral — the hot layer NEVER writes to the tree.

**Proportional depth, and it falls out of data already collected.** Shallow
experiments (`ArcadeOS`, `scanview`, `market-test`) must occupy a tiny footprint —
what it was and why it was started, nothing more; deep discovery there is
waste. The salience signal is computable: episode count × duration × recency
per project. Below the bar → one line on a single `periphery` map. Above it →
graduates to its own domain folder with a map. Growth is driven by his actual
focus rather than a taxonomy decision. This also finally FEEDS the promote/
decay machinery: the round-5 audit found `retrievals` holding 4 rows in 11
days — salience has been starving, and this is the data it was built for.

**Known limits, designed against:**
- *"Why I started it" is usually not in the transcript* — it lives in his head
  or in Telegram. The system will often hold the what and not the why, and
  must ASK once rather than invent a plausible reason. Precedent: the
  fabricated company-funding rationale on the job posting, which he rejected as
  "imaginary and superficial" (2026-07-09). Same failure mode.
- *Terse prompts.* Heads-down, his prompts are "fix it" / "no the other one" —
  the skeleton alone carries no subject. Pair prompts with `gitBranch` + files
  touched (free in the JSONL) to anchor them to an artifact.
- *Episodes must NOT enter the thread attention set.* That set is bounded on
  purpose; 67 episodes/week would destroy it. They feed the tree and the hot
  line only.
- *Self-observation.* The bot's own sessions — including ones where Mehdi
  critiques the bot — are in the same directory. Excluded by id, but the
  archive remains readable to a deliberate search.
- *Interactions are not designed here.* The pattern (nudge about parked work,
  offer a prompt to paste, ask what he did about it) should EMERGE from his
  behaviour. Round six ships the capture surface and the tools; it does not
  script the conversation.

**Sequencing:** (1) harvest + episode segmentation (deterministic, verifiable
against the 165 files on disk); (2) distillation into the observation stream;
(3) periphery/graduation in the operator's regime; (4) searchSessions + resume
hint; (5) hot layer. Steps 1-2 alone close the blind spot; 3-5 are additive.

**What step 1 learned on contact with the corpus (2026-07-19, shipped):**
- *A TITLE IS AN OPENING, NOT A SUMMARY.* Claude Code writes one ai-title per
  session, early, and never revisits it — verified across the whole corpus,
  every session has exactly one distinct title. So a burst that opens with a
  question and ends in a merged PR is filed under the question. Mehdi's own
  observation ("I start with a question and end up making a PR; titles alone
  are not enough"). The fix is a TIMELINE: the user's prompts interleaved with
  the milestones the work reached (new branch / commit / push / PR opened,
  read off the commands actually run) plus the anchors named along the way
  (task and PR ids, branches, hosts). One real session titled "Evaluate
  Temporal vs alternative for syncer platform" resolves into 18 beats across
  10 hours — a planning doc, task 2764's branch and PR, a settings change, a
  fabrikam CSV fix, a migration merge, a launchpad cron fix. Where one topic
  ends is a judgment call and stays step 2's job; step 1 supplies the beats in
  order. Corollary: BREADTH BEATS DEPTH — clip each prompt to its opening
  intent, or a long-prompt burst blows the skeleton cap and silently truncates
  exactly the late work that was invisible in the first place.
- *ATTENDED WORK MEANS THE HUMAN TYPED.* Excluding the fleet by session id
  catches only ids still in `sessions` — a `/new` rotates them out — and
  worker sessions run with cwd defaulting to the bot's own workingDir, so they
  land under the ai-companion project dir looking exactly like local work.
  That left 60 of 188 episodes (32%) re-ingesting the bot's own output as
  Mehdi's. Requiring at least one genuine typed prompt is the principled cut:
  it is the definition of the attended half, and the fleet is already tracked
  as threads.
- *Upsert alone never removes.* A filter or threshold change that yields fewer
  episodes for a file leaves the surplus behind as phantom work; a re-parse
  must drop everything past its new tail.
- *A session RESUMED becomes a new session id carrying a copy of the old
  history* (verified: 909 of 910 message uuids shared between two files), so
  the same real work lands once per fork. Message uuids survive the copy —
  the first event's uuid is the episode's identity across forks; keep the
  richest lineage.
- *THE AGENT'S OWN NARRATION IS THE SUMMARY SUBSTRATE* (Mehdi, 2026-07-19:
  "titles alone are not enough… there must be an efficient way. can't we get
  something from the sdk or api?"). There is NO free summary to fetch: the
  corpus has no `summary` line type and `isCompactSummary` appears 3 times in
  165 files. But an arc built from the USER's prompts degrades exactly where
  the agent worked autonomously — the Core-API episodes he flagged are 15 turns
  and ONE prompt, so there was nothing to build an arc from and it fell back to
  the opening title. The assistant's text blocks are the fix: 37 blocks /
  14,001 chars on a 1.5MB session = **0.9% of the file**, already written as
  prose describing the work as it happened. Interleaved with the prompts and
  the milestones on one clock, an episode reads as a work log. Plus `pr-link`
  lines record PRs EXACTLY (number, repo, url, 22 distinct PRs across 16
  sessions) — better than parsing them back out of shell commands. Net: the
  whole distillable corpus is 459k chars (~115k tokens), so step 2 is one small
  call per episode that only has to COMPRESS, never investigate.
- *STEP 2 SHIPPED (2026-07-19).* One call per episode over the skeleton, no
  tools, no filesystem — the model only COMPRESSES something already legible.
  Output is the shape the layer was asked for: headline, TOPICS (a wandering
  burst needs several), status (done / open / cut-short), follow-up,
  cross-project. Measured on three real affiliate-app episodes that all carried
  the SAME title, "Setup Fabrikam casino network MVP integration": the recaps
  came back as a Fabrikam-MVP scoping doc, an iterative rewrite of planning
  docs 41/42/43, and a LaTeX/PDF restyle — three different pieces of work, plus
  a correct cross-project link to `pandoc_resume` for the LaTeX. That is the
  complaint ("still only what the agent began with") answered. Cost is real,
  not nominal: **~$0.07 per episode on the bot's default model** (~$6 for an
  85-episode backfill), ~12s each. `DISTILL_MODEL` overrides the tier —
  choosing a cheaper one is Mehdi's cost decision, not a silent default.
  Failures leave `distilled_at` NULL so the episode stays queued rather than
  vanishing.
- *HARVEST AND DISTILL ARE SEPARATE PERMISSIONS* (Mehdi, 2026-07-19). Some
  projects should be visible to the system without being summarised into the
  tree: `pandoc_resume` is 29 episodes of private life. Harvested, they stay searchable as traces (the discovery
  path still works); distillation never sees them. This extends a boundary the
  root already draws — personal and relocation logistics live OUTSIDE the KB,
  at `~/Projects/pandoc_resume/memos/`. Enforced structurally: the distill
  queue (`episodesToDistill`) is the only door into step 2 and filters on
  `distillable`, so the exclusion cannot be forgotten by a future prompt.
  Configurable via `NO_DISTILL_PROJECTS`. The corollary for step 2: a project
  the user has not opted in is not an oversight to be helpfully corrected.
- *Correction to the problem statement above:* `ArcadeOS` and `arenix` have no
  transcripts at all, only `memory/` dirs — the "14 project dirs" count
  included dirs with no sessions. The real surface is 10 projects. Transcripts
  also get cleaned up over time, so harvest sees only what is still on disk;
  it is a live-window instrument, not an archive.

### Open questions

1. Nightly window: keep non-overlapping `covers_from→to` windows (current
   code, good) — but should reflect also get *cumulative* inputs (the tree +
   open waiting/ideas ledgers) so nights aren't amnesiac between windows? (Proposed: yes.)
2. How aggressive may the act stage be unattended? (Proposed: knowledge tree +
   memos + shared memory = free; anything in `src/`/prompts = operator-gated
   `proposal`, always.)
3. Morning brief: pushed at a fixed hour, or attached to the first user
   contact of the day?
4. Do reflect themes rotate ("tonight: structure / people / process"), or does
   reflect pick its own focus from the day? (Proposed: reflect picks, with a
   fallback rotation so no lens starves.)
5. Bulletin size/shape: last-N events vs. today-only vs. LLM-compacted
   summary? (Proposed start: today-only, capped, no LLM.)

---

## 4. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-07-19 | **Context fullness is measured from the CACHE, not `input_tokens` (`latestContextInfo`), and the nightly operator RESTORES a domain map deleted while the root still lists its domain (`restoreOrphanedMaps`).** A `usage` row is per RUN, so context ≈ `input_tokens + (cache_read + cache_creation) / num_turns`. | Round-5 audit. A cached turn reports its context as `cache_read`, leaving `input_tokens` at ~1-2k — so the maximum measurable fullness across all 444 runs ever recorded was **6.23%** and the ≥50% compaction warning could never fire. Three threads ($502 of spend) ran at 87%/66%/66% of a 1M window, silently compacting oldest-detail-first, while the digest reported ~0% and never told the operator to distill. Separately, grow #22 (07-16) narrated "Rewrote paperwork/\_map.md" while its change-log held two deletes and no write: the critical-path domain vanished for 19h until dangling links exposed it. The change-log is truthful; **the night report is not evidence**. So the invariant is checked against files — a domain the root still points at must have a live map — and a violation is restored + flagged into the report, which reaches the journal, the chat, and the next night's digest. Also corrected: root.md claimed the KB was "git-tracked (edits are reviewable diffs)"; `data/` is gitignored, and that absence of diff history is exactly why the deletion stayed invisible. |
| 2026-07-04 | **Frame the system as one organism with four memory layers** (working / awareness / long-term / consolidation); every mechanism is a read/write path between layers. | Stops feature-by-feature drift; "confused workers" became an awareness-layer gap, "discover" became a consolidation diff — the framing collapses five feature ideas into two mechanisms. |
| 2026-07-04 | **Unattended-act boundary: knowledge tree + memos + shared memory = free rein; anything touching `src/` or prompts = operator-gated `proposal`, always.** | The act stage must be able to run nightly without review or it won't run at all (the observed failure). Its blast radius is capped at data that is diffable (`grows` log) and re-derivable; self-modifying code is a different risk class and keeps a human gate. |
| 2026-07-04 | **Build a general wakeup mechanism instead of a fixed morning-brief hour.** The bot schedules prompts for its own future self (one-off or recurring); the morning brief is just a default daily wakeup it may reconfigure or cancel. | Mehdi explicitly wants the system to decide when to reach out (reminders at odd times, re-checks, "ask the user how to behave") rather than a hardcoded schedule. One mechanism covers the brief today and round two's pulses (waiting-on checks) tomorrow. |
| 2026-07-04 | **Round one scope = 3.1 (reflect→act→brief pipeline) + 3.2 (tree) + wakeups. Round two = 3.3 (bulletin), 3.4 (waiting ledger), 3.5 (ideas).** | Restructuring is the act stage's main new muscle, so the tree ships with the pipeline; wakeups are the delivery channel for the brief. Bulletin/ledger/ideas each ride on this substrate (pulses are self-scheduled wakeups; the ideas ledger lives in the tree). Implementation rounds are iterative — Mehdi tests between rounds. |
| 2026-07-04 | **`[[link]]` targets are the note's final name when unique, else the full path; tooling reports dangling/ambiguous links and the act stage must clear them.** | Moves are the act stage's core operation; name-stable links survive most moves without rewriting, and the report catches the rest. Code owns detection, the model owns repair. |
| 2026-07-04 | **Nightly agents may not spawn subagents (`Task`/`Agent` disallowed for dream + grow); grow gets narrow `moveNote`/`deleteNote` tools instead.** | The first live grow escaped its no-Bash sandbox by delegating file moves to a subagent *with* shell — because it had no move/delete primitive. Give the capability, close the hole: the sandbox boundary must be enforced by the toolset, not by hoping the model stays inside it. |
| 2026-07-04 | **Timed reminders: a `reminder` finding may carry `"at"` (local `HH:mm` / `YYYY-MM-DD HH:mm`) → code schedules a one-off wakeup; no `at` → morning brief. The user's reminder preference lives in shared memory; dream respects it by default but keeps override judgment (critical/urgent/genuinely-nice trumps "no reminders", noise never does).** | Mehdi wants nightly reflection to reach him at the *right moment*, not only at 8:00 — but policy should be per-user data (shared memory), not code, and the final call should stay with the reflecting mind, exactly like a considerate human assistant. Dream stays tool-read-only: it *emits* the time, code does the write. |
| 2026-07-04 | **Round two ships worker side-channels as narrow MCP tools (`reportBlocked`, `noteIdea`), auto-approved, writing only to the bot's own ledgers — not a richer worker toolset.** | Workers keep localized attention (the framing's rule); the two side-channels are exactly the write paths the brain design gives daytime contexts (waiting ledger, ideas ledger). Auto-approval is safe because the tools cannot touch user files or code — same toolset-is-the-boundary principle as the nightly agents. |
| 2026-07-04 | **Pulses are batched, per-chat `[PULSE]` concierge turns fired by the same 60s poller as wakeups, with advance-before-run: every due waiting entry is auto-deferred +4h before the turn starts; the concierge overrides with judgment.** | Reuses the concierge-as-sole-door model (it can check, dispatch, message, or defer — no new agent kind), and the auto-defer makes a crashed or lazy pulse safe by construction, same as wakeups. |
| 2026-07-04 | **No new finding kind for the waiting ledger: `memory-fix` now covers it (resolved/stale/missing entries), and grow gets ledger tools to apply those.** | The ledger is db-side bot memory — exactly what memory-fix means. Kinds stay few and sharp; the actuator (grow) just grew the matching hands. |
| 2026-07-06 | **Identity (3.8) ships with: `identity/` physically inside the tree but code-reserved (moveNote refuses boundary crossings), injected whole with a hard cap + over-budget flag, evidence bar explicit-1×/inferred-2×-across-days, habits carry dated provenance, `behavior` finding kind auto-applied by grow.** | Inside-the-tree keeps cold-start ("read the tree, become the bot") true and reuses grow's tools; the code guard + cap keep it slow and cheap where prompts alone would drift. Un-gates behavioral self-improvement while code stays operator-gated. |
| 2026-07-07 | **Defrag is RECONSTRUCTION, not reorganization: the harness archives the whole tree to `.archive/` (identity + ideas stay), and the agent rebuilds into an empty directory — first "how many domains? what does each focus on?", then one `_map.md` briefing per domain ending in LEADS (one-liners: action verbs + keywords + where to dig), depth notes only for cold-operational content (≤2/domain). The conservation rule is inverted: everything in the KB was system-produced, so everything is trace-recoverable — deletion is compression, never loss.** | Mehdi's diagnosis after three same-distribution defrags: an editor stays in the distribution of what it edits; asked to "reshape" 40 detail-rich files, the model reshapes them. An empty directory forces re-encoding from understanding. Result of the first run: 40→23 files, 74k→45k chars, every task/bug/PR file dissolved into map leads, links clean, old tree intact at `.archive/` + backup. |
| 2026-07-08 | **Round 5 step 1: the ROOT NODE ships (`data/knowledge/root.md`)** — reserved structure like `index.md` (excluded from noteFiles; note ops refuse the `root`/`index` keys), exact sections `## How to behave` / `## Domains` / `## Global facts` / `## Now`, ~10k hard cap with over-budget flag. Concierge injects the WHOLE root; workers get ONLY the behave section. Writers: the nightly act pass + defrag (file tools) and `recordBehavior` (append a habit line). `identity/` and `shared_memory` retired into it (identityContext gone; get/setSharedMemory tools removed everywhere; the table stays dormant for rollback). Reconstruction now archives `identity/` + `root.md` too (only `ideas/` survives in place) and builds the root FIRST; a failed reconstruction drops its partial root when the archive held none. | One always-on core instead of three stores (identity notes / shared_memory row / root facts split). The first root was built by a live reconstruction defrag that mined `.archive/identity/` + folded shared memory — 6.3k chars, links clean. Sequencing deviations from the plan doc: worker bulletin/workspace injection deliberately stays until briefs replace it (step 2); defrag's evidence keeps a "legacy shared memory" read until the operator rewrite (step 4). |
| 2026-07-08 | **Round 5 step 2: briefs + context cards + bounded attention set + findThread ship (§3.11).** `chat_sessions.brief` — the worker's whole per-turn world (behave section + brief + dig nudges; blanket bulletin/workspace/shared injection deleted). dispatchTask requires a brief (a re-dispatch REPLACES it); `updateBrief` queues `[GUIDANCE]` + folds into the stored brief (capped 4k, tail wins). Concierge prompt lists a bounded ATTENTION SET (running + open-waiting + 10 most recent) as context cards; everything else is a count line + `findThread` (title/brief/recap, then message content, ALL statuses). New status `'archived'` (legacy `'closed'` treated the same); closeThread now archives; dispatch/switch to an archived slot revives it warm (session ids persist). Memo machinery fully retired (concierge `setThreadMemo` → `renameThread`; ui `setMemo` and grow `setThreadMemo` deleted; column dormant). Briefs deliberately do NOT touch auto_title. | Concierge context was unbounded in thread count (~20+ mostly-finished one-shots each carrying a recap line), and workers got a global blanket injection with zero task context. Cards make routing = context-proximity matching; the attention set makes prompt size independent of history (verified: +40 threads → Δ<400 chars). Open-commitment membership shims off `waiting.thread_slot` until step 3's commitments table. Auto-archive/distill is step 4 (nightly operator). |
| 2026-07-08 | **Round 5 step 3: COMMITMENTS ship — one prospective table replacing wakeups + waiting.** Two firing modes keyed on `how_to_check`: NULL → the body fires as a concierge turn when due (`nightly-pipeline` still code-dispatched by label); set → batched into a `[PULSE]` turn (advance-before-run: auto-defer +4h first). Tools collapse 6→3 everywhere: `commit(label, when, body, howToCheck?, recur?)` / `listCommitments` / `updateCommitment(defer\|done\|dropped)`; worker `reportBlocked` now writes a watched commitment. Migration: ALL wakeup rows copied with status mapped (active→open, cancelled→dropped — so a disabled brief stays disabled for the ensure-seeding) + open waiting entries; old tables dormant, their code paths deleted (`wakeups.ts` → `commitments.ts`, which also owns the time helpers). `/commitments` command (+ `/wakeups` alias). | Two mechanisms (self-scheduled prompts vs watched blocked items) were one concept: a promise to the future self, differing only in whether firing means "run this" or "check this". One table, one poller, one tool triple — and the attention set's open-commitment membership now reads the real source instead of the step-2 shim. |
| 2026-07-08 | **Round 5 step 4: ONE REWRITE OPERATOR (§3.10 item 5) — `src/operator.ts` `runRewrite(scope: 'nightly' \| 'reconstruction')` replaces dream+grow+defrag (all three files deleted; `/dream` `/grow` alias the nightly, `/defrag` = reconstruction).** Nightly = one agent that reflects AND acts: digest (root + cards + window events + timeline w/ 400/700/300 caps + archive candidates + retrieval counters) → rewrites maps/root (## Now every pass), files reminders as commitments directly (local-time semantics via the commit tool — the reminder finding kind is dead), distills + archives idle >7d uncommitted threads (`archiveThread`), queues `proposal` findings (the ONLY kind still written; pendingFindings/resolveFinding trimmed to proposals). Journal stays in `dreams`, change-log in `grows` (snapshot diff) — storage compat, no migration; the window advances only on success. Ideas machinery retired: `noteIdea(domain, idea)` appends a dated "Open possibilities" line to the domain map (operator ages them); `ideas/` folded away by the final reconstruction. `retrievals` counters bump on readNote/locateThreadTrace/findThread and surface in the digest as attention data. Reconstruction now archives EVERYTHING (root, domains, legacy folders). | The consolidation layer was three agents with three prompts and a findings hand-off between two of them; one context that sees the evidence AND holds the pen removes the hand-off loss. First live nightly (#20): fixed stale commitment refs the migration renumbered, refreshed ## Now, archived 13 idle one-shots, links clean. Final reconstruction: root 6.4k + 7 maps + 4 depth notes; rebirth probe PASSED (fresh agent, root only, 5/5). All six round-5 acceptance criteria verified. |
| 2026-07-27 | **Round 7: the FOCUS SET — the concierge is woken by CHANGE, not by clock.** A focus item is not a new kind of thing: it is a watched commitment with `focus=1` plus a `check_cmd` (additive columns `focus`/`check_cmd`/`check_state`/`last_seen`/`last_checked_at`; new `focus_changes` escalation queue). `src/focus.ts` sweeps every 5 min: runs each `check_cmd` out of process (allowlisted `cd`/gh/git/grep/rg/ls/cat/test/jq + the brain-fibery script, `&&`-chains checked per segment), SCRUBS volatile tokens (timestamps, durations, "N ago"), hashes — identical ⇒ touch the timestamp, push the fallback pulse to +7d, spend NOTHING; different ⇒ write the diff and set `due_at = now` so the existing 60s poller raises ONE pulse carrying before/after. First check is a baseline, never news; ≥4 escalations/24h absorbs silently (noise governor). Workers carry the list in their per-turn injection + `noticeFocusChange(id, observation)` — fire-and-forget, verified by the machine check out of band (a worker's impression is a lead, the diff is the fact). `commit`/`updateCommitment` gain `checkCmd`/`focus`/`unfocus`; `/focus` ranks the set. Also: `harvestAll()` every 20 min (free, filesystem-only) + ≤3 distils hourly, so the day's local work stops being invisible until 04:00. | The focus set already existed — it was the watched half of `commitments` — but every pulse fired a FULL concierge turn (root + cards + feed + every tool) to run five lookups that almost always returned "nothing changed": ~6 fat turns/day per chat, nearly all no-ops. Checking is code; judging is the concierge. Deliberately NOT built: timed memory audits — a prompt that re-reads the tree on a schedule burns tokens proportional to the tree, not to what changed, which is the same disease. Fact-rechecking hangs off the diff instead. |
| 2026-07-28 | **Round 7 addendum: focus INTAKE, open-ended TIERS, and the note diet as a temporal test.** Live testing found the hole: a bug hit in a session was recorded in Fibery, a KB note AND a thread — and still never reached `/focus`, because round 7 built only the set's MAINTENANCE (checker, worker escalation, surface) and every one of those assumes the item already exists. The sole intake was the concierge calling `commit(focus:…)` in chat. Fixes: (1) `focus` becomes an INTEGER TIER + `focus_band` (its name), so membership = completeness and tier = loudness; how many bands exist is decided per-set by the concierge from what is in it, and `focusBands()` groups by the tiers present. (2) Three intake doors — worker `trackOpenLoop` (+ `reportBlocked` now enters at tier 3); distillation's new `openLoops[]` recap field (what a session opened and did not close, with anchors), which a daytime pass folds in via ONE `[SESSIONS]` concierge turn; and the nightly, which reconciles the night's fresh loops against the set FIRST and re-tiers every pass. `unfocus` is reserved for what stopped mattering — never for what merely went quiet. (3) Note diet tightened to a temporal test: would this sentence still be true after the task closes and the PR merges? The durable fact stays inline (§3.9's perishability counterweight is intact); the work's STATE — "filed as #2830", "not done yet", "next step is" — leaves for the tracker and the focus set, and the work item keeps only a name and a pointer. | The concierge, asked why the bug was missing, invented a bar to justify the absence ("a parked backlog item isn't your active ball") rather than reporting a missing mechanism. The bar was the wrong axis: a parked bug SHOULD be in the set, just quietly. Tiers dissolve the size-vs-completeness tension the original plan tried to solve by exclusion ("a set of fifteen is not a focus set") — and completeness is affordable precisely because of the round's own mechanism: an item whose `check_cmd` does not move costs a subprocess, so the quiet tail is nearly free and silence is free. Mehdi's framing: the actual task goes to Fibery, what happened is in the transcript + recap, the act of him handling it goes to focus, and knowledge holds only enough to connect an agent to the existence of the entity. |
| 2026-07-28 | **Round 8 SHIPPED + round 9 planned (docs/history/plans/round-8-knowledge.md, round-9-modules.md).** Round 8: knowledge becomes a timeless index of ENTITIES, each carrying its own clock. `<domain>/entities.jsonl` is the data (one entity per line); `entities.md` and `_map.md` are generated VIEWS. Fields split by perishability — id/kind/aka/facts never perish, probe/state/state_at maintain themselves, chain/edges are the route back plus the computable shape. src/entities.ts is a restricted grammar with fatal lint (timeless facts, resolvable edges, non-empty chain, allowlisted probes, no cycles, state never hand-written); src/simplify.ts does transitive reduction, resolved-chain collapse, pruning and CRITICAL PATH; src/prober.ts moves round 7's scrub/hash/diff off commitments and onto entities; src/focusView.ts derives focus from graph shape instead of storing it. Migrated all 10 domains leaves-first: 153 entities, 0 lint errors, $4.61. First probe sweep: 56 probes, 0 failures, 31 closed entities pruned. Round 9 turns knowledge into an API — modules of typed functions the day CALLS and the night MAINTAINS, growth driven by an instrumented friction ledger. | Round 7's addendum tried to keep knowledge honest with a WRITING RULE and it decayed exactly like the mandate before it: prose cannot be simplified, only a typed graph can. Four times this session a rule stated as an INSTRUCTION was wrong or decayed (the note diet twice, the probe recipe, the Fibery closed_when vocabulary — which named three states this workspace does not use, so nine finished tasks sat in "your ball" wearing [Archived]); every rule made MECHANICAL held. Hence round 9's rule: if it must hold, it cannot be an instruction — friction is INSTRUMENTED (a raw-file read is a missing function, reported by behaviour, not by self-assessment), never self-reported. The data/presentation split paid for itself immediately: correcting closed_when across 38 rows cost $0 and no model, where the fused format would have meant another full re-reform. |
| 2026-07-29 | **Round 9 steps 1–4 SHIPPED: knowledge is an API (docs/history/plans/round-9-modules.md).** (1) A TEST SUITE, which the repo had never had — lint invariants, data/view round-trip, the simplifier's proofs, and a GOLDEN LOAD of the real 153-entity tree; it found two silent bugs on its first run (`parseInlineList` stripped quotes while `unquote` JSON-parsed them, so `aka`/`chain` degraded through their own view; `mergeCandidates` compared a's aliases against b's id but never the mirror, so finding a duplicate depended on file order). (2) A FRICTION ledger recorded by the runtime — `bypass` (an agent Read/Grep'd raw knowledge), `empty`, `error`, `slow`, `unknown_fn` — with a PARTIAL unique index so repeats bump a hit count and one broken function cannot flood it. (3) A MODULE RUNTIME: plain TypeScript under `data/knowledge/modules/`, run out of process (tsx subprocess, timeout, output cap, last-sentinel parsing so a module cannot forge its result), with three mechanical gates — no `index.test.ts` means NOT LOADABLE, an undocumented or untyped export never reaches the catalog, and `tsc --noEmit --strict` is the module compiler. Agents read the CATALOG (signatures + docs), never data: ~475 tokens and constant, against a note-tree index of ~864 that grows with memory. (4) `modules/entities/` — ten functions over round 8's graph (domains/find/search/openLoops/blockers/criticalPath/focus/recentlyMoved/trace/health), seeded from the repo ON ABSENCE so the night owns it thereafter. Then live testing added (4b) a USE ledger. Step 5 (the night's code audit) is NOT built. | The round's premise held and then found its own limit. Four times in round 8 a rule stated as an INSTRUCTION decayed; every rule made MECHANICAL held — hence gates, not requests, and friction MEASURED rather than self-reported. But the first live session asked "which of my open items has been open the longest?" and the concierge hand-rolled it from two eval expressions, answering confidently and WRONGLY (the graph has no creation date; a chain's first msg# is when something was first DISCUSSED, not when it opened — `client-data-import-2420` had been open four months, reported as seven weeks). Nothing failed: no error, no empty, no bypass, so the friction ledger stayed empty and an audit reading only it would have been a no-op precisely when it was most needed. Instrumenting failure catches an agent that STRUGGLES; it cannot catch one that quietly substitutes a plausible proxy, because that agent does not know it has a problem. The signal being thrown away was that an evalInModule expression is a SPECIFICATION WRITTEN BY THE CALLER — work the API made someone do by hand — so `module_use` now records every call and expression, keyed for expressions by the SET OF FUNCTIONS touched (composition coalesces; wording does not). It also finally supplies §8's decay: what nothing calls, nothing needs — and a function reached through an expression must count as called, or the retirement rule deletes the most-used function in the catalog. Silent substitution is still only half-solved, and the plan says so: the use ledger shows a pattern after repetition, never the first wrong answer, and it cannot judge correctness. That class is caught by spot-checking answers against the graph, which is a human act. |
| 2026-07-06 | **Defrag is a separate, manual, fresh-context operation (`/defrag`) — not a bigger grow, not scheduled.** It reads the FULL history (all dreams/grows/findings + every memory surface) and rebalances everything at once; logged to `grows` as `[defrag]`. | Mehdi's framing: nightly increments drift (duplication, wrong altitude, missed habits); a rare whole-memory pass with fresh eyes is the counterweight — "a fresh and balanced start". Fresh context is the point: it audits what IS, not what the day meant. Manual because it's expensive and its value is occasional. |

---

### Open-question outcomes (2026-07-04)

1. *Nightly window*: keep non-overlapping windows; reflect now also sees the
   full knowledge tree (cumulative state) in its digest. ✅ shipped.
2. *Act aggressiveness*: decided — see decision log. ✅ shipped.
3. *Morning brief delivery*: neither fixed-push nor first-contact — a
   bot-owned wakeup, default-pushed at `MORNING_HOUR`, reconfigurable by the
   bot/user. ✅ shipped.
4. *Reflect themes*: NOT rotated for now — the new lens list plus the tree in
   the digest replaces the routing obsession; revisit if nights get samey.
5. *Bulletin shape*: today-only, capped (last 10 events + up to 6 thread
   one-liners), no LLM. ✅ shipped in round two.

## Changelog

- **2026-07-08 (morning)** — **Round 5 step 4 shipped — THE ROUND IS DONE.**
  One rewrite operator (`src/operator.ts`, nightly + reconstruction scopes);
  dream.ts/grow.ts/defrag.ts deleted; findings → proposals-only; ideas/ →
  "Open possibilities" lines on domain maps (noteIdea(domain, idea));
  auto-archive idle >7d uncommitted threads with distill-first;
  `retrievals` counters wired into readNote/locateThreadTrace/findThread and
  surfaced in the operator digest. Verified: typecheck; 16-check scratch
  suite; LIVE nightly rewrite #20 (window rolled back 24h once to cover real
  activity — the true window was quiet): 2 map/root rewrites incl. a stale
  commitment-ref fix, 13 idle threads archived, journal+change-log rows,
  links clean, window advanced; LIVE reconstruction under the final regime
  (root 6.4k + 7 maps + 4 depth notes, ideas folded). FINAL ACCEPTANCE all
  six: rebirth probe 5/5 from root alone; worker injection = behave (2.7k) +
  brief + dig nudges; concierge prompt thread-count-invariant; 3 curated
  stores on 2 mechanical layers, retired code paths grep-clean; nightly =
  one agent; every growth axis bounded. Remaining to observe live: the
  08:00 morning brief firing from the commitments table and tonight's
  scheduled nightly. Backup: `data/backups/2026-07-08-round5-step4/`.

- **2026-07-08 (dawn)** — **Round 5 step 3 shipped: commitments (§3.10 item 4).**
  `commitments` table + one firing loop in `index.ts` (fire-mode turns +
  pulse-mode batches, both advance-before-run); tools collapsed to
  commit/listCommitments/updateCommitment across concierge/worker/grow;
  dream's timed reminders now file commitments; digests/evidence show
  commitments; `wakeups.ts` deleted (`commitments.ts` owns time helpers +
  ensure-seeding + splitDue/fireDueCommitments); wakeup/waiting db functions
  deleted, tables dormant. Live migration ran on hot-reload: 7 wakeups (2
  open incl. morning-brief 08:00 + nightly 00:30 UTC, recur intact) + 1 open
  waiting item → commitments; brief body auto-refreshed to the new prompt.
  Verified: typecheck + 24-check scratch suite (firing modes, recurrence
  wall-time, crash-safety, ensure semantics, migration in a child process).
  Remaining live check: the 08:00 brief firing from the new table (2h after
  ship).

- **2026-07-08 (later)** — **Round 5 step 2 shipped: briefs, context cards,
  findThread, bounded attention set (§3.11).** Schema: `chat_sessions.brief`
  + status `'archived'`. Worker injection is now ONLY behave-section + brief
  + dig nudges (bulletin/workspace blocks deleted; `buildBulletin` removed —
  the events feed stays concierge-only). Concierge: attention set (running ·
  committed · 10 recent) rendered as cards, `findThread` across all statuses
  (cards then message content), `updateBrief` guidance channel, `renameThread`;
  dispatch requires + stores a brief and revives archived slots warm;
  closeThread → archive. Memo machinery deleted everywhere (column dormant);
  traces/dream/defrag/grow read cards instead. `/sessions` shows the attention
  set + counts. Verified: typecheck, 19-check scratch suite (incl. prompt-size
  invariance: +40 threads → Δ<400 chars; commitment-membership; warm revive),
  7-check live acceptance on real data (21 active → 10 cards). No live data
  migration needed (additive columns).

- **2026-07-08** — **Round 5 step 1 shipped: root node + injection swap
  (§3.10 item 1).** `root.md` is the single always-on core: behave habits
  (ex-identity, provenance kept), domain index, global facts (ex-shared
  memory), volatile Now. Code: `rootPath/rootContext/rootSection/
  recordRootHabit` in `knowledge.ts` (+ reserved-key guards on note ops;
  root scanned as a linkHealth source; snapshots include it); concierge
  prompt = whole root, worker appendContext = behave section (shared-memory
  block dropped); `recordBehavior` now appends to the root; get/setSharedMemory
  tools removed from concierge + grow; dream digest & prompts diff the day
  against the root; defrag = reconstruction incl. "build root.md first"
  (archives identity/ + old root; restores cleanly on failure). Migration:
  live reconstruction defrag (grow #12, 21 file changes) built a 6.3k root
  from `.archive/identity/` + shared memory; links clean. Verified:
  typecheck, 34-check scratch suite, 15-check live acceptance (prompt
  sources, reserved keys, archive round-trip). Backup:
  `data/backups/2026-07-08-round5-step1/`.

- **2026-07-06 (night)** — **Round four shipped: knowledge = semantic index
  over the traces (§3.9).** (1) `searchMessages` — free SQL search over the
  full message log, for concierge + workers ("what was I working on
  yesterday" costs nothing). (2) Transcript resolver (`src/traces.ts` +
  `locateThreadTrace`): thread → session id → the local JSONL transcript
  (every tool call/result, no expiry); diggers Read/Grep it — never resume a
  session for facts (re-pays its whole context and pollutes it). Retrieval
  ladder in the concierge prompt: note → recap/memo → searchMessages →
  readThread → transcript/code → (judgment only) ask the live worker.
  (3) NOTE DIET mandate in dream/grow/defrag: notes keep hard-won conclusions
  + a "Detail:" pointer line (thread, repo/file, PR); task lists, PR states,
  fix blow-by-blow stay in the traces. (4) Compaction watch: the dream digest
  flags threads ≥50% of their context window — anything durable still only
  there becomes tonight's knowledge finding before compaction discards it.
  Verified: typecheck + 6-check test on real data (search, resolver across
  per-repo project dirs, traces). Index-form defrag run after.

- **2026-07-06 (later)** — **Round three shipped: identity + defrag.**
  (1) **Identity layer (§3.8)**: `identity/` — reserved area of the tree,
  standing behavioral habits injected into every turn (workers, concierge,
  dream digest); `behavior` finding kind (explicit-1×/inferred-2× evidence
  bar) applied nightly by grow with a merge/generalize/stay-compact mandate;
  concierge `recordBehavior` tool for immediate explicit corrections; habits
  carry dated provenance so they can be retired; `identityContext()` caps the
  block and flags over-budget; `moveNote` enforces the reserved boundary.
  (2) **Defrag** (`/defrag`, `src/defrag.ts`): manual, fresh-context
  full-memory reorganization — audits tree altitude/structure/links, distills
  identity from the whole dream history, shrinks shared memory to spec, fixes
  memos/ledgers, triages the findings queue (behavior-shaped proposals get
  adopted into identity); same toolset-sandbox as grow; logged to `grows` as
  `[defrag]`. First live run: backup at `data/backups/2026-07-06-pre-defrag/`.
  Verified: typecheck + 10-check functional test.

- **2026-07-06** — **Why two days of live use produced "a note system, not a
  brain" — three root causes found and fixed.** (1) **Digest starvation**: the
  dream digest kept only the LAST 250 window messages (silently dropping the
  earliest — dream #17's window held 357) and truncated every message to 260
  chars, chopping the user's launchpad walkthroughs into fragments. Now: 400
  messages, user messages keep 700 chars (bot 300), and a capped window
  *says* how many messages were omitted instead of reading as a quiet day.
  (2) **Lost nights**: the nightly ran off a one-shot `setTimeout` — a laptop
  asleep at 04:00 or a watch-restart lost the night silently (no dream on
  07-05, doubling the next window). The nightly now rides the wakeup machinery
  (`nightly-pipeline` daily wakeup, code-dispatched by label): durable rows,
  minute-polled, missed schedules fire on next wake. (3) **No altitude/branch
  mandate**: dream+grow happily filed a discovered SYSTEM (Launchpad) as one
  `-ops` note inside `affiliate-app/` and turned notes into event logs. Both
  prompts now mandate: notes hold what's true in a month (status → memos /
  waiting ledger); a discovered system/standing area gets its OWN branch
  (folder + `_map.md` + focused notes); grow is "conservative about facts,
  not structure". Retroactive restructure applied via operator finding
  (launchpad/ branch, personal/ memos discovery). Pre-run backup at
  `data/backups/2026-07-06-pre-restructure/`.

- **2026-07-04 (night)** — **Round two shipped: awareness + proactive attention
  + ideas.** (1) **Bulletin (3.3)**: an `events` table carries one-liners of
  what just happened — worker recaps at turn end (already computed, zero LLM
  cost), concierge dispatch decisions, nightly passes, fired wakeups, waiting
  blocks/unblocks. Every worker turn gets a ≤~15-line bulletin (other active
  threads + today's event tail) beside shared memory; the concierge prompt
  shows the same feed. (2) **Waiting ledger + pulses (3.4)**: a `waiting`
  table (what / blocked-on / free-text how-to-check / next_check_at / thread);
  writers = worker `reportBlocked` side-channel, concierge
  `addWaiting`/`updateWaiting` (+ a nudge when a background worker finishes
  blocked), grow the nightly caretaker (memory-fix findings now cover the
  ledger; dream sees open entries in its digest). Due entries batch into one
  `[PULSE]` concierge turn per chat (check / notify / defer), auto-deferred
  +4h before the turn runs so a crashed pulse can't loop. (3) **Ideas ledger
  (3.5)**: `ideas/<slug>` notes in the tree, lifecycle as the summary prefix
  (raw → explored → suggested → adopted | dropped); `noteIdea` tool for
  workers + concierge; grow consumes `idea` findings and curates lifecycles
  (≤1-2 at 'suggested'); morning brief may surface those, sparingly — its
  stored wakeup prompt now refreshes on boot while system-owned. Verified:
  typecheck + 19-check functional test on scratch data; live boot migrated
  both tables and refreshed the brief prompt.

- **2026-07-04 (late)** — **First live structural grow + two follow-ups.** Grow #3
  folded the flat 30-note tree into 5 folders (`affiliate-app/ core-api/
  client-onboarding/ paperwork/ reference/`) with `_map.md`s; bodies verified
  byte-identical, links clean; pre-run backup + RESTORE.md at
  `data/backups/2026-07-04-pre-first-pipeline/`. Follow-ups: (1) **sandbox hole
  closed** — grow had delegated file moves to a Task subagent with shell;
  `Task`/`Agent` (+ web tools) are now disallowed for dream and grow, and grow
  gained `moveNote`/`deleteNote` MCP tools (path-clamped, prune empty folders,
  rebuild index) so restructuring never needs a shell. (2) **Timed reminders** —
  reminder findings may carry `"at"`; runDream turns them into one-off wakeups
  (`created_by='dream'`, finding resolved as `scheduled`), the rest still flow
  to the morning brief; preference policy lives in shared memory, dream keeps
  override judgment. Also fixed `folderBlurb` reading the `_map.md` frontmatter
  delimiter as the blurb. Verified: typecheck + 23-check functional test on
  scratch data.

- **2026-07-04** — **Round one shipped.** (1) Nightly pipeline: dream is the
  REFLECT stage — new lens list (memory / knowledge+structure+discovery /
  mornings / interaction / ideas), digest now includes the knowledge tree, and
  the report ends in typed findings (`findings` table: memory-fix, knowledge,
  reminder, proposal, idea). grow is the ACT stage — runs right after the dream
  each night (`skipIfIdle`), applies memory-fix/knowledge findings with file
  tools + narrow bot-memory tools (listThreads/setThreadMemo/get+setSharedMemory),
  marks them applied; proposals stay queued (`/proposals`). (2) Knowledge is a
  TREE: path keys, per-folder `_map.md`, tree-rendering `index.md`, name-or-path
  `[[links]]`, dangling/ambiguous-link report fed into grow. (3) Wakeups: a
  `wakeups` table + 60s poller; concierge tools scheduleWakeup/listWakeups/
  cancelWakeup + pendingFindings/resolveFinding; fired wakeups run as concierge
  turns; default daily morning-brief wakeup seeded once per chat (`MORNING_HOUR`,
  default 8), bot-reconfigurable, cancel is durable. New commands `/wakeups`,
  `/proposals`. Verified: typecheck + 31-check functional test on scratch data
  (tree ops, link health, findings parse/lifecycle, wakeup scheduling/recurrence/
  idempotence); live boot migrated the schema and seeded the brief.
- **2026-07-04** — Doc created from the first redesign discussion: audit of
  15 dreams / 1 grow / 30 flat notes, the four-layer framing, proposals
  3.1–3.7, open questions.
