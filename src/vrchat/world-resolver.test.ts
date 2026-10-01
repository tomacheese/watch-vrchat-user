import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { WorldResolver } from './world-resolver'

const TTL = 24 * 60 * 60 * 1000

describe('WorldResolver', () => {
  let dir: string
  let file: string
  let now: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-cache-'))
    file = path.join(dir, 'world-cache.json')
    now = Date.parse('2026-01-01T00:00:00Z')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function create(fetcher: jest.Mock): WorldResolver {
    return new WorldResolver({ fetcher, now: () => now, filePath: file })
  }

  it('初回は取得して name を返す', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: 'wrld_a', name: 'W' })
    const result = await create(fetcher).resolve('wrld_a')
    expect(result.name).toBe('W')
    expect(result.stale).toBeFalsy()
  })

  it('TTL 内は API を呼ばない', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: 'wrld_a', name: 'W' })
    const resolver = create(fetcher)
    await resolver.resolve('wrld_a')
    now += TTL - 1
    const result = await resolver.resolve('wrld_a')
    expect(result.name).toBe('W')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('TTL 超過後は再取得する', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ id: 'wrld_a', name: 'Old' })
      .mockResolvedValueOnce({ id: 'wrld_a', name: 'New' })
    const resolver = create(fetcher)
    await resolver.resolve('wrld_a')
    now += TTL
    await expect(resolver.resolve('wrld_a')).resolves.toMatchObject({
      name: 'New',
    })
  })

  it('TTL 超過後に取得失敗した場合は name なし・stale・lastFetchedAt を返す', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ id: 'wrld_a', name: 'Old' })
      .mockRejectedValueOnce(new Error('fail'))
    const resolver = create(fetcher)
    await resolver.resolve('wrld_a')
    const fetchedAt = new Date(now).toISOString()
    now += TTL + 1
    const result = await resolver.resolve('wrld_a')
    expect(result.name).toBeUndefined()
    expect(result.stale).toBe(true)
    expect(result.lastFetchedAt).toBe(fetchedAt)
  })

  it('未取得で取得失敗した場合は name なし・stale', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('fail'))
    const result = await create(fetcher).resolve('wrld_a')
    expect(result).toEqual({ stale: true })
  })

  it('再起動後もキャッシュが復元され API を呼ばない', async () => {
    const fetcher = jest.fn().mockResolvedValue({ id: 'wrld_a', name: 'W' })
    await create(fetcher).resolve('wrld_a')
    const fetcher2 = jest.fn()
    const result = await create(fetcher2).resolve('wrld_a')
    expect(result.name).toBe('W')
    expect(fetcher2).not.toHaveBeenCalled()
  })

  it('キャッシュファイルが破損していても空で起動する', async () => {
    fs.writeFileSync(file, '{not json')
    const fetcher = jest.fn().mockResolvedValue({ id: 'wrld_a', name: 'W' })
    const result = await create(fetcher).resolve('wrld_a')
    expect(result.name).toBe('W')
  })

  it('同一 worldId の同時 resolve は 1 回の取得を共有する', async () => {
    const { promise, resolve } = Promise.withResolvers<{
      id: string
      name: string
    }>()
    const fetcher = jest.fn().mockReturnValue(promise)
    const resolver = create(fetcher)
    const p1 = resolver.resolve('wrld_a')
    const p2 = resolver.resolve('wrld_a')
    resolve({ id: 'wrld_a', name: 'W' })
    await expect(Promise.all([p1, p2])).resolves.toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('取得が 10 秒を超えたら失敗扱いにする', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    try {
      const fetcher = jest.fn().mockReturnValue(Promise.withResolvers().promise)
      const promise = create(fetcher).resolve('wrld_a')
      // キャッシュ読み込み (実 fs) が終わり fetcher が呼ばれてからタイマーを進める
      while (fetcher.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      await jest.advanceTimersByTimeAsync(10_000)
      await expect(promise).resolves.toEqual({ stale: true })
    } finally {
      jest.useRealTimers()
    }
  })

  it('label オプションをログ文言に使う', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('boom'))
    const resolver = new WorldResolver({
      fetcher,
      now: () => now,
      filePath: file,
      label: 'owner',
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await resolver.resolve('usr_a')
    expect(result.stale).toBe(true)
    warn.mockRestore()
  })
})
