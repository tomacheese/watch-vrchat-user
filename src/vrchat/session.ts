import { Logger } from '@book000/node-utils'
import * as readline from 'node:readline'
import { KeyvFile } from 'keyv-file'
import { VRChat } from 'vrchat'
import type { Config } from '../config'
import type { Profile } from '../state/user-state'

const logger = Logger.configure('VRCHAT-SESSION')
const REQUEST_TIMEOUT_MS = 30_000

/** Cookie ファイルのパス（環境変数で上書き可能） */
const COOKIE_FILE_PATH =
  process.env.COOKIE_FILE_PATH ?? 'data/vrchat-cookies.json'

/**
 * readline を使って 2FA コードを入力させる
 *
 * @returns ユーザーが入力した 2FA コード
 */
async function promptTwoFactorCode(signal?: AbortSignal): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      rl.close()
    }
    const onClose = (): void => {
      signal?.removeEventListener('abort', onAbort)
      reject(
        new Error(
          signal?.aborted
            ? 'Two-factor prompt aborted'
            : 'Two-factor input closed'
        )
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    rl.once('close', onClose)
    if (signal?.aborted) {
      onAbort()
      return
    }
    rl.question('Enter 2FA code: ', (answer) => {
      signal?.removeEventListener('abort', onAbort)
      rl.removeListener('close', onClose)
      rl.close()
      resolve(answer.trim())
    })
  })
}

