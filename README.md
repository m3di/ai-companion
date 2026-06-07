# ai-companion

A local app that turns a Telegram chat into a single, persistent **Claude Code**
session. It runs on your laptop, long-polls Telegram, and relays messages to
Claude Code via the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript).

- **Telegram chat = one Claude Code session.** Resumed across messages via the
  SDK's `resume` option. `/new` starts fresh when context fills up.
- **Dynamic system prompt** lives in `prompts/system.md`, appended to Claude
  Code's own prompt and re-read on every turn — edit it anytime.
- **State** is SQLite (`data/companion.db`): chat→session mapping + message log.
  No Postgres, no RAG — Claude Code reads your files directly.

## How it fits together

```
Telegram  ──getUpdates──▶  bot (grammy)  ──askClaude()──▶  Claude Agent SDK ──▶ Claude Code
   ▲                          │  │                              (resumable session)
   └────── replies ───────────┘  └── SQLite: session id + log
```

## Setup

1. **Create a bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` →
   copy the token.
2. **Auth Claude**: log in once with the Claude Code CLI (`claude` → `/login`)
   so the SDK reuses your subscription. No API key needed.
3. **Install**: `npm install`
4. **Configure**: `cp .env.example .env`, paste `TELEGRAM_BOT_TOKEN`, set
   `CLAUDE_WORKING_DIR` to the directory Claude should operate in.
5. **Find your chat ID**: run `npm run dev`, message the bot. It replies with
   your chat ID. Put it in `ALLOWED_CHAT_IDS` and restart.

## Run

```bash
npm run dev      # watch mode
npm start        # one-off
npm run typecheck
```

## Commands

- `/new` — clear the session and start fresh.
- `/status` — current session id, message count, working dir, permission mode.

## Security

A Telegram bot token is effectively public. **Only chats listed in
`ALLOWED_CHAT_IDS` can drive Claude Code** — everyone else is refused. Because
the bot can run tools on your machine, keep the allowlist tight and pick
`PERMISSION_MODE` deliberately (`acceptEdits` to start, `bypassPermissions` for
the full hands-off experience).
