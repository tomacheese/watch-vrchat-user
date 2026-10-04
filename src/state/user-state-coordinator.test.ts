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

/** baseline 完了済みで、指定 record を持つ Repository を作る */
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
  it('state が変化しない observation では永続化しない', async () => {
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

  it('同一ユーザーの observation を順番に処理し effect を発火する', async () => {
    // baseline 完了済みかつ既存 offline record がある通常フローから開始する
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

    // no-op effect は onEffect に渡されない（Coordinator の実装が effect.type !== 'no-op' でフィルタする）
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

  it('ステータスの変化は status-change として発火・永続化され、初回は記録だけを行う', async () => {
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

  it('appendSnapshotObservation は expectedSeq が古い場合 dropped し false を返す', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(
      repository,
      () => Promise.resolve(),
      getSnapshot
    )

    const seq = coordinator.captureSeq('u1')
    coordinator.enqueue('u1', 'Alice', { type: 'online' }) // seq を進める

    const appended = coordinator.appendSnapshotObservation(
      'u1',
      'Alice',
      { type: 'offline' },
      seq
    )
    expect(appended).toBe(false)
  })

  it('appendSnapshotObservation は queue に変化がなければ true を返し末尾に追記する', () => {
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

  it('persist が失敗した observation は queue head で保持され、後続を処理しない', async () => {
    const repository = await completedRepository('offline')

    // 1 回目の commit だけ失敗させ、以降は実際の commitUserState を通す
    // （mock で完全に置き換えると in-memory state が更新されず retry 後も
    // reducer が current=undefined のまま扱ってしまうため）
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

    // 1 回目の persist 失敗直後（retry backoff 待機中）は unhealthy かつ何も effect が発火していない
    await wait(10)
    expect(coordinator.getUnhealthy('u1')).toBeDefined()
    expect(effects).toEqual([])

    // retry が成功すると head から順に処理され、unhealthy が解消する
    await waitFor(
      () => effects.length === 2 && coordinator.getUnhealthy('u1') === undefined
    )
    expect(effects.map((effect) => effect.type)).toEqual([
      'online',
      'location-change',
    ])
    expect(coordinator.getUnhealthy('u1')).toBeUndefined()
  })

  it('queue が上限に達すると新規 enqueue を停止し unhealthy になる', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    jest
      .spyOn(repository, 'commitUserState')
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- queue-overflow を検証するため commit を意図的に永遠に処理中にする
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

  it('queue-overflow は persist が成功しても解消されない（データ損失の記録を保持する）', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    // Promise.withResolvers() の resolve は `(value: void) => void` 型となり
    // no-invalid-void-type と衝突するため、この形のまま使う
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

    // head の commit は成功したが、overflow によるデータ損失自体は解消しない
    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')
  })

  it('AC-11: onEffect には enqueue 時点の snapshot が渡され、getSnapshot が後で変わっても影響しない', async () => {
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

  it('オンライン化と同時の公開 Location 確定は online に続けて location-change を発火する', async () => {
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

  it('friend-delete は record を削除し、friend-delete effect を発火する', async () => {
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

  it('baseline 未完了中に届いた未知ユーザーの observation は通知なしで state 化される', async () => {
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

  it('baseline 完了後の未知ユーザーは friend-add のみを通知する', async () => {
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
    it('対象の queue が空になれば true を返す', async () => {
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

    it('enqueue されていないユーザーだけなら即座に true を返す', async () => {
      const repository = await completedRepository()
      const coordinator = new UserStateCoordinator(
        repository,
        () => Promise.resolve(),
        getSnapshot
      )
      await expect(coordinator.drain(['u1'])).resolves.toBe(true)
    })

    it('待機中に persist 失敗で unhealthy になると false を返す', async () => {
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

    it('queue-overflow 済みのユーザーが対象なら false を返す', async () => {
      const repository = await completedRepository('offline')
      jest
        .spyOn(repository, 'commitUserState')
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- overflow を作るため commit を永遠に処理中にする
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
  it('persist-failure 後の overflow は復旧後も記録する', async () => {
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

  it('offline の表示名は先行 observation の commit 後に補完する', async () => {
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

  it('stop は受付を終了して正常な queue の永続化を待つ', async () => {
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

  it('stop は失敗中の retry 待機を起こして終了する', async () => {
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

  it('stop は完了しない dispatch を期限で打ち切る', async () => {
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

  it('永続 outbox モードは network dispatch を待たず state を処理する', async () => {
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
  it('永続化を再試行しても受信時刻を固定する', async () => {
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
