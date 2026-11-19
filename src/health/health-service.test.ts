import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HealthService, type HealthSnapshot } from './health-service'

const mockLog = jest.fn<undefined, unknown[]>()
const mockError = jest.fn<undefined, unknown[]>()
jest.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      info: (...args: unknown[]) => {
        mockLog(...args)
      },
      warn: (...args: unknown[]) => {
        mockLog(...args)
      },
      error: (...args: unknown[]) => {
        mockError(...args)
      },
      debug: (...args: unknown[]) => {
        mockLog(...args)
      },
    }),
  },
}))

/** Occupies a free localhost port and returns the server and its port. */
async function occupyPort(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, port: (server.address() as AddressInfo).port }
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
    await service.start()
    const port = service.getListeningPort()

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
    await service.start()
    const port = service.getListeningPort()

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
    await service.start()
    const port = service.getListeningPort()

    const { status } = await fetchJson(port)
    expect(status).toBe(503)

    service.stop()
  })

  it('returns 503 without crashing the process when getSnapshot throws', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => {
      throw new Error('Pipeline raw WebSocket is not available')
    })
    await service.start()
    const port = service.getListeningPort()

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
      await service.start()
      const port = service.getListeningPort()

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
    await service.start()
    const port = service.getListeningPort()

    const { status, body } = await fetchJson(port)
    expect(status).toBe(503)
    expect((body as { status: string }).status).toBe('unhealthy')

    service.stop()
  })

  describe('start failures', () => {
    beforeEach(() => {
      mockError.mockClear()
    })

    it('rejects with the host and port when the port is occupied', async () => {
      const { server, port } = await occupyPort()
      try {
        process.env.HEALTH_PORT = String(port)
        const service = new HealthService(() => healthySnapshot)

        await expect(service.start()).rejects.toThrow(
          new RegExp(
            String.raw`^Failed to start health check server on 127\.0\.0\.1:${port}: .*listen EADDRINUSE`
          )
        )
        expect(service.getListeningPort()).toBe(0)
        expect(() => {
          service.stop()
        }).not.toThrow()
      } finally {
        server.close()
      }
    })

    it('rejects instead of throwing synchronously on an invalid port', async () => {
      process.env.HEALTH_PORT = '99999'
      const service = new HealthService(() => healthySnapshot)

      await expect(service.start()).rejects.toThrow(
        'Failed to start health check server on 127.0.0.1:99999'
      )
      expect(service.getListeningPort()).toBe(0)
    })

    it('logs a server error emitted after a successful start without throwing', async () => {
      process.env.HEALTH_PORT = '0'
      const service = new HealthService(() => healthySnapshot)
      await service.start()
      try {
        const { server } = service as unknown as { server: http.Server }
        const failure = new Error('socket exploded')

        expect(() => server.emit('error', failure)).not.toThrow()
        expect(mockError).toHaveBeenCalledWith(
          'Health check server error',
          failure
        )
      } finally {
        service.stop()
      }
    })
  })
})
