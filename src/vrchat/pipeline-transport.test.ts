import { EventEmitter } from 'node:events'
import { PipelineTransportAdapter } from './pipeline-transport'
import type { VRChat } from 'vrchat'

// The real raw WebSocket (the ws library) has a Node-style EventEmitter API,
// so the fake follows it (an EventTarget does not match the on()/emit() shape).
// eslint-disable-next-line unicorn/prefer-event-target
class FakeRawWebSocket extends EventEmitter {
  readyState = 0 // CONNECTING
  ping = jest.fn()
}

function fakeVRChat(
  rawWs: FakeRawWebSocket,
  authenticate: jest.Mock,
  close: jest.Mock = jest.fn()
): VRChat {
  return {
    pipeline: { authenticate, websocket: rawWs, close },
  } as unknown as VRChat
}

describe('PipelineTransportAdapter.connect', () => {
  it('registers listeners on the raw socket right after authenticate starts, then waits for OPEN', async () => {
    const rawWs = new FakeRawWebSocket()
    const authenticate = jest.fn().mockImplementation(async () => {
      // Listeners must already be registered even if open fires before authenticate resolves
      await new Promise((resolve) => setImmediate(resolve))
      rawWs.readyState = 1 // OPEN
      rawWs.emit('open')
    })
    const vrchat = fakeVRChat(rawWs, authenticate)
    const adapter = new PipelineTransportAdapter()

    const onOpen = jest.fn()
    await adapter.connect(vrchat, 'cookie', {
      onOpen,
      onClose: jest.fn(),
      onError: jest.fn(),
      onMessage: jest.fn(),
      onPong: jest.fn(),
    })

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(authenticate).toHaveBeenCalledWith('cookie')
  })

  it('rejects when waiting for OPEN times out', async () => {
    const rawWs = new FakeRawWebSocket()
    const authenticate = jest.fn().mockResolvedValue(undefined)
    const vrchat = fakeVRChat(rawWs, authenticate)
    const adapter = new PipelineTransportAdapter()

    await expect(
      adapter.connect(
        vrchat,
        'cookie',
        {
          onOpen: jest.fn(),
          onClose: jest.fn(),
          onError: jest.fn(),
          onMessage: jest.fn(),
          onPong: jest.fn(),
        },
        10
      )
    ).rejects.toThrow(/timed out/)
  })

  it('does not cause an unhandled rejection if authenticate rejects after the OPEN timeout', async () => {
    const rawWs = new FakeRawWebSocket()
    // The resolve of Promise.withResolvers() is typed `(value: void) => void`,
    // which conflicts with no-invalid-void-type, so it is used as-is
    const { promise: authenticatePromise, reject: rejectAuthenticate } =
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
      Promise.withResolvers<void>()
    const authenticate = jest.fn().mockImplementation(() => authenticatePromise)
    const vrchat = fakeVRChat(rawWs, authenticate)
    const adapter = new PipelineTransportAdapter()

    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)

    await expect(
      adapter.connect(
        vrchat,
        'cookie',
        {
          onOpen: jest.fn(),
          onClose: jest.fn(),
          onError: jest.fn(),
          onMessage: jest.fn(),
          onPong: jest.fn(),
        },
        10
      )
    ).rejects.toThrow(/timed out/)

    rejectAuthenticate(new Error('cookie is expired'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(unhandled).not.toHaveBeenCalled()
    process.off('unhandledRejection', unhandled)
  })

  it('bridges raw message/pong to the liveness callbacks', async () => {
    const rawWs = new FakeRawWebSocket()
    rawWs.readyState = 1
    const authenticate = jest.fn().mockResolvedValue(undefined)
    const vrchat = fakeVRChat(rawWs, authenticate)
    const adapter = new PipelineTransportAdapter()

    const onMessage = jest.fn()
    const onPong = jest.fn()
    await adapter.connect(vrchat, 'cookie', {
      onOpen: jest.fn(),
      onClose: jest.fn(),
      onError: jest.fn(),
      onMessage,
      onPong,
    })

    rawWs.emit('message', Buffer.from('{}'))
    rawWs.emit('pong')

    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onPong).toHaveBeenCalledTimes(1)
  })
})

describe('PipelineTransportAdapter lifecycle recovery', () => {
  it('treats a close before OPEN as an immediate failure and removes the waiting listeners', async () => {
    const raw = new FakeRawWebSocket()
    const adapter = new PipelineTransportAdapter()
    const pending = adapter.connect(
      fakeVRChat(raw, jest.fn().mockResolvedValue(undefined)),
      'cookie',
      {
        onOpen: jest.fn(),
        onClose: jest.fn(),
        onError: jest.fn(),
        onMessage: jest.fn(),
        onPong: jest.fn(),
      },
      100_000
    )
    raw.emit('close')
    await expect(pending).rejects.toThrow('closed before opening')
    expect(raw.listenerCount('open')).toBe(1)
    expect(raw.listenerCount('close')).toBe(1)
  })

  it('close stops the old socket from forwarding messages to the SDK', () => {
    const raw = new FakeRawWebSocket()
    const sdkMessage = jest.fn()
    raw.on('message', sdkMessage)
    const adapter = new PipelineTransportAdapter()
    adapter.close(fakeVRChat(raw, jest.fn()))
    raw.emit('message', Buffer.from('{}'))
    expect(sdkMessage).not.toHaveBeenCalled()
  })
})

describe('PipelineTransportAdapter.getReadyState / ping / close', () => {
  it('returns the raw socket readyState', () => {
    const rawWs = new FakeRawWebSocket()
    rawWs.readyState = 1
    const vrchat = fakeVRChat(rawWs, jest.fn())
    const adapter = new PipelineTransportAdapter()
    expect(adapter.getReadyState(vrchat)).toBe(1)
  })

  it('returns CLOSED without throwing when no raw socket exists', () => {
    const vrchat = {
      pipeline: { authenticate: jest.fn(), websocket: undefined },
    } as unknown as VRChat
    const adapter = new PipelineTransportAdapter()
    expect(adapter.getReadyState(vrchat)).toBe(3)
  })

  it('ping calls the raw socket ping', () => {
    const rawWs = new FakeRawWebSocket()
    const vrchat = fakeVRChat(rawWs, jest.fn())
    const adapter = new PipelineTransportAdapter()
    adapter.ping(vrchat)
    expect(rawWs.ping).toHaveBeenCalledTimes(1)
  })

  it('close calls pipeline.close on a best-effort basis', () => {
    const rawWs = new FakeRawWebSocket()
    const close = jest.fn()
    const vrchat = fakeVRChat(rawWs, jest.fn(), close)
    const adapter = new PipelineTransportAdapter()
    adapter.close(vrchat)

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('close does not propagate an exception thrown by pipeline.close', () => {
    const rawWs = new FakeRawWebSocket()
    const close = jest.fn().mockImplementation(() => {
      throw new Error('already closed')
    })
    const vrchat = fakeVRChat(rawWs, jest.fn(), close)
    const adapter = new PipelineTransportAdapter()

    expect(() => {
      adapter.close(vrchat)
    }).not.toThrow()
  })
})
