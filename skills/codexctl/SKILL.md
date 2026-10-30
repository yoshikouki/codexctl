---
name: codexctl
description: 別の Codex に作業を委任する、バックグラウンドで実行する、複数の Codex ジョブを確認する依頼に使う。インストール済み Codex の app-server を codexctl 経由で操作する。
---

# codexctl

codexctl は Codex の薄い制御レイヤーです。サンドボックスと承認は `~/.codex/config.toml` を含む Codex 自身の設定に従います。Codex の設定を変更しないでください。

## 始める

1. `codexctl --help` でコマンドを確認する。CLI がなければ [setup.md](references/setup.md) を読む。
2. ジョブの key を決め、プロンプトに目的・対象・変更の可否・制約・期待する報告を含める。
3. 編集を並列に行うときは、ジョブごとに worktree を用意する。[workflows.md](references/workflows.md) を参照する。

```sh
codexctl job run --repo . --key review --prompt "このリポジトリをレビューして問題点を報告してください。ファイルは変更しないでください。"
codexctl job wait review --timeout-ms 600000
```

`job run` は queued レコードを返します。待機結果は `job wait` から読みます。

- `reason: "terminal"`: `summary.status` と `summary.finalResponse` または `summary.error` を確認して報告する。
- `reason: "approval_required"`: `approval list` で内容を確認し、ユーザーの指示や承認方針に従って判断する。無条件に承認しない。
- `reason: "timeout"`: ジョブは継続する。`job summary` で状態を確認するか、再度 `job wait` で待つ。

状態は `~/.codexctl/jobs/<key>/`、または `CODEXCTL_HOME` 配下の `jobs/<key>/` にあります。終了済みジョブには `job steer` で同じ thread の続きを依頼できます。`threadId` がない場合は新規ジョブにします。

通知は `CODEXCTL_GROK_BOT_NOTIFY_URL` と `CODEXCTL_GROK_BOT_NOTIFY_KEY` を環境変数から読むだけです。値を文書やプロンプトに書かないでください。通知の詳細と JSON 出力はリポジトリの [README](../../README.md#通知) と [契約文書](../../docs/codexctl-agent-contract.md) を参照してください。
