import { KeyvFile } from 'keyv-file'
import { VRChatSession } from './session'

jest.mock('keyv-file')

describe('VRChatSession.getAuthCookie', () => {
  it('保存済み Cookie から auth cookie を抽出する', async () => {
    const mockGet = jest
      .fn()
      .mockResolvedValue(
        JSON.stringify({ value: [{ name: 'auth', value: 'authcookie_123' }] })
      )
    ;(KeyvFile as unknown as jest.Mock).mockImplementation(() => ({
      get: mockGet,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = Object.create(VRChatSession.prototype) as any
    session.keyvAdapter = new KeyvFile({ filename: 'unused' })

    const cookie = await session.getAuthCookie()
    expect(cookie).toBe('authcookie_123')
  })

  it('Cookie データが存在しない場合は undefined を返す', async () => {
    const mockGet = jest.fn().mockResolvedValue(undefined)
    ;(KeyvFile as unknown as jest.Mock).mockImplementation(() => ({
      get: mockGet,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = Object.create(VRChatSession.prototype) as any
    session.keyvAdapter = new KeyvFile({ filename: 'unused' })

    const cookie = await session.getAuthCookie()
    expect(cookie).toBeUndefined()
  })
})
