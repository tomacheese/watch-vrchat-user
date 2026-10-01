import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { App } from './app'
import { VRChatSession } from './vrchat/session'
import { PipelineSupervisor } from './vrchat/pipeline-supervisor'
import { Reconciler } from './state/reconciler'
import type { Config } from './config'

jest.mock('./vrchat/session')
jest.mock('./vrchat/pipeline-supervisor')
jest.mock('./state/reconciler')

const VALID_CONFIG = `version: 1
destinations:
  main:
    type: discord-webhook
    url: https://discord.com/api/webhooks/1/abc
rules:
  - name: any
    when: event.type == "online"
    destinations: [main]
`

let dir: string

function config(): Config {
  return {
    vrchat: { username: 'u', password: 'p' },
    configPath: path.join(dir, 'config.yaml'),
  }
}

describe('App.start', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), VALID_CONFIG)
    process.env.HEALTH_PORT = '0'
    process.env.STATE_FILE_PATH = path.join(dir, 'friend-states.json')
    process.env.WORLD_CACHE_FILE_PATH = path.join(dir, 'world-cache.json')
    process.env.OWNER_CACHE_FILE_PATH = path.join(dir, 'owner-cache.json')
    ;(VRChatSession.create as jest.Mock).mockReset()
    ;(VRChatSession.create as jest.Mock).mockResolvedValue({
      client: {
        pipeline: { on: jest.fn(), removeAllListeners: jest.fn() },
        getFavorites: jest
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
      },
      getAuthCookie: jest.fn().mockResolvedValue('cookie'),
    })
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
    delete process.env.STATE_FILE_PATH
    delete process.env.WORLD_CACHE_FILE_PATH
    delete process.env.OWNER_CACHE_FILE_PATH
    fs.rmSync(dir, { recursive: true, force: true })
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
    // start() は固定 cookie 文字列ではなく provider 関数を受け取る
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

  it('設定ファイルが不正な場合は start() が reject し、認証まで進まない', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'version: 99\n')
    const app = new App(config())

    await expect(app.start()).rejects.toThrow()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(VRChatSession.create).not.toHaveBeenCalled()

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
