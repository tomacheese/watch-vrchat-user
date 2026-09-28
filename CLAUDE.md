# Claude Code Guidelines

## 目的
このドキュメントは、Claude Code の作業方針とプロジェクト固有ルールを示すものです。

## 判断記録のルール
1. 判断内容の要約を記載する
2. 検討した代替案を列挙する
3. 採用しなかった案とその理由を明記する
4. 前提条件・仮定・不確実性を明示する
5. 他エージェントによるレビュー可否を示す

前提・仮定・不確実性を明示し、仮定を事実のように扱わないでください。

## プロジェクト概要
- 目的: VRChat の全フレンドの状態変化を監視し、YAML 設定の CEL ルールに一致したものを Discord に通知する
- 主な機能: VRChat WebSocket イベント監視 (補助的に Friends API による REST reconciliation)、CEL ルールによる通知条件・通知先 (Discord Webhook) の振り分け、設定ファイルの hot reload

## 重要ルール
- **会話言語**: 日本語
- **コミット規約**: Conventional Commits (`<type>(<scope>): <description>`, description は日本語)
- **コメント言語**: 日本語
- **エラーメッセージ**: 英語
- **記述ルール**: 日本語と英数字の間に半角スペースを挿入

## 環境のルール
- **ブランチ命名**: Conventional Branch (`feat/xxx`, `fix/xxx`)
- **GitHub 調査**: 必要に応じてテンポラリディレクトリに clone して調査
- **Renovate**: Renovate PR には直接コミットしない
  - 理由: Renovate が管理するブランチに手動変更を加えると、再生成時のコンフリクト増加や履歴の不整合を招くため
  - 対応方針:
    - Renovate PR は「変更内容の確認・テスト」のみに用い、コード修正や設定変更は通常の `feat/xxx` / `fix/xxx` ブランチで行う
    - Renovate が提案した変更を採用する場合は、同内容を手動で別ブランチに反映し、通常の PR を作成してマージする
    - 依存関係をまとめて更新したい場合は、該当 Renovate PR を Close し、手動で依存更新用ブランチを切って対応する

## コード改修時のルール
- **エラーメッセージ**: 絵文字を使用する場合、メッセージ全体で統一する
- **TypeScript**: `skipLibCheck` は使用禁止
- **ドキュメント**: 関数・インターフェースに日本語の JSDoc を記載

## 開発コマンド
```bash
# 依存関係インストール
pnpm install

# 開発サーバー (ホットリロード)
pnpm dev

# 本番実行
pnpm start

# Lint 実行
pnpm lint

# 自動修正 (Format & Lint Fix)
pnpm fix

# テスト実行
pnpm test
```

## アーキテクチャと主要ファイル
- `src/main.ts`: エントリーポイント。設定読み込みと `App` の起動・シグナルハンドリングのみを担う
- `src/app.ts`: 各モジュールの配線と起動・reconnect・定期 REST reconciliation シーケンスを担う
- `src/config.ts`: 環境変数からの VRChat 認証情報・パス設定 (`CONFIG_PATH` / `STATE_FILE_PATH` / `WORLD_CACHE_FILE_PATH` 等) の読み込みとバリデーション
- `src/config/config-file.ts`: YAML 設定ファイルのパース・検証 (destinations の `${ENV_VAR}` 展開を含む)
- `src/config/config-manager.ts`: 設定ファイルの hot reload と last-known-good の保持
- `src/config/config-snapshot.ts`: 検証・compile 済みの設定スナップショット
- `src/rules/rule-engine.ts`: CEL ルールの compile / 評価と `RuleErrorLog`
- `src/rules/rule-context.ts`: effect から CEL 変数 (`event` / `user` / `previous` / `current`) を組み立てる
- `src/vrchat/session.ts`: VRChat REST 認証・Cookie 永続化・2FA・Friends API の取得を担う（Pipeline 開始は担当しない）
- `src/vrchat/pipeline-transport.ts`: VRChat SDK の raw WebSocket (`open`/`close`/`error`/`message`/`pong`/`readyState`) への唯一のアクセス経路
- `src/vrchat/pipeline-supervisor.ts`: Pipeline の接続状態・connection generation・liveness・reconnect backoff を管理する
- `src/vrchat/pipeline-event-router.ts`: `friend-location` / `friend-online` / `friend-offline` / `friend-add` / `friend-delete` を正規化して `UserStateCoordinator` へ渡す
- `src/vrchat/world-resolver.ts`: World 情報の取得と 24 時間 TTL の永続キャッシュ
- `src/vrchat/favorites-service.ts`: Favorite Friends (`group_0`〜`group_3`) の取得と 1 時間ごとの更新
- `src/state/location.ts`: raw Location 文字列のパース (visible 判定・World ID・instance type 等)
- `src/state/user-state.ts`: 全フレンドの永続 state (`FriendState`) の型と検証
- `src/state/user-state-reducer.ts`: WebSocket event / REST snapshot 共通の純粋な状態遷移関数 (baseline・`friend-add` / `friend-delete` を含む)
- `src/state/user-state-repository.ts`: `friend-states.json` (schemaVersion 3) への store-wide lock 付き atomic 読み書き
- `src/state/user-state-coordinator.ts`: ユーザーごとの observation を直列処理する single-writer queue
- `src/state/reconciler.ts`: Friends API のスナップショットを compare-and-enqueue で queue に追記する
- `src/notifications/notification-dispatcher.ts`: effect に対して全ルールを評価し、一致した destination ごとに 1 通へまとめて送信を依頼する
- `src/notifications/embed-builder.ts`: Discord Embed の組み立て (World 情報・一致したルール名の footer 表示を含む)
- `src/notifications/discord-notifier.ts`: Discord Webhook への送信 (bounded timeout 付き)
- `src/health/health-service.ts`: localhost のみでアクセス可能なヘルスチェック HTTP サーバー (supervisor state・generation・接続診断履歴・per-user unhealthy・`config`・`ruleErrors`・`favorites` を返し、`status` は `healthy` / `degraded` / `unhealthy`)
- `src/logger-utils.ts`: unknown 型の値を Error に変換する `toError` ヘルパーを提供する
- `config.example.yaml`: 通知ルール設定ファイルの例 (`data/config.yaml` として配置する。テストで parse / compile を検証している)
- `data/`: 永続化データ保存先 (Cookie・`friend-states.json`・`world-cache.json`・`config.yaml` 等)

