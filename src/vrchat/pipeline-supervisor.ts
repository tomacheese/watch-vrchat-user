import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import type {
  PipelineTransport,
  PipelineTransportCallbacks,
} from './pipeline-transport'

const logger = Logger.configure('PIPELINE-SUPERVISOR')

/** State of the Pipeline connection */
export type SupervisorState =
  'stopped' | 'connecting' | 'synchronizing' | 'ready' | 'reconnecting'

/** Reconnect reasons, restricted to a fixed set of safe values */
export type ReconnectReason =
  | 'manual'
  | 'raw close'
  | 'raw error'
  | 'stale message stream'
  | 'pong timeout'
  | 'ping send failed'
  | 'reconnect attempt failed'

/** Pipeline diagnostic event that contains no personal information; the history is capped */
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
  /** Close code of the raw close */
  closeCode?: number
  /** Reason of the raw close (sanitized: alphanumerics and a few symbols only, length-limited) */
  closeReason?: string
  /** Milliseconds since the last raw message when the reconnect was triggered */
  msSinceLastMessage?: number
  /** Milliseconds since the last pong when the reconnect was triggered */
  msSinceLastPong?: number
}

/** Options that tune the behavior of PipelineSupervisor */
export interface PipelineSupervisorOptions {
  /** Threshold (ms) of raw-message silence after which to proactively reconnect */
  staleMessageTimeoutMs?: number
  /** Ping interval (ms) */
  pingIntervalMs?: number
  /** Pong wait timeout (ms) */
  pongTimeoutMs?: number
  /** Initial reconnect backoff (ms) */
  initialBackoffMs?: number
  /** Maximum reconnect backoff (ms) */
  maxBackoffMs?: number
  /**
   * Checks for state drift via a REST sync when silence exceeds the threshold.
   *
   * Returning 0 skips the reconnect. A value of 1 or more, null (could not be
   * verified), an exception or a timeout triggers a reconnect.
   * If omitted, the supervisor reconnects immediately once silence exceeds the threshold.
   */
  probeDrift?: () => Promise<number | null>
  /** Maximum time (ms) to wait for probeDrift; on timeout the check counts as unverified */
  probeTimeoutMs?: number
}

/** Default heuristic for liveness based on any raw Pipeline message: 10 minutes of silence */
const DEFAULT_STALE_MESSAGE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 120_000
const DEFAULT_PING_INTERVAL_MS = 30_000
const DEFAULT_PONG_TIMEOUT_MS = 35_000
const DEFAULT_INITIAL_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 300_000
const DIAGNOSTIC_HISTORY_LIMIT = 25

/**
 * Returns a safe error type without exposing upstream messages.
 *
 * @param error Error to classify
 * @returns Sanitized error type
 */
function safeErrorType(error: unknown): string {
  const type = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(type) ? type : 'Error'
}

/** Maximum length of the close reason */
const CLOSE_REASON_MAX_LENGTH = 64

/**
 * Sanitizes an upstream close reason so it is safe to log.
 *
 * Characters other than alphanumerics and a few symbols are removed, and the length is limited.
 *
 * @param reason Reason of the raw close
 * @returns The sanitized reason, or undefined if empty
 */
function sanitizeCloseReason(reason: Buffer | undefined): string | undefined {
  const text = reason
    ?.toString('utf8')
    .replaceAll(/[^\w .:-]/g, '')
    .slice(0, CLOSE_REASON_MAX_LENGTH)
  return text === undefined || text === '' ? undefined : text
}

