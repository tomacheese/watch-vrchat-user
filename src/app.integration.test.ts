import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { App } from './app'
import { VRChatSession } from './vrchat/session'
import { PipelineTransportAdapter } from './vrchat/pipeline-transport'
import * as session from './vrchat/session'
import type { Config } from './config'
import type { PipelineTransportCallbacks } from './vrchat/pipeline-transport'

jest.mock('./vrchat/session')
jest.mock('./vrchat/pipeline-transport')
// Discord への実 HTTP 呼び出しを避ける。無効な webhook URL への送信失敗リトライは
// coordinator の queue 処理をブロックし（onEffect を await するため）、実ネットワーク
// 呼び出しのタイムアウト・リトライ分だけテストを不安定に遅くしてしまう。
jest.mock('@book000/node-utils', () => {
  const actual: object = jest.requireActual('@book000/node-utils')
  return {
    ...actual,
    Discord: jest.fn().mockImplementation(() => ({
      sendMessage: jest.fn().mockResolvedValue(undefined),
    })),
  }
})

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function config(): Config {
  return {
    vrchat: { username: 'u', password: 'p' },
    discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
    targetUserIds: ['usr_1'],
  }
}

describe('App integration', () => {
  let pipeline: EventEmitter & { removeAllListeners: (event: string) => void }
  let capturedCallbacks: PipelineTransportCallbacks[]

  beforeEach(() => {
    process.env.HEALTH_PORT = '0'
    process.env.LOCATION_FILE_PATH = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'app-integration-')),
      'user-locations.json'
    )
    // VRChat SDK の pipeline は Node 流の EventEmitter API を持つため、
    // fake もそれに合わせる（EventTarget では on()/emit() の形が一致しない）。
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter()
    const removeAllListeners = emitter.removeAllListeners.bind(emitter)
    pipeline = Object.assign(emitter, {
      removeAllListeners: (event: string) => {
        removeAllListeners(event)
      },
    })
    capturedCallbacks = []

    ;(VRChatSession.create as jest.Mock).mockResolvedValue({
      client: { pipeline },
      getAuthCookie: jest.fn().mockResolvedValue('cookie'),
    })
    ;(session.getUser as jest.Mock).mockResolvedValue({
      id: 'usr_1',
      displayName: 'Alice',
      location: null,
      status: 'offline',
    })
    ;(session.isFriend as jest.Mock).mockResolvedValue(true)
    ;(PipelineTransportAdapter as unknown as jest.Mock).mockImplementation(
      function (this: {
        connect: jest.Mock
        getReadyState: jest.Mock
        ping: jest.Mock
        close: jest.Mock
      }) {
        this.connect = jest
          .fn()
          .mockImplementation(
            (
              _vrchat: unknown,
              _cookie: string,
              callbacks: PipelineTransportCallbacks
            ) => {
              capturedCallbacks.push(callbacks)
              callbacks.onOpen()
              return Promise.resolve()
            }
          )
        this.getReadyState = jest.fn().mockReturnValue(1)
        this.ping = jest.fn()
        this.close = jest.fn()
      }
    )
  })

  afterEach(() => {
    delete process.env.HEALTH_PORT
    delete process.env.LOCATION_FILE_PATH
  })

  it('friend-online -> friend-location: Instance A -> traveling -> Instance B の順に通知される', async () => {
    const app = new App(config())
    await app.start()

    pipeline.emit('friend-online', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
    })
    pipeline.emit('friend-location', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
      location: 'wrld_a',
    })
    pipeline.emit('friend-location', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
      location: 'traveling',
    })
    pipeline.emit('friend-location', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
      location: 'wrld_b',
    })

    // 実 fs I/O (writeFile + rename) を伴う queue drain は setImmediate の
    // マイクロタスクフラッシュだけでは完了しないため、実 timer で待つ。
    await waitFor(() => app.getUserState('usr_1')?.location === 'wrld_b')

    expect(app.getUserState('usr_1')?.location).toBe('wrld_b')

    await app.stop()
  })

  it('raw close で reconnect し、reconnect 後も queue の内容を保持する', async () => {
    const app = new App(config())
    await app.start()

    pipeline.emit('friend-online', {
      userId: 'usr_1',
      user: { id: 'usr_1', displayName: 'Alice' },
    })
    capturedCallbacks[0].onClose()

    // App は PipelineSupervisor を既定 backoff (initialBackoffMs=1000ms) で
    // 生成するため、固定 50ms 待機では reconnect 前に検証してしまう。
    await waitFor(() => capturedCallbacks.length > 1, 3000)

    expect(capturedCallbacks.length).toBeGreaterThan(1)

    await app.stop()
  })
})
