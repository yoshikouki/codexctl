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
codexctl job start --detach --approval-policy untrusted --sandbox read-only --repo . --key demo --prompt "Run pwd" --json
codexctl job list --json
codexctl job status demo --json
codexctl job summary demo --events 10 --json
codexctl job events demo --format compact --json
codexctl job watch demo --format compact --json
codexctl job steer demo --prompt "Narrow the answer." --json
codexctl job cancel demo --json
codexctl job rm demo --json
codexctl job prune --keep 10 --status completed --dry-run --json
codexctl job recover demo --json
codexctl job sweep --json
codexctl approval list demo --json
codexctl approval show demo <approval-id> --json
codexctl approval approve demo <approval-id> --json
codexctl approval reject demo <approval-id> --json
codexctl supervisor once --json
codexctl supervisor plan --json
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

Running workers refresh `worker-heartbeat.json` roughly once per second while the worker is active. `readJob` overlays it onto the returned job record as `workerHeartbeatAt`; `job list` includes `nextAction`, `workerHeartbeatAt`, `workerAlive`, `workerHealth`, approval counts, and cancel metadata; `job status` and `job summary` expose `workerHealth` with `alive`, `heartbeatAgeMs`, `stale`, and a reason such as `alive_recent`, `alive_stale`, or `dead`. This is an observability contract for callers. It does not by itself make stale-but-live workers eligible for deletion, replay, or automatic interruption.

`job recover` reconciles persisted state with the detached worker. Queued jobs and jobs whose worker died before app-server thread creation are restarted. Jobs with an in-flight `threadId` / `turnId` are marked failed if their worker process is gone, because the current stdio app-server session cannot be safely resumed without risking duplicate execution.

`job cancel` cancels a queued job immediately or appends one `turn.interrupt` control command for a running job. Repeated cancel requests return `action: "already_requested"` rather than enqueueing duplicate interrupts. While cancellation is pending, `job summary` exposes `cancelRequestedAt`, `cancelCommandId`, and `nextAction: "wait_cancel"`. Running-job cancel metadata is recovered from append-only `control.jsonl` on reads, so stale worker writes to `job.json` cannot make agent-facing state forget a queued interrupt. The active worker sends app-server `turn/interrupt` on its existing stdio transport and waits for `turn/completed`. App-server `turn.status: "interrupted"` is exposed as job `status: "cancelled"`. If a running job has already lost its worker during an in-flight app-server turn, cancel marks the job failed instead of returning a false-success queued interrupt.

`job rm` removes one local job record. By default it only removes terminal jobs: `completed`, `failed`, or `cancelled`. `--force` can remove unreadable or inactive non-terminal records, but still refuses any job with a live worker. `--dry-run` returns the same removal decision without deleting files.

`job prune` cleans local job records in bulk. By default it only considers `completed` jobs, sorts them by `updatedAt` descending, keeps the newest `--keep <n>` records, and removes the older matches. `--status failed`, `--status cancelled`, or `--status terminal` must be passed explicitly to include failure/cancellation debugging records. It never removes queued/running jobs. `--dry-run` previews the exact records that would be removed.

`job list` summarizes local job records as an agent overview: status, `nextAction`, worker health, pending/actionable approval counts, and cancel metadata. `job sweep` is the supervisor primitive: it runs recovery for every queued or running local job and returns the per-job recovery result.

`supervisor plan` returns recommended next actions without executing them. Actions include approval resolution, cancellation waiting, error inspection, stale/dead worker inspection, and unreadable job inspection. `nextCommand` is a suggested follow-up command for the caller, not an automatically executed command. Time-sensitive actions may include `ageMs` and `thresholdMs`: pending cancellation is `info` below 60 seconds, `attention` from 60 seconds, and `critical` from 5 minutes; stale worker heartbeat inspection becomes `critical` from 5 minutes. During `supervisor run`, actions may also include `firstSeenAt`, `seenTicks`, and `criticalSeenTicks`, derived by matching the current recommendation against the previous tick in the same run. Critical actions may include `policy`, a non-mutating controller hint with `recommendation: "inspect"` or `recommendation: "escalate"`, `reason`, `basedOn`, and optionally `thresholdTicks`. These fields are observational; they do not trigger automatic execution.

`supervisor once` runs one sweep and records supervisor state. `supervisor run` repeats sweeps until interrupted. Each tick includes a compact health count summary and the same non-executing action plan so controllers can detect stale workers, dead workers, pending approvals, waiting cancellations, and failed jobs without replaying all job records. `--max-ticks` is available for tests and bounded dogfood runs.

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
