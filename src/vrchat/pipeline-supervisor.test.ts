import { PipelineSupervisor } from './pipeline-supervisor'
import type {
  PipelineTransport,
  PipelineTransportCallbacks,
} from './pipeline-transport'
import type { VRChat } from 'vrchat'

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
    jest.useRealTimers()
  })
})
