# codexctl Agent Contract

## Goal

`codexctl` exposes Codex app-server as a job-oriented control surface for AI agents.

The public model is `Job`, not app-server `Thread`.

## Non-goals

- It is not a replacement for Codex.
- It is not a generic agent framework.
- It does not hide Codex approvals or permissions.
- The supervisor does not replace per-job app-server workers; it reconciles persisted job state.

## Resources

- `Job`: agent-visible unit of work, keyed by a stable string.
- `Thread`: app-server conversation backing a job.
- `Turn`: one Codex instruction inside a thread.
- `Event`: persisted notification or request/response observation.
- `Result`: final assistant text, turn status, and app-server identifiers.

## Commands

Non-help public commands require `--json`. Machine callers can depend on JSON for success responses, JSON Lines for streaming event commands, and structured JSON errors on stderr.

```sh
codexctl doctor --json
codexctl job start --repo . --key demo --prompt "Respond exactly: ok" --json
codexctl job start --detach --repo . --key demo --prompt "Respond exactly: ok" --json
codexctl job run --repo . --key demo --prompt "Respond exactly: ok" --timeout-ms 600000 --json
codexctl job start --detach --approval-policy untrusted --sandbox read-only --repo . --key demo --prompt "Run pwd" --json
codexctl job list --json
codexctl job status demo --json
codexctl job summary demo --events 10 --json
codexctl job wait demo --events 0 --timeout-ms 600000 --json
codexctl job events demo --format compact --json
codexctl job watch demo --format compact --json
codexctl job steer demo --prompt "Narrow the answer." --wait --json
codexctl job cancel demo --wait --json
codexctl job rm demo --json
codexctl job prune --keep 10 --status completed --dry-run --json
codexctl job recover demo --json
codexctl job sweep --json
codexctl job reconcile --dry-run --json
codexctl approval list demo --json
codexctl approval show demo <approval-id> --json
codexctl approval approve demo <approval-id> --json
codexctl approval approve demo <approval-id> --wait --timeout-ms 600000 --json
codexctl approval reject demo <approval-id> --json
codexctl supervisor once --json
codexctl supervisor start --interval-ms 1000 --json
codexctl supervisor stop --json
codexctl supervisor plan --json
codexctl supervisor actions --ticks 10 --json
codexctl supervisor wait --after-tick 10 --timeout-ms 600000 --json
codexctl supervisor next --after-tick 10 --timeout-ms 600000 --json
codexctl supervisor inspect demo --kind inspect_error --action-id <id> --json
codexctl supervisor apply demo --kind inspect_dead_worker --action-id <id> --dry-run --json
codexctl supervisor apply demo --kind inspect_dead_worker --action-id <id> --confirm recover-dead-worker --json
codexctl supervisor run --interval-ms 1000 --json
codexctl supervisor status --json
codexctl supervisor events --json
codexctl job result demo --json
```

## Current PoC Semantics

`job start` launches `codex app-server --stdio`, sends newline-delimited JSON-RPC, starts a thread, starts a turn, records server notifications, and exits when `turn/completed` arrives for that turn.

If a `--json` command fails, stderr contains:

```json
{
  "ok": false,
  "error": {
    "code": "usage_error",
    "message": "Missing required --prompt"
  }
}
```

Known generic error codes are `usage_error`, `invalid_flag`, `missing_json_flag`, and `internal_error`. Job cleanup commands can also return `job_not_terminal`, `job_worker_alive`, or `job_unreadable` for expected safety refusals.

`job start --detach` creates the job record and spawns one detached worker process for that job. The worker owns the app-server stdio connection.

Running workers refresh `worker-heartbeat.json` roughly once per second while the worker is active. Job records expose `jobIncarnation`, `workerId`, and `workerGeneration`; each job creation gets a new job incarnation, each detached start or recovery creates a new worker identity, and `readJob` only overlays `workerHeartbeatAt` when the heartbeat belongs to the current job and worker incarnation. Worker spawn and worker writes share a per-job record lock to serialize `job.json` updates, and worker writes verify that their job and worker identity still match the persisted current record before updating `job.json` or heartbeat state. `job list` includes `nextAction`, `jobIncarnation`, `workerId`, `workerGeneration`, `workerHeartbeatAt`, `workerAlive`, `workerHealth`, approval counts, and cancel metadata; `job status` and `job summary` expose the same job and worker identity plus `workerHealth` with `alive`, `heartbeatAgeMs`, `stale`, and a reason such as `alive_recent`, `alive_stale`, or `dead`. This is an observability contract for callers. It does not by itself make stale-but-live workers eligible for deletion, replay, or automatic interruption.

