import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import type {
  PipelineTransport,
  PipelineTransportCallbacks,
} from './pipeline-transport'

const logger = Logger.configure('PIPELINE-SUPERVISOR')

/** Pipeline 接続の状態 */
export type SupervisorState =
  'stopped' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting'

/** Pipeline の再接続理由を安全な値に限定する */
export type ReconnectReason =
  | 'manual'
  | 'raw close'
  | 'raw error'
  | 'stale message stream'
  | 'pong timeout'
  | 'ping send failed'
  | 'reconnect attempt failed'

/** 個人情報を含まない、件数上限付きの Pipeline 診断イベント */
export interface PipelineDiagnosticEvent {
  timestamp: string
  event:
    | 'connect-started'
    | 'connect-ready'
    | 'connect-failed'
    | 'reconnect-triggered'
    | 'reconnect-attempt-started'
    | 'reconnect-attempt-failed'
    | 'ping-send-failed'
  generation: number
  reason?: ReconnectReason | 'startup' | 'reconnect'
  attempt?: number
  backoffMs?: number
  errorType?: string
  /** raw close の close code */
  closeCode?: number
  /** raw close の reason（英数字と一部記号のみ・長さ制限付きに整形済み） */
  closeReason?: string
  /** 再接続トリガー時点で最後の raw message から経過したミリ秒 */
  msSinceLastMessage?: number
  /** 再接続トリガー時点で最後の pong から経過したミリ秒 */
  msSinceLastPong?: number
}

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
const DIAGNOSTIC_HISTORY_LIMIT = 25

/**
 * upstream のメッセージを露出せず、安全なエラー種別を返す
 *
 * @param error 種別を確認するエラー
 * @returns 安全化されたエラー種別
 */
function safeErrorType(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(type) ? type : 'Error'
}

/** close reason の最大文字数 */
const CLOSE_REASON_MAX_LENGTH = 64

/**
 * upstream の close reason をログに出せる形へ整形する
 *
 * 英数字と一部の記号以外は除去し、長さを制限する。
 *
 * @param reason raw close の reason
 * @returns 整形済みの reason。空の場合は undefined
 */
