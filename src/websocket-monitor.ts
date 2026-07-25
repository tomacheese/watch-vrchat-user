import { Logger } from '@book000/node-utils'
import { createVRChatClient } from './vrchat-client'
import type { Config } from './config'
import { toError } from './logger-utils'
import type { VRChat } from 'vrchat'

const logger = Logger.configure('MONITOR')

/**
 * WebSocket 接続状態
 */
type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'

/**
 * `ws` ライブラリの WebSocket インスタンスが持つ、ping/pong に必要なメソッドの型
 *
 * VRChat SDK 内部フィールド (`pipeline.websocket`) から取得する raw ws インスタンスを
 * 型安全に扱うための最小限インターフェース。
 */
interface RawWebSocket {
  /**
   * WebSocket の接続状態
   * 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
   */
  readyState: number
  /** ping フレームを送信する */
  ping(data?: Buffer, cb?: (err: Error) => void): void
  /** イベントリスナーを登録する */
  on(event: 'pong', listener: () => void): this
  /** 特定のリスナーを削除する */
  removeListener(event: 'pong', listener: () => void): this
}

/**
 * WebSocket 接続監視クラス
 *
 * VRChat SDK の WebSocket (pipeline) 接続を監視し、切断時に自動再接続を行う。
 * 接続確立直後に即座に ping を送信し、以降 PING_INTERVAL ごとに継続する。
 * pong が返らない場合は最大 PING_TIMEOUT 以内にサイレントデスを検知して再接続する。
 */
export class WebSocketMonitor {
  private config: Config
  private state: ConnectionState = 'connecting'
  private vrchat: VRChat | null = null
  private lastEventTime: Date | null = null
  /** 現在の接続が確立された時刻 */
  private connectedAt: Date | null = null
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isReconnecting = false
  private closeEventReceived = false
  private closeTimeout: NodeJS.Timeout | null = null

  /** ping タイマー */
  private pingTimer: NodeJS.Timeout | null = null

  /** pong 待機タイムアウトタイマー */
  private pingTimeoutTimer: NodeJS.Timeout | null = null

  /** 現在の接続の raw ws インスタンス（stopPingPong で pong リスナーを削除するために保持） */
  private rawWs: RawWebSocket | null = null

  /** 登録済みの pong イベントハンドラ（removeListener で正確に解除するために保持） */
  private pongHandler: (() => void) | null = null

  /** 再接続の初回待機時間（ミリ秒） */
  private readonly INITIAL_BACKOFF = 1000

  /** 再接続の最大待機時間（ミリ秒） */
  private readonly MAX_BACKOFF = 5 * 60 * 1000 // 5分

  /** 認証失敗時のクールダウン時間（ミリ秒） */
  private readonly AUTH_FAILURE_COOLDOWN = 30 * 60 * 1000 // 30分

  /** ヘルスチェックの間隔（ミリ秒） */
  private readonly HEALTH_CHECK_INTERVAL = 60 * 1000 // 1分

  /**
   * ping フレームの送信間隔（ミリ秒）
   *
   * VRChat WebSocket サーバーに対して定期的に WebSocket プロトコルレベルの
   * ping フレームを送信し、pong が返ることで接続の生存を確認する。
   */
  private readonly PING_INTERVAL = 30 * 1000 // 30 秒

  /**
   * pong 待機タイムアウト（ミリ秒）
   *
   * ping 送信後この時間内に pong が返らない場合、サイレントデスと判断して再接続する。
   * sendPing() は前回の ping が未応答のまま次の interval が来た時点でも即再接続するため、
   * 実際の検知時間は最大で PING_INTERVAL × 2 程度となる。
   */
  private readonly PING_TIMEOUT = 35 * 1000 // 35 秒

