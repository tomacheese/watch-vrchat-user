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
- セッションの永続化 (2FA の再入力不要)

## 必要条件

- Node.js 24 以上
- pnpm 9.x
- VRChat アカウント
- Discord Webhook URL

## セットアップ

### 1. 依存パッケージのインストール

```bash
pnpm install
```

### 2. 環境変数の設定

`.env` ファイルを作成し、以下の環境変数を設定してください。

```env
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

| 環境変数 | 既定値 (Docker) | 説明 |
| --- | --- | --- |
| `CONFIG_PATH` | `/data/config.yaml` | 通知ルール設定ファイル (YAML) のパス |
| `STATE_FILE_PATH` | `data/friend-states.json` (`/data/friend-states.json`) | 全フレンドの state の保存先 |
| `WORLD_CACHE_FILE_PATH` | `data/world-cache.json` (`/data/world-cache.json`) | World 情報キャッシュの保存先 |
| `OWNER_CACHE_FILE_PATH` | `data/owner-cache.json` (`/data/owner-cache.json`) | インスタンスオーナー名キャッシュの保存先 |

> **注意**: `VRCHAT_TOTP_SECRET` を設定しない場合、初回起動時に 2FA コードの手動入力が必要です。

### 3. 設定ファイルの作成

`config.example.yaml` を `data/config.yaml` としてコピーし、ルールを編集してください。設定ファイルが存在しない、または不正な状態で起動した場合、起動は失敗します。

```bash
cp config.example.yaml data/config.yaml  # ローカル実行時は CONFIG_PATH=data/config.yaml を指定する
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
- Webhook URL は秘密情報です。設定ファイルに直書きせず、`${ENV_VAR}` で環境変数から渡すことを推奨します。ログや health には出力されません。

### semantic event

`event.type` は次の 6 種のいずれかです。

| `event.type` | 意味 |
| --- | --- |
| `online` | フレンドがオフラインからオンラインになった |
| `offline` | フレンドがオンラインからオフラインになった |
| `location-change` | オンライン中のフレンドの Location が、公開された別の Location に変わった、または公開 Location から private に変わった (private からの復帰、オンライン化と同時の Location 確定を含む) |
| `friend-add` | フレンドが追加された |
| `friend-delete` | フレンドが削除された |
| `status-change` | フレンドのステータス (Join Me / Online / Ask Me / Do Not Disturb) またはステータスメッセージが変わった |

- `location-change` は、変更後の Location が**公開**されている (World を特定できる) 場合に発生します。変更前は公開 Location または private のいずれでもかまいません。公開 Location から private への遷移でも発生し、このとき `current.location` は `{ visible: false }` になります (`current.location.visible` を条件に含めていないルールにも一致する点に注意してください)。オフラインからオンラインになると同時に公開 Location が確定した場合は、`online` に続けて `location-change` も発生します (両方に一致するルールは 2 回通知されます)。private の維持、Location 未確定からの確定 (オンライン直後の最初の確定を除く) や未確定からの private では発生しません。
- `status-change` は、ステータスとステータスメッセージのどちらが変わっても発生します (どちらが変わったかは `previous` / `current` の `status` / `statusDescription` を比べてください)。ステータスの値は `join me` / `active` / `ask me` / `busy` です (`active` が Online、`busy` が Do Not Disturb)。オンライン化などの他のイベントと同時に検知した場合は、そのイベントに続けて発生します。ステータスとメッセージは項目ごとに、確認済みの値からの変化だけを通知します。各項目の初回の観測 (アップグレード直後を含む) は通知せず記録だけを行うため、変更の通知は次の変化から始まります。`offline` のステータスは記録せず直前の値を維持するため、オフラインのユーザーはステータスが未確認のことがありますが、その間もメッセージの変更は通知されます (Embed には変わった項目だけを表示します)。
- 後追い調査のため、state が変化するたびに `State changed: user=... <前> -> <後> effects=...` を、ルール評価のたびに `Matched rules:` または `No rule matched:` をログ (info) に出力します。通知されなかった遷移も、このログで追えます。
- WebSocket 再接続の原因調査のため、再接続のたびに `reconnect-triggered` の診断ログへ、raw close の `closeCode` / `closeReason` (英数字と一部記号のみ・64 文字まで)、最後のメッセージ・pong からの経過ミリ秒 (`msSinceLastMessage` / `msSinceLastPong`) を出力します。REST 同期のたびに `Reconciliation snapshot applied: friends=N drift=M` を出力し、`drift` は WebSocket で届かなかった差分の目安になります。
- WebSocket が 10 分間無言になった場合 (接続が `ready` のときのみ)、すぐには再接続せず、まず Friends API との同期で差分を確認します。差分が 0 件なら再接続せず (`Pipeline liveness probe: drift=0 action=keep ...`)、差分がある場合・同期できなかった場合・120 秒以内に完了しなかった場合は再接続します (`Pipeline liveness probe: drift=<N> action=reconnect ...` / `unverified action=reconnect ...`)。この確認は無言が続く間 10 分ごとに最大 1 回で、結果はログのみに出力され `/health` の診断履歴には含まれません。
- `traveling` (移動中) は無視され、state も更新されません。
- 初回起動 (state ファイルが無い場合) は、現在の全フレンドの状態を **通知なしで** 記録する baseline 構築を行います。Favorite group の変更や設定の reload による、過去のイベントの再評価や遡及通知は行われません。
- WebSocket 経由の検知と、起動時・WebSocket 再接続直後・1 時間ごとの Friends API による同期は、同一の経路を通ります。

