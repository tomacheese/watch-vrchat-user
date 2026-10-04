import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import type { ConfigSnapshot } from '../config/config-snapshot'
import { compileRules } from '../rules/rule-engine'
import {
  getUserStateDatabasePath,
  UserStateRepository,
} from '../state/user-state-repository'
import type { UserState } from '../state/user-state'
import { DeliveryError, type DiscordNotifier } from './discord-notifier'
import type { NotificationDispatcher } from './notification-dispatcher'
import { NotificationOutbox, prepareEffects } from './notification-outbox'
import type { PersistedEffect } from './outbox-types'

jest.mock('@book000/node-utils', () => ({
  Logger: { configure: () => ({ error: jest.fn(), warn: jest.fn() }) },
}))

/** 処理完了を固定 sleep に依存せず待つ */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Outbox test timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const state: UserState = {
  userId: 'u',
  displayName: 'Alice',
  presence: 'online',
  location: 'private',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const snapshot: ConfigSnapshot = {
  destinations: {
    a: {
      type: 'discord-webhook',
      url: 'https://discord.com/api/webhooks/1/secret-a',
    },
    b: {
      type: 'discord-webhook',
      url: 'https://discord.com/api/webhooks/2/secret-b',
    },
  },
  rules: compileRules([
    { name: 'rule', when: 'true', enabled: true, destinations: ['a', 'b'] },
  ]),
  loadedAt: state.updatedAt,
}

/** 通知予定を受理時点の設定と日時で生成する */
function intent(): PersistedEffect {
  return prepareEffects(
    'u',
    'Alice',
    [{ type: 'online', previous: undefined, current: state }],
    snapshot,
    state.updatedAt
  )[0]
}

describe('NotificationOutbox', () => {
  let directory: string
  let file: string
  let repository: UserStateRepository
  const outboxes: NotificationOutbox[] = []

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'))
    file = path.join(directory, 'state.json')
    repository = new UserStateRepository(file)
    repository.load()
  })
  afterEach(async () => {
    await Promise.all(outboxes.splice(0).map((outbox) => outbox.stop()))
    jest.restoreAllMocks()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  /** 実際の Repository を使い、外部配信だけを差し替える */
  function setup(repo = repository, destinations = ['a']) {
    const prepareEffect = jest
      .fn()
      .mockResolvedValue(
        destinations.map((name) => ({ name, embed: { title: name } }))
      )
    const send = jest
      .fn<Promise<void>, [string, string, unknown]>()
      .mockResolvedValue(undefined)
    const stop = jest.fn()
    const outbox = new NotificationOutbox(
      repo,
      { prepareEffect } as unknown as NotificationDispatcher,
      { send, stop } as unknown as DiscordNotifier
    )
    outboxes.push(outbox)
    return { outbox, prepareEffect, send, stop }
  }

  it('state と通知予定が同じ transaction に保存され、再起動後に復元する', async () => {
    const entry = intent()
    await repository.commitUserState('u', state, [entry])
    expect(repository.get('u')).toEqual(state)
    expect(repository.getPendingEffects()[0]).toEqual(entry)
    expect(
      fs
        .readFileSync(`${file.slice(0, -5)}.sqlite`)
        .subarray(0, 16)
        .toString()
    ).toBe('SQLite format 3\u0000')
    const reloaded = new UserStateRepository(file)
    reloaded.load()
    const { outbox, prepareEffect, send } = setup(reloaded)
    await outbox.start()
    await waitFor(() => reloaded.getPendingEffects().length === 0)
    expect(prepareEffect).toHaveBeenCalledWith(
      'u',
      entry.effect,
      expect.objectContaining({ loadedAt: snapshot.loadedAt }),
      new Date(entry.createdAt)
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('schema 3 の JSON outbox を元ファイルを保持したまま SQLite へ移行する', () => {
    const legacyFile = path.join(directory, 'legacy-friend-states.json')
    const entry = intent()
    const legacyEntry = Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== 'configId')
    )
    const contents = JSON.stringify({
      schemaVersion: 3,
      baselineCompleted: true,
      users: { u: state },
      outbox: [legacyEntry],
    })
    fs.writeFileSync(legacyFile, contents, { mode: 0o600 })

    const migrated = new UserStateRepository(legacyFile)
    migrated.load()
    expect(migrated.get('u')).toEqual(state)
    expect(migrated.isBaselineCompleted()).toBe(true)
    expect(migrated.getPendingEffects()).toMatchObject([
      { id: entry.id, configId: entry.configId, config: entry.config },
    ])
    expect(fs.readFileSync(legacyFile, 'utf8')).toBe(contents)
    expect(fs.existsSync(getUserStateDatabasePath(legacyFile))).toBe(true)
    migrated.close()
  })

  it('同じ設定の大量通知は設定を一度だけ保存し、設定 snapshot 数も制限する', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      ...intent(),
      id: `queued-${index}`,
    }))
    await repository.commitUserState('u', state, entries)
    const database = new DatabaseSync(getUserStateDatabasePath(file))
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM configs').get()
      ).toEqual({ count: 1 })
      expect(
        database.prepare('SELECT count(*) AS count FROM outbox').get()
      ).toEqual({ count: 1000 })
    } finally {
      database.close()
    }

    await repository.commitUserState(
      'u',
      state,
      prepareEffects(
        'u',
        'Alice',
        [{ type: 'online', previous: undefined, current: state }],
        { ...snapshot, loadedAt: '2026-02-01T00:00:00.000Z' }
      )
    )
    const deduplicatedDatabase = new DatabaseSync(
      getUserStateDatabasePath(file)
    )
    try {
      expect(
        deduplicatedDatabase
          .prepare('SELECT count(*) AS count FROM configs')
          .get()
      ).toEqual({ count: 1 })
    } finally {
      deduplicatedDatabase.close()
    }

    for (let index = 1; index < 32; index++) {
      const snapshotVersion = {
        ...snapshot,
        rules: compileRules([
          {
            name: `rule-${index}`,
            when: 'true',
            enabled: true,
            destinations: ['a', 'b'],
          },
        ]),
      }
      await repository.commitUserState('u', state, [
        prepareEffects(
          'u',
          'Alice',
          [{ type: 'online', previous: undefined, current: state }],
          snapshotVersion
        )[0],
      ])
    }
    const overflowSnapshot = {
      ...snapshot,
      rules: compileRules([
        {
          name: 'rule-overflow',
          when: 'true',
          enabled: true,
          destinations: ['a', 'b'],
        },
      ]),
    }
    await expect(
      repository.commitUserState('u', state, [
        prepareEffects(
          'u',
          'Alice',
          [{ type: 'online', previous: undefined, current: state }],
          overflowSnapshot
        )[0],
      ])
    ).rejects.toThrow(/too many configuration snapshots/)
  })

  it('1 通知先が成功済みなら、別の通知先の transient failure 後も再送しない', async () => {
    await repository.commitUserState('u', state, [intent()])
    const { outbox, send } = setup(repository, ['a', 'b'])
    send
      .mockImplementationOnce(() => Promise.resolve())
      .mockRejectedValueOnce(new DeliveryError('temporary', 503))
    await outbox.start()
    await waitFor(
      () =>
        repository.getPendingEffects()[0]?.deliveries?.[1]?.status ===
          'pending' &&
        repository.getPendingEffects()[0]?.deliveries?.[1]?.attempts === 1
    )
    const entry = repository.getPendingEffects()[0]
    expect(entry.deliveries?.[0].status).toBe('delivered')
    await outbox.stop()
    const reloaded = new UserStateRepository(file)
    reloaded.load()
    await reloaded.updatePendingEffect({
      ...entry,
      deliveries: entry.deliveries?.map((delivery) => ({
        ...delivery,
        nextAttemptAt: 0,
      })),
    })
    const resumed = setup(reloaded, ['a', 'b'])
    await resumed.outbox.start()
    await waitFor(() => reloaded.getPendingEffects().length === 0)
    expect(send.mock.calls.map(([name]) => name)).toEqual(['a', 'b'])
    expect(resumed.send.mock.calls.map(([name]) => name)).toEqual(['b'])
  })

  it('送達不明は永続化され、自動再送されない', async () => {
    await repository.commitUserState('u', state, [intent()])
    const { outbox, send } = setup()
    send.mockRejectedValue(
      new DeliveryError('unknown', undefined, undefined, true)
    )
    await outbox.start()
    await waitFor(() => outbox.getStatus().uncertain === 1)
    outbox.wake()
    const reloaded = new UserStateRepository(file)
    reloaded.load()
    expect(reloaded.getPendingEffects()[0].deliveries?.[0].status).toBe(
      'uncertain'
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('再起動時の sending は uncertain に変更して再送しない', async () => {
    const entry = intent()
    entry.deliveries = [
      { name: 'a', embed: { title: 'a' }, status: 'sending', attempts: 1 },
    ]
    await repository.commitUserState('u', state, [entry])
    const { outbox, send } = setup()
    await outbox.start()
    expect(outbox.getStatus().uncertain).toBe(1)
    expect(send).not.toHaveBeenCalled()
    const reloaded = new UserStateRepository(file)
    reloaded.load()
    expect(reloaded.getPendingEffects()[0].deliveries?.[0].status).toBe(
      'uncertain'
    )
  })

  it('429 は通知を保持して指定された待機時間の後に再試行する', async () => {
    await repository.commitUserState('u', state, [intent()])
    const { outbox, send } = setup()
    send.mockRejectedValue(new DeliveryError('rate limited', 429, 60_000))
    const start = Date.now()
    await outbox.start()
    await waitFor(
      () =>
        (repository.getPendingEffects()[0]?.deliveries?.[0]?.nextAttemptAt ??
          0) > 0
    )
    const delivery = repository.getPendingEffects()[0].deliveries?.[0]
    expect(delivery?.status).toBe('pending')
    expect(delivery?.nextAttemptAt).toBeGreaterThanOrEqual(start + 60_000)
    outbox.wake()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('shutdown は通信を中断し、送達不明の結果を保存するまで待つ', async () => {
    await repository.commitUserState('u', state, [intent()])
    const { promise, reject } = Promise.withResolvers<undefined>()
    const { outbox, send, stop } = setup()
    send.mockImplementation(() => promise)
    stop.mockImplementation(() => {
      reject(
        new DeliveryError('cancelled', undefined, undefined, true, false, true)
      )
    })
    await outbox.start()
    await waitFor(() => send.mock.calls.length === 1)
    expect(await outbox.stop()).toBe(true)
    expect(repository.getPendingEffects()[0].deliveries?.[0].status).toBe(
      'uncertain'
    )
    const reloaded = new UserStateRepository(file)
    reloaded.load()
    expect(reloaded.getPendingEffects()[0].deliveries?.[0].status).toBe(
      'uncertain'
    )
  })

  it('永続化の失敗では state も通知予定も確定しない', async () => {
    const first = intent()
    await repository.commitUserState('u', state, [first])
    await expect(
      repository.commitUserState('u2', { ...state, userId: 'u2' }, [first])
    ).rejects.toThrow()
    expect(repository.get('u2')).toBeUndefined()
    expect(repository.getPendingEffects()).toEqual([first])
    await repository.commitUserState('u2', { ...state, userId: 'u2' }, [
      intent(),
    ])
    expect(repository.getPendingEffects()).toHaveLength(2)
  })
})
