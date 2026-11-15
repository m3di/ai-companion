# ai-companion

> A Claude Code companion with a memory that maintains itself. You talk to one
> concierge; background workers do the work; an entity **graph** holds what was
> learned; a **night** folds each day into it and audits its own machinery; the
> **Atlas** lets the operator see everything it knows and everything it did.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

**What this is.** One person's working system, published as a design: it has
run daily since June 2026 and every rule in it was bought with a real failure,
written down with the date and the number that exposed it. It runs, and you can
run it — but it is a research system with one operator, not a turnkey product.
The parts most worth reading are the [invariants](docs/CHARTER.md#the-invariants)
and the [decisions](docs/DECISIONS.md), not the setup.

---

## The shape

```
            Telegram ─┐                         ┌─ Companion.app (macOS, voice, presence)
                      ▼                         ▼
                 ┌──────────────── the day ────────────────┐
                 │  concierge — the only door              │
                 │     ├─ workers (Claude Code sessions)   │
                 │     ├─ commitments, focus set, probes   │
                 │     └─ observe() → the inbox            │
                 └────────────────────┬────────────────────┘
                                      │ refs on every read and write
                                      ▼
                 ┌──────────── the graph (the store) ──────┐
                 │  entities per domain (.jsonl)           │
                 │  record() is the only write path        │
                 │  state = probe-owned · observed = night │
                 └────────────────────┬────────────────────┘
                                      ▲
                 ┌──────────────── the night ──────────────┐
                 │  audit the machine → fold the inbox →   │
                 │  garden → rewrite the story tree        │
                 └─────────────────────────────────────────┘
                                      │
                                      ▼
                     the Atlas — live graph, runs, mode, vitals
```

- **One door.** Every message reaches the concierge. Workers run in the
  background and report through it; replying to a worker's message is a
  one-off direct line, never a mode you get stuck in.
- **The graph is the store.** Knowledge is typed entities in per-domain files,
  written only through `record()`, linted on every parse. Every fact has one
  home; maps, briefs and the root are *renders* of it.
- **The night is the metabolism.** It opens by auditing the machine itself
  (suite, typecheck, probes, friction, cost), then folds the day's inbox into
  the graph, gardens it, and rewrites the story the next day boots from. A day
  cannot begin until its night has ended — and the night can always be
  cancelled, which rolls back what it wrote.
- **Measured, not assumed.** Reads and writes carry refs, so "did the day
  actually use its memory?" is a query (`cycleCli`), not a hope. The
  [Charter](docs/CHARTER.md#where-it-stands--2026-11-16) states where each
  milestone honestly stands, including the ones that are not working yet.
- **Operator mode.** The bot is `live`, `dreaming`, or `debug`. Debug sedates
  the day and snapshots the knowledge tree so you can operate on memory and
  then keep or roll back the result, byte for byte.
- **Two transports, plus voice.** Telegram when you are away; a native Mac app
  (the *body*) when you are at the desk, which knows you are there. Voice in is
  transcribed locally (whisper.cpp); voice out is spoken locally (Piper).

## Reading the machine

The system reports on itself through CLIs, each of which prints every input
whether or not it fired:

```bash
npx tsx src/vitalsCli.ts     # free, instant: what state is it in
npx tsx src/auditCli.ts      # is anything broken (runs the suite — give it a minute)
npx tsx src/cycleCli.ts      # per day+night: who read memory, what changed, what it cost
npx tsx src/inboxCli.ts      # what the day captured that the night has not folded
npx tsx src/proposalCli.ts   # design proposals the bot opened for its developer
npx tsx src/modeCli.ts debug "why"   # sedate the day to work on it; `exit` / `exit --rollback`
```

## Running it

**Needs:** Node ≥ 20, a Claude Code login (`claude` → `/login`; no API key),
a Telegram bot token. Optional: `ffmpeg` + `whisper-cpp` for voice in, Piper
for voice out, Swift 6.2 on macOS for the body.

```bash
git clone https://github.com/m3di/ai-companion.git && cd ai-companion
npm install
cp .env.example .env            # token, allowed chat id, working dir — see below
npm run atlas:install && npm run atlas:build   # the Atlas client, once
npm run dev                     # watch mode; `npm start` to run once
```

Message the bot once; it replies with your chat id. Put it in
`ALLOWED_CHAT_IDS` and restart. Then just talk to it. The Atlas is at
`http://127.0.0.1:$ATLAS_PORT`. `npm run body` builds the Mac app, which
`npm start` then launches alongside the bot ([body/README.md](body/README.md)).

The graph starts empty. Domains, entities and the story grow from what you do
with it; nothing about a particular person ships in this repo.

### Chat commands

| | |
|---|---|
| *(any message)* | the concierge |
| `/status` · `/sessions` | overview · worker threads |
| `/focus` · `/commitments` | what deserves attention now · reminders, routines, watched items |
| `/find <phrase>` · `/episodes` | search past work · work harvested from your local Claude Code sessions |
| `/capture` · `/process` | queue notes silently all day · triage them |
| `/cancel` | stop all running work |
| `/dream` · `/cancelnight <why>` | run the night now · stop it and roll it back |
| `/debug` · `/live [rollback]` | sedate the day · resume, keeping or discarding changes |
| `/voice` | pick and calibrate the speaking voice |
| `/proposals` · `/repos` | proposed changes · workspace repos |

### Configuration

Everything is environment variables; [`.env.example`](.env.example) documents
each one. The ones you must set:

| variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `ALLOWED_CHAT_IDS` | who may use the bot; empty means nobody |
| `CLAUDE_WORKING_DIR` | where Claude Code operates; `WORKSPACE_DIR` holds the repos it may touch |

Also commonly set: `CLAUDE_MODEL` / `CONCIERGE_EFFORT` (the concierge and the
night), `WORKER_MODEL` / `WORKER_EFFORT` (workers it doesn't size itself),
`NIGHTLY_HOUR`, `MORNING_HOUR`, `ATLAS_PORT`, `PERMISSION_MODE`.

### Tests

```bash
npm run typecheck
npm test
```

`npm test` snapshots the instance's own database (`data/companion.db`) into
`data/tmp/` and runs against the copy — several tests check real state, by
design (see [I13](docs/CHARTER.md#the-invariants) for why the snapshot step is
guarded). On a fresh clone with no database it runs against an empty one, and
those tests fail; the rest are self-contained.

## Layout

| path | |
|---|---|
| `src/concierge.ts`, `dispatch.ts` | the day: the only door, turns, the worker fleet |
| `src/entities.ts`, `entityWrite.ts` | the graph's grammar, parser, lint and write path |
| `modules/entities`, `modules/graph` | the callable knowledge API (`find`, `record`, `history`, …) and graph measurements |
| `src/operator.ts`, `night.ts`, `gardener.ts`, `storyTree.ts` | the night: audit, fold, garden, the story |
| `src/prober.ts`, `focus.ts`, `commitments.ts` | the state clock, the attention set, dated plans |
| `src/mode.ts`, `runs.ts`, `debugAgent.ts` | operator mode and the runs it records |
| `src/*Cli.ts` | the machine's self-reports |
| `src/atlas.ts`, `web/` | the Atlas server and its React client |
| `src/transport/`, `body/` | Telegram, and the Swift Mac app |
| `src/transcribe.ts`, `speak.ts` | local voice in and out |
| `data/` | the instance: SQLite, knowledge tree, voice — git-ignored |

## Docs

| | |
|---|---|
| [docs/CHARTER.md](docs/CHARTER.md) | the destination, the 13 invariants, the milestones and where each stands — **start here** |
| [docs/DECISIONS.md](docs/DECISIONS.md) | every idea measured, accepted or rejected, with its reason |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | one dated entry per step |
| [docs/plans/](docs/plans/) | the live round's working plan |
| [docs/history/](docs/history/) | the original design log and the plans of landed rounds |
| [CLAUDE.md](CLAUDE.md) | how an agent session works on this repo |

## Security

A bot token is effectively public, and this bot runs tools on your machine.
Only chats in `ALLOWED_CHAT_IDS` are served. Start workers on `default` or
`acceptEdits` and move to `auto` only for workspaces you trust. The Atlas binds
to `127.0.0.1` and has no auth — do not expose it. `.env` and `data/` are
git-ignored; never commit either.

## License

[MIT](LICENSE) © Mehdi
