# watch-vrchat-user

VRChat ユーザーの Location 変更を監視し、Discord に通知するアプリケーションです。

## 機能

- 指定したユーザーの Location 変更をリアルタイムで監視
- ユーザーのオンライン/オフライン状態を検知
- Discord Webhook を使用した通知
- セッションの永続化（2FA の再入力不要）
- 起動時にユーザーの現在状態を取得

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

# Discord 通知設定
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy

# 監視対象ユーザー ID（カンマ区切り）
TARGET_USER_IDS=usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> **注意**: `VRCHAT_TOTP_SECRET` を設定しない場合、初回起動時に 2FA コードの手動入力が必要です。

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

```bash
docker compose up -d
```

ログを確認:

```bash
docker compose logs -f
```

## データの永続化

以下のファイルが `data/` ディレクトリに保存されます。

- `vrchat-cookies.json` - VRChat セッション Cookie
- `user-locations.json` - ユーザーの Location 履歴

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
