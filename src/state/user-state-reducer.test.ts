import { reduce, type UserObservation } from './user-state-reducer'
import type { UserState } from './user-state'

const FIXED_NOW = () => '2026-01-01T00:00:00.000Z'
const A = 'wrld_a:1'
const B = 'wrld_b:2'

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

function run(
  current: UserState | undefined,
  observation: UserObservation,
  baseline = false
) {
  return reduce('u1', current, 'Alice', observation, baseline, FIXED_NOW)
}

describe('reduce (spec §7 遷移表)', () => {
  it('1. offline -> online（online 観測）は online のみ', () => {
    const current = state()
    const result = run(current, { type: 'online' })
    expect(result.deleteUser).toBe(false)
    expect(result.effect).toEqual({
      type: 'online',
      previous: current,
      current: result.nextState,
    })
    expect(result.nextState).toMatchObject({
      userId: 'u1',
      presence: 'online',
      location: null,
    })
  })

  it('1. offline -> online（location 観測）は online と location-change', () => {
    const result = run(state(), { type: 'location', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.followUp).toMatchObject({ type: 'location-change' })
    expect(result.nextState).toMatchObject({ presence: 'online', location: A })
  })

  it('1. online 観測に location があれば state に載せ、location-change も発火する', () => {
    const result = run(state(), { type: 'online', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.followUp).toMatchObject({ type: 'location-change' })
    expect(result.nextState).toMatchObject({ location: A })
  })

  it('2. online -> offline は offline のみで location を null にする', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'offline' })
    expect(result.effect).toEqual({
      type: 'offline',
      previous: current,
      current: result.nextState,
    })
    expect(result.nextState).toMatchObject({
      presence: 'offline',
      location: null,
    })
  })

  it('3. 両方 visible で raw 値が異なれば location-change', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'location', location: B })
    expect(result.effect).toEqual({
      type: 'location-change',
      previous: current,
      current: result.nextState,
    })
  })

  it('4. 公開 -> private と private -> 公開はどちらも location-change', () => {
    const current = state({ presence: 'online', location: A })
    const toPrivate = run(current, { type: 'location', location: 'private' })
    expect(toPrivate.effect).toEqual({
      type: 'location-change',
      previous: current,
      current: toPrivate.nextState,
    })
    expect(toPrivate.nextState).toMatchObject({ location: 'private' })

    const back = run(toPrivate.nextState, { type: 'location', location: B })
    expect(back.effect).toMatchObject({ type: 'location-change' })
    expect(back.nextState).toMatchObject({ location: B })
  })

  it('4. private の維持と未確定 location からの private は no-op', () => {
    const stay = run(state({ presence: 'online', location: 'private' }), {
      type: 'location',
      location: 'private',
    })
    expect(stay.effect).toEqual({ type: 'no-op' })

    const fromUnknown = run(state({ presence: 'online', location: null }), {
      type: 'location',
      location: 'private',
    })
    expect(fromUnknown.effect).toEqual({ type: 'no-op' })
  })

  it('4. 未確定 location からの確定は no-op（state のみ更新）', () => {
    const current = state({ presence: 'online', location: null })
    const result = run(current, { type: 'location', location: A })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toMatchObject({ location: A })
  })

  it('4. 同一 location は no-op で state を変更しない', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'location', location: A })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
  })

  it('4. online 中の重複 online 観測は location を維持し no-op', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'online' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
  })

  it('5. traveling は state 不変で no-op（A -> traveling -> B は A -> B）', () => {
    const current = state({ presence: 'online', location: A })
    const traveling = run(current, {
      type: 'location',
      location: 'traveling:traveling',
    })
    expect(traveling.effect).toEqual({ type: 'no-op' })
    expect(traveling.nextState).toBe(current)

    const moved = run(traveling.nextState, { type: 'location', location: B })
    expect(moved.effect).toMatchObject({
      type: 'location-change',
      previous: { location: A },
      current: { location: B },
    })
  })

  it('5. record 不在への traveling は state を作らない', () => {
    const result = run(undefined, { type: 'location', location: 'traveling' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBeUndefined()
  })

  it('6. record 不在 + baseline=false は friend-add のみ', () => {
    for (const observation of [
      { type: 'online' },
      { type: 'offline' },
      { type: 'location', location: A },
    ] as const) {
      const result = run(undefined, observation)
      expect(result.effect).toEqual({
        type: 'friend-add',
        previous: undefined,
        current: result.nextState,
      })
      expect(result.nextState).toMatchObject({ userId: 'u1' })
    }
    expect(
      run(undefined, { type: 'location', location: A }).nextState
    ).toMatchObject({ presence: 'online', location: A })
  })

  it('7. friend-add observation で record 不在は friend-add', () => {
    const result = run(undefined, { type: 'friend-add' })
    expect(result.effect).toMatchObject({
      type: 'friend-add',
      previous: undefined,
    })
    expect(result.nextState).toMatchObject({
      userId: 'u1',
      displayName: 'Alice',
      presence: 'offline',
      location: null,
    })
  })

  it('8. friend-add observation で record 既存は no-op', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'friend-add' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
    expect(result.deleteUser).toBe(false)
  })

  it('9. friend-delete で record 既存は friend-delete と deleteUser', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'friend-delete' })
    expect(result.effect).toEqual({
      type: 'friend-delete',
      previous: current,
      current: undefined,
    })
    expect(result.deleteUser).toBe(true)
    expect(result.nextState).toBeUndefined()
  })

  it('10. friend-delete で record 不在は no-op', () => {
    const result = run(undefined, { type: 'friend-delete' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.deleteUser).toBe(false)
  })

  it('11. baseline=true は通知 effect を生成せず state のみ更新する', () => {
    const online = run(state(), { type: 'online' }, true)
    expect(online.effect).toEqual({ type: 'no-op' })
    expect(online.nextState).toMatchObject({ presence: 'online' })

    const moved = run(
      state({ presence: 'online', location: A }),
      { type: 'location', location: B },
      true
    )
    expect(moved.effect).toEqual({ type: 'no-op' })
    expect(moved.nextState).toMatchObject({ location: B })

    const unknown = run(undefined, { type: 'friend-add' }, true)
    expect(unknown.effect).toEqual({ type: 'no-op' })
    expect(unknown.nextState).toMatchObject({ userId: 'u1' })

    const deleted = run(state(), { type: 'friend-delete' }, true)
    expect(deleted.effect).toEqual({ type: 'no-op' })
    expect(deleted.deleteUser).toBe(true)
  })
})

describe('reduce (online 後の最初の location)', () => {
  it('location 未確定の online 後、最初の可視 location は location-change になる', () => {
    const online = run(state(), { type: 'online' })
    expect(online.nextState?.firstLocationPending).toBe(true)
    const result = run(online.nextState, { type: 'location', location: A })
    expect(result.effect).toMatchObject({ type: 'location-change' })
    expect(result.nextState?.firstLocationPending).toBeUndefined()
  })

  it('location が確定した online は pending にならない', () => {
    const result = run(state(), { type: 'online', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.nextState?.firstLocationPending).toBeUndefined()
  })
})
