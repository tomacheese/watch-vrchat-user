import {
  PipelineSupervisor,
  type PipelineSupervisorOptions,
} from './pipeline-supervisor'
import type {
  PipelineTransport,
  PipelineTransportCallbacks,
} from './pipeline-transport'
import type { VRChat } from 'vrchat'

const logs: string[] = []
jest.mock('@book000/node-utils', () => {
  const record = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return {
    Logger: {
      configure: () => ({
        info: record,
        warn: record,
        error: record,
        debug: record,
      }),
    },
  }
})

class FakeTransport implements PipelineTransport {
  callbacksByGeneration: PipelineTransportCallbacks[] = []
  connectResults: (() => Promise<void>)[] = []
  readyState = 1

  async connect(
    _vrchat: VRChat,
    _authCookie: string,
    callbacks: PipelineTransportCallbacks
  ): Promise<void> {
    this.callbacksByGeneration.push(callbacks)
    const fn = this.connectResults.shift()
    if (fn) {
      await fn()
    }
  }

  // The fake's ping/close are only used by tests that need no call records, so no-ops suffice
  /* eslint-disable @typescript-eslint/no-empty-function */
  ping(): void {}
  close(): void {}
  /* eslint-enable @typescript-eslint/no-empty-function */
  getReadyState(): number {
    return this.readyState
  }
}

const fakeVrchat = {} as VRChat

