import { Logger } from '@book000/node-utils'
import { toError } from './logger-utils'
import type { Config } from './config'
import { HealthService, type HealthSnapshot } from './health/health-service'
import { DiscordNotifier } from './notifications/discord-notifier'
import { Reconciler } from './state/reconciler'
import { UserStateCoordinator } from './state/user-state-coordinator'
import { UserStateRepository } from './state/user-state-repository'
import type { ReducerEffect } from './state/user-state-reducer'
import { PipelineEventRouter } from './vrchat/pipeline-event-router'
import { PipelineSupervisor } from './vrchat/pipeline-supervisor'
import { PipelineTransportAdapter } from './vrchat/pipeline-transport'
import { isFriend, VRChatSession } from './vrchat/session'

const logger = Logger.configure('APP')

/** 定期 REST reconciliation の実行間隔（ミリ秒） */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000

/**
 * アプリケーション全体を配線し、起動・reconnect・定期 reconciliation の
 * シーケンスを担うクラス
 */
export class App {
  private repository: UserStateRepository | null = null
  private coordinator: UserStateCoordinator | null = null
  private supervisor: PipelineSupervisor | null = null
  private reconciler: Reconciler | null = null
  private healthService: HealthService | null = null
  private session: VRChatSession | null = null
  private reconcileTimer: NodeJS.Timeout | null = null

  /**
   * App を初期化する
   *
   * @param config アプリケーション設定
   */
  constructor(private readonly config: Config) {}

  /**
   * アプリケーションを起動する
   *
   * REST セッション確立 -> target user の friend 検証 -> user state load ->
   * Coordinator/Router 準備 -> Pipeline 接続 (atomic connect) ->
   * synchronizing 中の REST snapshot cutover -> ready、の順で初期化する。
   */
  async start(): Promise<void> {
    logger.info('Starting watch-vrchat-user...')

    this.repository = new UserStateRepository()
    this.repository.load()

    const notifier = new DiscordNotifier(this.config)
    this.coordinator = new UserStateCoordinator(
      this.repository,
      (userId, displayName, effect) =>
        this.dispatchEffect(notifier, userId, displayName, effect)
    )

    this.session = await VRChatSession.create(this.config)

    for (const userId of this.config.targetUserIds) {
      let friend: boolean
      try {
        friend = await isFriend(this.session.client, userId)
      } catch (error) {
        // API 呼び出し自体の失敗（一時的なネットワーク不調や 429 等）は
        // 「フレンドではない」と断定できないため、fatal にせず監視を継続する
        logger.warn(
          `Could not verify friend status for ${userId}, continuing to monitor: ${toError(error).message}`
        )
        continue
      }
      if (!friend) {
        throw new Error(
          `Target user ${userId} is not a friend. Add them as a friend before monitoring.`
        )
      }
    }

    const router = new PipelineEventRouter(
      this.config.targetUserIds,
      this.coordinator
    )
    router.attach(this.session.client.pipeline)

    const reconciler = new Reconciler(
      () => this.session?.client ?? null,
      this.coordinator,
      this.config.targetUserIds
    )
    this.reconciler = reconciler

    const transport = new PipelineTransportAdapter()
    this.supervisor = new PipelineSupervisor(
      this.session.client,
      transport,
      () => reconciler.reconcileAll()
    )

    const session = this.session
    const getAuthCookie = async (): Promise<string> => {
      const authCookie = await session.getAuthCookie()
      if (!authCookie) {
        throw new Error(
          'Failed to obtain auth cookie for Pipeline authentication'
        )
      }
      return authCookie
    }
    // 起動時点で cookie が取得できることを早期に確認しておく
    // (以後 reconnect のたびに provider が再取得することで、期限切れ/rotate にも追従する)
    await getAuthCookie()
    await this.supervisor.start(getAuthCookie)

    this.reconcileTimer = setInterval(() => {
      this.reconciler?.reconcileAll().catch((error: unknown) => {
        logger.error('Periodic reconciliation failed', toError(error))
      })
    }, RECONCILE_INTERVAL_MS)

    this.healthService = new HealthService(() => this.buildHealthSnapshot())
    this.healthService.start()

    logger.info('Application started. Listening for events...')
  }

  /**
   * 指定ユーザーの現在の永続 state を取得する（テスト・診断用）
   *
   * @param userId ユーザー ID
   * @returns 現在の state、未初期化または存在しない場合は undefined
   */
  getUserState(userId: string) {
    return this.repository?.get(userId)
  }

  /**
   * アプリケーションを停止する
   *
   * shutdown handler (main.ts) の `.catch`/`.finally` が確実に走るよう、
   * 同期的な例外が発生してもここで飲み込み、reject させない。
   */
  stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    try {
      this.supervisor?.stop()
    } catch (error) {
      logger.error('Error while stopping supervisor', toError(error))
    }
    try {
      this.healthService?.stop()
    } catch (error) {
      logger.error('Error while stopping health service', toError(error))
    }
    return Promise.resolve()
  }

  /**
   * reduce effect を Discord 通知へ変換して送信する
   *
   * @param notifier Discord 通知クラス
   * @param userId ユーザー ID
   * @param displayName 表示名
   * @param effect reduce が生成した effect
   */
  private async dispatchEffect(
    notifier: DiscordNotifier,
    userId: string,
    displayName: string,
    effect: ReducerEffect
  ): Promise<void> {
    switch (effect.type) {
      case 'online': {
        await notifier.notifyOnline({ displayName, userId })

        break
      }
      case 'offline': {
        await notifier.notifyOffline({ displayName, userId })

        break
      }
      case 'location-change': {
        await notifier.notifyLocationChange({
          displayName,
          userId,
          previousLocation: effect.previousLocation,
          currentLocation: effect.currentLocation,
        })

        break
      }
      // No default
    }
  }

  /**
   * HealthService へ渡す現在の観測データを構築する
   *
   * @returns health snapshot
   */
  private buildHealthSnapshot(): HealthSnapshot {
    const unhealthyUsers = this.coordinator
      ? Object.entries(this.coordinator.getAllUnhealthy()).map(
          ([userId, info]) => ({ userId, ...info })
        )
      : []

    return {
      supervisorState: this.supervisor?.getState() ?? 'stopped',
      rawReadyState: this.session
        ? new PipelineTransportAdapter().getReadyState(this.session.client)
        : 0,
      generation: this.supervisor?.getGeneration() ?? 0,
      lastMessageAt: this.supervisor?.getLastMessageAt()?.toISOString() ?? null,
      lastPongAt: this.supervisor?.getLastPongAt()?.toISOString() ?? null,
      lastReconciliationAt:
        this.reconciler?.getLastRunAt()?.toISOString() ?? null,
      reconnectAttempts: this.supervisor?.getReconnectAttempts() ?? 0,
      lastReconnectReason: this.supervisor?.getLastReconnectReason() ?? null,
      unhealthyUsers,
    }
  }
}
