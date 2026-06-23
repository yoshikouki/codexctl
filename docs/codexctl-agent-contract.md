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
codexctl job start --detach --approval-policy untrusted --sandbox read-only --repo . --key demo --prompt "Run pwd" --json
codexctl job status demo --json
codexctl job events demo --json
codexctl job watch demo --json
codexctl job steer demo --prompt "Narrow the answer." --json
codexctl job recover demo --json
codexctl approval list demo --json
codexctl approval show demo <approval-id> --json
codexctl approval approve demo <approval-id> --json
codexctl approval reject demo <approval-id> --json
codexctl job result demo --json
```

## Current PoC Semantics

`job start` launches `codex app-server --stdio`, sends newline-delimited JSON-RPC, starts a thread, starts a turn, records server notifications, and exits when `turn/completed` arrives for that turn.

`job start --detach` creates the job record and spawns one detached worker process for that job. The worker owns the app-server stdio connection.

`job recover` reconciles persisted state with the detached worker. Queued jobs and jobs whose worker died before app-server thread creation are restarted. Jobs with an in-flight `threadId` / `turnId` are marked failed if their worker process is gone, because the current stdio app-server session cannot be safely resumed without risking duplicate execution.

Job keys are restricted to letters, numbers, `.`, `_`, and `-`. Existing local job records are not overwritten unless callers pass `--force`.

The persisted files live in `.codexctl/jobs/<job-key>/`:

- `job.json`: latest job state.
- `events.jsonl`: JSON Lines event log.
- `control.jsonl`: append-only command inbox for steering.
- `worker.log`: detached worker stdout.
- `worker.err.log`: detached worker stderr.

Approval server requests are copied into `job.json.approvals`. Approval decisions are appended to `control.jsonl`; the worker translates them into the correct JSON-RPC response for supported app-server methods.

## Future Async Semantics

A later supervisor can replace the one-worker-per-job model. The command contract should remain job-key based:

- `job watch` tails live or persisted events.
- `job steer` sends input to the active thread.
- approval commands list, approve, and reject externalized app-server requests.

## Known Gaps

- `item/permissions/requestApproval` is listed but not yet safely resolvable because its response schema is not a simple accept/decline decision.
- In-flight app-server stdio sessions cannot yet be resumed after worker loss; `job recover` marks them failed rather than replaying the prompt.
- The app-server process is still one worker-owned stdio process per active job; long-running jobs need a supervisor.
