import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { UserStateRepository } from './user-state-repository'

function tempFilePath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'user-state-')),
    'user-locations.json'
  )
}

describe('UserStateRepository', () => {
  it('ファイルが存在しない場合は空データで初期化される', () => {
    const repo = new UserStateRepository(tempFilePath())
    repo.load()
    expect(repo.getAll()).toEqual({})
  })

  it('legacy 形式のファイルを migrate して読み込む', () => {
    const filePath = tempFilePath()
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        users: {
          u1: {
            userId: 'u1',
            displayName: 'Alice',
            location: 'wrld_a',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      })
    )
    const repo = new UserStateRepository(filePath)
    repo.load()
    expect(repo.get('u1')).toMatchObject({
      presence: 'online',
      location: 'wrld_a',
    })
  })

  it('commitUserState はファイルへ atomic に書き込む', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await repo.commitUserState('u1', {
      userId: 'u1',
      displayName: 'Alice',
      presence: 'online',
      location: 'wrld_a',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const written: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(written).toMatchObject({
      schemaVersion: 2,
      users: { u1: { location: 'wrld_a' } },
    })
  })

  it('同時に複数ユーザーへ commit しても両方の更新が失われない（store-wide lock）', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await Promise.all([
      repo.commitUserState('u1', {
        userId: 'u1',
        displayName: 'Alice',
        presence: 'online',
        location: 'wrld_a',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      repo.commitUserState('u2', {
        userId: 'u2',
        displayName: 'Bob',
        presence: 'online',
        location: 'wrld_b',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ])

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      users: Record<string, unknown>
    }
    expect(Object.keys(written.users).sort()).toEqual(['u1', 'u2'])
  })
})
