import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Logger } from '@book000/node-utils'
import type {
  PersistedConfig,
  PersistedEffect,
} from '../notifications/outbox-types'
import { getPersistedConfigId } from '../notifications/outbox-types'
import {
  isUserStateStoreData,
  isValidUserState,
  type UserState,
  type UserStateStoreData,
} from './user-state'

const logger = Logger.configure('USER-STATE-REPOSITORY')
const MAX_PENDING_EFFECTS = 10_000
const MAX_PENDING_CONFIG_SNAPSHOTS = 32
const DATABASE_SCHEMA_VERSION = '1'
const BUSY_TIMEOUT_MS = 5000

interface StoreData extends UserStateStoreData {
  outbox: PersistedEffect[]
  configRefCounts: Map<string, number>
}

interface Mutation {
  update: (data: StoreData) => StoreData
  persist: (database: DatabaseSync) => void
  resolve: () => void
  reject: (error: unknown) => void
}

export function getUserStateDatabasePath(filePath: string): string {
  if (path.extname(filePath) === '.sqlite') return filePath
  const basename = path.basename(filePath).replace(/\.json$/i, '')
  return path.join(path.dirname(filePath), `${basename}.sqlite`)
}

function emptyData(): StoreData {
  return {
    schemaVersion: 3,
    baselineCompleted: false,
    users: {},
    outbox: [],
    configRefCounts: new Map(),
  }
}

function countConfigs(outbox: PersistedEffect[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of outbox) {
    counts.set(entry.configId, (counts.get(entry.configId) ?? 0) + 1)
  }
  return counts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPersistedConfig(value: unknown): value is PersistedConfig {
  if (
    !isRecord(value) ||
    typeof value.loadedAt !== 'string' ||
    !isRecord(value.destinations) ||
    !Array.isArray(value.rules)
  )
    return false
  const destinations = value.destinations
  const rules = value.rules
  return (
    Object.values(destinations).every(
      (destination: unknown) =>
        isRecord(destination) &&
        destination.type === 'discord-webhook' &&
        typeof destination.url === 'string' &&
        destination.url.startsWith('https://discord.com/api/webhooks/')
    ) &&
    rules.every((rule: unknown) =>
      isRecord(rule) &&
      typeof rule.name === 'string' &&
      typeof rule.when === 'string' &&
      typeof rule.enabled === 'boolean' &&
      Array.isArray(rule.destinations)
        ? rule.destinations.every(
            (name: unknown) =>
              typeof name === 'string' && Object.hasOwn(destinations, name)
          )
        : false
    )
  )
}

function isDelivery(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    ['pending', 'sending', 'delivered', 'blocked', 'uncertain'].includes(
      value.status
    ) &&
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    (value.nextAttemptAt === undefined ||
      (typeof value.nextAttemptAt === 'number' &&
        Number.isFinite(value.nextAttemptAt))) &&
    (value.lastError === undefined || typeof value.lastError === 'string') &&
    isRecord(value.embed)
  )
}

