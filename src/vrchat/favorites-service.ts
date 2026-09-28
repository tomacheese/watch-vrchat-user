import { Logger } from '@book000/node-utils'
import { toError } from '../logger-utils'

const logger = Logger.configure('FAVORITES-SERVICE')

/** 定期更新の間隔 */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/** FavoritesService の生成オプション */
export interface FavoritesServiceOptions {
  /** お気に入りグループの取得関数 */
  fetcher: () => Promise<Map<string, string[]>>
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

  /**
   * FavoritesService を初期化する
   *
   * @param options 取得関数・現在時刻関数
   */
  constructor(options: FavoritesServiceOptions) {
    this.fetcher = options.fetcher
    this.now = options.now ?? (() => Date.now())
  }

  /** お気に入りグループを再取得する。失敗時は last-known を維持する */
  async refresh(): Promise<void> {
    try {
      this.groups = await this.fetcher()
      this.lastUpdatedAt = new Date(this.now()).toISOString()
      this.lastError = null
    } catch (error) {
      this.lastError = toError(error).message
      logger.warn(`Failed to refresh favorites: ${this.lastError}`)
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
    return this.groups.get(userId) ?? []
  }

  /** 最終更新時刻と直近のエラーを返す */
  getStatus(): { lastUpdatedAt: string | null; lastError: string | null } {
    return { lastUpdatedAt: this.lastUpdatedAt, lastError: this.lastError }
  }
}
