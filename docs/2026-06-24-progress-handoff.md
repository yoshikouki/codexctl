# codexctl Progress Handoff: 2026-06-24

This document is the restart point for a future Codex session.

If the user says "これを把握してゴールを達成してください", read this file first, then verify the current repository state before acting.

## Goal

Build `codexctl`: a Bun-based CLI that wraps Codex app-server as a job-oriented control surface for AI agents and humans.

The design center is `Job`, not app-server `Thread`.

The intended end state is a dogfooded controller workflow:

1. Start Codex work through app-server.
2. Persist job state and app-server events.
3. Let agents observe actionable state as structured JSON.
4. Let a supervisor/controller loop inspect multiple jobs.
5. Dogfood `codexctl` itself while developing `codexctl`.

## Current Repository State

Last known implementation commit:

```text
1c28988 feat(supervisor): persist controller cursors
```

The main contract document is:

```text
docs/codexctl-agent-contract.md
```

Read it as the command-level truth source. This handoff is a progress summary and continuation guide.

## What Works Now

### App-server Health

`codexctl doctor --json` checks the managed Codex app-server daemon and transport.

Known-good smoke command:

```sh
./src/cli.ts doctor --json
```

### Job Lifecycle

Jobs are the agent-visible unit of work.

Supported commands include:

```sh
codexctl job start --detach --repo . --key demo --prompt "Respond exactly: ok" --json
codexctl job run --repo . --key demo --prompt "Respond exactly: ok" --timeout-ms 600000 --json
codexctl job wait demo --events 0 --timeout-ms 600000 --json
codexctl job summary demo --events 10 --json
codexctl job list --json
codexctl job status demo --json
codexctl job events demo --format compact --json
codexctl job watch demo --format compact --json
```

`job run` composes detached start and bounded wait. It returns `{ key, started, wait }`.

It does not auto-resolve approvals.

### Control Commands

The worker reads append-only control commands from `control.jsonl`.

Supported control surfaces:

```sh
codexctl job steer demo --prompt "Narrow the answer." --wait --json
codexctl job cancel demo --wait --json
codexctl approval approve demo <approval-id> --wait --json
codexctl approval reject demo <approval-id> --wait --json
```

The `--wait` forms return the next `job wait` shape after enqueueing the control command.

Approval `--wait` ignores the approval ID it just enqueued to avoid immediately returning the same pending approval before the worker consumes `control.jsonl`.

### Job Recovery and Cleanup

Supported primitives:

```sh
codexctl job reconcile --dry-run --json
codexctl job sweep --json
codexctl job recover demo --json
codexctl job rm demo --json
codexctl job prune --keep 10 --status completed --dry-run --json
```

Current recovery rule:

- Queued jobs and jobs whose worker died before thread creation can be restarted.
- In-flight app-server stdio sessions cannot be resumed safely; if the worker is gone, the job is marked failed rather than replayed.

### Supervisor Lifecycle

The supervisor can run as a detached reconciliation loop.

```sh
codexctl supervisor start --interval-ms 1000 --json
codexctl supervisor status --json
codexctl supervisor stop --json
codexctl supervisor run --interval-ms 1000 --json
codexctl supervisor once --json
```

Safety properties already implemented:

- `supervisorId` is stored in state and passed to the detached child.
- `stop` verifies process identity before sending `SIGTERM`.
- lifecycle transitions are serialized by `.codexctl/supervisor/lifecycle.lock`.
- stale lifecycle locks can be recovered.
- state writes use atomic rename.

### Supervisor Observation

The supervisor emits non-mutating action recommendations.

```sh
codexctl supervisor plan --json
codexctl supervisor actions --ticks 10 --json
codexctl supervisor wait --after-tick 10 --timeout-ms 600000 --json
```

`supervisor wait` returns when there are fresh actions, a new tick, a stopped/stale state, or timeout.

`tickCount` is a monotonic state cursor across supervisor restarts.

### Controller Shortcuts

Single-action shortcut:

```sh
codexctl supervisor next --timeout-ms 600000 --json
```

Batch shortcut:

```sh
codexctl supervisor inbox --timeout-ms 600000 --limit 5 --json
```

Both start the detached supervisor if needed, wait for fresh state, then perform read-only inspection.

They do not:

- apply actions
- resolve approvals
- cancel jobs
- mutate job records
- execute `nextCommand`

### Controller-local Inbox Cursor

Latest implemented feature:

```sh
codexctl supervisor inbox --cursor live --interval-ms 1 --timeout-ms 5000 --max-ticks 1 --limit 3 --json
codexctl supervisor ack live --tick 4 --json
```

`inbox --cursor <name>` reads `.codexctl/supervisor/cursors/<name>.json`.

Response shape includes:

```json
{
  "cursor": { "name": "live", "afterTick": 3, "updatedAt": "..." },
  "ack": { "name": "live", "tick": 4, "command": "codexctl supervisor ack live --tick 4 --json" },
  "totalActions": 1,
  "hasMore": false,
  "items": []
}
```

Cursor safety contract:

- `ack` is only a local tick receipt.
- `ack` does not resolve, hide, or suppress individual actions.
- `ack` does not mutate jobs.
- cursor names are limited to `[A-Za-z0-9._-]{1,80}`.
- `--after-tick` overrides the stored cursor for that call.
- if `--limit` hides some fresh actions, the response returns `hasMore: true` and `ack: null`.
- per-cursor locking serializes read/max/write so concurrent acks do not regress `afterTick`.

## Dogfooding So Far

`codexctl` has been used to review and improve its own implementation.

Examples of dogfood jobs already run:

```text
dogfood-job-wait-review
dogfood-job-run-review
dogfood-approval-wait-review
dogfood-control-wait-review
dogfood-supervisor-start-review*
dogfood-supervisor-wait-review*
dogfood-supervisor-next-review*
dogfood-supervisor-inbox-review
dogfood-supervisor-cursor-review
```

Dogfood reviews found and drove fixes for:

- default cursor race in `supervisor next`
- wait/inspect re-plan race
- detached supervisor start/stop race
- PID reuse and unsafe process identity assumptions
- stale lock recovery
- reused-pid stale lock handling
- `inbox --limit` offering an ack that could skip unreturned actions
- concurrent ack regression

The most recent repeat dogfood review, `dogfood-supervisor-cursor-review-2`, did not complete because Codex app-server returned `usageLimitExceeded`.

That failure was still useful: supervisor inbox observed it as an `inspect_error` action, proving the controller observation path can surface app-server failures.

## Last Known Validation

Run from repository root:

```sh
git diff --check
bun run typecheck
bun run test
./src/cli.ts doctor --json
./src/cli.ts supervisor inbox --cursor live --interval-ms 1 --timeout-ms 5000 --max-ticks 1 --limit 3 --json
./src/cli.ts supervisor ack live --tick 3 --json
./src/cli.ts supervisor ack live --tick 4 --json
```

Last known test result:

```text
56 pass
0 fail
474 expect() calls
```

Before continuing after a week, re-run at least:

```sh
bun run typecheck
bun run test
./src/cli.ts doctor --json
```

## Remaining Work

### 1. Persistent Controller Loop

Next natural feature:

```sh
codexctl controller run --cursor default --json
```

Expected behavior:

1. call `supervisor inbox --cursor <name>`
2. inspect all returned actions
3. decide whether to act, ask, or defer
4. ack only after the controller has processed all returned actions
5. repeat until interrupted

Important: do not ack when `hasMore` is true.

### 2. Policy Execution Layer

Current `policy` fields are observational hints only.

Needed:

- explicit policy table
- safe defaults
- dry-run mode
- clear boundary between automatic actions and human-confirmed actions

Possible policy categories:

- always inspect
- escalate to human
- auto-apply safe recovery after threshold
- never auto-resolve approval without explicit policy

### 3. Approval and Permission Strategy

Approvals are externally visible and manually resolvable, but not automatically decided.

Needed:

- a policy model for command/file approvals
- explicit handling for `item/permissions/requestApproval`
- session-scoped permission grants only under clear policy
- audit trail for any automatic approval

### 4. Multi-job Scheduling

Current jobs can run concurrently, but there is no higher-level queue/scheduler.

Needed:

- max concurrent jobs
- retry policy
- priority
- per-repo grouping
- stale/failed job backoff
- controller-level summary

### 5. Human UX

Current output is mostly agent-friendly JSON.

Potential human-facing commands:

```sh
codexctl inbox
codexctl dashboard
codexctl controller status
```

Keep JSON contracts stable first. Human UX should be a layer over the same primitives.

### 6. JSON Contract Hardening

Needed:

- schema-like fixtures for public commands
- compatibility tests for command output shape
- stricter docs around stable vs experimental fields
- examples for controller authors

### 7. App-server Failure Handling

Known live failure:

```text
usageLimitExceeded
```

Currently surfaced as `inspect_error`.

Needed:

- classify transient vs quota vs auth vs app-server protocol errors
- controller retry/backoff behavior
- user-facing escalation message

## Suggested Next Session Plan

1. Verify current state:

   ```sh
   git status --short --branch
   bun run typecheck
   bun run test
   ./src/cli.ts doctor --json
   ```

2. Read:

   ```text
   docs/codexctl-agent-contract.md
   docs/2026-06-24-progress-handoff.md
   ```

3. Implement the smallest useful persistent controller:

   ```sh
   codexctl controller run --cursor default --interval-ms 1000 --json
   ```

4. Keep it conservative:

   - read inbox
   - print or persist decisions
   - do not auto-approve
   - do not auto-cancel
   - do not auto-apply recovery
   - ack only fully returned batches

5. Dogfood it against `codexctl` itself.

6. Commit and push each logical slice.

## Design Boundary to Preserve

`codexctl` should remain a control surface, not a hidden autonomous agent framework.

The elegant split is:

- app-server owns Codex execution
- job worker owns one app-server stdio session
- supervisor owns reconciliation and action observation
- controller owns policy and ack
- human/agent owns final authority for risky decisions unless an explicit policy says otherwise