function isEffect(value: unknown, config: unknown): value is PersistedEffect {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isRecord(value.effect) &&
    typeof value.effect.type === 'string' &&
    [
      'online',
      'offline',
      'location-change',
      'friend-add',
      'friend-delete',
      'status-change',
    ].includes(value.effect.type) &&
    (value.effect.previous === undefined ||
      isValidUserState(value.effect.previous)) &&
    (value.effect.current === undefined ||
      isValidUserState(value.effect.current)) &&
    (value.effect.previous !== undefined ||
      value.effect.current !== undefined) &&
    typeof value.configId === 'string' &&
    isPersistedConfig(config) &&
    getPersistedConfigId(config) === value.configId &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.deliveries === undefined ||
      (Array.isArray(value.deliveries) &&
        value.deliveries.every((delivery: unknown) => isDelivery(delivery))))
  )
}
function parseLegacyData(raw: unknown): StoreData {
  if (!isUserStateStoreData(raw)) {
    throw new TypeError(
      'Invalid user state store; restore a backup before starting'
    )
  }
  const outbox = (raw as UserStateStoreData & { outbox?: unknown }).outbox
  if (outbox === undefined) {
    return { ...raw, outbox: [], configRefCounts: new Map() }
  }
  if (!Array.isArray(outbox)) {
    throw new TypeError(
      'Invalid notification outbox; restore a backup before starting'
    )
  }
  const ids = new Set<string>()
  const migrated = outbox.map((entry: unknown) => {
    if (!isRecord(entry) || !isPersistedConfig(entry.config)) {
      throw new Error(
        'Invalid notification outbox; restore a backup before starting'
      )
    }
    const next = { ...entry, configId: getPersistedConfigId(entry.config) }
    if (!isEffect(next, entry.config) || ids.has(next.id)) {
      throw new Error(
        'Invalid notification outbox; restore a backup before starting'
      )
    }
    ids.add(next.id)
    return next
  })
  if (
    migrated.length > MAX_PENDING_EFFECTS ||
    countConfigs(migrated).size > MAX_PENDING_CONFIG_SNAPSHOTS
  ) {
    throw new Error('Notification outbox exceeds supported storage limits')
  }
  return {
    ...raw,
    outbox: migrated,
    configRefCounts: countConfigs(migrated),
  }
}

