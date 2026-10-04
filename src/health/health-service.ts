import { Logger } from '@book000/node-utils'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { toError } from '../logger-utils'
import type {
  PipelineDiagnosticEvent,
  SupervisorState,
} from '../vrchat/pipeline-supervisor'

const logger = Logger.configure('HEALTH')

/** unhealthy なユーザー 1 件分の情報 */
export interface UnhealthyUserSnapshot {
  /** ユーザー ID */
  userId: string
  /** unhealthy の原因 */
  cause: string
  /** unhealthy になった日時（ISO 8601 形式） */
  since: string
}

/** health の総合状態 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/** health endpoint が公開する観測データ */
export interface HealthSnapshot {
  /** Pipeline supervisor の状態 */
  supervisorState: SupervisorState
  /** baseline が保存済みか */
  baselineCompleted?: boolean
  /** 直近の REST 同期障害 */
  lastReconciliationError?: string | null
  /** 通知予定と配信障害 */
  delivery?: import('../notifications/notification-outbox').DeliveryStatus
  /** raw WebSocket の readyState */
  rawReadyState: number
  /** 現在の connection generation */
  generation: number
  /** 最後に raw message を受信した日時 */
  lastMessageAt: string | null
  /** 最後に pong を受信した日時 */
  lastPongAt: string | null
  /** 最後に REST reconciliation を実行した日時 */
  lastReconciliationAt: string | null
  /** reconnect の試行回数 */
  reconnectAttempts: number
  /** 直近の reconnect 理由 */
  lastReconnectReason: string | null
  /** 個人情報を含まない直近の接続診断イベント */
  reconnectHistory: PipelineDiagnosticEvent[]
  /** unhealthy なユーザーの一覧 */
  unhealthyUsers: UnhealthyUserSnapshot[]
  /** 設定ファイルの読み込み状態 */
  config: {
    loadedAt: string | null
    lastReloadError: string | null
    lastReloadFailedAt: string | null
  }
  /** 直近のルール評価エラー（ルール名ごとの集計） */
  ruleErrors: {
    rule: string
    count: number
    lastAt: string
    lastError: string
  }[]
  /** Favorites 取得状態 */
  favorites: { lastUpdatedAt: string | null; lastError: string | null }
}

/**
 * snapshot から総合状態を判定する
 *
 * @param snapshot 観測データ
 * @returns 総合状態
 */
export function evaluateStatus(snapshot: HealthSnapshot): HealthStatus {
  if (
    snapshot.supervisorState !== 'ready' ||
    snapshot.baselineCompleted === false ||
    snapshot.unhealthyUsers.length > 0
  ) {
    return 'unhealthy'
  }
  const isDegraded =
    snapshot.config.lastReloadError !== null ||
    snapshot.ruleErrors.length > 0 ||
    snapshot.favorites.lastError !== null ||
    Boolean(snapshot.lastReconciliationError) ||
    Boolean(snapshot.delivery?.lastError) ||
    (snapshot.delivery?.blocked ?? 0) > 0 ||
    (snapshot.delivery?.uncertain ?? 0) > 0 ||
    Boolean(
      snapshot.delivery?.oldestPendingAt &&
      Date.now() - Date.parse(snapshot.delivery.oldestPendingAt) > 60_000
    )
  return isDegraded ? 'degraded' : 'healthy'
}

/**
 * localhost のみでアクセス可能な health endpoint を提供するクラス
 *
 * 「プロセスは生きている」と「Pipeline が健全」を区別できるよう、
 * supervisor state・raw readyState・generation・各種タイムスタンプ・
 * reconnect の直近履歴・per-user unhealthy を個別に観測可能にする。
 */
export class HealthService {
  private server: http.Server | null = null

  /**
   * HealthService を初期化する
   *
   * @param getSnapshot 最新の観測データを取得する関数
   */
  constructor(private readonly getSnapshot: () => HealthSnapshot) {}

  /**
   * health endpoint サーバーを開始する
   */
  start(): void {
    const port = process.env.HEALTH_PORT
      ? Number.parseInt(process.env.HEALTH_PORT, 10)
      : 3000
    const host = process.env.HEALTH_HOST ?? '127.0.0.1'

    this.server = http.createServer((request, response) => {
      if (request.url === '/health') {
        this.handleHealthCheck(response)
      } else {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('Not Found')
      }
    })

    this.server.listen(port, host, () => {
      logger.info(
        `Health check server listening on http://${host}:${this.getListeningPort()}/health`
      )
    })
  }

  /**
   * 実際に listen しているポート番号を取得する（`HEALTH_PORT=0` の場合の OS 割当ポート含む）
   *
   * @returns ポート番号
   */
  getListeningPort(): number {
    const address = this.server?.address() as AddressInfo | null
    return address?.port ?? 0
  }

  /**
   * health endpoint サーバーを停止する
   */
  stop(): void {
    if (!this.server) return
    this.server.close(() => {
      logger.info('Health check server stopped')
    })
    this.server = null
  }

  /**
   * health check リクエストを処理する
   *
   * @param response HTTP レスポンス
   */
  private handleHealthCheck(response: http.ServerResponse): void {
    let snapshot: HealthSnapshot
    try {
      snapshot = this.getSnapshot()
    } catch (error) {
      logger.error('Failed to build health snapshot', toError(error))
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ status: 'unhealthy' }))
      return
    }
    const status = evaluateStatus(snapshot)
    const statusCode = status === 'unhealthy' ? 503 : 200

    response.writeHead(statusCode, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify(
        {
          status,
          ...snapshot,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    )
  }
}
