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
      const friend = await isFriend(this.session.client, userId)
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

    this.reconciler = new Reconciler(
      () => this.session?.client ?? null,
      this.coordinator,
      this.config.targetUserIds
    )

    const transport = new PipelineTransportAdapter()
    this.supervisor = new PipelineSupervisor(this.session.client, transport, () =>
      this.reconciler!.reconcileAll()
    )

    const authCookie = await this.session.getAuthCookie()
    if (!authCookie) {
      throw new Error('Failed to obtain auth cookie for Pipeline authentication')
    }
    await this.supervisor.start(authCookie)

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
   * アプリケーションを停止する
   */
  async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    this.supervisor?.stop()
    this.healthService?.stop()
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
    if (effect.type === 'online') {
      await notifier.notifyOnline({ displayName, userId })
    } else if (effect.type === 'offline') {
      await notifier.notifyOffline({ displayName, userId })
    } else if (effect.type === 'location-change') {
      await notifier.notifyLocationChange({
        displayName,
        userId,
        previousLocation: effect.previousLocation,
        currentLocation: effect.currentLocation,
      })
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
