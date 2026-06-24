---
name: codexctl
description: Use codexctl to delegate work to another Codex/app-server job and monitor it as structured JSON. Trigger when the user asks to "ask another agent", "delegate to another Codex", "run a background Codex job", "dogfood codexctl", "review this with another agent", "start/wait/inspect a Codex job", or build/operate an AI-agent controller around Codex app-server.
---

# codexctl

Use `codexctl` as the job-oriented control surface for Codex app-server.

Prefer it when the user wants another agent to work independently, review a diff, run a background task, or when you need a structured JSON controller loop over Codex jobs.

## First Checks

1. Locate the repository or installed binary.
2. Run `codexctl doctor --json` before starting work.
3. Use `codexctl --help` and the repository's `docs/codexctl-agent-contract.md` as command truth sources.
4. Keep this skill as workflow guidance only; do not copy long command catalogs here.

If `codexctl` is not installed or the repository is not available, read [references/setup.md](references/setup.md).

## Delegate Work

For "ask another agent" style requests, create a stable job key and run one background job:

```sh
codexctl job run --repo . --key <safe-key> --prompt "<task>" --events 0 --timeout-ms 600000 --json
```

Read the returned `wait` object.

- If terminal, summarize `wait.summary.finalResponse` or `wait.summary.error`.
- If `approval_required`, inspect approvals and ask/resolve explicitly; do not auto-approve risky work.
- If timeout, use `codexctl job summary <key> --events 10 --json` or `codexctl job wait <key> --json`.

Use `--force` only when you intentionally replace a non-live job record with the same key.

## Monitor Many Jobs

For controller or dogfooding workflows, use the supervisor inbox rather than polling individual jobs:

```sh
codexctl supervisor inbox --cursor <name> --limit 5 --timeout-ms 600000 --json
```

Process every returned `items[]` entry before acknowledging.

Only run the returned `ack.command`, or equivalent `codexctl supervisor ack <name> --tick <n> --json`, when `hasMore` is false and every returned item has been handled.

Never treat `ack` as action resolution. It only records a local tick receipt.

## Safety Boundaries

- Do not execute `nextCommand` blindly; inspect the action first.
- Do not auto-approve permissions, file changes, or commands unless the user or a written policy explicitly allows it.
- Prefer read-only supervisor commands for diagnosis.
- Use `supervisor apply` only with the documented confirmation token and only for supported mutations.
- Keep job prompts self-contained: include repo path, exact task, constraints, and expected output.

## References

- Setup and update paths: [references/setup.md](references/setup.md)
- Controller patterns and handoff workflow: [references/workflows.md](references/workflows.md)

