import type { DiscordEmbed } from '@book000/node-utils'
import { NotificationDispatcher } from './notification-dispatcher'
import { buildEmbed, EMBED_LIMITS } from './embed-builder'
import { compileRules, RuleErrorLog } from '../rules/rule-engine'
import type { ConfigSnapshot } from '../config/config-snapshot'
import type { RawRule } from '../config/config-file'
import type { NotifiableEffect } from '../rules/rule-context'
import type { UserState } from '../state/user-state'

const logs: string[] = []
jest.mock('@book000/node-utils', () => {
  const record = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return {
    Logger: {
      configure: () => ({ info: record, warn: record, error: record }),
    },
  }
})

const URL_MAIN = 'https://discord.com/api/webhooks/1/secret-main'
const URL_SUB = 'https://discord.com/api/webhooks/2/secret-sub'
const HOME = 'https://vrchat.com/home'
const WORLD = 'wrld_00000000-0000-0000-0000-000000000001'

/** Builds the world / instance links shown in the Embed (parentheses are URL-encoded) */
function linked(world: string, label: string, instanceId: string): string {
  const id = encodeURIComponent(instanceId)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
  return `[${world}](${HOME}/world/${WORLD}) · [${label}](${HOME}/launch?worldId=${WORLD}&instanceId=${id})`
}

