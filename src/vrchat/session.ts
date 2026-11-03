import { Logger } from '@book000/node-utils'
import * as readline from 'node:readline'
import { KeyvFile } from 'keyv-file'
import { VRChat } from 'vrchat'
import type { Config } from '../config'
import type { Profile } from '../state/user-state'

const logger = Logger.configure('VRCHAT-SESSION')
const REQUEST_TIMEOUT_MS = 30_000

/** Cookie file path (overridable via the COOKIE_FILE_PATH environment variable) */
const COOKIE_FILE_PATH =
  process.env.COOKIE_FILE_PATH ?? 'data/vrchat-cookies.json'

/**
 * Prompts for a 2FA code via readline.
 *
 * @param signal Aborts the prompt when signaled
 * @returns The 2FA code the user entered
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

/** Shape of the stored cookie data */
interface CookieData {
  value?: ({ name?: unknown; value?: unknown } | null)[]
}

/**
 * Represents a VRChat REST session.
 *
 * Responsible only for REST authentication, cookie persistence and the
 * lifecycle of the VRChat API client; it does not start the Pipeline (WebSocket).
 */
export class VRChatSession {
  private constructor(
    public readonly client: VRChat,
    private readonly keyvAdapter: KeyvFile,
    private readonly config: Config,
    private readonly controller: AbortController
  ) {
    // The SDK's automatic authentication replaces the raw socket, so only REST
    // authentication is managed here (the response interceptor is replaced).
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

  /** Verifies the cookie via REST and reauthenticates if it has expired. Concurrent calls share one check. */
  getAuthenticatedCookie(): Promise<string> {
    this.checking ??= this.checkAuthentication().finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  /** Aborts in-flight REST requests. */
  stop(): void {
    this.controller.abort(new Error('VRChat session stopped'))
  }

  /** Writes the SDK's in-memory cookies to the cookie store. */
  async flush(): Promise<void> {
    const cookies = await this.getSdkCookies()
    if (cookies)
      await this.keyvAdapter.set(
        'keyv:cookies',
        JSON.stringify({ value: cookies })
      )
  }

  /** Checks the current REST authentication and returns the auth cookie. */
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

  /** Renews an expired REST session; concurrent callers share a single login. */
  private reauthenticate(): Promise<void> {
    this.authentication ??= this.login().finally(() => {
      this.authentication = undefined
    })
    return this.authentication
  }

  /** Logs in, marking the request so the 401 interceptor does not recurse. */
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
   * Establishes a VRChat REST session.
   *
   * Tries to restore the session from existing cookies and logs in if they are invalid.
   *
   * @param config Application config
   * @param signal Aborts the session's requests when signaled
   * @returns The established VRChatSession
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

  /** Gets the cookies held in the SDK's memory. */
  private getSdkCookies(): Promise<
    { name: string; value: string }[] | undefined
  > {
    const sdk = this.client as unknown as
      | { getCookies?: () => Promise<{ name: string; value: string }[]> }
      | undefined
    return sdk?.getCookies ? sdk.getCookies() : Promise.resolve(undefined)
  }

  /**
   * Gets the auth cookie used to authenticate the Pipeline (WebSocket).
   *
   * @returns The auth cookie value, or undefined if unavailable
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
 * Checks whether the given user ID is a friend.
 *
 * If the API call itself fails, "not a friend" cannot be concluded, so this
 * throws instead of returning false (so callers do not wrongly treat it as fatal).
 *
 * @param vrchat VRChat client
 * @param userId User ID to check
 * @param signal Aborts the request when signaled
 * @returns True if the user is a friend
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

/** Number of items per page when paging */
const PAGE_SIZE = 100

/**
 * Throws an API error as an Error.
 *
 * For 429 / rate limit errors the message includes `Rate limit error (429)`
 * (a contract the Reconciler relies on to decide whether to abort).
 *
 * @param context Description of the operation, prefixed to the error message
 * @param message Message of the API error
 */
function throwApiError(context: string, message: string): never {
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
    throw new Error(`Rate limit error (429): ${context}: ${message}`)
  }
  throw new Error(`${context}: ${message}`)
}

/** One entry of a Friends API snapshot */
export interface FriendSnapshot {
  /** Display name */
  displayName: string
  /** raw Location */
  location: string
  /** Status and status message (undefined if unavailable) */
  profile?: Profile
}

/**
 * Gets a snapshot of all friends.
 *
 * Pages through the online (including active) and offline lists and merges them.
 * If a user is in both, the online entry wins.
 * If any page fails to load, this throws instead of returning a partial result.
 *
 * @param vrchat VRChat client
 * @param signal Aborts the requests when signaled
 * @returns Map from user ID to display name, Location and status
 */
export async function getFriendsSnapshot(
  vrchat: VRChat,
  signal?: AbortSignal
): Promise<Map<string, FriendSnapshot>> {
  const snapshot = new Map<string, FriendSnapshot>()

  // Process online first; the offline pass never overwrites existing entries
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
 * Gets world information.
 *
 * @param vrchat VRChat client
 * @param worldId World ID
 * @param signal Aborts the request when signaled
 * @returns World information
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
 * Gets the name of an instance owner (user or group).
 *
 * @param vrchat VRChat client
 * @param ownerId User ID (`usr_`) or group ID (`grp_`)
 * @param signal Aborts the request when signaled
 * @returns The owner's ID and name
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
 * Aggregates friends' favorite groups (group_0 to group_3) per user.
 *
 * If any page fails to load, this throws instead of returning a partial result.
 *
 * @param vrchat VRChat client
 * @param signal Aborts the requests when signaled
 * @returns Map from user ID to an array of favorite group names
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
