import { Logger } from '@book000/node-utils'
import { loadConfig, type Config } from './config'
import { DiscordNotifier } from './discord-notifier'
import { HealthServer } from './health-server'
import { LocationStore } from './location-store'
import { toError } from './logger-utils'
import { getUser, isFriend } from './vrchat-client'
import { WebSocketMonitor } from './websocket-monitor'
import type { VRChat } from 'vrchat'

const logger = Logger.configure('MAIN')

/**
 * friend-location イベントのデータ構造
 */
interface FriendLocationEvent {
  /** ユーザー ID */
  userId: string
  /** ユーザー情報 */
  user: {
    id: string
    displayName: string
    currentAvatarThumbnailImageUrl?: string
  }
  /** 現在の Location */
  location: string
  /** ワールド情報 */
  world?: {
    id: string
    name: string
    thumbnailImageUrl?: string
  }
}

/**
 * friend-online イベントのデータ構造
 */
interface FriendOnlineEvent {
  /** ユーザー ID */
  userId: string
  /** ユーザー情報 */
  user: {
    id: string
    displayName: string
  }
}

/**
 * friend-offline イベントのデータ構造
 */
interface FriendOfflineEvent {
  /** ユーザー ID */
  userId: string
}

/**
 * FriendLocationEvent の型ガード
 *
 * @param data 検証するデータ
 * @returns FriendLocationEvent として有効な場合は true
 */
function isFriendLocationEvent(data: unknown): data is FriendLocationEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.userId !== 'string') {
    return false
  }

  if (typeof obj.location !== 'string') {
    return false
  }

  if (typeof obj.user !== 'object' || obj.user === null) {
    return false
  }

  const user = obj.user as Record<string, unknown>

  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * FriendOnlineEvent の型ガード
 *
 * @param data 検証するデータ
 * @returns FriendOnlineEvent として有効な場合は true
 */
function isFriendOnlineEvent(data: unknown): data is FriendOnlineEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.userId !== 'string') {
    return false
  }

  if (typeof obj.user !== 'object' || obj.user === null) {
    return false
  }

  const user = obj.user as Record<string, unknown>

  return typeof user.id === 'string' && typeof user.displayName === 'string'
}

/**
 * FriendOfflineEvent の型ガード
 *
 * @param data 検証するデータ
 * @returns FriendOfflineEvent として有効な場合は true
 */
function isFriendOfflineEvent(data: unknown): data is FriendOfflineEvent {
  if (typeof data !== 'object' || data === null) {
    return false
  }

  const obj = data as Record<string, unknown>

  return typeof obj.userId === 'string'
}

/** ワールド間移動中の Location 値 */
const TRAVELING_LOCATION = 'traveling'

/**
 * メインアプリケーションクラス
 */
class WatchVRChatUser {
  private config: Config
  private vrchat: VRChat | null = null
  private notifier: DiscordNotifier
  private locationStore: LocationStore
  private monitor: WebSocketMonitor
  private healthServer: HealthServer
  private isShuttingDown = false
  private apiPollerTimer: NodeJS.Timeout | null = null
  private apiPollCooldownUntil: Date | null = null

  /**
   * サイレントデス判定の時間閾値（ミリ秒）
   *
   * WebSocketMonitor の ping/pong ハートビートが主系の検知機構だが、
   * API ポーリングでのミスマッチ検出による副系としてこの閾値を使用する。
   * ping/pong が正常動作していればこの条件が先に満たされることはほぼない。
   */
  private readonly SIX_HOURS = 6 * 60 * 60 * 1000

  /** 429 エラー発生時のクールダウン時間（ミリ秒） */
  private readonly RATE_LIMIT_COOLDOWN = 30 * 60 * 1000 // 30分

  /**
   * friend-online イベント受信後に LocationStore へ書き込むセンチネル値
   *
   * VRChat は実際の Location が確定する前に friend-online を複数回送信することがある。
   * 1 回目の受信時にこの値を location として記録し、2 回目以降の重複通知を防ぐ。
   * friend-location イベントが届いた際、previousLocation がこの値であれば
   * オンライン遷移の初期化として扱い、location-change 通知は送信しない。
   */
  private readonly ONLINE_SENTINEL = 'online'

