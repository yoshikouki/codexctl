# Current contract: thin layer, step 2b

Use `codexctl --help` for accepted commands and flags. Older README, agent contract and skill workflows describe the pre-refactor implementation; their full rewrite is deferred to step 3.

- All commands output JSON, errors output JSON on stderr, and `job events` outputs raw JSONL. `--json` and `--json=<value>` are ignored.
- State lives in `$CODEXCTL_HOME/jobs/<key>/`, defaulting to `~/.codexctl/jobs/<key>/`. Keys are global within that home. The invoking cwd only determines the default repository for a new job. Old `repos/` state is neither read nor migrated; `CODEXCTL_STATE_DIR` and `CODEXCTL_STATE_REPO` are no longer used.
- `job run --key demo --repo . --prompt "..."` creates the initial record, starts a detached worker, and returns the queued record immediately. It accepts no wait flags. Use `job wait demo --timeout-ms 600000` to wait for completion or approval.
- After creation, only the worker writes `job.json`. CLI steer, cancel and approval decisions append to `control.jsonl`. There is no job-record lock, control-field merge or read-time state overlay. Worker writes use atomic file replacement so concurrent readers see complete JSON.
- `job summary demo` returns `key`, `status`, `repo`, `threadId`, `turnId`, `createdAt`, `startedAt`, `completedAt`, `pendingApprovals: { count, ids }`, `latestAgentMessage` (at most 2,000 Unicode code points), `finalResponse`, `error`, and `recentEvents`. `--events N` defaults to 5; zero omits the event tail. No next-action, worker-health or other derived summary fields are included.
- `job steer demo --prompt "..."` appends control input for an active job. For `completed`, `failed` or `cancelled`, it starts a new worker, resumes the same `threadId`, and starts a new turn. A job without a `threadId` cannot resume; create a new job instead. `--wait` waits for the new turn, rather than returning the old terminal result. Plain `job wait` also recognizes a queued resume.
- The new worker waits for the previous worker to exit (including webhook delivery), resets per-turn state and resumes control consumption after the restart command. Previously consumed steer, cancel and approval commands are not replayed. Completion sends the same webhook as an initial turn.
- Cancel only queues an interrupt. A queued cancellation is applied by the worker before starting app-server; it also sends the cancellation webhook. CLI no longer marks dead-worker jobs failed or cancelled. If no worker exists, a queued command cannot be applied; bounded waits can time out.
- Codex configuration, approval policy, sandbox, authentication and network configuration are not overridden.

## Protocol evidence and validation

Generated locally with `codex-cli 0.166.0-alpha.5.1`:

```sh
codex app-server generate-json-schema --out /tmp/codexctl-step2b-schema
```

`v2/ThreadResumeParams.json` requires only `threadId`, describes loading the persisted thread by ID, and imposes no previous turn-status restriction. The worker sends `thread/resume { threadId, cwd }`, then `turn/start { threadId, cwd, input }`. Cancelled jobs use this same path because an interrupted turn does not delete its thread.

`test/lifecycle.test.ts` uses a local mock app-server and loopback webhook to verify cwd independence, detached execution, CLI write ownership, all three terminal statuses, new turn IDs, no control replay, and repeat completion notifications. No production webhook is contacted. Real Codex conversation execution is not tested: it would write session data outside the permitted worktree and temporary codexctl home.

## Known discrepancies in older documentation

README, `docs/codexctl-agent-contract.md` and `skills/codexctl/` still describe removed doctor, supervisor, job start/status/result/watch/prune/recover/sweep/reconcile commands, model/approval/sandbox flags, compact events, heartbeat/generation/record locks, a deleted handoff document, and supervisor-based workflows. They also describe mandatory `--json`, blocking `job run`, repository-scoped state, old summary fields/defaults, and CLI-side cancel state updates. Follow current code, CLI help and this contract until step 3.
