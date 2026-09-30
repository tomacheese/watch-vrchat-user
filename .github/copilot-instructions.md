# GitHub Copilot コードレビュー指示

VRChat の全フレンドの状態変化 (オンライン / オフライン / Location 変更 / ステータス・ステータスメッセージ変更 / フレンド追加・削除) を WebSocket で監視し、YAML 設定の CEL ルールに一致したものを Discord に通知する Node.js / TypeScript アプリケーションです。このファイルは Copilot のコードレビュー向けに、指摘すべき点と指摘すべきでない点を示します。

## レビューで重視する点

- **機密情報の漏洩**: VRChat 認証情報 (ユーザー名・パスワード・TOTP シークレット)、Cookie、Discord Webhook URL (設定ファイルの `destinations`・展開後の環境変数値を含む) をログ出力・エラーメッセージ・コミットに含めていないか。
- **エラーハンドリング**: WebSocket 切断・再接続、VRChat API 失敗、認証エラーが握りつぶされていないか。`pipeline-supervisor.ts` の接続状態遷移 (`connecting`/`synchronizing`/`ready`/`reconnecting`/`stopped`) や connection generation 管理が破綻していないか。
- **重複通知の抑制**: Location 変更検知で `user-state-reducer.ts` の前回値比較が正しく、同一 Location の重複通知を防いでいるか。`traveling` が通知・永続化に混入していないか。ステータス変更 (`status-change`) でも、`offline` ステータスを記録していないか、各項目 (ステータス / メッセージ) の初回観測で通知していないかを確認する。
- **型安全性**: `any` の新規使用や `skipLibCheck` による回避がないか。VRChat SDK / WebSocket イベントのペイロードに対する型付けが妥当か。
- **ルール評価の分離**: CEL ルールの評価エラーや World 情報の取得失敗が、無関係なルールの通知を止めていないか。設定 reload の失敗時に last-known-good で稼働を継続しているか。
- **永続化の安全性**: `data/` 配下のファイル読み書きで、破損・不在時のフォールバックが考慮されているか。`user-state-repository.ts` (`friend-states.json`) の atomic write・store-wide lock が壊れていないか。

## 強制されている規約

- **フォーマット**: Prettier (`pnpm lint:prettier`)。
- **Lint**: ESLint (`@book000/eslint-config`, `pnpm lint:eslint`)。
- **型チェック**: `tsc` (`pnpm lint:tsc`)。`strict` 有効。
- **JSDoc**: 関数・インターフェースには日本語の JSDoc を記載する。
- **コメントは日本語、エラーメッセージは英語**。日本語と英数字の間には半角スペースを入れる。
- **コミット**: Conventional Commits (description は日本語)。

## 指摘すべきでない既知パターン

- `data/` へのファイル永続化に `keyv-file` を使用している点 (設計上の選択)。
- `vrchat` パッケージへのパッチ適用 (`patches/vrchat@2.24.0.patch`)。SDK の型定義バグ回避のための既知の対応。
- 2FA コードの対話的プロンプト (`vrchat/session.ts`)。TOTP シークレット未設定時の想定動作。
- `friend-update` のペイロード形状は実機で検証済みであり、router 側の型ガードは `status` / `statusDescription` が文字列でないペイロード (プロフィールの他項目のみを変更する更新など) を無視する点 (意図した挙動)。
- ステータス未記録 (offline のまま等) でもメッセージが記録済みなら `status-change` を通知する点 (項目ごとの判定による意図した挙動)。
- ヘルスチェックサーバー (`health/health-service.ts`) が localhost のみで待ち受ける点 (意図的)。

## テスト

- フレームワークは Jest (`pnpm test`)。主要ロジック (config、rules、state reducer/repository/coordinator、pipeline supervisor/transport、session、health-service、app) にはテストが整備済みのため、新規ロジック追加時は既存パターンに沿ったテスト追加を期待する。
