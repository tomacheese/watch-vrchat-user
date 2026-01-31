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
        this.handleConnected(vrchat).catch((error: unknown) => {
          console.error('[MAIN] Error in handleConnected:', error)
        })
      },
      () => {
        this.handleDisconnected()
      }
    )

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
      if (previousLocation !== null && previousLocation !== currentLocation) {
        console.log(
          `[MAIN] State changed during downtime: ${userInfo.displayName} (${userId}) - ${previousLocation} -> ${currentLocation}`
        )

        // 状態変化に応じて通知を送信
        await (currentLocation === null
          ? // オンライン -> オフライン
            this.notifier.notifyOffline({
              displayName: userInfo.displayName,
              userId,
            })
          : // ロケーション変更（オフライン -> オンライン または ロケーション間移動）
            this.notifier.notifyLocationChange({
              displayName: userInfo.displayName,
              userId,
              previousLocation,
              currentLocation,
              worldName: undefined, // 起動時は取得しない
              thumbnailUrl: undefined,
            }))
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
      // 最後のイベント受信時刻を更新
      this.monitor.updateLastEventTime()

      if (!isFriendLocationEvent(data)) {
        console.error(
          '[MAIN] Invalid friend-location event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendLocation(data).catch((error: unknown) => {
        console.error('[MAIN] Error handling friend-location event:', error)
      })
    })

    // friend-online イベント
    pipeline.on('friend-online', (data: unknown) => {
      // 最後のイベント受信時刻を更新
      this.monitor.updateLastEventTime()

      if (!isFriendOnlineEvent(data)) {
        console.error(
          '[MAIN] Invalid friend-online event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendOnline(data).catch((error: unknown) => {
        console.error('[MAIN] Error handling friend-online event:', error)
      })
    })

    // friend-offline イベント
    pipeline.on('friend-offline', (data: unknown) => {
      // 最後のイベント受信時刻を更新
      this.monitor.updateLastEventTime()

      if (!isFriendOfflineEvent(data)) {
        console.error(
          '[MAIN] Invalid friend-offline event data:',
          JSON.stringify(data)
        )
        return
      }
      this.handleFriendOffline(data).catch((error: unknown) => {
        console.error('[MAIN] Error handling friend-offline event:', error)
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

    // 表示名を更新
    this.locationStore.updateDisplayName(userId, displayName)

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
    this.locationStore.updateLocation(userId, displayName, null)

    // Discord に通知
    await this.notifier.notifyOffline({
      displayName,
      userId,
    })
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
    console.error('[MAIN] Fatal error:', error)
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1)
  }
}

// メイン関数を実行
main().catch((error: unknown) => {
  console.error('[MAIN] Unhandled error:', error)
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1)
})
