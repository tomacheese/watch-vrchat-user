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
- 目的: VRChat ユーザーの Location 変更を監視し、Discord に通知する
- 主な機能: VRChat WebSocket イベント監視 (補助的に VRChat API ポーリング)、Discord Webhook 通知

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
- `src/vrchat/session.ts`: VRChat REST 認証・Cookie 永続化・2FA・`getUser`/`isFriend`/`getFriendIds` を担う（Pipeline 開始は担当しない）
- `src/vrchat/pipeline-transport.ts`: VRChat SDK の raw WebSocket (`open`/`close`/`error`/`message`/`pong`/`readyState`) への唯一のアクセス経路
- `src/vrchat/pipeline-supervisor.ts`: Pipeline の接続状態・connection generation・liveness・reconnect backoff を管理する
- `src/vrchat/pipeline-event-router.ts`: `friend-location` / `friend-online` / `friend-offline` を正規化して `UserStateCoordinator` へ渡す
- `src/state/user-state-reducer.ts`: WebSocket event / REST snapshot 共通の純粋な状態遷移関数
- `src/state/user-state-repository.ts`: `user-locations.json` への store-wide lock 付き atomic 読み書き
- `src/state/user-state-coordinator.ts`: ユーザーごとの observation を直列処理する single-writer queue
- `src/state/reconciler.ts`: REST snapshot を compare-and-enqueue で queue に追記する
- `src/notifications/discord-notifier.ts`: Discord 通知処理 (`location-change` / `online` / `offline`、bounded timeout 付き)
- `src/health/health-service.ts`: localhost のみでアクセス可能なヘルスチェック HTTP サーバー (supervisor state・generation・per-user unhealthy 等を返す)
- `src/config.ts`: 環境変数からの設定読み込みとバリデーション
- `src/logger-utils.ts`: unknown 型の値を Error に変換する `toError` ヘルパーを提供する
- `data/`: 永続化データ保存先 (Cookie 等)

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
- Location 変更検知は `friend-location` を基準に `src/state/user-state-reducer.ts` で前回値と比較し、同一 Location の重複通知を抑制する
- 仕様変更の可能性があるため、公式 (https://creators.vrchat.com/) / 非公式コミュニティ (https://vrchatapi.github.io/) のドキュメントを随時確認する

## テスト
- **フレームワーク**: Jest (`ts-jest`)。テスト対象は `**/*.test.ts`
- **現状**: テストファイルは未整備 (`pnpm test` は `--passWithNoTests` で通る)。ロジック部分は可能な限りテストを追加する
- **コマンド**: `pnpm test` (カバレッジ計測込み)

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
- `patches/vrchat@2.20.7.patch` によるパッチが適用されているため、`vrchat` パッケージの更新時はパッチの整合性を確認する。