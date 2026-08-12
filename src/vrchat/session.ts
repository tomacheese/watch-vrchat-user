import { Logger } from '@book000/node-utils'
import * as readline from 'node:readline'
import { KeyvFile } from 'keyv-file'
import { VRChat } from 'vrchat'
import type { Config } from '../config'

const logger = Logger.configure('VRCHAT-SESSION')

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

/** Cookie データの型定義 */
interface CookieData {
  value: { name: string; value: string }[]
}

/**
 * VRChat REST セッションを表すクラス
 *
 * REST 認証・Cookie 永続化・VRChat API client のライフサイクルのみを担当し、
 * Pipeline (WebSocket) の開始は担当しない。
 */
export class VRChatSession {
  private constructor(
    public readonly client: VRChat,
    private readonly keyvAdapter: KeyvFile
  ) {}

  /**
   * VRChat REST セッションを確立する
   *
   * 既存 Cookie でのセッション復元を試み、無効であればログインする。
   *
   * @param config アプリケーション設定
   * @returns 確立された VRChatSession
   */
  static async create(config: Config): Promise<VRChatSession> {
    logger.info('Initializing VRChat session...')

    const keyvAdapter = new KeyvFile({
      filename: COOKIE_FILE_PATH,
      writeDelay: 100,
    })
    const client = new VRChat({
      baseUrl: 'https://api.vrchat.cloud/api/1',
      application: {
        name: 'watch-vrchat-user',
        version: '1.0.0',
        contact: 'tomachi@tomacheese.com',
      },
      keyv: keyvAdapter,
    })

    logger.info('Checking existing session...')
    const currentUserResult = await client.getCurrentUser()

    if (currentUserResult.data && 'displayName' in currentUserResult.data) {
      logger.info(`Session restored: ${currentUserResult.data.displayName}`)
      return new VRChatSession(client, keyvAdapter)
    }

    logger.info('No valid session, logging in...')
    const loginResult = await client.login({
      username: config.vrchat.username,
      password: config.vrchat.password,
      totpSecret: config.vrchat.totpSecret,
      twoFactorCode: config.vrchat.totpSecret ? undefined : promptTwoFactorCode,
    })

    if (loginResult.error) {
      throw new Error(`Failed to login: ${loginResult.error.message}`)
    }

    const data = loginResult.data
    if (!('displayName' in data)) {
      throw new Error(
        'Login succeeded but user data is incomplete (no displayName)'
      )
    }
    logger.info(`Logged in as ${data.displayName}`)

    return new VRChatSession(client, keyvAdapter)
  }

  /**
   * Pipeline (WebSocket) 認証用の auth cookie を取得する
   *
   * @returns auth cookie の値、取得できない場合は undefined
   */
  async getAuthCookie(): Promise<string | undefined> {
    const cookiesData = await this.keyvAdapter.get('keyv:cookies')
    if (!cookiesData) {
      logger.warn('No cookies data found')
      return undefined
    }

    let parsed: CookieData
    if (typeof cookiesData === 'string') {
      try {
        parsed = JSON.parse(cookiesData) as CookieData
      } catch {
        logger.error('Failed to parse cookies data')
        return undefined
      }
    } else if (typeof cookiesData === 'object') {
      parsed = cookiesData as CookieData
    } else {
      logger.error('Unexpected cookies data type')
      return undefined
    }

    const authCookie = parsed.value.find((c) => c.name === 'auth')
    if (!authCookie) {
      logger.warn('Auth cookie not found')
      return undefined
    }

    return authCookie.value
  }
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
 * 指定したユーザー ID がフレンドかどうかを確認する
 *
 * API 呼び出し自体が失敗した場合は「フレンドではない」と確定できないため、
 * false を返さず例外を投げる（呼び出し側が誤って fatal 判定しないようにする）。
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
    throw new Error(
      `Failed to get friend status for ${userId}: ${result.error.message}`
    )
  }
  return result.data.isFriend
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
 * 現在は未使用だが、将来的に全フレンドの Location 監視機能を追加する際に使用する予定
 *
 * @param vrchat VRChat クライアント
 * @returns フレンドのユーザー ID の配列
 */
export async function getFriendIds(vrchat: VRChat): Promise<string[]> {
  const friendIds: string[] = []
  let offset = 0
  const limit = 100

  while (true) {
    const result = await vrchat.getFriends({ query: { n: limit, offset } })
    if (result.error) {
      logger.error(
        `Failed to get friends (offset=${offset}): ${result.error.message}`
      )
      break
    }
    for (const friend of result.data) {
      friendIds.push(friend.id)
    }
    if (result.data.length < limit) {
      break
    }
    offset += limit
  }

  return friendIds
}