function state(location: string | null, name = 'Alice'): UserState {
  return {
    userId: 'usr_1',
    displayName: name,
    presence: location === null ? 'offline' : 'online',
    location,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function rule(name: string, when: string, destinations: string[]): RawRule {
  return { name, enabled: true, when, destinations }
}

function snapshot(rules: RawRule[]): ConfigSnapshot {
  return {
    destinations: {
      main: { type: 'discord-webhook', url: URL_MAIN },
      sub: { type: 'discord-webhook', url: URL_SUB },
    },
    rules: compileRules(rules),
    loadedAt: '2026-01-01T00:00:00.000Z',
  }
}

const move: NotifiableEffect = {
  type: 'location-change',
  previous: state(`${WORLD}:1~region(jp)`),
  current: state(`${WORLD}:2~hidden(usr_o)`),
}

function setup(resolve?: jest.Mock) {
  const ownerResolve = jest.fn().mockResolvedValue({ name: 'Owner Name' })
  const send = jest
    .fn<Promise<void>, [string, string, DiscordEmbed]>()
    .mockResolvedValue()
  const errorLog = new RuleErrorLog()
  const record = jest.spyOn(errorLog, 'record')
  const dispatcher = new NotificationDispatcher({
    worldResolver: {
      resolve:
        resolve ??
        jest.fn().mockResolvedValue({
          name: 'Cool World',
          lastFetchedAt: '2026-01-01T00:00:00.000Z',
        }),
    },
    ownerResolver: { resolve: ownerResolve },
    favorites: { getGroups: () => ['group_0'] },
    notifier: { send },
    errorLog,
  })
  return { dispatcher, send, record, ownerResolve }
}

describe('NotificationDispatcher', () => {
  beforeEach(() => {
    logs.length = 0
  })

  it('AC-5: two rules matching the same destination produce one message with both rule names in the footer', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([
        rule('a', 'event.type == "location-change"', ['main']),
        rule('b', 'user.id == "usr_1"', ['main', 'sub']),
      ])
    )
    expect(send).toHaveBeenCalledTimes(2)
    const main = send.mock.calls.find((c) => c[0] === 'main')
    const sub = send.mock.calls.find((c) => c[0] === 'sub')
    expect(main?.[1]).toBe(URL_MAIN)
    expect(main?.[2].footer?.text).toBe('検知ルール: a, b')
    expect(sub?.[2].footer?.text).toBe('検知ルール: b')
  })

  it('sends nothing when no rule matches', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'event.type == "offline"', ['main'])])
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('a no-op does nothing', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      { type: 'no-op' },
      snapshot([rule('a', 'true', ['main'])])
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('the other destination is still sent when one fails', async () => {
    const { dispatcher, send } = setup()
    send.mockImplementation((name) =>
      name === 'main' ? Promise.reject(new Error('boom')) : Promise.resolve()
    )
    await expect(
      dispatcher.handleEffect(
        'usr_1',
        'Alice',
        move,
        snapshot([rule('a', 'true', ['main', 'sub'])])
      )
    ).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a failed destination is logged as an error (without the URL) and the other is still sent', async () => {
    const { dispatcher, send } = setup()
    send.mockImplementation((name, url) =>
      name === 'main'
        ? Promise.reject(new Error(`failed for ${url}`))
        : Promise.resolve()
    )
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'true', ['main', 'sub'])])
    )
    expect(send).toHaveBeenCalledTimes(2)
    const output = logs.join('\n')
    expect(output).toContain('Failed to notify destination "main"')
    expect(output).not.toContain(URL_MAIN)
  })

  it('a destination missing from the snapshot is logged as a warning and the other is still sent', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'true', ['ghost', 'sub'])])
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('Destination "ghost" is not defined')
  })

  it('on a World fetch failure the Embed shows a failure notice and the CEL name is absent', async () => {
    const { dispatcher, send, record } = setup(
      jest.fn().mockRejectedValue(new Error('down'))
    )
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([
        rule('by-name', 'current.location.world.name == "Cool World"', [
          'main',
        ]),
        rule('always', 'true', ['main']),
      ])
    )
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0]).toBe('by-name')
    expect(send).toHaveBeenCalledTimes(1)
    const embed = send.mock.calls[0][2]
    expect(embed.footer?.text).toBe('検知ルール: always')
    expect(JSON.stringify(embed.fields)).toContain('取得失敗')
  })

  it('resolves the instance owner and shows it in the Embed, but not for public instances', async () => {
    const { dispatcher, send, ownerResolve } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'true', ['main'])])
    )
    expect(ownerResolve).toHaveBeenCalledTimes(1)
    expect(ownerResolve).toHaveBeenCalledWith('usr_o')
    expect(JSON.stringify(send.mock.calls[0][2].fields)).toContain(
      `👤 [Owner Name](${HOME}/user/usr_o)`
    )
  })

  it('does not resolve the owner when no rule matches', async () => {
    const { dispatcher, send, ownerResolve } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('never', 'false', ['main'])])
    )
    expect(send).not.toHaveBeenCalled()
    expect(ownerResolve).not.toHaveBeenCalled()
  })

  it('also resolves and shows the previous owner', async () => {
    const { dispatcher, send, ownerResolve } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      {
        type: 'location-change',
        previous: state(`${WORLD}:1~hidden(usr_p)`),
        current: state(`${WORLD}:2~region(jp)`),
      },
      snapshot([rule('a', 'true', ['main'])])
    )
    expect(ownerResolve).toHaveBeenCalledTimes(1)
    expect(ownerResolve).toHaveBeenCalledWith('usr_p')
    expect(JSON.stringify(send.mock.calls[0][2].fields)).toContain(
      `👤 [Owner Name](${HOME}/user/usr_p)`
    )
  })

  it('the notification is still sent and the ID shown when owner resolution fails', async () => {
    const { dispatcher, send, ownerResolve } = setup()
    ownerResolve.mockRejectedValue(new Error('down'))
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'true', ['main'])])
    )
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(send.mock.calls[0][2].fields)).toContain(
      `👤 [usr_o](${HOME}/user/usr_o)`
    )
  })

  it('shows the last fetch time when stale', () => {
    const embed = buildEmbed(
      move,
      { current: { stale: true, lastFetchedAt: '2026-01-01T00:00:00.000Z' } },
      ['a']
    )
    expect(JSON.stringify(embed.fields)).toContain(
      '最終取得: 2026-01-01T00:00:00.000Z'
    )
  })

  it('evaluation errors are recorded in RuleErrorLog and other rules still notify', async () => {
    const { dispatcher, send, record } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([
        rule('bad', 'previous.location.world.nothing == 1', ['main']),
        rule('ok', 'true', ['main']),
      ])
    )
    expect(record).toHaveBeenCalledWith(
      'bad',
      expect.any(String),
      expect.any(String),
      expect.any(Number)
    )
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the Webhook URL is not logged', async () => {
    const { dispatcher, send } = setup()
    send.mockRejectedValue(new Error('x'))
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'true', ['main', 'sub'])])
    )
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain('secret-')
    expect(logs.join('\n')).not.toContain('discord.com')
  })
})

