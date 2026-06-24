# codexctl

Agent-oriented CLI for controlling Codex app-server jobs.

This repository starts with a small Bun-based proof of concept. Non-help public commands require `--json` so agent callers can depend on a stable output mode:

- `codexctl doctor --json` checks the local Codex app-server daemon.
- `codexctl job start --repo . --key demo --prompt "..." --json` runs a Codex turn through `codex app-server --stdio`.
- `codexctl job start --detach --repo . --key demo --prompt "..." --json` starts a detached worker.
- `codexctl job start --approval-policy untrusted ...` asks app-server to route more actions through approval.
- `codexctl job start --sandbox read-only ...` overrides the app-server sandbox mode for that job.
- `codexctl job list --json` summarizes local job records with next actions and worker health.
- `codexctl job summary demo --events 10 --json` reads the job state, next action, final response, actionable approvals, diagnostics, and recent compact events.
- `codexctl job wait demo --timeout-ms 600000 --json` waits until a job is terminal or approval is required, then returns a summary.
- `codexctl job watch demo --format compact --json` follows a compact lifecycle stream until the job is terminal.
- `codexctl job watch demo --format raw --json` follows the raw persisted app-server event log.
- `codexctl job steer demo --prompt "..." --json` appends a steering command for the worker.
- `codexctl job cancel demo --json` interrupts an active turn or cancels a queued job.
- `codexctl job rm demo --json` removes a terminal local job record.
- `codexctl job prune --keep 10 --dry-run --json` previews completed job record cleanup.
- `codexctl job recover demo --json` reconciles a queued or stale running job.
- `codexctl job sweep --json` reconciles all queued or running local jobs.
- `codexctl job reconcile --dry-run --json` reports supervisor-style worker lifecycle decisions without applying them.
- `codexctl approval list demo --json` lists pending approval requests.
- `codexctl approval approve demo <approval-id> --json` resolves a pending approval.
- `codexctl supervisor plan --json` returns recommended next actions without executing them.
- `codexctl supervisor actions --ticks 10 --json` reads recent supervisor action history.
- `codexctl supervisor inspect demo --kind inspect_error --action-id <id> --json` resolves one current supervisor action into typed read-only inspection data.
- `codexctl supervisor apply demo --kind inspect_dead_worker --action-id <id> --confirm recover-dead-worker --json` applies the one supported mutating supervisor action after an explicit confirmation token.
- `codexctl supervisor run --interval-ms 1000 --json` keeps sweeping queued or running jobs.
- `codexctl job result demo --json` reads the persisted result.
- `codexctl job events demo --json` streams the persisted event log.

`job events` and `job watch` default to `--format raw` for full-fidelity replay. Use `--format compact` when an agent or human only needs lifecycle events such as thread/turn start, command execution, approval requests, warnings, app-server errors, completed assistant messages, and turn completion.

`job summary` is the quickest post-run view for agents: it returns the current job record, `nextAction`, worker health, pending and actionable approvals, approval counts, final response, error, diagnostics aggregated across compact events, and the most recent compact events. Use `--events 0` when the caller wants the stable summary fields without the event tail.

`job wait` polls `job summary` and returns one JSON object instead of streaming events. It stops when the job reaches a terminal status or when `nextAction` becomes `resolve_approval`, so agents can either read the final result or handle an approval without replaying logs. `--timeout-ms <ms>` bounds the wait and returns `ready: false`, `reason: "timeout"`, and the current summary; timeout is a poll result, not a structured error.

The current PoC supports both synchronous `job start` and detached `job start --detach`. Jobs record state under `.codexctl/jobs/`. Existing job records are preserved unless `--force` is passed.

`job cancel` marks queued jobs as `cancelled` immediately. For running jobs, it appends a `turn.interrupt` control command once; repeated cancel requests return `already_requested`. While the interrupt is pending, `job summary` returns `nextAction: "wait_cancel"` with `cancelRequestedAt` and `cancelCommandId`. The active worker sends app-server `turn/interrupt` on the same stdio connection and the job becomes `cancelled` when app-server completes the turn as interrupted. If the worker is already gone for an in-flight app-server turn, cancel marks the job failed instead of queuing an unreachable interrupt.

Running workers refresh `worker-heartbeat.json`, which is overlaid onto job reads as `workerHeartbeatAt` when the heartbeat belongs to the current job and worker incarnation. Job records expose `jobIncarnation`, `workerId`, and `workerGeneration`; each job creation gets a new job incarnation, and each detached start or recovery creates a new worker identity so stale heartbeat files from an older job or worker cannot make a newer job look healthy. Worker spawn and worker writes share a per-job record lock, and worker writes verify that their job and worker identity still match the persisted current record before updating `job.json` or heartbeat state. `job list` exposes the last heartbeat and whether the worker PID is alive; `job status` and `job summary.workerHealth` also expose whether the heartbeat is stale and the reason. Heartbeat staleness is an observation signal for agents and supervisors; it is not yet an automatic kill or replay policy.

`supervisor plan` is time-aware for stuck-looking states. Every action includes a stable `id` derived from its job and action identity; error and unreadable actions include a short reason hash so callers can distinguish changed failure causes, and dead-worker actions include a short job-state fingerprint so stale apply IDs do not match a later dead-worker state. Waiting cancellation actions include `ageMs` and move from `info` to `attention` after 60 seconds and to `critical` after 5 minutes. Stale worker actions include heartbeat `ageMs` and become `critical` after 5 minutes. During `supervisor run`, actions also include `firstSeenAt`, `seenTicks`, and `criticalSeenTicks` when the same concrete recommendation is observed in adjacent ticks, so callers can tell whether it is persistent. Critical actions may include a non-mutating `policy` recommendation such as `inspect`, or `escalate` when a critical finding itself persists for 3 ticks. These are still recommendations only; `nextCommand` is not auto-executed.

`job reconcile` is the typed worker lifecycle primitive underneath `job sweep` and supervisor ticks. It reports active or unreadable jobs, the recovery-state fingerprint that would be used as a precondition, the lifecycle decision (`restart_queued`, `restart_before_thread`, `fail_in_flight_dead_worker`, `skip_worker_alive`, or `skip_unreadable`), and whether the decision was applied. Use `--dry-run` when an agent wants to inspect supervisor behavior without spawning workers or marking dead in-flight turns failed.

`supervisor actions` reads the append-only supervisor event log and returns the most recent tick action history. It does not sweep jobs, run policy, or mutate state. Use `--ticks <n>` to bound how much history a controller reads before deciding whether to inspect, escalate, or keep waiting. Historical events written before action IDs existed are normalized with best-effort IDs when read; legacy dead-worker IDs cannot fully reconstruct the newer job-state fingerprint.

`supervisor inspect` checks the current supervisor plan for a specific `jobKey` and action `kind`, then returns typed read-only inspection data. Pass `--action-id <id>` to require an exact current action match. Approval actions return pending approvals, most inspection actions return `job summary`, and unreadable job actions return the plan error without trying to parse the broken job record. It does not execute the `nextCommand` shell string, resolve approvals, recover jobs, or mutate state.

`supervisor apply` is the explicit gate for mutating supervisor actions. The only supported mutation is applying a current `inspect_dead_worker` action by running the same recovery logic as `job recover`. Pass `--action-id <id>` to require an exact current action match before applying. It requires `--confirm recover-dead-worker`; without that token it fails with `supervisor_confirmation_required`. Use `--dry-run` to return the current action and required confirmation without mutating state. If the job state changes between validation and recovery, the recovery precondition rejects the mutation with `job_state_changed`. It does not approve requests, cancel jobs, delete records, or act on stale-but-live workers.

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
