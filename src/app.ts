import { Logger } from '@book000/node-utils'
import { toError } from './logger-utils'
import type { Config } from './config'
import { ConfigManager } from './config/config-manager'
import { HealthService, type HealthSnapshot } from './health/health-service'
import { DiscordNotifier } from './notifications/discord-notifier'
import { NotificationDispatcher } from './notifications/notification-dispatcher'
import { RuleErrorLog } from './rules/rule-engine'
import { Reconciler } from './state/reconciler'
import { UserStateCoordinator } from './state/user-state-coordinator'
import { UserStateRepository } from './state/user-state-repository'
import { FavoritesService } from './vrchat/favorites-service'
import { PipelineEventRouter } from './vrchat/pipeline-event-router'
import { PipelineSupervisor } from './vrchat/pipeline-supervisor'
import { PipelineTransportAdapter } from './vrchat/pipeline-transport'
import {
  getFriendFavoriteGroups,
  getWorldInfo,
  VRChatSession,
} from './vrchat/session'
import { WorldResolver } from './vrchat/world-resolver'

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
  private configManager: ConfigManager | null = null
  private favorites: FavoritesService | null = null
  private readonly errorLog = new RuleErrorLog()
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
   * 設定読み込み (不正なら fatal) -> user state load -> REST セッション確立 ->
   * Favorites 初回取得 (失敗は非致命) -> Coordinator/Router 準備 ->
   * Pipeline 接続 (atomic connect) -> synchronizing 中の REST snapshot cutover ->
   * ready、の順で初期化する。
   */
  async start(): Promise<void> {
    logger.info('Starting watch-vrchat-user...')

    const configManager = new ConfigManager({
      configPath: this.config.configPath,
      env: process.env,
    })
    configManager.load()
    this.configManager = configManager

    this.repository = new UserStateRepository()
    this.repository.load()

    this.session = await VRChatSession.create(this.config)
    const session = this.session

    const favorites = new FavoritesService({
      fetcher: () => getFriendFavoriteGroups(session.client),
    })
    this.favorites = favorites
    // 失敗は FavoritesService の status に記録される非致命エラー
    await favorites.refresh()

    const dispatcher = new NotificationDispatcher({
      worldResolver: new WorldResolver({
        fetcher: (worldId) => getWorldInfo(session.client, worldId),
        filePath: process.env.WORLD_CACHE_FILE_PATH,
      }),
      favorites,
      notifier: new DiscordNotifier(),
      errorLog: this.errorLog,
    })
    this.coordinator = new UserStateCoordinator(
      this.repository,
      (userId, displayName, effect, snapshot) =>
        dispatcher.handleEffect(userId, displayName, effect, snapshot),
      () => configManager.getSnapshot()
    )

    const router = new PipelineEventRouter(this.coordinator)
    router.attach(this.session.client.pipeline)

    const reconciler = new Reconciler(
      () => this.session?.client ?? null,
      this.coordinator,
      this.repository
    )
    this.reconciler = reconciler

    const transport = new PipelineTransportAdapter()
    this.supervisor = new PipelineSupervisor(
      this.session.client,
      transport,
      () => reconciler.reconcileAll()
    )

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

    favorites.start()

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
   * health endpoint が実際に listen しているポートを取得する（テスト・診断用）
   *
   * @returns ポート番号、未起動の場合は 0
   */
  getHealthPort(): number {
    return this.healthService?.getListeningPort() ?? 0
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
      this.configManager?.stop()
    } catch (error) {
      logger.error('Error while stopping config manager', toError(error))
    }
    try {
      this.favorites?.stop()
    } catch (error) {
      logger.error('Error while stopping favorites service', toError(error))
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
      config: this.configManager?.getStatus() ?? {
        loadedAt: null,
        lastReloadError: null,
        lastReloadFailedAt: null,
      },
      ruleErrors: this.errorLog.getRecent(Date.now()),
      favorites: this.favorites?.getStatus() ?? {
        lastUpdatedAt: null,
        lastError: null,
      },
    }
  }
}
