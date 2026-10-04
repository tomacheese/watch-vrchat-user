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

  // fake の ping/close は呼び出し記録が不要なテストでのみ使うため no-op でよい
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
  it('stop は再接続 backoff のタイマーも解放する', async () => {
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
  it('Cookie 待機中の stop は後続の接続を禁止する', async () => {
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

  it('raw open 前は ready にならず、synchronize 完了後に ready になる', async () => {
    const transport = new FakeTransport()
    let synchronizeResolve = (): void => undefined
    const onSynchronize = jest.fn(
      () =>
        // Promise.withResolvers() の resolve は `(value: void) => void` 型となり
        // no-invalid-void-type と衝突するため、この形のまま使う
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
    // authCookieProvider() / transport.connect() の await チェーン分の
    // microtask をすべて flush するため、macrotask 境界まで待つ
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(supervisor.getState()).toBe('synchronizing')

    // synchronizing 中に silent disconnect が起きても検知できるよう、
    // liveness 監視は synchronize 完了を待たずに開始しているべき
    expect(supervisor.getLastMessageAt()).not.toBeNull()

    synchronizeResolve()
    await startPromise
    expect(supervisor.getState()).toBe('ready')
  })

  it('raw close コールバックで reconnect する', async () => {
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

  it('raw close の close code / reason と無通信時間を診断に残し、reason は整形する', async () => {
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

  it('ready 到達時に liveness (lastMessageAt) が初期化され、raw message でさらに更新される', async () => {
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

  it('reconnect 後、新しい接続の lastMessageAt がリセットされる（stale reconnect storm 防止）', async () => {
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

  it('reconnect のたびに auth cookie provider を再呼び出しする（cookie rotation 対応）', async () => {
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

  it('古い generation からの callback は無視する', async () => {
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
    staleCallbacks.onClose() // 古い generation からの遅延 close
    expect(supervisor.getGeneration()).toBe(generationBeforeStaleEvent)
    expect(supervisor.getState()).toBe('ready')
  })

  it('pong timeout で reconnect する', async () => {
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

  it('pong を受信すると pong timeout がキャンセルされ reconnect しない', async () => {
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

    // ping 送信直後に pong を受信すれば、その ping に対応する timeout は解除される
    // (次の ping (t=20) より前、かつ元の timeout (t=30) より前で検証する)
    jest.advanceTimersByTime(10)
    transport.callbacksByGeneration[0].onPong()
    jest.advanceTimersByTime(5)

    expect(supervisor.getReconnectAttempts()).toBe(0)
    expect(supervisor.getState()).toBe('ready')
    supervisor.stop()
    jest.useRealTimers()
  })
})

/** stale 判定の閾値（3 分）。判定 interval は 60 秒になり、閾値より短い */
const STALE_MS = 180_000

type ProbeDrift = () => Promise<number | null>

/**
 * probe を検証するための supervisor を fake timer 下で起動する
 *
 * ping は timer を進めても発火しないよう、十分に長い間隔にしておく。
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

describe('PipelineSupervisor の stale 判定 (liveness probe)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    logs.length = 0
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('AC-1: 無音が閾値を超えても drift=0 なら再接続しない', async () => {
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

  it('AC-2: 前回の probe から閾値が経つまで probe を繰り返さない', async () => {
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

  it('AC-3: drift が 1 以上なら stale message stream で再接続する', async () => {
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

  it('AC-4: probe が null を返したときは再接続する', async () => {
    const { supervisor } = await startWithProbe(() => Promise.resolve(null))

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    expect(logs.join('\n')).toContain(
      'Pipeline liveness probe: unverified action=reconnect'
    )
    supervisor.stop()
  })

  it('AC-4: probe が例外を投げたときは再接続する', async () => {
    const { supervisor } = await startWithProbe(() =>
      Promise.reject(new Error('probe failed'))
    )

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toHaveLength(1)
    supervisor.stop()
  })

  it('AC-4: probe が probeTimeoutMs 内に完了しないときは再接続する', async () => {
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

  it('AC-5: probe が渡されていなければ従来どおり即座に再接続する', async () => {
    const { supervisor } = await startWithProbe(undefined)

    await jest.advanceTimersByTimeAsync(STALE_MS)

    expect(reconnectTriggered(supervisor)).toMatchObject([
      { reason: 'stale message stream' },
    ])
    supervisor.stop()
  })

  it('AC-6: ready 以外の状態では probe せず即座に再接続する', async () => {
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

  it('AC-7: probe の完了前に generation が変わったら結果を無視する', async () => {
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

  it('AC-8: probe の実行中は次の tick でも 2 つ目の probe を開始しない', async () => {
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

  it('AC-9: probe があっても raw close は従来どおり再接続する', async () => {
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

  it('AC-9: probe があっても pong timeout は従来どおり再接続する', async () => {
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
