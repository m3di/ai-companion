# Round 5 — The Unification (implementation plan)

> Instruction document for a fresh context. Self-contained: current state →
> desired state, in four shippable steps. `docs/BRAIN.md` (§3.10, §3.11) is
> the raw idea board / rationale; THIS file is the plan. Where they disagree,
> this file wins. Written 2026-07-07 after rounds 1–4 shipped.

## How to work (project conventions, learned over rounds 1–4)

- **Live bot**: runs locally under `tsx watch src/index.ts` — hot-reloads on
  every `src/` save. Schema migrations run at `db.ts` import: keep them
  idempotent (`CREATE TABLE IF NOT EXISTS`, pragma-guarded `ALTER`s).
- **Verify**: `npm run typecheck` + functional tests on scratch data — set
  `DB_PATH` and `KNOWLEDGE_DIR` env before importing `src/*` from a `.mts`
  script (top-level await needs a file, not `tsx -e`). Prior test examples
  lived in the session scratchpads; write fresh ones per step.
- **Live passes** (defrag/nightly) can be run without touching the bot: a
  small script with a plain `sendMessage` transport (fetch to the Telegram
  Bot API — no polling, no conflict). Pattern:
  `const transport = { send: fetch(api.telegram.org/bot$TOKEN/sendMessage), edit/delete/react/typing: noop }`,
  `chatId = [...config.allowedChatIds][0]`, then call the pass function.
- **Backups before every destructive live run**: `data/backups/<date>-<label>/`
  with `sqlite3 data/companion.db ".backup …"` + `cp -R data/knowledge` +
  a RESTORE.md with exact retry commands. The reconstruction defrag also
  leaves the old tree at `data/knowledge/.archive/` and auto-restores on
  failure.
- **Commit per step on main.** Update `docs/BRAIN.md` (decision log +
  changelog) as decisions land; keep the auto-memory roadmap note current.
- **Sandbox rule (non-negotiable)**: night/defrag agents get NO
  Bash/Task/Agent/web tools — the toolset is the boundary. `src/` + prompts
  changes are operator-gated (`proposal` → `/proposals`), never self-applied.

## Current state (what exists after round 4)

**Stores.** SQLite `data/companion.db`: `messages` (full text log),
`sessions` (thread key → Claude session id → transcript at
`~/.claude/projects/<proj>/<id>.jsonl`), `chat_sessions` (slot, title,
status active|closed, `memo`, auto-`recap`, last_active), `session_prefs`,
`chat_state`, `shared_memory` (global facts, ~1.2k chars), `events`
(awareness one-liners), `waiting` (blocked items: what/blocked_on/
how_to_check/next_check_at/thread_slot/status), `wakeups` (label/prompt/
fire_at/recur/status/created_by; `nightly-pipeline` + `morning-brief` are
system rows dispatched by label), `dreams` (nightly reflections, coverage
windows, processed_at), `findings` (kinds: memory-fix|knowledge|behavior|
reminder|proposal|idea; status pending→applied/delivered/scheduled/
dismissed), `grows` (change log incl. `[defrag]` rows), `usage` (per-turn
tokens/cost; `latestContextInfo` = compaction sensor), `pending_inbox`,
`repos`, `route_log`, `message_routes`, legacy `notes`.

**Knowledge tree** `data/knowledge/` (gitignored instance data, NOT a git
repo): domain folders, each `_map.md` = 60-second briefing ending in LEADS;
≤2 depth notes/domain; `identity/` (RESERVED — 7 habit notes, moveNote
refuses boundary crossings, `identityContext()` caps at 6k chars);
`ideas/` (lifecycle prefix in summary); generated `index.md`
(`rebuildIndex()`); `.archive/` = pre-reconstruction tree. `linkHealth()`
must stay clean; `[[folder/_map]]` is a valid link target.

