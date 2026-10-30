# codexctl

A thin control layer for running an installed Codex through app-server. Run jobs in the background, inspect their state as JSON, and send follow-up instructions or decisions on approvals.

Sandboxing and approvals follow Codex's own settings, including `~/.codex/config.toml`. codexctl does not modify Codex's code or configuration, or override model, network, or authentication settings.

## Run

Requires Bun and an installed Codex with app-server support. To run from the repository:

```sh
bun run src/cli.ts --help
bun run src/cli.ts job run --repo . --key demo --prompt "Explain this repository's structure. Do not modify files."
bun run src/cli.ts job wait demo --timeout-ms 600000
```

`job run` starts a detached worker and immediately returns a `queued` record. `job wait` returns on completion, a request for approval, or timeout. If the CLI is installed, use `codexctl` instead of `bun run src/cli.ts`.

Output is JSON; errors are JSON on stderr. `job events` outputs saved events as raw JSONL. See the [agent contract](docs/codexctl-agent-contract.md) for commands and output formats.

## State and follow-up instructions

State is stored in `~/.codexctl/jobs/<key>/`, or `jobs/<key>/` under `CODEXCTL_HOME` if set. Keys are unique within the same home. You can reference the same key after changing your working directory.

```sh
codexctl job summary demo --events 0
codexctl job steer demo --prompt "Also explain the configuration files."
codexctl job wait demo --timeout-ms 600000
```

Steering `completed`, `failed`, or `cancelled` jobs starts a new turn with the same `threadId`. Jobs without a `threadId` cannot resume; instead, use a new key to create a job.

`job summary` includes saved `progress`: `current` (`type`, `startedAt`, and a command limited to 200 characters for command execution), `lastCommentary` (latest completed commentary, limited to 500 characters), `commands: { run, failed }`, and `totalTokens`. Counts span all turns in the job; unavailable values are null and counts start at zero. `current` clears on matching item completion or turn completion. Progress is pull-only; summary reads `job.json` and only the requested event tail.

## Parallel work with worktrees

For each job, create `~/src/worktrees/github.com/<owner>/<repo>/<key>` on branch `codex/<key>` and pass that path to `--repo`. The caller creates worktrees with Git.

Example for this repository, using unused keys and branches:

```sh
mkdir -p "$HOME/src/worktrees/github.com/yoshikouki/codexctl"
git worktree add -b codex/docs-review "$HOME/src/worktrees/github.com/yoshikouki/codexctl/docs-review" HEAD
git worktree add -b codex/tests-review "$HOME/src/worktrees/github.com/yoshikouki/codexctl/tests-review" HEAD
codexctl job run --repo "$HOME/src/worktrees/github.com/yoshikouki/codexctl/docs-review" --key docs-review --prompt "Review the documentation and report inconsistencies. Do not modify files."
codexctl job run --repo "$HOME/src/worktrees/github.com/yoshikouki/codexctl/tests-review" --key tests-review --prompt "Review the tests and report gaps. Do not modify files."
codexctl job list
codexctl job wait docs-review --timeout-ms 600000
codexctl job wait tests-review --timeout-ms 600000
```

## Notifications

Every CLI invocation and worker loads `~/.config/codexctl/env` by default, using `$HOME`. Set `env_file = "path/to/env"` in `~/.config/codexctl/config.toml` to override it; `~` expands to `$HOME` and relative paths resolve against the config directory. Existing environment variables win; missing files are ignored. Protect the env file with `chmod 600`.

The env file accepts `KEY=VALUE`, blank lines, and `#` comments; surrounding single or double quotes are stripped. No `export`, variable expansion, or multiline values. Invalid or unreadable files fail with a JSON error; unknown config keys are rejected.

codexctl reads `CODEXCTL_GROK_BOT_NOTIFY_URL` and `CODEXCTL_GROK_BOT_NOTIFY_KEY` from the loaded environment and never stores them. Automatic notifications use the environment of the process that starts the worker: `job run`, or `job steer` on a finished job, which restarts the worker. `job notify` uses the caller's environment.

- When the worker reaches a terminal state, it sends `job.completed`, `job.failed`, or `job.cancelled`. This also applies after resuming a job.
- Approval requests send `approval.requested` once per approval ID within the worker.
- `codexctl job notify demo` sends the current state once as `job.status`.
- If the URL is missing, each automatic notification trigger records one `notify.skipped` event with `reason: "not_configured"`. If the URL is set but the key is missing, nothing is sent and `missing_key` is recorded.

Notifications use JSON POST with `Content-Type: application/json` and Bearer authentication. The payload contains `source: "codexctl"`, `event`, `key`, `status`, `repo`, `threadId`, `turnId`, an ISO timestamp in `at`, and `finalResponse`. `threadId` and `turnId` may be null. `finalResponse` is limited to 2,000 Unicode code points. Only `approval.requested` includes `approvalId`.

The payload excludes the prompt, params from approvals, error, and environment variables. Strings matching the notification URL or key are redacted; other secrets are not detected automatically.

Requests time out after 10 seconds, with no retries or redirect following. HTTP 200 records `notify.sent`; failures record `notify.failed`. Notification failures do not change the job's state. If recording the event itself fails, the record is omitted. Cancellation before startup also sends a notification when processed by the worker, but a worker startup failure does not send an automatic notification.

`job summary` reads the latest worker notification result from `job.json` in `lastNotification` as `{ status: "sent" | "failed" | "skipped", at }`, including `notify.skipped` when the URL is missing. It is null if no result is recorded and is included even with `--events 0`. Manual `job notify` results remain in the event log and do not update this saved value.

## Agent skill

[skills/codexctl/SKILL.md](skills/codexctl/SKILL.md) describes delegation, approvals, and resuming jobs. Point your skill manager at `skills/codexctl/`.