  /**
   * イベント未受信時のバックアップ再接続閾値（ミリ秒）
   *
   * ping/pong が機能しない環境（VRChat サーバーが pong を返さない等）への
   * 安全網として、アプリケーションレベルのイベントが一定時間来ない場合も再接続する。
   * 全フレンドのイベントで更新されるため、10 分無音は WebSocket 異常を強く示唆する。
   */
  private readonly EVENT_TIMEOUT_RECONNECT = 10 * 60 * 1000 // 10 分

  /**
   * pipeline.close() 後の close イベント待機タイムアウト（ミリ秒）
   *
   * requestReconnect() で pipeline.close() を呼び出した後、この時間内に close イベントが
   * 発火しない場合、handleDisconnect() を直接呼び出してフォールバックする。
   */
  private readonly CLOSE_TIMEOUT = 5000 // 5 秒

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
   * 初回接続に失敗した場合はエクスポネンシャルバックオフで再接続を試み、
   * 接続が確立されるまでこのメソッドは返らない。
   * 接続確立後にヘルスチェックを開始する。
   *
   * @param onConnected 接続確立時のコールバック
   * @param onDisconnected 切断時のコールバック
   */
  async start(
    onConnected: (vrchat: VRChat) => void,
    onDisconnected: () => void
  ): Promise<void> {
    logger.info('Starting WebSocket monitor...')

    this.onConnected = onConnected
    this.onDisconnected = onDisconnected

    try {
      await this.connect()
    } catch (error) {
      // 初回接続失敗 - 再接続ループを開始する
      const isAuthError = this.isAuthenticationError(error)
      if (isAuthError) {
        logger.error(
          `Authentication error on initial connect. Cooling down for ${this.AUTH_FAILURE_COOLDOWN / 1000 / 60} minutes...`
        )
        await this.scheduleReconnect(this.AUTH_FAILURE_COOLDOWN)
      } else {
        await this.scheduleReconnect(this.calculateBackoff())
      }
    }
    this.startHealthCheck()
  }

  /**
   * WebSocket 接続を停止する
   */
  stop(): void {
    logger.info('Stopping WebSocket monitor...')

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

    // closeTimeout をクリア
    if (this.closeTimeout) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }

    // ping/pong タイマーを停止
    this.stopPingPong()

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
   * 直近の接続が確立された時刻を取得する
   *
   * 切断後・再接続待機中も前回の接続確立時刻を保持するため、
   * `null` を返すのは初回接続前（アプリ起動直後）のみ。
   *
   * @returns 直近の接続確立時刻（初回接続前は null）
   */
  getConnectedAt(): Date | null {
    return this.connectedAt
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
   * 現在の再接続試行回数を取得する
   *
   * @returns 再接続試行回数
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  /**
   * 再接続処理中かどうかを取得する
   *
   * @returns 再接続処理中の場合は true
   */
  getIsReconnecting(): boolean {
    return this.isReconnecting
  }

  /**
   * 強制的に再接続を要求する
   *
   * VRChat クライアントが存在する場合は WebSocket を閉じて handleDisconnect() をトリガーすることで、
   * 既存の再接続ロジック（エクスポネンシャルバックオフ、単一フライト制御）に合流します。
   * VRChat クライアントが null の場合（接続失敗後など）は直接 handleDisconnect() を呼び出します。
   *
   * @param reason 再接続の理由
   */
  requestReconnect(reason: string): void {
    // 既に再接続中の場合はスキップ
    if (this.isReconnecting) {
      logger.warn(
        'Reconnect already in progress, skipping forced reconnect'
      )
      return
    }

    // stopped 状態の場合はスキップ
    if (this.state === 'stopped') {
      logger.warn('Monitor is stopped, skipping forced reconnect')
      return
    }

    logger.warn(`Forced reconnect: ${reason}`)

    // ping/pong タイマーを停止
    this.stopPingPong()

    // 既存の closeTimeout をクリア（連続呼び出し時のタイマー重複を防止）
    if (this.closeTimeout) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }

    // close イベント受信フラグをリセット
    this.closeEventReceived = false

    // WebSocket を閉じて handleDisconnect() をトリガー
    if (this.vrchat) {
      try {
        logger.info('Closing WebSocket pipeline for forced reconnect')
        this.vrchat.pipeline.close()

        // タイムアウトを設定（close イベントが発火しない場合のフォールバック）
        this.closeTimeout = setTimeout(() => {
          if (this.closeEventReceived) {
            return
          }

          logger.warn(
            `WARNING: Close event timeout after ${this.CLOSE_TIMEOUT}ms, forcing handleDisconnect()`
          )
          this.handleDisconnect()
        }, this.CLOSE_TIMEOUT)
      } catch (error) {
        logger.error(
          'Failed to close WebSocket pipeline for forced reconnect',
          toError(error)
        )

        // フォールバック: 直接 handleDisconnect() を呼び出す
        this.handleDisconnect()
      }
    } else {
      // vrchat が null の場合（接続失敗後など）は直接 handleDisconnect() を呼び出す
      logger.warn(
        'VRChat client is null during forced reconnect, calling handleDisconnect directly'
      )
      this.handleDisconnect()
    }
  }

