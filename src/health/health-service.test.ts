import * as http from 'node:http'
import { HealthService, type HealthSnapshot } from './health-service'

async function waitForListening(service: HealthService): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = service.getListeningPort()
    if (port !== 0) return port
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('HealthService did not start listening in time')
}

function fetchJson(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (response) => {
        let raw = ''
        response.on('data', (chunk: Buffer) => (raw += chunk.toString()))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) })
        })
      })
      .on('error', reject)
  })
}

describe('HealthService', () => {
  const healthySnapshot: HealthSnapshot = {
    supervisorState: 'ready',
    rawReadyState: 1,
    generation: 3,
    lastMessageAt: new Date().toISOString(),
    lastPongAt: new Date().toISOString(),
    lastReconciliationAt: new Date().toISOString(),
    reconnectAttempts: 0,
    lastReconnectReason: null,
    reconnectHistory: [],
    unhealthyUsers: [],
    config: {
      loadedAt: new Date().toISOString(),
      lastReloadError: null,
      lastReloadFailedAt: null,
    },
    ruleErrors: [],
    favorites: { lastUpdatedAt: new Date().toISOString(), lastError: null },
  }

  afterEach(() => {
    delete process.env.HEALTH_PORT
    delete process.env.HEALTH_HOST
  })

  it('returns 200 when healthy', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => healthySnapshot)
    service.start()
    const port = await waitForListening(service)

    const { status, body } = await fetchJson(port)
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('healthy')

    service.stop()
  })

  it('returns 503 when supervisorState is not ready', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => ({
      ...healthySnapshot,
      supervisorState: 'reconnecting',
    }))
    service.start()
    const port = await waitForListening(service)

    const { status } = await fetchJson(port)
    expect(status).toBe(503)

    service.stop()
  })

  it('returns 503 when unhealthyUsers exist', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => ({
      ...healthySnapshot,
      unhealthyUsers: [
        {
          userId: 'usr_1',
          cause: 'queue-overflow',
          since: new Date().toISOString(),
        },
      ],
    }))
    service.start()
    const port = await waitForListening(service)

    const { status } = await fetchJson(port)
    expect(status).toBe(503)

    service.stop()
  })

  it('returns 503 without crashing the process when getSnapshot throws', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => {
      throw new Error('Pipeline raw WebSocket is not available')
    })
    service.start()
    const port = await waitForListening(service)

    const { status } = await fetchJson(port)
    expect(status).toBe(503)

    service.stop()
  })

  const degradedCases: [string, Partial<HealthSnapshot>][] = [
    [
      'config reload failure',
      {
        config: {
          loadedAt: null,
          lastReloadError: 'bad yaml',
          lastReloadFailedAt: new Date().toISOString(),
        },
      },
    ],
    [
      'rule error',
      {
        ruleErrors: [
          {
            rule: 'r',
            count: 1,
            lastAt: new Date().toISOString(),
            lastError: 'e',
          },
        ],
      },
    ],
    [
      'favorites fetch failure',
      {
        favorites: { lastUpdatedAt: null, lastError: 'Rate limit error (429)' },
      },
    ],
  ]

  it.each(degradedCases)(
    'returns degraded with 200 on %s',
    async (_name, patch) => {
      process.env.HEALTH_PORT = '0'
      const service = new HealthService(() => ({
        ...healthySnapshot,
        ...patch,
      }))
      service.start()
      const port = await waitForListening(service)

      const { status, body } = await fetchJson(port)
      expect(status).toBe(200)
      expect((body as { status: string }).status).toBe('degraded')

      service.stop()
    }
  )

  it('unhealthy conditions take precedence over degraded conditions', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => ({
      ...healthySnapshot,
      supervisorState: 'reconnecting',
      favorites: { lastUpdatedAt: null, lastError: 'x' },
    }))
    service.start()
    const port = await waitForListening(service)

    const { status, body } = await fetchJson(port)
    expect(status).toBe(503)
    expect((body as { status: string }).status).toBe('unhealthy')

    service.stop()
  })
})