describe('buildEmbed', () => {
  const effects: [string, NotifiableEffect, string][] = [
    ['location-change', move, '📍 Alice ロケーション変更'],
    [
      'online',
      { type: 'online', previous: state(null), current: state(WORLD) },
      '🟢 Alice オンライン',
    ],
    [
      'offline',
      { type: 'offline', previous: state(WORLD), current: state(null) },
      '⚫ Alice オフライン',
    ],
    [
      'friend-add',
      { type: 'friend-add', previous: undefined, current: state(null) },
      '➕ Alice フレンド追加',
    ],
    [
      'friend-delete',
      { type: 'friend-delete', previous: state(null), current: undefined },
      '➖ Alice フレンド削除',
    ],
  ]

  it.each(effects)('%s title and user field', (_n, effect, title) => {
    const embed = buildEmbed(effect, {}, ['r'])
    expect(embed.title).toBe(title)
    expect(embed.fields?.[0]).toMatchObject({
      name: 'ユーザー',
      value: `[Alice](${HOME}/user/usr_1)`,
    })
    expect(embed.footer?.text).toBe('検知ルール: r')
  })

  it('location-change shows the worlds and instance type before and after the move', () => {
    const embed = buildEmbed(
      move,
      { previous: { name: 'Old' }, current: { name: 'New' } },
      ['r']
    )
    expect(embed.fields?.[1].value).toBe(
      linked('Old', 'Public #1', '1~region(jp)')
    )
    expect(embed.fields?.[2].value).toBe(
      `${linked('New', 'Friends+ #2', '2~hidden(usr_o)')} · 👤 [usr_o](${HOME}/user/usr_o)`
    )
  })

  it('shows the owner name when resolved and the ID when not', () => {
    const resolved = buildEmbed(
      move,
      { current: { name: 'New' } },
      ['r'],
      undefined,
      { current: { name: 'Owner Name' } }
    )
    expect(resolved.fields?.[2].value).toBe(
      `${linked('New', 'Friends+ #2', '2~hidden(usr_o)')} · 👤 [Owner Name](${HOME}/user/usr_o)`
    )
    const failed = buildEmbed(
      move,
      { current: { name: 'New' } },
      ['r'],
      undefined,
      { current: { stale: true } }
    )
    expect(failed.fields?.[2].value).toBe(
      `${linked('New', 'Friends+ #2', '2~hidden(usr_o)')} · 👤 [usr_o](${HOME}/user/usr_o)`
    )
  })

  it(String.raw`[ ] \ in link text are escaped`, () => {
    const embed = buildEmbed(
      {
        type: 'offline',
        previous: state(null),
        current: state(null, String.raw`A[b]c\d`),
      },
      {},
      ['r']
    )
    expect(embed.fields?.[0].value).toBe(
      String.raw`[A\[b\]c\\d](${HOME}/user/usr_1)`
    )
  })

  it('public instances show no owner line', () => {
    const embed = buildEmbed(move, { previous: { name: 'Old' } }, ['r'])
    expect(embed.fields?.[1].value).not.toContain('👤')
  })

  it.each([
    ['friends', 'Friends'],
    ['invite', 'Invite'],
    ['invite-plus', 'Invite+'],
    ['group-public', 'Group Public'],
    ['group-plus', 'Group+'],
    ['group-members', 'Group'],
  ] as const)('instance type %s is displayed as %s', (type, label) => {
    const tags: Record<string, string> = {
      friends: '~friends(usr_a)',
      invite: '~private(usr_a)',
      'invite-plus': '~private(usr_a)~canRequestInvite',
      'group-public': '~group(grp_a)~groupAccessType(public)',
      'group-plus': '~group(grp_a)~groupAccessType(plus)',
      'group-members': '~group(grp_a)~groupAccessType(members)',
    }
    const embed = buildEmbed(
      {
        type: 'online',
        previous: undefined,
        current: state(`${WORLD}:1${tags[type]}`),
      } as never,
      { current: { name: 'W' } },
      ['r']
    )
    const ownerIcon = type.startsWith('group') ? '👥' : '👤'
    const ownerId = type.startsWith('group') ? 'grp_a' : 'usr_a'
    const ownerUrl = `${HOME}/${type.startsWith('group') ? 'group' : 'user'}/${ownerId}`
    expect(embed.fields?.[1].value).toBe(
      `${linked('W', `${label} #1`, `1${tags[type]}`)} · ${ownerIcon} [${ownerId}](${ownerUrl})`
    )
  })

  it('a Location without an instance ID gets a launch link without instanceId', () => {
    const embed = buildEmbed(
      {
        type: 'online',
        previous: undefined,
        current: state(WORLD),
      } as never,
      { current: { name: 'W' } },
      ['r']
    )
    const value = String(embed.fields?.[1].value)
    expect(value).toContain(`${HOME}/launch?worldId=${WORLD}`)
    expect(value).not.toContain('instanceId=')
  })

  it('status-change shows only the changed fields, as written in VRChat', () => {
    const embed = buildEmbed(
      {
        type: 'status-change',
        previous: { ...state(WORLD), status: 'active', statusDescription: '' },
        current: {
          ...state(WORLD),
          status: 'busy',
          statusDescription: '作業中',
        },
      },
      {},
      ['r']
    )
    expect(embed.title).toBe('💬 Alice ステータス変更')
    expect(embed.fields?.slice(1)).toEqual([
      { name: 'ステータス', value: 'Online → Do Not Disturb' },
      { name: 'ステータスメッセージ', value: 'なし → 作業中' },
    ])

    const messageOnly = buildEmbed(
      {
        type: 'status-change',
        previous: { ...state(WORLD), status: 'busy', statusDescription: 'a' },
        current: { ...state(WORLD), status: 'busy', statusDescription: 'b' },
      },
      {},
      ['r']
    )
    expect(messageOnly.fields?.slice(1)).toEqual([
      { name: 'ステータスメッセージ', value: 'a → b' },
    ])
  })

  it('status-change shows only the message when the previous status is unknown', () => {
    const embed = buildEmbed(
      {
        type: 'status-change',
        previous: { ...state(WORLD), statusDescription: 'a' },
        current: {
          ...state(WORLD),
          status: 'active',
          statusDescription: 'b',
        },
      },
      {},
      ['r']
    )
    expect(embed.fields?.slice(1)).toEqual([
      { name: 'ステータスメッセージ', value: 'a → b' },
    ])
  })

  it('private is shown as Private and an unknown Location as 不明', () => {
    const priv = buildEmbed(
      { type: 'online', previous: undefined, current: state('private') },
      {},
      ['r']
    )
    const unknown = buildEmbed(
      { type: 'online', previous: undefined, current: state(null) },
      {},
      ['r']
    )
    expect(priv.fields?.[1].value).toBe('Private')
    expect(unknown.fields?.[1].value).toBe('不明')
  })

  it('truncates input over the limit', () => {
    const long = 'あ'.repeat(3000)
    const embed = buildEmbed(
      {
        type: 'online',
        previous: undefined,
        current: state(WORLD, long),
      } as never,
      { current: { name: long } },
      [long]
    )
    expect(embed.title?.length).toBe(EMBED_LIMITS.title)
    expect(embed.footer?.text.length).toBe(EMBED_LIMITS.footer)
    const fields = embed.fields ?? []
    for (const f of fields) {
      expect(f.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue)
    }
  })
})
