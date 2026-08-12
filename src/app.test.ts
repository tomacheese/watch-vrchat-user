import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
    ;(Reconciler as unknown as jest.Mock).mockImplementation(function (
      this: { reconcileAll: jest.Mock }
    ) {
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

    expect(VRChatSession.create).toHaveBeenCalledTimes(1)
    const supervisorInstance = (
      PipelineSupervisor as unknown as jest.Mock
    ).mock.instances[0] as {
      start: jest.Mock
    }
    expect(supervisorInstance.start).toHaveBeenCalledWith('cookie')
    const reconcilerInstance = (Reconciler as unknown as jest.Mock).mock
      .instances[0] as {
      reconcileAll: jest.Mock
    }
    expect(reconcilerInstance.reconcileAll).toHaveBeenCalledTimes(1)

    await app.stop()
  })
})
