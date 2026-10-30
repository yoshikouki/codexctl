# codexctl エージェント向け契約

codexctl は、インストール済み Codex の app-server を操作する薄い制御レイヤーです。ジョブごとの detached worker が app-server と通信します。サンドボックス・承認は `~/.codex/config.toml` を含む Codex 自身の設定に従い、codexctl は設定を上書きしません。

## コマンドと出力

公開コマンドは `codexctl --help` で確認できます。help は `{ usage }`、通常の出力は JSON、エラーは stderr に `{ ok: false, error: { code, message } }` を出して非ゼロで終了します。`job events` だけは raw JSONL です。

表の `<key>`・`<prompt>`・`<id>` などは引数の表記です。

| コマンド | フラグ | JSON 出力の要点 |
| --- | --- | --- |
| `codexctl job run` | 必須: `--key <key> --prompt <prompt>`。任意: `--repo <path> --force` | 初期の JobRecord。`status: "queued"`、`key`、`repo`、`prompt`、時刻、thread/turn ID、承認など。待機しない |
| `codexctl job list` | なし | ジョブ一覧。`key`、`status`、`nextAction`、`workerAlive`、承認件数、thread/turn ID、`error` など。更新日時の降順 |
| `codexctl job summary <key>` | `--events <n>` | 下記の Summary |
| `codexctl job wait <key>` | `--events <n> --interval-ms <ms> --timeout-ms <ms>` | 下記の Wait |
| `codexctl job events <key>` | `--format raw` | 保存済みイベントを1行1件で出力して終了 |
| `codexctl job steer <key>` | 必須: `--prompt <prompt>`。任意: `--wait` と待機用フラグ | `id`、`type: "turn.steer"`、`at`、`input`。終了済みなら `resume: true`。待機時は `{ command, wait }` |
| `codexctl job cancel <key>` | `--wait` と待機用フラグ | `{ action, reason, job, command }`。`action` は `interrupt_queued` または `none`。待機時は `{ cancel, wait }` |
| `codexctl job rm <key>` | `--force --dry-run` | `{ action, key, status, reason }`。`action` は `removed` または `would_remove` |
| `codexctl job notify <key>` | なし | 送信成功時は `{ ok: true }`。未設定は `notify_not_configured`、送信失敗は `notify_failed` のエラー |
| `codexctl approval list <key>` | `--all` | 承認レコードの配列。既定は pending のみ。`--all` で解決済みも含む |
| `codexctl approval show <key> <id>` | なし | 承認レコード1件。`id`、`serverRequestId`、`method`、`params`、`status`、時刻、`decision`、`error` |
| `codexctl approval approve <key> <id>` | `--for-session --wait` と待機用フラグ | `{ id, type: "approval.resolve", at, approvalId, decision }`。待機時は `{ command, wait }` |
| `codexctl approval reject <key> <id>` | `--cancel --wait` と待機用フラグ | approve と同じ形。`decision` は `reject`、`--cancel` 指定時は `cancel` |

待機用フラグは `--events <n>`、`--interval-ms <ms>`、`--timeout-ms <ms>` です。`--wait` と組み合わせて使います。`--events` は0以上の整数で既定値5、間隔は正の整数で既定値1,000 ms、タイムアウトは正の整数で省略時は無期限です。

### Summary

`key`、`status`、`repo`、`threadId`、`turnId`、`createdAt`、`startedAt`、`completedAt`、`pendingApprovals: { count, ids }`、`latestAgentMessage`、`finalResponse`、`error`、`recentEvents` を返します。`latestAgentMessage` は最大 2,000 Unicode コードポイント、`finalResponse` は全文です。`--events 0` で `recentEvents` は空配列になります。

### Wait

`key`、`ready`、`reason`、`status`、`summary`、`elapsedMs`、`intervalMs`、`ignoredApprovalIds`、`timeoutMs`、`deadlineAt` を返します。

- `reason: "terminal"`: completed・failed・cancelled のいずれか。`ready: true`。
- `reason: "approval_required"`: running のジョブに未解決の承認がある。`ready: true`。
- `reason: "timeout"`: 待機期限に達した。`ready: false`。CLI エラーではなく、ジョブも停止しません。

承認判断の `--wait` は、いま送った承認 ID を待機対象から除外し、別の承認か終了を待ちます。ジョブの失敗と CLI の失敗は別なので、終了コードだけでなく `summary.status` と `summary.error` を確認してください。

## 状態と操作

- 状態は `~/.codexctl/jobs/<key>/`。`CODEXCTL_HOME` で home を変更できます。key は同じ home 内で一意で、cwd に依存しません。`--repo` の既定値だけが呼び出し元の `.` です。
- 保存ファイルは `job.json`、`events.jsonl`、`control.jsonl`、`worker.log`、`worker.err.log`。初期作成後の `job.json` 更新は worker だけが行い、ファイルを原子的に置換します。
- steer・cancel・承認判断は `control.jsonl` に追記します。返却は受付を示し、適用完了は示しません。worker がいなければ処理されず、待機はタイムアウトし得ます。
- cancel は割り込みをキューに入れます。起動前なら worker が app-server を起動せず cancelled にします。終了済みへの cancel は `action: "none"` です。
- `job run` の `--force` は既存レコードとログを初期化します。生存中の worker があれば拒否します。
- `job rm` はジョブの状態ディレクトリを削除します。通常は終了済みのみ、`--force` で終了していない記録や読めない記録も対象にできます。読めた記録に生存中の worker があれば、強制指定でも拒否します。worktree は削除しません。

## 終了済みジョブへの steer

completed・failed・cancelled への `steer` は新しい worker を起動し、同じ `threadId` を再開して新しい turn を開始します。`threadId` がなければエラーになるので、新しい key でジョブを作成してください。

新しい worker は前の worker の終了（通知送信を含む）を待ちます。turn ごとの回答・エラー・承認を初期化し、処理済みの制御コマンドは再実行しません。`steer --wait` と再開受付後の `job wait` は、以前の終了結果を返さず再開後の結果を待ちます。

## 承認

承認判断は running かつ pending の承認に送ります。自動承認はしません。`method` と `params` を確認してから判断してください。

コマンド・ファイル承認の approve は `accept`、reject は `decline`、cancel は `cancel` を返します。`--for-session` は `params.availableDecisions` にある `acceptWithExecpolicyAmendment` をそのまま使い、なければ `acceptForSession` を返します。

`item/permissions/requestApproval` では、要求された permissions をそのまま返し、通常は turn、`--for-session` では session の範囲で許可します。この承認への reject/cancel はエラーになります。

## 並列作業と通知

worktree は呼び出し側で `~/src/worktrees/github.com/<owner>/<repo>/<key>`、ブランチ `codex/<key>` として作成し、`job run` の `--repo` に渡します。各ジョブを開始してから、`job list` と各 key の `job wait` で結果を確認します。

通知の環境変数・送信契機・payload・10秒の期限・再送なしの仕様は [README の通知](../README.md#通知) を参照してください。