function sanitizeCloseReason(reason: Buffer | undefined): string | undefined {
  const text = reason
    ?.toString('utf8')
    .replaceAll(/[^\w .:-]/g, '')
    .slice(0, CLOSE_REASON_MAX_LENGTH)
  return text === undefined || text === '' ? undefined : text
}

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
  private lastReconnectReason: ReconnectReason | null = null
  private readonly diagnosticHistory: PipelineDiagnosticEvent[] = []
  private authCookieProvider: (() => Promise<string>) | null = null
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
   * cookie は固定値ではなく provider として受け取り、reconnect のたびに再取得する。
   * 固定値のままだと auth cookie が期限切れ/rotate した場合、以後の reconnect が
   * 永久に失敗し続け、プロセス再起動でしか復旧できなくなる。
   *
   * @param authCookieProvider Pipeline 認証用の auth cookie を取得する関数
   */
  async start(authCookieProvider: () => Promise<string>): Promise<void> {
    this.authCookieProvider = authCookieProvider
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
  requestReconnect(reason: ReconnectReason): void {
    if (this.state === 'stopped' || this.state === 'reconnecting') {
      return
    }
    this.startReconnect(reason)
  }

  /**
   * 現在の接続状態を取得する
   *
   * @returns 現在の接続状態
   */
  getState(): SupervisorState {
    return this.state
  }

  /**
   * 現在の connection generation を取得する
   *
   * @returns 現在の generation
   */
  getGeneration(): number {
    return this.generation
  }

  /**
   * 直近で raw message を受信した日時を取得する
   *
   * @returns 直近の raw message 受信日時、未受信の場合は null
   */
  getLastMessageAt(): Date | null {
    return this.lastMessageAt
  }

  /**
   * 直近で pong を受信した日時を取得する
   *
   * @returns 直近の pong 受信日時、未受信の場合は null
   */
  getLastPongAt(): Date | null {
    return this.lastPongAt
  }

  /**
   * 現在の接続以降の reconnect 試行回数を取得する
   *
   * @returns reconnect 試行回数
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  /**
   * 直近の reconnect 理由を取得する
   *
   * @returns 直近の reconnect 理由、reconnect 未発生の場合は null
   */
  getLastReconnectReason(): ReconnectReason | null {
    return this.lastReconnectReason
  }

  /**
   * 個人情報を含まない接続診断履歴を取得する
   *
   * @returns 直近の診断イベントのコピー
   */
  getDiagnosticHistory(): PipelineDiagnosticEvent[] {
    return this.diagnosticHistory.map((event) => ({ ...event }))
  }

  /**
   * 1 回分の接続シーケンスを実行する（connecting -> synchronizing -> ready）
   */
  private async connectOnce(): Promise<void> {
    const myGeneration = this.generation
    this.state = 'connecting'
    this.recordDiagnostic('connect-started', {
      reason: myGeneration === 0 ? 'startup' : 'reconnect',
    })

    try {
      if (!this.authCookieProvider) {
        throw new Error(
          'PipelineSupervisor.start() was not called with an auth cookie provider'
        )
      }
      const authCookie = await this.authCookieProvider()

      const callbacks = this.buildCallbacks(myGeneration)
      await this.transport.connect(this.vrchat, authCookie, callbacks)
      if (myGeneration !== this.generation) {
        return
      }

      // raw socket が open した時点で liveness 監視を開始する。synchronizing
      // （REST reconciliation）完了を待ってから開始すると、その間に発生した
      // silent な切断を検知できない窓ができてしまう。
      // 新しい接続の基準時刻をリセットしないと、reconnect 後も古い generation の
      // stale な timestamp が残り、stale-message timeout が即座に再発火してしまう
      // （reconnect storm）。
      this.lastMessageAt = new Date()
      this.startLivenessTimers(myGeneration)

      this.state = 'synchronizing'
      await this.onSynchronize()
      if (myGeneration !== this.generation) {
        return
      }

      this.state = 'ready'
      this.reconnectAttempts = 0
      this.recordDiagnostic('connect-ready', {
        reason: myGeneration === 0 ? 'startup' : 'reconnect',
      })
    } catch (error) {
      this.recordDiagnostic('connect-failed', {
        reason: myGeneration === 0 ? 'startup' : 'reconnect',
        errorType: safeErrorType(error),
      })
      throw error
    }
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
      onClose: (code, reason) => {
        if (myGeneration !== this.generation) return
        this.startReconnect('raw close', undefined, {
          closeCode: code,
          closeReason: sanitizeCloseReason(reason),
        })
      },
      onError: (error: Error) => {
        if (myGeneration !== this.generation) return
        const errorType = safeErrorType(error)
        logger.warn(
          `Pipeline raw error event received (errorType=${errorType})`
        )
        this.startReconnect('raw error', errorType)
      },
      onMessage: () => {
        if (myGeneration !== this.generation) return
        this.lastMessageAt = new Date()
      },
      onPong: () => {
        if (myGeneration !== this.generation) return
        this.lastPongAt = new Date()
        if (!this.pingTimeoutTimer) {
          return
        }

        clearTimeout(this.pingTimeoutTimer)
        this.pingTimeoutTimer = null
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
        if (!(
          reference &&
          Date.now() - reference.getTime() >= this.staleMessageTimeoutMs
        )) {
          return
        }

        this.startReconnect('stale message stream')
      },
      Math.min(this.staleMessageTimeoutMs, 60_000)
    )

    this.pingTimer = setInterval(() => {
      if (myGeneration !== this.generation) return
      try {
        this.transport.ping(this.vrchat)
      } catch (error) {
        const errorType = safeErrorType(error)
        this.recordDiagnostic('ping-send-failed', {
          reason: 'ping send failed',
          errorType,
        })
        this.startReconnect('ping send failed', errorType)
        return
      }
      // 前回 ping の pong 待ちが残っている間は timeout を再設定しない。
      // ここで毎回リセットすると pingIntervalMs < pongTimeoutMs のとき
      // timeout が発火する前に常に打ち消され、pong 未達を検知できなくなる。
      if (this.pingTimeoutTimer) return
      this.pingTimeoutTimer = setTimeout(() => {
        if (myGeneration !== this.generation) return
        this.startReconnect('pong timeout')
      }, this.pongTimeoutMs)
    }, this.pingIntervalMs)
  }

  /**
   * reconnect シーケンスを実行する
   *
   * generation を invalidate してから capped exponential backoff を待ち、再接続する。
   */
  private async reconnect(reason: ReconnectReason): Promise<void> {
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
    const attempt = this.reconnectAttempts + 1
    this.reconnectAttempts += 1
    this.recordDiagnostic('reconnect-attempt-started', {
      reason,
      attempt,
      backoffMs: delay,
    })
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
      logger.error(
        `Reconnect attempt failed (errorType=${safeErrorType(error)})`
      )
      this.recordDiagnostic('reconnect-attempt-failed', {
        reason,
        attempt,
        errorType: safeErrorType(error),
      })
      this.startReconnect('reconnect attempt failed')
    }
  }

  /**
   * `reconnect` を fire-and-forget で開始する
   *
   * このリポジトリの ESLint 設定は `no-void` を禁止しているため、`no-floating-promises`
   * を `void` ではなくこの明示的な `.catch` ラッパーで満たす。
   */
  private startReconnect(
    reason: ReconnectReason,
    errorType?: string,
    close?: Pick<PipelineDiagnosticEvent, 'closeCode' | 'closeReason'>
  ): void {
    if (this.state === 'stopped' || this.state === 'reconnecting') {
      return
    }
    this.lastReconnectReason = reason
    // 切断原因の切り分け用に、無通信の長さを残す
    const now = Date.now()
    this.recordDiagnostic('reconnect-triggered', {
      reason,
      errorType,
      ...close,
      msSinceLastMessage: this.lastMessageAt
        ? now - this.lastMessageAt.getTime()
        : undefined,
      msSinceLastPong: this.lastPongAt
        ? now - this.lastPongAt.getTime()
        : undefined,
    })
    this.reconnect(reason).catch((error: unknown) => {
      logger.error(
        `Unexpected error during reconnect (errorType=${safeErrorType(error)})`
      )
    })
  }

  /**
   * 個人情報を含まない診断イベントを記録し、履歴を一定件数に保つ
   *
   * @param event イベント種別
   * @param details 安全なイベント情報
   */
  private recordDiagnostic(
    event: PipelineDiagnosticEvent['event'],
    details: Omit<PipelineDiagnosticEvent, 'timestamp' | 'event' | 'generation'>
  ): void {
    const entry: PipelineDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      event,
      generation: this.generation,
      ...details,
    }
    this.diagnosticHistory.push(entry)
    if (this.diagnosticHistory.length > DIAGNOSTIC_HISTORY_LIMIT) {
      this.diagnosticHistory.shift()
    }

    logger.info(
      `Pipeline diagnostic event=${event} generation=${entry.generation}${entry.reason ? ` reason=${entry.reason}` : ''}${entry.attempt === undefined ? '' : ` attempt=${entry.attempt}`}${entry.backoffMs === undefined ? '' : ` backoffMs=${entry.backoffMs}`}${entry.errorType ? ` errorType=${entry.errorType}` : ''}${entry.closeCode === undefined ? '' : ` closeCode=${entry.closeCode}`}${entry.closeReason ? ` closeReason="${entry.closeReason}"` : ''}${entry.msSinceLastMessage === undefined ? '' : ` msSinceLastMessage=${entry.msSinceLastMessage}`}${entry.msSinceLastPong === undefined ? '' : ` msSinceLastPong=${entry.msSinceLastPong}`}`
    )
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
    if (!this.pingTimeoutTimer) {
      return
    }

    clearTimeout(this.pingTimeoutTimer)
    this.pingTimeoutTimer = null
  }
}
