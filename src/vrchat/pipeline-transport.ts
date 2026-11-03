import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'

const logger = Logger.configure('PIPELINE-TRANSPORT')

/** Minimal interface of the SDK's internal raw WebSocket */
export interface RawWebSocket {
  readyState: number
  on(event: 'open' | 'pong', listener: () => void): void
  on(event: 'close', listener: (code?: number, reason?: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'message', listener: (data: Buffer) => void): void
  ping(): void
  removeListener?(event: string, listener: (...args: never[]) => void): void
  removeAllListeners?(event: string): void
  terminate?(): void
}

/** Callbacks for raw WebSocket lifecycle / liveness events */
export interface PipelineTransportCallbacks {
  onOpen: () => void
  /** The close code and reason come from ws and may be omitted (e.g. in tests) */
  onClose: (code?: number, reason?: Buffer) => void
  onError: (error: Error) => void
  onMessage: (data: Buffer) => void
  onPong: () => void
}

/** Abstract interface of the Pipeline (WebSocket) transport */
export interface PipelineTransport {
  connect(
    vrchat: VRChat,
    authCookie: string,
    callbacks: PipelineTransportCallbacks,
    openTimeoutMs?: number
  ): Promise<void>
  getReadyState(vrchat: VRChat): number
  ping(vrchat: VRChat): void
  close(vrchat: VRChat): void
}

const OPEN = 1
const CLOSED = 3
const DEFAULT_OPEN_TIMEOUT_MS = 10_000

/**
 * PipelineTransport implementation that isolates the dependency on the SDK's raw WebSocket.
 *
 * `pipeline.authenticate()` does not wait for the raw socket to reach OPEN, so
 * the raw socket is obtained and listeners are registered right after
 * authenticate starts, and only then is OPEN awaited. This way no events are
 * missed even if authenticate fires `open` synchronously.
 */
export class PipelineTransportAdapter implements PipelineTransport {
  /**
   * Connects to the Pipeline and registers raw WebSocket lifecycle/liveness listeners.
   *
   * @param vrchat VRChat client
   * @param authCookie Auth cookie used to authenticate the Pipeline
   * @param callbacks Callbacks for raw WebSocket lifecycle/liveness events
   * @param openTimeoutMs Timeout (ms) for waiting for the raw socket to open
   */
  async connect(
    vrchat: VRChat,
    authCookie: string,
    callbacks: PipelineTransportCallbacks,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS
  ): Promise<void> {
    const authenticatePromise = vrchat.pipeline.authenticate(authCookie)
    // Prevent an unhandled rejection if getRawWebSocket/waitForOpen throws first
    // and authenticatePromise rejects without being awaited. The real error
    // propagation is handled by the Promise.all below.
    authenticatePromise.catch(() => undefined)

    const rawWs = this.getRawWebSocket(vrchat)
    rawWs.on('open', callbacks.onOpen)
    rawWs.on('close', callbacks.onClose)
    rawWs.on('error', callbacks.onError)
    rawWs.on('message', callbacks.onMessage)
    rawWs.on('pong', callbacks.onPong)

    // Passing authenticatePromise to Promise.all attaches a rejection handler,
    // so it cannot become an unhandled rejection even if waitForOpen settles first.
    await Promise.all([
      this.waitForOpen(rawWs, openTimeoutMs),
      authenticatePromise,
    ])
  }

  /**
   * Gets the readyState of the raw WebSocket.
   *
   * Returns CLOSED instead of throwing when no raw socket exists (e.g. during
   * reconnect). The health endpoint calls this unconditionally, so throwing here
   * could let a `/health` request take the process down.
   *
   * @param vrchat VRChat client
   * @returns The raw WebSocket readyState, or CLOSED (3) if unavailable
   */
  getReadyState(vrchat: VRChat): number {
    try {
      return this.getRawWebSocket(vrchat).readyState
    } catch {
      return CLOSED
    }
  }

  /**
   * Sends a ping frame on the raw WebSocket.
   *
   * @param vrchat VRChat client
   */
  ping(vrchat: VRChat): void {
    this.getRawWebSocket(vrchat).ping()
  }

  /**
   * Closes the Pipeline.
   *
   * The SDK's EventEmitter does not re-emit raw close, so completion of the close
   * is not awaited. Exceptions thrown by pipeline.close() are swallowed here so
   * they cannot break the caller (Supervisor.reconnect/stop) and block reconnect;
   * the close is strictly best-effort.
   *
   * @param vrchat VRChat client
   */
  close(vrchat: VRChat): void {
    try {
      const raw = this.getRawWebSocket(vrchat)
      // Stop the old socket from forwarding business events to the SDK's shared emitter.
      raw.removeAllListeners?.('message')
      vrchat.pipeline.close()
      raw.terminate?.()
    } catch {
      logger.warn('Failed to close pipeline (best-effort)')
    }
  }

  /**
   * Gets the raw WebSocket from the VRChat SDK's private implementation.
   *
   * @param vrchat VRChat client
   * @returns The raw WebSocket
   * @throws If no raw WebSocket exists (e.g. during reconnect)
   */
  private getRawWebSocket(vrchat: VRChat): RawWebSocket {
    const rawWs = (
      vrchat.pipeline as unknown as { websocket: RawWebSocket | undefined }
    ).websocket
    if (!rawWs) {
      throw new Error('Pipeline raw WebSocket is not available')
    }
    return rawWs
  }

  /**
   * Waits until the raw WebSocket is OPEN.
   *
   * @param rawWs Raw WebSocket
   * @param timeoutMs Timeout in milliseconds
   * @throws If the socket closes, errors, or does not open within the timeout
   */
  private async waitForOpen(
    rawWs: RawWebSocket,
    timeoutMs: number
  ): Promise<void> {
    if (rawWs.readyState === OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timeout: { timer?: NodeJS.Timeout } = {}
      const listeners = new Map<string, () => void>()
      function cleanup(): void {
        clearTimeout(timeout.timer)
        for (const [event, listener] of listeners)
          rawWs.removeListener?.(event, listener)
      }
      function onOpen(): void {
        cleanup()
        resolve()
      }
      function onClose(): void {
        cleanup()
        reject(new Error('Pipeline closed before opening'))
      }
      function onError(): void {
        cleanup()
        reject(new Error('Pipeline failed before opening'))
      }
      timeout.timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(`Pipeline WebSocket open timed out after ${timeoutMs}ms`)
        )
      }, timeoutMs)
      listeners.set('open', onOpen)
      listeners.set('close', onClose)
      listeners.set('error', onError)
      rawWs.on('open', onOpen)
      rawWs.on('close', onClose)
      rawWs.on('error', onError)
    })
  }
}
