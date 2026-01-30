# Gemini 指示

## 目的
Gemini CLI 向けのコンテキストと作業方針を定義し、VRChat ユーザー監視ツールの開発を支援します。

## 基本設定

### 出力スタイル
- **言語**: 最終的なユーザーへの回答は日本語 (Gemini CLI 上の途中経過ログは簡潔な英語で記載)。
- **トーン**: 簡潔、専門的、丁寧。
- **形式**: Markdown。

### 共通ルール
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
- **セキュリティ**: `.env` (環境変数) や `data/` (Cookie、履歴) は機密情報を含むためコミット禁止。機密情報をログに出力しない。
- **優先事項**: 既存のプロジェクト規約を最優先する。
- **VRChat API ライブラリ (`vrchat` パッケージ)**: `vrchat` パッケージには型定義バグ修正のパッチ (`patches/vrchat@2.20.7.patch`) が適用されている。

## リポジトリ固有
- **技術スタック**: Node.js 24, TypeScript 5.x, pnpm 9.x
- **主要ライブラリ**: `vrchat` (patched), `@book000/node-utils`, `keyv-file`
- **ディレクトリ構成**:
  - `src/`: ソースコード (`config.ts`, `vrchat-client.ts`, `discord-notifier.ts`, `location-store.ts`, `main.ts`)
  - `data/`: 永続化データ
  - `patches/`: pnpm パッチ
- **Docker**: `compose.yaml` を使用して実行可能。

## 外部 API / VRChat 仕様メモ

- **公式・関連ドキュメント**
  - VRChat Creators Docs (公式): https://creators.vrchat.com/
  - VRChat Web API 参考情報 (コミュニティベース・非公式): https://vrchatapi.github.io/

- **認証方式 (概要)**
  - このプロジェクトは `vrchat` SDK を経由して VRChat Web API を利用する。
  - 認証は VRChat アカウントのユーザー名 / パスワードと 2FA (OTP) を前提とし、SDK が内部で Basic 認証およびセッション Cookie の管理を行う。
  - ユーザー名・パスワード・2FA シークレットなどの機密情報は `.env` から読み込み、リポジトリにはコミットしない。
  - 認証後に取得した Cookie は `data/` ディレクトリ配下に `keyv-file` で永続化し、再ログイン回数を減らす。
  - `apiKey` などのクエリパラメータは `vrchat` SDK が内部的に付与するため、アプリケーション側では直接扱わない。

- **WebSocket / イベント**
  - VRChat のリアルタイム通知は WebSocket で配信される。`vrchat` SDK は内部で VRChat のパイプラインサーバー (例: `wss://pipeline.vrchat.cloud/`) に接続する。
  - 本ツールで主に利用する想定のイベント:
    - `friend-location`: フレンドの Location 変更通知。ユーザーの現在 Location を監視し、変更時に Discord へ通知するために使用する。
    - `friend-online`: フレンドがオンラインになった際の通知。
    - `friend-offline`: フレンドがオフラインになった際の通知。
    - `notification`: 招待など、各種通知イベント。
  - 実装時の方針:
    - Location 変更検知は `friend-location` イベントをベースとし、`location-store.ts` で前回値との比較を行い、同一 Location の重複通知を抑制する。
    - VRChat API / WebSocket のイベント仕様に変更が入る可能性があるため、上記リンク先ドキュメントを随時確認し、破壊的変更があれば追随する。