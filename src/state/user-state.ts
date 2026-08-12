/** ユーザーの在席状態 */
export type Presence = 'online' | 'offline'

/** ユーザーの永続 state */
export interface UserState {
  /** ユーザー ID */
  userId: string
  /** ユーザーの表示名 */
  displayName: string
  /** 在席状態 */
  presence: Presence
  /** 最後に確定した実 Location（未確定または offline の場合は null） */
  location: string | null
  /** 最終更新日時（ISO 8601 形式） */
  updatedAt: string
}

/** 永続ストアのデータ構造（schemaVersion 2） */
export interface UserStateStoreData {
  /** スキーマバージョン */
  schemaVersion: 2
  /** ユーザー ID をキーとした state のマップ */
  users: Record<string, UserState>
}

/** ワールド間移動中の transient な Location 値。永続化・通知の対象外 */
export const TRAVELING_LOCATION = 'traveling'

/** 旧実装が online 遷移時に location へ書き込んでいた sentinel 値 */
export const ONLINE_SENTINEL = 'online'

/**
 * データが schemaVersion 2 の UserStateStoreData として有効かを検証する
 *
 * @param raw 検証するデータ
 * @returns 有効な場合は true
 */
export function isUserStateStoreData(raw: unknown): raw is UserStateStoreData {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }
  const obj = raw as Record<string, unknown>
  return (
    obj.schemaVersion === 2 &&
    typeof obj.users === 'object' &&
    obj.users !== null
  )
}

/** legacy (schemaVersion なし) 形式のユーザーレコード */
interface LegacyUserLocation {
  userId: string
  displayName: string
  location: string | null
  updatedAt: string
}

/**
 * 1 件の legacy レコードを UserState に migrate する
 *
 * @param legacy migrate 対象の legacy レコード
 * @returns migrate された UserState
 */
function migrateLegacyUser(legacy: LegacyUserLocation): UserState {
  if (legacy.location === ONLINE_SENTINEL) {
    return {
      userId: legacy.userId,
      displayName: legacy.displayName,
      presence: 'online',
      location: null,
      updatedAt: legacy.updatedAt,
    }
  }

  return {
    userId: legacy.userId,
    displayName: legacy.displayName,
    presence: legacy.location === null ? 'offline' : 'online',
    location: legacy.location,
    updatedAt: legacy.updatedAt,
  }
}

/**
 * 永続ストアのデータを schemaVersion 2 に migrate する
 *
 * 既に新形式の場合はそのまま返す。不正な形式の場合は空データを返す。
 *
 * @param raw ファイルから読み込んだ生データ
 * @returns schemaVersion 2 のストアデータ
 */
export function migrateStoreData(raw: unknown): UserStateStoreData {
  if (isUserStateStoreData(raw)) {
    return raw
  }

  if (typeof raw !== 'object' || raw === null || !('users' in raw)) {
    return { schemaVersion: 2, users: {} }
  }

  const legacyUsers = (raw as { users: unknown }).users
  if (typeof legacyUsers !== 'object' || legacyUsers === null) {
    return { schemaVersion: 2, users: {} }
  }

  const users: Record<string, UserState> = {}
  for (const [userId, legacy] of Object.entries(
    legacyUsers as Record<string, LegacyUserLocation>
  )) {
    users[userId] = migrateLegacyUser(legacy)
  }

  return { schemaVersion: 2, users }
}
