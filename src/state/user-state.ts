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

/** 永続ストアのデータ構造（schemaVersion 3） */
export interface UserStateStoreData {
  /** スキーマバージョン */
  schemaVersion: 3
  /** 初回 baseline 構築が完了したか */
  baselineCompleted: boolean
  /** ユーザー ID をキーとした state のマップ */
  users: Record<string, UserState>
}

/** ワールド間移動中の transient な Location 値。永続化・通知の対象外 */
export const TRAVELING_LOCATION = 'traveling'

/**
 * 値が 1 件分の UserState として有効かを検証する
 *
 * 壊れた・手編集された永続ファイルから `undefined` 等の不正値が
 * `location`/`presence` に紛れ込むと、reducer の `=== null` 判定をすり抜けて
 * 誤った通知を発火しうるため、個々のレコードの形を検証する。
 *
 * @param value 検証する値
 * @returns 有効な場合は true
 */
function isValidUserState(value: unknown): value is UserState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const obj = value as Record<string, unknown>
  return (
    typeof obj.userId === 'string' &&
    typeof obj.displayName === 'string' &&
    (obj.presence === 'online' || obj.presence === 'offline') &&
    (obj.location === null || typeof obj.location === 'string') &&
    typeof obj.updatedAt === 'string'
  )
}

/**
 * データが schemaVersion 3 の UserStateStoreData として有効かを検証する
 *
 * 旧形式・不正な形式は false になり、呼び出し側は空データで起動する。
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
    obj.schemaVersion === 3 &&
    typeof obj.baselineCompleted === 'boolean' &&
    typeof obj.users === 'object' &&
    obj.users !== null &&
    Object.values(obj.users).every((user) => isValidUserState(user))
  )
}
