# Claude Code Guidelines

## 目的

このドキュメントは、Claude Code の作業方針とプロジェクト固有ルールを示すものです。

## 判断記録のルール

1. 判断内容の要約を記載する
2. 検討した代替案を列挙する
3. 採用しなかった案とその理由を明記する
4. 前提条件・仮定・不確実性を明示する
5. 他エージェントによるレビュー可否を示す

前提・仮定・不確実性を明示し、仮定を事実のように扱わないでください。

## プロジェクト概要

- 目的: VRChat の全フレンドの状態変化を監視し、YAML 設定の CEL ルールに一致したものを Discord に通知する
- 主な機能: VRChat WebSocket イベント監視 (補助的に Friends API による REST reconciliation)、ステータス / ステータスメッセージの変化 (`status-change`) の追跡、CEL ルールによる通知条件・通知先 (Discord Webhook) の振り分け、設定ファイルの hot reload

## 重要ルール

- **会話言語**: 日本語
- **コミット規約**: Conventional Commits (`<type>(<scope>): <description>`, description は日本語)
- **コメント言語**: 日本語
- **エラーメッセージ**: 英語
- **記述ルール**: 日本語と英数字の間に半角スペースを挿入

## 環境のルール

- **ブランチ命名**: Conventional Branch (`feat/xxx`, `fix/xxx`)
- **GitHub 調査**: 必要に応じてテンポラリディレクトリに clone して調査
- **Renovate**: Renovate PR には直接コミットしない
  - 理由: Renovate が管理するブランチに手動変更を加えると、再生成時のコンフリクト増加や履歴の不整合を招くため
  - 対応方針:
    - Renovate PR は「変更内容の確認・テスト」のみに用い、コード修正や設定変更は通常の `feat/xxx` / `fix/xxx` ブランチで行う
    - Renovate が提案した変更を採用する場合は、同内容を手動で別ブランチに反映し、通常の PR を作成してマージする
    - 依存関係をまとめて更新したい場合は、該当 Renovate PR を Close し、手動で依存更新用ブランチを切って対応する

## コード改修時のルール

- **エラーメッセージ**: 絵文字を使用する場合、メッセージ全体で統一する
- **TypeScript**: `skipLibCheck` は使用禁止
- **ドキュメント**: 関数・インターフェースに日本語の JSDoc を記載

## 開発コマンド

```bash
# 依存関係インストール
pnpm install

# 開発サーバー (ホットリロード)
pnpm dev

# 本番実行
pnpm start

# 停止中の通知復旧
pnpm outbox list
pnpm outbox retry <id> <destination>
pnpm outbox discard <id> <destination>
pnpm outbox retry <id>  # 準備段階の失敗を再評価
pnpm outbox discard <id>  # イベント全体を破棄

# Lint 実行
pnpm lint

# 自動修正 (Format & Lint Fix)
pnpm fix

# テスト実行
pnpm test
```

## アーキテクチャと主要ファイル

