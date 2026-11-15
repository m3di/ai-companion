# ai-companion

A Telegram-fronted Claude Code companion with a self-maintaining memory: a
concierge (the only door), background workers, an entity **graph** as the store,
a nightly operator that maintains it, and the **Atlas** — a live graph view.

## Read this first

**[docs/CHARTER.md](docs/CHARTER.md) — the Charter.** It fixes the destination
(*the Colleague*), the invariants, the open shape forks, and the milestones.
**Read it at the start of every session, before proposing or building anything.**

**Start every session by reading the machine, not the docs:**

```bash
npx tsx src/auditCli.ts    # health: suite, typecheck, probes, checks, friction, API use, inbox
npx tsx src/inboxCli.ts    # what the day captured and the night has not folded
npx tsx src/cycleCli.ts    # per cycle (day + its dream): who read memory, what changed, footprint
```

`cycleCli --open` is the live window since the last dream — the one you are
inside while testing. Its first line is the question M4 turns on: **did the DAY
reach for memory, or only the night?**

Both report every input whether or not it fired, so they answer "is anything
broken, and is the last few days' work actually being used?" before you decide
what to build. The audit runs the suite, so give it a minute.

Working rules that follow from it:

- **Chase a number that moves, do not explain it.** On 2026-08-02 the friction
  ledger was watched going 12 rows → 0 → 1 and written off as live churn; it
  was the live database being deleted, three hours before anyone looked. An
  anomaly narrated is an anomaly missed — the human version of Charter I8.
- **Take one small step per session**, inside the current milestone, and add a
  dated line to the Charter's changelog. The system runs live between sessions —
  each step should survive a night of real use before the next lands.
- **Every change names the invariant it serves or the milestone it advances.**
  A change that serves neither is a bug fix, or it doesn't belong yet.
- **Run every new idea through the Charter's idea test** (which invariant? which
  milestone? what does it delete? how will we know it worked?) and log the
  verdict in *Ideas measured* — including rejections, with the reason.
- **Never break an invariant silently.** Each was bought with a real failure. If
  one has to give, amend the Charter first, in its own commit.

## Operator mode — working on the machine instead of with it

The bot is in exactly one of **three** states, and it is the first thing to
establish before touching anything:

| state | what it means | who may act |
|---|---|---|
| `live` | the day answers, the night folds, the probes tick | everything, plus the operator READ-ONLY |
| `dreaming` | a rewrite pass holds the machine | nothing at all |
| `debug` | sedated; the tree is snapshotted | the operator only |

There is a fourth condition that is **not** a mode and is easy to miss because
the chip still reads LIVE underneath it: a **night owed**. The fold is the day's
termination routine, so it is a precondition of the next day (Charter I11) — and
while one is unfolded every day activity is refused, however late it has become.
It pays itself within a minute; if it cannot wait, `/cancelnight <why>`, the
Atlas chip, or `modeCli cancel-dream "<why>"` stops the pass, rolls back what it
wrote, and opens the day. `vitalsCli` prints the debt loudly for the same reason
the refusal names it: "the bot is LIVE" is a true and useless answer to someone
whose message just bounced.

**Dreaming outranks debug and is not a peer of it.** Debug is a *session* — a
snapshot, a baseline write id, a reason — and dreaming is a *phase* over it, so
an induced `/dream` from debug reads as `dreaming` for its duration and hands
the machine back afterwards with the session intact. While a pass holds it,
nothing runs: not a turn, not a sweep, and not a gardening prompt, because a
dream is the day's termination routine and anything writing memory during one is
writing into a context being replaced under it. It is also the one state you
cannot click your way out of — it ends when the pass lands.

LIVE is the state in which it is impossible to work ON the bot, because
everything moves while you look. **Debug** is the other one — open-brain
surgery, with the patient sedated and the incision reversible.

**Asking is free; changing is what debug buys.** The operator's agent runs while
the bot is LIVE — it reads anything and writes nothing, enforced at `applyWrite`
rather than in its prompt — so a question about memory never costs a day. When
it concludes a change is needed it calls `propose()`, and **sedate & apply**
does the sedation and the work in one click.

The Atlas's **mode chip** (top bar) both reports the state and is the only door
through it: green LIVE, amber DEBUG, violet DREAMING; its dot is the live feed,
its label the work state. The **top bar tints** amber in debug and violet while
dreaming. A **grey graph** means you are in `/runs` and the graph is evidence
for a run — never "the bot is sedated". Those are two facts and they get two
signals: tying them together left the ledger in full colour while live, where
the footprint highlight was invisible against twelve hues.

