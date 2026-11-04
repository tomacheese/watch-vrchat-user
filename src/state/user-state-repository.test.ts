import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import {
  getUserStateDatabasePath,
  UserStateRepository,
} from './user-state-repository'

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

function readStore(filePath: string) {
  const repository = new UserStateRepository(filePath)
  repository.load()
  const data = {
    schemaVersion: 3,
    baselineCompleted: repository.isBaselineCompleted(),
    users: { ...repository.getAll() },
    outbox: [...repository.getPendingEffects()],
  }
  repository.close()
  return data
}

describe('UserStateRepository', () => {
  it('initializes with empty data when the file does not exist', () => {
    const repo = new UserStateRepository(tempFilePath())
    repo.load()
    expect(repo.getAll()).toEqual({})
    expect(repo.isBaselineCompleted()).toBe(false)
  })

  it('schemaVersion 2 and the legacy format keep the original file and refuse to start', () => {
    for (const content of [
      { schemaVersion: 2, users: { u1: aliceState() } },
      { users: { u1: { userId: 'u1', location: 'wrld_a' } } },
    ]) {
      const filePath = tempFilePath()
      fs.writeFileSync(filePath, JSON.stringify(content))
      const repo = new UserStateRepository(filePath)
      expect(() => {
        repo.load()
      }).toThrow()
      expect(fs.readFileSync(filePath, 'utf8')).toBe(JSON.stringify(content))
    }
  })

  it('broken JSON keeps the original file and refuses to start', () => {
    const filePath = tempFilePath()
    fs.writeFileSync(filePath, '{not json')
    const repo = new UserStateRepository(filePath)
    expect(() => {
      repo.load()
    }).toThrow()
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json')
  })

  it('uses the STATE_FILE_PATH environment variable as the path', () => {
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

  it('commitUserState persists state in a SQLite transaction', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await repo.commitUserState('u1', aliceState())

    expect(
      fs
        .readFileSync(getUserStateDatabasePath(filePath))
        .subarray(0, 16)
        .toString()
    ).toBe('SQLite format 3\u0000')
    expect(readStore(filePath)).toMatchObject({
      schemaVersion: 3,
      baselineCompleted: false,
      users: { u1: { location: 'wrld_a' } },
    })
  })

  it('setBaselineCompleted is persisted and restored on reload', async () => {
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

  it('deleteUser removes and persists the record while keeping other users and the baseline', async () => {
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

  it('concurrent commits for multiple users lose neither update (store-wide lock)', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()

    await Promise.all([
      repo.commitUserState('u1', aliceState()),
      repo.commitUserState('u2', { ...aliceState('wrld_b'), userId: 'u2' }),
      repo.setBaselineCompleted(),
    ])

    const written = readStore(filePath)
    expect(
      Object.keys(written.users).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['u1', 'u2'])
    expect(written.baselineCompleted).toBe(true)
  })

  it('batches multiple updates in the same turn into one SQLite transaction', async () => {
    const filePath = tempFilePath()
    const repo = new UserStateRepository(filePath)
    repo.load()
    await Promise.all([
      repo.commitUserState('u1', aliceState()),
      repo.commitUserState('u2', { ...aliceState(), userId: 'u2' }),
      repo.setBaselineCompleted(),
    ])
    const restored = new UserStateRepository(filePath)
    restored.load()
    expect(
      Object.keys(restored.getAll()).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['u1', 'u2'])
    expect(restored.isBaselineCompleted()).toBe(true)
  })

  it('the live writer lock rejects writes from the recovery CLI and other processes', () => {
    const filePath = tempFilePath()
    const live = new UserStateRepository(filePath, { exclusive: true })
    live.load()
    const recovery = new UserStateRepository(filePath, { exclusive: true })
    try {
      expect(() => {
        recovery.load()
      }).toThrow(/in use/)
      live.close()
      recovery.load()
      expect(
        fs.existsSync(
          `${getUserStateDatabasePath(filePath)}.writer-lock.sqlite`
        )
      ).toBe(true)
    } finally {
      live.close()
      recovery.close()
    }
    expect(
      fs.existsSync(`${getUserStateDatabasePath(filePath)}.writer-lock.sqlite`)
    ).toBe(true)
  })

  it('the OS releases the writer lock when the process exits', () => {
    const filePath = tempFilePath()
    const live = new UserStateRepository(filePath, { exclusive: true })
    live.load()
    live.close()
    const recovery = new UserStateRepository(filePath, { exclusive: true })
    expect(() => {
      recovery.load()
    }).not.toThrow()
    recovery.close()
  })

  it('SQLite releases the lock even if the writer process is killed', async () => {
    const filePath = tempFilePath()
    const lockPath = `${getUserStateDatabasePath(filePath)}.writer-lock.sqlite`
    const child = spawn(
      process.execPath,
      [
        '-e',
        String.raw`const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1], { timeout: 0 })
db.exec('CREATE TABLE IF NOT EXISTS writer_lock (id INTEGER PRIMARY KEY)')
db.exec('BEGIN EXCLUSIVE')
db.prepare('INSERT OR REPLACE INTO writer_lock (id) VALUES (1)').run()
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)`,
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    await once(child.stdout, 'data')
    child.kill('SIGKILL')
    await once(child, 'exit')

    const repository = new UserStateRepository(filePath, { exclusive: true })
    expect(() => {
      repository.load()
    }).not.toThrow()
    repository.close()
  })

  it('migrates existing JSON, and a failed transaction is not reflected in in-memory state', async () => {
    const filePath = tempFilePath()
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 3,
        baselineCompleted: false,
        users: {},
      })
    )
    const repo = new UserStateRepository(filePath)
    repo.load()
    await repo.commitUserState('u1', aliceState())
    expect(repo.get('u1')).toMatchObject({ location: 'wrld_a' })
    expect(readStore(filePath).users.u1).toMatchObject({ location: 'wrld_a' })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toMatchObject({
      schemaVersion: 3,
      users: {},
    })
  })
})
