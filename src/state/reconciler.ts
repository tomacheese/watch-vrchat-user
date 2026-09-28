import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import { toError } from '../logger-utils'
import { getFriendsSnapshot, isFriend } from '../vrchat/session'
import { isTraveling } from './location'
import type { UserStateCoordinator } from './user-state-coordinator'
import type { UserObservation } from './user-state-reducer'
import type { UserStateRepository } from './user-state-repository'

const logger = Logger.configure('RECONCILER')

/** 429 エラー発生時のクールダウン時間（ミリ秒） */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * フレンド一覧の Location を observation へ変換する
 *
 * @param location Friends API の location
 * @returns observation。traveling は在席のみ確定（location は未確定）として扱う
 */
function toObservation(location: string): UserObservation {
  if (isTraveling(location)) return { type: 'online' }
  return location === 'offline'
    ? { type: 'offline' }
    : { type: 'location', location }
}

/**
 * Friends API の REST snapshot を取得し、compare-and-enqueue で
 * UserStateCoordinator の queue に追記するクラス
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
   * @param repository 既知ユーザー一覧と baseline 完了フラグの参照・永続化先
   */
  constructor(
    private readonly getVrchat: () => VRChat | null,
    private readonly coordinator: UserStateCoordinator,
    private readonly repository: UserStateRepository
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
   * 全フレンドの REST snapshot を取得し queue に追記する
   *
   * snapshot の取得に 1 ページでも失敗した場合は差分を一切適用しない。
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

    try {
      await this.reconcile(vrchat)
    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {
        this.cooldownUntil = new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS)
        logger.warn(
          `API rate limit error (429), cooling down for ${RATE_LIMIT_COOLDOWN_MS / 1000 / 60} minutes`
        )
        return
      }
      logger.error('Error reconciling friends', toError(error))
    }
  }

  /**
   * snapshot の取得・差分の追記・baseline 完了の永続化を行う
   *
   * @param vrchat VRChat クライアント
   */
  private async reconcile(vrchat: VRChat): Promise<void> {
    // 取得前に全ユーザーの seq を控える（record を持たないユーザーも含む）。未観測は seq 0 とみなす
    const knownUsers = Object.values(this.repository.getAll())
    const expectedSeqs = this.coordinator.captureAllSeqs()

    const snapshot = await getFriendsSnapshot(vrchat)
    this.lastRunAt = new Date()

    const touchedUserIds: string[] = []
    for (const [userId, friend] of snapshot) {
      touchedUserIds.push(userId)
      this.appendOrDrop(
        userId,
        friend.displayName,
        toObservation(friend.location),
        expectedSeqs.get(userId) ?? 0
      )
    }

    for (const user of knownUsers) {
      if (snapshot.has(user.userId)) continue
      if (!(await this.isConfirmedDeleted(vrchat, user.userId))) continue
      touchedUserIds.push(user.userId)
      this.appendOrDrop(
        user.userId,
        user.displayName,
        { type: 'friend-delete' },
        expectedSeqs.get(user.userId) ?? 0
      )
    }

    if (!this.repository.isBaselineCompleted()) {
      await this.completeBaseline(touchedUserIds)
    }
  }

  /**
   * フレンドでないことを API で確認できたかを返す
   *
   * 確認 API が失敗した場合は「フレンドでない」と確定できないため false を返す。
   * 429 だけは cooldown 判定のため呼び出し元へ伝播する。
   *
   * @param vrchat VRChat クライアント
   * @param userId 確認するユーザー ID
   * @returns フレンドでないと確認できた場合は true
   */
  private async isConfirmedDeleted(
    vrchat: VRChat,
    userId: string
  ): Promise<boolean> {
    try {
      return !(await isFriend(vrchat, userId))
    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {
        throw error
      }
      logger.error(
        `Failed to confirm friend status for ${userId}`,
        toError(error)
      )
      return false
    }
  }

  /**
   * observation を compare-and-enqueue し、stale で drop された場合はログを出す
   *
   * @param userId ユーザー ID
   * @param displayName 表示名
   * @param observation 追記する observation
   * @param expectedSeq 取得前に控えた seq
   */
  private appendOrDrop(
    userId: string,
    displayName: string,
    observation: UserObservation,
    expectedSeq: number
  ): void {
    const appended = this.coordinator.appendSnapshotObservation(
      userId,
      displayName,
      observation,
      expectedSeq
    )
    if (!appended) {
      logger.info(
        `Snapshot for user ${userId} is stale, dropped (newer WebSocket observation arrived)`
      )
    }
  }

  /**
   * 全 baseline observation の persist 完了を待ち、成功時のみ完了フラグを永続化する
   *
   * persist 失敗・queue overflow で drain が false になった場合は永続化せず、
   * 次回の reconcile で再試行する。
   *
   * @param userIds 待機対象のユーザー ID
   */
  private async completeBaseline(userIds: string[]): Promise<void> {
    const drained = await this.coordinator.drain(userIds)
    if (!drained) {
      logger.warn(
        'Baseline was not completed because some users are unhealthy, will retry on next reconciliation'
      )
      return
    }
    await this.repository.setBaselineCompleted()
    logger.info('Baseline completed')
  }
}
