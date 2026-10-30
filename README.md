# codexctl

インストール済みの Codex を app-server 経由で動かす、薄い制御レイヤーです。ジョブをバックグラウンドで実行し、JSON で状態を確認したり、追加指示や承認を送ったりできます。

サンドボックスと承認は `~/.codex/config.toml` を含む Codex 自身の設定に従います。codexctl は Codex のコードや設定を書き換えず、モデル・ネットワーク・認証の設定も上書きしません。

## 実行する

Bun と app-server を利用できる Codex が必要です。リポジトリからの起動は次のとおりです。

```sh
bun run src/cli.ts --help
bun run src/cli.ts job run --repo . --key demo --prompt "このリポジトリの構成を説明してください。ファイルは変更しないでください。"
bun run src/cli.ts job wait demo --timeout-ms 600000
```

`job run` は detached worker を起動し、`queued` レコードをすぐ返します。`job wait` は終了・承認待ち・タイムアウトのいずれかで返ります。CLI をインストール済みなら、`bun run src/cli.ts` の代わりに `codexctl` を使えます。

出力は JSON、エラーは stderr の JSON です。`job events` は保存済みイベントを raw JSONL で出力します。コマンドと出力の一覧は [エージェント向け契約](docs/codexctl-agent-contract.md) にあります。

## 状態と追加指示

状態は `~/.codexctl/jobs/<key>/` に保存します。`CODEXCTL_HOME` を指定すると、その配下の `jobs/<key>/` を使います。key は同じ home 内で一意です。作業ディレクトリを移動しても同じ key を参照できます。

```sh
codexctl job summary demo --events 0
codexctl job steer demo --prompt "設定ファイルについても説明してください。" --wait --timeout-ms 600000
```

`completed`・`failed`・`cancelled` のジョブへの `steer` は、同じ `threadId` で新しい turn を開始します。`threadId` がないジョブは再開できないため、新しい key で作成します。

## worktree で並列作業する

ジョブごとに `~/src/worktrees/github.com/<owner>/<repo>/<key>` とブランチ `codex/<key>` を用意し、そのパスを `--repo` に渡します。worktree は呼び出し側が Git で作成します。

このリポジトリで、未使用の key とブランチを使う例です。

```sh
mkdir -p "$HOME/src/worktrees/github.com/yoshikouki/codexctl"
git worktree add -b codex/docs-review "$HOME/src/worktrees/github.com/yoshikouki/codexctl/docs-review" HEAD
git worktree add -b codex/tests-review "$HOME/src/worktrees/github.com/yoshikouki/codexctl/tests-review" HEAD
codexctl job run --repo "$HOME/src/worktrees/github.com/yoshikouki/codexctl/docs-review" --key docs-review --prompt "文書をレビューし、不一致を報告してください。変更はしないでください。"
codexctl job run --repo "$HOME/src/worktrees/github.com/yoshikouki/codexctl/tests-review" --key tests-review --prompt "テストをレビューし、不足を報告してください。変更はしないでください。"
codexctl job list
codexctl job wait docs-review --timeout-ms 600000
codexctl job wait tests-review --timeout-ms 600000
```

## 通知

`CODEXCTL_GROK_BOT_NOTIFY_URL` と `CODEXCTL_GROK_BOT_NOTIFY_KEY` は環境変数から読むだけで、通知処理は保存しません。自動通知は worker が起動時に引き継いだ環境、`job notify` は呼び出し元の環境を使います。

- worker が終了状態に達すると `job.completed`・`job.failed`・`job.cancelled` を送ります。再開後の終了も対象です。
- 承認要求では worker 内の承認 ID ごとに一度 `approval.requested` を送ります。
- `codexctl job notify demo` は現在の状態を `job.status` として一度送ります。
- URL がなければ自動通知は無効です。URL があって key がなければ送信せず、`missing_key` を記録します。

JSON POST に `Content-Type: application/json` と Bearer 認証を使います。payload は `source: "codexctl"`、`event`、`key`、`status`、`repo`、`threadId`、`turnId`、ISO 時刻の `at`、`finalResponse` です。`threadId` と `turnId` は null の場合があります。`finalResponse` は最大 2,000 Unicode コードポイントで、`approval.requested` だけに `approvalId` を加えます。

prompt・承認の params・error・環境変数は payload に含めません。通知 URL/key と一致する文字列は伏せますが、それ以外の秘密情報を自動判別する機能はありません。

送信は10秒で打ち切り、再送もリダイレクト追従もしません。HTTP 200 を成功として `notify.sent`、失敗を `notify.failed` に記録します。通知失敗でジョブの状態は変わりません。イベントの記録自体に失敗した場合は記録を省略します。起動前のキャンセルも worker が処理すると通知しますが、worker の起動失敗では自動通知しません。

## エージェント向けスキル

[skills/codexctl/SKILL.md](skills/codexctl/SKILL.md) に委任・承認・再開の手順があります。スキルの管理ツールには `skills/codexctl/` を指定してください。