describe('PipelineSupervisor', () => {
  it('stop also releases the reconnect backoff timer', async () => {
    jest.useFakeTimers()
    try {
      const transport = new FakeTransport()
      const supervisor = new PipelineSupervisor(
        fakeVrchat,
        transport,
        jest.fn().mockResolvedValue(undefined),
        { initialBackoffMs: 100_000 }
      )
      await supervisor.start(() => Promise.resolve('cookie'))
      supervisor.requestReconnect('manual')
      supervisor.stop()
      await Promise.resolve()
      expect(jest.getTimerCount()).toBe(0)
      expect(transport.callbacksByGeneration).toHaveLength(1)
      expect(supervisor.getState()).toBe('stopped')
    } finally {
      jest.useRealTimers()
    }
  })
  it('stop while waiting for the cookie prevents the subsequent connection', async () => {
    const cookie = Promise.withResolvers<string>()
    const transport = new FakeTransport()
    const synchronize = jest.fn()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      synchronize
    )
    const start = supervisor.start(() => cookie.promise)
    supervisor.stop()
    cookie.resolve('late-cookie')
    await start
    expect(transport.callbacksByGeneration).toHaveLength(0)
    expect(synchronize).not.toHaveBeenCalled()
    expect(supervisor.getState()).toBe('stopped')
  })

  it('is not ready before raw open and becomes ready after synchronize completes', async () => {
    const transport = new FakeTransport()
    let synchronizeResolve = (): void => undefined
    const onSynchronize = jest.fn(
      () =>
        // The resolve of Promise.withResolvers() is typed `(value: void) => void`,
        // which conflicts with no-invalid-void-type, so it is used as-is
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          synchronizeResolve = resolve
        })
    )
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      onSynchronize
    )

    const startPromise = supervisor.start(() => Promise.resolve('cookie'))
    // Wait until the macrotask boundary to flush all microtasks of the
    // authCookieProvider() / transport.connect() await chain
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(supervisor.getState()).toBe('synchronizing')

    // So that a silent disconnect during synchronizing is detected, liveness
    // monitoring must start without waiting for synchronize to complete
    expect(supervisor.getLastMessageAt()).not.toBeNull()

    synchronizeResolve()
    await startPromise
    expect(supervisor.getState()).toBe('ready')
  })

  it('reconnects on the raw close callback', async () => {
    const transport = new FakeTransport()
    const onSynchronize = jest.fn().mockResolvedValue(undefined)
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      onSynchronize,
      {
        initialBackoffMs: 1,
        maxBackoffMs: 2,
      }
    )

    await supervisor.start(() => Promise.resolve('cookie'))
    expect(supervisor.getState()).toBe('ready')

    transport.callbacksByGeneration[0].onClose()
    expect(supervisor.getState()).toBe('reconnecting')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(supervisor.getState()).toBe('ready')
    expect(transport.callbacksByGeneration.length).toBe(2)
  })

  it('records the raw close code / reason and silence duration in diagnostics, sanitizing the reason', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      { initialBackoffMs: 1, maxBackoffMs: 2 }
    )
    await supervisor.start(() => Promise.resolve('cookie'))

    transport.callbacksByGeneration[0].onClose(
      1006,
      Buffer.from(`bad\nreason<script>${'x'.repeat(100)}`)
    )

    const triggered = supervisor
      .getDiagnosticHistory()
      .find((event) => event.event === 'reconnect-triggered')
    expect(triggered).toMatchObject({ reason: 'raw close', closeCode: 1006 })
    expect(triggered?.closeReason).toMatch(/^[\w .:-]{1,64}$/)
    expect(triggered?.closeReason).not.toContain('<')
    expect(triggered?.msSinceLastMessage).toBeGreaterThanOrEqual(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('initializes liveness (lastMessageAt) on reaching ready and updates it on raw messages', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(fakeVrchat, transport, () =>
      Promise.resolve()
    )
    await supervisor.start(() => Promise.resolve('cookie'))

    const readyAt = supervisor.getLastMessageAt()
    expect(readyAt).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 5))
    transport.callbacksByGeneration[0].onMessage(Buffer.from(''))
    expect(supervisor.getLastMessageAt()?.getTime()).toBeGreaterThan(
      readyAt?.getTime() ?? 0
    )
  })

  it('resets lastMessageAt for the new connection after reconnect (prevents a stale reconnect storm)', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      { initialBackoffMs: 1, maxBackoffMs: 2 }
    )
    await supervisor.start(() => Promise.resolve('cookie'))
    transport.callbacksByGeneration[0].onMessage(Buffer.from(''))
    const firstMessageAt = supervisor.getLastMessageAt()

    await new Promise((resolve) => setTimeout(resolve, 5))
    supervisor.requestReconnect('manual')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(supervisor.getState()).toBe('ready')
    const afterReconnect = supervisor.getLastMessageAt()
    expect(afterReconnect).not.toBeNull()
    expect(afterReconnect?.getTime()).toBeGreaterThan(
      firstMessageAt?.getTime() ?? 0
    )
  })

  it('calls the auth cookie provider again on every reconnect (handles cookie rotation)', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      { initialBackoffMs: 1, maxBackoffMs: 2 }
    )
    const cookies = ['cookie-1', 'cookie-2']
    const getAuthCookie = jest.fn(() => Promise.resolve(cookies.shift() ?? ''))

    await supervisor.start(getAuthCookie)
    expect(getAuthCookie).toHaveBeenCalledTimes(1)

    supervisor.requestReconnect('manual')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(getAuthCookie).toHaveBeenCalledTimes(2)
  })

  it('ignores callbacks from an old generation', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      {
        initialBackoffMs: 1,
        maxBackoffMs: 2,
      }
    )
    await supervisor.start(() => Promise.resolve('cookie'))

    const staleCallbacks = transport.callbacksByGeneration[0]
    supervisor.requestReconnect('manual')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const generationBeforeStaleEvent = supervisor.getGeneration()
    staleCallbacks.onClose() // Late close from an old generation
    expect(supervisor.getGeneration()).toBe(generationBeforeStaleEvent)
    expect(supervisor.getState()).toBe('ready')
  })

  it('reconnects on pong timeout', async () => {
    jest.useFakeTimers()
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      {
        pingIntervalMs: 10,
        pongTimeoutMs: 20,
        initialBackoffMs: 1,
        maxBackoffMs: 2,
      }
    )
    await supervisor.start(() => Promise.resolve('cookie'))

    jest.advanceTimersByTime(40)
    expect(supervisor.getReconnectAttempts()).toBeGreaterThan(0)
    supervisor.stop()
    jest.useRealTimers()
  })

  it('receiving a pong cancels the pong timeout and does not reconnect', async () => {
    jest.useFakeTimers()
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => Promise.resolve(),
      {
        pingIntervalMs: 10,
        pongTimeoutMs: 20,
        initialBackoffMs: 1,
        maxBackoffMs: 2,
      }
    )
    await supervisor.start(() => Promise.resolve('cookie'))

    // A pong received right after a ping clears the timeout for that ping
    // (verified before the next ping (t=20) and before the original timeout (t=30))
    jest.advanceTimersByTime(10)
    transport.callbacksByGeneration[0].onPong()
    jest.advanceTimersByTime(5)

    expect(supervisor.getReconnectAttempts()).toBe(0)
    expect(supervisor.getState()).toBe('ready')
    supervisor.stop()
    jest.useRealTimers()
  })
})

