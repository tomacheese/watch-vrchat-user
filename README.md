# watch-vrchat-user

VRChat の全フレンドの状態変化を監視し、YAML 設定ファイルに書いた CEL ルールに一致したものを Discord に通知するアプリケーションです。

## 機能

- 全フレンドの状態 (オンライン / オフライン / Location / ステータス / ステータスメッセージ) をリアルタイムで追跡し、永続化
- オンライン復帰後に最初に確認した Location を `location-change` として通知対象にする
- 「通知するか」と「どの Discord Webhook へ通知するか」を CEL ルールで柔軟に指定 (1 イベントが複数ルールに一致した場合は、一致した全 destination へ通知)
- 同一 destination に複数ルールが一致した場合は 1 通にまとめ、Embed の footer に一致した全ルール名を表示
- Embed のユーザー名・ワールド名・インスタンス表記 (`Friends+ #2` など)・インスタンスオーナーは VRChat Web のリンクになります。インスタンス表記のリンクはそのインスタンスの起動 URL で、Friends+ などでは識別用の乱数 (nonce) を含みます。通知先のチャンネルは他人が見られない場所にしてください
- 設定ファイルの hot reload (不正な設定への reload は失敗し、直前の正常な設定で稼働を継続)
- World 情報の取得 (24 時間キャッシュ) と Favorite Friends (`group_0`〜`group_3`) の取得 (1 時間ごとに更新)
- セッションの永続化と認証切れからの復旧 (TOTP 設定時は 2FA を自動入力)
- 通知予定と配信結果の永続化。再起動後も未処理の通知を継続し、送達不明な通知は明示的な復旧を待つ

## 必要条件

- Node.js 24.21.0 以降 (`.node-version` に合わせる。built-in SQLite を使用)
- pnpm 12.8.2 (`package.json` の `packageManager` に合わせる)
- VRChat アカウント
- Discord Webhook URL

## セットアップ

### 1. 依存パッケージのインストール

```bash
pnpm install
```

### 2. 環境変数の設定

`.env` ファイルを作成し、以下の環境変数を設定してください。ローカル実行時は起動時に `.env` を読み込みます。既に設定済みの環境変数が優先されます。

```env
# ローカル実行時の通知設定ファイル
CONFIG_PATH=data/config.yaml

# VRChat 認証情報
VRCHAT_USERNAME=your_vrchat_username
VRCHAT_PASSWORD=your_vrchat_password
VRCHAT_TOTP_SECRET=your_totp_secret  # オプション: TOTP シークレット（設定すると 2FA を自動入力）

# 設定ファイル内の ${ENV_VAR} から参照する Discord Webhook URL (config.example.yaml の例)
DISCORD_WEBHOOK_MAIN=https://discord.com/api/webhooks/xxx/yyy
DISCORD_WEBHOOK_DANCE=https://discord.com/api/webhooks/xxx/zzz

# エラー通知設定
SENTRY_DSN=https://xxx@yyy.example.com/1  # オプション: GlitchTip/Sentry の DSN（未設定の場合、エラー通知は無効化される）
```

その他の環境変数は次のとおりです (いずれも任意)。

| 環境変数                | 既定値 (Docker)                                        | 説明                                                              |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `CONFIG_PATH`           | `/data/config.yaml`                                    | 通知ルール設定ファイル (YAML) のパス                              |
| `STATE_FILE_PATH`       | `data/friend-states.json` (`/data/friend-states.json`) | 既存 JSON state の移行元。稼働 DB は同じ場所の `.sqlite` ファイル |
| `WORLD_CACHE_FILE_PATH` | `data/world-cache.json` (`/data/world-cache.json`)     | World 情報キャッシュの保存先                                      |
| `OWNER_CACHE_FILE_PATH` | `data/owner-cache.json` (`/data/owner-cache.json`)     | インスタンスオーナー名キャッシュの保存先                          |

> **注意**: `VRCHAT_TOTP_SECRET` を設定しない場合、初回起動時に 2FA コードの手動入力が必要です。

### 3. 設定ファイルの作成

`config.example.yaml` を `data/config.yaml` としてコピーし、ルールを編集してください。設定ファイルが存在しない、または不正な状態で起動した場合、起動は失敗します。

```bash
mkdir -p data
cp config.example.yaml data/config.yaml
```

## 設定ファイル

