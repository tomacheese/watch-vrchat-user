import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import { toError } from '../logger-utils'
import type {
  PipelineTransport,
  PipelineTransportCallbacks,
} from './pipeline-transport'

const logger = Logger.configure('PIPELINE-SUPERVISOR')

/** Pipeline 接続の状態 */
export type SupervisorState =
  'stopped' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting'

/** PipelineSupervisor の挙動を調整するオプション */
export interface PipelineSupervisorOptions {
  /** raw message が一定時間まったく届かない場合に proactive reconnect する閾値（ミリ秒） */
  staleMessageTimeoutMs?: number
  /** ping 送信間隔（ミリ秒） */
  pingIntervalMs?: number
  /** pong 待機タイムアウト（ミリ秒） */
  pongTimeoutMs?: number
  /** reconnect の初期 backoff（ミリ秒） */
  initialBackoffMs?: number
  /** reconnect の最大 backoff（ミリ秒） */
  maxBackoffMs?: number
}

/** raw Pipeline message 全体を liveness 判定に使う既定の heuristic（10 分） */
const DEFAULT_STALE_MESSAGE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_PING_INTERVAL_MS = 30_000
const DEFAULT_PONG_TIMEOUT_MS = 35_000
const DEFAULT_INITIAL_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 300_000

/**
 * Pipeline 接続状態と transport liveness のみを管理するクラス
 *
 * ユーザーの online/offline/location semantics は持たない。
 */
export class PipelineSupervisor {
  private state: SupervisorState = 'stopped'
  private generation = 0
  private lastMessageAt: Date | null = null
  private lastPongAt: Date | null = null
  private reconnectAttempts = 0
  private lastReconnectReason: string | null = null
  private authCookie: string | null = null
  private staleCheckTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pingTimeoutTimer: NodeJS.Timeout | null = null

  private readonly staleMessageTimeoutMs: number
  private readonly pingIntervalMs: number
  private readonly pongTimeoutMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  /**
   * PipelineSupervisor を初期化する
   *
   * @param vrchat VRChat クライアント
   * @param transport raw WebSocket への隔離された transport
   * @param onSynchronize synchronizing 状態で呼ばれる REST snapshot cutover 処理
   * @param options liveness/backoff の閾値オプション
   */
  constructor(
    private readonly vrchat: VRChat,
    private readonly transport: PipelineTransport,
    private readonly onSynchronize: () => Promise<void>,
    options: PipelineSupervisorOptions = {}
  ) {
    this.staleMessageTimeoutMs =
      options.staleMessageTimeoutMs ?? DEFAULT_STALE_MESSAGE_TIMEOUT_MS
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS
    this.initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  }

  /**
   * Pipeline への接続を開始する
   *
   * @param authCookie Pipeline 認証用の auth cookie
   */
  async start(authCookie: string): Promise<void> {
    this.authCookie = authCookie
    await this.connectOnce()
  }

  /**
   * Supervisor を停止する
   */
  stop(): void {
    this.generation += 1 // 以降のすべての callback を無効化する
    this.clearTimers()
    this.state = 'stopped'
    this.transport.close(this.vrchat)
  }

  /**
   * 明示的に reconnect を要求する
   *
   * @param reason reconnect の理由（health 観測用）
   */
  requestReconnect(reason: string): void {
    if (this.state === 'stopped' || this.state === 'reconnecting') {
      return
    }
    this.lastReconnectReason = reason
    this.startReconnect()
  }

  getState(): SupervisorState {
    return this.state
  }

  getGeneration(): number {
    return this.generation
  }

  getLastMessageAt(): Date | null {
    return this.lastMessageAt
  }

