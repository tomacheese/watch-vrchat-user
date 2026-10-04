import fs from 'node:fs'

// パスや Cookie 設定を読むモジュールより先に環境変数を展開する。
if (fs.existsSync('.env')) process.loadEnvFile('.env')
