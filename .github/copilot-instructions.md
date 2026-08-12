# GitHub Copilot コードレビュー指示

VRChat ユーザーの Location 変更を WebSocket で監視し、Discord に通知する Node.js / TypeScript アプリケーションです。このファイルは Copilot のコードレビュー向けに、指摘すべき点と指摘すべきでない点を示します。

## レビューで重視する点

- **機密情報の漏洩**: VRChat 認証情報 (ユーザー名・パスワード・TOTP シークレット)、Cookie、Discord Webhook URL をログ出力・エラーメッセージ・コミットに含めていないか。
- **エラーハンドリング**: WebSocket 切断・再接続、VRChat API 失敗、認証エラーが握りつぶされていないか。`pipeline-supervisor.ts` の接続状態遷移 (`connecting`/`synchronizing`/`ready`/`reconnecting`/`stopped`) や connection generation 管理が破綻していないか。
- **重複通知の抑制**: Location 変更検知で `user-state-reducer.ts` の前回値比較が正しく、同一 Location の重複通知を防いでいるか。`traveling` が通知・永続化に混入していないか。
- **型安全性**: `any` の新規使用や `skipLibCheck` による回避がないか。VRChat SDK / WebSocket イベントのペイロードに対する型付けが妥当か。
- **永続化の安全性**: `data/` 配下のファイル読み書きで、破損・不在時のフォールバックが考慮されているか。`user-state-repository.ts` の atomic write・store-wide lock が壊れていないか。

## 強制されている規約

- **フォーマット**: Prettier (`pnpm lint:prettier`)。
- **Lint**: ESLint (`@book000/eslint-config`, `pnpm lint:eslint`)。
- **型チェック**: `tsc` (`pnpm lint:tsc`)。`strict` 有効。
- **JSDoc**: 関数・インターフェースには日本語の JSDoc を記載する。
- **コメントは日本語、エラーメッセージは英語**。日本語と英数字の間には半角スペースを入れる。
- **コミット**: Conventional Commits (description は日本語)。

## 指摘すべきでない既知パターン

- `data/` へのファイル永続化に `keyv-file` を使用している点 (設計上の選択)。
- `vrchat` パッケージへのパッチ適用 (`patches/vrchat@2.20.7.patch`)。SDK の型定義バグ回避のための既知の対応。
- 2FA コードの対話的プロンプト (`vrchat/session.ts`)。TOTP シークレット未設定時の想定動作。
- ヘルスチェックサーバー (`health/health-service.ts`) が localhost のみで待ち受ける点 (意図的)。

## テスト

- フレームワークは Jest (`pnpm test`)。主要ロジック (state reducer/repository/coordinator、pipeline supervisor/transport、session、health-service、app) にはテストが整備済みのため、新規ロジック追加時は既存パターンに沿ったテスト追加を期待する。
