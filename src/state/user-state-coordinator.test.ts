import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { UserStateCoordinator } from './user-state-coordinator'
import { UserStateRepository } from './user-state-repository'
import { getPersistedConfigId } from '../notifications/outbox-types'
import type { ReducerEffect } from './user-state-reducer'
import type { ConfigSnapshot } from '../config/config-snapshot'

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-')),
    'friend-states.json'
  )
}

const snapshot: ConfigSnapshot = {
  destinations: {},
  rules: [],
  loadedAt: '2026-01-01T00:00:00.000Z',
}
const getSnapshot = (): ConfigSnapshot => snapshot

/** Builds a Repository with the baseline completed and the given records */
async function completedRepository(
  ...records: ('offline' | 'online')[]
): Promise<UserStateRepository> {
  const repository = new UserStateRepository(tempFilePath())
  repository.load()
  await repository.setBaselineCompleted()
  for (const [i, presence] of records.entries()) {
    await repository.commitUserState(`u${i + 1}`, {
      userId: `u${i + 1}`,
      displayName: 'Alice',
      presence,
      location: null,
      updatedAt: '2025-12-31T00:00:00.000Z',
    })
  }
  return repository
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await wait(5)
  }
  throw new Error('Condition was not met in time')
}

describe('UserStateCoordinator', () => {
  it('does not persist an observation that leaves state unchanged', async () => {
    const repository = await completedRepository('offline')
    const commit = jest.spyOn(repository, 'commitUserState')
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )

    coordinator.enqueue('u1', 'Alice', { type: 'offline' })
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })
    await coordinator.drain(['u1'])

    expect(commit).not.toHaveBeenCalled()
  })

  it('processes observations of the same user in order and fires effects', async () => {
    // Start from the normal flow: baseline completed and an existing offline record
    const repository = await completedRepository('offline')
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', {
      type: 'location',
      location: 'traveling',
    })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_b' })
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })

    await waitFor(() => effects.length === 4)

    // no-op effects are not passed to onEffect (the Coordinator filters on effect.type !== 'no-op')
    expect(effects.map((effect) => effect.type)).toEqual([
      'online',
      'location-change',
      'location-change',
      'offline',
    ])
    expect(effects[1]).toMatchObject({
      previous: { location: null },
      current: { location: 'wrld_a' },
    })
    expect(effects[2]).toMatchObject({
      previous: { location: 'wrld_a' },
      current: { location: 'wrld_b' },
    })
    expect(repository.get('u1')).toMatchObject({
      presence: 'offline',
      location: null,
    })
  })

  it('status changes fire and persist as status-change, and the first observation only records', async () => {
    const repository = await completedRepository('online')
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u1', 'Alice', {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'a' },
    })
    coordinator.enqueue('u1', 'Alice', {
      type: 'profile',
      profile: { status: 'busy', statusDescription: 'a' },
    })
    await waitFor(() => effects.length === 1)
    await coordinator.drain(['u1'])

    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({
      type: 'status-change',
      previous: { status: 'active' },
      current: { status: 'busy' },
    })
    expect(repository.get('u1')).toMatchObject({
      status: 'busy',
      statusDescription: 'a',
    })
  })

  it('appendSnapshotObservation drops and returns false when expectedSeq is stale', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )

    const seq = coordinator.captureSeq('u1')
    coordinator.enqueue('u1', 'Alice', { type: 'online' }) // advance seq

    const appended = coordinator.appendSnapshotObservation(
      'u1',
      'Alice',
      { type: 'offline' },
      seq
    )
    expect(appended).toBe(false)
  })

  it('appendSnapshotObservation returns true and appends to the tail when the queue is unchanged', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )

    const seq = coordinator.captureSeq('u1')
    const appended = coordinator.appendSnapshotObservation(
      'u1',
      'Alice',
      { type: 'online' },
      seq
    )
    expect(appended).toBe(true)
  })

  it('an observation that fails to persist stays at the queue head and later ones are not processed', async () => {
    const repository = await completedRepository('offline')

    // Fail only the first commit and let later ones go through the real commitUserState
    // (fully replacing it with a mock would not update the in-memory state, so even after a retry the
    // reducer would keep treating current as undefined)
    const realCommit = repository.commitUserState.bind(repository)
    let callCount = 0
    jest
      .spyOn(repository, 'commitUserState')
      .mockImplementation(async (userId, nextState) => {
        callCount += 1
        if (callCount === 1) {
          throw new Error('disk full')
        }
        return realCommit(userId, nextState)
      })

    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot,
      { initialBackoffMs: 30, maxBackoffMs: 30 }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })

    // Right after the first persist failure (waiting for retry backoff) the user is unhealthy and no effect has fired
    await wait(10)
    expect(coordinator.getUnhealthy('u1')).toBeDefined()
    expect(effects).toEqual([])

    // Once the retry succeeds, items are processed from the head and unhealthy clears
    await waitFor(
      () => effects.length === 2 && coordinator.getUnhealthy('u1') === undefined
    )
    expect(effects.map((effect) => effect.type)).toEqual([
      'online',
      'location-change',
    ])
    expect(coordinator.getUnhealthy('u1')).toBeUndefined()
  })

  it('when the queue reaches its limit, new enqueues stop and the user becomes unhealthy', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    jest
      .spyOn(repository, 'commitUserState')
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- keep commit pending forever on purpose to verify queue-overflow
      .mockReturnValue(new Promise(() => {}))
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot,
      {
        maxQueueSize: 2,
      }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_b' })

    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')
  })

  it('queue-overflow is not cleared even when persist succeeds (the data-loss record is kept)', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    // The resolve from Promise.withResolvers() has type `(value: void) => void`,
    // which conflicts with no-invalid-void-type, so it is used in this form
    const { promise: firstCommitPromise, resolve: resolveFirstCommit } =
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
      Promise.withResolvers<void>()
    jest
      .spyOn(repository, 'commitUserState')
      .mockImplementationOnce(() => firstCommitPromise)
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot,
      { maxQueueSize: 2 }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', {
      type: 'location',
      location: 'wrld_a',
    })
    coordinator.enqueue('u1', 'Alice', {
      type: 'location',
      location: 'wrld_b',
    })
    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')

    resolveFirstCommit()
    await wait(50)

    // The head commit succeeded, but the data loss from the overflow itself is not resolved
    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')
  })

  it('AC-11: onEffect receives the snapshot from enqueue time and is unaffected by later getSnapshot changes', async () => {
    const repository = await completedRepository('offline')
    const snapshotA: ConfigSnapshot = { ...snapshot, loadedAt: 'A' }
    const snapshotB: ConfigSnapshot = { ...snapshot, loadedAt: 'B' }
    let current = snapshotA
    const received: ConfigSnapshot[] = []
    const { promise: gate, resolve: openGate } =
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
      Promise.withResolvers<void>()
    const coordinator = new UserStateCoordinator(
      repository,
      async (_userId, _displayName, _effect, effectSnapshot) => {
        received.push(effectSnapshot)
        await gate
      },
      () => current
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' }) // snapshot A
    current = snapshotB
    coordinator.enqueue('u1', 'Alice', { type: 'offline' }) // snapshot B
    openGate()

    await waitFor(() => received.length === 2)
    expect(received).toEqual([snapshotA, snapshotB])
  })

  it('a public Location confirmed together with going online fires location-change after online', async () => {
    const repository = await completedRepository('offline')
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u1', 'Alice', {
      type: 'online',
      location: 'wrld_a:1~region(jp)',
    })
    await waitFor(() => effects.length === 2)

    expect(effects.map((effect) => effect.type)).toEqual([
      'online',
      'location-change',
    ])
  })

  it('friend-delete removes the record and fires the friend-delete effect', async () => {
    const repository = await completedRepository('online')
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u1', 'u1', { type: 'friend-delete' })
    await waitFor(() => effects.length === 1)

    expect(effects[0]).toMatchObject({
      type: 'friend-delete',
      previous: { userId: 'u1' },
      current: undefined,
    })
    expect(repository.get('u1')).toBeUndefined()
  })

  it('an observation of an unknown user received before the baseline completes becomes state without notification', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u9', 'Zed', { type: 'location', location: 'wrld_a' })
    await coordinator.drain(['u9'])

    expect(effects).toEqual([])
    expect(repository.get('u9')).toMatchObject({
      presence: 'online',
      location: 'wrld_a',
    })
  })

  it('after the baseline completes, an unknown user notifies friend-add only', async () => {
    const repository = await completedRepository()
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      },
      getSnapshot
    )

    coordinator.enqueue('u9', 'Zed', { type: 'location', location: 'wrld_a' })
    await coordinator.drain(['u9'])

    expect(effects.map((effect) => effect.type)).toEqual(['friend-add'])
  })

  describe('drain', () => {
    it('returns true once the target queues are empty', async () => {
      const repository = await completedRepository('offline', 'offline')
      const coordinator = new UserStateCoordinator(
        repository,
        () => wait(20),
        getSnapshot
      )

      coordinator.enqueue('u1', 'Alice', { type: 'online' })
      coordinator.enqueue('u2', 'Alice', { type: 'online' })

      await expect(coordinator.drain(['u1', 'u2'])).resolves.toBe(true)
      expect(repository.get('u1')?.presence).toBe('online')
      expect(repository.get('u2')?.presence).toBe('online')
    })

    it('returns true immediately when only never-enqueued users are given', async () => {
      const repository = await completedRepository()
      const coordinator = new UserStateCoordinator(
        repository,
        () => Promise.resolve(),
        getSnapshot
      )
      await expect(coordinator.drain(['u1'])).resolves.toBe(true)
    })

    it('returns false if a persist failure makes a user unhealthy while waiting', async () => {
      const repository = await completedRepository('offline')
      jest
        .spyOn(repository, 'commitUserState')
        .mockRejectedValue(new Error('disk full'))
      const coordinator = new UserStateCoordinator(
        repository,
        () => Promise.resolve(),
        getSnapshot,
        { initialBackoffMs: 30, maxBackoffMs: 30 }
      )

      coordinator.enqueue('u1', 'Alice', { type: 'online' })

      await expect(coordinator.drain(['u1'])).resolves.toBe(false)
    })

    it('returns false when a target user already has queue-overflow', async () => {
      const repository = await completedRepository('offline')
      jest
        .spyOn(repository, 'commitUserState')
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- keep commit pending forever to create an overflow
        .mockReturnValue(new Promise(() => {}))
      const coordinator = new UserStateCoordinator(
        repository,
        () => Promise.resolve(),
        getSnapshot,
        { maxQueueSize: 1 }
      )
      coordinator.enqueue('u1', 'Alice', { type: 'online' })
      coordinator.enqueue('u1', 'Alice', { type: 'offline' })

      await expect(coordinator.drain(['u1'])).resolves.toBe(false)
    })
  })
})

