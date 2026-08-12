import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import { toError } from '../logger-utils'
import { getUser } from '../vrchat/session'
import type { UserStateCoordinator } from './user-state-coordinator'
import type { UserObservation } from './user-state-reducer'

const logger = Logger.configure('RECONCILER')

/** 429 エラー発生時のクールダウン時間（ミリ秒） */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * REST snapshot を取得し、compare-and-enqueue で UserStateCoordinator の
 * queue に追記するクラス
 *
 * 起動時・reconnect 後・定期ポーリングのいずれからも同一ロジックで呼び出せる。
 * REST mismatch 自体は reconnect trigger にしない。
 */
export class Reconciler {
  private lastRunAt: Date | null = null
  private cooldownUntil: Date | null = null

  /**
   * Reconciler を初期化する
   *
   * @param getVrchat 現在の VRChat クライアントを取得する関数（未接続時は null）
   * @param coordinator observation の追記先
   * @param targetUserIds 監視対象のユーザー ID 一覧
   */
  constructor(
    private readonly getVrchat: () => VRChat | null,
    private readonly coordinator: UserStateCoordinator,
    private readonly targetUserIds: string[]
  ) {}

  /**
   * 直近の reconcile 実行日時を取得する
   *
   * @returns 実行日時、未実行の場合は null
   */
  getLastRunAt(): Date | null {
    return this.lastRunAt
  }

  /**
   * 全対象ユーザーの REST snapshot を取得し queue に追記する
   */
  async reconcileAll(): Promise<void> {
    const vrchat = this.getVrchat()
    if (!vrchat) {
      logger.warn('VRChat client is not initialized, skipping reconciliation')
      return
    }

    if (this.cooldownUntil && new Date() < this.cooldownUntil) {
      logger.info('Skipping reconciliation due to rate limit cooldown')
      return
    }
    this.cooldownUntil = null

    for (const userId of this.targetUserIds) {
      try {
        await this.reconcileUser(vrchat, userId)
      } catch (error) {
        if (error instanceof Error && error.message.includes('429')) {
          this.cooldownUntil = new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS)
          logger.warn(
            `API rate limit error (429), cooling down for ${RATE_LIMIT_COOLDOWN_MS / 1000 / 60} minutes`
          )
          break
        }
        logger.error(`Error reconciling user ${userId}`, toError(error))
      }
    }

    this.lastRunAt = new Date()
  }

  /**
   * 1 ユーザー分の REST snapshot を取得し compare-and-enqueue する
   *
   * @param vrchat VRChat クライアント
   * @param userId ユーザー ID
   */
  private async reconcileUser(vrchat: VRChat, userId: string): Promise<void> {
    const expectedSeq = this.coordinator.captureSeq(userId)
    const userInfo = await getUser(vrchat, userId)
    if (!userInfo) {
      return
    }

    const observation: UserObservation =
      userInfo.location === null
        ? { type: 'offline' }
        : { type: 'location', location: userInfo.location }

    const appended = this.coordinator.appendSnapshotObservation(
      userId,
      userInfo.displayName,
      observation,
      expectedSeq
    )
    if (!appended) {
      logger.info(
        `Snapshot for user ${userId} is stale, dropped (newer WebSocket observation arrived)`
      )
    }
  }
}
