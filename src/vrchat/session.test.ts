import { KeyvFile } from 'keyv-file'
import type { VRChat } from 'vrchat'
import {
  getFriendFavoriteGroups,
  getFriendsSnapshot,
  getInstanceOwnerInfo,
  getWorldInfo,
  isFriend,
  VRChatSession,
} from './session'

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

interface PagedQuery {
  query: { offline?: boolean; offset: number; n: number }
}

function friends(prefix: string, count: number, location: string): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    displayName: `${prefix}${i}`,
    location,
  }))
}

/** online 側だけ items をページングして返し、offline 側は空にする fake */
function onlineOnlyFake(items: unknown[]): jest.Mock {
  return jest.fn().mockImplementation((options: PagedQuery) =>
    Promise.resolve({
      data: options.query.offline
        ? []
        : items.slice(
            options.query.offset,
            options.query.offset + options.query.n
          ),
    })
  )
}

describe('getFriendsSnapshot', () => {
  it('online と offline の 2 系統を取得して統合する', async () => {
    const getFriends = jest.fn().mockImplementation((options: PagedQuery) =>
      Promise.resolve({
        data: [
          options.query.offline
            ? { id: 'usr_off', displayName: 'Off', location: 'offline' }
            : { id: 'usr_on', displayName: 'On', location: 'wrld_a:1' },
        ],
      })
    )
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.get('usr_on')).toEqual({
      displayName: 'On',
      location: 'wrld_a:1',
    })
    expect(snapshot.get('usr_off')).toEqual({
      displayName: 'Off',
      location: 'offline',
    })
  })

  it('ステータスとステータスメッセージを profile として載せる', async () => {
    const getFriends = jest.fn().mockImplementation((options: PagedQuery) =>
      Promise.resolve({
        data: options.query.offline
          ? []
          : [
              {
                id: 'usr_on',
                displayName: 'On',
                location: 'wrld_a:1',
                status: 'join me',
                statusDescription: 'ダンス募集',
              },
            ],
      })
    )
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.get('usr_on')?.profile).toEqual({
      status: 'join me',
      statusDescription: 'ダンス募集',
    })
  })

  it('両方に居る場合は online 側を採用する', async () => {
    const getFriends = jest.fn().mockImplementation((options: PagedQuery) =>
      Promise.resolve({
        data: [
          {
            id: 'usr_1',
            displayName: 'A',
            location: options.query.offline ? 'offline' : 'wrld_a:1',
          },
        ],
      })
    )
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.get('usr_1')?.location).toBe('wrld_a:1')
  })

  it('ちょうど 100 件のページの次ページも取得する', async () => {
    const getFriends = onlineOnlyFake(friends('on', 100, 'wrld_a:1'))
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.size).toBe(100)
    const onlineCalls = getFriends.mock.calls.filter(
      (c: PagedQuery[]) => !c[0].query.offline
    )
    expect(onlineCalls).toHaveLength(2)
  })

  it('100 件を超える場合は複数ページを結合する', async () => {
    const getFriends = onlineOnlyFake(friends('on', 150, 'wrld_a:1'))
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.size).toBe(150)
  })

  it('いずれかの取得が失敗した場合は部分結果を返さず throw する', async () => {
    const getFriends = jest
      .fn()
      .mockImplementation((options: PagedQuery) =>
        Promise.resolve(
          options.query.offline
            ? { error: { message: 'boom' } }
            : { data: [{ id: 'usr_on', displayName: 'On', location: 'x' }] }
        )
      )
    await expect(
      getFriendsSnapshot({ getFriends } as unknown as VRChat)
    ).rejects.toThrow('boom')
  })

  it('2 ページ目の失敗でも throw する', async () => {
    const page1 = friends('on', 100, 'wrld_a:1')
    const getFriends = jest.fn().mockImplementation((options: PagedQuery) => {
      return options.query.offline
        ? Promise.resolve({ data: [] })
        : Promise.resolve(
            options.query.offset === 0
              ? { data: page1 }
              : { error: { message: 'page2 failed' } }
          )
    })
    await expect(
      getFriendsSnapshot({ getFriends } as unknown as VRChat)
    ).rejects.toThrow('page2 failed')
  })

  it('429 の場合は Rate limit error (429) を含む例外を投げる', async () => {
    const getFriends = jest
      .fn()
      .mockResolvedValue({ error: { message: 'Too Many Requests (429)' } })
    await expect(
      getFriendsSnapshot({ getFriends } as unknown as VRChat)
    ).rejects.toThrow('Rate limit error (429)')
  })
})