`job recover` reconciles persisted state with the detached worker. Queued jobs and jobs whose worker died before app-server thread creation are restarted. Jobs with an in-flight `threadId` / `turnId` are marked failed if their worker process is gone, because the current stdio app-server session cannot be safely resumed without risking duplicate execution.

`job cancel` cancels a queued job immediately or appends one `turn.interrupt` control command for a running job. Repeated cancel requests return `action: "already_requested"` rather than enqueueing duplicate interrupts. While cancellation is pending, `job summary` exposes `cancelRequestedAt`, `cancelCommandId`, and `nextAction: "wait_cancel"`. Running-job cancel metadata is recovered from append-only `control.jsonl` on reads, so stale worker writes to `job.json` cannot make agent-facing state forget a queued interrupt. The active worker sends app-server `turn/interrupt` on its existing stdio transport and waits for `turn/completed`. App-server `turn.status: "interrupted"` is exposed as job `status: "cancelled"`. If a running job has already lost its worker during an in-flight app-server turn, cancel marks the job failed instead of returning a false-success queued interrupt.

`job rm` removes one local job record. By default it only removes terminal jobs: `completed`, `failed`, or `cancelled`. `--force` can remove unreadable or inactive non-terminal records, but still refuses any job with a live worker. `--dry-run` returns the same removal decision without deleting files.

`job prune` cleans local job records in bulk. By default it only considers `completed` jobs, sorts them by `updatedAt` descending, keeps the newest `--keep <n>` records, and removes the older matches. `--status failed`, `--status cancelled`, or `--status terminal` must be passed explicitly to include failure/cancellation debugging records. It never removes queued/running jobs. `--dry-run` previews the exact records that would be removed.

`job list` summarizes local job records as an agent overview: status, `nextAction`, worker health, pending/actionable approval counts, and cancel metadata. `job reconcile` is the typed worker lifecycle primitive: it reports active or unreadable jobs, the recovery-state fingerprint used as a mutation precondition, the lifecycle decision (`restart_queued`, `restart_before_thread`, `fail_in_flight_dead_worker`, `skip_worker_alive`, or `skip_unreadable`), and whether any mutation was applied. `--dry-run` returns the same decisions without spawning workers or failing in-flight dead-worker jobs. `job sweep` is the legacy compact wrapper: it applies reconciliation and returns only the per-job recovery results.

`job wait` polls `job summary` and returns one JSON object when the job is terminal or when `nextAction` becomes `resolve_approval`. The result includes `ready`, `reason`, elapsed timing fields, `ignoredApprovalIds`, top-level `status` / `nextAction`, and the nested `summary`. `--events <n>` controls the nested summary event tail. `--timeout-ms <ms>` returns `ready: false` and `reason: "timeout"` with the current summary instead of writing a structured error, so controllers can use bounded waits without treating normal polling expiry as command failure.

`job run` composes `job start --detach` and `job wait` into one command. It accepts the detached start flags (`--repo`, `--key`, `--prompt`, `--model`, `--approval-policy`, `--sandbox`, `--force`) plus wait flags (`--events`, `--interval-ms`, `--timeout-ms`). The response has `{ key, started, wait }`, where `started` is the worker record after spawn and `wait` is the same shape as `job wait`. It does not auto-resolve approvals; `wait.reason: "approval_required"` is the handoff point for approval commands.

`approval approve --wait` and `approval reject --wait` return `{ command, wait }`. `command` is the queued approval resolve command, and `wait` is the same shape as `job wait`. The wait ignores the approval ID that was just enqueued, preventing a race where the caller immediately sees the same pending approval before the worker has processed `control.jsonl`. If a different approval appears, or if the job reaches terminal state, the wait returns normally. Timeout remains a non-error `ready: false` result.

`job steer --wait` and `job cancel --wait` enqueue the same control command as their non-waiting forms, then return the same `job wait` shape. `steer --wait` returns `{ command, wait }`, where `command.type` is `turn.steer`. `cancel --wait` returns `{ cancel, wait }`, where `cancel` is the ordinary `job cancel` result. A running-job cancellation may still time out with `wait.nextAction: "wait_cancel"` while the worker is processing `turn/interrupt`; this is a bounded poll result, not an error.