  /**
   * WebSocket に接続する
   *
   * 接続に失敗した場合は例外をスローする。
   * 再接続のスケジュールは呼び出し元（scheduleReconnect のループ または start）が担う。
   */
  private async connect(): Promise<void> {
    if (this.state === 'stopped') {
      return
    }

    this.state = 'connecting'

    try {
      logger.info('Connecting to VRChat WebSocket...')

      // 既存の VRChat インスタンスをクリーンアップ
      if (this.vrchat) {
        try {
          // closeTimeout をクリア
          if (this.closeTimeout) {
            clearTimeout(this.closeTimeout)
            this.closeTimeout = null
          }

          // ping/pong タイマーを停止
          this.stopPingPong()

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
        logger.warn('WebSocket closed')

        // close イベント受信フラグを設定
        this.closeEventReceived = true

        // タイムアウトをクリア
        if (this.closeTimeout) {
          clearTimeout(this.closeTimeout)
          this.closeTimeout = null
        }

        this.handleDisconnect()
      })

      this.vrchat.pipeline.on('error', (error: unknown) => {
        logger.error('WebSocket error', toError(error))
        this.handleDisconnect()
      })

      this.state = 'connected'
      this.reconnectAttempts = 0

      // 再接続後に lastEventTime をリセットして新しい接続に新鮮な計測ウィンドウを与える
      this.lastEventTime = null
      // 接続確立時刻を記録（lastEventTime が null の間のバックアップ基準時刻として使用）
      this.connectedAt = new Date()

      logger.info('Connected to VRChat WebSocket')

      // ping/pong ハートビートを開始
      this.startPingPong()

      // 接続確立コールバックを呼び出す
      if (this.onConnected) {
        this.onConnected(this.vrchat)
      }
    } catch (error) {
      logger.error('Failed to connect to VRChat WebSocket', toError(error))
      // 再接続スケジュールは呼び出し元（scheduleReconnect のループ または start）に委譲する
      throw error
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

    logger.warn('Handling WebSocket disconnect...')

    // ping/pong タイマーを停止
    this.stopPingPong()

    // close イベント受信フラグをリセット
    this.closeEventReceived = false

    // タイムアウトをクリア
    if (this.closeTimeout) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }

    // 切断コールバックを呼び出す
    if (this.onDisconnected) {
      this.onDisconnected()
    }

    // 再接続をスケジュール
    this.scheduleReconnect(this.calculateBackoff()).catch((error: unknown) => {
      logger.error('Failed to schedule reconnect', toError(error))
    })
  }

