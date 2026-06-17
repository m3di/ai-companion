# 🤖 ai-companion

> A team chatbot that **runs real work** and **learns from it.** Talk to a concierge in chat; it spawns Claude Code worker sessions to do the work, and a nightly **dream → grow** loop turns everything that happened into a curated, git-tracked knowledge base. Start empty, and let it grow into the brain of your team's workflow.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

`ai-companion` runs on your own machine (or a container), long-polls a chat
surface, and drives [Claude Code](https://platform.claude.com/docs/en/agent-sdk/typescript)
through the Claude Agent SDK. It uses your existing Claude Code login — no API
key required — and keeps state in a small SQLite file plus a git-tracked
knowledge directory. No server, no separate database, no RAG — Claude Code reads
your files directly.

It's a **general framework**: clone it, point it at your repos, and grow your own
companion. This repo ships the engine; your bot's knowledge lives only on your
machine.

---

## 🧠 The idea

```
                        you ─────────────▶  🎛️ Concierge  ─── spawns ──▶  🔧 workers
                     (just talk)            (one front door)              (Claude Code sessions)
                                                  │                            │
                                                  ▼                            ▼
                            SQLite (the firehose: sessions, messages)   work on your repos
                                                  │
                              nightly  ──▶  💤 dream  ──▶  dream records
                                                                │
                              operator ──▶  🌱 grow  ◀──────────┘
                                                  │
                                                  ▼
                                   knowledge/ (git-tracked curated brain)
                                                  │
                                                  └──▶ read by every future turn
```

- **One front door.** You always talk to the **concierge**. It answers, manages
  threads, and hands real work to **worker** sessions. Worker messages are tagged
  `🔧 <title>` — reply to one to talk to that worker directly.
- **Workers** are parallel, resumable Claude Code sessions. They run in the
  background and report through the concierge; one you're watching streams live.
- **The flywheel.** SQLite is the short-term firehose (what happened).
  `knowledge/` is the long-term brain (what we learned). Two transforms connect
  them: **dream** compacts recent activity into reflections; **grow** promotes
  those reflections into committed, curated knowledge. Every interaction makes
  the next answer better.

---

## 🚀 Quick start

**Prerequisites:** Node ≥ 20 and a Claude Code login (`claude` → `/login`).

```bash
git clone https://github.com/m3di/ai-companion.git
cd ai-companion
npm install
cp .env.example .env        # then fill it in (see below)
```

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) → `/newbot` →
   copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Pick a working directory** — set `CLAUDE_WORKING_DIR` to where Claude should
   operate; `WORKSPACE_DIR` is the folder holding the repos it may touch.
3. **Find your chat ID** — run `npm run dev`, message the bot; it replies with
   your chat ID. Put it in `ALLOWED_CHAT_IDS` and restart.
4. **Say hi** — just tell the concierge what you need.

```bash
npm run dev        # watch mode (auto-reload)
npm start          # run once
npm run typecheck  # tsc --noEmit
```

---

## 💬 Talking to it

There is exactly **one** interaction model, so nothing is ambiguous:

- **Plain message → the concierge.** It decides what to do: answer, manage
  threads, or delegate work to a worker.
- **Reply to a `🔧` worker message → that worker.** A one-off direct line; your
  next plain message is back with the concierge. You never "switch into" a thread.
- **Background work** runs quietly and the concierge reports it when done; work
  you ask to watch streams into the chat, tagged with its worker's title.

### Commands

| Command       | What it does                                                   |
| ------------- | -------------------------------------------------------------- |
| `/sessions`   | Status board of your worker threads.                           |
| `/capture`    | Toggle capture mode — queue notes/forwards silently all day.   |
| `/process`    | Triage everything captured and fan it out to threads.          |
| `/cancel`     | Stop all running work in this chat.                            |
| `/repos`      | List, add, or scan your workspace repos.                       |
| `/dream`      | Run an offline self-reflection over recent activity now.       |
| `/dreams`     | List saved reflections (`/dreams <id>` for the full report).   |
| `/grow`       | Refine the knowledge base from recent reflections.             |
| `/status`     | Concierge + worker overview.                                   |

---

## 🌱 The knowledge flywheel

- **Knowledge base** — `KNOWLEDGE_DIR` (default `data/knowledge`) is a
  **git-tracked** directory of markdown notes: one `<key>.md` per note
  (frontmatter + body, cross-linked as `[[other-key]]`) plus a generated
  `index.md`. Workers and the concierge read and write it through their tools, and
  every write auto-commits — so the brain has real, reviewable history.
