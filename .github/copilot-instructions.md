# GitHub Copilot 指示

## プロジェクト概要

VRChat ユーザーの Location 変更を監視し、Discord に通知する Node.js アプリケーションです。

## 技術スタック

- **ランタイム**: Node.js 24
- **言語**: TypeScript 5.x
- **パッケージマネージャ**: pnpm 9.x（必須）
- **主要ライブラリ**:
  - `vrchat` - VRChat API SDK
  - `@book000/node-utils` - Discord Webhook 送信
  - `keyv-file` - Cookie 永続化

## コーディング規約

### 言語

- コード内のコメント・JSDoc は**日本語**で記載する
- エラーメッセージは**英語**で記載する
- 日本語と英数字の間には**半角スペース**を挿入する

### TypeScript

- 関数・インターフェースには JSDoc を必ず記載する
- `skipLibCheck` を有効にして型エラーを回避してはならない
- `any` 型の使用は避け、適切な型定義を行う
- ESLint / Prettier のルールに従う

### コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従う
- `<description>` は日本語で記載する
- 例: `feat: ユーザー状態の初期取得機能を追加`

## ディレクトリ構成

```text
src/
  config.ts          # 環境変数の読み込み・検証
  vrchat-client.ts   # VRChat SDK 初期化・認証
  discord-notifier.ts # Discord 通知送信
  location-store.ts  # ユーザー Location 状態管理
  main.ts            # エントリポイント
```

## 開発コマンド

```bash
pnpm dev      # 開発モード
pnpm start    # 本番実行
pnpm lint     # Lint チェック
pnpm fix      # Lint 修正
pnpm test     # テスト実行
```

## 注意事項

- `.env` ファイルには機密情報が含まれるため、コミットしてはならない
- `data/` ディレクトリには Cookie が保存されるため、コミットしてはならない
- `vrchat` パッケージにはパッチが適用されている（`patches/` ディレクトリ参照）
