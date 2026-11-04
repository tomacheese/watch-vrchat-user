import { Logger } from '@book000/node-utils'
import * as fsPromises from 'node:fs/promises'
import path from 'node:path'
import { toError } from '../logger-utils'

const logger = Logger.configure('WORLD-RESOLVER')

/** Cache file path (overridable via the WORLD_CACHE_FILE_PATH environment variable) */
const WORLD_CACHE_FILE_PATH =
  process.env.WORLD_CACHE_FILE_PATH ?? 'data/world-cache.json'

/** Cache time-to-live */
const TTL_MS = 24 * 60 * 60 * 1000

/** Fetch timeout */
const FETCH_TIMEOUT_MS = 10_000
/** Backoff before refetching an entry whose capacity is missing, when capacity is required */
const CAPACITY_RETRY_MS = 5 * 60 * 1000

/** Cache entry */
interface CacheEntry {
  name: string
  capacity?: number
  capacityRetryAfter?: string
  /** Last fetch time (ISO 8601) */
  fetchedAt: string
}

/** Result of resolving a world name */
export interface WorldResolveResult {
  /** World name (set only when within TTL or the fetch succeeded) */
  name?: string
  /** World capacity (set only when within TTL or the fetch succeeded, and known) */
  capacity?: number
  /** True when the fetch failed and no valid world name can be provided */
  stale?: boolean
  /** Last successful fetch time (ISO 8601) */
  lastFetchedAt?: string
}

/** Options for creating a WorldResolver */
export interface WorldResolverOptions {
  /** Fetches world information */
  fetcher: (
    worldId: string,
    signal?: AbortSignal
  ) => Promise<{
    id: string
    name: string
    capacity?: number
  }>
  /** Returns the current time (epoch ms) */
  now?: () => number
  /** Cache file path */
  filePath?: string
  /** Name of the resolved entity used in logs (default: `world`) */
  label?: string
  /** Refetch cache entries that lack capacity */
  requireCapacity?: boolean
  /** Maximum number of cache entries to keep */
  maxEntries?: number
}

/**
 * Resolves a name (e.g. a world name) from an ID.
 *
 * Keeps a persistent cache with a TTL. If a fetch fails after the TTL has
 * expired, the old name is not returned and the result is marked stale.
 * Concurrent fetches for the same worldId are shared.
 */
export class WorldResolver {
  private readonly fetcher: WorldResolverOptions['fetcher']
  private readonly now: () => number
  private readonly filePath: string
  private readonly label: string
  private readonly requireCapacity: boolean
  private cache: Map<string, CacheEntry> | undefined
  private cacheLoading: Promise<Map<string, CacheEntry>> | undefined
  private readonly maxEntries: number
  private readonly controllers = new Set<AbortController>()
  private stopped = false
  private persistPending: Promise<void> | undefined
  private persistRevision = 0
  private persistTrigger: (() => void) | undefined
  private readonly inFlight = new Map<string, Promise<WorldResolveResult>>()
  private persistQueue: Promise<void> = Promise.resolve()

  /**
   * Creates a WorldResolver.
   *
   * @param options Fetcher, clock, cache file path and other options
   */
  constructor(options: WorldResolverOptions) {
    this.fetcher = options.fetcher
    this.now = options.now ?? (() => Date.now())
    this.filePath = options.filePath ?? WORLD_CACHE_FILE_PATH
    this.label = options.label ?? 'world'
    this.requireCapacity = options.requireCapacity ?? false
    this.maxEntries = options.maxEntries ?? 10_000
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1)
      throw new Error('Invalid cache entry limit')
  }

  /**
   * Resolves the name.
   *
   * @param worldId ID to resolve
   * @returns Resolution result
   */
  async resolve(worldId: string): Promise<WorldResolveResult> {
    if (this.stopped) return { stale: true }
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
   * Fetches world information and stores it in the cache. Returns stale on failure.
   *
   * @param worldId World ID
   * @param old Existing cache entry
   * @returns Resolution result
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
      this.trimCache(cache)
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
   * Fetches world information with a timeout.
   *
   * @param worldId World ID
   * @returns Fetched world information
   */
  private async fetchWithTimeout(
    worldId: string
  ): Promise<{ id: string; name: string; capacity?: number }> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => {
      controller.abort(new Error(`Fetch timed out: ${worldId}`))
    }, FETCH_TIMEOUT_MS)
    try {
      if (this.stopped) controller.abort(new Error('World resolver stopped'))
      controller.signal.throwIfAborted()
      return await Promise.race([
        this.fetcher(worldId, controller.signal),
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
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }

  /** Stops in-flight fetches and rejects further resolves as stale. */
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers)
      controller.abort(new Error('World resolver stopped'))
  }

  /** Waits for pending cache writes to finish. */
  async flush(): Promise<void> {
    this.persistTrigger?.()
    await this.persistPending
    await this.persistQueue
  }

  /**
   * Loads the cache. Starts empty if the file is missing or unreadable.
   *
   * @returns In-memory cache
   */
  private loadCache(): Promise<Map<string, CacheEntry>> {
    if (this.cache) return Promise.resolve(this.cache)
    this.cacheLoading ??= this.readCache()
    return this.cacheLoading
  }

  /** Reads the cache file once; callers share the initial load via loadCache. */
  private async readCache(): Promise<Map<string, CacheEntry>> {
    const cache = new Map<string, CacheEntry>()
    try {
      const parsed = JSON.parse(
        await fsPromises.readFile(this.filePath, 'utf8')
      ) as Record<string, Partial<CacheEntry> | null>
      for (const [id, entry] of Object.entries(parsed)) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
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
    this.trimCache(cache)
    this.cache = cache
    return cache
  }

  /**
   * Persists atomically via tmp file + rename; writes are batched. The
   * in-memory cache is kept even if persisting fails.
   *
   * @param cache Cache to persist
   */
  private persist(cache: Map<string, CacheEntry>): Promise<void> {
    this.persistRevision++
    if (this.persistPending) return this.persistPending
    this.persistPending = new Promise<void>((resolve) => {
      const timeout: { timer?: NodeJS.Timeout } = {}
      const run = (): void => {
        if (!this.persistTrigger) return
        this.persistTrigger = undefined
        clearTimeout(timeout.timer)
        this.persistQueue = this.persistQueue.then(async () => {
          let revision: number
          do {
            revision = this.persistRevision
            const tmpPath = `${this.filePath}.tmp`
            try {
              await fsPromises.mkdir(path.dirname(this.filePath), {
                recursive: true,
              })
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
          } while (revision !== this.persistRevision)
        })
        this.persistQueue
          .finally(() => {
            this.persistPending = undefined
            resolve()
          })
          .catch(() => undefined)
      }
      timeout.timer = setTimeout(run, 25)
      this.persistTrigger = run
    })
    return this.persistPending
  }

  /** Enforces the entry limit by evicting the oldest entries. */
  private trimCache(cache: Map<string, CacheEntry>): void {
    if (cache.size <= this.maxEntries) return
    const oldest = [...cache].toSorted(
      (a, b) => Date.parse(a[1].fetchedAt) - Date.parse(b[1].fetchedAt)
    )
    const evicted = oldest.slice(0, cache.size - this.maxEntries)
    for (const [id] of evicted) cache.delete(id)
  }
}