```yaml
version: 1
destinations:
  main:
    type: discord-webhook
    url: ${DISCORD_WEBHOOK_MAIN}
rules:
  - name: dance-world
    enabled: true
    when: |
      event.type == "location-change" &&
      current.location != null &&
      current.location.visible &&
      current.location.world.name.contains("ダンス")
    destinations: [main]
```

- `version` は `1` 固定です。
- `destinations` はキーが destination 名で、`type` は `discord-webhook` のみです。`url` は直書きするか、値全体を `${ENV_VAR}` にすると環境変数から展開されます (展開されるのは `destinations.*.url` の値全体が `${NAME}` の場合のみ。環境変数が未定義なら設定エラー)。展開後の URL は `https://discord.com/api/webhooks/` で始まる必要があります。
- `rules[].name` は必須で、設定内で一意にします。`enabled` は省略すると `true` です。`destinations` は 1 個以上で、定義済みの destination 名のみ指定できます。`when` は boolean を返す CEL 式です (4096 文字以内)。
- 未知のキーはエラーになります (typo 検出)。`enabled: false` のルールも構文の検証は行われますが、評価はされません。
- Webhook URL は秘密情報です。設定ファイルに直書きせず、`${ENV_VAR}` で環境変数から渡すことを推奨します。ログや health には出力されません。再起動後の未処理通知には受理時点の URL が必要なため、展開済み URL は `friend-states.sqlite` に保存されます。バックアップも秘密情報として扱ってください。

### semantic event

`event.type` は次の 6 種のいずれかです。

| `event.type`      | 意味                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `online`          | フレンドがオフラインからオンラインになった                                                                                                                                           |
| `offline`         | フレンドがオンラインからオフラインになった                                                                                                                                           |
| `location-change` | オンライン中のフレンドの Location が、公開された別の Location に変わった、または公開 Location から private に変わった (private からの復帰、オンライン化と同時の Location 確定を含む) |
| `friend-add`      | フレンドが追加された                                                                                                                                                                 |
| `friend-delete`   | フレンドが削除された                                                                                                                                                                 |
| `status-change`   | フレンドのステータス (Join Me / Online / Ask Me / Do Not Disturb) またはステータスメッセージが変わった                                                                               |

- `location-change` は、変更後の Location が**公開**されている (World を特定できる) 場合に発生します。変更前は公開 Location または private のいずれでもかまいません。公開 Location から private への遷移でも発生し、このとき `current.location` は `{ visible: false }` になります (`current.location.visible` を条件に含めていないルールにも一致する点に注意してください)。オフラインからオンラインになると同時に公開 Location が確定した場合は、`online` に続けて `location-change` も発生します (両方に一致するルールは 2 回通知されます)。private の維持、Location 未確定からの確定 (オンライン直後の最初の確定を除く) や未確定からの private では発生しません。
- `status-change` は、WebSocket の `friend-update` や presence / Location event に付いた profile でステータスとステータスメッセージのどちらかが変わると発生します (どちらが変わったかは `previous` / `current` の `status` / `statusDescription` を比べてください)。Friends API の REST snapshot は未確認の profile 項目を初期化する場合だけ使い、確認済みの値を上書きしたり status-change を生成したりしません。ステータスの値は `join me` / `active` / `ask me` / `busy` です (`active` が Online、`busy` が Do Not Disturb)。オンライン化などの他のイベントと同時に検知した場合は、そのイベントに続けて発生します。ステータスとメッセージは項目ごとに、確認済みの値からの変化だけを通知します。各項目の初回の観測 (アップグレード直後を含む) は通知せず記録だけを行うため、変更の通知は次の変化から始まります。`offline` のステータスは記録せず直前の値を維持するため、オフラインのユーザーはステータスが未確認のことがありますが、その間もメッセージの変更は通知されます (Embed には変わった項目だけを表示します)。
- 後追い調査のため、state が変化するたびに `State changed: user=... <前> -> <後> effects=...` を、ルール評価のたびに `Matched rules:` または `No rule matched:` をログ (info) に出力します。通知されなかった遷移も、このログで追えます。
- WebSocket 再接続の原因調査のため、再接続のたびに `reconnect-triggered` の診断ログへ、raw close の `closeCode` / `closeReason` (英数字と一部記号のみ・64 文字まで)、最後のメッセージ・pong からの経過ミリ秒 (`msSinceLastMessage` / `msSinceLastPong`) を出力します。REST 同期のたびに `Reconciliation snapshot applied: friends=N drift=M` を出力し、`drift` は WebSocket で届かなかった差分の目安になります。
- WebSocket が 10 分間無言になった場合 (接続が `ready` のときのみ)、すぐには再接続せず、まず Friends API との同期で差分を確認します。差分が 0 件なら再接続せず (`Pipeline liveness probe: drift=0 action=keep ...`)、差分がある場合・同期できなかった場合・120 秒以内に完了しなかった場合は再接続します (`Pipeline liveness probe: drift=<N> action=reconnect ...` / `unverified action=reconnect ...`)。この確認は無言が続く間 10 分ごとに最大 1 回で、結果はログのみに出力され `/health` の診断履歴には含まれません。
- WebSocket の `traveling` (移動中) は Location の確定や在席遷移には使いません。付属する profile のステータス変更は通常どおり追跡します。REST 同期では移動中もオンラインとして扱い、確定済みの Location を維持します。
- 初回起動 (state ファイルが無い場合) は、現在の全フレンドの状態を **通知なしで** 記録する baseline 構築を行います。Favorite group の変更や設定の reload による、過去のイベントの再評価や遡及通知は行われません。
- WebSocket の status-change 検知は `friend-update` や presence / Location event に付属する profile を使います。Friends API 同期は未確認の profile 項目だけを初期化し、その後は online / offline / Location の状態を照合します。