  /**
   * 再接続をスケジュールし、接続が確立されるまで内部でリトライループを行う
   *
   * - 単一フライト制御: 既に再接続中の場合は即座にリターンする
   * - connect() が失敗した場合、エクスポネンシャルバックオフでリトライを継続する
   * - 認証エラーの場合は AUTH_FAILURE_COOLDOWN のクールダウンを挿入する
   * - Promise チェーンが積み上がらないよう、再試行はループで処理する
   *
   * @param initialDelay 最初の待機時間（ミリ秒）
   */
  private async scheduleReconnect(initialDelay: number): Promise<void> {
    // 単一フライト化: 既に再接続中の場合はスキップ
    if (this.isReconnecting) {
      logger.warn('Reconnect already in progress, skipping')
      return
    }

    this.isReconnecting = true
    let delay = initialDelay

    try {
      // stopped チェックをループ先頭で行うことで TypeScript の型絞り込みエラーを回避する
      while (true) {
        if (this.state === 'stopped') break

        this.state = 'reconnecting'
        this.reconnectAttempts++
        logger.info(
          `Scheduling reconnect attempt #${this.reconnectAttempts} in ${delay / 1000} seconds...`
        )

        // 既存のタイマーをクリア
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
        }

        // 指定時間待機してから再接続を試みる
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(resolve, delay)
        })

