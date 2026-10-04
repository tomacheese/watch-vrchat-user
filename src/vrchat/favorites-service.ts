import { Logger } from '@book000/node-utils'
import { toError } from '../logger-utils'

const logger = Logger.configure('FAVORITES-SERVICE')

/** 定期更新の間隔 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/** FavoritesService の生成オプション */
export interface FavoritesServiceOptions {
  /** お気に入りグループの取得関数 */
  fetcher: (signal?: AbortSignal) => Promise<Map<string, string[]>>
  /** 更新のタイムアウト（ミリ秒） */
  timeoutMs?: number
  /** 現在時刻 (epoch ms) を返す関数 */
  now?: () => number
}

/**
 * フレンドのお気に入りグループを保持し、定期更新するサービス
 *
 * 更新に失敗した場合は最後に成功した内容を維持する。
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
   * FavoritesService を初期化する
   *
   * @param options 取得関数・現在時刻関数
   */
  constructor(options: FavoritesServiceOptions) {
    this.fetcher = options.fetcher
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** お気に入りグループを再取得する。失敗時は last-known を維持する */
  refresh(): Promise<void> {
    this.refreshPromise ??= this.fetchGroups().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  /** 中断可能な更新を実行する。 */
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

  /** 定期更新を開始する（初回の refresh は呼び出し側が行う） */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.refresh().catch((error: unknown) => {
        logger.error('Unexpected favorites refresh error', toError(error))
      })
    }, REFRESH_INTERVAL_MS)
    this.timer.unref()
  }

  /** 定期更新を停止する */
  stop(): void {
    this.controller?.abort(new Error('Favorites service stopped'))
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * ユーザーが属するお気に入りグループ名を返す
   *
   * @param userId ユーザー ID
   * @returns グループ名の配列（未所属は空配列）
   */
  getGroups(userId: string): string[] {
    return [...(this.groups.get(userId) ?? [])]
  }

  /** 最終更新時刻と直近のエラーを返す */
  getStatus(): { lastUpdatedAt: string | null; lastError: string | null } {
    return { lastUpdatedAt: this.lastUpdatedAt, lastError: this.lastError }
  }
}
