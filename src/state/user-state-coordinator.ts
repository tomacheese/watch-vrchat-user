import { Logger } from '@book000/node-utils'
import { toError } from '../logger-utils'
import {
  reduce,
  type ReducerEffect,
  type UserObservation,
} from './user-state-reducer'
import type { UserStateRepository } from './user-state-repository'

const logger = Logger.configure('USER-STATE-COORDINATOR')

/** unhealthy 状態の情報 */
export interface UnhealthyInfo {
  /** unhealthy の原因 */
  cause: string
  /** unhealthy になった日時（ISO 8601 形式） */
  since: string
}

/** Coordinator の挙動を調整するオプション（テスト用） */
export interface UserStateCoordinatorOptions {
  /** persist 失敗時の初期リトライ間隔（ミリ秒） */
  initialBackoffMs?: number
  /** persist 失敗時の最大リトライ間隔（ミリ秒） */
  maxBackoffMs?: number
  /** 1 ユーザーあたりの queue 最大長 */
  maxQueueSize?: number
}

interface QueueItem {
  displayName: string
  observation: UserObservation
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const DEFAULT_MAX_QUEUE_SIZE = 1000

/**
 * ユーザーごとに observation を直列処理する single-writer queue
 *
 * transport の connection generation を跨いで永続する。REST snapshot は
 * `appendSnapshotObservation` の compare-and-enqueue により、既に受信済みの
 * WebSocket observation を置き換えることなく追記される。
 */
export class UserStateCoordinator {
  private readonly queues = new Map<string, QueueItem[]>()
  private readonly processing = new Set<string>()
  private readonly lastSeq = new Map<string, number>()
  private readonly unhealthy = new Map<string, UnhealthyInfo>()
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly maxQueueSize: number

  /**
   * UserStateCoordinator を初期化する
   *
   * @param repository 永続化先の Repository
   * @param onEffect reduce の結果 effect が no-op 以外のときに呼ばれるコールバック
   * @param options リトライ間隔・queue 上限などのオプション
   */
  constructor(
    private readonly repository: UserStateRepository,
    private readonly onEffect: (
      userId: string,
      displayName: string,
      effect: ReducerEffect
    ) => Promise<void>,
    options: UserStateCoordinatorOptions = {}
  ) {
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
  }

  /**
   * observation を queue に追加し、処理ループが停止していれば起動する
   *
   * `displayName` が `userId` と同一（呼び出し元が表示名を持たない場合の
   * フォールバック）のときは Repository が保持する既存の表示名で補完する。
   *
   * queue が上限に達している場合は非通知で drop し unhealthy にする
   * （10.1 known limitation: この間の中間 transition は REST reconciliation でのみ
   * 最終 state を補正できる）。
   *
   * @param userId ユーザー ID
   * @param displayName 表示名
   * @param observation 観測値
   */
  enqueue(
    userId: string,
    displayName: string,
    observation: UserObservation
  ): void {
    const resolvedDisplayName =
      displayName === userId
        ? (this.repository.get(userId)?.displayName ?? displayName)
        : displayName

    this.lastSeq.set(userId, (this.lastSeq.get(userId) ?? 0) + 1)

    const queue = this.queues.get(userId) ?? []
    this.queues.set(userId, queue)

    if (queue.length >= this.maxQueueSize) {
      this.markUnhealthy(userId, 'queue-overflow')
      logger.error(
        `Queue overflow for user ${userId}, dropping new observation`
      )
      return
    }

    queue.push({ displayName: resolvedDisplayName, observation })
    this.startProcessingQueue(userId)
  }

  /**
   * 現在の queue 末尾の seq を取得する（REST snapshot 取得開始前の anchor として使う）
   *
   * @param userId ユーザー ID
   * @returns 現在の seq（未 enqueue の場合は 0）
   */
  captureSeq(userId: string): number {
    return this.lastSeq.get(userId) ?? 0
  }

