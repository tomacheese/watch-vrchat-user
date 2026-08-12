import { EventEmitter } from 'node:events'
import { PipelineTransportAdapter } from './pipeline-transport'
import type { VRChat } from 'vrchat'

class FakeRawWebSocket extends EventEmitter {
  readyState = 0 // CONNECTING
  ping = jest.fn()
}

function fakeVRChat(rawWs: FakeRawWebSocket, authenticate: jest.Mock): VRChat {
  return {
    pipeline: { authenticate, websocket: rawWs, close: jest.fn() },
  } as unknown as VRChat
}

describe('PipelineTransportAdapter.connect', () => {
  it('authenticate 開始後、即座に raw socket へ listener を登録してから OPEN を待つ', async () => {
    const rawWs = new FakeRawWebSocket()
    const authenticate = jest.fn().mockImplementation(async () => {
      // authenticate が resolve する前に open を発火させても listener は既に登録済みであること
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

  it('OPEN 待機がタイムアウトすると reject する', async () => {
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

  it('raw message/pong を liveness コールバックへ橋渡しする', async () => {
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

describe('PipelineTransportAdapter.getReadyState / ping / close', () => {
  it('raw socket の readyState を返す', () => {
    const rawWs = new FakeRawWebSocket()
    rawWs.readyState = 1
    const vrchat = fakeVRChat(rawWs, jest.fn())
    const adapter = new PipelineTransportAdapter()
    expect(adapter.getReadyState(vrchat)).toBe(1)
  })

  it('ping は raw socket の ping を呼ぶ', () => {
    const rawWs = new FakeRawWebSocket()
    const vrchat = fakeVRChat(rawWs, jest.fn())
    const adapter = new PipelineTransportAdapter()
    adapter.ping(vrchat)
    expect(rawWs.ping).toHaveBeenCalledTimes(1)
  })

  it('close は pipeline.close を best-effort で呼ぶ', () => {
    const rawWs = new FakeRawWebSocket()
    const vrchat = fakeVRChat(rawWs, jest.fn())
    const adapter = new PipelineTransportAdapter()
    adapter.close(vrchat)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((vrchat.pipeline as any).close).toHaveBeenCalledTimes(1)
  })
})
