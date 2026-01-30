import { createVRChatClient } from './vrchat-client'
import type { Config } from './config'
import type { VRChat } from 'vrchat'

/**
 * WebSocket 接続状態
 */
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/**
 * WebSocket 接続監視クラス
 *
 * VRChat SDK の WebSocket (pipeline) 接続を監視し、切断時に自動再接続を行う
 */
export class WebSocketMonitor {
  private config: Config
  private state: ConnectionState = 'connecting'
  private vrchat: VRChat | null = null
  private lastEventTime: Date | null = null
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isReconnecting = false

  /** 再接続の初回待機時間（ミリ秒） */
  private readonly INITIAL_BACKOFF = 1000

  /** 再接続の最大待機時間（ミリ秒） */
  private readonly MAX_BACKOFF = 5 * 60 * 1000 // 5分

  /** 認証失敗時のクールダウン時間（ミリ秒） */
  private readonly AUTH_FAILURE_COOLDOWN = 30 * 60 * 1000 // 30分

  /** ヘルスチェックの間隔（ミリ秒） */
  private readonly HEALTH_CHECK_INTERVAL = 60 * 1000 // 1分

  /** イベント未受信の警告閾値（ミリ秒） */
  private readonly EVENT_TIMEOUT_WARNING = 24 * 60 * 60 * 1000 // 24時間

  /** コールバック関数 */
  private onConnected: ((vrchat: VRChat) => void) | null = null
  private onDisconnected: (() => void) | null = null

  /**
   * WebSocket 接続監視を初期化する
   *
   * @param config アプリケーション設定
   */
  constructor(config: Config) {
    this.config = config
  }

  /**
   * WebSocket 接続を開始する
   *
   * @param onConnected 接続確立時のコールバック
   * @param onDisconnected 切断時のコールバック
   */
  async start(
    onConnected: (vrchat: VRChat) => void,
    onDisconnected: () => void
  ): Promise<void> {
    console.log('[MONITOR] Starting WebSocket monitor...')

    this.onConnected = onConnected
    this.onDisconnected = onDisconnected

    await this.connect()
    this.startHealthCheck()
  }

  /**
   * WebSocket 接続を停止する
   */
  stop(): void {
    console.log('[MONITOR] Stopping WebSocket monitor...')

    this.state = 'stopped'

    // タイマーをクリア
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    // WebSocket を閉じる
    if (this.vrchat) {
      this.vrchat.pipeline.close()
      this.vrchat = null
    }
  }

  /**
   * 最後のイベント受信時刻を更新する
   */
  updateLastEventTime(): void {
    this.lastEventTime = new Date()
  }

  /**
   * 接続状態を取得する
   *
   * @returns 接続状態
   */
  getState(): ConnectionState {
    return this.state
  }

  /**
   * 最後のイベント受信時刻を取得する
   *
   * @returns 最後のイベント受信時刻（未受信の場合は null）
   */
  getLastEventTime(): Date | null {
    return this.lastEventTime
  }

  /**
   * VRChat クライアントを取得する
   *
   * @returns VRChat クライアント（未接続の場合は null）
   */
  getVRChatClient(): VRChat | null {
    return this.vrchat
  }

  /**
   * WebSocket に接続する
   */
  private async connect(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.state = 'connecting'

    try {
      console.log('[MONITOR] Connecting to VRChat WebSocket...')

      // 既存の VRChat インスタンスをクリーンアップ
      if (this.vrchat) {
        try {
          // イベントリスナーを削除してからクローズ
          this.vrchat.pipeline.removeAllListeners('close')
          this.vrchat.pipeline.removeAllListeners('error')
          this.vrchat.pipeline.close()
        } catch {
          // クリーンアップ時のエラーは無視
        }
        this.vrchat = null
      }

      this.vrchat = await createVRChatClient(this.config)

      // pipeline イベントハンドラを登録
      this.vrchat.pipeline.on('close', () => {
        console.warn('[MONITOR] WebSocket closed')
        this.handleDisconnect()
      })

      this.vrchat.pipeline.on('error', (error: unknown) => {
        console.error('[MONITOR] WebSocket error:', error)
        this.handleDisconnect()
      })

      this.state = 'connected'
      this.reconnectAttempts = 0
      console.log('[MONITOR] Connected to VRChat WebSocket')

      // 接続確立コールバックを呼び出す
      if (this.onConnected) {
        this.onConnected(this.vrchat)
      }
    } catch (error) {
      console.error('[MONITOR] Failed to connect to VRChat WebSocket:', error)

      // 認証エラーの場合は長時間クールダウン
      const isAuthError = this.isAuthenticationError(error)
      if (isAuthError) {
        console.error(
          `[MONITOR] Authentication error detected. Cooling down for ${this.AUTH_FAILURE_COOLDOWN / 1000 / 60} minutes...`
        )
        await this.scheduleReconnect(this.AUTH_FAILURE_COOLDOWN)
      } else {
        // 通常のエラーの場合はバックオフして再接続
        await this.scheduleReconnect(this.calculateBackoff())
      }
    }
  }

