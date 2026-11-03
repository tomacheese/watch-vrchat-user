import { isUserStateStoreData } from './user-state'

const record = {
  userId: 'u1',
  displayName: 'Alice',
  presence: 'online',
  location: 'wrld_1',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('isUserStateStoreData', () => {
  it('valid schemaVersion 3 data is true', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: false,
        users: { u1: record },
      })
    ).toBe(true)
  })

  it('schemaVersion 2 and the legacy format are false', () => {
    expect(isUserStateStoreData({ schemaVersion: 2, users: {} })).toBe(false)
    expect(isUserStateStoreData({ users: {} })).toBe(false)
  })

  it('false when baselineCompleted is not a boolean', () => {
    expect(isUserStateStoreData({ schemaVersion: 3, users: {} })).toBe(false)
  })

  it('false when the record location is undefined', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: true,
        users: { u1: { ...record, location: undefined } },
      })
    ).toBe(false)
  })

  it('false when the record presence is not online/offline', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: true,
        users: { u1: { ...record, presence: 'traveling' } },
      })
    ).toBe(false)
  })
})
