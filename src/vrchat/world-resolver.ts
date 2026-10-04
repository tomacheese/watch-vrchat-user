import { Logger } from '@book000/node-utils'
import * as fsPromises from 'node:fs/promises'
import path from 'node:path'
import { toError } from '../logger-utils'

const logger = Logger.configure('WORLD-RESOLVER')

/** キャッシュファイルのパス（環境変数で上書き可能） */
const WORLD_CACHE_FILE_PATH =
  process.env.WORLD_CACHE_FILE_PATH ?? 'data/world-cache.json'

/** キャッシュの有効期間 */
const TTL_MS = 24 * 60 * 60 * 1000

/** 取得のタイムアウト */
const FETCH_TIMEOUT_MS = 10_000
const CAPACITY_RETRY_MS = 5 * 60 * 1000

/** キャッシュエントリ */
interface CacheEntry {
  name: string
  capacity?: number
  capacityRetryAfter?: string
  /** 最終取得時刻 (ISO 8601) */
  fetchedAt: string
}

/** ワールド名の解決結果 */
export interface WorldResolveResult {
  /** ワールド名（TTL 内または取得成功時のみ設定される） */
  name?: string
  /** ワールドの最大人数（TTL 内または取得成功時のみ設定される） */
  capacity?: number
  /** 取得に失敗し、有効なワールド名を提供できない場合に true */
  stale?: boolean
  /** 過去に取得した最終時刻 (ISO 8601) */
  lastFetchedAt?: string
}

/** WorldResolver の生成オプション */
export interface WorldResolverOptions {
  /** ワールド情報の取得関数 */
  fetcher: (worldId: string) => Promise<{
    id: string
    name: string
    capacity?: number
  }>
  /** 現在時刻 (epoch ms) を返す関数 */
  now?: () => number
  /** キャッシュファイルのパス */
  filePath?: string
  /** ログに出す解決対象の呼称（既定は `world`） */
  label?: string
  /** 最大人数がないキャッシュを再取得する */
  requireCapacity?: boolean
}

/**
 * ワールド名など ID から名前を解決するクラス
 *
 * TTL 付きの永続キャッシュを持ち、TTL 超過後に取得へ失敗した場合は
 * 古い名前を返さず stale として扱う。同一 worldId の同時取得は共有する。
 */
export class WorldResolver {
  private readonly fetcher: WorldResolverOptions['fetcher']
  private readonly now: () => number
  private readonly filePath: string
  private readonly label: string
  private readonly requireCapacity: boolean
  private cache: Map<string, CacheEntry> | undefined
  private readonly inFlight = new Map<string, Promise<WorldResolveResult>>()
  private persistQueue: Promise<void> = Promise.resolve()

  /**
   * WorldResolver を初期化する
   *
   * @param options 取得関数・現在時刻関数・キャッシュファイルのパス
   */
  constructor(options: WorldResolverOptions) {
    this.fetcher = options.fetcher
    this.now = options.now ?? (() => Date.now())
    this.filePath = options.filePath ?? WORLD_CACHE_FILE_PATH
    this.label = options.label ?? 'world'
    this.requireCapacity = options.requireCapacity ?? false
  }

  /**
   * 名前を解決する
   *
   * @param worldId 解決対象の ID
   * @returns 解決結果
   */
  async resolve(worldId: string): Promise<WorldResolveResult> {
    const cache = await this.loadCache()
    const entry = cache.get(worldId)
    const now = this.now()
    const capacityRetryPending =
      entry?.capacityRetryAfter !== undefined &&
      Date.parse(entry.capacityRetryAfter) > now
    if (entry !== undefined) {
      const isFresh = now - Date.parse(entry.fetchedAt) < TTL_MS
      const cacheHasRequiredData =
        !this.requireCapacity ||
        entry.capacity !== undefined ||
        capacityRetryPending
      if (cacheHasRequiredData && isFresh) {
        return {
          name: entry.name,
          ...(entry.capacity !== undefined && { capacity: entry.capacity }),
          lastFetchedAt: entry.fetchedAt,
        }
      }
    }

    const existing = this.inFlight.get(worldId)
    if (existing) return existing

    const promise = this.fetchAndStore(worldId, entry).finally(() => {
      this.inFlight.delete(worldId)
    })
    this.inFlight.set(worldId, promise)
    return promise
  }

