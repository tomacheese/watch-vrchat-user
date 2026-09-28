import { isUserStateStoreData } from './user-state'

const record = {
  userId: 'u1',
  displayName: 'Alice',
  presence: 'online',
  location: 'wrld_1',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('isUserStateStoreData', () => {
  it('schemaVersion 3 の正しいデータは true', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: false,
        users: { u1: record },
      })
    ).toBe(true)
  })

  it('schemaVersion 2 と legacy 形式は false', () => {
    expect(isUserStateStoreData({ schemaVersion: 2, users: {} })).toBe(false)
    expect(isUserStateStoreData({ users: {} })).toBe(false)
  })

  it('baselineCompleted が boolean でない場合は false', () => {
    expect(isUserStateStoreData({ schemaVersion: 3, users: {} })).toBe(false)
  })

  it('レコードの location が undefined の場合は false', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: true,
        users: { u1: { ...record, location: undefined } },
      })
    ).toBe(false)
  })

  it('レコードの presence が online/offline 以外の場合は false', () => {
    expect(
      isUserStateStoreData({
        schemaVersion: 3,
        baselineCompleted: true,
        users: { u1: { ...record, presence: 'traveling' } },
      })
    ).toBe(false)
  })
})