function openPrivateDatabase(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  if (!fs.existsSync(filePath)) {
    try {
      const fd = fs.openSync(filePath, 'wx', 0o600)
      fs.closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  fs.chmodSync(filePath, 0o600)
  const database = new DatabaseSync(filePath, { timeout: BUSY_TIMEOUT_MS })
  database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
  return database
}

function insertEffect(database: DatabaseSync, entry: PersistedEffect): void {
  const serializedConfig = JSON.stringify(entry.config)
  database
    .prepare(
      'INSERT OR IGNORE INTO configs (config_id, config_json) VALUES (?, ?)'
    )
    .run(entry.configId, serializedConfig)
  database
    .prepare(
      `INSERT INTO outbox
       (id, user_id, display_name, effect_json, config_id, created_at, deliveries_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id,
      entry.userId,
      entry.displayName,
      JSON.stringify(entry.effect),
      entry.configId,
      entry.createdAt,
      entry.deliveries === undefined ? null : JSON.stringify(entry.deliveries),
      entry.error ?? null
    )
}

function createSchema(database: DatabaseSync, data: StoreData): void {
  database.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (user_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE configs (config_id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      config_id TEXT NOT NULL REFERENCES configs(config_id),
      created_at TEXT NOT NULL,
      deliveries_json TEXT,
      error TEXT
    );
    CREATE INDEX outbox_user_sequence ON outbox(user_id, sequence);
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    const insertMetadata = database.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?)'
    )
    insertMetadata.run('schema_version', DATABASE_SCHEMA_VERSION)
    insertMetadata.run('baseline_completed', String(data.baselineCompleted))
    const insertUser = database.prepare(
      'INSERT INTO users (user_id, state_json) VALUES (?, ?)'
    )
    for (const [userId, state] of Object.entries(data.users)) {
      insertUser.run(userId, JSON.stringify(state))
    }
    for (const entry of data.outbox) insertEffect(database, entry)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/** state と outbox を transaction で保存する SQLite repository */
export class UserStateRepository {
  private data: StoreData = emptyData()
  private readonly filePath: string
  private readonly databaseFilePath: string
  private readonly mutations: Mutation[] = []
  private database: DatabaseSync | undefined
  private writerLock: DatabaseSync | undefined
  private writing = false
  private scheduled = false
  private readonly flushWaiters = new Set<() => void>()

  constructor(
    filePath?: string,
    private readonly options: { exclusive?: boolean } = {}
  ) {
    this.filePath =
      filePath ?? process.env.STATE_FILE_PATH ?? 'data/friend-states.json'
    this.databaseFilePath = getUserStateDatabasePath(this.filePath)
  }

  /** JSON schema 3 を SQLite へ一度だけ移行し、不正な既存データは保持して停止する */
  load(): void {
    if (this.options.exclusive) this.acquireWriterLock()
    if (fs.existsSync(this.databaseFilePath)) {
      this.database = openPrivateDatabase(this.databaseFilePath)
      this.data = this.readDatabase(this.database)
      return
    }
    const legacy = fs.existsSync(this.filePath)
      ? parseLegacyData(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
      : emptyData()
    if (fs.existsSync(this.filePath)) fs.chmodSync(this.filePath, 0o600)
    const temporaryPath = `${this.databaseFilePath}.${randomUUID()}.tmp`
    let temporaryDatabase: DatabaseSync | undefined
    try {
      temporaryDatabase = openPrivateDatabase(temporaryPath)
      createSchema(temporaryDatabase, legacy)
      temporaryDatabase.close()
      temporaryDatabase = undefined
      fs.renameSync(temporaryPath, this.databaseFilePath)
      this.database = openPrivateDatabase(this.databaseFilePath)
      this.data = this.readDatabase(this.database)
    } catch (error) {
      temporaryDatabase?.close()
      try {
        fs.unlinkSync(temporaryPath)
      } catch {
        // Keep the original JSON store untouched if migration fails.
      }
      throw error
    }
  }

  /** アプリと recovery CLI の排他を SQLite の OS-level file lock で維持する */
  private acquireWriterLock(): void {
    const lockPath = `${this.databaseFilePath}.writer-lock.sqlite`
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    let lockDatabase: DatabaseSync | undefined
    try {
      if (!fs.existsSync(lockPath)) {
        try {
          const fd = fs.openSync(lockPath, 'wx', 0o600)
          fs.closeSync(fd)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      fs.chmodSync(lockPath, 0o600)
      lockDatabase = new DatabaseSync(lockPath, { timeout: 0 })
      lockDatabase.exec(
        'CREATE TABLE IF NOT EXISTS writer_lock (id INTEGER PRIMARY KEY)'
      )
      lockDatabase.exec('BEGIN EXCLUSIVE')
      lockDatabase
        .prepare('INSERT OR REPLACE INTO writer_lock (id) VALUES (1)')
        .run()
      this.writerLock = lockDatabase
    } catch (error) {
      lockDatabase?.close()
      throw new Error(
        'State store is in use; stop the application before recovery',
        {
          cause: error,
        }
      )
    }
  }

  private readDatabase(database: DatabaseSync): StoreData {
    const metadata = new Map(
      (
        database.prepare('SELECT key, value FROM metadata').all() as {
          key: string
          value: string
        }[]
      ).map(({ key, value }) => [key, value])
    )
    if (
      metadata.get('schema_version') !== DATABASE_SCHEMA_VERSION ||
      !['true', 'false'].includes(metadata.get('baseline_completed') ?? '')
    ) {
      throw new Error(
        'Invalid user state database; restore a backup before starting'
      )
    }
    const users: Record<string, UserState> = {}
    for (const row of database
      .prepare('SELECT user_id, state_json FROM users')
      .all() as { user_id: string; state_json: string }[]) {
      const state: unknown = JSON.parse(row.state_json)
      if (!isValidUserState(state) || state.userId !== row.user_id) {
        throw new Error(
          'Invalid user state database; restore a backup before starting'
        )
      }
      users[row.user_id] = state
    }
    const configs = new Map<string, PersistedConfig>()
    for (const row of database
      .prepare('SELECT config_id, config_json FROM configs')
      .all() as { config_id: string; config_json: string }[]) {
      const config: unknown = JSON.parse(row.config_json)
      if (
        !isPersistedConfig(config) ||
        getPersistedConfigId(config) !== row.config_id
      ) {
        throw new Error(
          'Invalid notification configuration; restore a backup before starting'
        )
      }
      configs.set(row.config_id, config)
    }
    const outbox = database
      .prepare(
        `SELECT id, user_id, display_name, effect_json, config_id, created_at,
                deliveries_json, error
         FROM outbox ORDER BY sequence`
      )
      .all() as {
      id: string
      user_id: string
      display_name: string
      effect_json: string
      config_id: string
      created_at: string
      deliveries_json: string | null
      error: string | null
    }[]
    const entries = outbox.map((row) => {
      const entry: Record<string, unknown> = {
        id: row.id,
        userId: row.user_id,
        displayName: row.display_name,
        effect: JSON.parse(row.effect_json),
        configId: row.config_id,
        config: configs.get(row.config_id),
        createdAt: row.created_at,
        deliveries:
          row.deliveries_json === null
            ? undefined
            : JSON.parse(row.deliveries_json),
        error: row.error ?? undefined,
      }
      if (!isEffect(entry, entry.config)) {
        throw new Error(
          'Invalid notification outbox; restore a backup before starting'
        )
      }
      return entry
    })
    return {
      schemaVersion: 3,
      baselineCompleted: metadata.get('baseline_completed') === 'true',
      users,
      outbox: entries,
      configRefCounts: countConfigs(entries),
    }
  }

  close(): void {
    try {
      if (this.database) {
        try {
          this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          this.database.close()
          this.database = undefined
        }
      }
    } finally {
      if (this.writerLock) {
        try {
          this.writerLock.exec('ROLLBACK')
        } finally {
          this.writerLock.close()
          this.writerLock = undefined
        }
      }
    }
  }

  get(userId: string): UserState | undefined {
    return this.data.users[userId]
  }

  getAll(): Record<string, UserState> {
    return this.data.users
  }

  isBaselineCompleted(): boolean {
    return this.data.baselineCompleted
  }

  getPendingEffects(): readonly PersistedEffect[] {
    return this.data.outbox
  }

  async commitUserState(
    userId: string,
    nextState: UserState,
    pending: PersistedEffect[] = []
  ): Promise<void> {
    await this.mutate(
      (data) => {
        const appended = this.appendEffects(data, pending)
        return {
          ...data,
          users: { ...data.users, [userId]: nextState },
          ...appended,
        }
      },
      (database) => {
        database
          .prepare(
            'INSERT INTO users (user_id, state_json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json'
          )
          .run(userId, JSON.stringify(nextState))
        for (const entry of pending) insertEffect(database, entry)
      }
    )
  }

  async deleteUser(
    userId: string,
    pending: PersistedEffect[] = []
  ): Promise<void> {
    await this.mutate(
      (data) => {
        const appended = this.appendEffects(data, pending)
        return {
          ...data,
          users: Object.fromEntries(
            Object.entries(data.users).filter(([id]) => id !== userId)
          ),
          ...appended,
        }
      },
      (database) => {
        database.prepare('DELETE FROM users WHERE user_id = ?').run(userId)
        for (const entry of pending) insertEffect(database, entry)
      }
    )
  }

  async setBaselineCompleted(): Promise<void> {
    await this.mutate(
      (data) => ({ ...data, baselineCompleted: true }),
      (database) => {
        database
          .prepare('UPDATE metadata SET value = ? WHERE key = ?')
          .run('true', 'baseline_completed')
      }
    )
  }

  async updatePendingEffect(entry: PersistedEffect): Promise<void> {
    await this.mutate(
      (data) => ({
        ...data,
        outbox: data.outbox.map((item) =>
          item.id === entry.id ? entry : item
        ),
      }),
      (database) => {
        const config = database
          .prepare('SELECT config_json FROM configs WHERE config_id = ?')
          .get(entry.configId) as { config_json: string } | undefined
        if (config?.config_json !== JSON.stringify(entry.config)) {
          throw new Error('Notification configuration snapshot is unavailable')
        }
        database
          .prepare(
            `UPDATE outbox SET display_name = ?, effect_json = ?, created_at = ?,
             deliveries_json = ?, error = ? WHERE id = ?`
          )
          .run(
            entry.displayName,
            JSON.stringify(entry.effect),
            entry.createdAt,
            entry.deliveries === undefined
              ? null
              : JSON.stringify(entry.deliveries),
            entry.error ?? null,
            entry.id
          )
      }
    )
  }

  async removePendingEffect(id: string): Promise<void> {
    await this.mutate(
      (data) => {
        const removed = data.outbox.find((item) => item.id === id)
        const configRefCounts = new Map(data.configRefCounts)
        if (removed) {
          const remaining = (configRefCounts.get(removed.configId) ?? 1) - 1
          if (remaining > 0) configRefCounts.set(removed.configId, remaining)
          else configRefCounts.delete(removed.configId)
        }
        return {
          ...data,
          outbox: data.outbox.filter((item) => item.id !== id),
          configRefCounts,
        }
      },
      (database) => {
        const row = database
          .prepare('SELECT config_id FROM outbox WHERE id = ?')
          .get(id) as { config_id: string } | undefined
        database.prepare('DELETE FROM outbox WHERE id = ?').run(id)
        if (row) {
          database
            .prepare(
              `DELETE FROM configs WHERE config_id = ?
               AND NOT EXISTS (SELECT 1 FROM outbox WHERE config_id = ?)`
            )
            .run(row.config_id, row.config_id)
        }
      }
    )
  }

  async flush(): Promise<void> {
    while (this.writing || this.scheduled || this.mutations.length > 0) {
      await new Promise<void>((resolve) => {
        this.flushWaiters.add(resolve)
      })
    }
  }

  private appendEffects(
    data: StoreData,
    pending: PersistedEffect[]
  ): Pick<StoreData, 'outbox' | 'configRefCounts'> {
    if (data.outbox.length + pending.length > MAX_PENDING_EFFECTS) {
      throw new Error('Notification outbox is full')
    }
    const configRefCounts = new Map(data.configRefCounts)
    for (const entry of pending) {
      configRefCounts.set(
        entry.configId,
        (configRefCounts.get(entry.configId) ?? 0) + 1
      )
    }
    if (configRefCounts.size > MAX_PENDING_CONFIG_SNAPSHOTS) {
      throw new Error(
        'Notification outbox has too many configuration snapshots'
      )
    }
    return {
      outbox: [...data.outbox, ...pending],
      configRefCounts,
    }
  }

  private async mutate(
    update: Mutation['update'],
    persist: Mutation['persist']
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.mutations.push({ update, persist, resolve, reject })
      if (this.writing || this.scheduled) return
      this.scheduled = true
      setImmediate(() => {
        this.scheduled = false
        try {
          this.writeBatch()
        } catch (error) {
          logger.error(
            'Unexpected repository write failure',
            error instanceof Error ? error : new Error(String(error))
          )
        }
      })
    })
  }

  private writeBatch(): void {
    this.writing = true
    try {
      while (this.mutations.length > 0) {
        const batch = this.mutations.splice(0)
        let nextData = this.data
        const accepted: Mutation[] = []
        for (const mutation of batch) {
          try {
            nextData = mutation.update(nextData)
            accepted.push(mutation)
          } catch (error) {
            mutation.reject(error)
          }
        }
        if (accepted.length === 0) continue
        const database = this.database
        if (!database) {
          const error = new Error('User state database is not open')
          for (const mutation of accepted) mutation.reject(error)
          continue
        }
        try {
          database.exec('BEGIN IMMEDIATE')
          for (const mutation of accepted) mutation.persist(database)
          database.exec('COMMIT')
          this.data = nextData
          for (const mutation of accepted) mutation.resolve()
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // The database can already have rolled back after an I/O failure.
          }
          for (const mutation of accepted) mutation.reject(error)
        }
      }
    } finally {
      this.writing = false
      for (const resolve of this.flushWaiters) resolve()
      this.flushWaiters.clear()
    }
  }
}
