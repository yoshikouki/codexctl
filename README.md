# codexctl

Agent-oriented CLI for controlling Codex app-server jobs.

This repository starts with a small Bun-based proof of concept:

- `codexctl doctor --json` checks the local Codex app-server daemon.
- `codexctl job start --repo . --key demo --prompt "..." --json` runs a Codex turn through `codex app-server --stdio`.
- `codexctl job result demo --json` reads the persisted result.
- `codexctl job events demo --json` streams the persisted event log.

The current PoC is synchronous: `job start` waits for the turn to finish and records events under `.codexctl/jobs/`. Existing job records are preserved unless `--force` is passed.