**Actors & injection.**
- *Concierge* (slot -1, resets every 30 turns): prompt = identity block +
  thread index (ALL active threads w/ recaps — the unbounded part) + today's
  events + waiting ledger + shared memory + `treeIndex()` + workspace +
  retrieval-ladder text. Tools (bot server, `src/concierge.ts`): thread mgmt
  (listThreads/readThread/dispatchTask/newThread/switchThread/setThreadMemo/
  setThreadMode/closeThread), get/setSharedMemory, digestSource, readNote/
  writeNote/deleteNote, noteIdea, recordBehavior, searchMessages,
  locateThreadTrace, scheduleWakeup/listWakeups/cancelWakeup, addWaiting/
  listWaiting/updateWaiting, pendingFindings/resolveFinding; + telegram UI
  server (`src/ui.ts`: send/ask/askUserQuestion/setMemo/recallNotes/
  readNote/saveFinding).
- *Workers* (full Claude Code preset, permission-gated via
  `createCanUseTool`; SAFE_TOOLS auto-allowed): per-turn `appendContext` =
  identity + shared memory + bulletin (≤15 lines) + workspace + side-channel
  nudges (built in `dispatch.ts` runTurn). Worker bot server
  (`src/workerTools.ts`): reportBlocked, noteIdea, searchMessages,
  locateThreadTrace; + the telegram server (incl. saveFinding = direct note
  write).
- *Nightly* (a `nightly-pipeline` wakeup, code-dispatched in `index.ts`):
  `runDream` (read-only reflect over a windowed digest — identity, shared
  memory, threads w/ ≥50%-context flags, treeIndex, waiting, corrections,
  last 400 msgs at 700/300 char caps + omission marker → prose + typed
  findings; code schedules `"at"` reminders as one-off wakeups) then
  `runGrow` (applies memory-fix/knowledge/behavior/idea findings; tools:
  file tools in tree + moveNote/deleteNote + listThreads/setThreadMemo +
  shared memory + waiting tools; maps+leads regime).
- *Defrag* (`/defrag`, manual): `archiveTreeForReconstruction()` moves all
  but identity/+ideas/ to `.archive/`; agent reconstructs (domains → one
  map each ending in leads; depth ≤2/domain; conservation inverted:
  everything is trace-recoverable); `restoreArchivedTree()` on failure.
- *Clockwork* (`index.ts`): 60s poller fires due wakeups (advance-before-
  run) + batches due `waiting` into `[PULSE]` concierge turns (auto-defer
  +4h first); worker turn end → `setRecap` + `postEvent`; 20-min idle
  watchdog; title refresh from SDK session summary.

**Known pain (why round 5):** ~15 mechanisms for ~6 functions; blanket
worker injection (global everything, task context accidental); concierge
thread index unbounded (~20+ active threads, most finished one-shots);
waiting/wakeups duality; 6 finding kinds as user-visible machinery;
memo vs recap redundancy; shared memory vs identity vs root facts split.

## Desired state (the target, from BRAIN §3.10/§3.11)

One bounded retrieval tree over one unbounded trace, one rewrite operator:

1. **ROOT NODE** — `data/knowledge/root.md`, reserved like `index.md`
  (excluded from noteFiles; NOT a note). Hard cap ~10k chars with an
  over-budget flag (like identityContext today). Sections (exact headings,
  code-parsable): `## How to behave` (absorbs identity habits, provenance
  kept), `## Domains` (one line per domain folder), `## Global facts`
  (absorbs shared_memory), `## Now` (few volatile lines: active focus,
  open commitments count). Only the rewrite operator and defrag write it
  (plus `recordBehavior`, which becomes "append/merge a habit line in
  `## How to behave`"). Injection: concierge gets the whole root; workers
  get ONLY `## How to behave` + their brief.
2. **TASK BRIEFS + CONTEXT CARDS + GUIDANCE** — `chat_sessions.brief`
  column; dispatchTask/newThread compose a brief (task, relevant root
  lines, domain-node excerpt + leads, artifacts, non-goals) — stored AND
  sent as the seed. `updateBrief(slot, guidance)` appends a `[GUIDANCE]`
  message to the worker queue + updates the stored brief. Context card =
  title + brief (first ~2 lines) + latest recap + artifacts; rendered for
  the concierge instead of memo lines. Blanket worker injection dies:
  appendContext = root `## How to behave` + "your brief:" + dig-tool
  nudges only. `setThreadMemo`/`memo` retire (title stays; auto-title
  stays).
3. **BOUNDED ATTENTION SET + THREAD LIFECYCLE** — concierge prompt lists:
  running threads + threads with open commitments + ~8-10 most recently
  active; count line for the rest ("N archived — findThread to search").
  New status `'archived'`: auto-archive threads idle >7 days with no open
  commitment (nightly operator distills durable residue first — reuse the
  compaction-watch muscle — then archives + posts an observation).
  `findThread(query)` searches title/brief/recap/messages across ALL
  statuses; revive = set active (session id persists → warm). closeThread
  (user-confirmed) remains as manual archive.
4. **COMMITMENTS** — one prospective table replacing wakeups + waiting:
  `commitments(id, chat_id, label, body, due_at, recur, how_to_check NULL,
  thread_slot NULL, status, created_by, last_fired_at, resolution)`.
  Firing loop: due + `how_to_check IS NULL` → fire like today's wakeup
  (concierge turn with stored body; `nightly-pipeline` label still
  code-dispatched); due + how_to_check → batch into one `[PULSE]` turn
  (advance-before-run stays: auto-defer +4h). Tools collapse:
  `commit(label, when, body, howToCheck?, recur?)`, `listCommitments`,
  `updateCommitment(defer|resolved|dropped)`. Migrate existing rows
  (active wakeups incl. morning-brief/nightly-pipeline; open waiting
  entries). Keep old tables dormant for rollback; delete code paths.
5. **ONE REWRITE OPERATOR** — `src/operator.ts` with
  `runRewrite(transport, chatId, scope: 'nightly' | 'reconstruction')`
  replacing dream+grow (nightly) and defrag (reconstruction):
  - *nightly*: ONE agent, tree write access + commitments/proposal/thread
    tools; digest = root + cards + observation tail + windowed timeline
    (keep 400/700/300 caps + omission marker + non-overlapping windows that
    only advance on success). Mandate: rewrite touched domain nodes +
    root's volatile lines; keep every node bounded and true; reminders →
    `commit(...)` directly (keep local-time `"at"` semantics); code/prompt
    changes → a `proposal` finding (the ONLY finding kind left); distill +
    archive idle threads; journal one row (keep `dreams` table as the
    journal, `grows` as the change log via snapshot diff — storage compat,
    no migration).
  - *reconstruction*: today's defrag flow (archive → rebuild → restore on
    failure) with the same prompt PLUS "build/rebuild `root.md` first".
  - `findings` writes stop except `kind='proposal'`; pendingFindings/
    resolveFinding tools trim to proposals; `/proposals` unchanged.
    `ideas/` machinery retires → "Open possibilities" lines on domain maps
    (operator ages them); `noteIdea` tool → appends to the relevant map's
    possibilities (or drop the tool; decide by prompt-size economy).
  - `/dream` `/grow` become aliases of the nightly rewrite; `/defrag` =
    reconstruction.
6. **RETRIEVAL COUNTERS** — `retrievals(key, kind, count, last_at)`;
  bump in readNote, locateThreadTrace, findThread. Surface top/never-used
  in the operator's digest ("attention data") for promote/decay decisions.
  Cheap, no UI.

**Explicitly KEEP untouched:** messages/transcripts/usage (episodic layer,
raw); searchMessages/locateThreadTrace; reply-routing, capture/process,
/stats, /dreams, /grows viewers (rename copy if trivial); permission
system + SAFE_TOOLS; transport seam; morning brief behavior (now a
commitment); backups/.archive/restore; operator gate; identity evidence
bars (explicit 1×, inferred 2× across days) — now governing root habit
edits.

**Out of scope for round 5:** multi-user (audience/provenance frontmatter,
per-user root overlays), embeddings/associative recall, salience scoring.
Note them in BRAIN.md as round 6 candidates; design nothing that blocks
them.