describe('getWorldInfo', () => {
  it('ワールド情報を返す', async () => {
    const getWorld = jest.fn().mockResolvedValue({
      data: { id: 'wrld_a', name: 'W', thumbnailImageUrl: 'http://t' },
    })
    await expect(
      getWorldInfo({ getWorld } as unknown as VRChat, 'wrld_a')
    ).resolves.toEqual({
      id: 'wrld_a',
      name: 'W',
      thumbnailImageUrl: 'http://t',
    })
  })

  it('失敗時は throw し、429 は Rate limit error (429) を含む', async () => {
    const getWorld = jest
      .fn()
      .mockResolvedValueOnce({ error: { message: 'not found' } })
      .mockResolvedValueOnce({ error: { message: 'rate limit' } })
    const vrchat = { getWorld } as unknown as VRChat
    await expect(getWorldInfo(vrchat, 'wrld_a')).rejects.toThrow('not found')
    await expect(getWorldInfo(vrchat, 'wrld_a')).rejects.toThrow(
      'Rate limit error (429)'
    )
  })
})

describe('getFriendFavoriteGroups', () => {
  it('group_0 から group_3 のタグをユーザーごとに集約する', async () => {
    const getFavorites = jest.fn().mockResolvedValue({
      data: [
        { favoriteId: 'usr_1', tags: ['group_0'], type: 'friend' },
        { favoriteId: 'usr_1', tags: ['group_2', 'other'], type: 'friend' },
        { favoriteId: 'usr_2', tags: ['group_3'], type: 'friend' },
      ],
    })
    const groups = await getFriendFavoriteGroups({
      getFavorites,
    } as unknown as VRChat)
    expect(groups.get('usr_1')).toEqual(['group_0', 'group_2'])
    expect(groups.get('usr_2')).toEqual(['group_3'])
    expect(getFavorites).toHaveBeenCalledWith({
      query: { n: 100, offset: 0, type: 'friend' },
    })
  })

  it('ちょうど 100 件のページの次ページも取得する', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      favoriteId: `usr_${i}`,
      tags: ['group_0'],
      type: 'friend',
    }))
    const getFavorites = jest
      .fn()
      .mockResolvedValueOnce({ data: items })
      .mockResolvedValueOnce({ data: [] })
    const groups = await getFriendFavoriteGroups({
      getFavorites,
    } as unknown as VRChat)
    expect(groups.size).toBe(100)
    expect(getFavorites).toHaveBeenCalledTimes(2)
  })

  it('部分失敗では部分 map を返さず throw する', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      favoriteId: `usr_${i}`,
      tags: ['group_0'],
      type: 'friend',
    }))
    const getFavorites = jest
      .fn()
      .mockResolvedValueOnce({ data: items })
      .mockResolvedValueOnce({ error: { message: 'boom' } })
    await expect(
      getFriendFavoriteGroups({ getFavorites } as unknown as VRChat)
    ).rejects.toThrow('boom')
  })
})

describe('getInstanceOwnerInfo', () => {
  it('usr_ はユーザーの表示名を返す', async () => {
    const getUser = jest
      .fn()
      .mockResolvedValue({ data: { id: 'usr_a', displayName: 'Alice' } })
    const getGroup = jest.fn()
    await expect(
      getInstanceOwnerInfo({ getUser, getGroup } as unknown as VRChat, 'usr_a')
    ).resolves.toEqual({ id: 'usr_a', name: 'Alice' })
    expect(getUser).toHaveBeenCalledWith({ path: { userId: 'usr_a' } })
    expect(getGroup).not.toHaveBeenCalled()
  })

  it('grp_ はグループ名を返し、名前が無ければ throw する', async () => {
    const getGroup = jest
      .fn()
      .mockResolvedValueOnce({ data: { id: 'grp_a', name: 'Group' } })
      .mockResolvedValueOnce({ data: { id: 'grp_a' } })
    const vrchat = { getGroup } as unknown as VRChat
    await expect(getInstanceOwnerInfo(vrchat, 'grp_a')).resolves.toEqual({
      id: 'grp_a',
      name: 'Group',
    })
    await expect(getInstanceOwnerInfo(vrchat, 'grp_a')).rejects.toThrow(
      'has no name'
    )
  })

  it('API エラー時は throw する', async () => {
    const getUser = jest
      .fn()
      .mockResolvedValue({ error: { message: 'not found' } })
    await expect(
      getInstanceOwnerInfo({ getUser } as unknown as VRChat, 'usr_a')
    ).rejects.toThrow('not found')
  })
})
