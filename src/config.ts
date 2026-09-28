import { Logger } from '@book000/node-utils'

const logger = Logger.configure('CONFIG')

/**
 * VRChat 認証情報の設定
 */
interface VRChatConfig {
  /** VRChat ユーザー名（メールアドレス） */
  username: string
  /** VRChat パスワード */
  password: string
  /** TOTP シークレット（設定すると自動 2FA） */
  totpSecret?: string
}

/**
 * アプリケーション全体の設定
 */
export interface Config {
  /** VRChat 認証情報 */
  vrchat: VRChatConfig
  /** 通知ルール設定ファイル (YAML) のパス */
  configPath: string
}

/**
 * 必須環境変数を取得する
 * 存在しない場合はエラーをスローする
 *
 * @param name 環境変数名
 * @returns 環境変数の値
 * @throws 環境変数が設定されていない場合
 */
function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * 環境変数から設定を読み込む
 *
 * @returns アプリケーション設定
 * @throws 必須環境変数が設定されていない場合
 */
export function loadConfig(): Config {
  const errors = [
    ...(process.env.VRCHAT_USERNAME
      ? []
      : ['Missing required environment variable: VRCHAT_USERNAME']),
    ...(process.env.VRCHAT_PASSWORD
      ? []
      : ['Missing required environment variable: VRCHAT_PASSWORD']),
  ]

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error)
    }
    throw new Error('Invalid configuration')
  }

  return {
    vrchat: {
      username: getRequiredEnv('VRCHAT_USERNAME'),
      password: getRequiredEnv('VRCHAT_PASSWORD'),
      totpSecret: process.env.VRCHAT_TOTP_SECRET,
    },
    configPath: process.env.CONFIG_PATH ?? '/data/config.yaml',
  }
}
