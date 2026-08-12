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

    const startPromise = supervisor.start('cookie')
    await Promise.resolve()
    expect(supervisor.getState()).toBe('synchronizing')

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

    await supervisor.start('cookie')
    expect(supervisor.getState()).toBe('ready')

    transport.callbacksByGeneration[0].onClose()
    expect(supervisor.getState()).toBe('reconnecting')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(supervisor.getState()).toBe('ready')
    expect(transport.callbacksByGeneration.length).toBe(2)
  })

  it('raw message は liveness (lastMessageAt) を更新する', async () => {
    const transport = new FakeTransport()
    const supervisor = new PipelineSupervisor(fakeVrchat, transport, () =>
      Promise.resolve()
    )
    await supervisor.start('cookie')

    expect(supervisor.getLastMessageAt()).toBeNull()
    transport.callbacksByGeneration[0].onMessage(Buffer.from(''))
    expect(supervisor.getLastMessageAt()).not.toBeNull()
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
    await supervisor.start('cookie')

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
    await supervisor.start('cookie')

    jest.advanceTimersByTime(40)
    expect(supervisor.getReconnectAttempts()).toBeGreaterThan(0)
    jest.useRealTimers()
  })
})
