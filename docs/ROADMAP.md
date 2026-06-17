# ai-companion — Roadmap

> A living document. We update it **as we build**, not once up front. Each phase
> has checkboxes; check them off in the same PR that ships the work, and add a
> dated line to the [Changelog](#changelog).

_Last updated: 2026-06-17 (initial)._

---

## North star

Evolve ai-companion from "drive Claude Code from Telegram" into a **team knowledge
system** that learns from how a company actually uses it. The engine is a
flywheel:

```
messages → dream → dream-records → grow → committed knowledge → better answers → more messages
```

- **SQLite = the firehose** — what happened (sessions, messages, routing). Short-term memory.
- **`knowledge/` = the git-tracked brain** — what we learned (curated note-units, linked, reviewable). Long-term memory.
- **dream** and **grow** are the two transforms between them: dream compacts the firehose into records; grow promotes records into committed knowledge.

The goal is to **harvest the best data**: every interaction makes the next answer
better, until the bot is the master of the team's workflow and process.

---

## Decisions (the load-bearing ones)

| Date | Decision | Why |
|---|---|---|
| 2026-06-17 | **Grow is knowledge-only.** It rewrites/reorganizes `knowledge/` + `index.md`; it never edits `src/`. | Make `knowledge/` its own git repo and grow's sandbox *is* that repo — it physically cannot touch code. Worst case is a bad knowledge edit, fixed by `git revert`. Removes the scariest risk for free. |
| 2026-06-17 | **Internal tool first**, not a product. | Optimize for one team (whoever runs the bot); prove the flywheel on real data. Multi-tenant/productization deferred. Pushes integrations (issue tracker, GitHub, cluster) *up* in priority (richer answers → richer harvested data). |
| 2026-06-17 | **Abstract the transport adapter now.** | Extract a `ChatAdapter` interface from `telegram.ts` while there's exactly one adapter to factor out. Telegram + (later) Slack become two implementations of one core. |
| 2026-06-17 | **No git inside the knowledge dir** (revised). | Originally the knowledge base was its own git repo with auto-commits + a `grow` revert. Reversed: the dir is plain **gitignored instance data**, never a git repo — a nested repo creates a parallel history that drifts from the public app repo, and "knowledge is just ignored data" is the cleaner mental model. `grow` applies edits directly to the files and records a change-log to a `grows` table instead of committing; review is via `/grows`. |
| 2026-06-17 | **The concierge is the only door** (one interaction model). | The bot had two contradictory models — original "active thread / tap to switch / you're now in X" vs. "concierge + reply-routing" — and the UI lied about where messages went. Unify: the chat always talks to the concierge; it spawns/supervises workers and speaks for them; replying to a worker is a *momentary* direct line. Remove `activeSlot`/attach, `/new`, `/sessions`-as-switcher, the `classifier` routing mode, and `pin`/`auto`. This is the only model that survives Phase-2 group chat, and it makes the WorkSession/QuerySession split real. Merges into seam slice 3. |

---

## Current state (baseline, 2026-06)

Already built:

- **Concierge + workers** — concierge on slot `-1` (control/query), worker sessions on slots `0+` (parallel Claude Code jobs), composite key `<chatId>:<slot>`.
- **Shared memory + notes KB** — Claude-digested note-units (`key`/`summary`/`content` with `[[links]]`) in the SQLite `notes` table; concierge indexes them and reads on demand.
- **Dream** — offline reflection pass (`src/dream.ts`), currently **dry-run + read-only**: posts a report to chat and forgets it.
- **Routing** — reply-routing + a learned classifier; routing corrections logged.
- **Workspace registry** — `repos` table; scan/register local git repos with path/remote/branch/conventions.
- **Live status + memos** — per-turn self-editing status message; per-thread memo for recap.

Not yet built (the gaps this roadmap closes): **grow**, persisted dreams,
git-tracked knowledge + bootstrap protocol, work/query session typing, multi-user
identity, Slack, deployment (Docker/k8s/PVC), credential store + progressive access.

---

## Phases

### Phase 0 — Substrate + seam  ·  ✅ done

The unlock. Most of the value-at-risk lives here; everything downstream depends on it.

- [ ] **Transport seam** — extract a `ChatAdapter` interface (`sendMessage`, `editMessage`, buttons, reactions, update loop) from `telegram.ts`; Telegram becomes `TelegramAdapter`. Core talks only to the interface. _In progress — staged in 3 slices:_
  - [x] Slice 1 — `ChatAdapter`/`ChatTransport` contract (`src/transport/types.ts`) + `TelegramAdapter` owning the grammy lifecycle (runner, stall-watchdog, command menu, boot); `index.ts` is now transport-agnostic.
  - [x] Slice 2 — migrated every outbound `Api` consumer (`RunningView`/`LiveStatus`, `ui`, `permissions`, `concierge`, `dream`) onto `ChatTransport` with `OutgoingMessage`/`Buttons`. grammy now lives only in `telegram.ts` (inbound handlers) and the adapter.
  - [x] Slice 3 — inbound events normalized in the adapter; the dispatcher (`src/dispatch.ts`, replacing `telegram.ts`) is transport-agnostic; grammy is gone from everything but `src/transport/telegram.ts`. **Merged with the concierge-only rebuild:** chat → concierge, reply → momentary worker line; visibility is a per-turn flag (no active slot). Removed `activeSlot`/attach, `/new`/`/pin`/`/auto`/`/close`/`/history`/`/cwd`/`/bot`, the classifier router (`router.ts` deleted), and the concierge `setRouting`/connect-through-switch semantics.
  - _Markup is carried as opaque format-tagged text for now; a cross-platform markup IR is deferred to the Slack adapter (Phase 2), when there's a second consumer to design it against._
- [x] **Knowledge → files** — `src/knowledge.ts` is the file-backed note store: one `<key>.md` per note (frontmatter + body with `[[links]]`) + a generated `index.md`, in `KNOWLEDGE_DIR` (default `data/knowledge`). Plain gitignored instance data — **not** a git repo (see Decisions). `chatId` dropped → one shared brain. The 15 legacy SQLite notes migrated on first boot (idempotent); the `notes` table stays only as the migration source. `digest`, `concierge`, and `ui` read/write files now.
- [x] **Bootstrap protocol** — `index.md` carries the KB protocol (how to read/add notes, the `[[link]]` convention); the bot's agents reach it through the existing `recallNotes`/`readNote`/`writeNote`/`digestSource` tools. _(A `CLAUDE.md` inside the knowledge repo — for when `grow` operates there directly — comes with Phase 1.)_
- [x] **`dreams` table** — dream reflections persist to a `dreams` table (`id`, `chat_id`, `report`, `created_at`, `processed_at`) instead of post-and-forget. `runDream` saves each genuine report; `grow` (Phase 1) consumes `pendingDreams()` and stamps `markDreamProcessed()`. A `/dreams` command lists them (`/dreams <id>` for the full report).
- [x] **Session typing + rolling recap** — the WorkSession/QuerySession split is realized by the concierge-only model (concierge = query/control layer; workers = work layer; per-turn visibility). Each worker now also keeps an auto **recap** (a `recap` column, refreshed from its latest output after every turn, no LLM call); the concierge index and `/sessions` board surface it, so "what's X doing?" is answerable without re-reading the thread.

### Phase 1 — Close the loop, on our own data  ·  🔄 in progress

The crown jewel — the part nobody else has. Prove it on ourselves before exposing it to a team.

- [x] **Dream nightly** — `index.ts` schedules `runDream` for each allowed chat at `NIGHTLY_HOUR` (default 04:00); records persist to the `dreams` table (Phase 0). So reflections accumulate unattended.
- [x] **Build `grow`** (`src/grow.ts`, `/grow`) — operator-triggered. Reads `pendingDreams()` + the knowledge dir (its working dir = `KNOWLEDGE_DIR`, sandboxed — Read/Write/Edit/Glob/Grep, no Bash, can't touch app code), refines the notes (merge/split/fix/re-link/tighten), regenerates `index.md`, **applies the edits directly to the files (no git)**, records what changed to a `grows` change-log (prose summary + per-file before/after, diffed via `snapshotNotes`), posts the summary + change list, and marks the consumed dreams processed. `/grows` lists passes (`/grows <id>` for the full log).
  - _Verified end-to-end on real data: 2 backfilled dreams → grow created a note, refreshed a stale one, cross-linked, and correctly declined out-of-scope (code) changes._
- [ ] **Dogfood** until grow's commits are consistently good (run `/dream` to seed reflections, then `/grow`; revert any weak passes).

### Phase 2 — Get the team on it  ·  ⬜ not started

- [ ] `SlackAdapter` (second impl of the Phase-0 seam).
- [ ] Multi-user identity (`user_id` in the schema; per-person attribution → better dream signal).
- [ ] Docker + k8s + PVC — knowledge repo + sqlite on the volume. Real, diverse team data feeds a *proven* flywheel.

### Phase 3 — Capability (still internal)  ·  ⬜ not started

- [ ] Encrypted credential store on the PVC + keygen + a runtime "grant me github/fibery/cluster access" flow.
- [ ] Wire the Fibery MCP, `gh`, cluster access so answers are worth harvesting. Each new capability widens what the flywheel ingests.

---

## Changelog

- **2026-06-17** — **Removed git from the knowledge dir** (design reversal). The knowledge base is now plain gitignored files — no nested git repo, no auto-commit on note writes, no `grow` commit/revert (a nested repo would create a parallel history that drifts from the public app repo). `grow` now applies edits directly and records a change-log to a new `grows` table (prose summary + per-file before/after, diffed via `snapshotNotes`); the existing `data/knowledge/.git` was removed. Added a `/grows` viewer (list + `/grows <id>`), mirroring `/dreams`. Dropped `commitKnowledge`/`revertKnowledge` and the `gr:` revert callback.
- **2026-06-17** — **Phase 1 — the flywheel is closed.** `dream` now runs nightly (scheduled in `index.ts` at `NIGHTLY_HOUR`, default 04:00, per allowed chat) so reflections accumulate on their own. Built **`grow`** (`src/grow.ts`, `/grow`): a knowledge-only librarian that reads `pendingDreams()` + the knowledge repo, refines the notes in its sandboxed working dir (no app-code access), regenerates `index.md`, lands one revertible `grow:` commit, posts a summary with a ↩️ Revert button, and marks dreams processed. Added `commitKnowledge`/`revertKnowledge`/`rebuildIndex` to `src/knowledge.ts` (commit/revert lifecycle verified). The `messages → dream → dream-records → grow → committed knowledge` loop now runs end-to-end; what remains is dogfooding it.
- **2026-06-17** — Phase 0 **rolling worker recap** → **Phase 0 complete**. Each worker keeps an auto `recap` (new `chat_sessions.recap` column) refreshed from its latest output after every turn — no LLM call, can't go stale like a memo. The concierge thread index and `/sessions` board prefer it, so "what's that worker doing?" is answerable without re-reading. With this, the substrate phase is done: transport seam, concierge-only model, git-tracked knowledge, persisted dreams, and the WorkSession/QuerySession split + recap. Next: **Phase 1 — the flywheel** (schedule `dream` nightly + build `grow`).
- **2026-06-17** — Phase 0 **`dreams` table**: dream reflections now persist (`db.saveDream`) to a `dreams` table with a `processed_at` flag, so they're no longer post-and-forget — `grow` will consume `pendingDreams()` and stamp `markDreamProcessed()`. Added a `/dreams` viewer (list + `/dreams <id>` full report). The dream stays read-only/dry-run; only its output is now captured. This is the last raw-material piece before the Phase 1 flywheel.
- **2026-06-17** — Phase 0 **Knowledge → git-tracked files**: new `src/knowledge.ts` replaces the SQLite `notes` table with a file-backed, git-tracked base — one `<key>.md` per note (frontmatter + `[[links]]`) + a generated protocol-headed `index.md`, in its own git repo under `KNOWLEDGE_DIR` (default `data/knowledge`), auto-committing each write. Dropped `chatId` (one shared brain). 15 legacy notes migrated on first boot (idempotent). `digest`/`concierge`/`ui` now read & write files; SQLite stays the firehose. This is the substrate `dream`-persistence and `grow` stand on.
- **2026-06-17** — Worker messages now carry a `🔧 <title>` marker (answers, file-op notices, the live-status card, and `send`/`ask`/permission prompts); the concierge stays unmarked as the default voice. Makes "which message is a worker's — and which to reply to" unambiguous, closing the discoverability gap in the reply-to-worker model.
- **2026-06-17** — Phase 0 transport seam, slice 3/3 + the concierge-only interaction rebuild (one pass): the `TelegramAdapter` now normalizes inbound updates into `message`/`command`/`callback` events and owns the access gate; `telegram.ts` became the transport-agnostic `dispatch.ts`; grammy is confined to `src/transport/telegram.ts`. **Interaction model unified:** the chat always talks to the concierge, workers are background and surface through it, replying to a worker is a momentary direct line, and a turn's visibility is fixed at start (no active/attached thread). Removed `activeSlot`/attach, `/new`/`/pin`/`/auto`/`/close`/`/history`/`/cwd`/`/bot`, the classifier router (`router.ts`), and the concierge's `setRouting` + connect-through-switch. Typecheck green. **Transport seam complete.**
- **2026-06-17** — `TelegramAdapter` now handles a fatal runner error (e.g. 409 Conflict from a second instance polling the same token) with one clear log line + clean exit, instead of an uncaught-exception stack dump. The stall-watchdog's restart reuses the same handled path.
- **2026-06-17** — Phase 0 transport seam, slice 2/3: ported all outbound `Api` consumers onto `ChatTransport` (`liveStatus`, `sessions`/`RunningView`, `permissions`, `ui`, `concierge`, `dream`); replaced grammy `InlineKeyboard` with the transport's `Buttons` model. grammy is now contained to `telegram.ts` (inbound) + the adapter. Behaviour unchanged; typecheck green.
- **2026-06-17** — Phase 0 transport seam, slice 1/3: added the `ChatAdapter` contract (`src/transport/types.ts`) and `TelegramAdapter` (`src/transport/telegram.ts`) owning the grammy runner, watchdog, command menu, and outbound API; `index.ts` now constructs the adapter and is transport-agnostic. Handler wiring still grammy-native (slices 2–3).
- **2026-06-17** — Roadmap created. Captured the flywheel model, the three load-bearing decisions, and Phases 0–3.