/**
 * Manages only the Pipeline connection state and transport liveness.
 *
 * It has no knowledge of user online/offline/location semantics.
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
  private lastProbeAt: number | null = null
  private probing = false
  private backoffTimer: NodeJS.Timeout | null = null
  private releaseBackoff: (() => void) | null = null

  private readonly probeDrift: (() => Promise<number | null>) | undefined
  private readonly probeTimeoutMs: number
  private readonly staleMessageTimeoutMs: number
  private readonly pingIntervalMs: number
  private readonly pongTimeoutMs: number
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  /**
   * Creates a PipelineSupervisor.
   *
   * @param vrchat VRChat client
   * @param transport Transport that isolates access to the raw WebSocket
   * @param onSynchronize REST snapshot cutover run in the synchronizing state
   * @param options Liveness/backoff threshold options
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
    this.probeDrift = options.probeDrift
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  }

  /**
   * Starts connecting to the Pipeline.
   *
   * The cookie is taken as a provider rather than a fixed value and is fetched
   * again on every reconnect. With a fixed value, once the auth cookie expires
   * or rotates every later reconnect would fail forever and only a process
   * restart could recover.
   *
   * @param authCookieProvider Function that returns the auth cookie for Pipeline authentication
   */
  async start(authCookieProvider: () => Promise<string>): Promise<void> {
    this.authCookieProvider = authCookieProvider
    await this.connectOnce()
  }

  /**
   * Stops the supervisor.
   */
  stop(): void {
    this.generation += 1 // invalidates every later callback
    this.clearTimers()
    this.state = 'stopped'
    this.transport.close(this.vrchat)
  }

  /**
   * Explicitly requests a reconnect.
   *
   * @param reason Reason for the reconnect (for health observation)
   */
  requestReconnect(reason: ReconnectReason): void {
    if (this.state === 'stopped' || this.state === 'reconnecting') {
      return
    }
    this.startReconnect(reason)
  }

  /**
   * Gets the current connection state.
   *
   * @returns Current connection state
   */
  getState(): SupervisorState {
    return this.state
  }

  /**
   * Gets the current connection generation.
   *
   * @returns Current generation
   */
  getGeneration(): number {
    return this.generation
  }

  /**
   * Gets the time the last raw message was received.
   *
   * @returns Time of the last raw message, or null if none was received
   */
  getLastMessageAt(): Date | null {
    return this.lastMessageAt
  }

  /**
   * Gets the time the last pong was received.
   *
   * @returns Time of the last pong, or null if none was received
   */
  getLastPongAt(): Date | null {
    return this.lastPongAt
  }

  /**
   * Gets the number of reconnect attempts since the last successful connection.
   *
   * @returns Number of reconnect attempts
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  /**
   * Gets the most recent reconnect reason.
   *
   * @returns The most recent reconnect reason, or null if no reconnect has occurred
   */
  getLastReconnectReason(): ReconnectReason | null {
    return this.lastReconnectReason
  }

  /**
   * Gets the connection diagnostic history, which contains no personal information.
   *
   * @returns Copy of the recent diagnostic events
   */
  getDiagnosticHistory(): PipelineDiagnosticEvent[] {
    return this.diagnosticHistory.map((event) => ({ ...event }))
  }

  /**
   * Runs one connection sequence (connecting -> synchronizing -> ready).
   */
  private async connectOnce(): Promise<void> {
    const myGeneration = this.generation
    this.state = 'connecting'
    this.lastProbeAt = null
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
      if (myGeneration !== this.generation) return

      const callbacks = this.buildCallbacks(myGeneration)
      await this.transport.connect(this.vrchat, authCookie, callbacks)
      if (myGeneration !== this.generation) {
        return
      }

      // Start liveness monitoring as soon as the raw socket opens. Waiting for
      // synchronizing (REST reconciliation) to finish would leave a window in
      // which a silent disconnect goes undetected.
      // The reference time must be reset for the new connection; otherwise the
      // stale timestamp of the old generation survives the reconnect and the
      // stale-message timeout fires again immediately (reconnect storm).
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
      if (myGeneration !== this.generation) return
      this.recordDiagnostic('connect-failed', {
        reason: myGeneration === 0 ? 'startup' : 'reconnect',
        errorType: safeErrorType(error),
      })
      throw error
    }
  }

  /**
   * Builds the raw transport callbacks bound to the given generation.
   *
   * Callbacks fired after the generation has changed are ignored (late callbacks are rejected).
   *
   * @param myGeneration Generation for which these callbacks are valid
   * @returns Callbacks to pass to the transport
   */
  private buildCallbacks(myGeneration: number): PipelineTransportCallbacks {
    return {
      // The supervisor keeps no liveness state for raw open, so nothing to do
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
   * Starts stale-message monitoring and ping/pong.
   *
   * @param myGeneration Generation being monitored
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

        // Without a probe, reconnect immediately.
        // Outside the ready state (mid-connection) a REST probe cannot judge, so reconnect immediately as well
        if (!this.probeDrift || this.state !== 'ready') {
          this.startReconnect('stale message stream')
          return
        }
        if (this.probing) return
        if (
          this.lastProbeAt !== null &&
          Date.now() - this.lastProbeAt < this.staleMessageTimeoutMs
        ) {
          return
        }
        this.runLivenessProbe(myGeneration, this.probeDrift).catch(
          (error: unknown) => {
            logger.error(
              `Unexpected error during liveness probe (errorType=${safeErrorType(error)})`
            )
          }
        )
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
      // Do not re-arm the timeout while the previous ping is still awaiting its pong.
      // Resetting it every time would, when pingIntervalMs < pongTimeoutMs, always
      // cancel it before it fires, so a missing pong would never be detected.
      if (this.pingTimeoutTimer) return
      this.pingTimeoutTimer = setTimeout(() => {
        if (myGeneration !== this.generation) return
        this.startReconnect('pong timeout')
      }, this.pongTimeoutMs)
    }, this.pingIntervalMs)
  }

  /**
   * Checks for drift via a REST sync after prolonged silence and decides whether to reconnect.
   *
   * Reconnects unless drift is exactly 0; an unverified result also reconnects.
   *
   * @param myGeneration Generation that started the probe
   * @param probeDrift Returns the drift count (null if it could not be verified)
   */
  private async runLivenessProbe(
    myGeneration: number,
    probeDrift: () => Promise<number | null>
  ): Promise<void> {
    this.probing = true
    this.lastProbeAt = Date.now()
    let timeoutTimer: NodeJS.Timeout | undefined
    let drift: number | null
    try {
      drift = await Promise.race([
        probeDrift(),
        new Promise<null>((resolve) => {
          timeoutTimer = setTimeout(() => {
            resolve(null)
          }, this.probeTimeoutMs)
        }),
      ])
    } catch (error) {
      logger.warn(
        `Pipeline liveness probe failed (errorType=${safeErrorType(error)})`
      )
      drift = null
    } finally {
      clearTimeout(timeoutTimer)
      this.probing = false
    }
    if (myGeneration !== this.generation) return

    const silentMs = this.lastMessageAt
      ? Date.now() - this.lastMessageAt.getTime()
      : undefined
    const action = drift === 0 ? 'keep' : 'reconnect'
    logger.info(
      `Pipeline liveness probe: ${drift === null ? 'unverified' : `drift=${drift}`} action=${action} msSinceLastMessage=${silentMs}`
    )
    if (action === 'reconnect') {
      this.startReconnect('stale message stream')
    }
  }

  /**
   * Runs the reconnect sequence.
   *
   * Invalidates the generation, waits out a capped exponential backoff, then reconnects.
   *
   * @param reason Reason for the reconnect
   */
  private async reconnect(reason: ReconnectReason): Promise<void> {
    if (this.state === 'reconnecting' || this.state === 'stopped') {
      return
    }
    this.generation += 1
    this.clearTimers()
    this.state = 'reconnecting'
    this.transport.close(this.vrchat)
    const reconnectGeneration = this.generation

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
    await new Promise<void>((resolve) => {
      this.releaseBackoff = resolve
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null
        this.releaseBackoff = null
        resolve()
      }, delay)
    })

    // stop() may have been called during the backoff and changed the state, so
    // this check is needed even though the types suggest it is always 'reconnecting'
    // (the lint rule is a false positive)
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      this.state !== 'reconnecting' ||
      reconnectGeneration !== this.generation
    ) {
      return
    }

    try {
      await this.connectOnce()
    } catch (error) {
      if (reconnectGeneration !== this.generation) return
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
   * Starts `reconnect` fire-and-forget.
   *
   * This repository's ESLint config forbids `no-void`, so `no-floating-promises`
   * is satisfied with this explicit `.catch` wrapper instead of `void`.
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
    // Record how long the connection was silent, to help diagnose the cause of the disconnect
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
   * Records a diagnostic event without personal information and caps the history size.
   *
   * @param event Event type
   * @param details Safe event details
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
   * Clears all liveness/ping timers.
   */
  private clearTimers(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
      this.releaseBackoff?.()
      this.releaseBackoff = null
    }
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
