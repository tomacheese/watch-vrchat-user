import { Logger } from '@book000/node-utils'
import { isTraveling } from '../state/location'
import type { UserStateCoordinator } from '../state/user-state-coordinator'

const logger = Logger.configure('PIPELINE-EVENT-ROUTER')

/** Pipeline の business event を発火する EventEmitter が満たすべき最小インターフェース */
export interface PipelineEventEmitterLike {
  on: (event: string, listener: (data: unknown) => void) => void
  removeAllListeners: (event: string) => void
}

/** Pipeline の `friend-location` イベントのペイロード */
interface FriendLocationEvent {
  userId: string
  user: { id: string; displayName: string }
  location: string
}

/** Pipeline の `friend-online` イベントのペイロード */
interface FriendOnlineEvent {
  userId: string
  user: { id: string; displayName: string }
  /** 任意。有効な値の場合のみ online observation に載せる */
  location?: unknown
}

/** Pipeline の `friend-add` イベントのペイロード（形は想定であり実機未確認） */
interface FriendAddEvent {
  userId: string
  user: { id: string; displayName: string }
}

/** Pipeline の `friend-delete` イベントのペイロード（形は想定であり実機未確認） */
interface FriendDeleteEvent {
  userId: string
}

/** Pipeline の `friend-offline` イベントのペイロード */
interface FriendOfflineEvent {
  userId: string
}

/**
 * イベントデータが FriendLocationEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendLocationEvent(data: unknown): data is FriendLocationEvent {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.userId !== 'string' || typeof obj.location !== 'string')
    return false
  if (typeof obj.user !== 'object' || obj.user === null) return false
  const user = obj.user as Record<string, unknown>
  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * イベントデータが FriendOnlineEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendOnlineEvent(data: unknown): data is FriendOnlineEvent {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.userId !== 'string') return false
  if (typeof obj.user !== 'object' || obj.user === null) return false
  const user = obj.user as Record<string, unknown>
  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * friend-online の location が online observation に載せられる有効値かを判定する
 *
 * @param location ペイロードの location
 * @returns 有効な Location 文字列の場合は true
 */
function isUsableLocation(location: unknown): location is string {
  return (
    typeof location === 'string' &&
    location !== '' &&
    location !== 'offline' &&
    !isTraveling(location)
  )
}

/**
 * イベントデータが FriendOfflineEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendOfflineEvent(data: unknown): data is FriendOfflineEvent {
  return typeof data !== 'object' || data === null
    ? false
    : typeof (data as Record<string, unknown>).userId === 'string'
}

/**
 * イベントデータが FriendAddEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendAddEvent(data: unknown): data is FriendAddEvent {
  // friend-online と同じ形（userId + user.id + user.displayName）を要求する
  return isFriendOnlineEvent(data)
}

/**
 * イベントデータが FriendDeleteEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendDeleteEvent(data: unknown): data is FriendDeleteEvent {
  return isFriendOfflineEvent(data)
}

/**
 * Pipeline の business event を UserObservation に正規化し Coordinator へ enqueue するクラス
 *
 * liveness 判定は担当しない（raw message 全体は PipelineTransportAdapter が扱う）。
 */
export class PipelineEventRouter {
  /**
   * PipelineEventRouter を初期化する
   *
   * @param coordinator observation の enqueue 先
   */
  constructor(private readonly coordinator: UserStateCoordinator) {}

  /**
   * Pipeline の EventEmitter へ business event listener を登録する
   *
   * @param pipeline VRChat SDK の pipeline EventEmitter
   */
  attach(pipeline: PipelineEventEmitterLike): void {
    pipeline.removeAllListeners('friend-location')
    pipeline.removeAllListeners('friend-online')
    pipeline.removeAllListeners('friend-offline')
    pipeline.removeAllListeners('friend-add')
    pipeline.removeAllListeners('friend-delete')

    pipeline.on('friend-location', (data: unknown) => {
      if (!isFriendLocationEvent(data)) {
        logger.error('Invalid friend-location event data')
        logger.debug('Invalid friend-location event data (raw)', { data })
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'location',
        location: data.location,
      })
    })

    pipeline.on('friend-online', (data: unknown) => {
      if (!isFriendOnlineEvent(data)) {
        logger.error('Invalid friend-online event data')
        logger.debug('Invalid friend-online event data (raw)', { data })
        return
      }
      this.coordinator.enqueue(
        data.userId,
        data.user.displayName,
        isUsableLocation(data.location)
          ? { type: 'online', location: data.location }
          : { type: 'online' }
      )
    })

    pipeline.on('friend-offline', (data: unknown) => {
      if (!isFriendOfflineEvent(data)) {
        logger.error('Invalid friend-offline event data')
        logger.debug('Invalid friend-offline event data (raw)', { data })
        return
      }
      // displayName は Coordinator.enqueue 側で Repository の既存値から補完する
      this.coordinator.enqueue(data.userId, data.userId, { type: 'offline' })
    })

    pipeline.on('friend-add', (data: unknown) => {
      if (!isFriendAddEvent(data)) {
        logger.error('Invalid friend-add event data')
        logger.debug('Invalid friend-add event data (raw)', { data })
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'friend-add',
      })
    })

    pipeline.on('friend-delete', (data: unknown) => {
      if (!isFriendDeleteEvent(data)) {
        logger.error('Invalid friend-delete event data')
        logger.debug('Invalid friend-delete event data (raw)', { data })
        return
      }
      // displayName は Coordinator.enqueue 側で Repository の既存値から補完する
      this.coordinator.enqueue(data.userId, data.userId, {
        type: 'friend-delete',
      })
    })
  }
}