/** Stale threshold (3 minutes). The check interval becomes 60 seconds, shorter than the threshold */
const STALE_MS = 180_000

type ProbeDrift = () => Promise<number | null>

/**
 * Starts a supervisor under fake timers to verify the probe.
 *
 * The ping interval is made long enough that ping never fires when timers advance.
 */
async function startWithProbe(
  probeDrift: ProbeDrift | undefined,
  options: PipelineSupervisorOptions = {}
): Promise<{ transport: FakeTransport; supervisor: PipelineSupervisor }> {
  const transport = new FakeTransport()
  const supervisorOptions: PipelineSupervisorOptions = {
    staleMessageTimeoutMs: STALE_MS,
    pingIntervalMs: 2_000_000_000,
    initialBackoffMs: 1,
    maxBackoffMs: 2,
    probeDrift,
    ...options,
  }
  const supervisor = new PipelineSupervisor(
    fakeVrchat,
    transport,
    () => Promise.resolve(),
    supervisorOptions
  )
  await supervisor.start(() => Promise.resolve('cookie'))
  return { transport, supervisor }
}

function reconnectTriggered(supervisor: PipelineSupervisor) {
  return supervisor
    .getDiagnosticHistory()
    .filter((event) => event.event === 'reconnect-triggered')
}

describe('PipelineSupervisor stale detection (liveness probe)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    logs.length = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('AC-1: does not reconnect when silence exceeds the threshold but drift=0', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(0))
    const { supervisor } = await startWithProbe(probeDrift)

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(probeDrift).toHaveBeenCalledTimes(1)
    expect(reconnectTriggered(supervisor)).toEqual([])
    expect(supervisor.getGeneration()).toBe(0)
    expect(logs.join('\n')).toContain(
      'Pipeline liveness probe: drift=0 action=keep'
    )
    supervisor.stop()
  })

  it('AC-2: does not repeat the probe until the threshold has elapsed since the last probe', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(0))
    const { supervisor } = await startWithProbe(probeDrift)

    await jest.advanceTimersByTimeAsync(STALE_MS)
    expect(probeDrift).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(STALE_MS - 60_000)
    expect(probeDrift).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(60_000)
    expect(probeDrift).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('AC-3: reconnects with stale message stream when drift is 1 or more', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(2))
    const { supervisor } = await startWithProbe(probeDrift)

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toMatchObject([
      { reason: 'stale message stream' },
    ])
    expect(logs.join('\n')).toContain(
      'Pipeline liveness probe: drift=2 action=reconnect'
    )
    supervisor.stop()
  })

  it('AC-4: reconnects when the probe returns null', async () => {
    const { supervisor } = await startWithProbe(() => Promise.resolve(null))

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    expect(logs.join('\n')).toContain(
      'Pipeline liveness probe: unverified action=reconnect'
    )
    supervisor.stop()
  })

  it('AC-4: reconnects when the probe throws', async () => {
    const { supervisor } = await startWithProbe(() =>
      Promise.reject(new Error('probe failed'))
    )

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    supervisor.stop()
  })

  it('AC-4: reconnects when the probe does not finish within probeTimeoutMs', async () => {
    const { supervisor } = await startWithProbe(
      () => new Promise<number | null>(() => undefined),
      { probeTimeoutMs: 5000 }
    )

    await jest.advanceTimersByTimeAsync(STALE_MS)
    expect(reconnectTriggered(supervisor)).toEqual([])

    await jest.advanceTimersByTimeAsync(5000)
    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    supervisor.stop()
  })

  it('AC-5: reconnects immediately when no probe is given', async () => {
    const { supervisor } = await startWithProbe(undefined)

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toMatchObject([
      { reason: 'stale message stream' },
    ])
    supervisor.stop()
  })

  it('AC-6: reconnects immediately without probing outside the ready state', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(0))
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(
      fakeVrchat,
      transport,
      () => new Promise<void>(() => undefined),
      {
        staleMessageTimeoutMs: STALE_MS,
        pingIntervalMs: 2_000_000_000,
        initialBackoffMs: 1,
        maxBackoffMs: 2,
        probeDrift,
      }
    )
    supervisor.start(() => Promise.resolve('cookie')).catch(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    expect(supervisor.getState()).toBe('synchronizing')

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(probeDrift).not.toHaveBeenCalled()
    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    supervisor.stop()
  })

  it('AC-7: ignores the result if the generation changes before the probe completes', async () => {
    const { promise, resolve: resolveProbe } = Promise.withResolvers<
      number | null
    >()
    const probeDrift = jest.fn(() => promise)
    const { transport, supervisor } = await startWithProbe(probeDrift, {
      probeTimeoutMs: 600_000,
    })

    await jest.advanceTimersByTimeAsync(STALE_MS)
    expect(probeDrift).toHaveBeenCalledTimes(1)

    transport.callbacksByGeneration[0].onClose()
    await jest.advanceTimersByTimeAsync(10)
    expect(supervisor.getGeneration()).toBe(1)
    expect(reconnectTriggered(supervisor)).toHaveLength(1)

    resolveProbe(5)
    await jest.advanceTimersByTimeAsync(0)

    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    expect(supervisor.getGeneration()).toBe(1)
    supervisor.stop()
  })

  it('AC-8: does not start a second probe on the next tick while one is running', async () => {
    const probeDrift = jest.fn(
      () => new Promise<number | null>(() => undefined)
    )
    const { supervisor } = await startWithProbe(probeDrift, {
      probeTimeoutMs: 600_000,
    })

    await jest.advanceTimersByTimeAsync(STALE_MS)
    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(probeDrift).toHaveBeenCalledTimes(1)
    supervisor.stop()
  })

  it('AC-9: still reconnects on raw close even with a probe', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(0))
    const { transport, supervisor } = await startWithProbe(probeDrift)

    transport.callbacksByGeneration[0].onClose(1006)

    expect(reconnectTriggered(supervisor)).toMatchObject([
      { reason: 'raw close' },
    ])
    expect(probeDrift).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(10)
    supervisor.stop()
  })

  it('AC-9: still reconnects on pong timeout even with a probe', async () => {
    const probeDrift = jest.fn(() => Promise.resolve<number | null>(0))
    const { supervisor } = await startWithProbe(probeDrift, {
      pingIntervalMs: 10,
      pongTimeoutMs: 20,
    })

    await jest.advanceTimersByTimeAsync(40)

    expect(reconnectTriggered(supervisor)).toMatchObject([
      { reason: 'pong timeout' },
    ])
    expect(probeDrift).not.toHaveBeenCalled()
    supervisor.stop()
  })
})
