import { reduce } from './user-state-reducer'
import type { UserState } from './user-state'

const FIXED_NOW = () => '2026-01-01T00:00:00.000Z'

function state(overrides: Partial<UserState> = {}): UserState {
  return {
    userId: 'u1',
    displayName: 'Alice',
    presence: 'offline',
    location: null,
    updatedAt: '2025-12-31T00:00:00.000Z',
    ...overrides,
  }
}

describe('reduce', () => {
  it('offline -> online: online 通知を発火する', () => {
    const current = state({ presence: 'offline', location: null })
    const result = reduce(current, 'Alice', { type: 'online' }, FIXED_NOW)
    expect(result.effect).toEqual({ type: 'online' })
    expect(result.nextState).toMatchObject({
      presence: 'online',
      location: null,
    })
  })

  it('record 不在ユーザーへの最初の online observation は baseline として保存し通知しない（unknown baseline）', () => {
    const result = reduce(undefined, 'Alice', { type: 'online' }, FIXED_NOW)
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toMatchObject({
      presence: 'online',
      location: null,
    })
  })

  it('online 中の duplicate online は通知しない', () => {
    const current = state({ presence: 'online', location: null })
    const result = reduce(current, 'Alice', { type: 'online' }, FIXED_NOW)
    expect(result.effect).toEqual({ type: 'no-op' })
  })

  it('traveling は persisted location を変更せず通知しない', () => {
    const current = state({ presence: 'online', location: 'wrld_a' })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'traveling' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toEqual(current)
  })

  it('online 直後の最初の確定 location は baseline として保存し通知しない', () => {
    const current = state({ presence: 'online', location: null })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'wrld_a' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toMatchObject({
      presence: 'online',
      location: 'wrld_a',
    })
  })

  it('A -> traveling -> B は A -> B の移動通知になる', () => {
    const current = state({ presence: 'online', location: 'wrld_a' })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'wrld_b' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({
      type: 'location-change',
      previousLocation: 'wrld_a',
      currentLocation: 'wrld_b',
    })
  })

  it('duplicate concrete location は通知しない', () => {
    const current = state({ presence: 'online', location: 'wrld_a' })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'wrld_a' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({ type: 'no-op' })
  })

  it('friend-online 欠落状態で concrete location を受けても online と推定する', () => {
    const current = state({ presence: 'offline', location: null })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'wrld_a' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({ type: 'online' })
    expect(result.nextState).toMatchObject({
      presence: 'online',
      location: 'wrld_a',
    })
  })

  it('online -> offline: offline 通知を発火し location を null にする', () => {
    const current = state({ presence: 'online', location: 'wrld_a' })
    const result = reduce(current, 'Alice', { type: 'offline' }, FIXED_NOW)
    expect(result.effect).toEqual({ type: 'offline' })
    expect(result.nextState).toMatchObject({
      presence: 'offline',
      location: null,
    })
  })

  it('record 不在ユーザーへの REST 由来 concrete location は baseline として保存し通知しない（unknown baseline）', () => {
    const result = reduce(
      undefined,
      'Alice',
      { type: 'location', location: 'wrld_a' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toMatchObject({
      presence: 'online',
      location: 'wrld_a',
    })
  })

  it('private は stable な confirmed location として扱われる（traveling と異なり通知対象）', () => {
    const current = state({ presence: 'online', location: 'wrld_a' })
    const result = reduce(
      current,
      'Alice',
      { type: 'location', location: 'private' },
      FIXED_NOW
    )
    expect(result.effect).toEqual({
      type: 'location-change',
      previousLocation: 'wrld_a',
      currentLocation: 'private',
    })
  })
})
