import { Reconciler } from './reconciler'
import { UserStateCoordinator } from './user-state-coordinator'
import { UserStateRepository } from './user-state-repository'
import * as session from '../vrchat/session'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import type { VRChat } from 'vrchat'
import type { FriendSnapshot } from '../vrchat/session'
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

/** Builds a Repository / Coordinator / Reconciler */
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

function mockSnapshot(entries: Record<string, FriendSnapshot>): void {
  ;(session.getFriendsSnapshot as jest.Mock).mockResolvedValue(
    new Map(Object.entries(entries))
  )
}

beforeEach(() => {
  jest.resetAllMocks()
})

describe('Reconciler.reconcileAll', () => {
  it('compare-and-enqueues the REST snapshot as observations', async () => {
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

  it('appends the snapshot status as the observation profile', async () => {
    const { coordinator, reconciler } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    const profile = { status: 'busy', statusDescription: '作業中' }
    mockSnapshot({
      usr_1: { displayName: 'Alice', location: 'wrld_a', profile },
    })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      {
        type: 'location',
        location: 'wrld_a',
        profile,
        profileBaseline: true,
      },
      0
    )
  })

  it('appends the REST snapshot profile as an initial value, not a status-change', async () => {
    const { coordinator, reconciler } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    const profile = { status: 'busy', statusDescription: '作業中' }
    mockSnapshot({
      usr_1: {
        displayName: 'Alice',
        location: 'wrld_a',
        profile,
      },
    })

    await reconciler.reconcileAll()

    expect(appendSpy).toHaveBeenCalledWith(
      'usr_1',
      'Alice',
      {
        type: 'location',
        location: 'wrld_a',
        profile,
        profileBaseline: true,
      },
      0
    )
  })

  it('appends traveling as an online observation that confirms presence only', async () => {
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

  it('a friend that was traveling during baseline is recorded silently and a later location does not produce friend-add', async () => {
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

  it('does not drop the snapshot of a user with no record but an advanced seq', async () => {
    const { repository, coordinator, reconciler } = setup()
    await repository.setBaselineCompleted()
    // State where only traveling WebSocket events arrived and no record was created
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

  it('drops the snapshot even for a user with no record if a WebSocket event arrives during fetch', async () => {
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

  it('on a 429 error, appends nothing, does not update lastRunAt, and cools down', async () => {
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

  it('does nothing when vrchat is not connected', async () => {
    const { repository, coordinator } = setup()
    const appendSpy = jest.spyOn(coordinator, 'appendSnapshotObservation')
    const reconciler = new Reconciler(() => null, coordinator, repository)

    await reconciler.reconcileAll()

    expect(appendSpy).not.toHaveBeenCalled()
  })

  it('AC-7: the initial baseline produces zero notifications and baselineCompleted is persisted after completion', async () => {
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

  it('logs the number of mismatches with state (drift) found by REST sync', async () => {
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

  it('AC-10: returns the drift count when the snapshot was applied', async () => {
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

  it('AC-10: returns null when not connected, cooling down after 429, or the fetch failed', async () => {
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

  it('AC-10: returns null when a 429 occurs while confirming friend-delete', async () => {
    const { repository, reconciler } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1', 'online'))
    mockSnapshot({})
    ;(session.isFriend as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429): too many requests')
    )

    expect(await reconciler.reconcileAll()).toBeNull()
  })

  it('AC-7: after the baseline completes, an unknown user produces friend-add', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    mockSnapshot({ usr_9: { displayName: 'Zed', location: 'wrld_a' } })

    await reconciler.reconcileAll()
    await coordinator.drain(['usr_9'])

    expect(effects.map((effect) => effect.type)).toEqual(['friend-add'])
  })

  it('AC-7: a user missing from the list with isFriend false produces friend-delete', async () => {
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

  it('AC-7: does not produce friend-delete when isFriend is true', async () => {
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

  it('AC-7: does not produce friend-delete when isFriend fails', async () => {
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

  it('AC-7: when the snapshot fetch partially fails, applies no differences and produces no friend-delete', async () => {
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

  it('AC-8: if a WebSocket observation arrives during the REST fetch, that snapshot is not appended', async () => {
    const { repository, coordinator, reconciler, effects } = setup()
    await repository.setBaselineCompleted()
    await repository.commitUserState('usr_1', userState('usr_1'))
    ;(session.getFriendsSnapshot as jest.Mock).mockImplementation(() => {
      // Simulate a WebSocket observation arriving during the fetch
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

  it('while drain is false due to a persist failure, baselineCompleted is not persisted and is retried next time', async () => {
    const { repository, reconciler } = setup()
    mockSnapshot({ usr_1: { displayName: 'Alice', location: 'wrld_a' } })
    const realCommit = repository.commitUserState.bind(repository)
    jest
      .spyOn(repository, 'commitUserState')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(realCommit)

    await reconciler.reconcileAll()
    expect(repository.isBaselineCompleted()).toBe(false)

    // persist-failure is recoverable, so it completes on the next run once unhealthy clears
    await new Promise((resolve) => setTimeout(resolve, 50))
    await reconciler.reconcileAll()
    expect(repository.isBaselineCompleted()).toBe(true)
  })
})
