import { Logger } from '@book000/node-utils'
import fs from 'node:fs'
import { compileRules } from '../rules/rule-engine'
import { toError } from '../logger-utils'
import { parseConfigFile } from './config-file'
import type { ConfigSnapshot } from './config-snapshot'

const logger = Logger.configure('ConfigManager')

/** ConfigManager のオプション */
export interface ConfigManagerOptions {
  /** 設定ファイルのパス */
  configPath: string
  /** `${ENV_VAR}` 展開に使う環境変数 */
  env: NodeJS.ProcessEnv
  /** watchFile のポーリング間隔（ミリ秒） */
  pollIntervalMs?: number
  /** 変更検知後、書き込みが落ち着くまで待つ時間（ミリ秒） */
  stableMs?: number
  /** 現在時刻の取得関数 */
  now?: () => Date
}

/** health 用の設定状態 */
export interface ConfigStatus {
  /** 現在有効な設定の読み込み日時 */
  loadedAt: string | null
  /** 直近の reload 失敗メッセージ（成功で解消される） */
  lastReloadError: string | null
  /** 直近の reload 失敗日時 */
  lastReloadFailedAt: string | null
}

/**
 * 設定ファイルの読み込みと hot reload を担う
 *
 * reload に失敗した場合は last-known-good のスナップショットを維持する。
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
  private watching = false

  /**
   * ConfigManager を初期化する
   *
   * @param options 設定ファイルのパス・環境変数・ポーリング間隔など
   */
  constructor(options: ConfigManagerOptions) {
    this.configPath = options.configPath
    this.env = options.env
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.stableMs = options.stableMs ?? 500
    this.now = options.now ?? (() => new Date())
  }

  /**
   * 設定を読み込み、ファイル監視を開始する。失敗時は throw する
   *
   * @throws 設定ファイルの読み込み・検証・compile に失敗した場合
   */
  load(): void {
    this.snapshot = this.readSnapshot()
    if (this.watching) return
    this.watching = true
    fs.watchFile(
      this.configPath,
      { interval: this.pollIntervalMs },
      (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
        this.scheduleReload()
      }
    )
  }

  /**
   * 現在有効な設定スナップショットを返す
   *
   * @returns スナップショット
   * @throws `load()` 前に呼んだ場合
   */
  getSnapshot(): ConfigSnapshot {
    if (this.snapshot === undefined) {
      throw new Error('Config has not been loaded')
    }
    return this.snapshot
  }

  /**
   * health 用の設定状態を返す
   *
   * @returns 設定状態
   */
  getStatus(): ConfigStatus {
    return {
      loadedAt: this.snapshot?.loadedAt ?? null,
      lastReloadError: this.lastReloadError,
      lastReloadFailedAt: this.lastReloadFailedAt,
    }
  }

  /**
   * ファイル監視と保留中の reload を停止する
   */
  stop(): void {
    fs.unwatchFile(this.configPath)
    this.watching = false
    if (this.stableTimer === undefined) return
    clearTimeout(this.stableTimer)
    this.stableTimer = undefined
  }

  /**
   * 設定ファイルから不変スナップショットを作る
   *
   * @returns スナップショット
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
   * 書き込みが落ち着くのを待ってから reload を予約する
   */
  private scheduleReload(): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined
      this.reload()
    }, this.stableMs)
  }

  /**
   * 再読込する。失敗時は last-known-good を維持して状態に記録する
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
      // 同一内容の連続ログは抑止する
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
