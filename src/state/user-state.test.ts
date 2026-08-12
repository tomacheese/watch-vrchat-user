import { migrateStoreData, isUserStateStoreData } from './user-state'

describe('isUserStateStoreData', () => {
  it('schemaVersion 2 かつ presence を持つ場合は true', () => {
    const data = {
      schemaVersion: 2,
      users: {
        u1: {
          userId: 'u1',
          displayName: 'Alice',
          presence: 'online',
          location: 'wrld_1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    expect(isUserStateStoreData(data)).toBe(true)
  })

  it('schemaVersion がない legacy 形式は false', () => {
    const data = { users: {} }
    expect(isUserStateStoreData(data)).toBe(false)
  })
})

describe('migrateStoreData', () => {
  it('既に新形式の場合はそのまま返す', () => {
    const data = {
      schemaVersion: 2,
      users: {
        u1: {
          userId: 'u1',
          displayName: 'Alice',
          presence: 'online',
          location: 'wrld_1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    expect(migrateStoreData(data)).toEqual(data)
  })

  it('legacy: concrete location を持つレコードは presence=online に migrate する', () => {
    const legacy = {
      users: {
        u1: {
          userId: 'u1',
          displayName: 'Alice',
          location: 'wrld_1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const migrated = migrateStoreData(legacy)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.users.u1).toEqual({
      userId: 'u1',
      displayName: 'Alice',
      presence: 'online',
      location: 'wrld_1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('legacy: location=null のレコードは presence=offline に migrate する', () => {
    const legacy = {
      users: {
        u1: {
          userId: 'u1',
          displayName: 'Alice',
          location: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const migrated = migrateStoreData(legacy)
    expect(migrated.users.u1.presence).toBe('offline')
    expect(migrated.users.u1.location).toBeNull()
  })

  it('legacy: location="online" sentinel は presence=online, location=null に migrate する', () => {
    const legacy = {
      users: {
        u1: {
          userId: 'u1',
          displayName: 'Alice',
          location: 'online',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const migrated = migrateStoreData(legacy)
    expect(migrated.users.u1.presence).toBe('online')
    expect(migrated.users.u1.location).toBeNull()
  })

  it('不正な形式（null）は空の schemaVersion 2 データを返す', () => {
    expect(migrateStoreData(null)).toEqual({ schemaVersion: 2, users: {} })
  })
})