### CEL 変数

| 変数 | 内容 |
| --- | --- |
| `event.type` | 上記 6 種のいずれか |
| `event.month` / `event.day` | ルール評価時の月 (1〜12) と日 (1〜31) |
| `event.weekday` | ルール評価時の曜日 (0=日〜6=土) |
| `event.hour` / `event.minute` | ルール評価時の時 (0〜23) と分 (0〜59)。夜間の条件は `event.hour >= 22 \|\| event.hour < 6` のように書く |
| (時刻の共通事項) | 時刻の変数はアプリのローカルタイムゾーン (本番コンテナは JST) で解釈する |
| `user.id` / `user.displayName` | 対象フレンドのユーザー ID と表示名 |
| `previous` / `current` | イベント前後の状態。`friend-add` では `previous == null`、`friend-delete` では `current == null` |

`previous` / `current` は次のフィールドを持ちます。

- `presence`: `"online"` または `"offline"`
- `status` / `statusDescription`: ステータス (`join me` / `active` / `ask me` / `busy`) とステータスメッセージ。未観測の場合は空文字
- `favoriteGroups`: 所属する Favorite group の一覧 (`group_0`〜`group_3`)
- `location`: offline のときは `null`。online でも Location 未確定の場合は `null` になるため、在席判定は `presence` で行ってください。private などの非公開 Location は `{ visible: false }`。公開 Location は次の構造です。
  - `location.visible`: `true`
  - `location.world.id`: World ID
  - `location.world.name`: World 名 (World 情報が有効な場合のみ存在。取得できない場合、参照したルールは評価エラーとなり、そのルールだけが不一致扱いになる)
  - `location.instance.name` / `type` / `ownerId` / `region` / `ageGate`

`location.instance.type` は次の 8 種です。

| `type` | 意味 |
| --- | --- |
| `public` | Public |
| `friends-plus` | Friends+ |
| `friends` | Friends |
| `invite-plus` | Invite+ |
| `invite` | Invite |
| `group-public` | Group Public |
| `group-plus` | Group+ |
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

設定ファイルを保存すると、数秒の遅延の後に自動で再読み込みされます。再読み込み後の設定は、以降に検知したイベントから適用されます。不正な設定 (YAML の構文エラー、未知のキー、不正な CEL 式など) への reload は失敗し、直前の正常な設定 (last-known-good) で稼働を継続します。失敗は health の `config` に反映されます。ただし、起動時に設定が不正な場合は起動に失敗します。

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

`HEALTH_HOST` (既定 `127.0.0.1`) と `HEALTH_PORT` (既定 `3000`) の `/health` が JSON を返します。`config` (設定の読み込み状態)、`ruleErrors` (ルール評価エラー)、`favorites` (Favorite Friends の更新状態) を含みます。

- `healthy`: 正常
- `degraded` (HTTP 200): 設定の reload 失敗中、直近 1 時間内のルール評価エラー、または Favorite Friends の取得失敗がある。通知は last-known-good の設定で継続している
- `unhealthy` (HTTP 503): WebSocket 接続が ready でない、またはユーザー単位の異常がある

Pipeline の接続診断はログに記録され、`/health` では直近 25 件を確認できます。接続理由、再接続試行、結果を確認できます。診断イベントにはユーザー情報、Location、Cookie、Webhook URL、raw event payload は含まれません。

## データの永続化

以下のファイルが `data/` ディレクトリに保存されます。

- `vrchat-cookies.json` - VRChat セッション Cookie
- `friend-states.json` - 全フレンドの state
- `world-cache.json` - World 情報のキャッシュ (24 時間 TTL)
- `owner-cache.json` - インスタンスオーナー (ユーザー名・グループ名) のキャッシュ (24 時間 TTL)
- `config.yaml` - 通知ルール設定ファイル (利用者が用意する)

## 旧バージョンからの移行

旧バージョンの環境変数による指定は廃止され、後方互換はありません。

1. 旧 `DISCORD_WEBHOOK_URL` (廃止) を、新しい環境変数 (例: `DISCORD_WEBHOOK_MAIN`) に移し、`destinations` の `url: ${DISCORD_WEBHOOK_MAIN}` から参照します。
2. 旧 `TARGET_USER_IDS` (廃止) の各ユーザーについて、`user.id == "usr_..."` を条件にしたルールを追加します (上記「ルールの例」の 1・2 番目)。
3. 旧 `LOCATION_FILE_PATH` (廃止) は不要です。旧 `user-locations.json` は新バージョンに引き継がれません。新バージョンは `friend-states.json` を新規に作成します。
4. 初回起動では、現在の全フレンドの状態を通知なしで記録する baseline を構築します。この間と直後に、既存の状態を理由とした通知は送られません。

### rollback

旧イメージに戻し、旧環境変数 (`DISCORD_WEBHOOK_URL` / `TARGET_USER_IDS`) を復元すれば戻せます。旧 `user-locations.json` は新バージョンから変更されません。新バージョンが作成した `friend-states.json` などは残りますが、旧バージョンには影響しません。

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