### CEL 変数

| 変数                           | 内容                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event.type`                   | 上記 6 種のいずれか                                                                                                                                     |
| `event.month` / `event.day`    | イベントの受信時刻の月 (1〜12) と日 (1〜31)                                                                                                             |
| `event.weekday`                | イベントの受信時刻の曜日 (0=日〜6=土)                                                                                                                   |
| `event.hour` / `event.minute`  | イベントの受信時刻の時 (0〜23) と分 (0〜59)。夜間の条件は `event.hour >= 22 \|\| event.hour < 6` のように書く                                           |
| (時刻の共通事項)               | 配信が遅延しても時刻は保存済みの `createdAt` を使い、配信時刻には変わりません。時刻の変数はアプリのローカルタイムゾーン (本番コンテナは JST) で解釈する |
| `user.id` / `user.displayName` | 対象フレンドのユーザー ID と表示名                                                                                                                      |
| `previous` / `current`         | イベント前後の状態。`friend-add` では `previous == null`、`friend-delete` では `current == null`                                                        |

`previous` / `current` は次のフィールドを持ちます。

- `presence`: `"online"` または `"offline"`
- `status` / `statusDescription`: ステータス (`join me` / `active` / `ask me` / `busy`) とステータスメッセージ。未観測の場合は空文字
- `favoriteGroups`: 所属する Favorite group の一覧 (`group_0`〜`group_3`)
- `location`: offline のときは `null`。online でも Location 未確定の場合は `null` になるため、在席判定は `presence` で行ってください。private などの非公開 Location は `{ visible: false }`。公開 Location は次の構造です。
  - `location.visible`: `true`
  - `location.world.id`: World ID
  - `location.world.name`: World 名 (World 情報が有効な場合のみ存在。取得できない場合、参照したルールは評価エラーとなり、そのルールだけが不一致扱いになる)
  - `location.world.capacity`: World の最大人数 (World 情報が有効な場合のみ存在。取得できない場合、参照したルールは評価エラーとなり、そのルールだけが不一致扱いになる)
  - `location.instance.name` / `type` / `ownerId` / `region` / `ageGate`

`location.instance.type` は次の 8 種です。

| `type`          | 意味                 |
| --------------- | -------------------- |
| `public`        | Public               |
| `friends-plus`  | Friends+             |
| `friends`       | Friends              |
| `invite-plus`   | Invite+              |
| `invite`        | Invite               |
| `group-public`  | Group Public         |
| `group-plus`    | Group+               |
| `group-members` | Group (メンバーのみ) |

### ルールの例

`config.example.yaml` には次の 4 例が含まれています。`usr_...` の値は実際のユーザー ID に置き換えてください。

```yaml
rules:
  # 特定ユーザーの Location 変更のみ通知
  - name: specific-user-location
    when: |
      event.type == "location-change" &&
      user.id == "usr_00000000-0000-0000-0000-000000000000"
    destinations: [main]

  # 特定ユーザーのオンライン / オフラインのみ通知
  - name: specific-user-presence
    when: |
      (event.type == "online" || event.type == "offline") &&
      user.id == "usr_00000000-0000-0000-0000-000000000000"
    destinations: [main]

  # World 名に「ダンス」を含む World への移動を通知
  - name: dance-world
    when: |
      event.type == "location-change" &&
      current.location != null &&
      current.location.visible &&
      current.location.world.name.contains("ダンス")
    destinations: [dance]

  # Favorite group group_0 のフレンドのオンライン / オフラインを通知
  - name: favorite-group-0-presence
    when: |
      (event.type == "online" || event.type == "offline") &&
      (("group_0" in current.favoriteGroups) ||
       ("group_0" in previous.favoriteGroups))
    destinations: [main]
