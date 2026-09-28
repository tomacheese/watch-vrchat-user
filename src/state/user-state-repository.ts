import { Logger } from '@book000/node-utils'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import path from 'node:path'
import { toError } from '../logger-utils'
import {
  isUserStateStoreData,
  type UserState,
  type UserStateStoreData,
} from './user-state'

const logger = Logger.configure('USER-STATE-REPOSITORY')

/** state データファイルの既定パス（環境変数が未設定の場合） */
const FALLBACK_FILE_PATH = 'data/friend-states.json'

/** 空のストアデータを生成する */
function emptyData(): UserStateStoreData {
  return { schemaVersion: 3, baselineCompleted: false, users: {} }
}

/**
 * `friend-states.json` への store-wide lock 付き atomic な読み書きを担うクラス
 *
 * 単一ファイルへの書き込みを直列化することで、複数ユーザーの状態を並行更新しても
 * lost update を起こさない。
 */
export class UserStateRepository {
  private data: UserStateStoreData = emptyData()
  private readonly filePath: string
  private mutex: Promise<unknown> = Promise.resolve()

  /**
   * UserStateRepository を初期化する
   *
   * @param filePath ストアファイルのパス（省略時は環境変数 `STATE_FILE_PATH` または既定値）
   */
  constructor(filePath?: string) {
    // 環境変数はコンストラクタ呼び出し時に読む（モジュール読み込み時に固定すると、
    // テストごとに `STATE_FILE_PATH` を差し替えても反映されない）
    this.filePath =
      filePath ?? process.env.STATE_FILE_PATH ?? FALLBACK_FILE_PATH
  }

  /**
   * ファイルから既存データを読み込む
   *
   * 旧形式・不正な形式のファイルは空データとして扱う。
   */
  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return
      }
      const content = fs.readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      this.data = isUserStateStoreData(parsed) ? parsed : emptyData()
    } catch (error) {
      logger.error(
        'Failed to load user state, starting with empty data',
        toError(error)
      )
      this.data = emptyData()
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
   * 初回 baseline 構築が完了しているかを返す
   *
   * @returns 完了している場合は true
   */
  isBaselineCompleted(): boolean {
    return this.data.baselineCompleted
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
    return this.mutate((data) => ({
      ...data,
      users: { ...data.users, [userId]: nextState },
    }))
  }

  /**
   * 指定ユーザーの state をメモリとファイルの両方から atomic に削除する
   *
   * @param userId ユーザー ID
   */
  async deleteUser(userId: string): Promise<void> {
    return this.mutate((data) => {
      const users = Object.fromEntries(
        Object.entries(data.users).filter(([id]) => id !== userId)
      )
      return { ...data, users }
    })
  }

  /**
   * baseline 構築の完了を atomic に永続化する
   */
  async setBaselineCompleted(): Promise<void> {
    return this.mutate((data) => ({ ...data, baselineCompleted: true }))
  }

  /**
   * store lock 下で最新データから次のデータを計算し、ファイルへ書き込む
   *
   * @param update 現在のデータから次のデータを返す関数
   */
  private async mutate(
    update: (data: UserStateStoreData) => UserStateStoreData
  ): Promise<void> {
    const run = this.mutex.then(() => this.writeLocked(update))
    // 直前の書き込みが失敗しても後続がロックを引き継げるよう、
    // mutex チェーン自体は常に resolve させる
    this.mutex = run.catch(() => undefined)
    return run
  }

  /**
   * ロックを取得済みの状態でデータを書き込む
   *
   * @param update 現在のデータから次のデータを返す関数
   */
  private async writeLocked(
    update: (data: UserStateStoreData) => UserStateStoreData
  ): Promise<void> {
    // 書き込みが失敗した場合に `this.data` が新データのまま残ると、呼び出し側の
    // retry が「既に反映済み」と誤認して no-op になり通知を失う。そのため
    // in-memory 反映は write + rename が成功した後に行う。
    const nextData = update(this.data)
    const tmpPath = `${this.filePath}.tmp`
    const directory = path.dirname(this.filePath)
    await fsPromises.mkdir(directory, { recursive: true })
    await fsPromises.writeFile(tmpPath, JSON.stringify(nextData, null, 2))
    await fsPromises.rename(tmpPath, this.filePath)
    this.data = nextData
  }
}
