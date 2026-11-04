import { Logger } from '@book000/node-utils'
import { toError } from '../logger-utils'

const logger = Logger.configure('FAVORITES-SERVICE')

/** Interval between periodic refreshes */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/** Options for creating a FavoritesService */
export interface FavoritesServiceOptions {
  /** Fetches favorite groups, keyed by user ID */
  fetcher: (signal?: AbortSignal) => Promise<Map<string, string[]>>
  /** Refresh timeout in milliseconds */
  timeoutMs?: number
  /** Returns the current time (epoch ms) */
  now?: () => number
}

/**
 * Holds each friend's favorite groups and refreshes them periodically.
 *
 * A failed refresh keeps the last successful result.
 */
export class FavoritesService {
  private readonly fetcher: FavoritesServiceOptions['fetcher']
  private readonly now: () => number
  private groups = new Map<string, string[]>()
  private lastUpdatedAt: string | null = null
  private lastError: string | null = null
  private timer: NodeJS.Timeout | undefined
  private refreshPromise: Promise<void> | undefined
  private controller: AbortController | undefined
  private readonly timeoutMs: number

  /**
   * Creates a FavoritesService.
   *
   * @param options Fetcher, optional clock and timeout
   */
  constructor(options: FavoritesServiceOptions) {
    this.fetcher = options.fetcher
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** Refetches favorite groups. Concurrent calls share one refresh; on failure the last-known groups are kept */
  refresh(): Promise<void> {
    this.refreshPromise ??= this.fetchGroups().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async fetchGroups(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => {
      controller.abort(new Error('Favorites refresh timed out'))
    }, this.timeoutMs)
    try {
      const groups = await Promise.race([
        this.fetcher(controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              reject(toError(controller.signal.reason))
            },
            { once: true }
          )
        }),
      ])
      if (controller.signal.aborted) return
      this.groups = groups
      this.lastUpdatedAt = new Date(this.now()).toISOString()
      this.lastError = null
    } catch (error) {
      this.lastError = toError(error).message
      logger.warn(`Failed to refresh favorites: ${this.lastError}`)
    } finally {
      clearTimeout(timer)
      this.controller = undefined
    }
  }

  /** Starts periodic refresh (the caller performs the initial refresh) */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.refresh().catch((error: unknown) => {
        logger.error('Unexpected favorites refresh error', toError(error))
      })
    }, REFRESH_INTERVAL_MS)
    this.timer.unref()
  }

  /** Stops periodic refresh and aborts any in-flight refresh */
  stop(): void {
    this.controller?.abort(new Error('Favorites service stopped'))
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Returns the favorite group names the user belongs to.
   *
   * @param userId User ID
   * @returns Group names (empty array if the user is in none)
   */
  getGroups(userId: string): string[] {
    return [...(this.groups.get(userId) ?? [])]
  }

  /** Returns the last successful update time and the latest error */
  getStatus(): { lastUpdatedAt: string | null; lastError: string | null } {
    return { lastUpdatedAt: this.lastUpdatedAt, lastError: this.lastError }
  }
}
