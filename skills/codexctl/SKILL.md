---
name: codexctl
description: Use to delegate work to another Codex, run it in the background, or check multiple Codex jobs. Controls the installed Codex's app-server through codexctl.
---

# codexctl

codexctl is a thin control layer for Codex. Sandboxing and approvals follow Codex's own settings, including `~/.codex/config.toml`. Do not change Codex's configuration.

## Get started

1. Check commands with `codexctl --help`. If the CLI is unavailable, read [setup.md](references/setup.md).
2. Choose a key for the job. Include the goal, target, whether changes are allowed, constraints, and expected report in the prompt.
3. For parallel edits, prepare a worktree per job. See [workflows.md](references/workflows.md).

```sh
codexctl job run --repo . --key review --prompt "Review this repository and report issues. Do not modify files."
codexctl job wait review --timeout-ms 600000
```

`job run` returns a queued record. After steer or cancel is accepted, use `job wait` to read the result.

- `reason: "terminal"`: inspect and report `summary.status` and `summary.finalResponse` or `summary.error`.
- `reason: "approval_required"`: inspect the request with `approval list` and decide according to the user's instructions and policy for approvals. Do not approve unconditionally.
- `reason: "timeout"`: execution continues. Check `job summary` or wait again with `job wait`.

State is in `~/.codexctl/jobs/<key>/`, or `jobs/<key>/` under `CODEXCTL_HOME`. Use `job steer` to continue the same thread of a finished job. Without a `threadId`, create a new job.

Notifications only read `CODEXCTL_GROK_BOT_NOTIFY_URL` and `CODEXCTL_GROK_BOT_NOTIFY_KEY` from the environment. Do not put their values in documents or prompts. See the repository's [README](../../README.md#notifications) and [agent contract](../../docs/codexctl-agent-contract.md) for notification details and JSON output.