`supervisor plan` returns recommended next actions without executing them. Actions include approval resolution, cancellation waiting, error inspection, stale/dead worker inspection, and unreadable job inspection. Every action has an `id` that is stable for the same job/action identity; `inspect_error` and `inspect_unreadable` IDs include a short hash of the reason so callers can distinguish changed failure causes, and `inspect_dead_worker` IDs include a short job-state fingerprint so stale apply IDs do not match a later dead-worker state. `nextCommand` is a suggested follow-up command for the caller, not an automatically executed command. Time-sensitive actions may include `ageMs` and `thresholdMs`: pending cancellation is `info` below 60 seconds, `attention` from 60 seconds, and `critical` from 5 minutes; stale worker heartbeat inspection becomes `critical` from 5 minutes. During `supervisor run`, actions may also include `firstSeenAt`, `seenTicks`, and `criticalSeenTicks`, derived by matching the current recommendation against the previous tick in the same run. Critical actions may include `policy`, a non-mutating controller hint with `recommendation: "inspect"` or `recommendation: "escalate"`, `reason`, `basedOn`, and optionally `thresholdTicks`. These fields are observational; they do not trigger automatic execution.

`supervisor start` runs the same reconciliation loop as `supervisor run`, but detached in the background. It returns `action: "started"` with the child `pid`, `supervisorId` inside `state`, and log paths, or `action: "already_running"` when the current state points at a live supervisor process with matching identity. Detached stdout/stderr go to `.codexctl/supervisor/supervisor.log` and `.codexctl/supervisor/supervisor.err.log`. Start/stop state transitions are serialized by `.codexctl/supervisor/lifecycle.lock`, which refreshes a lock heartbeat so stale locks can be recovered without stealing an active long stop. Concurrent starts converge on one recorded supervisor instead of spawning unreachable siblings. `supervisor stop` verifies that the recorded pid still looks like the same detached supervisor launch before sending `SIGTERM`, then returns `action: "stop_requested"` with the latest state it observed. If state says running but the pid is gone or belongs to something else, it returns `action: "stale_state"` and marks state stopped. If the pid is live but cannot be verified, start/stop fail with `supervisor_identity_unverified` instead of spawning a duplicate, sending a blind signal, or marking state stopped. These commands do not execute supervisor recommendations; they only control the loop lifecycle.

`supervisor actions` scans `.codexctl/supervisor/events.jsonl` from the tail and returns bounded recent `supervisor.tick` action history. It includes `tickLimit`, `eventsScanned` for the tail lines inspected, `tickCount`, `latestTickAt`, `latestActions`, and `ticks[]` with each tick's action list and health summary. It is read-only: it does not sweep jobs, execute `nextCommand`, or apply policy recommendations. Older tick events written without action IDs are normalized with best-effort IDs during reads; legacy dead-worker IDs cannot fully reconstruct the newer job-state fingerprint.

`supervisor wait` polls `.codexctl/supervisor/state.json` and returns one JSON object when current actions from a tick newer than `--after-tick <n>` are present, when a newer tick appears, when the supervisor is stale or stopped, or when `--timeout-ms` expires. The response includes `ready`, `reason: "actions" | "tick" | "stale" | "stopped" | "timeout"`, elapsed timing fields, `afterTick`, `state`, and fresh `actions`. Supervisor `tickCount` is preserved across supervisor restarts, so `--after-tick` is a monotonic cursor over state observations rather than a per-process tick index. It is read-only and does not run reconciliation itself; use it with `supervisor start` for long-lived controller loops. Timeout is a normal `ready: false` result, not a structured CLI error.

`supervisor next` is the agent-facing controller shortcut for `supervisor start`, `supervisor wait`, and read-only action inspection. It returns `{ at, start, wait, action, inspection }`. `start` is the detached supervisor lifecycle result, `wait` is the normal wait result, `action` is the selected highest-severity fresh action or `null`, and `inspection` is the read-only inspection payload for the selected wait action or `null`. Without `--after-tick`, it starts waiting from the state cursor observed before `start`, so a fast first tick is not skipped and old actions from a previous tick are not reselected. `next` inspects the wait-selected action directly instead of re-planning, so normal races between wait and inspection do not become stale-action CLI errors. It does not apply actions, resolve approvals, cancel jobs, mutate job records, or execute `nextCommand`.

