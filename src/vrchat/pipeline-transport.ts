import { Logger } from '@book000/node-utils'
import type { VRChat } from 'vrchat'
import { toError } from '../logger-utils'

const logger = Logger.configure('PIPELINE-TRANSPORT')

/** SDK 内部の raw WebSocket が持つ最小限のインターフェース */
export interface RawWebSocket {
  readyState: number
  on(event: 'open' | 'close' | 'pong', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'message', listener: (data: Buffer) => void): void
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
const CLOSED = 3
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
  /**
   * Pipeline へ接続し、raw WebSocket の lifecycle/liveness listener を登録する
   *
   * @param vrchat VRChat クライアント
   * @param authCookie Pipeline 認証用の auth cookie
   * @param callbacks raw WebSocket lifecycle/liveness イベントのコールバック
   * @param openTimeoutMs raw socket の OPEN 待機タイムアウト（ミリ秒）
   */
  async connect(
    vrchat: VRChat,
    authCookie: string,
    callbacks: PipelineTransportCallbacks,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS
  ): Promise<void> {
    const authenticatePromise = vrchat.pipeline.authenticate(authCookie)
    // getRawWebSocket/waitForOpen が先に throw/reject しても authenticatePromise が
    // 誰にも await されないまま reject し unhandled rejection になるのを防ぐ
    // （実際のエラー伝播は下の Promise.all が担う）
    authenticatePromise.catch(() => undefined)

    const rawWs = this.getRawWebSocket(vrchat)
    rawWs.on('open', callbacks.onOpen)
    rawWs.on('close', callbacks.onClose)
    rawWs.on('error', callbacks.onError)
    rawWs.on('message', callbacks.onMessage)
    rawWs.on('pong', callbacks.onPong)

    // authenticatePromise は Promise.all に渡した時点で rejection handler が
    // 付くため、waitForOpen が先に reject/resolve しても unhandled rejection にならない
    await Promise.all([
      this.waitForOpen(rawWs, openTimeoutMs),
      authenticatePromise,
    ])
  }

  /**
   * raw WebSocket の readyState を取得する
   *
   * raw socket が存在しない場合（reconnect 中など）は例外を投げず CLOSED を返す。
   * health endpoint から無条件に呼ばれるため、ここで例外にすると `/health` への
   * リクエストがプロセスを落としかねない。
   *
   * @param vrchat VRChat クライアント
   * @returns raw WebSocket の readyState、取得できない場合は CLOSED (3)
   */
  getReadyState(vrchat: VRChat): number {
    try {
      return this.getRawWebSocket(vrchat).readyState
    } catch {
      return CLOSED
    }
  }

  /**
   * raw WebSocket へ ping フレームを送信する
   *
   * @param vrchat VRChat クライアント
   */
  ping(vrchat: VRChat): void {
    this.getRawWebSocket(vrchat).ping()
  }

  /**
   * Pipeline を close する
   *
   * SDK の EventEmitter は raw close を再送出しないため、close 完了は待たない。
   * pipeline.close() 自体が投げる例外も、呼び出し側 (Supervisor.reconnect/stop)
   * を巻き込んで reconnect 不能にしないよう、ここで確実に飲み込む (真に best-effort にする)。
   *
   * @param vrchat VRChat クライアント
   */
  close(vrchat: VRChat): void {
    try {
      vrchat.pipeline.close()
    } catch (error) {
      logger.warn(
        `Failed to close pipeline (best-effort): ${toError(error).message}`
      )
    }
  }

  /**
   * VRChat SDK の private 実装から raw WebSocket を取得する
   *
   * @param vrchat VRChat クライアント
   * @returns raw WebSocket
   * @throws raw WebSocket が存在しない場合（reconnect 中など）
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
   * raw WebSocket が OPEN になるまで待つ
   *
   * @param rawWs raw WebSocket
   * @param timeoutMs 待機タイムアウト（ミリ秒）
   * @throws タイムアウト時間内に OPEN にならなかった場合
   */
  private async waitForOpen(
    rawWs: RawWebSocket,
    timeoutMs: number
  ): Promise<void> {
    if (rawWs.readyState === OPEN) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Pipeline WebSocket open timed out after ${timeoutMs}ms`)
        )
      }, timeoutMs)

      rawWs.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