  /**
   * エラーが認証エラーかどうかを判定する
   *
   * @param error エラーオブジェクト
   * @returns 認証エラーの場合は true
   */
  private isAuthenticationError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase()
      return (
        message.includes('authentication') ||
        message.includes('login') ||
        message.includes('unauthorized') ||
        message.includes('401')
      )
    }
    return false
  }

  /**
   * WebSocket 切断を処理する
   */
  private handleDisconnect(): void {
    if (this.state === 'stopped' || this.isReconnecting) {
      return
    }

    console.warn('[MONITOR] Handling WebSocket disconnect...')

    // 切断コールバックを呼び出す
    if (this.onDisconnected) {
      this.onDisconnected()
    }

    // 再接続をスケジュール
    this.scheduleReconnect(this.calculateBackoff()).catch((error: unknown) => {
      console.error('[MONITOR] Failed to schedule reconnect:', error)
    })
  }

  /**
   * 再接続をスケジュールする
   *
   * @param delay 待機時間（ミリ秒）
   */
  private async scheduleReconnect(delay: number): Promise<void> {
    // 単一フライト化: 既に再接続中の場合はスキップ
    if (this.isReconnecting) {
      console.warn('[MONITOR] Reconnect already in progress, skipping')
      return
    }

    this.isReconnecting = true
    this.state = 'reconnecting'

    this.reconnectAttempts++
    console.log(
      `[MONITOR] Scheduling reconnect attempt #${this.reconnectAttempts} in ${delay / 1000} seconds...`
    )

    // 既存のタイマーをクリア
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.connect()
          .then(() => {
            this.isReconnecting = false
            resolve()
          })
          .catch((error: unknown) => {
            console.error('[MONITOR] Error during reconnect:', error)
            this.isReconnecting = false
            resolve()
          })
      }, delay)
    })
  }

  /**
   * バックオフ時間を計算する（ジッター付きエクスポネンシャルバックオフ）
   *
   * @returns バックオフ時間（ミリ秒）
   */
  private calculateBackoff(): number {
    const exponential =
      this.INITIAL_BACKOFF * 2 ** Math.min(this.reconnectAttempts, 10)
    const backoff = Math.min(exponential, this.MAX_BACKOFF)

    // ジッターを追加（±25%）
    const jitter = backoff * 0.25 * (Math.random() * 2 - 1)

    return Math.floor(backoff + jitter)
  }

  /**
   * ヘルスチェックを開始する
   */
  private startHealthCheck(): void {
    // 既存のタイマーがあればクリア
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck()
    }, this.HEALTH_CHECK_INTERVAL)
  }

  /**
   * ヘルスチェックを実行する
   */
  private performHealthCheck(): void {
    if (!this.lastEventTime) {
      // まだイベントを受信していない場合はスキップ
      return
    }

    const now = new Date()
    const timeSinceLastEvent = now.getTime() - this.lastEventTime.getTime()

    if (timeSinceLastEvent > this.EVENT_TIMEOUT_WARNING) {
      console.warn(
        `[MONITOR] WARNING: No events received for ${timeSinceLastEvent / 1000 / 60 / 60} hours. Last event: ${this.lastEventTime.toISOString()}`
      )
    }
  }
}