  getLastPongAt(): Date | null {
    return this.lastPongAt
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  getLastReconnectReason(): string | null {
    return this.lastReconnectReason
  }

  /**
   * 1 回分の接続シーケンスを実行する（connecting -> synchronizing -> ready）
   */
  private async connectOnce(): Promise<void> {
    const myGeneration = this.generation
    this.state = 'connecting'

    if (!this.authCookie) {
      throw new Error(
        'PipelineSupervisor.start() was not called with an auth cookie'
      )
    }

    const callbacks = this.buildCallbacks(myGeneration)
    await this.transport.connect(this.vrchat, this.authCookie, callbacks)
    if (myGeneration !== this.generation) {
      return
    }

    this.state = 'synchronizing'
    await this.onSynchronize()
    if (myGeneration !== this.generation) {
      return
    }

    this.state = 'ready'
    this.reconnectAttempts = 0
    this.startLivenessTimers(myGeneration)
  }

  /**
   * 現在の generation に束縛された raw transport コールバック群を構築する
   *
   * generation が変わった後に発火した callback は無視する（late callback の拒否）。
   *
   * @param myGeneration このコールバックが有効な generation
   * @returns transport へ渡すコールバック
   */
  private buildCallbacks(myGeneration: number): PipelineTransportCallbacks {
    return {
      // raw open は supervisor 側で liveness 状態を持たないため何もしない
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onOpen: () => {},
      onClose: () => {
        if (myGeneration !== this.generation) return
        this.lastReconnectReason = 'raw close'
        this.startReconnect()
      },
      onError: (error: Error) => {
        if (myGeneration !== this.generation) return
        logger.error('Raw pipeline error', toError(error))
        this.lastReconnectReason = 'raw error'
        this.startReconnect()
      },
      onMessage: () => {
        if (myGeneration !== this.generation) return
        this.lastMessageAt = new Date()
      },
      onPong: () => {
        if (myGeneration !== this.generation) return
        this.lastPongAt = new Date()
        if (this.pingTimeoutTimer) {
          clearTimeout(this.pingTimeoutTimer)
          this.pingTimeoutTimer = null
        }
      },
    }
  }

  /**
   * stale-message 監視・ping/pong を開始する
   *
   * @param myGeneration 監視対象の generation
   */
  private startLivenessTimers(myGeneration: number): void {
    this.staleCheckTimer = setInterval(
      () => {
        if (myGeneration !== this.generation) return
        const reference = this.lastMessageAt
        if (
          reference &&
          Date.now() - reference.getTime() >= this.staleMessageTimeoutMs
        ) {
          this.lastReconnectReason = 'stale message stream'
          this.startReconnect()
        }
      },
      Math.min(this.staleMessageTimeoutMs, 60_000)
    )

    this.pingTimer = setInterval(() => {
      if (myGeneration !== this.generation) return
      this.transport.ping(this.vrchat)
      // 前回 ping の pong 待ちが残っている間は timeout を再設定しない。
      // ここで毎回リセットすると pingIntervalMs < pongTimeoutMs のとき
      // timeout が発火する前に常に打ち消され、pong 未達を検知できなくなる。
      if (this.pingTimeoutTimer) return
      this.pingTimeoutTimer = setTimeout(() => {
        if (myGeneration !== this.generation) return
        this.lastReconnectReason = 'pong timeout'
        this.startReconnect()
      }, this.pongTimeoutMs)
    }, this.pingIntervalMs)
  }

  /**
   * reconnect シーケンスを実行する
   *
   * generation を invalidate してから capped exponential backoff を待ち、再接続する。
   */
  private async reconnect(): Promise<void> {
    if (this.state === 'reconnecting' || this.state === 'stopped') {
      return
    }
    this.generation += 1
    this.clearTimers()
    this.state = 'reconnecting'
    this.transport.close(this.vrchat)

    const delay = Math.min(
      this.initialBackoffMs * 2 ** this.reconnectAttempts,
      this.maxBackoffMs
    )
    this.reconnectAttempts += 1
    await new Promise((resolve) => setTimeout(resolve, delay))

    // backoff 待機中に stop() が呼ばれ state が変わっている可能性があるため、
    // 型上は常に 'reconnecting' に見えてもこのチェックは必要（false positive）
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.state !== 'reconnecting') {
      return
    }

    try {
      await this.connectOnce()
    } catch (error) {
      logger.error('Reconnect attempt failed', toError(error))
      this.startReconnect()
    }
  }

  /**
   * `reconnect` を fire-and-forget で開始する
   *
   * このリポジトリの ESLint 設定は `no-void` を禁止しているため、`no-floating-promises`
   * を `void` ではなくこの明示的な `.catch` ラッパーで満たす。
   */
  private startReconnect(): void {
    this.reconnect().catch((error: unknown) => {
      logger.error('Unexpected error during reconnect', toError(error))
    })
  }

  /**
   * すべての liveness/ping タイマーを解除する
   */
  private clearTimers(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer)
      this.staleCheckTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
  }
}
