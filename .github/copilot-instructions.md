# GitHub Copilot コードレビュー指示

VRChat ユーザーの Location 変更を WebSocket で監視し、Discord に通知する Node.js / TypeScript アプリケーションです。このファイルは Copilot のコードレビュー向けに、指摘すべき点と指摘すべきでない点を示します。

## レビューで重視する点

- **機密情報の漏洩**: VRChat 認証情報 (ユーザー名・パスワード・TOTP シークレット)、Cookie、Discord Webhook URL をログ出力・エラーメッセージ・コミットに含めていないか。
- **エラーハンドリング**: WebSocket 切断・再接続、VRChat API 失敗、認証エラーが握りつぶされていないか。`websocket-monitor.ts` の接続状態遷移が破綻していないか。
- **重複通知の抑制**: Location 変更検知で `location-store.ts` の前回値比較が正しく、同一 Location の重複通知を防いでいるか。
- **型安全性**: `any` の新規使用や `skipLibCheck` による回避がないか。VRChat SDK / WebSocket イベントのペイロードに対する型付けが妥当か。
- **永続化の安全性**: `data/` 配下のファイル読み書きで、破損・不在時のフォールバックが考慮されているか。

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
- 2FA コードの対話的プロンプト (`vrchat-client.ts`)。TOTP シークレット未設定時の想定動作。
- ヘルスチェックサーバー (`health-server.ts`) が localhost のみで待ち受ける点 (意図的)。

## テスト

- フレームワークは Jest (`pnpm test`)。テストファイルは現状未整備のため、テスト不足それ自体を一律に指摘する必要はない。ロジック追加時のテスト提案は歓迎する。
