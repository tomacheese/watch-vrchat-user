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
    if (this.server) {
      this.server.close(() => {
        console.log('[HEALTH] Health check server stopped')
      })
      this.server = null
    }
  }

  /**
   * ヘルスチェックリクエストを処理する
   *
   * @param response HTTP レスポンス
   */
  private handleHealthCheck(response: http.ServerResponse): void {
    const state = this.monitor.getState()
    const lastEventTime = this.monitor.getLastEventTime()

    // 接続状態が connected でない場合は 503 を返す
    const isHealthy = state === 'connected'
    const statusCode = isHealthy ? 200 : 503

    const healthStatus = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      connectionState: state,
      lastEventTime: lastEventTime ? lastEventTime.toISOString() : null,
      timestamp: new Date().toISOString(),
    }

    response.writeHead(statusCode, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(healthStatus, null, 2))
  }
}
