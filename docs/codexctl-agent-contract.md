# codexctl Agent Contract

## Goal

`codexctl` exposes Codex app-server as a job-oriented control surface for AI agents.

The public model is `Job`, not app-server `Thread`.

## Non-goals

- It is not a replacement for Codex.
- It is not a generic agent framework.
- It does not hide Codex approvals or permissions.
- The PoC does not yet provide a long-running supervisor.

## Resources

- `Job`: agent-visible unit of work, keyed by a stable string.
- `Thread`: app-server conversation backing a job.
- `Turn`: one Codex instruction inside a thread.
- `Event`: persisted notification or request/response observation.
- `Result`: final assistant text, turn status, and app-server identifiers.

## Commands

All commands support `--json`. Machine callers should use it.

```sh
codexctl doctor --json
codexctl job start --repo . --key demo --prompt "Respond exactly: ok" --json
codexctl job start --detach --repo . --key demo --prompt "Respond exactly: ok" --json
codexctl job status demo --json
codexctl job events demo --json
codexctl job watch demo --json
codexctl job steer demo --prompt "Narrow the answer." --json
codexctl job result demo --json
```

## Current PoC Semantics

`job start` launches `codex app-server --stdio`, sends newline-delimited JSON-RPC, starts a thread, starts a turn, records server notifications, and exits when `turn/completed` arrives for that turn.

`job start --detach` creates the job record and spawns one detached worker process for that job. The worker owns the app-server stdio connection.

Job keys are restricted to letters, numbers, `.`, `_`, and `-`. Existing local job records are not overwritten unless callers pass `--force`.

The persisted files live in `.codexctl/jobs/<job-key>/`:

- `job.json`: latest job state.
- `events.jsonl`: JSON Lines event log.
- `control.jsonl`: append-only command inbox for steering.
- `worker.log`: detached worker stdout.
- `worker.err.log`: detached worker stderr.

## Future Async Semantics

A later supervisor can replace the one-worker-per-job model. The command contract should remain job-key based:

- `job watch` tails live or persisted events.
- `job steer` sends input to the active thread.
- approval commands list, approve, and reject externalized app-server requests.

## Known Gaps

- Approval requests are persisted as raw server events, but there is not yet a first-class `approval` command set.
- The app-server process is per-command in the PoC; long-running jobs need a supervisor.
