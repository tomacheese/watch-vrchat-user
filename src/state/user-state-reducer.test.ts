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

describe('reduce (ステータス / ステータスメッセージ)', () => {
  const join = { status: 'join me', statusDescription: 'ダンス募集' }

  it('未確認のユーザーには通知せず記録だけを行う', () => {
    const current = state({ presence: 'online', location: A })
    const result = run(current, { type: 'profile', profile: join })
    expect(result.effect).toEqual({ type: 'no-op' })
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })

  it('ステータスが変わると status-change を返す', () => {
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

  it('ステータスメッセージだけが変わっても status-change を返す', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'b' },
    })
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('変化が無ければ同一 state を返し effect を出さない', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'a' },
    })
    expect(result.nextState).toBe(current)
    expect(result.statusEffect).toBeUndefined()
  })

  it('status が offline のときは直前のステータスを維持する', () => {
    const current = state({ status: 'busy', statusDescription: 'a' })
    const result = run(current, {
      type: 'offline',
      profile: { status: 'offline', statusDescription: 'a' },
    })
    expect(result.nextState).toMatchObject({ status: 'busy' })
    expect(result.statusEffect).toBeUndefined()
  })

  it('offline 観測でメッセージだけ記録された後の最初の実ステータスは通知しない', () => {
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

  it('status が未確認でも、確認済みのメッセージが変われば status-change を返す', () => {
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

  it('status が初めて確認されるのと同時のメッセージ変更では、status は変化として扱わない', () => {
    const result = run(state({ statusDescription: 'a' }), {
      type: 'profile',
      profile: { status: 'active', statusDescription: 'b' },
    })
    expect(result.statusEffect).toMatchObject({
      previous: { status: 'active' },
      current: { status: 'active' },
    })
  })

  it('空文字のメッセージも確認済みとして、変われば通知する', () => {
    const result = run(state({ statusDescription: '' }), {
      type: 'profile',
      profile: { status: 'offline', statusDescription: 'x' },
    })
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('メッセージも未確認の最初の観測は通知しない', () => {
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

  it('baseline 中は記録だけを行い通知しない', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, { type: 'profile', profile: join }, true)
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })

  it('online 遷移と同時のステータス変更は両方の effect を返す', () => {
    const current = state({ status: 'active', statusDescription: 'a' })
    const result = run(current, { type: 'online', profile: join })
    expect(result.effect.type).toBe('online')
    expect(result.statusEffect?.type).toBe('status-change')
  })

  it('record が無いユーザーへの profile 観測は無視する', () => {
    const result = run(undefined, { type: 'profile', profile: join })
    expect(result.nextState).toBeUndefined()
    expect(result.statusEffect).toBeUndefined()
  })

  it('friend-add と同時に観測したステータスは記録だけを行う', () => {
    const result = run(undefined, { type: 'friend-add', profile: join })
    expect(result.effect.type).toBe('friend-add')
    expect(result.statusEffect).toBeUndefined()
    expect(result.nextState).toMatchObject(join)
  })
})