  /**
   * アプリケーションを初期化する
   *
   * @param config アプリケーション設定
   */
  constructor(config: Config) {
    this.config = config
    this.notifier = new DiscordNotifier(config)
    this.locationStore = new LocationStore()
    this.monitor = new WebSocketMonitor(config)
    this.healthServer = new HealthServer(this.monitor)
  }

  /**
   * アプリケーションを開始する
   */
  async start(): Promise<void> {
    logger.info('Starting watch-vrchat-user...')

    // シグナルハンドラを設定
    this.setupSignalHandlers()

    // ヘルスチェックサーバーを開始
    this.healthServer.start()

    // WebSocket 接続監視を開始
    await this.monitor.start(
      (vrchat: VRChat) => {
        this.handleConnected(vrchat).catch((error: unknown) => {
          logger.error('Error in handleConnected', toError(error))
        })
      },
      () => {
        this.handleDisconnected()
      }
    )

    // API ポーリングを開始
    this.startApiPoller()

    logger.info('Application started. Listening for events...')
  }

  /**
   * シグナルハンドラを設定する
   */
  private setupSignalHandlers(): void {
    const shutdown = () => {
      if (this.isShuttingDown) {
        return
      }
      this.isShuttingDown = true

      logger.info('\nShutting down...')

      // API ポーリングを停止
      if (this.apiPollerTimer) {
        clearInterval(this.apiPollerTimer)
        this.apiPollerTimer = null
      }

      // Location ストアをフラッシュ
      this.locationStore.flush()

      // WebSocket 監視を停止
      this.monitor.stop()

      // ヘルスチェックサーバーを停止
      this.healthServer.stop()

      logger.info('Goodbye!')
      // Logger の送信をフラッシュしてからプロセスを終了する
      Logger.closeAll()
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  /**
   * ターゲットユーザーがフレンドかどうかを検証する
   */
  private async validateTargetUsers(): Promise<void> {
    logger.info('Validating target users...')

    if (!this.vrchat) {
      throw new Error('VRChat client is not initialized')
    }

    const notFriends: string[] = []

    for (const userId of this.config.targetUserIds) {
      const isFriendResult = await isFriend(this.vrchat, userId)
      if (!isFriendResult) {
        notFriends.push(userId)
      }
    }

    if (notFriends.length > 0) {
      logger.warn(
        `Warning: The following target users are not friends: ${notFriends.join(', ')}`
      )
      logger.warn(
        'You will not receive notifications for these users until they become friends.'
      )
    } else {
      logger.info(
        `All ${this.config.targetUserIds.length} target user(s) are friends.`
      )
    }
  }

  /**
   * ターゲットユーザーの初期状態を取得する
   *
   * 前回保存された状態と現在の状態を比較し、変化があれば通知を送信する。
   * 初回起動時など、前回の状態が存在しない場合は初期状態として保存するのみで通知は行わない。
   */
  private async fetchInitialUserStatuses(): Promise<void> {
    logger.info('Fetching initial user statuses...')

    if (!this.vrchat) {
      throw new Error('VRChat client is not initialized')
    }

    for (const userId of this.config.targetUserIds) {
      const userInfo = await getUser(this.vrchat, userId)

      if (!userInfo) {
        logger.warn(`Failed to fetch user info for ${userId}`)
        continue
      }

      // 前回の状態を取得
      const previousLocation =
        this.locationStore.getLocation(userId)?.location ?? null
      const currentLocation = userInfo.location

      // traveling 中は通知を送らず、ストアも更新しない（前回の location を維持）
      if (currentLocation === TRAVELING_LOCATION) {
        logger.info(
          `Initial status: ${userInfo.displayName} (${userId}) - traveling (skipped)`
        )
        continue
      }

      // 初期状態を保存
      this.locationStore.setInitialLocation(
        userId,
        userInfo.displayName,
        currentLocation
      )

      // 状態変化があれば通知
      if (previousLocation !== currentLocation) {
        logger.info(
          `State changed during downtime: ${userInfo.displayName} (${userId}) - ${previousLocation ?? 'offline'} -> ${currentLocation ?? 'offline'}`
        )

        // 状態変化に応じて通知を送信
        if (currentLocation === null) {
          // オンライン -> オフライン
          await this.notifier.notifyOffline({
            displayName: userInfo.displayName,
            userId,
          })
        } else if (previousLocation === null) {
          // オフライン -> オンライン
          await this.notifier.notifyOnline({
            displayName: userInfo.displayName,
            userId,
          })
        } else {
          // ロケーション間移動
          await this.notifier.notifyLocationChange({
            displayName: userInfo.displayName,
            userId,
            previousLocation,
            currentLocation,
            worldName: undefined, // 起動時は取得しない
            thumbnailUrl: undefined,
          })
        }
      }

      const locationDisplay = currentLocation ?? 'offline'
      logger.info(
        `Initial status: ${userInfo.displayName} (${userId}) - ${userInfo.status} @ ${locationDisplay}`
      )
    }

    logger.info('Initial user statuses fetched.')
  }

  /**
   * WebSocket 接続確立時の処理
   *
   * @param vrchat VRChat クライアント
   */
  private async handleConnected(vrchat: VRChat): Promise<void> {
    logger.info('WebSocket connected, initializing...')

    this.vrchat = vrchat

    // ターゲットユーザーがフレンドかどうかを検証
    await this.validateTargetUsers()

    // ターゲットユーザーの初期状態を取得
    await this.fetchInitialUserStatuses()

    // WebSocket イベントを登録
    this.setupWebSocketEvents()

    logger.info('WebSocket initialized successfully')
  }

  /**
   * WebSocket 切断時の処理
   */
  private handleDisconnected(): void {
    logger.warn('WebSocket disconnected')
    this.vrchat = null
  }

  /**
   * WebSocket イベントを設定する
   */
  private setupWebSocketEvents(): void {
    if (!this.vrchat) {
      throw new Error('VRChat client is not initialized')
    }

    const pipeline = this.vrchat.pipeline

    // 既存のリスナーをすべて削除（重複登録を防ぐ）
    pipeline.removeAllListeners('friend-location')
    pipeline.removeAllListeners('friend-online')
    pipeline.removeAllListeners('friend-offline')

    // friend-location イベント
    pipeline.on('friend-location', (data: unknown) => {
      // 最後のイベント受信時刻を更新（フィルタ前）
      this.monitor.updateLastEventTime()

      if (!isFriendLocationEvent(data)) {
        logger.error(
          `Invalid friend-location event data: ${JSON.stringify(data)}`
        )
        return
      }
      this.handleFriendLocation(data).catch((error: unknown) => {
        logger.error('Error handling friend-location event', toError(error))
      })
    })

    // friend-online イベント
    pipeline.on('friend-online', (data: unknown) => {
      // 最後のイベント受信時刻を更新（フィルタ前）
      this.monitor.updateLastEventTime()

      if (!isFriendOnlineEvent(data)) {
        logger.error(
          `Invalid friend-online event data: ${JSON.stringify(data)}`
        )
        return
      }
      this.handleFriendOnline(data).catch((error: unknown) => {
        logger.error('Error handling friend-online event', toError(error))
      })
    })

    // friend-offline イベント
    pipeline.on('friend-offline', (data: unknown) => {
      // 最後のイベント受信時刻を更新（フィルタ前）
      this.monitor.updateLastEventTime()

      if (!isFriendOfflineEvent(data)) {
        logger.error(
          `Invalid friend-offline event data: ${JSON.stringify(data)}`
        )
        return
      }
      this.handleFriendOffline(data).catch((error: unknown) => {
        logger.error('Error handling friend-offline event', toError(error))
      })
    })

    logger.info('WebSocket event handlers registered.')
  }

  /**
   * friend-location イベントを処理する
   *
   * @param event イベントデータ
   */
  private async handleFriendLocation(
    event: FriendLocationEvent
  ): Promise<void> {
    const userId = event.userId

    // ターゲットユーザーでない場合はスキップ
    if (!this.config.targetUserIds.includes(userId)) {
      return
    }

    const displayName = event.user.displayName
    const location = event.location

    logger.info(
      `Friend location event: ${displayName} (${userId}) -> ${location}`
    )

    // traveling 中はストアの更新・通知ともにスキップ
    if (location === TRAVELING_LOCATION) {
      logger.info(
        `User ${displayName} (${userId}) is traveling, skipping notification`
      )
      return
    }

    // Location を更新
    const result = this.locationStore.updateLocation(
      userId,
      displayName,
      location
    )

    // Location が変更されていない場合はスキップ
    if (!result.changed) {
      return
    }

    // friend-online 直後のセンチネル値からの遷移はオンライン通知済みのためスキップ
    if (result.previousLocation === this.ONLINE_SENTINEL) {
      return
    }

    // Discord に通知
    await this.notifier.notifyLocationChange({
      displayName,
      userId,
      previousLocation: result.previousLocation,
      currentLocation: location,
      worldName: event.world?.name,
      thumbnailUrl: event.world?.thumbnailImageUrl,
    })
  }

  /**
   * friend-online イベントを処理する
   *
   * @param event イベントデータ
   */
  private async handleFriendOnline(event: FriendOnlineEvent): Promise<void> {
    const userId = event.userId

    // ターゲットユーザーでない場合はスキップ
    if (!this.config.targetUserIds.includes(userId)) {
      return
    }

    const displayName = event.user.displayName

    logger.info(`Friend online event: ${displayName} (${userId})`)

    // 既にオンライン状態（location が非 null）の場合は重複通知を防ぐ
    const result = this.locationStore.updateLocation(
      userId,
      displayName,
      this.ONLINE_SENTINEL
    )

    if (!result.changed) {
      logger.info(
        `User ${displayName} (${userId}) already online, skipping notification`
      )
      return
    }

    // Discord に通知
    await this.notifier.notifyOnline({
      displayName,
      userId,
    })
  }

  /**
   * friend-offline イベントを処理する
   *
   * @param event イベントデータ
   */
  private async handleFriendOffline(event: FriendOfflineEvent): Promise<void> {
    const userId = event.userId

    // ターゲットユーザーでない場合はスキップ
    if (!this.config.targetUserIds.includes(userId)) {
      return
    }

    // 表示名を取得（キャッシュから）
    const displayName = this.locationStore.getDisplayName(userId) ?? userId

    logger.info(`Friend offline event: ${displayName} (${userId})`)

    // Location を null に更新
    const result = this.locationStore.updateLocation(userId, displayName, null)

    // 既にオフライン状態の場合は重複通知を防ぐ
    if (!result.changed) {
      logger.info(
        `User ${displayName} (${userId}) already offline, skipping notification`
      )
      return
    }

    // Discord に通知
    await this.notifier.notifyOffline({
      displayName,
      userId,
    })
  }

  /**
   * API ポーリングを開始する
   */
  private startApiPoller(): void {
    // 既に API ポーリングが開始されている場合はスキップ
    if (this.apiPollerTimer) {
      logger.warn('API polling already started, skipping')
      return
    }

    // 1 時間ごとに API ポーリングを実行
    const POLLING_INTERVAL = 60 * 60 * 1000 // 1時間

    this.apiPollerTimer = setInterval(() => {
      this.pollUsersStatus().catch((error: unknown) => {
        logger.error('Error in API polling', toError(error))
      })
    }, POLLING_INTERVAL)

    logger.info('API polling started (interval: 1 hour)')
  }

  /**
   * ユーザーの状態を API でポーリングする
   */
  private async pollUsersStatus(): Promise<void> {
    // 429 エラーによるクールダウン中はスキップ
    if (this.apiPollCooldownUntil) {
      const now = new Date()
      if (now < this.apiPollCooldownUntil) {
        const remainingMinutes = Math.ceil(
          (this.apiPollCooldownUntil.getTime() - now.getTime()) / 1000 / 60
        )
        logger.info(
          `Skipping API polling due to rate limit cooldown (${remainingMinutes} minutes remaining)`
        )
        return
      }

      // クールダウン期間が終了した場合はリセット
      this.apiPollCooldownUntil = null
    }

    logger.info('Polling users status...')

    // VRChat クライアントのスナップショット（ループ中に null になることを防ぐ）
    const vrchat = this.vrchat
    if (!vrchat) {
      logger.warn('VRChat client is not initialized, skipping API polling')
      return
    }

    // 各ユーザーに対して逐次実行（バースト防止）
    for (const userId of this.config.targetUserIds) {
      try {
        // API からユーザー状態を取得
        const userInfo = await getUser(vrchat, userId)

        if (!userInfo) {
          logger.warn(`Failed to fetch user info for ${userId}`)
          continue
        }

        // LocationStore から最新の Location を取得
        const storeLocation =
          this.locationStore.getLocation(userId)?.location ?? null
        const apiLocation = userInfo.location

        // traveling 中は乖離チェックをスキップ
        if (apiLocation === TRAVELING_LOCATION) {
          logger.info(
            `User ${userInfo.displayName} (${userId}) is traveling, skipping mismatch check`
          )
          continue
        }

        // Location の乖離を検出
        if (apiLocation !== storeLocation) {
          logger.info(
            `Location mismatch detected for ${userInfo.displayName} (${userId}): API=${apiLocation ?? 'offline'}, Store=${storeLocation ?? 'offline'}`
          )

          // サイレント接続死の判定
          this.checkSilentDeath(userId, apiLocation, storeLocation)
        }
      } catch (error) {
        // 429 エラー（レート制限）の場合はクールダウン
        if (error instanceof Error && error.message.includes('429')) {
          this.apiPollCooldownUntil = new Date(
            Date.now() + this.RATE_LIMIT_COOLDOWN
          )
          logger.warn(
            `API rate limit error (429), cooling down for ${this.RATE_LIMIT_COOLDOWN / 1000 / 60} minutes`
          )
          break
        }

        // その他のエラーはログ出力のみ
        logger.error(`Error fetching user info for ${userId}`, toError(error))
      }
    }

    logger.info('API polling completed')
  }

  /**
   * サイレント接続死の判定を行う
   *
   * @param userId ユーザー ID
   * @param apiLocation API で取得した Location
   * @param storeLocation LocationStore に保存された Location
   */
  private checkSilentDeath(
    userId: string,
    apiLocation: string | null,
    storeLocation: string | null
  ): void {
    // 条件 1: WebSocket が接続状態であること
    if (this.monitor.getState() !== 'connected') {
      return
    }

    // 条件 2: 最後のイベント受信時刻（またはフォールバックとして接続確立時刻）が 6 時間以上古いこと
    // lastEventTime が null の場合は connectedAt を基準とする。
    // これにより、再接続後にイベントが一切来ない（サーバー側ゾンビ状態）でも
    // サイレントデス判定が正しく機能する。
    const referenceTime =
      this.monitor.getLastEventTime() ?? this.monitor.getConnectedAt()
    if (!referenceTime) {
      return
    }

    const now = new Date()
    const timeSinceReference = now.getTime() - referenceTime.getTime()

    if (timeSinceReference < this.SIX_HOURS) {
      return
    }

    // 条件 3: Location が異なること（すでに呼び出し元で確認済み）

    // すべての条件を満たす場合、強制再接続
    logger.warn(
      `Silent death detected for user ${userId}: API=${apiLocation ?? 'offline'}, Store=${storeLocation ?? 'offline'}, Time since reference=${timeSinceReference / 1000 / 60 / 60} hours`
    )

    this.monitor.requestReconnect('Silent death detected')
  }
}

/**
 * エントリポイント
 */
async function main(): Promise<void> {
  try {
    // 設定を読み込む
    const config = loadConfig()

    // アプリケーションを開始
    const app = new WatchVRChatUser(config)
    await app.start()
  } catch (error) {
    logger.error('Fatal error', toError(error))
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}

// メイン関数を実行
main().catch((error: unknown) => {
  logger.error('Unhandled error', toError(error))
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
})