`supervisor inspect <job-key> --kind <action-kind>` validates that the current supervisor plan still contains the requested action, then returns typed read-only inspection data. Pass `--action-id <id>` to require an exact match against a current action ID. `resolve_approval` returns `inspection.type: "approval_list"` with pending approvals. `wait_cancel`, `inspect_error`, `inspect_stale_worker`, and `inspect_dead_worker` return `inspection.type: "job_summary"` with the event tail size used for that action. `inspect_unreadable` returns `inspection.type: "unreadable_job"` with the plan error, without trying to parse the broken job record. This command does not execute the action's `nextCommand` shell string, resolve approvals, recover jobs, or mutate state. If the action is no longer current, stderr uses `supervisor_action_not_found`.

`supervisor apply <job-key> --kind <action-kind>` is the explicit gate for mutating supervisor actions. The only supported mutation is a current `inspect_dead_worker` action, which runs the same recovery path as `job recover`. Pass `--action-id <id>` to require an exact match against a current action ID before applying. A real apply requires `--confirm recover-dead-worker`; otherwise stderr uses `supervisor_confirmation_required`. `--dry-run` returns the action, `requiredConfirmation`, and `application.result: null` without mutating state. If the requested action is not current, stderr uses `supervisor_action_not_found`; if it is current but has no supported mutation, stderr uses `supervisor_action_not_applicable`. If the job state changes between action validation and recovery, the recovery precondition rejects the mutation with `job_state_changed`. This command does not resolve approvals, cancel jobs, remove records, or act on stale-but-live workers.

`supervisor once` runs one reconciliation and records supervisor state. `supervisor run` repeats reconciliation until interrupted. Each new tick includes the full reconciliation report, the compact legacy `recovered[]` list, a health count summary, and the same non-executing action plan so controllers can detect stale workers, dead workers, pending approvals, waiting cancellations, and failed jobs without replaying all job records. Legacy `state.json` written before reconciliation existed is normalized with `lastTick.reconciliation: null` when read. `--max-ticks` is available for tests and bounded dogfood runs.

`job summary` returns a single post-run object for agent callers: current job state, prompt, `nextAction`, worker health, pending and actionable approvals, whether approvals can be resolved, approval counts, final response, error, diagnostics aggregated across compact events, and the most recent compact events. `--events <n>` controls the compact event tail size and defaults to 10. Use `--events 0` to omit the event tail while keeping diagnostics.

`job events` and `job watch` support `--format raw` and `--format compact`. Raw mode emits the persisted app-server event log exactly as JSON Lines. Compact mode emits only agent-useful lifecycle events: worker/control events, thread and turn starts, approval requests, command starts/completions, failed MCP startup notifications, warnings, app-server errors, completed assistant messages, and turn completions. Server-derived compact events include thread/turn identifiers when app-server provides them. Compact mode filters streaming token deltas and reasoning deltas.

Job keys are restricted to letters, numbers, `.`, `_`, and `-`. Existing local job records are not overwritten unless callers pass `--force`.

The persisted files live in `.codexctl/jobs/<job-key>/`:

- `job.json`: latest job state.
- `worker-heartbeat.json`: latest worker heartbeat, overlaid onto job reads.
- `events.jsonl`: JSON Lines event log.
- `control.jsonl`: append-only command inbox for steering, cancellation, and approval decisions.
- `worker.log`: detached worker stdout.
- `worker.err.log`: detached worker stderr.

Supervisor files live in `.codexctl/supervisor/`:

- `state.json`: latest supervisor status, pid, tick count, and last tick.
- `events.jsonl`: append-only supervisor lifecycle and tick events.

Approval server requests are copied into `job.json.approvals`. Approval decisions are appended to `control.jsonl`; the worker translates them into the correct JSON-RPC response for supported app-server methods.

`item/permissions/requestApproval` uses a different response shape from command and file approvals. `approval approve` grants the requested permissions for the current turn, and `approval approve --for-session` grants them for the session. The current app-server schema does not define a reject/cancel response for permissions approvals, so `codexctl` rejects those decisions before appending a control command.

## Future Async Semantics

A later supervisor can replace the one-worker-per-job model. The command contract should remain job-key based:

- `job watch` tails live or persisted events.
- `job steer` sends input to the active thread.
- approval commands list, approve, and reject externalized app-server requests.

## Known Gaps

- `item/permissions/requestApproval` denial is not mapped because the current app-server schema exposes only a permission grant response.
- In-flight app-server stdio sessions cannot yet be resumed after worker loss; `job recover` marks them failed rather than replaying the prompt.
- The app-server process is still one worker-owned stdio process per active job.
