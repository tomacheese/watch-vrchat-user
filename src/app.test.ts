import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { App } from './app'
import { VRChatSession, isFriend } from './vrchat/session'
import { PipelineSupervisor } from './vrchat/pipeline-supervisor'
import { Reconciler } from './state/reconciler'
import type { Config } from './config'

jest.mock('./vrchat/session')
jest.mock('./vrchat/pipeline-supervisor')
jest.mock('./state/reconciler')

function config(): Config {
  return {
    vrchat: { username: 'u', password: 'p' },
    discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
    targetUserIds: ['usr_1'],
  }
}

describe('App.start', () => {
  beforeEach(() => {
    process.env.HEALTH_PORT = '0'
    process.env.LOCATION_FILE_PATH = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'app-')),
      'user-locations.json'
    )
    ;(VRChatSession.create as jest.Mock).mockResolvedValue({
      client: {
        pipeline: { on: jest.fn(), removeAllListeners: jest.fn() },
      },
      getAuthCookie: jest.fn().mockResolvedValue('cookie'),
    })
    ;(isFriend as jest.Mock).mockResolvedValue(true)
    ;(PipelineSupervisor as unknown as jest.Mock).mockImplementation(function (
      this: { start: jest.Mock },
      _vrchat: unknown,
      _transport: unknown,
      onSynchronize: () => Promise<void>
    ) {
      this.start = jest.fn().mockImplementation(async () => {
        await onSynchronize()
      })
    })
    ;(Reconciler as unknown as jest.Mock).mockImplementation(function (this: {
      reconcileAll: jest.Mock
    }) {
      this.reconcileAll = jest.fn().mockResolvedValue(undefined)
    })
  })

  afterEach(() => {
    delete process.env.HEALTH_PORT
    delete process.env.LOCATION_FILE_PATH
  })

  it('起動シーケンスで VRChatSession -> Supervisor.start -> Reconciler.reconcileAll の順に呼ばれる', async () => {
    const app = new App(config())
    await app.start()

    // static method を値として渡すため this バインディングに依存せず false positive
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(VRChatSession.create).toHaveBeenCalledTimes(1)
    const supervisorInstance = (PipelineSupervisor as unknown as jest.Mock).mock
      .instances[0] as {
      start: jest.Mock<Promise<void>, [() => Promise<string>]>
    }
    // start() は固定 cookie 文字列ではなく provider 関数を受け取るようになった
    // ため、渡された provider を実際に呼び出して解決値を検証する
    expect(supervisorInstance.start).toHaveBeenCalledWith(expect.any(Function))
    const authCookieProvider = supervisorInstance.start.mock.calls[0][0]
    await expect(authCookieProvider()).resolves.toBe('cookie')
    const reconcilerInstance = (Reconciler as unknown as jest.Mock).mock
      .instances[0] as {
      reconcileAll: jest.Mock
    }
    expect(reconcilerInstance.reconcileAll).toHaveBeenCalledTimes(1)

    await app.stop()
  })

  it('isFriend の API 呼び出し自体が失敗しても fatal にせず起動を継続する', async () => {
    ;(isFriend as jest.Mock).mockRejectedValue(new Error('network error'))
    const app = new App(config())

    await expect(app.start()).resolves.toBeUndefined()

    await app.stop()
  })

  it('supervisor.stop() が同期的に例外を投げても stop() は reject せず完了する', async () => {
    const app = new App(config())
    await app.start()

    const supervisorInstance = (PipelineSupervisor as unknown as jest.Mock).mock
      .instances[0] as { stop: jest.Mock }
    supervisorInstance.stop.mockImplementation(() => {
      throw new Error('pipeline.close failed')
    })

    await expect(app.stop()).resolves.toBeUndefined()
  })
})
