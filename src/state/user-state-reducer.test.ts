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

describe('reduce (spec §7 transition table)', () => {
  it('1. offline -> online (online observation) yields online only', () => {
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

  it('1. offline -> online (location observation) yields online and location-change', () => {
    const result = run(state(), { type: 'location', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.followUp).toMatchObject({ type: 'location-change' })
    expect(result.nextState).toMatchObject({ presence: 'online', location: A })
  })

  it('1. an online observation with a location stores it in state and also fires location-change', () => {
    const result = run(state(), { type: 'online', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.followUp).toMatchObject({ type: 'location-change' })
    expect(result.nextState).toMatchObject({ location: A })
  })

  it('2. online -> offline yields offline only and sets location to null', () => {
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

  it('3. location-change when both are visible and the raw values differ', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'location', location: B })
    expect(result.effect).toEqual({
      type: 'location-change',
      previous: current,
      current: result.nextState,
    })
  })

  it('4. public -> private and private -> public are both location-change', () => {
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

  it('4. staying private and going private from an unconfirmed location are no-op', () => {
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

  it('4. confirming from an unconfirmed location is no-op (state only updated)', () => {
    const current = state({ presence: 'online', location: null })
    const result = run(current, { type: 'location', location: A })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toMatchObject({ location: A })
  })

  it('4. the same location is no-op and leaves state unchanged', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'location', location: A })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
  })

  it('4. a duplicate online observation while online keeps the location and is no-op', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'online' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
  })

  it('5. traveling leaves state unchanged and is no-op (A -> traveling -> B behaves as A -> B)', () => {
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

  it('5. traveling for a missing record does not create state', () => {
    const result = run(undefined, { type: 'location', location: 'traveling' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBeUndefined()
  })

  it('6. missing record + baseline=false yields friend-add only', () => {
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

  it('7. a friend-add observation with a missing record yields friend-add', () => {
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

  it('8. a friend-add observation with an existing record is no-op', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'friend-add' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.nextState).toBe(current)
    expect(result.deleteUser).toBe(false)
  })

  it('9. friend-delete with an existing record yields friend-delete and deleteUser', () => {
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

  it('10. friend-delete with a missing record is no-op', () => {
    const result = run(undefined, { type: 'friend-delete' })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.deleteUser).toBe(false)
  })

  it('11. baseline=true produces no notification effect and only updates state', () => {
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

describe('reduce (first location after online)', () => {
  it('after an online with an unconfirmed location, the first visible location becomes location-change', () => {
    const online = run(state(), { type: 'online' })
    expect(online.nextState?.firstLocationPending).toBe(true)
    const result = run(online.nextState, { type: 'location', location: A })
    expect(result.effect).toMatchObject({ type: 'location-change' })
    expect(result.nextState?.firstLocationPending).toBeUndefined()
  })

  it('an online with a confirmed location does not become pending', () => {
    const result = run(state(), { type: 'online', location: A })
    expect(result.effect).toMatchObject({ type: 'online' })
    expect(result.nextState?.firstLocationPending).toBeUndefined()
  })
})

describe('reduce (status / status message)', () => {
  const join = { status: 'join me', statusDescription: 'ダンス募集' }

  it('only records for an unconfirmed user without notifying', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'profile', profile: join })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })

  it('returns status-change when the status changes', () => {
    const current = state({
      presence: 'online',
      location: A,
      status: 'active',
      statusDescription: 'hi',
    })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'busy', statusDescription: 'hi' },
    })
    expect(result.statusEffect).toEqual({
      type: 'status-change',
      previous: current,
      current: result.nextState,
    })
    expect(result.nextState).toMatchObject({ status: 'busy' })
    expect(result.effect).toEqual({ type: 'no-op' })
  })

  it('returns status-change even when only the status message changes', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'b' },
    })
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('returns the same state and no effect when nothing changed', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'a' },
    })
    expect(result.nextState).toBe(current)
    expect(result.statusEffect).toBeUndefined()
  })

  it('keeps the previous status when status is offline', () => {
    const current = state({ status: 'busy', statusDescription: 'a' })
    const result = run(current, {
      type: 'offline',
      profile: { status: 'offline', statusDescription: 'a' },
    })
    expect(result.nextState).toMatchObject({ status: 'busy' })
    expect(result.statusEffect).toBeUndefined()
  })

  it('does not notify the first real status after only the message was recorded from an offline observation', () => {
    const offline = run(state({ presence: 'online', location: A }), {
      type: 'offline',
      profile: { status: 'offline', statusDescription: 'a' },
    })
    expect(offline.nextState?.status).toBeUndefined()
    expect(offline.statusEffect).toBeUndefined()
    const result = run(offline.nextState, {
      type: 'online',
      profile: { status: 'active', statusDescription: 'a' },
    })
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject({ status: 'active' })
  })

  it('returns status-change when a confirmed message changes even if status is unconfirmed', () => {
    const current = state({ statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'offline', statusDescription: 'b' },
    })
    expect(result.statusEffect).toEqual({
      type: 'status-change',
      previous: current,
      current: result.nextState,
    })
    expect(result.nextState?.status).toBeUndefined()
  })

  it('a REST snapshot initializes only unconfirmed profile fields and returns no status-change', () => {
    const current = state({ status: 'active' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'busy', statusDescription: '作業中' },
      profileBaseline: true,
    })

    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject({
      status: 'active',
      statusDescription: '作業中',
    })
  })

  it('a REST snapshot does not overwrite confirmed profile fields', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'busy', statusDescription: 'b' },
      profileBaseline: true,
    })

    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toBe(current)
  })

  it('when a message change coincides with the first status confirmation, status is not treated as a change', () => {
    const result = run(state({ statusDescription: 'a' }), {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'b' },
    })
    expect(result.statusEffect).toMatchObject({
      previous: { status: 'active' },
      current: { status: 'active' },
    })
  })

  it('an empty-string message also counts as confirmed and notifies when it changes', () => {
    const result = run(state({ statusDescription: '' }), {
      type: 'profile',
      profile: { status: 'offline', statusDescription: 'x' },
    })
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('the first observation with the message also unconfirmed does not notify', () => {
    const result = run(state(), {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'a' },
    })
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject({
      status: 'active',
      statusDescription: 'a',
    })
  })

  it('during baseline, only records and does not notify', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, { type: 'profile', profile: join }, true)
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })

  it('a status change together with an online transition returns both effects', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, { type: 'online', profile: join })
    expect(result.effect.type).toBe('online')
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('a profile observation for a user without a record is ignored', () => {
    const result = run(undefined, { type: 'profile', profile: join })
    expect(result.nextState).toBeUndefined()
    expect(result.statusEffect).toBeUndefined()
  })

  it('a status observed together with friend-add is only recorded', () => {
    const result = run(undefined, { type: 'friend-add', profile: join })
    expect(result.effect.type).toBe('friend-add')
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })
})

describe('combined profile effects', () => {
  it('online and followUp include the profile observed at the same time', () => {
    const result = run(
      state({ status: 'active', statusDescription: 'before' }),
      {
        type: 'online',
        location: A,
        profile: { status: 'join me', statusDescription: 'after' },
      }
    )
    expect(result.effect).toMatchObject({
      current: { status: 'join me', statusDescription: 'after' },
      previous: { status: 'active', statusDescription: 'before' },
    })
    expect(result.followUp).toMatchObject({
      current: { status: 'join me', statusDescription: 'after' },
    })
  })

  it('friend-add for an unknown user also includes the initial profile', () => {
    const result = run(undefined, {
      type: 'online',
      profile: { status: 'busy', statusDescription: 'working' },
    })
    expect(result.effect).toMatchObject({
      type: 'friend-add',
      current: { status: 'busy', statusDescription: 'working' },
    })
  })
})
