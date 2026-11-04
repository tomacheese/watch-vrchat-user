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

// Minimal accessor type for testing getAuthCookie() alone without going through the private constructor
interface SessionTestAccessor {
  keyvAdapter: KeyvFile
  getAuthCookie: () => Promise<string | undefined>
}

describe('VRChatSession.getAuthCookie', () => {
  it('extracts the auth cookie from the stored cookies', async () => {
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

  it('returns undefined when no cookie data exists', async () => {
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

  it('returns true for a friend', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ data: { isFriend: true } })
    )
    await expect(isFriend(vrchat, 'usr_1')).resolves.toBe(true)
  })

  it('returns false for a non-friend', async () => {
    const vrchat = fakeVrchat(
      jest.fn().mockResolvedValue({ data: { isFriend: false } })
    )
    await expect(isFriend(vrchat, 'usr_1')).resolves.toBe(false)
  })

  it('throws instead of returning false when the API call itself fails', async () => {
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

/** Fake that pages through items for the online side only and returns nothing for offline */
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
  it('fetches and merges the online and offline lists', async () => {
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

  it('includes the status and status message as the profile', async () => {
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

  it('uses the online entry when a user is in both', async () => {
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

  it('also fetches the next page after a page of exactly 100 items', async () => {
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

  it('merges multiple pages when there are more than 100 items', async () => {
    const getFriends = onlineOnlyFake(friends('on', 150, 'wrld_a:1'))
    const snapshot = await getFriendsSnapshot({
      getFriends,
    } as unknown as VRChat)
    expect(snapshot.size).toBe(150)
  })

  it('throws without returning a partial result when any fetch fails', async () => {
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

  it('throws even when the second page fails', async () => {
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

  it('throws an error containing Rate limit error (429) on 429', async () => {
    const getFriends = jest
      .fn()
      .mockResolvedValue({ error: { message: 'Too Many Requests (429)' } })
    await expect(
      getFriendsSnapshot({ getFriends } as unknown as VRChat)
    ).rejects.toThrow('Rate limit error (429)')
  })
})

describe('getWorldInfo', () => {
  it('returns world information', async () => {
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

  it('throws on failure, and 429 includes Rate limit error (429)', async () => {
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
  it('aggregates group_0 to group_3 tags per user', async () => {
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

  it('also fetches the next page after a page of exactly 100 items', async () => {
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

  it('throws without returning a partial map on partial failure', async () => {
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
  it('returns the display name for usr_', async () => {
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

  it('returns the group name for grp_ and throws if there is no name', async () => {
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

  it('throws on an API error', async () => {
    const getUser = jest
      .fn()
      .mockResolvedValue({ error: { message: 'not found' } })
    await expect(
      getInstanceOwnerInfo({ getUser } as unknown as VRChat, 'usr_a')
    ).rejects.toThrow('not found')
  })
})

describe('VRChatSession REST authentication recovery', () => {
  let directory: string
  let session: VRChatSession | undefined
  let fetchSpy: jest.SpyInstance
  const config = {
    vrchat: {
      username: 'test-user',
      password: 'test-password',
      totpSecret: 'unused',
    },
    configPath: 'unused',
  }

  beforeEach(() => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs')
    const os = jest.requireActual<typeof import('node:os')>('node:os')
    const path = jest.requireActual<typeof import('node:path')>('node:path')
    const { KeyvFile: RealKeyvFile } =
      jest.requireActual<typeof import('keyv-file')>('keyv-file')
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vrchat-session-test-'))
    ;(KeyvFile as unknown as jest.Mock).mockImplementation(
      (options: object) =>
        new RealKeyvFile({
          ...options,
          filename: path.join(directory, 'cookies.json'),
        })
    )
    fetchSpy = jest.spyOn(globalThis, 'fetch')
  })

  afterEach(async () => {
    session?.stop()
    await session?.flush()
    session = undefined
    fetchSpy.mockRestore()
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs')
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('on expiry, concurrent cookie checks share one login and the SDK Pipeline is not recreated', async () => {
    let loginCount = 0
    let revoked = false
    fetchSpy.mockImplementation(async (input: Request) => {
      await Promise.resolve()
      if (input.headers.has('authorization')) {
        loginCount++
        return Response.json(
          { id: 'usr_test', displayName: 'Test' },
          {
            headers: {
              'set-cookie': `auth=test_${loginCount}; Max-Age=3600; Path=/`,
            },
          }
        )
      }
      return !input.headers.has('cookie') ||
        (revoked && input.headers.get('cookie')?.includes('test_1'))
        ? Response.json(
            { error: { message: 'Unauthorized', status_code: 401 } },
            { status: 401 }
          )
        : Response.json({ id: 'usr_test', displayName: 'Test' })
    })
    session = await VRChatSession.create(config)
    const authenticate = jest.spyOn(session.client.pipeline, 'authenticate')
    revoked = true
    const first = session.getAuthenticatedCookie()
    const second = session.getAuthenticatedCookie()
    expect(first).toBe(second)
    await expect(first).resolves.toBe('test_2')
    expect(loginCount).toBe(2)
    expect(authenticate).not.toHaveBeenCalled()
    authenticate.mockRestore()
  })

  it('also retries the original API once after reauthenticating on a REST 401', async () => {
    let loginCount = 0
    let worldCount = 0
    fetchSpy.mockImplementation(async (input: Request) => {
      await Promise.resolve()
      if (input.headers.has('authorization')) {
        loginCount++
        return Response.json(
          { id: 'usr_test', displayName: 'Test' },
          {
            headers: {
              'set-cookie': `auth=test_${loginCount}; Max-Age=3600; Path=/`,
            },
          }
        )
      }
      if (new URL(input.url).pathname.includes('/worlds/')) {
        worldCount++
        return worldCount === 1
          ? Response.json(
              { error: { message: 'Unauthorized', status_code: 401 } },
              { status: 401 }
            )
          : Response.json({ id: 'wrld_test', name: 'World', capacity: 16 })
      }
      return input.headers.has('cookie')
        ? Response.json({ id: 'usr_test', displayName: 'Test' })
        : Response.json(
            { error: { message: 'Unauthorized', status_code: 401 } },
            { status: 401 }
          )
    })
    session = await VRChatSession.create(config)
    const authenticate = jest.spyOn(session.client.pipeline, 'authenticate')
    await expect(
      getWorldInfo(session.client, 'wrld_test')
    ).resolves.toMatchObject({ name: 'World', capacity: 16 })
    expect(worldCount).toBe(2)
    expect(loginCount).toBe(2)
    expect(authenticate).not.toHaveBeenCalled()
    authenticate.mockRestore()
  })

  it('a late 401 for an old cookie does not trigger a duplicate reauthentication', async () => {
    let loginCount = 0
    let oldRequests = 0
    const started = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<Response>()
    const unauthorized = (): Response =>
      Response.json(
        { error: { message: 'Unauthorized', status_code: 401 } },
        { status: 401 }
      )
    fetchSpy.mockImplementation(async (input: Request) => {
      await Promise.resolve()
      if (input.headers.has('authorization')) {
        loginCount++
        return Response.json(
          { id: 'usr_test', displayName: 'Test' },
          {
            headers: {
              'set-cookie': `auth=test_${loginCount}; Max-Age=3600; Path=/`,
            },
          }
        )
      }
      if (new URL(input.url).pathname.includes('/worlds/')) {
        if (input.headers.get('cookie')?.includes('test_1')) {
          const request = ++oldRequests
          if (oldRequests === 2) started.resolve(undefined)
          await started.promise
          return request === 1 ? unauthorized() : late.promise
        }
        return Response.json({ id: 'wrld_test', name: 'World', capacity: 16 })
      }
      return input.headers.has('cookie')
        ? Response.json({ id: 'usr_test', displayName: 'Test' })
        : unauthorized()
    })
    session = await VRChatSession.create(config)
    const first = getWorldInfo(session.client, 'wrld_test')
    const second = getWorldInfo(session.client, 'wrld_test')
    await first
    late.resolve(unauthorized())
    await second
    expect(loginCount).toBe(2)
  })

  it('stop aborts the signal of the actual fetch', async () => {
    fetchSpy.mockImplementation((input: Request) =>
      Promise.resolve(
        Response.json(
          { id: 'usr_test', displayName: 'Test' },
          {
            headers: input.headers.has('authorization')
              ? { 'set-cookie': 'auth=test; Max-Age=3600; Path=/' }
              : undefined,
          }
        )
      )
    )
    // A restore check without a cookie is reported as unauthenticated.
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json(
          { error: { message: 'Unauthorized', status_code: 401 } },
          { status: 401 }
        )
      )
    )
    session = await VRChatSession.create(config)
    let requestSignal: AbortSignal | undefined
    const started = Promise.withResolvers<undefined>()
    fetchSpy.mockImplementation((_input: Request, init: RequestInit) => {
      if (!init.signal) throw new Error('Request signal missing')
      requestSignal = init.signal
      started.resolve(undefined)
      return new Promise((_resolve, reject) =>
        requestSignal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Aborted'))
          },
          { once: true }
        )
      )
    })
    const pending = getWorldInfo(session.client, 'wrld_test')
    const assertion = expect(pending).rejects.toThrow()
    await started.promise
    session.stop()
    await assertion
    expect(requestSignal?.aborted).toBe(true)
  })
})
