# Round 7 — the focus set: woken by change, not by clock

_Planned 2026-07-27. Mehdi's ask: "a focus set … every information flowing in this
system should check if it can update the focus list … a worker that finishes a task
and randomly observes TCP3 merged should escalate it in the background."_

## The finding that shapes this round

The focus set already exists — it is the watched half of `commitments` (#34
ops-tool-pr10, #35 token-leak, #39 2767-sasha-qa, #40 2822-northwind-csvs, #18
posting-to-iris). What is missing is not a ledger. It is:

1. **Cheap verification.** Every pulse fires a FULL concierge turn
   (`runConciergeSystemTurn` → root + attention cards + awareness feed + every
   tool) to run five `gh`/Fibery lookups that usually return "nothing changed".
   ~6 fat turns/day per chat, almost all of them no-ops. That is the token burn.
2. **An escalation channel.** A worker that incidentally sees a focus item move
   has nowhere to put it — `reportBlocked` creates a NEW watch, it does not
   update an existing one.
3. **A ranked surface.** Nothing shows Mehdi the list.

## The principle

> The concierge is woken by CHANGE, not by clock. Checking is code; judging is
> the concierge. Never pay concierge tokens to discover that nothing happened.

## Design

### 1. Shape (SQL, not the tree — focus is time-dependent and fixed-shape)

Additive columns on `commitments` (a focus item IS a watched commitment):

| column | meaning |
|---|---|
| `focus` | 1 = a focus item: ranked in `/focus`, injected into workers |
| `check_cmd` | a DETERMINISTIC command whose stdout is comparable run-to-run |
| `check_state` | last scrubbed output (excerpt, ≤800 chars) — the "before" of a diff |
| `last_seen` | sha256 of the last scrubbed output |
| `last_checked_at` | when the checker last ran it |

`how_to_check` stays: free text for the LLM ("ask Mehdi"). `check_cmd` is the
machine's version. An item may have either or both.

New table `focus_changes` — the escalation queue: `commitment_id`, `source`
(`checker` | `worker`), `observation`, `before`, `after`, `consumed_at`.

### 2. The checker (`src/focus.ts`) — no LLM

Same shape as `watch.ts` (already spawns commands out-of-band and re-invokes on
exit), on a 15-min interval:

- run `check_cmd` (allowlisted prefixes, `cd … &&` chains unwrapped, 60s cap)
- **scrub** volatile tokens (ISO timestamps, `1m2s` durations, "N minutes ago")
  so `gh pr checks` does not diff against itself
- hash → equal? update `last_checked_at`, push `due_at` out 7d, **spend nothing**
- differs? write a `focus_changes` row (before → after), set `due_at = now`
- first-ever check = baseline, never an escalation
- **noise cap**: ≥4 escalations in 24h → absorb silently, mark noisy in `/focus`

The 60s poller then pulses that item — carrying the diff, so the concierge does
not re-fetch what the checker already fetched.

### 3. Worker escalation

- Workers already get the root's "How to behave"; add a compact `## Focus set`
  block (id · what · believed state) to their per-turn injection.
- New worker tool `noticeFocusChange(id, observation)`: writes the row, fires the
  deterministic check to verify, sets `due_at = now`. The worker's own turn is
  undisturbed — it drops a note and continues. A worker's "looks merged" is
  never trusted; `gh` confirms it.

### 4. Concierge

- `commit` gains `checkCmd` + `focus`; `updateCommitment` rescope gains
  `checkCmd`. Guidance: make the command's output SMALL and STABLE
  (`--json state -q .state`), because a stable command is a free check.
- System prompt gets a FOCUS SET block (ranked, with believed state + last
  check) and the doctrine paragraph.
- `[PULSE]` prompt now carries `CHANGED: <before> → <after>` per entry.

### 5. Daytime freshness (the other half of "keep it fresh")

`harvestAll()` is a filesystem scan — free. Run it every 20 min instead of only
at 04:00. Distil at most 3 grown episodes hourly (bounded; the nightly would
have paid for these anyway). A new distilled session becomes a live trigger
rather than a nightly-only one.