- **dream** — a read-only reflection pass (scheduled nightly at `NIGHTLY_HOUR`,
  or on demand via `/dream`). It reviews recent activity and the bot's memory and
  records a report to the `dreams` table. It changes nothing.
- **grow** — operator-triggered (`/grow`). It reads the unprocessed dreams and the
  knowledge base, then **refines the notes** (merge duplicates, fix stale facts,
  split, re-link, tighten) and lands **one reviewable commit** — with a one-tap
  **↩️ Revert**. Grow's working directory *is* the knowledge repo, so it can never
  touch the bot's source.

The knowledge directory is each deployment's own — it's git-ignored from this
repo and persists on your machine (or a PVC), never in the framework.

---

## 🎛️ Telegram UI tools

The bot exposes a small MCP server so Claude can compose chat UI directly instead
of only plain text:

- **`send`** — a message in Telegram HTML with optional inline buttons.
- **`ask`** — one quick question with tappable options; blocks for the answer.
- **`askUserQuestion`** — up to four structured questions at once.

A worker also has knowledge tools (`recallNotes` / `readNote` / `saveFinding`) so
hard-won answers are saved once and reused, and a `setMemo` tool to keep its
thread labeled.

---

## ⚙️ Configuration

All configuration is environment variables (see [`.env.example`](.env.example)):

| Variable             | Required | Description                                                                 |
| -------------------- | :------: | --------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` |    ✅    | Bot token from @BotFather.                                                   |
| `ALLOWED_CHAT_IDS`   |    ✅    | Comma-separated chat IDs allowed to use the bot. Empty = nobody.             |
| `CLAUDE_WORKING_DIR` |    ✅    | Directory Claude Code operates in (its file-access root).                   |
| `WORKSPACE_DIR`      |          | Root holding your cloned repos. Default: the parent of `CLAUDE_WORKING_DIR`. |
| `PERMISSION_MODE`    |          | Default mode for worker tools (`default` · `acceptEdits` · `auto`).         |
| `CLAUDE_MODEL`       |          | Model override, e.g. `claude-opus-4-8`. Empty = SDK/CLI default.            |
| `KNOWLEDGE_DIR`      |          | Git-tracked knowledge base. Default `data/knowledge`.                       |
| `NIGHTLY_HOUR`       |          | Hour (0–23) to run the nightly dream. Default `4`.                          |
| `SYSTEM_PROMPT_PATH` |          | Path to the dynamic system prompt. Default `prompts/system.md`.             |
| `DB_PATH`            |          | SQLite path. Default `data/companion.db`.                                    |

The system prompt in `prompts/system.md` is re-read every turn — edit it anytime,
no restart.

---

## 🔒 Security

A bot token is effectively public, and this bot runs tools on your machine. Two
things keep that safe:

1. **Allowlist** — only chats in `ALLOWED_CHAT_IDS` are served; everyone else is
   refused. Keep it tight.
2. **Permission mode** — start workers on **Ask each** or **Accept edits** and
   only move to **Auto** for workspaces you trust.

`.env` and `data/` (your SQLite + knowledge base) are git-ignored. Never commit
your token or your instance's knowledge.

---

## 🗂️ Project structure

```
src/
├── index.ts          entry point — boot, nightly scheduler, graceful shutdown
├── transport/
│   ├── types.ts      the ChatAdapter contract (transport-agnostic)
│   └── telegram.ts   Telegram adapter: grammy runner, events, outbound API
├── dispatch.ts       the transport-agnostic core: turns, routing, commands
├── sessions.ts       worker views, per-turn visibility, status badges
├── concierge.ts      the concierge agent + its bot-management tools
├── claude.ts         Claude Agent SDK wrapper (normalizes events)
├── permissions.ts    inline Allow/Deny/Always-allow tool gating
├── ui.ts             Telegram UI tools (send / ask / knowledge tools)
├── liveStatus.ts     the self-editing live status message
├── format.ts         Markdown/HTML formatting + tool summaries
├── db.ts             SQLite schema + queries (the firehose)
├── knowledge.ts      the git-tracked knowledge base (files + commits)
├── dream.ts          offline self-reflection → dreams table
├── grow.ts           the knowledge-base librarian (dreams → committed notes)
├── digest.ts         digest a document into knowledge notes
├── workspace.ts      the workspace repo registry
└── config.ts         env-var configuration
```

The chat surface is chosen in one place (`index.ts`). The core talks only to a
`ChatAdapter`, so a second transport (e.g. Slack) is a new adapter, not a rewrite.

---

## 🤝 Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
In short: fork, branch, `npm run typecheck`, open a PR against `main`.

## 📄 License

[MIT](LICENSE) © Mehdi
