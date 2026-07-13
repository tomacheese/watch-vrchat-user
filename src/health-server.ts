import * as http from 'node:http'
import type { WebSocketMonitor } from './websocket-monitor'

/**
 * ヘルスチェックサーバー
 *
 * localhost のみでアクセス可能な HTTP サーバーを提供し、
 * WebSocket 接続状態と最後のイベント受信時刻を返す
 */
export class HealthServer {
  private server: http.Server | null = null
  private monitor: WebSocketMonitor

  /** ヘルスチェックサーバーのポート */
  private readonly PORT = process.env.HEALTH_PORT
    ? Number.parseInt(process.env.HEALTH_PORT, 10)
    : 3000

  /** ヘルスチェックサーバーのホスト */
  private readonly HOST = process.env.HEALTH_HOST ?? '127.0.0.1'

  /**
   * イベント未受信の unhealthy 閾値（ミリ秒）
   *
   * 最後のイベント受信時刻がこの時間以上古い場合、unhealthy と判定する。
   *
   * 注: WebSocketMonitor の EVENT_TIMEOUT_WARNING (6 時間) やサイレント接続死の判定 (6 時間) とは
   * 異なる閾値を使用している。これは、ヘルスチェックでより早く異常を検出し、外部監視システムに
   * 通知するための設計。自動再接続は 6 時間後に発動する。
   */
  private readonly EVENT_TIMEOUT_UNHEALTHY = 3 * 60 * 60 * 1000 // 3 時間

  /**
   * ヘルスチェックサーバーを初期化する
   *
   * @param monitor WebSocket 接続監視
   */
  constructor(monitor: WebSocketMonitor) {
    this.monitor = monitor
  }

  /**
   * ヘルスチェックサーバーを開始する
   */
  start(): void {
    this.server = http.createServer(
      (request: http.IncomingMessage, response: http.ServerResponse) => {
        if (request.url === '/health') {
          this.handleHealthCheck(response)
        } else {
          response.writeHead(404, { 'Content-Type': 'text/plain' })
          response.end('Not Found')
        }
      }
    )

    this.server.listen(this.PORT, this.HOST, () => {
      console.log(
        `[HEALTH] Health check server listening on http://${this.HOST}:${this.PORT}/health`
      )
    })
  }

  /**
   * ヘルスチェックサーバーを停止する
   */
  stop(): void {
    if (!this.server) {
      return
    }

    this.server.close(() => {
      console.log('[HEALTH] Health check server stopped')
    })
    this.server = null
  }

  /**
   * ヘルスチェックリクエストを処理する
   *
   * @param response HTTP レスポンス
   */
  private handleHealthCheck(response: http.ServerResponse): void {
    const state = this.monitor.getState()
    const lastEventTime = this.monitor.getLastEventTime()
    const reconnectAttempts = this.monitor.getReconnectAttempts()
    const isReconnecting = this.monitor.getIsReconnecting()

    // ヘルス判定
    let isHealthy = state === 'connected'
    let timeSinceLastEventHours: number | null = null

    // lastEventTime が存在する場合、経過時間を計算
    if (lastEventTime) {
      const now = new Date()
      const timeSinceLastEvent = now.getTime() - lastEventTime.getTime()
      timeSinceLastEventHours = timeSinceLastEvent / 1000 / 60 / 60

      // 3 時間以上経過している場合は unhealthy
      if (timeSinceLastEvent >= this.EVENT_TIMEOUT_UNHEALTHY) {
        isHealthy = false
      }
    }

    const statusCode = isHealthy ? 200 : 503

    const healthStatus = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      connectionState: state,
      lastEventTime: lastEventTime ? lastEventTime.toISOString() : null,
      timeSinceLastEventHours,
      reconnectAttempts,
      isReconnecting,
      timestamp: new Date().toISOString(),
    }

    response.writeHead(statusCode, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(healthStatus, null, 2))
  }
}
