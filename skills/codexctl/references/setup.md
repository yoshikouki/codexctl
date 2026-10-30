# Setup

Requires Bun and an installed Codex with app-server support. Sandboxing, approvals, and authentication use Codex's own settings.

## Run from source

Run at the root of the codexctl repository:

```sh
bun install
bun run src/cli.ts --help
```

If the CLI is installed, use `codexctl --help`. Help returns JSON with a `usage` field. Before starting Codex through a job, decide on the task and target repository.

## Install the skill

Point your skill manager at `skills/codexctl/`. To update the instructions, edit the originals in this repository and reinstall them through the manager. Check `src/cli.ts` and the implementation for command behavior, and keep the README, agent contract, and skill consistent.
