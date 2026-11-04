import { compileRules, evaluateRules, RuleErrorLog } from './rule-engine'
import { buildContext, type NotifiableEffect } from './rule-context'
import type { RawRule } from '../config/config-file'
import type { UserState } from '../state/user-state'

const warn = jest.fn()
jest.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      warn: (...args: unknown[]) => {
        warn(...args)
      },
    }),
  },
}))

const WORLD = 'wrld_11111111-1111-1111-1111-111111111111'

/**
 * Builds a state for tests
 *
 * @param userId User ID
 * @param presence Presence
 * @param location raw Location
 * @returns state
 */
function state(
  userId: string,
  presence: 'online' | 'offline',
  location: string | null
): UserState {
  return {
    userId,
    displayName: `name-${userId}`,
    presence,
    location,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Builds a rule for tests
 *
 * @param name Rule name
 * @param when CEL expression
 * @param enabled Whether enabled
 * @returns Raw rule
 */
function rule(name: string, when: string, enabled = true): RawRule {
  return { name, enabled, when, destinations: ['main'] }
}

/**
 * Evaluates a single expression
 *
 * @param when CEL expression
 * @param effect effect
 * @param membership favorite group
 * @param worlds World resolution result
 * @returns Evaluation result
 */
function run(
  when: string,
  effect: NotifiableEffect,
  membership: string[] = [],
  worlds = {}
) {
  return evaluateRules(
    compileRules([rule('r', when)]),
    buildContext(effect, membership, worlds)
  )
}

const move: NotifiableEffect = {
  type: 'location-change',
  previous: state('usr_x', 'online', `${WORLD}:1~region(jp)`),
  current: state('usr_x', 'online', `${WORLD}:2~hidden(usr_o)~region(eu)`),
}

describe('event.hour', () => {
  const night = 'event.hour >= 22 || event.hour < 6'
  const at = (hour: number) =>
    evaluateRules(
      compileRules([rule('r', night)]),
      buildContext(move, [], {}, new Date(2026, 0, 1, hour))
    ).matched

  it('matches only during the night hours', () => {
    expect(at(23)).toEqual(['r'])
    expect(at(3)).toEqual(['r'])
    expect(at(12)).toEqual([])
    expect(at(6)).toEqual([])
  })

  it('also evaluates arithmetic combined with minutes', () => {
    const after2230 = 'event.hour * 60 + event.minute >= 1350'
    const at2 = (hour: number, minute: number) =>
      evaluateRules(
        compileRules([rule('r', after2230)]),
        buildContext(move, [], {}, new Date(2026, 0, 1, hour, minute))
      ).matched
    expect(at2(22, 30)).toEqual(['r'])
    expect(at2(22, 29)).toEqual([])
  })
})

describe('buildContext', () => {
  it('builds previous / current for location-change', () => {
    const ctx = buildContext(
      move,
      ['group_0'],
      { current: { name: 'ダンスワールド' } },
      new Date(2026, 0, 2, 23, 45)
    )
    expect(ctx).toEqual({
      event: {
        type: 'location-change',
        month: 1n,
        day: 2n,
        weekday: 5n,
        hour: 23n,
        minute: 45n,
      },
      user: { id: 'usr_x', displayName: 'name-usr_x' },
      previous: {
        presence: 'online',
        status: '',
        statusDescription: '',
        favoriteGroups: ['group_0'],
        location: {
          visible: true,
          world: { id: WORLD },
          instance: {
            name: '1',
            type: 'public',
            ownerId: '',
            region: 'jp',
            ageGate: false,
          },
        },
      },
      current: {
        presence: 'online',
        status: '',
        statusDescription: '',
        favoriteGroups: ['group_0'],
        location: {
          visible: true,
          world: { id: WORLD, name: 'ダンスワールド' },
          instance: {
            name: '2',
            type: 'friends-plus',
            ownerId: 'usr_o',
            region: 'eu',
            ageGate: false,
          },
        },
      },
    })
  })

  it('friend-add has null previous; friend-delete has null current', () => {
    const add = buildContext(
      {
        type: 'friend-add',
        previous: undefined,
        current: state('u', 'offline', null),
      },
      []
    )
    expect(add.previous).toBeNull()
    expect(add.current).toMatchObject({ presence: 'offline', location: null })
    const del = buildContext(
      {
        type: 'friend-delete',
        previous: state('u', 'online', 'private'),
        current: undefined,
      },
      ['group_1']
    )
    expect(del.current).toBeNull()
    expect(del.previous).toMatchObject({ location: { visible: false } })
    expect(del.user).toEqual({ id: 'u', displayName: 'name-u' })
  })

  it('omits name for stale World info', () => {
    const ctx = buildContext(move, [], {
      current: { name: 'old', stale: true },
    }) as { current: { location: { world: object } } }
    expect(ctx.current.location.world).toEqual({ id: WORLD })
  })

  it('includes the World capacity in the current / previous CEL context', () => {
    const ctx = buildContext(move, [], {
      previous: { name: 'Old', capacity: 16 },
      current: { name: 'New', capacity: 32 },
    }) as {
      previous: { location: { world: { capacity: number } } }
      current: { location: { world: { capacity: number } } }
    }

    expect(ctx.previous.location.world.capacity).toBe(16)
    expect(ctx.current.location.world.capacity).toBe(32)
  })
})

describe('compileRules / evaluateRules', () => {
  it('AC-1: matches only location-change for a specific user', () => {
    const when = 'user.id == "usr_x" && event.type == "location-change"'
    expect(run(when, move).matched).toEqual(['r'])
    const other: NotifiableEffect = {
      ...move,
      current: state('usr_y', 'online', `${WORLD}:2`),
    }
    expect(run(when, other).matched).toEqual([])
    const online: NotifiableEffect = {
      type: 'online',
      previous: state('usr_x', 'offline', null),
      current: state('usr_x', 'online', `${WORLD}:2`),
    }
    expect(run(when, online).matched).toEqual([])
  })

  it('AC-2: matches only online / offline', () => {
    const when = 'event.type in ["online","offline"] && user.id == "usr_x"'
    const offline: NotifiableEffect = {
      type: 'offline',
      previous: state('usr_x', 'online', `${WORLD}:2`),
      current: state('usr_x', 'offline', null),
    }
    expect(run(when, offline).matched).toEqual(['r'])
    expect(run(when, move).matched).toEqual([])
  })

  const dance =
    'event.type == "location-change" && current.location != null && current.location.visible && current.location.world.name.contains("ダンス")'

  it('AC-3: matches only when the World name contains the dance keyword', () => {
    expect(
      run(dance, move, [], { current: { name: 'ダンスの世界' } }).matched
    ).toEqual(['r'])
    expect(
      run(dance, move, [], { current: { name: 'other' } }).matched
    ).toEqual([])
  })

  it('evaluates rules using the World capacity', () => {
    const when =
      'current.location != null && current.location.world.capacity >= 24'
    expect(
      run(when, move, [], { current: { name: 'W', capacity: 32 } }).matched
    ).toEqual(['r'])
    expect(
      run(when, move, [], { current: { name: 'W', capacity: 16 } }).matched
    ).toEqual([])
  })

  it('a rule using the World capacity errors when the capacity is missing', () => {
    const result = run('current.location.world.capacity >= 24', move, [], {
      current: { name: 'W' },
    })
    expect(result.matched).toEqual([])
    expect(result.errors).toHaveLength(1)
  })

  it('AC-3/AC-10: a missing world.name makes only that rule false and returns an error', () => {
    const rules = compileRules([
      rule('dance', dance),
      rule('all', 'event.type == "location-change"'),
    ])
    const result = evaluateRules(
      rules,
      buildContext(move, [], { current: { stale: true } })
    )
    expect(result.matched).toEqual(['all'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({
      rule: 'dance',
      kind: 'evaluation',
    })
    expect(result.errors[0].message).toContain('name')
  })

  it('AC-4: matches only online / offline for group_0 members', () => {
    const when =
      '"group_0" in current.favoriteGroups && event.type in ["online","offline"]'
    const online: NotifiableEffect = {
      type: 'online',
      previous: state('usr_x', 'offline', null),
      current: state('usr_x', 'online', null),
    }
    expect(run(when, online, ['group_0']).matched).toEqual(['r'])
    expect(run(when, online, ['group_1']).matched).toEqual([])
    expect(run(when, online, []).matched).toEqual([])
  })

  it('status-change can reference status / statusDescription from CEL', () => {
    const change: NotifiableEffect = {
      type: 'status-change',
      previous: {
        ...state('usr_x', 'online', null),
        status: 'active',
        statusDescription: '作業中',
      },
      current: {
        ...state('usr_x', 'online', null),
        status: 'join me',
        statusDescription: 'ダンス募集',
      },
    }
    const when =
      'event.type == "status-change" && current.status == "join me" && current.statusDescription.contains("ダンス") && previous.status != current.status'
    expect(run(when, change).matched).toEqual(['r'])
    expect(
      run('current.statusDescription.contains("睡眠")', change).matched
    ).toEqual([])
  })

  it('friend-delete can reference previous.favoriteGroups', () => {
    const del: NotifiableEffect = {
      type: 'friend-delete',
      previous: state('usr_x', 'online', null),
      current: undefined,
    }
    const when =
      'event.type == "friend-delete" && "group_0" in previous.favoriteGroups'
    expect(run(when, del, ['group_0']).matched).toEqual(['r'])
  })

  it('referencing current.location errors when current is null, while null comparison works', () => {
    const del: NotifiableEffect = {
      type: 'friend-delete',
      previous: state('usr_x', 'online', null),
      current: undefined,
    }
    expect(run('current.location.visible', del).errors).toHaveLength(1)
    expect(run('current == null', del).matched).toEqual(['r'])
  })

  it('short-circuits to false when location is null', () => {
    const online: NotifiableEffect = {
      type: 'online',
      previous: state('u', 'offline', null),
      current: state('u', 'online', null),
    }
    const result = run(
      'current.location != null && current.location.visible',
      online
    )
    expect(result.matched).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('compile fails on a syntax error and includes the rule name', () => {
    expect(() => compileRules([rule('bad', 'event.type ==')])).toThrow(
      /rule "bad"/
    )
  })

  it('compile fails on an undeclared identifier', () => {
    expect(() => compileRules([rule('bad', 'unknown.x == 1')])).toThrow(
      /rule "bad"/
    )
  })

  it('rejects expressions returning a non-bool type at compile time', () => {
    expect(() => compileRules([rule('bad', '1 + 2')])).toThrow(
      /must evaluate to bool/
    )
    expect(() => compileRules([rule('bad', 'user.id')])).not.toThrow()
  })

  it('an expression returning a non-bool at runtime is an evaluation error', () => {
    const result = run('user.id', move)
    expect(result.matched).toEqual([])
    expect(result.errors[0]).toMatchObject({ rule: 'r', kind: 'non-boolean' })
  })

  it('disabled rules are only validated at compile time and not evaluated', () => {
    expect(() => compileRules([rule('bad', 'event.type ==', false)])).toThrow()
    const rules = compileRules([rule('off', 'true', false), rule('on', 'true')])
    const result = evaluateRules(rules, buildContext(move, []))
    expect(result.matched).toEqual(['on'])
  })

  it('matches are returned in configuration order', () => {
    const rules = compileRules([rule('b', 'true'), rule('a', 'true')])
    expect(evaluateRules(rules, buildContext(move, [])).matched).toEqual([
      'b',
      'a',
    ])
  })

  it('compile fails when the expression structure limit is exceeded', () => {
    const big = Array.from({ length: 600 }, () => 'true').join(' && ')
    expect(() => compileRules([rule('big', big)])).toThrow(/rule "big"/)
  })
})

describe('RuleErrorLog', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('getRecent aggregates and cuts the window at 1 hour', () => {
    const log = new RuleErrorLog()
    const t0 = Date.parse('2026-01-01T00:00:00.000Z')
    log.record('a', 'evaluation', 'e1', t0)
    log.record('a', 'evaluation', 'e2', t0 + 1000)
    log.record('a', 'non-boolean', 'e3', t0 + 2000)
    log.record('b', 'evaluation', 'x', t0 + 3000)
    const recent = log.getRecent(t0 + 4000)
    expect(recent).toEqual([
      {
        rule: 'a',
        count: 3,
        lastAt: new Date(t0 + 2000).toISOString(),
        lastError: 'e3',
      },
      {
        rule: 'b',
        count: 1,
        lastAt: new Date(t0 + 3000).toISOString(),
        lastError: 'x',
      },
    ])
    expect(
      log.getRecent(t0 + 2000 + 60 * 60 * 1000 + 1).map((r) => r.rule)
    ).toEqual(['b'])
    expect(log.getRecent(t0 + 3000 + 60 * 60 * 1000 + 1)).toEqual([])
  })

  it('does not add past totals to newer errors within the window', () => {
    const log = new RuleErrorLog()
    log.record('a', 'evaluation', 'old', 1000)
    log.record('a', 'evaluation', 'new', 1000 + 2 * 60 * 60 * 1000)
    expect(log.getRecent(1000 + 2 * 60 * 60 * 1000)[0].count).toBe(1)
  })

  it('warnings are limited to once per minute per (rule, kind)', () => {
    warn.mockClear()
    const log = new RuleErrorLog()
    const t0 = 1_000_000
    log.record('a', 'k', 'm', t0)
    log.record('a', 'k', 'm', t0 + 30_000)
    log.record('a', 'other', 'm', t0 + 30_000)
    log.record('a', 'k', 'm', t0 + 60_000)
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
