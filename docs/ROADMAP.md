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
| 2026-06-17 | **Internal tool first**, not a product. | Optimize for the BackendArchitects team; prove the flywheel on real data. Multi-tenant/productization deferred. Pushes Fibery/GitHub/cluster integrations *up* in priority (richer answers → richer harvested data). |
| 2026-06-17 | **Abstract the transport adapter now.** | Extract a `ChatAdapter` interface from `telegram.ts` while there's exactly one adapter to factor out. Telegram + (later) Slack become two implementations of one core. |

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

### Phase 0 — Substrate + seam  ·  ⬜ not started

The unlock. Most of the value-at-risk lives here; everything downstream depends on it.

- [ ] **Transport seam** — extract a `ChatAdapter` interface (`sendMessage`, `editMessage`, buttons, reactions, update loop) from `telegram.ts`; Telegram becomes `TelegramAdapter`. Core talks only to the interface. _In progress — staged in 3 slices:_
  - [x] Slice 1 — `ChatAdapter`/`ChatTransport` contract (`src/transport/types.ts`) + `TelegramAdapter` owning the grammy lifecycle (runner, stall-watchdog, command menu, boot); `index.ts` is now transport-agnostic.
  - [ ] Slice 2 — migrate outbound `Api` consumers (`RunningView`, `ui`, `permissions`, `dream`, `concierge`) onto the transport; drop their grammy imports.
  - [ ] Slice 3 — normalize inbound events; port `telegram.ts` handlers off grammy `Context`; delete the `createBot` grammy island.
  - _Markup is carried as opaque format-tagged text for now; a cross-platform markup IR is deferred to the Slack adapter (Phase 2), when there's a second consumer to design it against._
- [ ] **Knowledge → git-tracked files** — migrate the `notes` table into a standalone `knowledge/` git repo: `index.md` (protocol + index) + one `.md` per note-unit (frontmatter + `[[links]]`). Files are source of truth; the digest pipeline writes files; concierge reads them. SQLite stays the firehose.
- [ ] **Bootstrap protocol** — `prompts/system.md` and a `CLAUDE.md` inside `knowledge/` point every agent at `knowledge/index.md` (the "first agent wakes up → reads index.md → has the KB protocol" path).
- [ ] **`dreams` table** — persist dream output as structured records.
- [ ] **Session typing** — model `WorkSession` (owns a task/PR/branch, long-lived) vs `QuerySession` (ephemeral, read-only), plus a **rolling recap** auto-updated per turn so many askers read the recap, not the whole thread.

### Phase 1 — Close the loop, on our own data  ·  ⬜ not started

The crown jewel — the part nobody else has. Prove it on ourselves before exposing it to a team.

- [ ] Schedule **dream nightly**; persist structured dream-records instead of post-and-forget.
- [ ] Build **grow** — operator-triggered, reads recent dream-records + current `knowledge/`, reorganizes/rewrites the knowledge repo (re-categorize, split sub-systems, refresh `index.md`), commits to a branch to skim. Knowledge-only → low blast radius.
- [ ] Dogfood until grow's branches are consistently good.

### Phase 2 — Get the team on it  ·  ⬜ not started

- [ ] `SlackAdapter` (second impl of the Phase-0 seam).
- [ ] Multi-user identity (`user_id` in the schema; per-person attribution → better dream signal).
- [ ] Docker + k8s + PVC — knowledge repo + sqlite on the volume. Real, diverse team data feeds a *proven* flywheel.

### Phase 3 — Capability (still internal)  ·  ⬜ not started

- [ ] Encrypted credential store on the PVC + keygen + a runtime "grant me github/fibery/cluster access" flow.
- [ ] Wire the Fibery MCP, `gh`, cluster access so answers are worth harvesting. Each new capability widens what the flywheel ingests.

---

## Changelog

- **2026-06-17** — Phase 0 transport seam, slice 1/3: added the `ChatAdapter` contract (`src/transport/types.ts`) and `TelegramAdapter` (`src/transport/telegram.ts`) owning the grammy runner, watchdog, command menu, and outbound API; `index.ts` now constructs the adapter and is transport-agnostic. Handler wiring still grammy-native (slices 2–3).
- **2026-06-17** — Roadmap created. Captured the flywheel model, the three load-bearing decisions, and Phases 0–3.
