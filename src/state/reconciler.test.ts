import { Reconciler } from './reconciler'
import { UserStateCoordinator } from './user-state-coordinator'
import { UserStateRepository } from './user-state-repository'
import * as session from '../vrchat/session'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import type { VRChat } from 'vrchat'
import type { ConfigSnapshot } from '../config/config-snapshot'
import type { ReducerEffect } from './user-state-reducer'

const logs: string[] = []
jest.mock('@book000/node-utils', () => {
  const record = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return {
    Logger: {
      configure: () => ({
        info: record,
        warn: record,
        error: record,
        debug: record,
      }),
    },
  }
})
jest.mock('../vrchat/session')

const snapshot: ConfigSnapshot = {
  destinations: {},
  rules: [],
  loadedAt: '2026-01-01T00:00:00.000Z',
}

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-')),
    'friend-states.json'
  )
}

/** Repository / Coordinator / Reconciler を組み立てる */
function setup(): {
  repository: UserStateRepository
  coordinator: UserStateCoordinator
  reconciler: Reconciler
  effects: ReducerEffect[]
} {
  const repository = new UserStateRepository(tempFilePath())
  repository.load()
  const effects: ReducerEffect[] = []
  const coordinator = new UserStateCoordinator(
    repository,
    (_userId, _displayName, effect) => {
      effects.push(effect)
      return Promise.resolve()
    },
    () => snapshot,
    { initialBackoffMs: 10, maxBackoffMs: 10 }
  )
  const reconciler = new Reconciler(
    () => ({}) as VRChat,
    coordinator,
    repository
  )
  return { repository, coordinator, reconciler, effects }
}

function userState(
  userId: string,
  presence: 'online' | 'offline' = 'offline'
): {
  userId: string
  displayName: string
  presence: 'online' | 'offline'
  location: string | null
  updatedAt: string
} {
  return {
    userId,
    displayName: userId,
    presence,
    location: null,
    updatedAt: '2025-12-31T00:00:00.000Z',
  }
}

function mockSnapshot(
  entries: Record<string, { displayName: string; location: string }>
): void {
  ;(session.getFriendsSnapshot as jest.Mock).mockResolvedValue(
    new Map(Object.entries(entries))
  )
}

beforeEach(() => {
  jest.resetAllMocks()
})

