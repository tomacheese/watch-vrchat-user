import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { UserStateCoordinator } from './user-state-coordinator'
import { UserStateRepository } from './user-state-repository'
import type { ReducerEffect } from './user-state-reducer'

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-')),
    'user-locations.json'
  )
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('UserStateCoordinator', () => {
  it('同一ユーザーの observation を順番に処理し effect を発火する', async () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    // 8.6 unknown baseline ではなく 8.1/8.2/8.5 の通常フローを検証するため、
    // 既存 offline record がある状態から開始する
    await repository.commitUserState('u1', {
      userId: 'u1',
      displayName: 'Alice',
      presence: 'offline',
      location: null,
      updatedAt: '2025-12-31T00:00:00.000Z',
    })
    const effects: ReducerEffect[] = []
    const coordinator = new UserStateCoordinator(
      repository,
      (_userId, _displayName, effect) => {
        effects.push(effect)
        return Promise.resolve()
      }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', {
      type: 'location',
      location: 'traveling',
    })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_b' })
    coordinator.enqueue('u1', 'Alice', { type: 'offline' })

    await wait(50)

    // no-op effect は onEffect に渡されない（Coordinator の実装が effect.type !== 'no-op' でフィルタする）ため、
    // ここには traveling / wrld_a（baseline 保存のみ）の no-op は含まれない
    expect(effects).toEqual([
      { type: 'online' },
      {
        type: 'location-change',
        previousLocation: 'wrld_a',
        currentLocation: 'wrld_b',
      },
      { type: 'offline' },
    ])
    expect(repository.get('u1')).toMatchObject({
      presence: 'offline',
      location: null,
    })
  })

  it('appendSnapshotObservation は expectedSeq が古い場合 dropped し false を返す', () => {
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    const coordinator = new UserStateCoordinator(repository, () =>
      Promise.resolve()
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
    const coordinator = new UserStateCoordinator(repository, () =>
      Promise.resolve()
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
    const repository = new UserStateRepository(tempFilePath())
    repository.load()
    // online が baseline 保存（no-op）ではなく effect 'online' を発火するよう、
    // 事前に offline record を実際にコミットしておく
    await repository.commitUserState('u1', {
      userId: 'u1',
      displayName: 'Alice',
      presence: 'offline',
      location: null,
      updatedAt: '2025-12-31T00:00:00.000Z',
    })

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
      { initialBackoffMs: 30, maxBackoffMs: 30 }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })

    // 1 回目の persist 失敗直後（retry backoff 待機中）は unhealthy かつ何も effect が発火していない
    await wait(10)
    expect(coordinator.getUnhealthy('u1')).toBeDefined()
    expect(effects).toEqual([])

    // retry が成功すると head から順に処理され、unhealthy が解消する
    await wait(50)
    expect(effects).toEqual([{ type: 'online' }])
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
      {
        maxQueueSize: 2,
      }
    )

    coordinator.enqueue('u1', 'Alice', { type: 'online' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_a' })
    coordinator.enqueue('u1', 'Alice', { type: 'location', location: 'wrld_b' })

    expect(coordinator.getUnhealthy('u1')?.cause).toBe('queue-overflow')
  })
})
