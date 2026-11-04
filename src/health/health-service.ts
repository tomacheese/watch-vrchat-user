import { Logger } from '@book000/node-utils'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { toError } from '../logger-utils'
import type {
  PipelineDiagnosticEvent,
  SupervisorState,
} from '../vrchat/pipeline-supervisor'

const logger = Logger.configure('HEALTH')

/** Information about one unhealthy user */
export interface UnhealthyUserSnapshot {
  /** User ID */
  userId: string
  /** Cause of the unhealthy state */
  cause: string
  /** When the user became unhealthy (ISO 8601) */
  since: string
}

/** Overall health status */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/** Observation data exposed by the health endpoint */
export interface HealthSnapshot {
  /** State of the Pipeline supervisor */
  supervisorState: SupervisorState
  /** Whether the baseline has been saved */
  baselineCompleted?: boolean
  /** Most recent REST synchronization failure */
  lastReconciliationError?: string | null
  /** Pending notifications and delivery failures */
  delivery?: import('../notifications/notification-outbox').DeliveryStatus
  /** readyState of the raw WebSocket */
  rawReadyState: number
  /** Current connection generation */
  generation: number
  /** When the last raw message was received */
  lastMessageAt: string | null
  /** When the last pong was received */
  lastPongAt: string | null
  /** When REST reconciliation last ran */
  lastReconciliationAt: string | null
  /** Number of reconnect attempts */
  reconnectAttempts: number
  /** Most recent reconnect reason */
  lastReconnectReason: string | null
  /** Recent connection diagnostic events, without personal information */
  reconnectHistory: PipelineDiagnosticEvent[]
  /** List of unhealthy users */
  unhealthyUsers: UnhealthyUserSnapshot[]
  /** Config file load state */
  config: {
    loadedAt: string | null
    lastReloadError: string | null
    lastReloadFailedAt: string | null
  }
  /** Recent rule evaluation errors, aggregated per rule name */
  ruleErrors: {
    rule: string
    count: number
    lastAt: string
    lastError: string
  }[]
  /** Favorites fetch state */
  favorites: { lastUpdatedAt: string | null; lastError: string | null }
}

/**
 * Determines the overall status from a snapshot.
 *
 * @param snapshot Observation data
 * @returns Overall status
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
 * Serves a health endpoint reachable from localhost only (overridable via env).
 *
 * To distinguish "the process is alive" from "the Pipeline is healthy", the
 * supervisor state, raw readyState, generation, timestamps, recent reconnect
 * history and per-user unhealthy state are each observable.
 */
export class HealthService {
  private server: http.Server | null = null

  /**
   * Creates a HealthService.
   *
   * @param getSnapshot Function that returns the latest observation data
   */
  constructor(private readonly getSnapshot: () => HealthSnapshot) {}

  /**
   * Starts the health endpoint server.
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
   * Gets the port actually being listened on (including the OS-assigned port when `HEALTH_PORT=0`).
   *
   * @returns Port number
   */
  getListeningPort(): number {
    const address = this.server?.address() as AddressInfo | null
    return address?.port ?? 0
  }

  /**
   * Stops the health endpoint server.
   */
  stop(): void {
    if (!this.server) return
    this.server.close(() => {
      logger.info('Health check server stopped')
    })
    this.server = null
  }

  /**
   * Handles a health check request.
   *
   * @param response HTTP response
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
