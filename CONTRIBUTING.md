# Contributing

`ai-companion` is a research system with one operator (see the
[README](README.md)). Issues, questions and pull requests are welcome; the
bar for a change is the same one its maintainer works to.

## Before you propose a change

Read [docs/CHARTER.md](docs/CHARTER.md). Every change names the invariant it
serves or the milestone it advances, and a new idea answers the Charter's four
questions — which invariant, which milestone, what does it delete, how will we
know it worked. A good issue usually reads like a row in
[docs/DECISIONS.md](docs/DECISIONS.md).

## Reporting issues

Open an [issue](https://github.com/m3di/ai-companion/issues) with what you
expected, what happened, and the steps. Output from `npx tsx src/vitalsCli.ts`
or `src/auditCli.ts` helps — **redact it first**: it prints your instance's
own entity names and messages.

## Pull requests

1. Branch off `main`; keep the change small and single-purpose.
2. Run the gate:
   ```bash
   npm run typecheck
   npm test
   ```
   `npm test` runs against a snapshot of your instance's database; on a fresh
   clone a few state-reading tests fail by design (README → Tests). Say which
   ones in the PR.
3. Match the surrounding style: TypeScript ES modules, and comments that say
   *why* — usually the incident that made the rule necessary.
4. Add a dated entry to [docs/CHANGELOG.md](docs/CHANGELOG.md).
5. Never commit `.env`, `data/`, or anything from a real instance — names,
   messages, entity ids.
