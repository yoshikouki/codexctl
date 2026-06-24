# codexctl

Agent-oriented CLI for controlling Codex app-server jobs.

This repository starts with a small Bun-based proof of concept. Non-help public commands require `--json` so agent callers can depend on a stable output mode:

- `codexctl doctor --json` checks the local Codex app-server daemon.
- `codexctl job start --repo . --key demo --prompt "..." --json` runs a Codex turn through `codex app-server --stdio`.
- `codexctl job start --detach --repo . --key demo --prompt "..." --json` starts a detached worker.
- `codexctl job start --approval-policy untrusted ...` asks app-server to route more actions through approval.
- `codexctl job start --sandbox read-only ...` overrides the app-server sandbox mode for that job.
- `codexctl job list --json` summarizes local job records.
- `codexctl job summary demo --events 10 --json` reads the job state, next action, final response, actionable approvals, diagnostics, and recent compact events.
- `codexctl job watch demo --format compact --json` follows a compact lifecycle stream until the job is terminal.
- `codexctl job watch demo --format raw --json` follows the raw persisted app-server event log.
- `codexctl job steer demo --prompt "..." --json` appends a steering command for the worker.
- `codexctl job cancel demo --json` interrupts an active turn or cancels a queued job.
- `codexctl job rm demo --json` removes a terminal local job record.
- `codexctl job prune --keep 10 --dry-run --json` previews completed job record cleanup.
- `codexctl job recover demo --json` reconciles a queued or stale running job.
- `codexctl job sweep --json` reconciles all queued or running local jobs.
- `codexctl approval list demo --json` lists pending approval requests.
- `codexctl approval approve demo <approval-id> --json` resolves a pending approval.
- `codexctl supervisor run --interval-ms 1000 --json` keeps sweeping queued or running jobs.
- `codexctl job result demo --json` reads the persisted result.
- `codexctl job events demo --json` streams the persisted event log.

`job events` and `job watch` default to `--format raw` for full-fidelity replay. Use `--format compact` when an agent or human only needs lifecycle events such as thread/turn start, command execution, approval requests, warnings, app-server errors, completed assistant messages, and turn completion.

`job summary` is the quickest post-run view for agents: it returns the current job record, `nextAction`, pending and actionable approvals, approval counts, final response, error, diagnostics aggregated across compact events, and the most recent compact events. Use `--events 0` when the caller wants the stable summary fields without the event tail.

The current PoC supports both synchronous `job start` and detached `job start --detach`. Jobs record state under `.codexctl/jobs/`. Existing job records are preserved unless `--force` is passed.

`job cancel` marks queued jobs as `cancelled` immediately. For running jobs, it appends a `turn.interrupt` control command once; repeated cancel requests return `already_requested`. While the interrupt is pending, `job summary` returns `nextAction: "wait_cancel"` with `cancelRequestedAt` and `cancelCommandId`. The active worker sends app-server `turn/interrupt` on the same stdio connection and the job becomes `cancelled` when app-server completes the turn as interrupted. If the worker is already gone for an in-flight app-server turn, cancel marks the job failed instead of queuing an unreachable interrupt.

`job rm` and `job prune` only clean local `.codexctl/jobs` records; they do not delete Codex app-server thread history. `job rm` removes terminal jobs by default. `--force` can remove unreadable or inactive non-terminal local records, but refuses any job with a live worker. `job prune --keep <n>` removes older completed jobs after keeping the newest `n`; use `--status terminal` only when failed and cancelled debugging records should also be eligible. Use `--dry-run` to inspect first.

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
