/**
 * ユーザーの Location 状態を管理するモジュール
 */

import * as fs from 'node:fs'
import path from 'node:path'

/** Location データファイルのパス */
const LOCATION_FILE_PATH = 'data/user-locations.json'

/** 保存の debounce 時間（ミリ秒） */
const SAVE_DEBOUNCE_MS = 1000

/**
 * ユーザーの Location 情報
 */
export interface UserLocation {
  /** ユーザー ID */
  userId: string
  /** ユーザーの表示名 */
  displayName: string
  /** 現在の Location */
  location: string | null
  /** 最終更新日時（ISO 8601 形式） */
  updatedAt: string
}

/**
 * Location ストアのデータ構造
 */
interface LocationStoreData {
  /** ユーザー ID をキーとした Location 情報のマップ */
  users: Record<string, UserLocation>
}

/**
 * Location の変更結果
 */
export interface LocationChangeResult {
  /** Location が変更されたかどうか */
  changed: boolean
  /** 前回の Location */
  previousLocation: string | null
  /** 現在の Location */
  currentLocation: string | null
}

/**
 * ユーザーの Location 状態を管理するクラス
 */
export class LocationStore {
  private data: LocationStoreData = { users: {} }
  private saveTimeout: NodeJS.Timeout | null = null

  /**
   * LocationStore を初期化する
   * ファイルから既存データを読み込む
   */
  constructor() {
    this.load()
  }

  /**
   * ファイルからデータを読み込む
   */
  private load(): void {
    try {
      // ディレクトリが存在しない場合は作成
      const directory = path.dirname(LOCATION_FILE_PATH)
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true })
      }

      if (fs.existsSync(LOCATION_FILE_PATH)) {
        const content = fs.readFileSync(LOCATION_FILE_PATH, 'utf8')
        this.data = JSON.parse(content) as LocationStoreData
        console.log(
          `[LOCATION-STORE] Loaded ${Object.keys(this.data.users).length} user(s) from file`
        )
      }
    } catch (error) {
      console.error('[LOCATION-STORE] Failed to load data:', error)
      this.data = { users: {} }
    }
  }

  /**
   * データをファイルに保存する（debounce 付き）
   */
  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => {
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 即座にデータをファイルに保存する
   */
  private saveNow(): void {
    try {
      const directory = path.dirname(LOCATION_FILE_PATH)
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true })
      }

      fs.writeFileSync(LOCATION_FILE_PATH, JSON.stringify(this.data, null, 2))
    } catch (error) {
      console.error('[LOCATION-STORE] Failed to save data:', error)
    }
  }

  /**
   * ユーザーの Location を更新する
   *
   * @param userId ユーザー ID
   * @param displayName ユーザーの表示名
   * @param location 新しい Location
   * @returns Location の変更結果
   */
  updateLocation(
    userId: string,
    displayName: string,
    location: string | null
  ): LocationChangeResult {
    const previousData = this.data.users[userId] as UserLocation | undefined
    const previousLocation = previousData?.location ?? null

    // Location が変更されていない場合は何もしない
    if (previousLocation === location) {
      return {
        changed: false,
        previousLocation,
        currentLocation: location,
      }
    }

    // Location を更新
    this.data.users[userId] = {
      userId,
      displayName,
      location,
      updatedAt: new Date().toISOString(),
    }

    this.scheduleSave()

    return {
      changed: true,
      previousLocation,
      currentLocation: location,
    }
  }

  /**
   * ユーザーの初期 Location を設定する（通知なし）
   * 起動時に現在の状態を保存するために使用
   *
   * @param userId ユーザー ID
   * @param displayName ユーザーの表示名
   * @param location 現在の Location
   */
  setInitialLocation(
    userId: string,
    displayName: string,
    location: string | null
  ): void {
    this.data.users[userId] = {
      userId,
      displayName,
      location,
      updatedAt: new Date().toISOString(),
    }

    this.scheduleSave()
  }

  /**
   * ユーザーの Location を取得する
   *
   * @param userId ユーザー ID
   * @returns Location 情報、存在しない場合は undefined
   */
  getLocation(userId: string): UserLocation | undefined {
    return this.data.users[userId]
  }

  /**
   * ユーザーの表示名を取得する
   * オフライン通知時に displayName を取得するために使用
   *
   * @param userId ユーザー ID
   * @returns 表示名、存在しない場合は undefined
   */
  getDisplayName(userId: string): string | undefined {
    const userData = this.data.users[userId] as UserLocation | undefined
    return userData?.displayName
  }

  /**
   * ユーザーの表示名を更新する
   *
   * @param userId ユーザー ID
   * @param displayName 新しい表示名
   */
  updateDisplayName(userId: string, displayName: string): void {
    const userData = this.data.users[userId] as UserLocation | undefined
    if (userData) {
      userData.displayName = displayName
      this.scheduleSave()
    }
  }

  /**
   * 終了時に未保存のデータを保存する
   */
  flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    this.saveNow()
  }
}
