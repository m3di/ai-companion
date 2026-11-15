# Live test — the mint checklist, the linter, and whether the DAY reaches for memory

**Written before the run.** The predictions below are pinned so the result can
falsify them. A test whose expectations are written afterwards measures nothing
but my ability to explain what happened.

## Baseline (2026-08-07 03:22, before the first message)

| | |
|---|---|
| rot / birth | **142 / 6** over 163 entities |
| entities | 163 |
| last dream | #59 @ 2026-08-06 20:27:04 |
| max `entity_writes` id | 159 |
| mints ever | 11 |
| open focus slots | 14 |
| pending observations | 0 |
| pending proposals | 0 |
| open cycle | DAY **0** / NIGHT 15, 3 messages |

## USE REAL INFORMATION

This runs against the live graph, which is Mehdi's actual memory. **Every fact
in the sequence must be true.** A test that feeds it invented work leaves
invented work in the graph, and the linter, the focus set and every future night
will treat it as real. The steps below are SHAPES — fill each with something
that genuinely happened.

If a step has no true content available, skip it and say so. A skipped step is a
smaller test; a fabricated one is a damaged graph.

---

## The sequence

Send `/dream` FIRST to close the current window, so the test gets a clean cycle.

### 1 — Something genuinely new (exercises: mint + the birth checklist)

Tell it about a piece of work it does not know about yet. A new task, a new
repo, a new person, a new constraint. Give it enough to file: what it is, what
it belongs to.

> *"New thing today: <what>. It's part of <existing project/system>."*

**Why:** the night must MINT a node, and since 2026-08-07 a mint is refused
without at least one edge. This is the first mint since that rule existed.

### 2 — A correction (exercises: correct-fact + the visibility fix)

Correct something the bot has said or something you know the graph holds wrongly.
Anything where its picture is out of date.

> *"That's wrong — <the correct version>. It changed on <when>."*

**Why:** corrections append, and until 08-06 `_map.md` rendered only `facts[0]`,
so a correction was the fact LEAST likely to be read. This checks the fix end to
end: write → map → what the next reader sees.

### 3 — A question only memory can answer (exercises: M4, the DAY/NIGHT ratio)

Ask about something from days ago that is not in the current conversation. Not a
web question — a *what do we know* question.

> *"What do we know about <a thing from last week>?"*

**Why:** this is the number the whole round turns on. It has been DAY 0–1 against
NIGHT 15–40 every cycle. If the concierge answers from the transcript instead of
calling `entities.find`, the graph is a store the day does not use.

### 4 — Something you are now waiting on (exercises: the focus measure)

Anything with an outcome you want tracked.

> *"I'm waiting on <person/system> for <thing>."*

**Why:** `cycleCli`'s FOCUS SET line was rewritten on 08-07 — it used to count
checker output diffs and reported "0 change(s)" on a night that closed one slot
and rescoped another. This should now read `+1 entered`.

### 5 — Close it

Send `/dream`.

---

## Predictions

Numbered so each can be marked hit or missed. **A miss is the point** — four of
twenty lint rules were wrong on their first run, and only measuring caught them.

**P1 — the mint carries edges.** Any node minted this cycle has ≥1 authored
edge. *Falsified if:* a new node is isolated, or the night reports a refused
mint it could not satisfy.

**P2 — no new birth defects.** `birth` stays at 6. It cannot rise: the write
path now refuses the only op that could raise it.

**P3 — rot rises by less than the entities added.** New nodes written carefully
should not add much decay. *Falsified if:* rot jumps by more than ~2 per new
entity — which would mean the night writes compound, paragraph-length facts by
default, and the W208 threshold is measuring house style rather than rot.

**P4 — the correction is visible in `_map.md`.** After the dream, the corrected
fact appears in the domain map, not buried behind `facts[0]`.

**P5 — DAY ≥ 1 knowledge call.** The weak prediction, and the one I most expect
to miss. I am not confident: nothing in this round changed the concierge's
prompt to push retrieval harder, and the injected focus set being gone removes a
crutch without adding a habit.

**P6 — FOCUS SET shows `+1 entered`.** With the slot named.

**P7 — the audit's `graph shape` line reports a direction**, not "no previous
count" — the series has two readings already.

**P8 — no reds.** `lintGraph().findings` contains no `E*`. The write path is
supposed to make this impossible; a red would mean a hole in it.

## How I will check

```bash
npx tsx src/cycleCli.ts 1        # the closed cycle: writes, focus, DAY/NIGHT
npx tsx src/lintCli.ts           # rot, birth, per-rule
npx tsx src/auditCli.ts          # graph shape direction, proposals, drift
sqlite3 data/companion.db "select id,op,entity_id,substr(reason,1,80) from entity_writes where id > 159;"
```

---

# RESULT (unattended nightly, dreams #60 and #61)

The scheduled nightly fired before anyone could watch it. That made it a better
test, not a spoiled one: `cycleCli` reads the database retrospectively, and
nothing was staged for an audience.

**5 hit, 2 missed, 1 untested.**

| | | |
|---|---|---|
| P1 mint carries edges | HIT | `owned-by: people/mehdi`. No refusal, no retry, no friction row — the night simply supplied it. |
| P2 birth stays 6 | HIT | 6. |
| P3 rot < ~2 per entity | **MISS** | +3 for one node, **all three W208** |
| P4 correction in `_map.md` | untested | no correction occurred this cycle |
| P5 DAY ≥ 1 | HIT | **DAY 2 / NIGHT 17**, with `readFocus`×1 and `callModule`×2 |
| P6 focus `+1 entered` | MISS | +0 / −0 |
| P7 direction reported | HIT | `rot 145 (UP 3)` |
| P8 no reds | HIT | 0 |

## P3 is the finding

`personal/learning-software-testing` was minted with three facts and **all three
tripped W208**. A rule that fires on 100% of fresh, careful, correct output is
not measuring decay — it is measuring house style, and in a budget it would
charge the night for every fact it ever writes. The ratchet would have failed on
night one.

W208 is not WRONG about the shape; that fact really is three claims welded
together. It is wrong about severity. Splitting compound facts is gardening work
for an agent that can read the evidence, never a gate. Demoted to I308.

**Rot after the demotion: 86.** That is a budget the night can hold.

## P5 hit, and I predicted it would miss

After a run of DAY 0–1 against NIGHT 15–40 every cycle, the day reached for
memory unprompted. One cycle is not a trend, but it is the first movement on the
number M4 turns on, and it moved in the direction I said I was not confident
about.

## Two findings no prediction covered

1. **The night wrote the fact twice** — the graph node AND
   `personal/learning-software-testing.md`, then read the md back through a
   bypass. Eight entities now have two homes. Now counted as I309.
2. **The chain format was wrong** — `message#6497` where the graph's other ~250
   entries say `msg#`. Two entries, both from this mint, both unfollowable, and
   `chain` has no write op so nothing could ever have repaired them. Normalised
   at the write path now.

The night did the right thing before minting: `entities.search("software
testing")` → nothing, THEN mint. Demand-driven growth (I5) working as designed —
the "empty" friction row is the signal, not the fault.
