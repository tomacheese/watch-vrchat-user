import { Logger } from '@book000/node-utils'
import { isTraveling } from '../state/location'
import type { Profile } from '../state/user-state'
import type { UserStateCoordinator } from '../state/user-state-coordinator'

const logger = Logger.configure('PIPELINE-EVENT-ROUTER')

/** Pipeline の business event を発火する EventEmitter が満たすべき最小インターフェース */
export interface PipelineEventEmitterLike {
  on: (event: string, listener: (data: unknown) => void) => void
  removeAllListeners: (event: string) => void
  removeListener?: (event: string, listener: (data: unknown) => void) => void
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
 * ペイロードの user からステータスとステータスメッセージを取り出す
 *
 * @param user ペイロードの user オブジェクト
 * @returns 両方が文字列の場合のみ Profile、それ以外は undefined
 */
function extractProfile(user: unknown): Profile | undefined {
  if (typeof user !== 'object' || user === null) return undefined
  const { status, statusDescription } = user as Record<string, unknown>
  return typeof status === 'string' && typeof statusDescription === 'string'
    ? { status, statusDescription }
    : undefined
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
  private pipeline: PipelineEventEmitterLike | undefined
  private readonly listeners = new Map<string, (data: unknown) => void>()
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
    this.detach()
    this.pipeline = pipeline

    this.listen('friend-location', (data: unknown) => {
      if (!isFriendLocationEvent(data)) {
        logger.error('Invalid friend-location event data')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'location',
        location: data.location,
        profile: extractProfile(data.user),
      })
    })

    this.listen('friend-online', (data: unknown) => {
      if (!isFriendOnlineEvent(data)) {
        logger.error('Invalid friend-online event data')
        return
      }
      this.coordinator.enqueue(
        data.userId,
        data.user.displayName,
        isUsableLocation(data.location)
          ? {
              type: 'online',
              location: data.location,
              profile: extractProfile(data.user),
            }
          : { type: 'online', profile: extractProfile(data.user) }
      )
    })

    this.listen('friend-offline', (data: unknown) => {
      if (!isFriendOfflineEvent(data)) {
        logger.error('Invalid friend-offline event data')
        return
      }
      // displayName は Coordinator.enqueue 側で Repository の既存値から補完する
      this.coordinator.enqueue(data.userId, data.userId, { type: 'offline' })
    })

    this.listen('friend-add', (data: unknown) => {
      if (!isFriendAddEvent(data)) {
        logger.error('Invalid friend-add event data')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'friend-add',
      })
    })

    this.listen('friend-delete', (data: unknown) => {
      if (!isFriendDeleteEvent(data)) {
        logger.error('Invalid friend-delete event data')
        return
      }
      // displayName は Coordinator.enqueue 側で Repository の既存値から補完する
      this.coordinator.enqueue(data.userId, data.userId, {
        type: 'friend-delete',
      })
    })

    // friend-update は profile 全般の更新で届く（status / statusDescription を含むペイロードは実機で確認済み）
    this.listen('friend-update', (data: unknown) => {
      const profile = isFriendOnlineEvent(data)
        ? extractProfile(data.user)
        : undefined
      if (profile === undefined || !isFriendOnlineEvent(data)) {
        logger.debug('Ignored friend-update event without status')
        return
      }
      this.coordinator.enqueue(data.userId, data.user.displayName, {
        type: 'profile',
        profile,
      })
    })
  }

  /** 登録した business event listener を解除する */
  detach(): void {
    const pipeline = this.pipeline
    if (!pipeline) return
    for (const [event, listener] of this.listeners) {
      if (pipeline.removeListener) pipeline.removeListener(event, listener)
      else pipeline.removeAllListeners(event)
    }
    this.listeners.clear()
    this.pipeline = undefined
  }

  /**
   * Router が所有する listener を記録して登録する
   *
   * @param event business event 名
   * @param listener payload の正規化処理
   */
  private listen(event: string, listener: (data: unknown) => void): void {
    this.listeners.set(event, listener)
    this.pipeline?.on(event, listener)
  }
}
