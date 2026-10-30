# セットアップ

Bun と、app-server を利用できるインストール済み Codex が必要です。サンドボックス・承認・認証は Codex 自身の設定を使います。

## ソースから起動する

codexctl リポジトリのルートで実行します。

```sh
bun install
bun run src/cli.ts --help
```

CLI がインストール済みなら `codexctl --help` を使います。help は JSON の `usage` を返します。ジョブを実行して Codex を起動する前に、作業内容と対象リポジトリを決めてください。

## スキルを配置する

スキル管理ツールに `skills/codexctl/` を指定します。手順を更新するときはリポジトリ内の原本を編集し、管理ツールで再配置します。コマンドの仕様は `src/cli.ts` と実装を確認し、README・契約文書・スキルを揃えます。
