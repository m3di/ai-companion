# Contributing

Thanks for your interest in `ai-companion`! Issues and pull requests are
welcome.

## Reporting issues

Open an [issue](https://github.com/m3di/ai-companion/issues) with:

- what you expected vs. what happened,
- steps to reproduce,
- your OS, Node version, and anything relevant from the bot logs (with the
  token redacted).

## Pull requests

1. **Fork** the repo and create a branch off `main`.
2. Make your change. Keep it focused — small, single-purpose PRs are easiest to
   review.
3. **Type-check** before pushing:
   ```bash
   npm install
   npm run typecheck
   ```
4. Match the surrounding style: TypeScript, ES modules, and the existing naming
   and comment conventions. Prefer clear code over cleverness.
5. Open a PR against `main` describing the change and why. Link any related
   issue.

A maintainer will review and merge. `main` is protected against force-pushes and
deletion, so history stays clean.

## Local development

```bash
cp .env.example .env   # fill in token, allowed chat id, working dir
npm run dev            # watch mode
```

See the [README](README.md) for full setup and configuration.

## Scope & conventions

- This is a thin, local bridge between Telegram and Claude Code — features
  should keep that "small, runs on your laptop, no extra infra" spirit.
- State lives in SQLite (`src/db.ts`); the multi-session model and bottom
  keyboard live in `src/sessions.ts`. Skim those before larger changes.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
