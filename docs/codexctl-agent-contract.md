# codexctl agent contract

codexctl is a thin control layer for an installed Codex's app-server. A detached worker communicates with app-server for each job. Sandboxing and approvals follow Codex's own settings, including `~/.codex/config.toml`; codexctl does not override them.

## Commands and output

Use `codexctl --help` to list public commands. Help returns `{ usage }`. Normal output is JSON. Errors write `{ ok: false, error: { code, message } }` to stderr and exit with a nonzero code. Only `job events` outputs raw JSONL.

Placeholders such as `<key>`, `<prompt>`, and `<id>` represent arguments.

| Command | Flags | JSON output |
| --- | --- | --- |
| `codexctl job run` | Required: `--key <key> --prompt <prompt>`. Optional: `--repo <path> --force` | Initial JobRecord: `status: "queued"`, `key`, `repo`, `prompt`, timestamps, thread/turn IDs, approvals, etc. Does not wait |
| `codexctl job list` | None | Jobs with `key`, `status`, `workerAlive`, counts of approvals, thread/turn IDs, `error`, etc. Sorted by update time, newest first |
| `codexctl job summary <key>` | `--events <n>` | Summary below |
| `codexctl job wait <key>` | `--events <n> --interval-ms <ms> --timeout-ms <ms>` | Wait below |
| `codexctl job events <key>` | `--format raw` | Outputs saved events, one per line, then exits |
| `codexctl job steer <key>` | Required: `--prompt <prompt>` | `id`, `type: "turn.steer"`, `at`, `input`. Includes `resume: true` for a finished job |
| `codexctl job cancel <key>` | None | `{ action, reason, job, command }`. `action` is `interrupt_queued` or `none` |
| `codexctl job rm <key>` | `--force --dry-run` | `{ action, key, status, reason }`. `action` is `removed` or `would_remove` |
| `codexctl job notify <key>` | None | `{ ok: true }` on success. Errors: `notify_not_configured` if unconfigured, `notify_failed` if sending fails |
| `codexctl approval list <key>` | `--all` | Array of records for approvals. Pending only by default; `--all` includes resolved records |
| `codexctl approval show <key> <id>` | None | One record for an approval: `id`, `serverRequestId`, `method`, `params`, `status`, timestamps, `decision`, `error` |
| `codexctl approval approve <key> <id>` | `--for-session --wait` and wait flags | `{ id, type: "approval.resolve", at, approvalId, decision }`. With waiting: `{ command, wait }` |
| `codexctl approval reject <key> <id>` | `--cancel --wait` and wait flags | Same shape as approve. `decision` is `reject`, or `cancel` with `--cancel` |

Wait flags are `--events <n>`, `--interval-ms <ms>`, and `--timeout-ms <ms>`. Use them with `job wait` or `--wait` when deciding on an approval. `--events` is a non-negative integer, default 5. The interval is a positive integer, default 1,000 ms. The timeout is a positive integer; omitting it waits indefinitely.

### Summary

Returns `key`, `status`, `repo`, `threadId`, `turnId`, `createdAt`, `startedAt`, `completedAt`, `pendingApprovals: { count, ids }`, `latestAgentMessage`, `finalResponse`, `error`, and `recentEvents`. `latestAgentMessage` is limited to 2,000 Unicode code points; `finalResponse` is the full text. `--events 0` makes `recentEvents` an empty array.

`lastNotification` is the latest notification result, `{ status: "sent" | "failed" | "skipped", at }`, or null if none is recorded. It does not depend on `--events`.
If the URL is missing, each automatic notification trigger records one `notify.skipped` event with `reason: "not_configured"`, shown in `lastNotification`. The notification URL and key are never recorded. Manual notifications still return the `notify_not_configured` error.

### Wait

Returns `key`, `ready`, `reason`, `status`, `summary`, `elapsedMs`, `intervalMs`, `ignoredApprovalIds`, `timeoutMs`, and `deadlineAt`.