/** Cookie データの型定義 */
interface CookieData {
  value?: ({ name?: unknown; value?: unknown } | null)[]
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
    private readonly keyvAdapter: KeyvFile,
    private readonly config: Config,
    private readonly controller: AbortController
  ) {
    // SDK の自動認証は raw socket を置き換えるため、REST 認証だけをここで管理する。
    const sdk = client as unknown as {
      saveCookies: (headers: Headers) => Promise<void>
    }
    client.client.interceptors.response.clear()
    client.client.interceptors.response.use(
      async (response, request, options) => {
        await sdk.saveCookies(response.headers)
        const meta = (
          options as {
            meta?: { sessionAuthentication?: boolean; sessionRetry?: boolean }
          }
        ).meta
        if (
          response.status !== 401 ||
          meta?.sessionAuthentication ||
          meta?.sessionRetry
        )
          return response
        await response.body?.cancel()
        const rejectedCookie = (request.headers.get('cookie') ?? '')
          .split(';')
          .map((item) => item.trim())
          .find((item) => item.startsWith('auth='))
          ?.slice(5)
        const currentCookie = await this.getAuthCookie()
        if (!currentCookie || currentCookie === rejectedCookie)
          await this.reauthenticate()
        const retryOptions = {
          ...options,
          method: options.method ?? 'GET',
          meta: { ...meta, sessionRetry: true },
          throwOnError: false,
          responseStyle: 'fields' as const,
        }
        const result = await client.client.request(retryOptions)
        const status = (result.response as Response | undefined)?.status ?? 503
        return Response.json(
          result.data ?? {
            error: { message: 'VRChat request failed', status_code: status },
          },
          { status }
        )
      }
    )
  }

  private authentication: Promise<void> | undefined
  private checking: Promise<string> | undefined

  /** Cookie を REST で検証し、失効時は再認証する。並行呼び出しは共有する。 */
  getAuthenticatedCookie(): Promise<string> {
    this.checking ??= this.checkAuthentication().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  /** REST リクエストを停止する。 */
  stop(): void {
    this.controller.abort(new Error('VRChat session stopped'))
  }

  /** Cookie の保存完了を待つ。 */
  async flush(): Promise<void> {
    const cookies = await this.getSdkCookies()
    if (cookies)
      await this.keyvAdapter.set(
        'keyv:cookies',
        JSON.stringify({ value: cookies })
      )
  }

  /** 現在の REST 認証を確認する。 */
  private async checkAuthentication(): Promise<string> {
    const result = await this.client.getCurrentUser({
      meta: { sessionAuthentication: true },
    })
    if (!(result.data && 'displayName' in result.data)) {
      if (
        result.error &&
        (result.response as Response | undefined)?.status !== 401
      )
        throw new Error('Failed to verify VRChat session')
      await this.reauthenticate()
    }
    const cookie = await this.getAuthCookie()
    if (!cookie) throw new Error('Authenticated session has no auth cookie')
    return cookie
  }

  /** 失効した REST セッションを一度だけ更新する。 */
  private reauthenticate(): Promise<void> {
    this.authentication ??= this.login().finally(() => {
      this.authentication = undefined
    })
    return this.authentication
  }

  /** SDK の再帰的な 401 処理を避けてログインする。 */
  private async login(): Promise<void> {
    this.controller.signal.throwIfAborted()
    const result = await this.client.login({
      username: this.config.vrchat.username,
      password: this.config.vrchat.password,
      totpSecret: this.config.vrchat.totpSecret,
      twoFactorCode: this.config.vrchat.totpSecret
        ? undefined
        : promptTwoFactorCode,
      meta: { sessionAuthentication: true },
    })
    if (result.error || !('displayName' in result.data))
      throw new Error('Failed to authenticate VRChat session')
  }

  /**
   * VRChat REST セッションを確立する
   *
   * 既存 Cookie でのセッション復元を試み、無効であればログインする。
   *
   * @param config アプリケーション設定
   * @returns 確立された VRChatSession
   */
  static async create(
    config: Config,
    signal?: AbortSignal
  ): Promise<VRChatSession> {
    logger.info('Initializing VRChat session...')

    const keyvAdapter = new KeyvFile({
      filename: COOKIE_FILE_PATH,
      writeDelay: 100,
    })
    const controller = new AbortController()
    if (signal) {
      const abort = (): void => {
        controller.abort(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      controller.signal.addEventListener(
        'abort',
        () => {
          signal.removeEventListener('abort', abort)
        },
        { once: true }
      )
    }
    const client = new VRChat({
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            ...(input instanceof Request ? [input.signal] : []),
            ...(init?.signal ? [init.signal] : []),
            controller.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        }),
      baseUrl: 'https://api.vrchat.cloud/api/1',
      application: {
        name: 'watch-vrchat-user',
        version: '1.0.0',
        contact: 'tomachi@tomacheese.com',
      },
      keyv: keyvAdapter,
    })

    const session = new VRChatSession(client, keyvAdapter, config, controller)
    try {
      await session.getAuthenticatedCookie()
      logger.info('VRChat session authenticated')
      return session
    } catch (error) {
      session.stop()
      throw error
    }
  }

  /** SDK のメモリ上の Cookie を取得する。 */
  private getSdkCookies(): Promise<
    { name: string; value: string }[] | undefined
  > {
    const sdk = this.client as unknown as
      | { getCookies?: () => Promise<{ name: string; value: string }[]> }
      | undefined
    return sdk?.getCookies ? sdk.getCookies() : Promise.resolve(undefined)
  }

  /**
   * Pipeline (WebSocket) 認証用の auth cookie を取得する
   *
   * @returns auth cookie の値、取得できない場合は undefined
   */
  async getAuthCookie(): Promise<string | undefined> {
    const sdkCookies = await this.getSdkCookies()
    if (sdkCookies)
      return sdkCookies.find((cookie) => cookie.name === 'auth')?.value
    const cookiesData = await this.keyvAdapter.get('keyv:cookies')
    if (!cookiesData) {
      logger.warn('No cookies data found')
      return undefined
    }

    let parsed: CookieData | null
    if (typeof cookiesData === 'string') {
      try {
        parsed = JSON.parse(cookiesData) as CookieData | null
      } catch {
        logger.error('Failed to parse cookies data')
        return undefined
      }
    } else if (typeof cookiesData === 'object') {
      parsed = cookiesData
    } else {
      logger.error('Unexpected cookies data type')
      return undefined
    }

    if (!Array.isArray(parsed?.value)) return undefined
    const authCookie = parsed.value.find(
      (c) => c?.name === 'auth' && typeof c.value === 'string'
    )
    if (!authCookie) {
      logger.warn('Auth cookie not found')
      return undefined
    }

    return typeof authCookie.value === 'string' ? authCookie.value : undefined
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
  userId: string,
  signal?: AbortSignal
): Promise<boolean> {
  const result = await vrchat.getFriendStatus({ path: { userId }, signal })
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

/** Friends API の snapshot 1 件分 */
export interface FriendSnapshot {
  /** 表示名 */
  displayName: string
  /** raw Location */
  location: string
  /** ステータスとステータスメッセージ（取得できなかった場合は undefined） */
  profile?: Profile
}

/**
 * 全フレンドのスナップショットを取得する
 *
 * online (active 含む) と offline の 2 系統をページングして統合する。
 * 両方に同一ユーザーが居る場合は online 側を採用する。
 * いずれかのページ取得が失敗した場合は部分結果を返さず例外を投げる。
 *
 * @param vrchat VRChat クライアント
 * @returns ユーザー ID から表示名・Location・ステータスへの Map
 */
export async function getFriendsSnapshot(
  vrchat: VRChat,
  signal?: AbortSignal
): Promise<Map<string, FriendSnapshot>> {
  const snapshot = new Map<string, FriendSnapshot>()

  // online を先に処理し、offline 側では既存エントリを上書きしない
  for (const offline of [false, true]) {
    let offset = 0
    while (true) {
      const result = await vrchat.getFriends({
        query: { n: PAGE_SIZE, offset, offline },
        signal,
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
            profile:
              typeof friend.status === 'string' &&
              typeof friend.statusDescription === 'string'
                ? {
                    status: friend.status,
                    statusDescription: friend.statusDescription,
                  }
                : undefined,
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
  worldId: string,
  signal?: AbortSignal
): Promise<{
  id: string
  name: string
  capacity: number
  thumbnailImageUrl?: string
}> {
  const result = await vrchat.getWorld({ path: { worldId }, signal })
  if (result.error) {
    throwApiError(`Failed to get world ${worldId}`, result.error.message)
  }
  return {
    id: result.data.id,
    name: result.data.name,
    capacity: result.data.capacity,
    thumbnailImageUrl: result.data.thumbnailImageUrl,
  }
}

/**
 * インスタンスオーナー (ユーザーまたはグループ) の名前を取得する
 *
 * @param vrchat VRChat クライアント
 * @param ownerId ユーザー ID (`usr_`) またはグループ ID (`grp_`)
 * @returns オーナーの ID と名前
 */
export async function getInstanceOwnerInfo(
  vrchat: VRChat,
  ownerId: string,
  signal?: AbortSignal
): Promise<{ id: string; name: string }> {
  if (ownerId.startsWith('grp_')) {
    const result = await vrchat.getGroup({ path: { groupId: ownerId }, signal })
    if (result.error) {
      throwApiError(`Failed to get group ${ownerId}`, result.error.message)
    }
    if (result.data.name === undefined) {
      throw new Error(`Group ${ownerId} has no name`)
    }
    return { id: ownerId, name: result.data.name }
  }
  const result = await vrchat.getUser({ path: { userId: ownerId }, signal })
  if (result.error) {
    throwApiError(`Failed to get user ${ownerId}`, result.error.message)
  }
  return { id: ownerId, name: result.data.displayName }
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
  vrchat: VRChat,
  signal?: AbortSignal
): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>()
  let offset = 0

  while (true) {
    const result = await vrchat.getFavorites({
      query: { n: PAGE_SIZE, offset, type: 'friend' },
      signal,
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
