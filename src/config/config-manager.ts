import { Logger } from '@book000/node-utils'
import fs from 'node:fs'
import { compileRules } from '../rules/rule-engine'
import { toError } from '../logger-utils'
import { parseConfigFile } from './config-file'
import type { ConfigSnapshot } from './config-snapshot'

const logger = Logger.configure('ConfigManager')

/** Options for ConfigManager */
export interface ConfigManagerOptions {
  /** Path to the config file */
  configPath: string
  /** Environment variables used for `${ENV_VAR}` expansion */
  env: NodeJS.ProcessEnv
  /** Polling interval for watchFile (milliseconds) */
  pollIntervalMs?: number
  /** Time to wait after a change is detected until writes settle (milliseconds) */
  stableMs?: number
  /** Function returning the current time */
  now?: () => Date
}

/** Config status for health */
export interface ConfigStatus {
  /** Load time of the config currently in effect */
  loadedAt: string | null
  /** Message of the latest reload failure (cleared on success) */
  lastReloadError: string | null
  /** Time of the latest reload failure */
  lastReloadFailedAt: string | null
}

/**
 * Handles loading the config file and hot reload
 *
 * On reload failure, the last-known-good snapshot is kept.
 */
export class ConfigManager {
  private readonly configPath: string
  private readonly env: NodeJS.ProcessEnv
  private readonly pollIntervalMs: number
  private readonly stableMs: number
  private readonly now: () => Date

  private snapshot: ConfigSnapshot | undefined
  private lastReloadError: string | null = null
  private lastReloadFailedAt: string | null = null
  private stableTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private knownStat: { mtimeMs: number; size: number } | undefined

  /**
   * Initializes the ConfigManager
   *
   * @param options Config file path, environment variables, polling interval, etc.
   */
  constructor(options: ConfigManagerOptions) {
    this.configPath = options.configPath
    this.env = options.env
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.stableMs = options.stableMs ?? 500
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Loads the config and starts watching the file. Throws on failure
   *
   * @throws If reading, validating or compiling the config file fails
   */
  load(): void {
    // Take the stat before reading; a write during the read is caught by the next poll
    const { mtimeMs, size } = fs.statSync(this.configPath)
    this.snapshot = this.readSnapshot()
    this.knownStat = { mtimeMs, size }
    if (this.pollTimer !== undefined) return
    // fs.watchFile takes its baseline stat asynchronously, so a write right after
    // load() would be missed. Compare directly against the stat taken at load time
    this.pollTimer = setInterval(() => {
      this.poll()
    }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  /**
   * Returns the config snapshot currently in effect
   *
   * @returns The snapshot
   * @throws If called before `load()`
   */
  getSnapshot(): ConfigSnapshot {
    if (this.snapshot === undefined) {
      throw new Error('Config has not been loaded')
    }
    return this.snapshot
  }

  /**
   * Returns the config status for health
   *
   * @returns Config status
   */
  getStatus(): ConfigStatus {
    return {
      loadedAt: this.snapshot?.loadedAt ?? null,
      lastReloadError: this.lastReloadError,
      lastReloadFailedAt: this.lastReloadFailedAt,
    }
  }

  /**
   * Stops the file watcher and any pending reload
   */
  stop(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.stableTimer === undefined) return
    clearTimeout(this.stableTimer)
    this.stableTimer = undefined
  }

  /**
   * Builds an immutable snapshot from the config file
   *
   * @returns The snapshot
   */
  private readSnapshot(): ConfigSnapshot {
    const text = fs.readFileSync(this.configPath, 'utf8')
    const parsed = parseConfigFile(text, this.env)
    const rules = compileRules(parsed.rules)
    return Object.freeze({
      destinations: Object.freeze({ ...parsed.destinations }),
      rules: Object.freeze(rules),
      loadedAt: this.now().toISOString(),
    })
  }

  /**
   * Schedules a reload if the config file mtime / size changed since it was loaded
   */
  private poll(): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.configPath)
    } catch {
      // Defer to the next poll when the file is temporarily unreadable (e.g. being replaced)
      return
    }
    if (
      stat.mtimeMs === this.knownStat?.mtimeMs &&
      stat.size === this.knownStat.size
    ) {
      return
    }
    this.knownStat = { mtimeMs: stat.mtimeMs, size: stat.size }
    this.scheduleReload()
  }

  /**
   * Schedules a reload after writes settle
   */
  private scheduleReload(): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined
      this.reload()
    }, this.stableMs)
  }

  /**
   * Reloads. On failure, keeps the last-known-good snapshot and records the failure
   */
  private reload(): void {
    try {
      this.snapshot = this.readSnapshot()
      if (this.lastReloadError !== null) {
        logger.info('Config reload recovered')
      }
      this.lastReloadError = null
      this.lastReloadFailedAt = null
      logger.info('Config reloaded')
    } catch (error) {
      const message = toError(error).message
      // Suppress consecutive identical logs
      if (message !== this.lastReloadError) {
        logger.error(
          'Config reload failed; keeping last known good config',
          toError(error)
        )
      }
      this.lastReloadError = message
      this.lastReloadFailedAt = this.now().toISOString()
    }
  }
}