## 実装パターン
- **VRChat API**: `vrchat` パッケージを使用 (パッチ適用済み)
- **永続化**: `keyv-file` を使用してローカルファイルに保存

## セキュリティ / 機密情報
- `.env` (認証情報) や `data/` (Cookie・履歴) は機密情報を含むためコミットしない
- 認証トークンなどの機密情報をログに出力しない
- パッケージマネージャーは `pnpm` のみ (npm/yarn は `preinstall` の `only-allow` で禁止)

## VRChat API / WebSocket メモ
- VRChat Web API は `vrchat` SDK 経由で利用する。`apiKey` 等のクエリパラメータは SDK が内部付与するため、アプリ側では扱わない
- 認証はユーザー名 / パスワード + 2FA (TOTP)。取得した Cookie は `data/` に `keyv-file` で永続化し、再ログイン回数を減らす
- リアルタイム通知は VRChat パイプラインサーバー (`wss://pipeline.vrchat.cloud/`) の WebSocket で配信される
- 主に利用するイベント: `friend-location` (Location 変更・監視の中心)、`friend-online`、`friend-offline`、`notification`
- Location 変更検知は `friend-location` を基準に `src/state/user-state-reducer.ts` で前回値と比較し、同一 Location の重複通知を抑制する。previous / current の両方が visible (`wrld_` 始まり) の場合のみ `location-change` を生成し、private への遷移や `traveling` は通知しない
- `friend-add` / `friend-delete` は SDK の型に現れないため、ペイロード形状は非公式ドキュメントに基づく想定であり router 側で型ガード検証する
- 仕様変更の可能性があるため、公式 (https://creators.vrchat.com/) / 非公式コミュニティ (https://vrchatapi.github.io/) のドキュメントを随時確認する

## テスト
- **フレームワーク**: Jest (`ts-jest`)。テスト対象は `**/*.test.ts`
- **現状**: config・rules・state・vrchat・notifications・health・app の主要ロジックにテストが整備済み (件数は `pnpm test` の出力を参照)
- **コマンド**: `pnpm test` (カバレッジ計測込み)
- 新規ロジック追加時は既存のテストパターンに沿ってテストを追加する

## ドキュメント更新ルール
- **タイミング**: 機能追加・変更時、アーキテクチャや主要ファイル構成の変更時
- **対象**: `README.md`、`CLAUDE.md` (本ファイル)、`.github/copilot-instructions.md`
- **CLAUDE.md 自体の更新**: `src/` の主要ファイル追加・削除、開発コマンドの変更、依存関係の大幅な更新時は本ファイルの該当セクションも更新する

## 作業チェックリスト

### 新規改修時
1. プロジェクトを理解する
2. 作業ブランチが適切であることを確認する
3. 最新のリモートブランチに基づいた新規ブランチであることを確認する
4. クローズされた PR の不要ブランチが削除済みであることを確認する
5. 指定されたパッケージマネージャー (`pnpm`) で依存関係をインストールする

### コミット・プッシュ前
1. Conventional Commits に従っていることを確認する
2. センシティブな情報が含まれていないことを確認する
3. Lint / Format エラーがないことを確認する
4. 動作確認を行う

### PR 作成前
1. PR 作成の依頼があることを確認する
2. センシティブな情報が含まれていないことを確認する
3. コンフリクトの恐れがないことを確認する

### PR 作成後
1. コンフリクトがないことを確認する
2. PR 本文が最新のコミットに含まれる変更内容を正確に反映していることを確認する
3. `gh pr checks <PR ID> --watch` で CI を確認する
4. Copilot レビューに対応し、コメントに返信する
5. Claude Code によるコードレビューを実施し、指摘対応を行う
6. PR 本文の崩れがないことを確認する

## リポジトリ固有
- `patches/vrchat@2.24.0.patch` によるパッチが適用されているため、`vrchat` パッケージの更新時はパッチの整合性を確認する。