  /**
   * ワールド情報を取得してキャッシュへ保存する。失敗時は stale を返す
   *
   * @param worldId ワールド ID
   * @param old 既存のキャッシュエントリ
   * @returns 解決結果
   */
  private async fetchAndStore(
    worldId: string,
    old: CacheEntry | undefined
  ): Promise<WorldResolveResult> {
    try {
      const world = await this.fetchWithTimeout(worldId)
      if (this.requireCapacity && world.capacity === undefined) {
        throw new Error(`World capacity is unavailable: ${worldId}`)
      }
      const entry: CacheEntry = {
        name: world.name,
        ...(world.capacity !== undefined && { capacity: world.capacity }),
        fetchedAt: new Date(this.now()).toISOString(),
      }
      const cache = await this.loadCache()
      cache.set(worldId, entry)
      await this.persist(cache)
      return {
        name: entry.name,
        ...(entry.capacity !== undefined && { capacity: entry.capacity }),
        lastFetchedAt: entry.fetchedAt,
      }
    } catch (error) {
      logger.warn(
        `Failed to resolve ${this.label} ${worldId}: ${toError(error).message}`
      )
      if (
        old &&
        this.requireCapacity &&
        old.capacity === undefined &&
        this.now() - Date.parse(old.fetchedAt) < TTL_MS
      ) {
        const cache = await this.loadCache()
        cache.set(worldId, {
          ...old,
          capacityRetryAfter: new Date(
            this.now() + CAPACITY_RETRY_MS
          ).toISOString(),
        })
        await this.persist(cache)
        return { name: old.name, lastFetchedAt: old.fetchedAt }
      }
      return old
        ? { stale: true, lastFetchedAt: old.fetchedAt }
        : { stale: true }
    }
  }

  /**
   * タイムアウト付きでワールド情報を取得する
   *
   * @param worldId ワールド ID
   * @returns 取得したワールド情報
   */
  private async fetchWithTimeout(
    worldId: string
  ): Promise<{ id: string; name: string; capacity?: number }> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Fetch timed out: ${worldId}`))
      }, FETCH_TIMEOUT_MS)
    })
    try {
      return await Promise.race([this.fetcher(worldId), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * キャッシュを読み込む。ファイルが無い・破損している場合は空で始める
   *
   * @returns メモリ上のキャッシュ
   */
  private async loadCache(): Promise<Map<string, CacheEntry>> {
    if (this.cache) return this.cache
    const cache = new Map<string, CacheEntry>()
    try {
      const parsed = JSON.parse(
        await fsPromises.readFile(this.filePath, 'utf8')
      ) as Record<string, Partial<CacheEntry>>
      for (const [id, entry] of Object.entries(parsed)) {
        if (
          typeof entry.name === 'string' &&
          (entry.capacity === undefined ||
            (typeof entry.capacity === 'number' &&
              Number.isFinite(entry.capacity))) &&
          (entry.capacityRetryAfter === undefined ||
            (typeof entry.capacityRetryAfter === 'string' &&
              !Number.isNaN(Date.parse(entry.capacityRetryAfter)))) &&
          typeof entry.fetchedAt === 'string' &&
          !Number.isNaN(Date.parse(entry.fetchedAt))
        ) {
          cache.set(id, {
            name: entry.name,
            ...(entry.capacity !== undefined && { capacity: entry.capacity }),
            ...(entry.capacityRetryAfter !== undefined && {
              capacityRetryAfter: entry.capacityRetryAfter,
            }),
            fetchedAt: entry.fetchedAt,
          })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          `Cache ${this.filePath} is unreadable, starting empty: ${toError(error).message}`
        )
      }
    }
    this.cache = cache
    return cache
  }

  /**
   * tmp + rename でアトミックに永続化する。失敗してもメモリ上のキャッシュは維持する
   *
   * @param cache 永続化するキャッシュ
   */
  private async persist(cache: Map<string, CacheEntry>): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const tmpPath = `${this.filePath}.tmp`
      try {
        await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true })
        await fsPromises.writeFile(
          tmpPath,
          JSON.stringify(Object.fromEntries(cache)),
          'utf8'
        )
        await fsPromises.rename(tmpPath, this.filePath)
      } catch (error) {
        logger.warn(
          `Failed to persist cache ${this.filePath}: ${toError(error).message}`
        )
      }
    })
    await this.persistQueue
  }
}