### 6. `/focus`

Ranked list for Mehdi: most-recently-changed first, then longest-unchecked.
Shows believed state, last check time, and noisy flags.

## Addendum (2026-07-28) — intake, tiers, and the note diet

Live-testing found the hole. A long session hit a real bug (`tracker_code` is
globally unique, so generated CSVs cannot be reused per client). The system saw
it and recorded it in three places — Fibery #2830, a KB note, a thread — and it
still never reached `/focus`. When Mehdi asked why, the concierge invented a
bar to justify the absence ("a parked backlog item isn't your active ball").

**The real cause: round 7 built only the maintenance half.** The checker,
`noticeFocusChange`, and `/focus` all assume the item already exists. The only
intake was the concierge calling `commit(focus: true)` in chat. The plan quotes
Mehdi's line — *"every information flowing in this system should check if it can
update the focus list"* — and then builds only the update direction.

### The four-way split

| surface | holds | perishes |
|---|---|---|
| Fibery / GitHub | the work item and its state | — (it IS the truth) |
| transcript + distilled recap | what happened, blow-by-blow | never (append-only) |
| **focus set** | that *he* touched it, and it is still open | resolved when it closes |
| knowledge tree | the durable fact + a pointer | never (that is the point) |

### 1. Tiers, not a bar

`focus` becomes an INTEGER TIER, not a flag: 1 = closest to Mehdi, climbing for
quieter bands, plus `focus_band` — the short name the concierge gives that band.
**How many bands exist is decided per-set, by the concierge, from what is
actually in it** (Mehdi's call: "it can be multiple tiers and the system itself
decides how many based on the items"). `focusBands()` groups by the tiers
present, so a set that is all one thing renders as one list.

This dissolves the false choice. **Membership is completeness; tier is
loudness.** #2830 belongs in the set — at a quiet tier, verified every few
minutes by its `check_cmd`, silent until someone assigns or fixes it. That is
affordable precisely because of the round's core mechanism: a checked item that
does not move costs a subprocess, so a complete set costs almost nothing.

### 2. Intake — three new doors

- **Workers**: `trackOpenLoop(what, howToCheck, checkCmd?)` — anything their own
  work leaves open enters at tier 3. `reportBlocked` now enters the set too.
- **Distillation**: the recap schema gains `openLoops[]` — what a session opened
  and did not close, named with anchors. This is the door that would have caught
  #2830: it came out of Mehdi's own terminal session, which reaches no other
  surface unless he mentions it in chat.
- **The nightly**: reconciles the night's fresh open loops against the set
  before anything else, and RE-TIERS every pass (picked up → up, quiet → down).
  `unfocus` is only for what stopped mattering, never for what went quiet.

A daytime distill that surfaces loops fires ONE `[SESSIONS]` concierge turn to
fold them in — a judgment call, so it costs a turn, but only when a real session
actually produced something. Same bargain the checker makes.

### 3. The note diet, tightened

The old mandate ("conclusions plus pointers, not blow-by-blow") was too loose to
apply: "bug + fix captured" reads like a conclusion. The new test is temporal —
**would this sentence still be true after the task closes and the PR merges?**

- Yes → the note. *"`tracker_code` is globally unique across clients, so
  generated CSVs cannot be reused per client."*
- No → not the note. *"Filed as #2830, High, not done yet, fix wanted is
  ignore-conflict + regenerate."* That is state; state lives in the tracker and
  the focus set, both of which move without telling the file.

A work item earns a NAME and a POINTER in its domain map, never a status. §3.9's
perishability counterweight survives intact: the durable fact still lives
inline, so cold-start still works — what leaves is only what was already going
to be wrong within days.

## Explicitly NOT doing

- **Timed memory audits.** A prompt that re-reads the tree on a schedule burns
  tokens proportional to the tree, not to what changed — the same disease as the
  fat pulse. Fact-rechecking hangs off the diff: when an item actually moves,
  that is when the facts around it get re-verified.
- A separate focus table. One ledger, one poller — the round-5 lesson.
