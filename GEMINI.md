# Gemini 指示

## プロジェクト概要

VRChat ユーザーの Location 変更を監視し、Discord に通知する Node.js アプリケーションです。

## 技術スタック

- **ランタイム**: Node.js 24
- **言語**: TypeScript 5.x
- **パッケージマネージャ**: pnpm 9.x（必須、npm/yarn は使用不可）
- **主要ライブラリ**:
  - `vrchat` - VRChat API SDK（パッチ適用済み）
  - `@book000/node-utils` - Discord Webhook 送信
  - `keyv-file` - Cookie 永続化

## ディレクトリ構成

```text
src/
  config.ts          # 環境変数の読み込み・検証
  vrchat-client.ts   # VRChat SDK 初期化・認証
  discord-notifier.ts # Discord 通知送信
  location-store.ts  # ユーザー Location 状態管理
  main.ts            # エントリポイント
data/                # 永続化データ（Cookie、Location 履歴）
patches/             # pnpm パッチファイル
```

## コーディング規約

### 言語ルール

- コード内のコメント・JSDoc は**日本語**で記載すること
- エラーメッセージは**英語**で記載すること
- 日本語と英数字の間には**半角スペース**を挿入すること

### TypeScript ルール

- 関数・インターフェースには JSDoc を必ず記載すること
- `skipLibCheck` を有効にして型エラーを回避してはならない
- `any` 型の使用は避け、適切な型定義を行うこと
- ESLint / Prettier のルールに従うこと

### コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従うこと
- `<description>` は日本語で記載すること
- 例: `feat: ユーザー状態の初期取得機能を追加`

### ブランチ規約

- [Conventional Branch](https://conventional-branch.github.io) に従うこと
- `<type>` は短縮形（feat, fix）で記載すること
- 例: `feat/initial-status-fetch`

## 開発コマンド

```bash
# 依存パッケージのインストール
pnpm install

# 開発モード（ホットリロード）
pnpm dev

# 本番実行
pnpm start

# Lint チェック
pnpm lint

# Lint 修正
pnpm fix

# テスト実行
pnpm test
```

## 外部依存情報

### VRChat API

- 公式ドキュメント: https://vrchatapi.github.io/
- 認証方式: Cookie ベース（2FA 対応）
- WebSocket: friend-location, friend-online, friend-offline イベントを使用

### Discord Webhook

- 標準的な Discord Webhook API を使用
- Embed 形式で通知を送信

## 注意事項

### 機密情報

以下のファイル・ディレクトリには機密情報が含まれるため、絶対にコミットしてはならない：

- `.env` - 環境変数（VRChat 認証情報、Discord Webhook URL）
- `data/` - Cookie、Location 履歴

### VRChat SDK パッチ

`vrchat` パッケージには型定義のバグがあり、`patches/vrchat@2.20.7.patch` で修正しています。パッケージを更新する際はパッチの互換性を確認してください。

### Docker

Docker で実行する場合は `compose.yaml` を使用してください：

```bash
docker compose up -d
```

## 調査・確認時の注意

外部 API や最新仕様を調査する際は、以下を確認してください：

1. VRChat API の仕様変更
2. Discord Webhook API の制限・レートリミット
3. Node.js / TypeScript のバージョン互換性
4. 使用ライブラリの最新バージョンとの互換性
