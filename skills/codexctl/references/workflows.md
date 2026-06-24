# codexctl Agent Workflows

Use this reference for concrete orchestration patterns. Verify exact flags with `codexctl --help` before relying on them.

## One-off Delegation

Use when the user asks for another agent to review, investigate, or work independently.

```sh
codexctl job run \
  --repo . \
  --key <task-key> \
  --prompt "<self-contained task>" \
  --events 0 \
  --timeout-ms 600000 \
  --json
```

Good prompts include:

- current repository path
- exact goal
- constraints and files to inspect
- whether edits are allowed
- expected final output

After the job returns:

- summarize terminal results to the user
- inspect `approval_required` jobs before resolving
- keep the job key for follow-up `job summary`, `job wait`, or `job steer`

## Dogfood Review

Use when changing `codexctl` itself.

```sh
codexctl job run \
  --force \
  --repo . \
  --key dogfood-<topic>-review \
  --prompt "Review the current uncommitted codexctl diff. Focus only on severe correctness bugs. If no severe findings, say No severe findings." \
  --events 0 \
  --timeout-ms 300000 \
  --json
```

If the review finds severe issues, fix them and run a second dogfood review with a new key.

If app-server returns usage limits or auth errors, record the blocker and inspect it through supervisor inbox if relevant.

## Inbox Controller

Use for multiple jobs or long-running background supervision.

```sh
codexctl supervisor inbox --cursor default --limit 5 --timeout-ms 600000 --json
```

For each `items[]` entry:

1. read `action.kind`, `action.severity`, and `inspection`
2. decide whether to inspect further, ask the user, or run an explicit command
3. avoid automatic mutation unless a written policy allows it

When `hasMore` is false and all returned items have been handled:

```sh
codexctl supervisor ack default --tick <ack.tick> --json
```

When `hasMore` is true, call inbox again before acknowledging.

## Continuing From a Handoff

When a user points to a handoff or issue:

1. Read the referenced handoff document.
2. Verify current state with Git and tests.
3. Read `docs/codexctl-agent-contract.md` for the command contract.
4. Use `codexctl` itself for dogfood review where possible.
5. Commit logical slices.

Current handoff document at the time this skill was created:

```text
docs/2026-06-24-progress-handoff.md
```

