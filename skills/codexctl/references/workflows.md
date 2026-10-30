# Job operations

## Run in parallel with worktrees

1. Choose an unused key. Do not reuse keys within the same `CODEXCTL_HOME`, even across repositories.
2. Use Git to create a worktree at `~/src/worktrees/github.com/<owner>/<repo>/<key>` on branch `codex/<key>`.
3. Pass the worktree path to `job run` with `--repo`. Include the goal, constraints, whether changes are allowed, and expected report in the prompt.
4. Start each job, then check `job list` and `job wait` for each key. See the [README](../../../README.md#parallel-work-with-worktrees) for a creation example.

## Review approvals

```sh
codexctl approval list review
```

Choose a returned `id` and inspect `method` and `params` with `approval show`. Send a decision with `approval approve` or `approval reject`. Add `--wait` to wait for completion or another approval. Reject and cancel are errors for permissions approvals. If the user's instructions or policy for approvals are unclear, ask the user to decide.

## Follow-up instructions, interruption, and removal

These examples operate on an existing `review` job. Run only the operations you need.

```sh
codexctl job summary review --events 5
codexctl job steer review --prompt "Report only the most important issues."
codexctl job wait review --timeout-ms 600000
codexctl job cancel review
codexctl job wait review --timeout-ms 600000
codexctl job rm review --dry-run
```

Steering finished jobs starts a new turn in the same thread. Without a `threadId`, use a new key to create a job. The cancel response confirms receipt of an interrupt; check completion through the wait result. Without a worker, control commands are not processed.

`job rm` deletes the state of a job. The caller decides separately whether to remove the worktree or integrate changes.
