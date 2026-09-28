import { FavoritesService } from './favorites-service'

describe('FavoritesService', () => {
  it('refresh 成功で getGroups と status が更新される', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(new Map([['usr_1', ['group_0']]]))
    const service = new FavoritesService({
      fetcher,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    })
    expect(service.getGroups('usr_1')).toEqual([])
    await service.refresh()
    expect(service.getGroups('usr_1')).toEqual(['group_0'])
    expect(service.getGroups('usr_x')).toEqual([])
    expect(service.getStatus()).toEqual({
      lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      lastError: null,
    })
  })

  it('refresh 失敗時は last-known を維持し lastError を保持する', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(new Map([['usr_1', ['group_1']]]))
      .mockRejectedValueOnce(new Error('boom'))
    const service = new FavoritesService({ fetcher })
    await service.refresh()
    const before = service.getStatus().lastUpdatedAt
    await service.refresh()
    expect(service.getGroups('usr_1')).toEqual(['group_1'])
    expect(service.getStatus()).toEqual({
      lastUpdatedAt: before,
      lastError: 'boom',
    })
  })

  it('start は 1 時間ごとに refresh し、stop で止まる', async () => {
    jest.useFakeTimers()
    try {
      const fetcher = jest.fn().mockResolvedValue(new Map())
      const service = new FavoritesService({ fetcher })
      service.start()
      await jest.advanceTimersByTimeAsync(3_600_000)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(3_600_000)
      expect(fetcher).toHaveBeenCalledTimes(2)
      service.stop()
      await jest.advanceTimersByTimeAsync(3_600_000)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
