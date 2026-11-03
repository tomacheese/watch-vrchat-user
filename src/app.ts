import { Logger } from '@book000/node-utils'
import { toError } from './logger-utils'
import type { Config } from './config'
import { ConfigManager } from './config/config-manager'
import { HealthService, type HealthSnapshot } from './health/health-service'
import { DiscordNotifier } from './notifications/discord-notifier'
import { NotificationDispatcher } from './notifications/notification-dispatcher'
import {
  NotificationOutbox,
  prepareEffects,
} from './notifications/notification-outbox'
import { RuleEvaluator } from './rules/rule-evaluator'
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
  getInstanceOwnerInfo,
  getWorldInfo,
  VRChatSession,
} from './vrchat/session'
import { WorldResolver } from './vrchat/world-resolver'

const logger = Logger.configure('APP')

/** Interval of the periodic REST reconciliation (milliseconds) */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Wires up the whole application and runs startup, reconnect and periodic
 * reconciliation sequences
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
  private outbox: NotificationOutbox | null = null
  private evaluator: RuleEvaluator | null = null
  private router: PipelineEventRouter | null = null
  private readonly resolvers: WorldResolver[] = []
  private readonly abortController = new AbortController()
  private stopping = false
  private stopPromise: Promise<void> | undefined

  /**
   * Initializes the App
   *
   * @param config Application configuration
   */
  constructor(private readonly config: Config) {}

  /**
   * Starts the application
   *
   * Initializes in this order: load config (fatal if invalid) -> load user state -> establish REST session ->
   * initial Favorites fetch (non-fatal on failure) -> prepare Coordinator/Router ->
   * connect Pipeline (atomic connect) -> REST snapshot cutover while synchronizing ->
   * ready.
   */
  async start(): Promise<void> {
    try {
      await this.startServices()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Starts the services in order */
  private async startServices(): Promise<void> {
    logger.info('Starting watch-vrchat-user...')

    const configManager = new ConfigManager({
      configPath: this.config.configPath,
      env: process.env,
    })
    configManager.load()
    this.configManager = configManager

    this.repository = new UserStateRepository(undefined, { exclusive: true })
    this.repository.load()

    this.session = await VRChatSession.create(
      this.config,
      this.abortController.signal
    )
    const session = this.session
    this.assertRunning()

    const favorites = new FavoritesService({
      fetcher: (signal) => getFriendFavoriteGroups(session.client, signal),
    })
    this.favorites = favorites
    // A failure is a non-fatal error recorded in the FavoritesService status
    await favorites.refresh()
    this.assertRunning()

    const worldResolver = new WorldResolver({
      fetcher: (worldId, signal) =>
        getWorldInfo(session.client, worldId, signal),
      filePath: process.env.WORLD_CACHE_FILE_PATH,
      requireCapacity: true,
    })
    const ownerResolver = new WorldResolver({
      fetcher: (ownerId, signal) =>
        getInstanceOwnerInfo(session.client, ownerId, signal),
      filePath: process.env.OWNER_CACHE_FILE_PATH ?? 'data/owner-cache.json',
      label: 'instance owner',
    })
    this.resolvers.push(worldResolver, ownerResolver)
    const notifier = new DiscordNotifier()
    const evaluator = new RuleEvaluator()
    this.evaluator = evaluator
    const dispatcher = new NotificationDispatcher({
      worldResolver,
      ownerResolver,
      favorites,
      notifier,
      errorLog: this.errorLog,
      evaluateRules: (rules, context) => evaluator.evaluate(rules, context),
    })
    const outbox = new NotificationOutbox(this.repository, dispatcher, notifier)
    this.outbox = outbox
    await outbox.start()
    this.assertRunning()
    this.coordinator = new UserStateCoordinator(
      this.repository,
      () => Promise.resolve(),
      () => configManager.getSnapshot(),
      {
        prepareEffects,
        onCommitted: () => {
          outbox.wake()
        },
      }
    )

    const router = new PipelineEventRouter(this.coordinator)
    this.router = router
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
      async () => {
        const result = await reconciler.reconcileAll()
        if (result === null || !this.repository?.isBaselineCompleted()) {
          throw new Error('Initial friends synchronization did not complete')
        }
      },
      { probeDrift: () => reconciler.reconcileAll() }
    )

    await this.supervisor.start(() => session.getAuthenticatedCookie())
    this.assertRunning()

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
   * Gets a user's current persisted state (for tests and diagnostics)
   *
   * @param userId User ID
   * @returns The current state, or undefined if uninitialized or absent
   */
  getUserState(userId: string) {
    return this.repository?.get(userId)
  }

  /**
   * Gets the port the health endpoint is actually listening on (for tests and diagnostics)
   *
   * @returns Port number, or 0 if not started
   */
  getHealthPort(): number {
    return this.healthService?.getListeningPort() ?? 0
  }

  /**
   * Stops the application
   *
   * Swallows synchronous exceptions here and never rejects, so the `.catch`/`.finally`
   * of the shutdown handler (main.ts) always run.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.stopServices()
    return this.stopPromise
  }

  /** After stopping intake, saves state and in-flight delivery results within the deadline */
  private async stopServices(): Promise<void> {
    this.stopping = true
    this.abortController.abort(new Error('Application stopped'))
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    this.configManager?.stop()
    this.coordinator?.stopAccepting()
    this.router?.detach()
    this.reconciler?.stop()
    this.favorites?.stop()
    this.session?.stop()
    for (const resolver of this.resolvers) resolver.stop()
    try {
      this.supervisor?.stop()
    } catch (error) {
      logger.error('Error while stopping supervisor', toError(error))
    }
    const [drained, deliverySaved] = await Promise.all([
      this.coordinator?.stop(5000) ?? Promise.resolve(true),
      this.outbox?.stop(5000) ?? Promise.resolve(true),
    ])
    await this.evaluator?.stop()
    await Promise.all([
      this.repository?.flush(),
      this.session?.flush(),
      ...this.resolvers.map(async (resolver) => resolver.flush()),
    ])
    this.repository?.close()
    this.healthService?.stop()
    if (!drained || !deliverySaved)
      logger.error(
        'Shutdown did not drain all observations; persisted notifications remain available'
      )
  }

  /** Prevents an asynchronous startup from restarting services after a stop */
  private assertRunning(): void {
    if (this.stopping) throw new Error('Application startup was interrupted')
  }

  /**
   * Builds the current observation data passed to HealthService
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
      baselineCompleted: this.repository?.isBaselineCompleted() ?? false,
      lastReconciliationError: this.reconciler?.getLastError() ?? null,
      delivery: this.outbox?.getStatus(),
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
      reconnectHistory: this.supervisor?.getDiagnosticHistory() ?? [],
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