```

### hot reload

設定ファイルを保存すると、数秒の遅延の後に自動で再読み込みされます。再読み込み後の設定は、以降に検知したイベントから適用されます。未処理通知には受理時点の設定を保存するため、reload 後も当時のルールと通知先で処理します。Webhook を変更・無効化した場合は、古い通知先の未処理通知も確認してください。不正な設定 (YAML の構文エラー、未知のキー、不正な CEL 式など) への reload は失敗し、直前の正常な設定 (last-known-good) で稼働を継続します。失敗は health の `config` に反映されます。ただし、起動時に設定が不正な場合は起動に失敗します。

CEL 評価はルールごとに時間制限を設けて実行します。制限超過や評価エラーのルールは不一致として記録し、他のルールの評価を続けます。

## 使用方法

### 開発モード

```bash
pnpm dev
```

### 本番モード

```bash
pnpm start
```

### Docker を使用する場合

`./data` が `/data` にマウントされるため、`./data/config.yaml` を用意してください。設定ファイルの `${ENV_VAR}` から参照する環境変数は、`compose.yaml` の `environment` に追加してコンテナへ渡します (同梱の `compose.yaml` は `DISCORD_WEBHOOK_MAIN` と `DISCORD_WEBHOOK_DANCE` を渡す例です)。

```bash
docker compose up -d
```

ログを確認:

```bash
docker compose logs -f
```

### ヘルスチェック

`HEALTH_HOST` (既定 `127.0.0.1`) と `HEALTH_PORT` (既定 `3000`) の `/health` が JSON を返します。`baselineCompleted` (初回同期の完了)、`config` (設定の読み込み状態)、`ruleErrors` (ルール評価エラー)、`favorites` (Favorite Friends の更新状態)、REST 同期結果、`delivery` (未処理・送達不明・配信停止の件数) を含みます。

- `healthy`: 正常
- `degraded` (HTTP 200): 設定の reload、ルール評価、Favorite Friends、REST 同期、通知配信に異常がある、または未処理通知が 60 秒以上滞留している。配信停止・送達不明の通知は復旧が必要
- `unhealthy` (HTTP 503): WebSocket 接続が ready でない、初回 baseline が未完了、またはユーザー単位の異常がある

Pipeline の接続診断はログに記録され、`/health` では直近 25 件を確認できます。接続理由、再接続試行、結果を確認できます。診断イベントにはユーザー情報、Location、Cookie、Webhook URL、raw event payload は含まれません。

## データの永続化

以下のファイルが `data/` ディレクトリに保存されます。

- `vrchat-cookies.json` - VRChat セッション Cookie
- `friend-states.sqlite` - 全フレンドの state、未処理通知、設定 snapshot、通知先ごとの配信結果
- `friend-states.json` - 旧バージョンの JSON store。初回起動時に検証して SQLite へ一度だけ移行し、元ファイルは保持します
- `world-cache.json` - World 情報のキャッシュ (24 時間 TTL)
- `owner-cache.json` - インスタンスオーナー (ユーザー名・グループ名) のキャッシュ (24 時間 TTL)
- `config.yaml` - 通知ルール設定ファイル (利用者が用意する)

state と通知予定は同じ SQLite transaction で確定します。通知先の配信状態は該当 row だけを更新し、同じ設定 snapshot を outbox item ごとに複製しません。設定ファイルは 1 MiB、destination は 64 件、rule は 256 件までです。outbox は 10,000 件、未処理の設定 snapshot は 32 件まで保持します。終了時は新しいイベントの受付を止め、状態更新と通知配信にはそれぞれ最大 5 秒の待機時間を設けます。終了処理全体が 15 秒を超えた場合は異常終了し、次回起動時に保存データから復旧します。保存済みの未処理通知は次回起動時に引き継がれます。SQLite database とその lock database は所有者のみ読み書きできる権限 (`0600`) で保存されます。Location の nonce、ステータスメッセージ、Webhook URL を含むため、`data/` とそのバックアップを共有・公開しないでください。

### 通知の復旧

通知はユーザー単位の順序で処理します。Discord の rate limit (429) とサーバーエラー (5xx) は待機して再試行します。恒久的なクライアントエラー (4xx) は `blocked`、タイムアウト・通信途絶など送達を確認できない場合は `uncertain` として保存します。POST 前に送信中であることを記録するため、送信中のまま終了した通知も再起動後は `uncertain` になります。重複配信を防ぐため、送達不明な通知を自動再送しません。先頭の通知が `blocked` または `uncertain` の場合、そのユーザーの後続通知は復旧まで待機します。

復旧コマンドはアプリを停止してから実行してください。同じ state store に対するアプリと復旧コマンドの同時実行は SQLite の exclusive lock で拒否されます。`.env` の `STATE_FILE_PATH` が稼働時と同じ移行元パスを指すことを確認します。

```bash
pnpm outbox list
pnpm outbox retry <id> <destination>
pnpm outbox discard <id> <destination>

