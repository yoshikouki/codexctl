# codexctl

Agent-oriented CLI for controlling Codex app-server jobs.

This repository starts with a small Bun-based proof of concept:

- `codexctl doctor --json` checks the local Codex app-server daemon.
- `codexctl job start --repo . --key demo --prompt "..." --json` runs a Codex turn through `codex app-server --stdio`.
- `codexctl job start --detach --repo . --key demo --prompt "..." --json` starts a detached worker.
- `codexctl job watch demo --json` follows the event log until the job is terminal.
- `codexctl job steer demo --prompt "..." --json` appends a steering command for the worker.
- `codexctl job result demo --json` reads the persisted result.
- `codexctl job events demo --json` streams the persisted event log.

The current PoC supports both synchronous `job start` and detached `job start --detach`. Jobs record state under `.codexctl/jobs/`. Existing job records are preserved unless `--force` is passed.
