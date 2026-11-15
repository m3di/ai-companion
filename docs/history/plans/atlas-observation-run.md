# The observation run — watching the machine think

_Designed 2026-07-31, to be run the same day. Mehdi's ask: "dream to get a fresh
session, then some messages so we can monitor the bot activity, dream again, some
other messages, dream and check the result, then we can re-evaluate the final
target shape."_

The Atlas is live at **http://127.0.0.1:7391** (`ATLAS_PORT` in `.env`; rebuild
the client with `npm run atlas:build`). This is the protocol for the cycle, and —
more importantly — what each step is a TEST OF. Watching pretty lights proves
nothing; each step below has a prediction attached, and the prediction is what
makes the run worth the evening.

---

## What the Atlas will show you

| pulse | colour | what it means |
|---|---|---|
| `probe` | cyan | one entity re-deriving its own state. A sweep is 56 of these rippling through the graph every ~15 min. |
| `entity-change` | amber | a probe found something different. **Loud** = the status flipped (open↔closed) — the event that reshapes the graph. |
| `focus` | pink | a focus item's checker saw a real change. |
| `call` | green | the knowledge API was called, with a light travelling between the entities the call touched. |
| `friction` | red | an agent went *around* the API and read the tree raw. |
| `turn` | blue | a concierge or worker turn started / ended. |
| `tool` | grey | one tool call inside a turn. |
| `operator` | violet | a nightly rewrite starting or finishing. |

A quiet Atlas is not a broken Atlas. Three days of stillness is exactly what the
round-10 pass found, and it took reading four tables to see it.

---

## The protocol

### Step 0 — baseline (2 minutes, before anything)

Open the Atlas, let it settle into the sky view, and just watch one prober sweep
go past. Note whether any node flips amber.

**Prediction:** a clean ripple of ~56 cyan pulses, no amber. If a sweep does NOT
arrive within 15 minutes, the state layer has stalled again and everything below
is moot — that is the regression test for this morning's fix, and it is now
watchable instead of buried in a log.

### Step 1 — `/dream` (fresh session)

Run `/dream` in Telegram. It takes a few minutes.

**Watch for:** a violet `operator` pulse, then a stream of grey `tool` pulses as
the pass reads the tree — this is new as of today; before this evening the night
was a black box between two events. Domain washes light as it reads each folder.

**The prediction that matters, and it is a negative one:** *the graph will not
move.* No amber, no new nodes, no edges. The night rewrites `root.md` and the
prose maps; it has no way to write the entity graph and does not know it exists
(round 10, finding #4). If you watch a full dream and the graph sits perfectly
still while the ticker scrolls, **you have just seen the two-memories problem
directly**, and that is the single most valuable frame of the whole run.

Also watch for **red**. The operator reads the knowledge tree exhaustively, and
as of tonight those reads are recorded as friction for the first time. Every red
flare is a function the API is missing, named by behaviour.

### Step 2 — messages (10–20 minutes of ordinary use)

Talk to the bot the way you normally would. Ask it something it should answer
from memory — ideally something the entity graph *could* answer:

- "what's open in affiliate-app?" → should be `openLoops`
- "what's blocking #3181?" → should be `blockers`
- "which of my open items has been open longest?" → the question that produced a
  confident wrong answer on 2026-07-28, and whose fix (`firstSeen`) is still
  deliberately unbuilt

**Watch for:** green `call` pulses with lights travelling between nodes. **The
prediction is that you will see very few, or none** — the API has been called
three times in its life, all on the day it shipped (finding #5). If the concierge
answers those questions with no green pulse at all, it answered from injected
prose, and you are watching the round-9 premise fail live.

### Step 3 — `/dream` again

Same as step 1, now with a day's real messages in the window.

**Watch for:** whether the second dream's tool pattern differs from the first —
and whether anything it learned in step 2 reaches the graph. (It will not. Same
reason.)

### Step 4 — messages again, then `/dream` a third time

The third pass is the one to read carefully in `/dreams`, because it is the first
that reflects on a window containing *your deliberate probing* rather than
ordinary work.

### Step 5 — read the result

```
/dreams                       # the three night reports
npx tsx src/frictionCli.ts    # the friction ledger + module_use
```

and in the Atlas: which domains lit up, which nodes never lit at all.

---

## The four questions this run is designed to answer

1. **Does the night ever touch the graph?** (Predicted: no. If confirmed by
   observation rather than by grep, round 10 step 3 is settled and non-negotiable.)
2. **Does the day ever call the API?** (Predicted: rarely or never. Determines
   whether the fix is more functions, or the *prompt* — being in the catalog is
   evidently not enough to be used.)
3. **What does the operator actually read?** Now that its tool calls are
   recorded, one night produces more bypass signal than a week of worker traffic.
   That list is the specification for the next round's functions, written by
   behaviour instead of by me.
4. **Which parts of the graph are dead?** 97 of 153 entities have no probe. On
   the Atlas they are the nodes with a dark centre that never pulse. If a whole
   region stays dark through three dreams and a day of messages, it is either
   genuinely timeless — or it is silt, and the graph is carrying weight it should
   not.

---

## Then: re-evaluate the target shape

After the run, revisit `docs/history/plans/round-10-one-memory.md` § "The target shape"
with the evidence in hand. The three things most likely to change:

- **`observed` vs `state`** — if the dreams show the night repeatedly learning
  things that have an obvious home on an entity, the split is confirmed. If the
  night's learnings are mostly *prose-shaped* (arcs, lessons, framing), then the
  graph is the wrong target for them and the two memories are two memories for a
  reason — a genuinely different conclusion, and one worth being open to.
- **Whether the API needs more functions or a different prompt.** Step 2 decides
  this, and they call for opposite work.
- **Whether the Atlas belongs in the loop, not beside it.** If watching turns out
  to be how the two of us actually find these things, that argues for time
  travel (the `entity_changes` scrubber deferred in the spec) sooner than round 11.
