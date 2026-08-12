import { KeyvFile } from 'keyv-file'
import type { VRChat } from 'vrchat'
import { getUser, isFriend, VRChatSession } from './session'

jest.mock('keyv-file')

// private constructor を経由せず getAuthCookie() 単体をテストするための最小限のアクセサ型
interface SessionTestAccessor {
  keyvAdapter: KeyvFile
  getAuthCookie: () => Promise<string | undefined>
}

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

    const session = Object.create(
      VRChatSession.prototype
    ) as SessionTestAccessor
    session.keyvAdapter = new KeyvFile({ filename: 'unused' })

    const cookie = await session.getAuthCookie()
    expect(cookie).toBe('authcookie_123')
  })

  it('Cookie データが存在しない場合は undefined を返す', async () => {
    const mockGet = jest.fn().mockResolvedValue(undefined)
    ;(KeyvFile as unknown as jest.Mock).mockImplementation(() => ({
      get: mockGet,
    }))

    const session = Object.create(
      VRChatSession.prototype
    ) as SessionTestAccessor
    session.keyvAdapter = new KeyvFile({ filename: 'unused' })

    const cookie = await session.getAuthCookie()
    expect(cookie).toBeUndefined()
  })
})

describe('isFriend', () => {
  function fakeVrchat(getFriendStatus: jest.Mock): VRChat {
    return { getFriendStatus } as unknown as VRChat
  }

  it('フレンドの場合は true を返す', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ data: { isFriend: true } })
    )
    await expect(isFriend(vrchat, 'usr_1')).resolves.toBe(true)
  })

  it('フレンドでない場合は false を返す', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ data: { isFriend: false } })
    )
    await expect(isFriend(vrchat, 'usr_1')).resolves.toBe(false)
  })

  it('API 呼び出し自体が失敗した場合は false を返さず例外を投げる', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ error: { message: 'network error' } })
    )
    await expect(isFriend(vrchat, 'usr_1')).rejects.toThrow('network error')
  })
})

describe('getUser', () => {
  function fakeVrchat(getUserMock: jest.Mock): VRChat {
    return { getUser: getUserMock } as unknown as VRChat
  }

  it('concrete location を持つユーザーはそのまま location を返す', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({
        data: {
          id: 'usr_1',
          displayName: 'Alice',
          location: 'wrld_a:12345',
          status: 'active',
        },
      })
    )
    await expect(getUser(vrchat, 'usr_1')).resolves.toEqual({
      id: 'usr_1',
      displayName: 'Alice',
      location: 'wrld_a:12345',
      status: 'active',
    })
  })

  it('location が "offline" の場合は null に正規化する', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({
        data: {
          id: 'usr_1',
          displayName: 'Alice',
          location: 'offline',
          status: 'offline',
        },
      })
    )
    const user = await getUser(vrchat, 'usr_1')
    expect(user?.location).toBeNull()
  })

  it('location が空文字の場合も null に正規化する', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({
        data: {
          id: 'usr_1',
          displayName: 'Alice',
          location: '',
          status: 'active',
        },
      })
    )
    const user = await getUser(vrchat, 'usr_1')
    expect(user?.location).toBeNull()
  })

  it('429 エラーの場合は message に "429" を含む例外を投げる（Reconciler の中断判定契約）', async () => {
    const vrchat = fakeVrchat(
      jest
        .fn()
        .mockResolvedValue({ error: { message: 'Too Many Requests (429)' } })
    )
    await expect(getUser(vrchat, 'usr_1')).rejects.toThrow('429')
  })

  it('429 以外の API エラーは例外を投げず null を返す', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ error: { message: 'not found' } })
    )
    await expect(getUser(vrchat, 'usr_1')).resolves.toBeNull()
  })
})
