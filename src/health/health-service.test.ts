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
    unhealthyUsers: [],
  }

  afterEach(() => {
    delete process.env.HEALTH_PORT
    delete process.env.HEALTH_HOST
  })

  it('healthy な状態では 200 を返す', async () => {
    process.env.HEALTH_PORT = '0'
    const service = new HealthService(() => healthySnapshot)
    service.start()
    const port = await waitForListening(service)

    const { status, body } = await fetchJson(port)
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('healthy')

    service.stop()
  })

  it('supervisorState が ready 以外の場合は 503 を返す', async () => {
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

  it('unhealthyUsers が存在する場合は 503 を返す', async () => {
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
})
