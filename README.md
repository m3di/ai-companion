# 🤖 ai-companion

> Drive **Claude Code** from a Telegram chat — run several coding sessions at once, switch between them with a tap, and approve actions from your phone.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

`ai-companion` runs on your own machine, long-polls Telegram, and relays your
messages to Claude Code through the
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript).
It's a pocket remote control for Claude Code: ask it to fix a bug on the train,
watch the live progress, tap **Allow** on a command, and read the diff — all
from Telegram.

It uses your existing Claude Code login (no API key required) and keeps state in
a small SQLite file. No server, no database to run, no RAG — Claude Code reads
your files directly.

---

## ✨ Features

- **Many sessions, one chat.** A persistent keyboard at the bottom of the chat
  lists every session. Tap one to switch to it; the rest keep running in the
  background and surface their state through badges (`🟢` running · `❗` needs
  permission · `❓` waiting on a question · `✅` done).
- **Catch-up on switch.** Attaching to a session replays its last few messages
  and, if it's still working, resumes a live status feed.
- **Live status.** A single message edits itself in place to show the current
  action plus an expandable activity log, with a **🛑 Stop** button.
- **Approve from your phone.** Tools that change things prompt inline —
  **✅ Allow · ⛔ Deny · ♾️ Always allow** — unless the session's permission mode
  auto-approves them.
- **Rich UI the model can compose.** Claude can send formatted messages,
  link/quick-reply buttons, and tappable multiple-choice questions (see
  [Telegram UI tools](#-telegram-ui-tools)).
- **Quick state at a glance.** Each of your messages gets a reaction:
  ✍️ working · 👀 queued · 👍 done · 🤔 cancelled · 😱 errored.
- **Per-session working directory and resumable context**, persisted across
  restarts in SQLite.
- **Dynamic system prompt** in `prompts/system.md`, re-read every turn — edit it
  anytime, no restart.
- **Tight access control** — only allow-listed chats can drive the bot.

---

## 🧭 How it fits together

```
                 ┌──────────────────────── one Telegram chat ───────────────────────┐
                 │   ▶ 🟢 api #1     ✅ scraper #2     ❗ deploy #3     ➕ New        │  ← bottom keyboard
                 └───────────────────────────────────────────────────────────────────┘
                            │ tap to switch              every session keeps running
                            ▼
Telegram ──getUpdates──▶ bot (grammy) ──askClaude()──▶ Claude Agent SDK ──▶ Claude Code
   ▲                        │   │                                            (resumable)
   └──── replies ───────────┘   └── SQLite: sessions · prefs · message log
```

Each session maps to a resumable Claude Code session (`<chatId>:<slot>`),
serialized so one turn runs at a time per session while independent sessions run
concurrently.

---

## 🚀 Quick start

**Prerequisites:** Node ≥ 20 and a Claude Code login (`claude` → `/login`).

```bash
git clone https://github.com/m3di/ai-companion.git
cd ai-companion
npm install
cp .env.example .env       # then fill it in (see below)
```

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) → `/newbot` →
   copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Pick a working directory** — set `CLAUDE_WORKING_DIR` to the folder Claude
   should operate in.
3. **Find your chat ID** — run `npm run dev`, message the bot; it replies with
   your chat ID. Put it in `ALLOWED_CHAT_IDS` and restart.
4. **Say hi** — message the bot, pick a permission mode, and you're driving
   Claude Code from Telegram.

```bash
npm run dev        # watch mode (auto-reload)
npm start          # run once
npm run typecheck  # tsc --noEmit
```

---

## ⚙️ Configuration

All configuration is environment variables (see [`.env.example`](.env.example)):

| Variable             | Required | Description                                                                 |
| -------------------- | :------: | --------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` |    ✅    | Bot token from @BotFather.                                                   |
| `ALLOWED_CHAT_IDS`   |    ✅    | Comma-separated chat IDs allowed to use the bot. Empty = nobody.             |
| `CLAUDE_WORKING_DIR` |    ✅    | Directory Claude Code operates in (its file-access root).                    |
| `PERMISSION_MODE`    |          | Default permission mode for new sessions (`default` · `acceptEdits` · `bypassPermissions`). |
| `CLAUDE_MODEL`       |          | Model override, e.g. `claude-opus-4-8`. Empty = SDK/CLI default.            |
| `SYSTEM_PROMPT_PATH` |          | Path to the dynamic system prompt. Default `prompts/system.md`.             |
| `DB_PATH`            |          | SQLite path. Default `data/companion.db`.                                    |

### Permission modes

When you start a session you choose how it handles tools:

- **⚡ Auto** — works autonomously, only stopping for genuinely risky actions.
- **✏️ Accept edits** — file edits run automatically; commands still ask you.
- **🔐 Ask each** — prompts before every command and edit.

---

## 💬 Commands

| Command       | What it does                                                          |
| ------------- | -------------------------------------------------------------------- |
| `/sessions`   | Show / refresh the bottom session keyboard.                          |
| `/new`        | Start another session (you pick its permission mode).               |
| `/close`      | Close the current session and remove it from the keyboard.          |
| `/history`    | Reopen a previously closed session.                                 |
| `/cancel`     | Stop the turn running in the current session.                       |
| `/cwd [path]` | Show or set the current session's working directory.               |
| `/status`     | Session info: Claude session id, message count, working dir, mode.  |

Tapping a session button on the bottom keyboard switches the active session.

---

## 🎛️ Telegram UI tools

The bot exposes a small MCP server so Claude can compose Telegram UI directly,
instead of only plain text:

- **`send`** — a message in Telegram HTML with optional inline buttons
  (expandable details, spoilers, code, link/quick-reply buttons).
- **`ask`** — one quick question with tappable options; blocks for the answer.
- **`askUserQuestion`** — up to four structured questions at once, each option
  carrying a one-line explanation. (The built-in `AskUserQuestion` needs an
  interactive terminal it doesn't have here, so this renders the same thing as
  Telegram buttons.)

---

## 🔒 Security

A Telegram bot token is effectively public, and this bot can run tools on your
machine. Two things keep that safe:

1. **Allowlist** — only chats in `ALLOWED_CHAT_IDS` are served; everyone else is
   refused. Keep it tight.
2. **Permission mode** — start with **Ask each** or **Accept edits** and only
   move to **Auto** once you trust a given workspace.

`.env` and `data/` are git-ignored. Never commit your token.

---

## 🗂️ Project structure

```
src/
├── index.ts        entry point — boots the bot + graceful shutdown
├── telegram.ts     bot wiring: commands, callbacks, turn queue
├── sessions.ts     multi-session model, bottom keyboard, attach/switch
├── claude.ts       Claude Agent SDK wrapper (normalizes events)
├── permissions.ts  inline Allow/Deny/Always-allow tool gating
├── ui.ts           Telegram UI tools (send / ask / askUserQuestion)
├── liveStatus.ts   the self-editing live status message
├── format.ts       Markdown/HTML formatting + tool summaries
├── db.ts           SQLite schema + queries
└── config.ts       env-var configuration
```

---

## 🤝 Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
In short: fork, branch, `npm run typecheck`, open a PR against `main`.

## 📄 License

[MIT](LICENSE) © Mehdi
