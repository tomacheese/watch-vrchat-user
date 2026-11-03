/** User presence */
export type Presence = 'online' | 'offline'

/** User status and status message */
export interface Profile {
  /** Status (`join me` / `active` / `ask me` / `busy`) */
  status: string
  /** Status message */
  statusDescription: string
}

/** Persisted per-user state */
export interface UserState {
  /** User ID */
  userId: string
  /** User display name */
  displayName: string
  /** Presence */
  presence: Presence
  /** Last confirmed real Location (null when unconfirmed or offline) */
  location: string | null
  /** True if the first confirmed Location after going online still needs to be notified */
  firstLocationPending?: boolean
  /** Last confirmed status (undefined when unconfirmed; `offline` is never recorded) */
  status?: string
  /** Last confirmed status message (undefined when unconfirmed) */
  statusDescription?: string
  /** Last update time (ISO 8601) */
  updatedAt: string
}

/** Persisted store data structure (schemaVersion 3) */
export interface UserStateStoreData {
  /** Schema version */
  schemaVersion: 3
  /** Whether the initial baseline has completed */
  baselineCompleted: boolean
  /** Map of state keyed by user ID */
  users: Record<string, UserState>
}

/** Transient Location value while moving between worlds. Not persisted or notified */
export const TRAVELING_LOCATION = 'traveling'

/**
 * Validates that a value is a valid single UserState
 *
 * If an invalid value such as `undefined` slips into `location`/`presence` from a corrupted or
 * hand-edited persisted file, it bypasses the reducer's `=== null` checks and
 * can trigger wrong notifications, so the shape of each record is validated.
 *
 * @param value Value to validate
 * @returns true if valid
 */
export function isValidUserState(value: unknown): value is UserState {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const obj = value as Record<string, unknown>
  return (
    typeof obj.userId === 'string' &&
    typeof obj.displayName === 'string' &&
    (obj.presence === 'online' || obj.presence === 'offline') &&
    (obj.location === null || typeof obj.location === 'string') &&
    (obj.firstLocationPending === undefined ||
      typeof obj.firstLocationPending === 'boolean') &&
    (obj.firstLocationPending !== true ||
      (obj.presence === 'online' && obj.location === null)) &&
    (obj.status === undefined || typeof obj.status === 'string') &&
    (obj.statusDescription === undefined ||
      typeof obj.statusDescription === 'string') &&
    typeof obj.updatedAt === 'string'
  )
}

/**
 * Validates that data is a valid schemaVersion 3 UserStateStoreData
 *
 * Legacy or malformed data yields false; the repository then refuses to start rather than overwrite it.
 *
 * @param raw Data to validate
 * @returns true if valid
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
    !Array.isArray(obj.users) &&
    Object.values(obj.users).every((user) => isValidUserState(user))
  )
}