describe('coordinator recovery and shutdown', () => {
  it('an overflow after persist-failure is still recorded after recovery', async () => {
    const repository = await completedRepository('offline')
    jest
      .spyOn(repository, 'commitUserState')
      .mockRejectedValueOnce(new Error('disk full'))
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot,
      {
        maxQueueSize: 1,
        initialBackoffMs: 30,
        maxBackoffMs: 30,
      }
    )
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    await waitFor(
      () => coordinator.getUnhealthy('u1')?.cause === 'persist-failure'
    )
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })
    await waitFor(() => repository.get('u1')?.presence === 'online')
    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')
    await expect(coordinator.stop()).resolves.toBe(false)
  })

  it('the display name for offline is filled in after the preceding observation commits', async () => {
    const repository = await completedRepository('offline')
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )
    coordinator.enqueue('u1', 'Alicia', { type: 'online' })
    coordinator.enqueue('u1', 'u1', { type: 'offline' })
    await coordinator.drain(['u1'])
    expect(repository.get('u1')).toMatchObject({
      displayName: 'Alicia',
      presence: 'offline',
    })
  })

  it('stop ends intake and waits for healthy queues to persist', async () => {
    const repository = await completedRepository('offline')
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })
    const stopped = coordinator.stop()
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    await expect(stopped).resolves.toBe(true)
    expect(repository.get('u1')?.presence).toBe('offline')
  })

  it('stop wakes a failing retry wait and finishes', async () => {
    const repository = await completedRepository('offline')
    const commit = jest
      .spyOn(repository, 'commitUserState')
      .mockRejectedValue(new Error('disk full'))
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot,
      {
        initialBackoffMs: 60_000,
      }
    )
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    await waitFor(() => coordinator.getUnhealthy('u1') !== undefined)
    await expect(coordinator.stop(500)).resolves.toBe(false)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('stop cuts off a dispatch that never completes at the deadline', async () => {
    const repository = await completedRepository('offline')
    const { promise: pending, resolve: release } =
      // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
      Promise.withResolvers<void>()
    const coordinator = new UserStateCoordinator(
      repository,
      () => pending,
      getSnapshot
    )
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    await expect(coordinator.stop(10)).resolves.toBe(false)
    release()
    await waitFor(() => repository.get('u1')?.presence === 'online')
  })

  it('persistent outbox mode processes state without waiting for network dispatch', async () => {
    const repository = await completedRepository('offline')
    const legacyDispatch = jest.fn(() => new Promise<void>(() => undefined))
    const onCommitted = jest.fn()
    const coordinator = new UserStateCoordinator(
      repository,
      legacyDispatch,
      getSnapshot,
      {
        prepareEffects: (userId, displayName, effects, config) => {
          const persistedConfig = {
            destinations: config.destinations,
            rules: [],
            loadedAt: config.loadedAt,
          }
          return effects.map((effect, index) => ({
            id: `${effect.type}-${index}`,
            userId,
            displayName,
            effect,
            configId: getPersistedConfigId(persistedConfig),
            config: persistedConfig,
            createdAt: '2026-01-01T00:00:00.000Z',
          }))
        },
        onCommitted,
      }
    )
    const commit = jest.spyOn(repository, 'commitUserState')
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })
    await expect(coordinator.stop()).resolves.toBe(true)
    expect(commit.mock.calls[0][2]).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ type: 'online' }),
      }),
    ])
    expect(commit.mock.calls[1][2]).toEqual([
      expect.objectContaining({
        effect: expect.objectContaining({ type: 'offline' }),
      }),
    ])
    expect(legacyDispatch).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledTimes(2)
    expect(repository.get('u1')?.presence).toBe('offline')
  })
})

describe('durable event clock', () => {
  it('keeps the receive time fixed across persist retries', async () => {
    const repository = await completedRepository('offline')
    jest
      .spyOn(repository, 'commitUserState')
      .mockRejectedValueOnce(new Error('disk full'))
    const observedTimes: (string | undefined)[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot,
      {
        initialBackoffMs: 30,
        prepareEffects: (
          _userId,
          _displayName,
          _effects,
          _snapshot,
          receivedAt
        ) => {
          observedTimes.push(receivedAt)
          return []
        },
      }
    )
    const before = Date.now()
    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    const after = Date.now()
    await waitFor(() => observedTimes.length === 2)
    await expect(coordinator.stop()).resolves.toBe(true)
    expect(observedTimes[0]).toBeDefined()
    expect(observedTimes[1]).toBe(observedTimes[0])
    const receivedMs = Date.parse(observedTimes[0] ?? '')
    expect(receivedMs).toBeGreaterThanOrEqual(before)
    expect(receivedMs).toBeLessThanOrEqual(after)
  })
})
