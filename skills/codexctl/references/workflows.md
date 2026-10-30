# ジョブの操作

## worktree で並列実行する

1. 未使用の key を決める。同じ `CODEXCTL_HOME` 内ではリポジトリが違っても key を重複させない。
2. Git で `~/src/worktrees/github.com/<owner>/<repo>/<key>` に worktree を作り、ブランチ名を `codex/<key>` にする。
3. worktree のパスを `job run` の `--repo` に渡す。プロンプトには目的・制約・変更の可否・期待する報告を書く。
4. 各ジョブを開始してから `job list` と各 key の `job wait` で確認する。作成例は [README](../../../README.md#worktree-で並列作業する) を参照する。

## 承認を確認する

```sh
codexctl approval list review
```

返された `id` を選び、`approval show` で `method` と `params` を確認します。承認判断は `approval approve` または `approval reject` で送ります。`--wait` を付けると別の承認か終了まで待ちます。permissions 承認への reject/cancel はエラーです。利用者の指示や承認方針が不明なら、判断を利用者に確認してください。

## 追加指示・中断・削除

以下は、作成済みの `review` ジョブに対する操作例です。必要な操作だけ実行してください。

```sh
codexctl job summary review --events 5
codexctl job steer review --prompt "最も重要な問題に絞って報告してください。"
codexctl job wait review --timeout-ms 600000
codexctl job cancel review
codexctl job wait review --timeout-ms 600000
codexctl job rm review --dry-run
```

終了済みへの steer は、同じ thread で新しい turn を開始します。`threadId` がなければ、新しい key でジョブを作成してください。cancel の返却は割り込み受付であり、完了は待機結果で確認します。worker がいなければ制御コマンドは処理されません。

`job rm` はジョブの状態を削除します。worktree の削除や変更の統合は、呼び出し側で別に判断してください。
