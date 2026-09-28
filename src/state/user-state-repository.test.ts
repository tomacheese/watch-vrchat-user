import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { UserStateRepository } from './user-state-repository'

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'user-state-')),
    'friend-states.json'
  )
}

function aliceState(location = 'wrld_a') {
  return {
    userId: 'u1',
    displayName: 'Alice',
    presence: 'online' as const,
    location,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('UserStateRepository', () => {
  it('ファイルが存在しない場合は空データで初期化される', () => {
    const repo = new UserStateRepository(tempFilePath())
    repo.load()
    expect(repo.getAll()).toEqual({})
    expect(repo.isBaselineCompleted()).toBe(false)
  })

  it('schemaVersion 2 と legacy 形式のファイルは空データとして扱う', () => {
    for (const content of [
      { schemaVersion: 2, users: { u1: aliceState() } },
      { users: { u1: { userId: 'u1', location: 'wrld_a' } } },
    ]) {
      const filePath = tempFilePath()
      fs.writeFileSync(filePath, JSON.stringify(content))
      const repo = new UserStateRepository(filePath)
      repo.load()
      expect(repo.getAll()).toEqual({})
      expect(repo.isBaselineCompleted()).toBe(false)
    }
  })

  it('壊れた JSON は空データとして扱う', () => {
    const filePath = tempFilePath()
    fs.writeFileSync(filePath, '{not json')
    const repo = new UserStateRepository(filePath)
    repo.load()
    expect(repo.getAll()).toEqual({})
  })

  it('環境変数 STATE_FILE_PATH をパスに使う', () => {
    const filePath = tempFilePath()
    process.env.STATE_FILE_PATH = filePath
    try {
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 3,
          baselineCompleted: true,
          users: { u1: aliceState() },
        })
      )
      const repo = new UserStateRepository()
      repo.load()
      expect(repo.get('u1')).toMatchObject({ location: 'wrld_a' })
      expect(repo.isBaselineCompleted()).toBe(true)
    } finally {
      delete process.env.STATE_FILE_PATH
    }
  })

  it('commitUserState はファイルへ atomic に書き込む', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await repo.commitUserState('u1', aliceState())

    const written: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(written).toMatchObject({
      schemaVersion: 3,
      baselineCompleted: false,
      users: { u1: { location: 'wrld_a' } },
    })
  })

  it('setBaselineCompleted は永続化され、再 load で復元される', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()
    await repo.commitUserState('u1', aliceState())
    await repo.setBaselineCompleted()
    expect(repo.isBaselineCompleted()).toBe(true)

    const reloaded = new UserStateRepository(filePath)
    reloaded.load()
    expect(reloaded.isBaselineCompleted()).toBe(true)
    expect(reloaded.get('u1')).toBeDefined()
  })

  it('deleteUser は record を削除して永続化し、他ユーザーと baseline は保持する', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()
    await repo.commitUserState('u1', aliceState())
    await repo.commitUserState('u2', { ...aliceState(), userId: 'u2' })
    await repo.setBaselineCompleted()

    await repo.deleteUser('u1')

    expect(repo.get('u1')).toBeUndefined()
    const reloaded = new UserStateRepository(filePath)
    reloaded.load()
    expect(Object.keys(reloaded.getAll())).toEqual(['u2'])
    expect(reloaded.isBaselineCompleted()).toBe(true)
  })

  it('同時に複数ユーザーへ commit しても両方の更新が失われない（store-wide lock）', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await Promise.all([
      repo.commitUserState('u1', aliceState()),
      repo.commitUserState('u2', { ...aliceState('wrld_b'), userId: 'u2' }),
      repo.setBaselineCompleted(),
    ])

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      baselineCompleted: boolean
      users: Record<string, unknown>
    }
    expect(
      Object.keys(written.users).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['u1', 'u2'])
    expect(written.baselineCompleted).toBe(true)
  })

  it('write 失敗時は in-memory state を変更せず、retry で正しく反映できる', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    // tmp 書き込み先をディレクトリにしておくことで writeFile を確実に失敗させる
    fs.mkdirSync(`${filePath}.tmp`)

    await expect(repo.commitUserState('u1', aliceState())).rejects.toThrow()
    // 書き込みが失敗した場合、in-memory state は変更されていないこと
    expect(repo.get('u1')).toBeUndefined()
    await expect(repo.setBaselineCompleted()).rejects.toThrow()
    expect(repo.isBaselineCompleted()).toBe(false)

    fs.rmdirSync(`${filePath}.tmp`)
    await repo.commitUserState('u1', aliceState())
    expect(repo.get('u1')).toMatchObject({ location: 'wrld_a' })
  })
})
