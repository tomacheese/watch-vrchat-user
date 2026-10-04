# GitHub Copilot コードレビュー指示

VRChat の全フレンドの状態変化 (オンライン / オフライン / Location 変更 / ステータス・ステータスメッセージ変更 / フレンド追加・削除) を WebSocket で監視し、YAML 設定の CEL ルールに一致したものを Discord に通知する Node.js / TypeScript アプリケーションです。このファイルは Copilot のコードレビュー向けに、指摘すべき点と指摘すべきでない点を示します。

## レビューで重視する点

- **機密情報の漏洩**: VRChat 認証情報 (ユーザー名・パスワード・TOTP シークレット)、Cookie、Location の nonce、Discord Webhook URL (設定ファイルの `destinations`・展開後の環境変数値を含む) をログ出力・エラーメッセージ・コミットに含めていないか。
- **エラーハンドリング**: WebSocket 切断・再接続、VRChat API 失敗、認証エラーが握りつぶされていないか。`pipeline-supervisor.ts` の接続状態遷移 (`connecting`/`synchronizing`/`ready`/`reconnecting`/`stopped`) や connection generation 管理が破綻していないか。
- **重複通知の抑制**: Location 変更検知で `user-state-reducer.ts` の前回値比較が正しく、同一 Location の重複通知を防いでいるか。`traveling` が通知・永続化に混入していないか。ステータス変更 (`status-change`) でも、`offline` ステータスを記録していないか、各項目 (ステータス / メッセージ) の初回観測で通知していないかを確認する。
- **型安全性**: `any` の新規使用や `skipLibCheck` による回避がないか。VRChat SDK / WebSocket イベントのペイロードに対する型付けが妥当か。
- **ルール評価の分離**: CEL ルールの評価エラー・Worker timeout や World 情報の取得失敗が、無関係なルールの通知を止めていないか。CEL 評価は Worker で隔離し、実行時間・起動時間・cache・Worker heap を制限する。設定 reload の失敗時に last-known-good で稼働を継続しているか。
- **永続化の安全性**: `data/` 配下の読み書きで、store 不在時だけ空 state とし、破損・未対応 schema を既存データへ上書きしない。`user-state-repository.ts` の JSON から SQLite への一度だけの移行、state + outbox の SQLite transaction、config snapshot の重複排除、`0600`、OS-level exclusive writer lock が壊れていないか。旧 schema 3 の optional outbox は移行でき、schema 2 は自動破棄しない。

- **配信の整合性**: state commit と通知予定保存が同じ mutation で、coordinator がネットワーク送信を待っていないか。通知先ごとの payload / 配信結果を永続化し、POST 前の `sending` が再起動時に `uncertain` になるか。恒久的 4xx は `blocked`、送達不明は `uncertain` として自動再送せず、429 / 5xx を制限付きで再試行するか。先頭 event の未完了中に同じユーザーの後続 event を追い越させていないか。
- **受信時点の意味**: 設定の raw CEL と展開済み通知先を受理時点で保存し、retry / 再起動後も保持するか。CEL の時刻は保存済み `createdAt` に基づくか。online / Location の effect に同時観測した最終 profile が入り、表示名の補完が処理時点の state を使っているか。
- **運用と復旧**: baseline 未完了を unhealthy、同期・配信失敗と 60 秒以上の通知滞留を degraded として観測できるか。overflow を persist 復旧だけで消していないか。shutdown の受付停止・期限付き drain・flush、セッション再認証、通信の abort、cache の共有 load / 件数上限 / batch write が維持されているか。outbox 復旧 CLI はアプリとの同時 writer を拒否するか。

## 強制されている規約

- **実行環境**: Node.js 24.21.0 以降、pnpm 12.8.2。`.env` は設定・Cookie path を読むモジュールより前に読み込む。
- **フォーマット**: Prettier (`pnpm lint:prettier`)。
- **Lint**: ESLint (`@book000/eslint-config`, `pnpm lint:eslint`)。
- **型チェック**: `tsc` (`pnpm lint:tsc`)。`strict` 有効。
- **JSDoc**: 関数・インターフェースには日本語の JSDoc を記載する。
- **コメントは日本語、エラーメッセージは英語**。日本語と英数字の間には半角スペースを入れる。
- **コミット**: Conventional Commits (description は日本語)。

## 指摘すべきでない既知パターン

- Cookie のローカル永続化に `keyv-file` を使用している点 (設計上の選択)。
- outbox が復旧用に展開済み Webhook URL・raw CEL・Embed を `0600` の SQLite store へ保持する点。ログ・health・CLI 一覧への漏洩は指摘する。
- 送達不明を自動再送せず管理者の retry / discard を待つ点。通知先を省略した retry は準備失敗を再評価し、省略した discard は event 全体を破棄する。exactly-once 配信は保証しない。
- `vrchat` パッケージへのパッチ適用 (`patches/vrchat@2.24.0.patch`)。SDK の型定義バグ回避のための既知の対応。
- 2FA コードの対話的プロンプト (`vrchat/session.ts`)。TOTP シークレット未設定時の想定動作。
- `friend-update` のペイロード形状は実機で検証済みであり、router 側の型ガードは `status` / `statusDescription` が文字列でないペイロード (プロフィールの他項目のみを変更する更新など) を無視する点 (意図した挙動)。
- ステータス未記録 (offline のまま等) でもメッセージが記録済みなら `status-change` を通知する点 (項目ごとの判定による意図した挙動)。
- Friends API snapshot の profile は未確認項目の初期化にのみ使い、確認済み値を上書きせず、`status-change` は生成しない点 (REST snapshot は状態の読み取りであり、遷移イベントではない)。
- ヘルスチェックサーバー (`health/health-service.ts`) が localhost のみで待ち受ける点 (意図的)。

## テスト

- フレームワークは Jest (`pnpm test`)。主要ロジック (config、rules / Worker 評価、state reducer/repository/coordinator、outbox / notifier、pipeline supervisor/transport、session、health-service、app) にはテストが整備済みのため、新規ロジック追加時は既存パターンに沿ったテスト追加を期待する。
