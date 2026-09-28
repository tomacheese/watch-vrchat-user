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
const WORLD = 'wrld_00000000-0000-0000-0000-000000000001'

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
    favorites: { getGroups: () => ['group_0'] },
    notifier: { send },
    errorLog,
  })
  return { dispatcher, send, record }
}

describe('NotificationDispatcher', () => {
  beforeEach(() => {
    logs.length = 0
  })

  it('AC-5: 2 ルールが同じ destination に一致しても 1 通で footer に両ルール名を載せる', async () => {
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

  it('一致 0 件なら送信しない', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      move,
      snapshot([rule('a', 'event.type == "offline"', ['main'])])
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('no-op は何もしない', async () => {
    const { dispatcher, send } = setup()
    await dispatcher.handleEffect(
      'usr_1',
      'Alice',
      { type: 'no-op' },
      snapshot([rule('a', 'true', ['main'])])
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('一方の destination が失敗しても他方は送信される', async () => {
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

  it('送信が失敗した destination はエラーログに残り（URL なし）、他方は送信される', async () => {
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

  it('スナップショットに無い destination は warn ログに残し、他方は送信される', async () => {
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

  it('World 取得失敗時は Embed に失敗表示が出て、CEL の name は欠落する', async () => {
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

  it('stale の場合は最終取得時刻を表示する', () => {
    const embed = buildEmbed(
      move,
      { current: { stale: true, lastFetchedAt: '2026-01-01T00:00:00.000Z' } },
      ['a']
    )
    expect(JSON.stringify(embed.fields)).toContain(
      '最終取得: 2026-01-01T00:00:00.000Z'
    )
  })

  it('評価エラーは RuleErrorLog に記録され、他ルールの通知は継続する', async () => {
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

  it('Webhook URL はログに出力されない', async () => {
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

  it.each(effects)('%s のタイトルとユーザー field', (_n, effect, title) => {
    const embed = buildEmbed(effect, {}, ['r'])
    expect(embed.title).toBe(title)
    expect(embed.fields?.[0]).toMatchObject({
      name: 'ユーザー',
      value: 'Alice',
    })
    expect(embed.footer?.text).toBe('検知ルール: r')
  })

  it('location-change は移動前後のワールドと instance 種別を表示する', () => {
    const embed = buildEmbed(
      move,
      { previous: { name: 'Old' }, current: { name: 'New' } },
      ['r']
    )
    expect(embed.fields?.[1].value).toBe('Old (public #1)')
    expect(embed.fields?.[2].value).toBe('New (friends-plus #2)')
  })

  it('上限を超える入力を切り詰める', () => {
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
