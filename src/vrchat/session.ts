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

/** ページング取得の 1 ページあたり件数 */
const PAGE_SIZE = 100

/**
 * API エラーを Error として投げる
 *
 * 429 / rate limit の場合は message に `Rate limit error (429)` を含める（Reconciler の中断判定契約）。
 *
 * @param context エラーメッセージに付与する操作の説明
 * @param message API エラーの message
 */
function throwApiError(context: string, message: string): never {
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
    throw new Error(`Rate limit error (429): ${context}: ${message}`)
  }
  throw new Error(`${context}: ${message}`)
}

/**
 * 全フレンドのスナップショットを取得する
 *
 * online (active 含む) と offline の 2 系統をページングして統合する。
 * 両方に同一ユーザーが居る場合は online 側を採用する。
 * いずれかのページ取得が失敗した場合は部分結果を返さず例外を投げる。
 *
 * @param vrchat VRChat クライアント
 * @returns ユーザー ID から表示名と Location への Map
 */
export async function getFriendsSnapshot(
  vrchat: VRChat
): Promise<Map<string, { displayName: string; location: string }>> {
  const snapshot = new Map<string, { displayName: string; location: string }>()

  // online を先に処理し、offline 側では既存エントリを上書きしない
  for (const offline of [false, true]) {
    let offset = 0
    while (true) {
      const result = await vrchat.getFriends({
        query: { n: PAGE_SIZE, offset, offline },
      })
      if (result.error) {
        throwApiError(
          `Failed to get friends (offline=${String(offline)}, offset=${offset})`,
          result.error.message
        )
      }
      for (const friend of result.data) {
        if (!snapshot.has(friend.id)) {
          snapshot.set(friend.id, {
            displayName: friend.displayName,
            location: friend.location,
          })
        }
      }
      if (result.data.length < PAGE_SIZE) {
        break
      }
      offset += PAGE_SIZE
    }
  }

  return snapshot
}

/**
 * ワールド情報を取得する
 *
 * @param vrchat VRChat クライアント
 * @param worldId ワールド ID
 * @returns ワールド情報
 */
export async function getWorldInfo(
  vrchat: VRChat,
  worldId: string
): Promise<{ id: string; name: string; thumbnailImageUrl?: string }> {
  const result = await vrchat.getWorld({ path: { worldId } })
  if (result.error) {
    throwApiError(`Failed to get world ${worldId}`, result.error.message)
  }
  return {
    id: result.data.id,
    name: result.data.name,
    thumbnailImageUrl: result.data.thumbnailImageUrl,
  }
}

/**
 * フレンドのお気に入りグループ (group_0 から group_3) をユーザーごとに集約する
 *
 * いずれかのページ取得が失敗した場合は部分結果を返さず例外を投げる。
 *
 * @param vrchat VRChat クライアント
 * @returns ユーザー ID からお気に入りグループ名の配列への Map
 */
export async function getFriendFavoriteGroups(
  vrchat: VRChat
): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>()
  let offset = 0

  while (true) {
    const result = await vrchat.getFavorites({
      query: { n: PAGE_SIZE, offset, type: 'friend' },
    })
    if (result.error) {
      throwApiError(
        `Failed to get favorites (offset=${offset})`,
        result.error.message
      )
    }
    for (const favorite of result.data) {
      const matched = favorite.tags.filter((tag) => /^group_[0-3]$/.test(tag))
      if (matched.length === 0) continue
      const existing = groups.get(favorite.favoriteId) ?? []
      for (const tag of matched) {
        if (!existing.includes(tag)) existing.push(tag)
      }
      groups.set(favorite.favoriteId, existing)
    }
    if (result.data.length < PAGE_SIZE) {
      break
    }
    offset += PAGE_SIZE
  }

  return groups
}