describe('Reconciler.reconcileAll', () => {
  it('REST snapshot を observation として compare-and-enqueue する', async () => {
    const { coordinator, reconciler } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    mockSnapshot({
      usr_1: { displayName: 'Alice', location: 'wrld_a' },
      usr_2: { displayName: 'Bob', location: 'offline' },
    })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      { type: 'location', location: 'wrld_a' },
      0
    )
    expect(appendSpy).toHaveBeenCalledWith(
      'usr_2',
      'Bob',
      { type: 'offline' },
      0
    )
    expect(reconciler.getLastRunAt()).not.toBeNull()
  })

  it('traveling は在席のみ確定した online observation として追記する', async () => {
    const { coordinator, reconciler } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    mockSnapshot({
      usr_1: { displayName: 'Alice', location: 'traveling:traveling' },
    })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      { type: 'online' },
      0
    )
  })

  it('baseline 中に traveling だったフレンドは silent に record 化され、後続の location で friend-add にならない', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    mockSnapshot({
      usr_1: { displayName: 'Alice', location: 'traveling:traveling' },
    })

    await reconciler.reconcileAll()
    expect(repository.get('usr_1')).toMatchObject({
      presence: 'online',
      location: null,
    })
    expect(repository.isBaselineCompleted()).toBe(true)

    coordinator.enqueue('usr_1', 'Alice', {
      type: 'location',
      location: 'wrld_a',
    })
    await coordinator.drain(['usr_1'])

    expect(effects).toEqual([])
    expect(repository.get('usr_1')).toMatchObject({ location: 'wrld_a' })
  })

  it('record は無いが seq が進んでいるユーザーの snapshot も drop されない', async () => {
    const { repository, coordinator, reconciler } = setup()
    await repository.setBaselineCompleted()
    // traveling の WebSocket event のみで record が作られていない状態
    coordinator.enqueue('usr_1', 'Alice', {
      type: 'location',
      location: 'traveling:traveling',
    })
    await coordinator.drain(['usr_1'])
    expect(repository.get('usr_1')).toBeUndefined()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    mockSnapshot({ usr_1: { displayName: 'Alice', location: 'wrld_a' } })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      { type: 'location', location: 'wrld_a' },
      1
    )
    expect(appendSpy).toHaveReturnedWith(true)
  })

  it('record の無いユーザーでも取得中に WebSocket event が届けば snapshot は drop される', async () => {
    const { repository, coordinator, reconciler } = setup()
    await repository.setBaselineCompleted()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getFriendsSnapshot as jest.Mock).mockImplementation(() => {
      coordinator.enqueue('usr_1', 'Alice', {
        type: 'location',
        location: 'wrld_ws',
      })
      return Promise.resolve(
        new Map([['usr_1', { displayName: 'Alice', location: 'offline' }]])
      )
    })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveReturnedWith(false)
  })

  it('429 エラーが発生した場合は何も追記せず lastRunAt を更新せず cooldown する', async () => {
    const { coordinator, reconciler } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getFriendsSnapshot as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429): too many requests')
    )

    await reconciler.reconcileAll()
    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
    expect(session.getFriendsSnapshot).toHaveBeenCalledTimes(1)
    expect(reconciler.getLastRunAt()).toBeNull()
  })

  it('vrchat が未接続の場合は何もしない', async () => {
    const { repository, coordinator } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    const reconciler = new Reconciler(() => null, coordinator, repository)

    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
  })

  it('AC-7: 初回 baseline は通知 0 件で、完了後に baselineCompleted が永続化される', async () => {
    const { repository, reconciler, effects } = setup()
    mockSnapshot({
      usr_1: { displayName: 'Alice', location: 'wrld_a' },
      usr_2: { displayName: 'Bob', location: 'offline' },
    })

    await reconciler.reconcileAll()

    expect(effects).toEqual([])
    expect(repository.get('usr_1')).toMatchObject({ presence: 'online' })
    expect(repository.get('usr_2')).toMatchObject({ presence: 'offline' })
    expect(repository.isBaselineCompleted()).toBe(true)

    const reloaded = new UserStateRepository(
      (repository as unknown as { filePath: string }).filePath
    )
    reloaded.load()
    expect(reloaded.isBaselineCompleted()).toBe(true)
  })

  it('REST 同期で state と食い違った件数 (drift) をログに出す', async () => {
    const { repository, coordinator, reconciler } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1', 'online'))
    await repository.commitUserState('usr_2', userState('usr_2', 'offline'))
    mockSnapshot({
      usr_1: { displayName: 'usr_1', location: 'offline' },
      usr_2: { displayName: 'usr_2', location: 'offline' },
    })
    logs.length = 0

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_1', 'usr_2'])

    expect(logs.join('\n')).toContain('friends=2 drift=1')
  })

  it('AC-10: snapshot を適用できたとき drift 件数を返す', async () => {
    const { repository, coordinator, reconciler } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1', 'online'))
    await repository.commitUserState('usr_2', userState('usr_2', 'offline'))
    mockSnapshot({
      usr_1: { displayName: 'usr_1', location: 'offline' },
      usr_2: { displayName: 'usr_2', location: 'offline' },
    })

    const withDrift = await reconciler.reconcileAll()
    await coordinator.drain(['usr_1', 'usr_2'])
    const withoutDrift = await reconciler.reconcileAll()

    expect(withDrift).toBe(1)
    expect(withoutDrift).toBe(0)
  })

  it('AC-10: 未接続・429 cooldown 中・取得失敗のときは null を返す', async () => {
    const { repository, coordinator, reconciler } = setup()
    const disconnected = new Reconciler(() => null, coordinator, repository)
    expect(await disconnected.reconcileAll()).toBeNull()

    ;(session.getFriendsSnapshot as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429): too many requests')
    )
    expect(await reconciler.reconcileAll()).toBeNull()
    expect(await reconciler.reconcileAll()).toBeNull()

    const failing = setup().reconciler
    ;(session.getFriendsSnapshot as jest.Mock).mockRejectedValue(
      new Error('network down')
    )
    expect(await failing.reconcileAll()).toBeNull()
  })

  it('AC-10: friend-delete の確認中に 429 が発生したときは null を返す', async () => {
    const { repository, reconciler } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1', 'online'))
    mockSnapshot({})
    ;(session.isFriend as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429): too many requests')
    )

    expect(await reconciler.reconcileAll()).toBeNull()
  })

  it('AC-7: baseline 完了後、未知ユーザーは friend-add を生成する', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    mockSnapshot({ usr_9: { displayName: 'Zed', location: 'wrld_a' } })

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_9'])

    expect(effects.map((effect) => effect.type)).toEqual(['friend-add'])
  })

  it('AC-7: 一覧から消えて isFriend が false のユーザーは friend-delete を生成する', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    mockSnapshot({})
    ;(session.isFriend as jest.Mock).mockResolvedValue(false)

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_1'])

    expect(effects.map((effect) => effect.type)).toEqual(['friend-delete'])
    expect(repository.get('usr_1')).toBeUndefined()
  })

  it('AC-7: isFriend が true なら friend-delete を生成しない', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    mockSnapshot({})
    ;(session.isFriend as jest.Mock).mockResolvedValue(true)

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_1'])

    expect(effects).toEqual([])
    expect(repository.get('usr_1')).toBeDefined()
  })

  it('AC-7: isFriend が失敗した場合は friend-delete を生成しない', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    mockSnapshot({})
    ;(session.isFriend as jest.Mock).mockRejectedValue(new Error('network'))

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_1'])

    expect(effects).toEqual([])
    expect(repository.get('usr_1')).toBeDefined()
  })

  it('AC-7: snapshot 取得が部分失敗した場合は差分を適用せず friend-delete も生成しない', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    ;(session.getFriendsSnapshot as jest.Mock).mockRejectedValue(
      new Error('Failed to get friends (offline=true, offset=100): boom')
    )

    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
    expect(session.isFriend).not.toHaveBeenCalled()
    expect(effects).toEqual([])
    expect(reconciler.getLastRunAt()).toBeNull()
  })

  it('AC-8: REST 取得中に WebSocket observation が届いた場合、その snapshot は追記されない', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    ;(session.getFriendsSnapshot as jest.Mock).mockImplementation(() => {
      // 取得中に WebSocket 由来の observation が入った状況を再現する
      coordinator.enqueue('usr_1', 'usr_1', {
        type: 'location',
        location: 'wrld_ws',
      })
      return Promise.resolve(
        new Map([['usr_1', { displayName: 'usr_1', location: 'offline' }]])
      )
    })

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_1'])

    expect(repository.get('usr_1')).toMatchObject({
      presence: 'online',
      location: 'wrld_ws',
    })
    expect(effects.map((effect) => effect.type)).toEqual([
      'online',
      'location-change',
    ])
  })

  it('persist 失敗で drain が false の間は baselineCompleted を永続化せず、次回に再試行する', async () => {
    const { repository, reconciler } = setup()
    mockSnapshot({ usr_1: { displayName: 'Alice', location: 'wrld_a' } })
    const realCommit = repository.commitUserState.bind(repository)
    jest
      .spyOn(repository, 'commitUserState')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(realCommit)

    await reconciler.reconcileAll()
    expect(repository.isBaselineCompleted()).toBe(false)

    // persist-failure は回復可能なので、unhealthy が解消した次回で完了する
    await new Promise((resolve) => setTimeout(resolve, 50))
    await reconciler.reconcileAll()
    expect(repository.isBaselineCompleted()).toBe(true)
  })
})
