# codexctl

Agent-oriented CLI for controlling Codex app-server jobs.

This repository starts with a small Bun-based proof of concept. Non-help public commands require `--json` so agent callers can depend on a stable output mode:

- `codexctl doctor --json` checks the local Codex app-server daemon.
- `codexctl job start --repo . --key demo --prompt "..." --json` runs a Codex turn through `codex app-server --stdio`.
- `codexctl job start --detach --repo . --key demo --prompt "..." --json` starts a detached worker.
- `codexctl job start --approval-policy untrusted ...` asks app-server to route more actions through approval.
- `codexctl job start --sandbox read-only ...` overrides the app-server sandbox mode for that job.
- `codexctl job list --json` summarizes local job records.
- `codexctl job watch demo --json` follows the event log until the job is terminal.
- `codexctl job steer demo --prompt "..." --json` appends a steering command for the worker.
- `codexctl job recover demo --json` reconciles a queued or stale running job.
- `codexctl job sweep --json` reconciles all queued or running local jobs.
- `codexctl approval list demo --json` lists pending approval requests.
- `codexctl approval approve demo <approval-id> --json` resolves a pending approval.
- `codexctl supervisor run --interval-ms 1000 --json` keeps sweeping queued or running jobs.
- `codexctl job result demo --json` reads the persisted result.
- `codexctl job events demo --json` streams the persisted event log.

The current PoC supports both synchronous `job start` and detached `job start --detach`. Jobs record state under `.codexctl/jobs/`. Existing job records are preserved unless `--force` is passed.

When a `--json` command fails, `codexctl` writes a structured error to stderr:

```json
{
  "ok": false,
  "error": {
    "code": "usage_error",
    "message": "Missing required --prompt"
  }
}
```
