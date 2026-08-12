import type { VRChat } from 'vrchat'

/** SDK 内部の raw WebSocket が持つ最小限のインターフェース */
export interface RawWebSocket {
  readyState: number
  on(event: 'open', listener: () => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'message', listener: (data: Buffer) => void): void
  on(event: 'pong', listener: () => void): void
  ping(): void
}

/** raw WebSocket lifecycle / liveness イベントのコールバック */
export interface PipelineTransportCallbacks {
  onOpen: () => void
  onClose: () => void
  onError: (error: Error) => void
  onMessage: (data: Buffer) => void
  onPong: () => void
}

/** Pipeline (WebSocket) transport の抽象インターフェース */
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
const DEFAULT_OPEN_TIMEOUT_MS = 10_000

/**
 * SDK の raw WebSocket 依存を隔離する PipelineTransport 実装
 *
 * `pipeline.authenticate()` は raw socket が OPEN になるまで待たないため、
 * authenticate 開始直後に raw socket を取得し listener を登録してから
 * OPEN を待つことで、authenticate が同期的に open を発火させる場合でも
 * イベントを取りこぼさないようにする。
 */
export class PipelineTransportAdapter implements PipelineTransport {
  async connect(
    vrchat: VRChat,
    authCookie: string,
    callbacks: PipelineTransportCallbacks,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS
  ): Promise<void> {
    const authenticatePromise = vrchat.pipeline.authenticate(authCookie)

    const rawWs = this.getRawWebSocket(vrchat)
    rawWs.on('open', callbacks.onOpen)
    rawWs.on('close', callbacks.onClose)
    rawWs.on('error', callbacks.onError)
    rawWs.on('message', callbacks.onMessage)
    rawWs.on('pong', callbacks.onPong)

    await this.waitForOpen(rawWs, openTimeoutMs)
    await authenticatePromise
  }

  getReadyState(vrchat: VRChat): number {
    return this.getRawWebSocket(vrchat).readyState
  }

  ping(vrchat: VRChat): void {
    this.getRawWebSocket(vrchat).ping()
  }

  close(vrchat: VRChat): void {
    // SDK の EventEmitter は raw close を再送出しないため、close 完了は待たない
    vrchat.pipeline.close()
  }

  private getRawWebSocket(vrchat: VRChat): RawWebSocket {
    const rawWs = (
      vrchat.pipeline as unknown as { websocket: RawWebSocket | undefined }
    ).websocket
    if (!rawWs) {
      throw new Error('Pipeline raw WebSocket is not available')
    }
    return rawWs
  }

  private async waitForOpen(
    rawWs: RawWebSocket,
    timeoutMs: number
  ): Promise<void> {
    if (rawWs.readyState === OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Pipeline WebSocket open timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      rawWs.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
