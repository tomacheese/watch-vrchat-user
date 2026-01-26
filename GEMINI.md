# Gemini 指示

## 目的
Gemini CLI 向けのコンテキストと作業方針を定義し、VRChat ユーザー監視ツールの開発を支援します。

## 出力スタイル
- **言語**: 最終的なユーザーへの回答は日本語。途中経過は英語で簡潔に。
- **トーン**: 簡潔、専門的、丁寧。
- **形式**: Markdown。

## 共通ルール
- **会話言語**: 日本語
- **コミット規約**: [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) に従う。`<description>` は日本語。
- **ブランチ規約**: [Conventional Branch](https://conventional-branch.github.io) に従う。`<type>` は短縮形 (feat, fix)。
- **記述ルール**: 日本語と英数字の間に半角スペースを挿入。

## プロジェクト概要
VRChat ユーザーの Location 変更を監視し、Discord に通知する Node.js アプリケーションです。

## コーディング規約
- **言語ルール**: コメント・JSDoc は日本語。エラーメッセージは英語。
- **TypeScript**: `skipLibCheck` での回避禁止。`any` 型の回避。
- **フォーマット**: Prettier/ESLint のルールに従う。
- **ドキュメント**: 関数・インターフェースには JSDoc を記載。

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

## 注意事項
- **セキュリティ**: `.env` (環境変数) や `data/` (Cookie、履歴) は機密情報を含むためコミット禁止。ログへの出力も禁止。
- **優先事項**: 既存のプロジェクト規約を最優先する。
- **VRChat SDK**: `vrchat` パッケージには型定義バグ修正のパッチ (`patches/vrchat@2.20.7.patch`) が適用されている。

## リポジトリ固有
- **技術スタック**: Node.js 24, TypeScript 5.x, pnpm 9.x
- **主要ライブラリ**: `vrchat` (patched), `@book000/node-utils`, `keyv-file`
- **ディレクトリ構成**:
  - `src/`: ソースコード (`config.ts`, `vrchat-client.ts`, `discord-notifier.ts`, `location-store.ts`, `main.ts`)
  - `data/`: 永続化データ
  - `patches/`: pnpm パッチ
- **Docker**: `compose.yaml` を使用して実行可能。