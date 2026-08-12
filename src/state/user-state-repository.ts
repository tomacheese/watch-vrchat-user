import { Logger } from '@book000/node-utils'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import path from 'node:path'
import { toError } from '../logger-utils'
import {
  migrateStoreData,
  type UserState,
  type UserStateStoreData,
} from './user-state'

const logger = Logger.configure('USER-STATE-REPOSITORY')

/** ユーザー state データファイルの既定パス（環境変数が未設定の場合） */
const FALLBACK_FILE_PATH = 'data/user-locations.json'

/**
 * `user-locations.json` への store-wide lock 付き atomic な読み書きを担うクラス
 *
 * 単一ファイルへの書き込みを直列化することで、複数ユーザーの状態を並行更新しても
 * lost update を起こさない。
 */
export class UserStateRepository {
  private data: UserStateStoreData = { schemaVersion: 2, users: {} }
  private readonly filePath: string
  private mutex: Promise<unknown> = Promise.resolve()

  /**
   * UserStateRepository を初期化する
   *
   * @param filePath ストアファイルのパス（省略時は環境変数 `LOCATION_FILE_PATH` または既定値）
   */
  constructor(filePath?: string) {
    // 環境変数はコンストラクタ呼び出し時に読む（モジュール読み込み時に固定すると、
    // テストごとに `LOCATION_FILE_PATH` を差し替えても反映されない）
    this.filePath =
      filePath ?? process.env.LOCATION_FILE_PATH ?? FALLBACK_FILE_PATH
  }

  /**
   * ファイルから既存データを読み込み、必要であれば migrate する
   */
  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return
      }
      const content = fs.readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      this.data = migrateStoreData(parsed)
    } catch (error) {
      logger.error(
        'Failed to load user state, starting with empty data',
        toError(error)
      )
      this.data = { schemaVersion: 2, users: {} }
    }
  }

  /**
   * 指定ユーザーの現在の state を取得する
   *
   * @param userId ユーザー ID
   * @returns state、存在しない場合は undefined
   */
  get(userId: string): UserState | undefined {
    return this.data.users[userId]
  }

  /**
   * 全ユーザーの state を取得する
   *
   * @returns ユーザー ID をキーとした state のマップ
   */
  getAll(): Record<string, UserState> {
    return this.data.users
  }

  /**
   * 指定ユーザーの state をメモリとファイルの両方へ atomic に反映する
   *
   * ファイル全体への書き込みは store-wide lock で直列化される。
   *
   * @param userId ユーザー ID
   * @param nextState 反映する state
   */
  async commitUserState(userId: string, nextState: UserState): Promise<void> {
    const run = this.mutex.then(() => this.writeLocked(userId, nextState))
    // 直前の commit が失敗しても後続の commit がロックを引き継げるよう、
    // mutex チェーン自体は常に resolve させる
    this.mutex = run.catch(() => undefined)
    return run
  }

  /**
   * ロックを取得済みの状態で 1 ユーザー分の state を書き込む
   *
   * @param userId ユーザー ID
   * @param nextState 反映する state
   */
  private async writeLocked(
    userId: string,
    nextState: UserState
  ): Promise<void> {
    this.data.users[userId] = nextState
    const tmpPath = `${this.filePath}.tmp`
    const directory = path.dirname(this.filePath)
    await fsPromises.mkdir(directory, { recursive: true })
    await fsPromises.writeFile(tmpPath, JSON.stringify(this.data, null, 2))
    await fsPromises.rename(tmpPath, this.filePath)
  }
}
