import { Logger } from '@book000/node-utils'
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
 * イベントデータが FriendOfflineEvent として有効かを検証する
 *
 * @param data 検証するデータ
 * @returns 有効な場合は true
 */
function isFriendOfflineEvent(data: unknown): data is FriendOfflineEvent {
  if (typeof data !== 'object' || data === null) return false
  return typeof (data as Record<string, unknown>).userId === 'string'
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
   * @param targetUserIds 監視対象のユーザー ID 一覧
   * @param coordinator observation の enqueue 先
   */
  constructor(
    private readonly targetUserIds: string[],
    private readonly coordinator: UserStateCoordinator
  ) {}

  /**
   * Pipeline の EventEmitter へ business event listener を登録する
   *
   * @param pipeline VRChat SDK の pipeline EventEmitter
   */
  attach(pipeline: PipelineEventEmitterLike): void {
    pipeline.removeAllListeners('friend-location')
    pipeline.removeAllListeners('friend-online')
    pipeline.removeAllListeners('friend-offline')

    pipeline.on('friend-location', (data: unknown) => {
      if (!isFriendLocationEvent(data)) {
        logger.error('Invalid friend-location event data')
        logger.debug('Invalid friend-location event data (raw)', { data })
        return
      }
      if (!this.targetUserIds.includes(data.userId)) return
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
      if (!this.targetUserIds.includes(data.userId)) return
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'online',
      })
    })

    pipeline.on('friend-offline', (data: unknown) => {
      if (!isFriendOfflineEvent(data)) {
        logger.error('Invalid friend-offline event data')
        logger.debug('Invalid friend-offline event data (raw)', { data })
        return
      }
      if (!this.targetUserIds.includes(data.userId)) return
      // displayName は Coordinator.enqueue 側で Repository の既存値から補完する
      this.coordinator.enqueue(data.userId, data.userId, { type: 'offline' })
    })
  }
}