# 通知準備の失敗を再試行 / イベント全体を破棄
pnpm outbox retry <id>
pnpm outbox discard <id>
```

`list` で通知 ID と通知先ごとの状態を確認します。Discord 側のチャンネルも確認し、未配信と判断できる通知だけを `retry` で再送対象に戻してください。`uncertain` の再送は重複する可能性があります。既に届いた通知や不要な通知は `discard` でその通知先の処理を終了します。他の通知先に未処理があれば、その状態は保持されます。通知先がまだ作成されていない準備段階の失敗は、通知先を指定しない `retry <id>` で再評価します。通知先を指定しない `discard <id>` はイベント全体を破棄し、そのイベントの残りの通知先にも配信しません。

Docker では `docker compose stop app` で停止し、同じボリュームを使って実行します。復旧が終わったら `docker compose start app` で再開します。

```bash
docker compose run --rm --entrypoint pnpm app outbox list
```

### state ファイルの互換性と破損時の対応

`friend-states.json` の schema 3 は SQLite へ一度だけ移行します。以前の schema 3 ファイルに `outbox` がなくても読み込めます。SQLite は内部 schema version 1 を使います。不正な JSON、不正な record、schema 2、破損した SQLite など未対応の形式が既存ファイルにある場合は、空データで上書きせず起動を停止します。SQLite が作成された後も元の JSON は更新されません。

アプリを停止し、SQLite database (`friend-states.sqlite`) と移行元 JSON を保全してください。正常なバックアップがない場合は state を作り直さないでください。作り直すと、既存 state・未処理通知・配信結果は復元できません。バックアップ取得後の変更を戻す場合は Discord 側の配信状況も確認します。

## 旧バージョンからの移行

旧バージョンの環境変数による指定は廃止され、後方互換はありません。

1. 旧 `DISCORD_WEBHOOK_URL` (廃止) を、新しい環境変数 (例: `DISCORD_WEBHOOK_MAIN`) に移し、`destinations` の `url: ${DISCORD_WEBHOOK_MAIN}` から参照します。
2. 旧 `TARGET_USER_IDS` (廃止) の各ユーザーについて、`user.id == "usr_..."` を条件にしたルールを追加します (上記「ルールの例」の 1・2 番目)。
3. 旧 `LOCATION_FILE_PATH` (廃止) は不要です。旧 `user-locations.json` は新バージョンに引き継がれません。新バージョンは `friend-states.json` があれば SQLite (`friend-states.sqlite`) へ移行し、なければ SQLite store を作成します。
4. 初回起動では、現在の全フレンドの状態を通知なしで記録する baseline を構築します。この間と直後に、既存の状態を理由とした通知は送られません。

### rollback

切り替え前にアプリを停止し、`data/` 全体をバックアップしてください。SQLite へ移行した後に旧 JSON-only イメージへ戻すと、旧版は移行後の SQLite の変更を読みません。ロールバックには切り替え前のバックアップを復元し、旧環境変数 (`DISCORD_WEBHOOK_URL` / `TARGET_USER_IDS`) を戻してください。旧 `user-locations.json` は新バージョンから変更されません。未処理通知の配信結果も新 SQLite に保存されるため、ロールバック前に Discord 側の配信状況を確認してください。

## 開発

### Lint

```bash
pnpm lint
```

### Lint & Fix

```bash
pnpm fix
```

### テスト

```bash
pnpm test
```

## ライセンス

The project is licensed under the [MIT License](LICENSE).
