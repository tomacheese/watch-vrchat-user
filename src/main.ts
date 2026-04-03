import { loadConfig, type Config } from './config'
import { DiscordNotifier } from './discord-notifier'
import { HealthServer } from './health-server'
import { LocationStore } from './location-store'
import { getUser, isFriend } from './vrchat-client'
import { WebSocketMonitor } from './websocket-monitor'
import type { VRChat } from 'vrchat'

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

  if (typeof user.id !== 'string' || typeof user.displayName !== 'string') {
    return false
  }

  return true
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

  if (typeof user.id !== 'string' || typeof user.displayName !== 'string') {
    return false
  }

  return true
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
    console.log('[MAIN] Starting watch-vrchat-user...')

    // シグナルハンドラを設定
    this.setupSignalHandlers()

    // ヘルスチェックサーバーを開始
    this.healthServer.start()

    // WebSocket 接続監視を開始
    await this.monitor.start(
      (vrchat: VRChat) => {
        this.handleConnected(vrchat).catch((err: unknown) => {
          console.error('[MAIN] Error in handleConnected:', err)
        })
      },
      () => {
        this.handleDisconnected()
      }
    )

    // API ポーリングを開始
    this.startApiPoller()

    console.log('[MAIN] Application started. Listening for events...')
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

      console.log('\n[MAIN] Shutting down...')

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

      console.log('[MAIN] Goodbye!')
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
    console.log('[MAIN] Validating target users...')

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
      console.warn(
        `[MAIN] Warning: The following target users are not friends: ${notFriends.join(', ')}`
      )
      console.warn(
        '[MAIN] You will not receive notifications for these users until they become friends.'
      )
    } else {
      console.log(
        `[MAIN] All ${this.config.targetUserIds.length} target user(s) are friends.`
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
    console.log('[MAIN] Fetching initial user statuses...')

    if (!this.vrchat) {
      throw new Error('VRChat client is not initialized')
    }

    for (const userId of this.config.targetUserIds) {
      const userInfo = await getUser(this.vrchat, userId)

      if (!userInfo) {
        console.warn(`[MAIN] Failed to fetch user info for ${userId}`)
        continue
      }

      // 前回の状態を取得
      const previousLocation =
        this.locationStore.getLocation(userId)?.location ?? null
      const currentLocation = userInfo.location

      // 初期状態を保存
      this.locationStore.setInitialLocation(
        userId,
        userInfo.displayName,
        currentLocation
      )

      // 状態変化があれば通知
      if (previousLocation !== currentLocation) {
        console.log(
          `[MAIN] State changed during downtime: ${userInfo.displayName} (${userId}) - ${previousLocation ?? 'offline'} -> ${currentLocation ?? 'offline'}`
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
      console.log(
        `[MAIN] Initial status: ${userInfo.displayName} (${userId}) - ${userInfo.status} @ ${locationDisplay}`
      )
    }

    console.log('[MAIN] Initial user statuses fetched.')
  }

  /**
   * WebSocket 接続確立時の処理
   *
   * @param vrchat VRChat クライアント
   */
  private async handleConnected(vrchat: VRChat): Promise<void> {
    console.log('[MAIN] WebSocket connected, initializing...')

    this.vrchat = vrchat

    // ターゲットユーザーがフレンドかどうかを検証
    await this.validateTargetUsers()

    // ターゲットユーザーの初期状態を取得
    await this.fetchInitialUserStatuses()

    // WebSocket イベントを登録
    this.setupWebSocketEvents()

    console.log('[MAIN] WebSocket initialized successfully')
  }

  /**
   * WebSocket 切断時の処理
   */
  private handleDisconnected(): void {
    console.warn('[MAIN] WebSocket disconnected')
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
        console.error(
          '[MAIN] Invalid friend-location event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendLocation(data).catch((err: unknown) => {
        console.error('[MAIN] Error handling friend-location event:', err)
      })
    })

    // friend-online イベント
    pipeline.on('friend-online', (data: unknown) => {
      // 最後のイベント受信時刻を更新（フィルタ前）
      this.monitor.updateLastEventTime()

      if (!isFriendOnlineEvent(data)) {
        console.error(
          '[MAIN] Invalid friend-online event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendOnline(data).catch((err: unknown) => {
        console.error('[MAIN] Error handling friend-online event:', err)
      })
    })

    // friend-offline イベント
    pipeline.on('friend-offline', (data: unknown) => {
      // 最後のイベント受信時刻を更新（フィルタ前）
      this.monitor.updateLastEventTime()

      if (!isFriendOfflineEvent(data)) {
        console.error(
          '[MAIN] Invalid friend-offline event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendOffline(data).catch((err: unknown) => {
        console.error('[MAIN] Error handling friend-offline event:', err)
      })
    })

    console.log('[MAIN] WebSocket event handlers registered.')
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
    const displayName = event.user.displayName
    const location = event.location

    // ターゲットユーザーでない場合はスキップ
    if (!this.config.targetUserIds.includes(userId)) {
      return
    }

    console.log(
      `[MAIN] Friend location event: ${displayName} (${userId}) -> ${location}`
    )

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
    const displayName = event.user.displayName

    // ターゲットユーザーでない場合はスキップ
    if (!this.config.targetUserIds.includes(userId)) {
      return
    }

    console.log(`[MAIN] Friend online event: ${displayName} (${userId})`)

    // 既にオンライン状態（location が非 null）の場合は重複通知を防ぐ
    const result = this.locationStore.updateLocation(
      userId,
      displayName,
      this.ONLINE_SENTINEL
    )

    if (!result.changed) {
      console.log(
        `[MAIN] User ${displayName} (${userId}) already online, skipping notification`
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

    console.log(`[MAIN] Friend offline event: ${displayName} (${userId})`)

    // Location を null に更新
    const result = this.locationStore.updateLocation(userId, displayName, null)

    // 既にオフライン状態の場合は重複通知を防ぐ
    if (!result.changed) {
      console.log(
        `[MAIN] User ${displayName} (${userId}) already offline, skipping notification`
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
      console.warn('[MAIN] API polling already started, skipping')
      return
    }

    // 1 時間ごとに API ポーリングを実行
    const POLLING_INTERVAL = 60 * 60 * 1000 // 1時間

    this.apiPollerTimer = setInterval(() => {
      this.pollUsersStatus().catch((err: unknown) => {
        console.error('[MAIN] Error in API polling:', err)
      })
    }, POLLING_INTERVAL)

    console.log('[MAIN] API polling started (interval: 1 hour)')
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
        console.log(
          `[MAIN] Skipping API polling due to rate limit cooldown (${remainingMinutes} minutes remaining)`
        )
        return
      }

      // クールダウン期間が終了した場合はリセット
      this.apiPollCooldownUntil = null
    }

    console.log('[MAIN] Polling users status...')

    // VRChat クライアントのスナップショット（ループ中に null になることを防ぐ）
    const vrchat = this.vrchat
    if (!vrchat) {
      console.warn(
        '[MAIN] VRChat client is not initialized, skipping API polling'
      )
      return
    }

    // 各ユーザーに対して逐次実行（バースト防止）
    for (const userId of this.config.targetUserIds) {
      try {
        // API からユーザー状態を取得
        const userInfo = await getUser(vrchat, userId)

        if (!userInfo) {
          console.warn(`[MAIN] Failed to fetch user info for ${userId}`)
          continue
        }

        // LocationStore から最新の Location を取得
        const storeLocation =
          this.locationStore.getLocation(userId)?.location ?? null
        const apiLocation = userInfo.location

        // Location の乖離を検出
        if (apiLocation !== storeLocation) {
          console.log(
            `[MAIN] Location mismatch detected for ${userInfo.displayName} (${userId}): API=${apiLocation ?? 'offline'}, Store=${storeLocation ?? 'offline'}`
          )

          // サイレント接続死の判定
          this.checkSilentDeath(userId, apiLocation, storeLocation)
        }
      } catch (err) {
        // 429 エラー（レート制限）の場合はクールダウン
        if (err instanceof Error && err.message.includes('429')) {
          this.apiPollCooldownUntil = new Date(
            Date.now() + this.RATE_LIMIT_COOLDOWN
          )
          console.warn(
            `[MAIN] API rate limit error (429), cooling down for ${this.RATE_LIMIT_COOLDOWN / 1000 / 60} minutes`
          )
          break
        }

        // その他のエラーはログ出力のみ
        console.error(`[MAIN] Error fetching user info for ${userId}:`, err)
      }
    }

    console.log('[MAIN] API polling completed')
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

    // 条件 2: 最後のイベント受信時刻が 6 時間以上古いこと
    const lastEventTime = this.monitor.getLastEventTime()
    if (!lastEventTime) {
      // まだイベントを受信していない場合はスキップ
      return
    }

    const now = new Date()
    const timeSinceLastEvent = now.getTime() - lastEventTime.getTime()

    if (timeSinceLastEvent < this.SIX_HOURS) {
      return
    }

    // 条件 3: Location が異なること（すでに呼び出し元で確認済み）

    // すべての条件を満たす場合、強制再接続
    console.warn(
      `[MAIN] Silent death detected for user ${userId}: API=${apiLocation ?? 'offline'}, Store=${storeLocation ?? 'offline'}, Time since last event=${timeSinceLastEvent / 1000 / 60 / 60} hours`
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
  } catch (err) {
    console.error('[MAIN] Fatal error:', err)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}

// メイン関数を実行
main().catch((err: unknown) => {
  console.error('[MAIN] Unhandled error:', err)
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
})
