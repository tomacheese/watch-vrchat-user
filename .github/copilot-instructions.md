# GitHub Copilot Instructions

## プロジェクト概要
- 目的: VRChat ユーザーの Location 変更を監視し、Discord に通知する
- 主な機能: VRChat API 監視、Discord 通知、Cookie 永続化
- 対象ユーザー: 開発者

## 共通ルール
- 会話は日本語で行う。
- PR とコミットは Conventional Commits に従う。
- 日本語と英数字の間には半角スペースを入れる。

## 技術スタック
- 言語: TypeScript
- ランタイム: Node.js 24
- パッケージマネージャー: pnpm
- 主要ライブラリ: vrchat, @book000/node-utils, keyv-file

## コーディング規約
- フォーマット: Prettier
- Lint: ESLint
- 型チェック: TypeScript (skipLibCheck 禁止)
- ドキュメント: JSDoc (日本語)

## 開発コマンド
```bash
# 依存関係のインストール
pnpm install

# 開発
pnpm dev

# ビルド (TS実行)
pnpm start

# Lint
pnpm lint

# Format
pnpm fix

# テスト
pnpm test
```

## テスト方針
- テストフレームワーク: Jest
- テストコマンド: `pnpm test`
- カバレッジ計測: `pnpm test` (デフォルトで有効)

## セキュリティ / 機密情報
- .env ファイルに環境変数を保存し、コミットしない。
- data/ ディレクトリの Cookie や履歴をコミットしない。
- ログに認証トークンや個人情報を出力しない。

## ドキュメント更新
- README.md: 機能変更時
- GEMINI.md: コンテキスト変更時

## リポジトリ固有
- VRChat SDK にパッチ (`patches/vrchat@2.20.7.patch`) を適用しているため、更新時は注意する。