```bash
npx tsx src/modeCli.ts debug "why you are opening it"   # sedate
npx tsx src/vitalsCli.ts                                # read the vitals
npx tsx src/gardenRunCli.ts open --linter               # or: open "<your instruction>"
#   ... work: record() calls, code changes, an induced /dream, an audit ...
npx tsx src/gardenRunCli.ts close <id> "what I did AND skipped"
npx tsx src/modeCli.ts exit              # keep  (clears the concierge context)
npx tsx src/modeCli.ts exit --rollback   # discard (leaves the context alone)
```

**1 · Sedate.** `debug` suspends every day activity — turns, workers,
commitments, wakeups, probe and focus sweeps, harvest, distil, the automatic
nightly — and snapshots the whole knowledge tree. Nothing reaches the
concierge's context. Gardening, an induced dream and every read still work.
Commands still work, because a mode you cannot leave from where you entered is
a trap (I8). The state is in the DATABASE: the runner restarts the process on
every source edit, which is exactly what you do while debugging.

**2 · Read the vitals.** `vitalsCli` is free by design — no subprocess, no
model, no network — because a check you pay a minute for is a check you skip.
It answers *what state is this thing in*, where `auditCli` answers *is anything
broken* and costs a minute. Use both, in that order.

**3 · Operate.** A **run** is one attempt to change the graph, with a stated
intent. Two ways in and the only difference is where the intent comes from:
`--linter` (the findings choose) or a prompt (you choose). Both record the same
object, which is what makes them comparable — you cannot judge a hand-written
instruction against an automatic one if only one is written down.

**The run is the unit of review, not the write.** Nine writes are nine rows you
can audit one at a time; *"this prompt produced those nine and touched these
six nodes"* is a judgement about the PROMPT, and rewording the prompt is how
the editing gets better. The Atlas's **runs panel** (bottom-left) is that
surface: what was asked, what changed, what was skipped. A run with two writes
and a paragraph about what it left alone is usually the better run.

**4 · Decide.** `exit` keeps the work and clears the concierge context, because
memory moved under a context built on the old one. `exit --rollback` restores
the tree byte for byte and leaves the context alone — that is the point: an
experiment that turns out to be scaffolding costs the day nothing.

### The proposal channel — how the bot asks for a change

A **design proposal** is how a conversation with the bot ("the morning
routine no longer works for me") or a night's friction becomes work for the
developer. It is a row, not a file: the day and the night open it, attach
evidence and amend it; **only a developer session decides**, and the decision
writes the Charter's *Ideas measured* table. `auditCli` lists what is open.

```bash
npx tsx src/proposalCli.ts                 # open / accepted / landed
npx tsx src/proposalCli.ts show <id>       # problem, design, evidence trail
npx tsx src/proposalCli.ts accept <id> "<verdict>" --invariant .. --milestone .. --deletes .. --measure ..
npx tsx src/proposalCli.ts land <id> <commit>   # then the nightly audit runs its verify
```

The loop is: **open → accepted → landed → verified** (or rejected, or merged).
A landed proposal without a `verify` command is blind and the audit says so.
Never write a proposal as a file under `docs/`; that is a second home (I1).

### Watching it happen

The Atlas (`ATLAS_PORT` in `.env`) halos every node a write touches, live, from
any process — a write, its run, and the whole attempt on close. `/api/mode`,
`/api/runs` and `/api/vitals` are the same data for anything else that wants it.

## The other docs

- [docs/history/BRAIN.md](docs/history/BRAIN.md) — the running design log: why we changed our
  minds, round by round.
- [docs/plans/round-*.md](docs/plans/) — per-round working plans. Round 12
  (`round-12-the-body.md`, the Swift body as a second transport, M7) is the
  live one; round 11 (the story tree) is landed; round 10's step 3 was M2.
- [docs/history/ROADMAP.md](docs/history/ROADMAP.md) — the original phase plan. Historical;
  superseded from round 10 by the Charter.

## Layout

| path | what |
|---|---|
| `src/entities.ts` | the entity grammar, parser and lint — the graph's teeth |
| `modules/entities/` | the callable knowledge API (`find`, `graph`, `record`, …) |
| `src/operator.ts` | the nightly pass — the night's metabolism |
| `src/focus.ts`, `focusView.ts` | the focus set: the attention spine |
| `src/prober.ts` | the state clock; the only writer of `state` |
| `src/concierge.ts`, `dispatch.ts` | the day: the only door, and the worker fleet |
| `src/knowledge.ts` | the md tree (being converged into the graph — M5) |
| `web/`, `src/atlas.ts` | the Atlas — the operator's backdoor |
| `data/knowledge/` | live instance data: `root.md` + per-domain entity files |

## Before you finish

```bash
npm run typecheck
npm test
```

Both must be green. A red suite that reaches nobody is exactly the failure the
Charter's I8 and milestone M2 exist to prevent.