## Step plan (each: implement → typecheck → scratch tests → backup →
live verify → commit)

**Step 1 — Root node + injection swap.**
`knowledge.ts`: `rootPath()`, `rootContext()` (whole file, capped),
`rootSection('How to behave')` parser, exclusion from noteFiles;
`recordBehavior` rewires to edit the behave section. `dispatch.ts`:
worker appendContext → behave-section + brief placeholder + dig nudges;
concierge prompt → whole root (drop identity+shared blocks).
`concierge.ts`/`grow` prompts: swap wording. Migration: build the first
root.md by RUNNING A RECONSTRUCTION DEFRAG whose prompt (already updated
in this step) includes root-building; shared_memory content folds into
`## Global facts`; identity/ bodies fold into `## How to behave`
(retire identity/ folder after verifying rootSection ≈ old
identityContext). get/setSharedMemory tools retire after migration.
*Acceptance:* every agent prompt sources from root; `identityContext`
callers gone; live defrag produced a root ≤ cap; links clean.

**Step 2 — Briefs, cards, guidance, findThread, attention set.**
Schema: `chat_sessions.brief TEXT`, status `'archived'`. Tools: brief
param on dispatchTask/newThread (required for dispatch), updateBrief,
findThread; retire setThreadMemo + memo column reads (keep column,
dormant). Concierge prompt: context cards + bounded attention set +
reuse-first routing text; `/sessions` shows attention set + archived
count. *Acceptance:* concierge prompt size constant vs thread count
(test: seed 30 threads on scratch, assert prompt length); dispatch
stores brief; findThread revives archived thread and it resumes its old
session id.

**Step 3 — Commitments.** Schema + data migration (active wakeups + open
waiting → commitments; verify morning-brief and nightly-pipeline rows
migrated with recur intact and fire on schedule next day). One firing
loop in index.ts (wakeup-style + pulse-style by how_to_check); tools
collapse in concierge/worker/grow servers (reportBlocked → creates a
commitment). `/wakeups` → `/commitments` (keep old command as alias).
*Acceptance:* scratch test of both firing modes + recurrence + advance-
before-run; live: brief fires next morning from the new table.

**Step 4 — Operator unification + retirements + lifecycle mechanics.**
`src/operator.ts` (nightly + reconstruction scopes); delete dream.ts/
grow.ts/defrag.ts after porting (keep thin `/dream`→nightly aliases);
findings→proposals-only; ideas machinery retires (fold current 2 ideas
into their domain maps); auto-archive + distill-first in the nightly
scope; retrieval counters wired into readNote/locateThreadTrace/
findThread and surfaced in the operator digest. *Acceptance:* one live
nightly run end-to-end (script transport): rewrites a touched map,
archives an idle one-shot thread with a final observation, files a
reminder as a commitment, journal + change-log rows written, links
clean, root under cap. Then a live reconstruction to re-balance
everything under the final regime.

**Rollback per step:** step 1: restore knowledge backup + revert commit
(shared_memory table untouched until step verified); step 2: statuses/
columns are additive; step 3: old tables kept dormant — revert code,
copy rows back if needed; step 4: previous night agents restorable from
git; backups before each live pass.

## Final acceptance (the round is done when)

1. A brand-new agent onboards from `root.md` alone and can answer: who am
   I working for, how do I behave, what domains exist, where do I dig —
   the rebirth probe (run it: fresh context, root only, 5 questions).
2. Worker per-turn injection = behave section + brief pointer (measure a
   dispatched worker's first-turn prompt).
3. Concierge prompt size is independent of total thread count.
4. Exactly 3 curated stores remain (root, tree, commitments) on 2
   mechanical layers (observation stream, traces); grep proves
   shared_memory/memo/ideas/waiting/wakeups code paths are gone.
5. Nightly = ONE agent run; `/defrag` = reconstruction incl. root.
6. All growth axes bounded: root cap, node budgets, attention set,
   bulletin tail, identity-in-root cap — only messages/transcripts grow.
