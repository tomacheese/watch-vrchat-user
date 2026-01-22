import { loadConfig, type Config } from './config'
import { DiscordNotifier } from './discord-notifier'
import { LocationStore } from './location-store'
import { createVRChatClient, getUser, isFriend } from './vrchat-client'
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
  }

  /**
   * アプリケーションを開始する
   */
  async start(): Promise<void> {
    console.log('[MAIN] Starting watch-vrchat-user...')

    // シグナルハンドラを設定
    this.setupSignalHandlers()

    // VRChat クライアントを初期化
    this.vrchat = await createVRChatClient(this.config)

    // ターゲットユーザーがフレンドかどうかを検証
    await this.validateTargetUsers()

    // ターゲットユーザーの初期状態を取得
    await this.fetchInitialUserStatuses()

    // WebSocket イベントを登録
    this.setupWebSocketEvents()

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

      // WebSocket を閉じる
      if (this.vrchat) {
        this.vrchat.pipeline.close()
      }

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

      // Location ストアに初期状態を保存（通知なし）
      this.locationStore.setInitialLocation(
        userId,
        userInfo.displayName,
        userInfo.location
      )

      const locationDisplay = userInfo.location ?? 'offline'
      console.log(
        `[MAIN] Initial status: ${userInfo.displayName} (${userId}) - ${userInfo.status} @ ${locationDisplay}`
      )
    }

    console.log('[MAIN] Initial user statuses fetched.')
  }

  /**
   * WebSocket イベントを設定する
   */
  private setupWebSocketEvents(): void {
    if (!this.vrchat) {
      throw new Error('VRChat client is not initialized')
    }

    const pipeline = this.vrchat.pipeline

    // friend-location イベント
    pipeline.on('friend-location', (data: unknown) => {
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

    // NOTE: VRChat SDK は WebSocket 切断時の自動再接続を行わない。
    // 長時間運用では、外部からのプロセス再起動（Docker restart など）で対応する。
    // 将来的には SDK の拡張または独自の再接続ロジックが必要になる可能性がある。

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
