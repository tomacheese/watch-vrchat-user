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
 * Discord 通知の設定
 */
interface DiscordConfig {
  /** Discord Webhook URL */
  webhookUrl: string
}

/**
 * アプリケーション全体の設定
 */
export interface Config {
  /** VRChat 認証情報 */
  vrchat: VRChatConfig
  /** Discord 通知設定 */
  discord: DiscordConfig
  /** 監視対象ユーザー ID の配列 */
  targetUserIds: string[]
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
 * 環境変数の検証結果
 */
interface ValidationResult {
  /** 検証が成功したかどうか */
  valid: boolean
  /** エラーメッセージの配列 */
  errors: string[]
}

/**
 * 環境変数を検証する
 *
 * @returns 検証結果
 */
function validateEnvironmentVariables(): ValidationResult {
  const errors: string[] = []

  // 必須環境変数のチェック
  const requiredVariables = [
    'VRCHAT_USERNAME',
    'VRCHAT_PASSWORD',
    'DISCORD_WEBHOOK_URL',
    'TARGET_USER_IDS',
  ]

  for (const variable of requiredVariables) {
    if (!process.env[variable]) {
      errors.push(`Missing required environment variable: ${variable}`)
    }
  }

  // TARGET_USER_IDS の形式チェック
  const targetUserIds = process.env.TARGET_USER_IDS
  if (targetUserIds) {
    const ids = targetUserIds.split(',').filter((id) => id.trim() !== '')
    if (ids.length === 0) {
      errors.push('TARGET_USER_IDS must contain at least one user ID')
    }
  }

  // DISCORD_WEBHOOK_URL の形式チェック
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL
  if (
    webhookUrl &&
    !webhookUrl.startsWith('https://discord.com/api/webhooks/')
  ) {
    errors.push('DISCORD_WEBHOOK_URL must be a valid Discord webhook URL')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * 環境変数から設定を読み込む
 *
 * @returns アプリケーション設定
 * @throws 必須環境変数が設定されていない場合
 */
export function loadConfig(): Config {
  const validation = validateEnvironmentVariables()

  if (!validation.valid) {
    for (const error of validation.errors) {
      console.error(`[CONFIG] ${error}`)
    }
    throw new Error('Invalid configuration')
  }

  const targetUserIds = getRequiredEnv('TARGET_USER_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')

  return {
    vrchat: {
      username: getRequiredEnv('VRCHAT_USERNAME'),
      password: getRequiredEnv('VRCHAT_PASSWORD'),
      totpSecret: process.env.VRCHAT_TOTP_SECRET,
    },
    discord: {
      webhookUrl: getRequiredEnv('DISCORD_WEBHOOK_URL'),
    },
    targetUserIds,
  }
}
