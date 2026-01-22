# watch-vrchat-user プロジェクト指示

## プロジェクト概要

VRChat ユーザーの Location 変更を監視し、Discord に通知する Node.js アプリケーションです。

## 技術スタック

- **ランタイム**: Node.js 24
- **言語**: TypeScript 5.x
- **パッケージマネージャ**: pnpm 9.x（必須）
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

## 開発ルール

### 言語

- コード内のコメント・JSDoc は日本語で記載する
- エラーメッセージは英語で記載する
- 日本語と英数字の間には半角スペースを挿入する

### コーディング規約

- 関数・インターフェースには JSDoc を必ず記載する
- `skipLibCheck` を有効にして型エラーを回避してはならない
- ESLint / Prettier のルールに従う

### コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従う
- `<description>` は日本語で記載する
- 例: `feat: ユーザー状態の初期取得機能を追加`

### ブランチ規約

- [Conventional Branch](https://conventional-branch.github.io) に従う
- `<type>` は短縮形（feat, fix）で記載する
- 例: `feat/initial-status-fetch`

## 開発コマンド

```bash
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

## 注意事項

### VRChat SDK パッチ

`vrchat` パッケージには型定義のバグがあり、`patches/vrchat@2.20.7.patch` で修正しています。パッケージを更新する際はパッチの互換性を確認してください。

### 認証情報

- `.env` ファイルには機密情報が含まれるため、コミットしてはならない
- `data/` ディレクトリにも Cookie が保存されるため、コミットしてはならない

### Docker

Docker で実行する場合は `compose.yaml` を使用してください。

```bash
docker compose up -d
```