- `src/env.ts`: `.env` の読み込み。パス・Cookie・logger を初期化するモジュールより先に import する
- `src/main.ts`: エントリーポイント。環境変数・設定読み込みと `App` の起動・シグナルハンドリングを担う
- `src/outbox-cli.ts`: 停止中の outbox の確認・再送・破棄。アプリと同じ SQLite OS lock を取得する
- `src/app.ts`: 各モジュールの配線と起動・reconnect・定期 REST reconciliation シーケンスを担う
- `src/config.ts`: 環境変数からの VRChat 認証情報・パス設定 (`CONFIG_PATH` / `STATE_FILE_PATH` / `WORLD_CACHE_FILE_PATH` 等) の読み込みとバリデーション
- `src/config/config-file.ts`: YAML 設定ファイルのパース・検証 (destinations の `${ENV_VAR}` 展開を含む)
- `src/config/config-manager.ts`: 設定ファイルの hot reload と last-known-good の保持
- `src/config/config-snapshot.ts`: 検証・compile 済みの設定スナップショット
- `src/rules/rule-engine.ts`: CEL ルールの compile と `RuleErrorLog`
- `src/rules/rule-evaluator.ts`: Worker に隔離し、実行時間・起動時間・cache・Worker heap を制限した CEL 評価。失敗したルールだけを不一致扱いにして残りの評価を続ける
- `src/rules/rule-context.ts`: effect から CEL 変数 (`event` / `user` / `previous` / `current`) を組み立てる。`event.type` は `online` / `offline` / `location-change` / `friend-add` / `friend-delete` / `status-change` の 6 種。永続化した受信時刻 (`createdAt`) の `event.month` (1〜12) / `event.day` / `event.weekday` (0=日〜6=土) / `event.hour` (0〜23) / `event.minute` も持ち、ローカルタイムゾーンで解釈する (夜間などの時間帯条件に使う)。`previous` / `current` は `status` / `statusDescription` を持つ (未観測なら空文字列)
- `src/vrchat/session.ts`: VRChat REST 認証・Cookie 永続化・2FA・明示的なセッション再認証・Friends API の取得を担う（Pipeline 開始は担当しない）。`getFriendsSnapshot` は `profile` (status / statusDescription) を含む `FriendSnapshot` を返す。`getInstanceOwnerInfo` は `usr_` なら表示名、`grp_` ならグループ名を取得する
- `src/vrchat/pipeline-transport.ts`: VRChat SDK の raw WebSocket (`open`/`close`/`error`/`message`/`pong`/`readyState`) への唯一のアクセス経路
- `src/vrchat/pipeline-supervisor.ts`: Pipeline の接続状態・connection generation・liveness・reconnect backoff を管理する。10 分間 raw message が途絶えた場合は、ready 状態に限り reconnect 前に REST reconciliation による stale probe (drift 確認) を行う
- `src/vrchat/pipeline-event-router.ts`: `friend-location` / `friend-online` / `friend-offline` / `friend-add` / `friend-delete` / `friend-update` を正規化して `UserStateCoordinator` へ渡す。`friend-online` / `friend-location` の `user` からは profile も抽出する
- `src/vrchat/world-resolver.ts`: World 情報の取得と 24 時間 TTL の永続キャッシュ。初回 load を共有し、最大 10,000 件に制限して書き込みをまとめる。インスタンスオーナー名の解決にも別インスタンス (`label` オプションでログを区別、キャッシュは `OWNER_CACHE_FILE_PATH`) として使う
- `src/vrchat/favorites-service.ts`: Favorite Friends (`group_0`〜`group_3`) の取得と 1 時間ごとの更新。並行 refresh は同じ処理を共有し、timeout / stop で通信を abort する
- `src/state/location.ts`: raw Location 文字列のパース (visible 判定・World ID・instance type 等)
- `src/state/user-state.ts`: 全フレンドの永続 state (`FriendState`) の型と検証。`UserState` は任意の `status` / `statusDescription` を持ち、`Profile` 型も定義する (schemaVersion は据え置き)
- `src/state/user-state-reducer.ts`: WebSocket event / REST snapshot 共通の純粋な状態遷移関数 (baseline・`friend-add` / `friend-delete` を含む)。online / offline / location / friend-add の observation は任意の `profile` を持ち、`{ type: 'profile' }` observation (WebSocket の `friend-update` 由来) もある。`reduce` は `effect` / `followUp` と併発しうる `statusEffect` (`status-change`) も返す
- `src/state/user-state-repository.ts`: 旧 `friend-states.json` を検証して `friend-states.sqlite` へ一度だけ移行する。state と outbox の更新は SQLite transaction で確定し、config snapshot は内容 hash で共有する。排他は SQLite の OS-level lock database で行い、保存権限は `0600`。破損データは起動エラーにする
- `src/state/user-state-coordinator.ts`: ユーザーごとの observation を直列処理する single-writer queue。受信時刻・設定を固定し、effect → followUp → statusEffect の順で outbox を state と同時保存する。ネットワーク処理は待たない。表示名は処理時の state で補完し、overflow は persist 復旧後も異常として保持する
- `src/state/reconciler.ts`: Friends API のスナップショットを compare-and-enqueue で queue に追記する。profile snapshot は未確認項目の初期化だけに使い、確認済み profile を上書きせず `status-change` も生成しない (ステータスの差分は `drift` に数えない)
- `src/notifications/outbox-types.ts`: 再起動後も評価できる raw CEL・展開済み通知先・event と、通知先ごとの payload / 配信状態の永続型
- `src/notifications/notification-outbox.ts`: 保存済み effect を受信時の設定・時刻で評価し、payload を保存してから送信する。ユーザー単位の順序を維持し、通知先ごとの配信結果を保存する
- `src/notifications/notification-dispatcher.ts`: effect に対して全ルールを評価し、一致した destination ごとに 1 通へまとめて payload を準備する。`ownerResolver` でオーナー名を解決して Embed に渡す
- `src/notifications/embed-builder.ts`: Discord Embed の組み立て (World 情報・一致したルール名の footer 表示を含む)。公開 Location の欄は 1 行にまとめ、`<ワールド名> · <インスタンス種別 #番号>` の後ろにオーナーを ` · 👤 <表示名>` (グループは ` · 👥 <グループ名>`) で続ける。public (オーナーなし) では付けない。名前を解決できない場合は生の ID を表示する (オーナー名は表示専用で CEL には公開しない)。Embed の表示名はリンクになり、ユーザー欄は `https://vrchat.com/home/user/<usr_id>`、ワールド名は `https://vrchat.com/home/world/<wrld_id>`、インスタンス表記 (`Friends+ #2` など) は `https://vrchat.com/home/launch?worldId=...&instanceId=...` へリンクする。instanceId は Markdown リンクを壊さないよう括弧も含めて URL エンコードする。オーナー名はユーザー / グループ (`https://vrchat.com/home/group/<grp_id>`) のページへリンクする。リンクの表示文字列に含まれる `[` `]` `\` はエスケープする。`status-change` では変化したフィールドのみ (ステータス / ステータスメッセージ) を VRChat 上の名称 (Online / Join Me / Ask Me / Do Not Disturb) で表示する。直前のステータスが未記録の場合はステータス欄を表示しない
- `src/notifications/discord-notifier.ts`: native fetch による Discord Webhook への送信。timeout で abort し、Webhook URL 単位の queue と 429 待機を管理する。5xx は後で再試行し、恒久的 4xx と送達不明を区別する
- `src/health/health-service.ts`: localhost のみでアクセス可能なヘルスチェック HTTP サーバー (supervisor state・generation・接続診断履歴・per-user unhealthy・baseline 完了・REST 同期エラー・`config`・`ruleErrors`・`favorites`・`delivery` を返し、`status` は `healthy` / `degraded` / `unhealthy`)
- `src/logger-utils.ts`: unknown 型の値を Error に変換する `toError` ヘルパーを提供する
- `config.example.yaml`: 通知ルール設定ファイルの例 (`data/config.yaml` として配置する。テストで parse / compile を検証している)
- `data/`: 永続化データ保存先 (Cookie・`friend-states.sqlite`・旧 `friend-states.json`・`world-cache.json`・`owner-cache.json`・`config.yaml` 等)

## 実装パターン

- **VRChat API**: `vrchat` パッケージを使用 (パッチ適用済み)
- **実行環境**: Node.js 24 (`.node-version`)、pnpm 12.8.2 (`packageManager`)
- **永続化**: Cookie は `keyv-file`、state / outbox は `UserStateRepository`、World / owner cache は `WorldResolver` がローカルファイルに保存

## セキュリティ / 機密情報

- `.env` (認証情報) や `data/` (Cookie・履歴) は機密情報を含むためコミットしない
- 認証トークンなどの機密情報をログに出力しない。invalid payload でも raw event をログへ出さない
- outbox は再起動後の処理のため展開済み Webhook URL、raw CEL、Location の nonce、ステータスメッセージ、Embed を保持する。`friend-states.sqlite` とバックアップは秘密情報として扱い、health / 復旧 CLI の一覧では本文・URL を公開しない
- パッケージマネージャーは `pnpm` のみ (npm/yarn は `preinstall` の `only-allow` で禁止)

## VRChat API / WebSocket メモ

- VRChat Web API は `vrchat` SDK 経由で利用する。`apiKey` 等のクエリパラメータは SDK が内部付与するため、アプリ側では扱わない
- 認証はユーザー名 / パスワード + 2FA (TOTP)。取得した Cookie は `data/` に `keyv-file` で永続化し、再ログイン回数を減らす
- リアルタイム通知は VRChat パイプラインサーバー (`wss://pipeline.vrchat.cloud/`) の WebSocket で配信される
- 主に利用するイベント: `friend-location` (Location 変更・監視の中心)、`friend-online`、`friend-offline`、`friend-update` (ステータス・ステータスメッセージ変更)、`notification`
- Location 変更検知は `friend-location` を基準に `src/state/user-state-reducer.ts` で前回値と比較し、同一 Location の重複通知を抑制する。current が visible (`wrld_` 始まり) かつ previous が non-null (visible または `private`) の場合に `location-change` を生成する (private → visible も対象)。current が `private` かつ previous が visible の場合も生成する (visible → private。この場合 CEL の `current.location` は `{ visible: false }` になる)。offline → online で visible な Location を持つ場合は `online` に続けて `location-change` を生成する (reducer が `followUp` として返し、coordinator が effect → followUp の順に永続化し outbox が順次処理する)。private の維持、`traveling`、null → visible (online 直後の最初の Location を除く)、null → private は何も通知しない
- coordinator が state 変更ごとに `State changed:` を、dispatcher が `Matched rules:` / `No rule matched:` をログ出力する (事後調査用)
- supervisor の `reconnect-triggered` 診断ログには、raw close の `closeCode` / `closeReason` (英数字と一部記号のみ・64 文字まで)、`msSinceLastMessage` / `msSinceLastPong` が含まれる。また reconciler は REST 同期のたびに `Reconciliation snapshot applied: friends=N drift=M` を出力する (`drift` は WebSocket で届かなかった差分の目安)
- supervisor は 10 分間 raw message が途絶え、かつ `ready` 状態のとき、即 reconnect せず先に `Reconciler.reconcileAll()` による liveness probe を実行する。`drift=0` なら reconnect せず `Pipeline liveness probe: drift=0 action=keep msSinceLastMessage=<ms>` を出力する。`drift` が 1 以上、同期不能 (null・例外)、または 120 秒の probe タイムアウトの場合は `Pipeline liveness probe: drift=<N> action=reconnect ...` / `Pipeline liveness probe: unverified action=reconnect ...` を出力して従来どおり reconnect する。probe は沈黙が続く間 10 分ごとに最大 1 回で、`ready` 以外の状態では即 reconnect する。probe 結果はログのみで、reconnect 診断履歴・health には含めない
- `friend-add` / `friend-delete` は SDK の型に現れないため、ペイロード形状は非公式ドキュメントに基づく想定であり router 側で型ガード検証する
- `friend-update` のペイロード形状は実機 (本番アカウント、2026-09-30) で確認済み。`userId`、`user.displayName`、`user.status` (観測値: `active` / `ask me` / `busy` / `join me`)、`user.statusDescription` が文字列で届き、ステータスのみ・メッセージのみの変更は friend-location / friend-online を伴わず単独の `friend-update` として届く。`user.status` / `user.statusDescription` が文字列でない場合は無視する
- WebSocket の profile observation (`friend-update` / `friend-online` / `friend-location`) で観測したステータス (`join me` / `active` / `ask me` / `busy`) とステータスメッセージの変化を `status-change` として通知する。Friends API snapshot の profile は未確認項目の初期化だけに使い、確認済み profile を上書きせず、status-change も生成しない。`offline` ステータスは記録せず、直前の値を保持する。`status-change` はフィールドごとに判定し、記録済みの値が変化したときだけ通知する (ステータスはステータス記録済みの場合のみ、メッセージはメッセージ記録済みの場合のみ。空文字列も記録済みとして扱う)。各フィールドの初回観測は通知せず記録のみ行うため、ステータス未記録 (offline のまま等) のユーザーでもメッセージ変更は通知される
- 仕様変更の可能性があるため、公式 (https://creators.vrchat.com/) / 非公式コミュニティ (https://vrchatapi.github.io/) のドキュメントを随時確認する

## 通知・永続化の不変条件

- schemaVersion は `3` を維持し、以前の schema 3 に `outbox` がなければ空の通知予定として読み込む。schema 2・壊れた JSON・不正 state / outbox は自動破棄せず起動を拒否する。元データを保全し、正常なバックアップを復元するか、管理者が明示的に新しい baseline を選ぶ。
- observation 受信時の設定と時刻を retry 中も固定する。主 effect / followUp の `current` にも同時観測した最終 profile を含める。CEL の時間帯条件と Embed 時刻は outbox の `createdAt` に基づき、送信時刻で置き換えない。
- 通知予定と state を同じ atomic mutation に含める。通知先ごとの payload を保存してから POST し、送信前に `sending`、成功後に `delivered` を保存する。再起動時に残る `sending` は `uncertain` にする。
- `blocked` (恒久的失敗) / `uncertain` (送達不明) は自動再送しない。先頭 event が完了するまで同じユーザーの後続 event は待つ。Discord POST とローカル書き込みは同一 transaction にできないため、exactly-once は保証しない。
- `pnpm outbox list / retry / discard` はアプリ停止中だけ実行する。`retry` は重複配信の可能性を認識した管理者の明示操作であり、`discard` は指定した通知先を処理済みにする。別の通知先の結果を巻き戻さない。通知先を省略した retry は準備失敗を再評価し、省略した discard は event 全体を破棄する。
- baseline 未完了は health を `unhealthy` にする。REST 同期・配信の異常、blocked / uncertain、60 秒を超える通知滞留は `degraded` にする。null の同期結果を ready の根拠にしない。
- shutdown は受信を止めてから coordinator / 配信の処理を最大 5 秒待つ。保存済み通知予定を残し、通信の abort と state / Cookie / cache の flush を行う。main の 15 秒の終了期限を超えた場合は異常終了する。

## テスト

- **フレームワーク**: Jest (`ts-jest`)。テスト対象は `**/*.test.ts`
- **現状**: config・rules・state・vrchat・notifications・health・app の主要ロジックにテストが整備済み (件数は `pnpm test` の出力を参照)
- **コマンド**: `pnpm test` (カバレッジ計測込み)
- 新規ロジック追加時は既存のテストパターンに沿ってテストを追加する

## ドキュメント更新ルール

- **タイミング**: 機能追加・変更時、アーキテクチャや主要ファイル構成の変更時
- **対象**: `README.md`、`CLAUDE.md` (本ファイル)、`.github/copilot-instructions.md`
- **CLAUDE.md 自体の更新**: `src/` の主要ファイル追加・削除、開発コマンドの変更、依存関係の大幅な更新時は本ファイルの該当セクションも更新する

## 作業チェックリスト

### 新規改修時

1. プロジェクトを理解する
2. 作業ブランチが適切であることを確認する
3. 最新のリモートブランチに基づいた新規ブランチであることを確認する
4. クローズされた PR の不要ブランチが削除済みであることを確認する
5. 指定されたパッケージマネージャー (`pnpm`) で依存関係をインストールする

### コミット・プッシュ前

1. Conventional Commits に従っていることを確認する
2. センシティブな情報が含まれていないことを確認する
3. Lint / Format エラーがないことを確認する
4. 動作確認を行う

### PR 作成前

1. PR 作成の依頼があることを確認する
2. センシティブな情報が含まれていないことを確認する
3. コンフリクトの恐れがないことを確認する

### PR 作成後

1. コンフリクトがないことを確認する
2. PR 本文が最新のコミットに含まれる変更内容を正確に反映していることを確認する
3. `gh pr checks <PR ID> --watch` で CI を確認する
4. Copilot レビューに対応し、コメントに返信する
5. Claude Code によるコードレビューを実施し、指摘対応を行う
6. PR 本文の崩れがないことを確認する

## リポジトリ固有

- `patches/vrchat@2.24.0.patch` によるパッチが適用されているため、`vrchat` パッケージの更新時はパッチの整合性を確認する。