- `reason: "terminal"`: completed, failed, or cancelled. `ready: true`.
- `reason: "approval_required"`: pending approvals on a running job. `ready: true`.
- `reason: "timeout"`: the wait deadline was reached. `ready: false`. This is not a CLI error and does not stop the job.

With `--wait`, the submitted approval's ID is excluded while waiting for completion or another approval. Job failure and CLI failure are separate: inspect `summary.status` and `summary.error`, not just the exit code.

## State and operations

- State is stored in `~/.codexctl/jobs/<key>/`. Set `CODEXCTL_HOME` to change the home. Keys are unique within the same home and independent of cwd. Only the default `--repo` uses the caller's `.`.
- Saved files are `job.json`, `events.jsonl`, `control.jsonl`, `worker.log`, and `worker.err.log`. After creation, only the worker updates `job.json`, replacing it atomically.
- Steer, cancel, and decisions on approvals append to `control.jsonl`. A response confirms receipt, not application. Without a worker, commands are not processed and waits may time out.
- Cancel queues an interrupt. Before startup, the worker sets the status to cancelled without starting app-server. Cancelling finished jobs returns `action: "none"`.
- `job run` with `--force` resets the existing record and logs. It refuses if a worker is alive.
- `job rm` deletes the job's state directory. Normally it accepts only finished jobs; `--force` also accepts unfinished or unreadable records. If a readable record has a live worker, removal is refused even with force. Worktrees are not removed.

## Steering finished jobs

Steering completed, failed, or cancelled jobs starts a new worker, resumes the same `threadId`, and starts a new turn. A missing `threadId` is an error; instead, use a new key to create a job.

The new worker waits for the previous worker to exit, including notification delivery. It resets turn-specific responses, errors, and approvals without replaying processed control commands. After a resume is accepted, `job wait` waits for the resumed result instead of returning the previous terminal result.

After steering or cancelling, use `job wait` to check the result.

## Approvals

Send decisions for pending approvals on running jobs. codexctl does not approve automatically. Inspect `method` and `params` before deciding.

For command and file approvals, approve returns `accept`, reject returns `decline`, and cancel returns `cancel`. `--for-session` uses `acceptWithExecpolicyAmendment` from `params.availableDecisions` unchanged when available; otherwise it returns `acceptForSession`.

`execCommandApproval` and `applyPatchApproval` are also in the current schema. Approve returns `approved`, `--for-session` returns `approved_for_session`, reject returns `{ denied: { rejection: "Rejected via codexctl" } }`, and cancel returns `abort`.

For `item/permissions/requestApproval`, the requested permissions are returned unchanged, scoped to the turn by default or the session with `--for-session`. Reject and cancel are errors for this type of approval.

## Parallel work and notifications

The caller creates each worktree at `~/src/worktrees/github.com/<owner>/<repo>/<key>` on branch `codex/<key>` and passes it to `job run` with `--repo`. Start each job, then check results with `job list` and `job wait` for each key.

Every CLI invocation and worker loads `~/.config/codexctl/env` by default, using `$HOME`. Set `env_file = "path/to/env"` in `~/.config/codexctl/config.toml` to override it; `~` expands to `$HOME` and relative paths resolve against the config directory. Existing environment variables win; missing files are ignored. Protect the env file with `chmod 600`.

The env file accepts `KEY=VALUE`, blank lines, and `#` comments; surrounding single or double quotes are stripped. No `export`, variable expansion, or multiline values. Invalid or unreadable files fail with a JSON error; unknown config keys are rejected.

codexctl reads `CODEXCTL_GROK_BOT_NOTIFY_URL` and `CODEXCTL_GROK_BOT_NOTIFY_KEY` from the loaded environment and never stores them. Automatic notifications use the environment of the process that starts the worker: `job run`, or `job steer` on a finished job, which restarts the worker. `job notify` uses the caller's environment.

See [Notifications in the README](../README.md#notifications) for notification triggers, payloads, the 10-second timeout, and the no-retry policy.