        try {
          await this.connect()
          return // 接続成功 - ループ終了
        } catch (connectError: unknown) {
          logger.error(
            'Error during reconnect attempt',
            toError(connectError)
          )
          // 認証エラーの場合は長時間クールダウン、それ以外はバックオフ
          const isAuthError = this.isAuthenticationError(connectError)
          if (isAuthError) {
            logger.error(
              `Authentication error detected. Cooling down for ${this.AUTH_FAILURE_COOLDOWN / 1000 / 60} minutes...`
            )
            delay = this.AUTH_FAILURE_COOLDOWN
          } else {
            delay = this.calculateBackoff()
          }
        }
      }
    } finally {
      this.isReconnecting = false
    }
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
   *
   * 毎分実行し、以下を確認する:
   * 1. pipeline.connected が false → 即座に再接続（既存の切断検出）
   * 2. アプリケーションレベルのイベントが 10 分以上来ない → バックアップ再接続
   *    （ping/pong が機能しない環境への安全網）
   *    基準時刻は lastEventTime、未受信時は connectedAt をフォールバックとして使用する。
   *    これにより再接続後にサーバーがイベントを送信しないゾンビ状態でも検知できる。
   */
  private performHealthCheck(): void {
    // VRChat SDK は WebSocket の close/error イベントを EventEmitter に転送しないため、
    // pipeline.connected を毎分チェックして切断を早期検出する
    if (this.vrchat && !this.vrchat.pipeline.connected) {
      logger.warn('WebSocket is not connected, triggering reconnect')
      this.handleDisconnect()
      return
    }

    // 接続状態でない場合（再接続中など）はイベントタイムアウトチェックをスキップする
    if (this.state !== 'connected') {
      return
    }

    // lastEventTime が null の場合は connectedAt を基準とする。
    // これにより、再接続後にイベントが一切来ない（サーバー側ゾンビ状態）でも
    // バックアップ再接続が正しく発火する。
    const referenceTime = this.lastEventTime ?? this.connectedAt
    if (!referenceTime) {
      return
    }

    const now = new Date()
    const timeSinceReference = now.getTime() - referenceTime.getTime()

    if (timeSinceReference > this.EVENT_TIMEOUT_RECONNECT) {
      // 全フレンドのイベントが 10 分以上来ない = WebSocket が実質的に死んでいる可能性が高い
      // ping/pong のバックアップとして強制再接続する
      const minutes = Math.floor(timeSinceReference / 1000 / 60)
      logger.warn(
        `No events received for ${minutes} minutes (reference: ${referenceTime.toISOString()}). Triggering backup reconnect.`
      )
      this.requestReconnect(`No events received for ${minutes} minutes`)
    }
  }

  /**
   * ping/pong ハートビートを開始する
   *
   * VRChat WebSocket サーバーに PING_INTERVAL ごとに WebSocket プロトコルレベルの ping フレームを送信する。
   * 前回の ping に対する pong が返っていない状態で次の ping タイミングが来た場合、
   * または PING_TIMEOUT 以内に pong が返らない場合にサイレントデスと判断して再接続する。
   */
  private startPingPong(): void {
    this.stopPingPong()

    if (!this.vrchat) {
      return
    }

    // VRChat SDK 内部の raw ws インスタンスを取得（isomorphic-ws = Node.js では ws ライブラリ）
    // pipeline.websocket は TypeScript 型定義上は private フィールドだが、
    // JavaScript ランタイムにはアクセス制御がないため型アサーションで強制アクセスする
    const rawWs = (
      this.vrchat.pipeline as unknown as { websocket: RawWebSocket | undefined }
    ).websocket

    if (!rawWs) {
      logger.warn(
        'Raw WebSocket instance not available, skipping ping/pong setup'
      )
      return
    }

    // rawWs をフィールドに保存（stopPingPong で pong リスナーを削除するために必要）
    this.rawWs = rawWs

    // pong ハンドラをフィールドに保持し、removeListener で正確に解除できるようにする
    this.pongHandler = () => {
      // pong 受信 → タイムアウトをキャンセル（接続は生きている）
      if (!this.pingTimeoutTimer) {
        return
      }

      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
    rawWs.on('pong', this.pongHandler)

    logger.info('Starting ping/pong heartbeat (interval: 30s)')

    // 接続直後に即座に ping を送り、最初のサイクルの検知遅延（最大 PING_INTERVAL）をなくす
    this.sendPing(rawWs)

    // PING_INTERVAL ごとに ping を送信
    this.pingTimer = setInterval(() => {
      this.sendPing(rawWs)
    }, this.PING_INTERVAL)
  }

  /**
   * ping/pong タイマーをすべて停止し、pong リスナーを削除する
   */
  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }

    // 古い接続の rawWs に登録した pong ハンドラを正確に解除してメモリリークを防ぐ
    if (this.rawWs && this.pongHandler) {
      // removeAllListeners ではなく登録したハンドラのみを解除し、他のリスナーに影響しない
      this.rawWs.removeListener('pong', this.pongHandler)
    }
    this.rawWs = null
    this.pongHandler = null
  }

  /**
   * ping フレームを送信し、pong 待機タイムアウトを設定する
   *
   * 前回の ping に対する pong がまだ返っていない（`pingTimeoutTimer` が生きている）場合は、
   * 接続がサイレントデス状態と判断して即座に再接続を要求する。
   *
   * @param rawWs raw ws WebSocket インスタンス
   */
  private sendPing(rawWs: RawWebSocket): void {
    if (this.state !== 'connected' || !this.vrchat) {
      return
    }

    // 前回の ping に対する pong がまだ返っていない場合、接続がサイレントデス状態と判断する
    if (this.pingTimeoutTimer) {
      logger.warn(
        'Previous ping unanswered. Connection is silently dead.'
      )
      this.requestReconnect('Previous ping unanswered')
      return
    }

    // raw WebSocket がまだ OPEN 状態でない場合はスキップ（接続直後の CONNECTING 状態等）
    if (rawWs.readyState !== 1) {
      logger.info(
        `Skipping ping: WebSocket not open (readyState=${rawWs.readyState})`
      )
      return
    }

    try {
      rawWs.ping()

      // pong が返ってこない場合のタイムアウトを設定
      this.pingTimeoutTimer = setTimeout(() => {
        logger.warn(
          `Ping timeout: no pong received within ${this.PING_TIMEOUT / 1000}s. Connection is silently dead.`
        )
        this.requestReconnect('Ping timeout')
      }, this.PING_TIMEOUT)
    } catch (error) {
      logger.error('Failed to send ping', toError(error))
    }
  }
}
