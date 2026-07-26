import { Logger } from '@book000/node-utils'
import * as readline from 'node:readline'
import { KeyvFile } from 'keyv-file'
import { VRChat } from 'vrchat'
import type { Config } from './config'
import { toError } from './logger-utils'

const logger = Logger.configure('VRCHAT')

/** Cookie ファイルのパス（環境変数で上書き可能） */
const COOKIE_FILE_PATH =
  process.env.COOKIE_FILE_PATH ?? 'data/vrchat-cookies.json'

/**
 * readline を使って 2FA コードを入力させる
 *
 * @returns ユーザーが入力した 2FA コード
 */
async function promptTwoFactorCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Enter 2FA code: ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Cookie データの型定義
 */
interface CookieData {
  value: { name: string; value: string }[]
}

/**
 * WebSocket (pipeline) を認証する
 *
 * @param vrchat VRChat クライアント
 * @param keyvAdapter Cookie を保存している Keyv アダプタ
 */
async function authenticateWebSocket(
  vrchat: VRChat,
  keyvAdapter: KeyvFile
): Promise<void> {
  const cookiesData = await keyvAdapter.get('keyv:cookies')
  if (!cookiesData) {
    logger.warn('No cookies data found, WebSocket not authenticated')
    return
  }

  // keyvAdapter.get の戻り値は string または object の可能性がある
  let parsed: CookieData
  if (typeof cookiesData === 'string') {
    try {
      parsed = JSON.parse(cookiesData) as CookieData
    } catch {
      logger.error('Failed to parse cookies data, WebSocket not authenticated')
      return
    }
  } else if (typeof cookiesData === 'object') {
    // すでに object として保存されている場合
    parsed = cookiesData as CookieData
  } else {
    logger.error('Unexpected cookies data type, WebSocket not authenticated')
    return
  }

  const authCookie = parsed.value.find((c) => c.name === 'auth')
  if (!authCookie) {
    logger.warn('Auth cookie not found, WebSocket not authenticated')
    return
  }

  try {
    await vrchat.pipeline.authenticate(authCookie.value)
    logger.info('WebSocket authenticated')
  } catch (error) {
    logger.error('Failed to authenticate WebSocket', toError(error))
  }
}

/**
 * VRChat クライアントを初期化する
 *
 * @param config アプリケーション設定
 * @returns 初期化された VRChat クライアント
 */
export async function createVRChatClient(config: Config): Promise<VRChat> {
  logger.info('Initializing VRChat client...')

  // Cookie 永続化用の Keyv アダプタを作成
  const keyvAdapter = new KeyvFile({
    filename: COOKIE_FILE_PATH,
    writeDelay: 100,
  })

  // VRChat クライアントを初期化
  const vrchat = new VRChat({
    baseUrl: 'https://api.vrchat.cloud/api/1',
    application: {
      name: 'watch-vrchat-user',
      version: '1.0.0',
      contact: 'tomachi@tomacheese.com',
    },
    keyv: keyvAdapter,
  })

  // まず Cookie を使ってセッション復元を試みる
  logger.info('Checking existing session...')
  const currentUserResult = await vrchat.getCurrentUser()

  // セッションが有効な場合（displayName がある = CurrentUser）
  if (currentUserResult.data && 'displayName' in currentUserResult.data) {
    logger.info(`Session restored: ${currentUserResult.data.displayName}`)

    // WebSocket (pipeline) を認証するために keyv から auth cookie を取得
    await authenticateWebSocket(vrchat, keyvAdapter)

    return vrchat
  }

  // セッションが無効な場合はログインを試みる
  logger.info('No valid session, logging in...')
  const loginResult = await vrchat.login({
    username: config.vrchat.username,
    password: config.vrchat.password,
    totpSecret: config.vrchat.totpSecret,
    // totpSecret が設定されていない場合は readline で 2FA コードを入力させる
    twoFactorCode: config.vrchat.totpSecret ? undefined : promptTwoFactorCode,
  })

  if (loginResult.error) {
    throw new Error(`Failed to login: ${loginResult.error.message}`)
  }

  // SDK は 2FA が必要な場合に内部で自動処理するため、
  // 成功時は CurrentUser が返される。防御的に displayName の存在を確認
  const data = loginResult.data
  if (!('displayName' in data)) {
    // 通常発生しないが、SDK の動作が変わった場合に備える
    throw new Error(
      'Login succeeded but user data is incomplete (no displayName)'
    )
  }
  logger.info(`Logged in as ${data.displayName}`)

  // ログイン後も WebSocket を認証する
  await authenticateWebSocket(vrchat, keyvAdapter)

  return vrchat
}

/**
 * 指定したユーザー ID がフレンドかどうかを確認する
 *
 * @param vrchat VRChat クライアント
 * @param userId 確認するユーザー ID
 * @returns フレンドの場合は true
 */
export async function isFriend(
  vrchat: VRChat,
  userId: string
): Promise<boolean> {
  const result = await vrchat.getFriendStatus({ path: { userId } })

  if (result.error) {
    logger.error(
      `Failed to get friend status for ${userId}: ${result.error.message}`
    )
    return false
  }

  return result.data.isFriend
}

/**
 * ユーザー情報の型定義
 */
export interface UserInfo {
  /** ユーザー ID */
  id: string
  /** 表示名 */
  displayName: string
  /** 現在の Location（offline の場合は null） */
  location: string | null
  /** ステータス */
  status: string
  /** 現在いるワールドの情報 */
  world?: {
    id: string
    name: string
    thumbnailImageUrl?: string
  }
}

/**
 * ユーザー情報を取得する
 *
 * @param vrchat VRChat クライアント
 * @param userId ユーザー ID
 * @returns ユーザー情報（取得できない場合は null）
 */
export async function getUser(
  vrchat: VRChat,
  userId: string
): Promise<UserInfo | null> {
  const result = await vrchat.getUser({ path: { userId } })

  if (result.error) {
    // 429 エラー（レート制限）の場合は例外を投げる
    if (
      result.error.message.includes('429') ||
      result.error.message.toLowerCase().includes('rate limit')
    ) {
      throw new Error(`Rate limit error (429): ${result.error.message}`)
    }

    logger.error(`Failed to get user ${userId}: ${result.error.message}`)
    return null
  }

  const user = result.data

  // Location が "offline" または空の場合は null として扱う
  const location =
    user.location && user.location !== 'offline' ? user.location : null

  return {
    id: user.id,
    displayName: user.displayName,
    location,
    status: user.status,
  }
}

/**
 * フレンド一覧を取得する
 *
 * 現在は未使用だが、将来的に全フレンドの Location 監視機能を
 * 追加する際に使用する予定
 *
 * @param vrchat VRChat クライアント
 * @returns フレンドのユーザー ID の配列
 */
export async function getFriendIds(vrchat: VRChat): Promise<string[]> {
  const friendIds: string[] = []
  let offset = 0
  const limit = 100

  // ページネーションを使ってすべてのフレンドを取得
  while (true) {
    const result = await vrchat.getFriends({
      query: { n: limit, offset },
    })

    if (result.error) {
      logger.error(
        `Failed to get friends (offset=${offset}): ${result.error.message}`
      )
      break
    }

    for (const friend of result.data) {
      friendIds.push(friend.id)
    }

    // すべて取得した場合はループを抜ける
    if (result.data.length < limit) {
      break
    }

    offset += limit
  }

  return friendIds
}