  /**
   * REST snapshot を compare-and-enqueue で追記する
   *
   * `expectedSeq` が現在の seq と一致する場合のみ追記する。REST 呼び出し中に
   * 新しい WebSocket observation が届いていた場合は、より新しい実データを
   * 古い REST snapshot で上書きしないよう追記せず false を返す。
   *
   * @param userId ユーザー ID
   * @param displayName 表示名
   * @param observation REST から得た観測値
   * @param expectedSeq `captureSeq` で取得した anchor seq
   * @returns 追記した場合は true、stale のため drop した場合は false
   */
  appendSnapshotObservation(
    userId: string,
    displayName: string,
    observation: UserObservation,
    expectedSeq: number
  ): boolean {
    if ((this.lastSeq.get(userId) ?? 0) !== expectedSeq) {
      return false
    }
    this.enqueue(userId, displayName, observation)
    return true
  }

  /**
   * 指定ユーザーの unhealthy 情報を取得する
   *
   * @param userId ユーザー ID
   * @returns unhealthy 情報、健全な場合は undefined
   */
  getUnhealthy(userId: string): UnhealthyInfo | undefined {
    return this.unhealthy.get(userId)
  }

  /**
   * unhealthy な全ユーザーの情報を取得する
   *
   * @returns ユーザー ID をキーとした unhealthy 情報のマップ
   */
  getAllUnhealthy(): Record<string, UnhealthyInfo> {
    return Object.fromEntries(this.unhealthy)
  }

  /**
   * 指定ユーザーの queue を先頭から順に処理する
   *
   * persist に失敗した observation は queue head に保持したまま
   * capped exponential backoff で無期限にリトライする。
   *
   * @param userId ユーザー ID
   */
  private async processQueue(userId: string): Promise<void> {
    if (this.processing.has(userId)) {
      return
    }
    this.processing.add(userId)

    try {
      let attempt = 0
      while (true) {
        const queue = this.queues.get(userId)
        if (!queue || queue.length === 0) {
          return
        }

        const item = queue[0]
        const current = this.repository.get(userId)
        const { nextState, effect } = reduce(
          current,
          item.displayName,
          item.observation
        )

        try {
          if (nextState) {
            await this.repository.commitUserState(userId, {
              ...nextState,
              userId,
            })
          }
          queue.shift()
          attempt = 0
          this.unhealthy.delete(userId)

          if (effect.type !== 'no-op') {
            await this.onEffect(userId, item.displayName, effect).catch(
              (error: unknown) => {
                // 通知失敗はログのみ。persist 済みの state は既に確定しているため、
                // 通知の再送は行わず次の observation の処理を継続する。
                logger.error(
                  `Failed to dispatch effect for user ${userId}`,
                  toError(error)
                )
              }
            )
          }
        } catch (error) {
          this.markUnhealthy(userId, 'persist-failure')
          logger.error(
            `Failed to persist state for user ${userId}`,
            toError(error)
          )
          const delay = Math.min(
            this.initialBackoffMs * 2 ** attempt,
            this.maxBackoffMs
          )
          attempt += 1
          await this.sleep(delay)
        }
      }
    } finally {
      this.processing.delete(userId)
      // sleep 中に enqueue が呼ばれ、ループを抜けた直後に新規アイテムが積まれている
      // 可能性があるため、queue が空でなければ処理ループを再起動する
      const queue = this.queues.get(userId)
      if (queue && queue.length > 0) {
        this.startProcessingQueue(userId)
      }
    }
  }

  /**
   * `processQueue` を fire-and-forget で開始する
   *
   * このリポジトリの ESLint 設定は `no-void` を禁止しているため、`no-floating-promises`
   * を `void` ではなくこの明示的な `.catch` ラッパーで満たす。
   *
   * @param userId ユーザー ID
   */
  private startProcessingQueue(userId: string): void {
    this.processQueue(userId).catch((error: unknown) => {
      logger.error(
        `Unexpected error while processing queue for user ${userId}`,
        toError(error)
      )
    })
  }

  /**
   * 指定ユーザーを unhealthy としてマークする（既に unhealthy な場合は何もしない）
   *
   * @param userId ユーザー ID
   * @param cause unhealthy の原因
   */
  private markUnhealthy(userId: string, cause: string): void {
    if (this.unhealthy.has(userId)) {
      return
    }
    this.unhealthy.set(userId, { cause, since: new Date().toISOString() })
  }

  /**
   * 指定ミリ秒だけ待機する
   *
   * @param ms 待機するミリ秒
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
