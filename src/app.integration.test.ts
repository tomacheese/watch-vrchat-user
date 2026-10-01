import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import path from 'node:path'
import { App } from './app'
import * as session from './vrchat/session'
import { VRChatSession } from './vrchat/session'
import { PipelineTransportAdapter } from './vrchat/pipeline-transport'
import type { Config } from './config'
import type { PipelineTransportCallbacks } from './vrchat/pipeline-transport'

jest.mock('./vrchat/session')
jest.mock('./vrchat/pipeline-transport')

interface SentMessage {
  url: string
  title: string
  footer: string
}

const mockSent: SentMessage[] = []

// Discord への実 HTTP 呼び出しを避け、送信内容を記録する
jest.mock('@book000/node-utils', () => {
  const actual: object = jest.requireActual('@book000/node-utils')
  return {
    ...actual,
    Discord: jest
      .fn()
      .mockImplementation((options: { webhookUrl: string }) => ({
        sendMessage: jest
          .fn()
          .mockImplementation(
            (message: {
              embeds: { title: string; footer: { text: string } }[]
            }) => {
              for (const embed of message.embeds) {
                mockSent.push({
                  url: options.webhookUrl,
                  title: embed.title,
                  footer: embed.footer.text,
                })
              }
              return Promise.resolve()
            }
          ),
      })),
  }
})

const MAIN_URL = 'https://discord.com/api/webhooks/1/main'
const DANCE_URL = 'https://discord.com/api/webhooks/2/dance'

/** Issue の 4 例に相当する設定 */
const CONFIG_YAML = `version: 1
destinations:
  main:
    type: discord-webhook
    url: ${MAIN_URL}
  dance:
    type: discord-webhook
    url: ${DANCE_URL}
rules:
  - name: specific-user-location
    when: event.type == "location-change" && user.id == "usr_a"
    destinations: [main]
  - name: specific-user-presence
    when: (event.type == "online" || event.type == "offline") && user.id == "usr_a"
    destinations: [main]
  - name: dance-world
    when: |
      event.type == "location-change" &&
      current.location != null &&
      current.location.visible &&
      current.location.world.name.contains("ダンス")
    destinations: [dance]
  - name: favorite-group-0-presence
    when: |
      (event.type == "online" || event.type == "offline") &&
      (("group_0" in current.favoriteGroups) ||
       ("group_0" in previous.favoriteGroups))
    destinations: [main]
`

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function healthPort(app: App): Promise<number> {
  await waitFor(() => app.getHealthPort() !== 0)
  return app.getHealthPort()
}

function fetchHealth(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/health`, (response) => {
        let raw = ''
        response.on('data', (chunk: Buffer) => (raw += chunk.toString()))
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) })
        })
      })
      .on('error', reject)
  })
}

let dir: string

function config(): Config {
  return {
    vrchat: { username: 'u', password: 'p' },
    configPath: path.join(dir, 'config.yaml'),
  }
}

function user(id: string): {
  userId: string
  user: { id: string; displayName: string }
} {
  return { userId: id, user: { id, displayName: `name-${id}` } }
}

describe('App integration', () => {
  let pipeline: EventEmitter & { removeAllListeners: (event: string) => void }
  let capturedCallbacks: PipelineTransportCallbacks[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-integration-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG_YAML)
    process.env.HEALTH_PORT = '0'
    process.env.STATE_FILE_PATH = path.join(dir, 'friend-states.json')
    process.env.WORLD_CACHE_FILE_PATH = path.join(dir, 'world-cache.json')
    process.env.OWNER_CACHE_FILE_PATH = path.join(dir, 'owner-cache.json')
    mockSent.length = 0
    // VRChat SDK の pipeline は Node 流の EventEmitter API を持つため、
    // fake もそれに合わせる（EventTarget では on()/emit() の形が一致しない）。
    // eslint-disable-next-line unicorn/prefer-event-target
    const emitter = new EventEmitter()
    const removeAllListeners = emitter.removeAllListeners.bind(emitter)
    pipeline = Object.assign(emitter, {
      removeAllListeners: (event: string) => {
        removeAllListeners(event)
      },
    })
    capturedCallbacks = []

    ;(VRChatSession.create as jest.Mock).mockResolvedValue({
      client: { pipeline },
      getAuthCookie: jest.fn().mockResolvedValue('cookie'),
    })
    ;(session.getFriendsSnapshot as jest.Mock).mockResolvedValue(
      new Map([
        ['usr_a', { displayName: 'name-usr_a', location: 'wrld_other:1' }],
        ['usr_b', { displayName: 'name-usr_b', location: 'wrld_other:9' }],
        ['usr_c', { displayName: 'name-usr_c', location: 'offline' }],
      ])
    )
    ;(session.getFriendFavoriteGroups as jest.Mock).mockResolvedValue(
      new Map([['usr_c', ['group_0']]])
    )
    ;(session.getWorldInfo as jest.Mock).mockImplementation(
      (_vrchat: unknown, worldId: string) =>
        Promise.resolve({
          id: worldId,
          name: worldId === 'wrld_dance' ? 'ダンスワールド' : 'Other World',
        })
    )
    ;(session.isFriend as jest.Mock).mockResolvedValue(true)
    ;(PipelineTransportAdapter as unknown as jest.Mock).mockImplementation(
      function (this: {
        connect: jest.Mock
        getReadyState: jest.Mock
        ping: jest.Mock
        close: jest.Mock
      }) {
        this.connect = jest
          .fn()
          .mockImplementation(
            (
              _vrchat: unknown,
              _cookie: string,
              callbacks: PipelineTransportCallbacks
            ) => {
              capturedCallbacks.push(callbacks)
              callbacks.onOpen()
              return Promise.resolve()
            }
          )
        this.getReadyState = jest.fn().mockReturnValue(1)
        this.ping = jest.fn()
        this.close = jest.fn()
      }
    )
  })

  afterEach(async () => {
    // 進行中の state 永続化が終わってから一時ディレクトリを消す
    await new Promise((resolve) => setTimeout(resolve, 100))
    delete process.env.HEALTH_PORT
    delete process.env.STATE_FILE_PATH
    delete process.env.WORLD_CACHE_FILE_PATH
    delete process.env.OWNER_CACHE_FILE_PATH
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** baseline 完了（永続化済み）まで待つ */
  async function waitForBaseline(): Promise<void> {
    await waitFor(() => {
      try {
        const data = JSON.parse(
          fs.readFileSync(process.env.STATE_FILE_PATH ?? '', 'utf8')
        ) as { baselineCompleted: boolean }
        return data.baselineCompleted
      } catch {
        return false
      }
    })
  }

  it('AC-1〜AC-4: WebSocket event が rule に従って destination へ振り分けられる', async () => {
    const app = new App(config())
    await app.start()
    await waitForBaseline()
    // baseline 中の通知は抑止される
    expect(mockSent).toHaveLength(0)

    pipeline.emit('friend-location', {
      ...user('usr_a'),
      location: 'wrld_dance:2',
    })
    pipeline.emit('friend-location', {
      ...user('usr_a'),
      location: 'wrld_other:3',
    })
    pipeline.emit('friend-offline', user('usr_a'))
    pipeline.emit('friend-location', {
      ...user('usr_b'),
      location: 'wrld_dance:3',
    })
    pipeline.emit('friend-online', user('usr_c'))

    await waitFor(() => mockSent.length >= 6)
    // 余分な通知が無いことを確認するため少し待つ
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rulesFor = (url: string): string[] =>
      mockSent
        .filter((m) => m.url === url)
        .map((m) => m.footer)
        .toSorted((a, b) => a.localeCompare(b))
    // AC-1/AC-2: 特定ユーザーの location-change / online は main のみ
    // AC-4: group_0 のフレンドの online は main
    expect(rulesFor(MAIN_URL)).toEqual([
      '検知ルール: favorite-group-0-presence',
      '検知ルール: specific-user-location',
      '検知ルール: specific-user-location',
      '検知ルール: specific-user-presence',
    ])
    // AC-3: 「ダンス」を含む World への移動は dance（usr_a と usr_b の 2 件）
    expect(rulesFor(DANCE_URL)).toEqual([
      '検知ルール: dance-world',
      '検知ルール: dance-world',
    ])
    const danceTitles = mockSent
      .filter((m) => m.url === DANCE_URL)
      .map((m) => m.title)
    expect(danceTitles.some((t) => t.includes('name-usr_a'))).toBe(true)
    expect(danceTitles.some((t) => t.includes('name-usr_b'))).toBe(true)

    await app.stop()
  })

  it('Favorites の初回取得に失敗しても起動を継続し、health は degraded (200) になる', async () => {
    ;(session.getFriendFavoriteGroups as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429)')
    )
    const app = new App(config())
    await expect(app.start()).resolves.toBeUndefined()

    const { status, body } = await fetchHealth(await healthPort(app))
    expect(status).toBe(200)
    const health = body as {
      status: string
      favorites: { lastError: string | null }
    }
    expect(health.status).toBe('degraded')
    expect(health.favorites.lastError).toContain('429')

    await app.stop()
  })

  it('Favorites 取得に成功していれば health は healthy (200) になる', async () => {
    const app = new App(config())
    await app.start()

    const { status, body } = await fetchHealth(await healthPort(app))
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('healthy')

    await app.stop()
  })

  it('設定ファイルが不正な場合は start() が reject する', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'version: 1\nrules: 1\n')
    const app = new App(config())

    await expect(app.start()).rejects.toThrow()

    await app.stop()
  })

  it('raw close で reconnect し、reconnect 後も queue の内容を保持する', async () => {
    const app = new App(config())
    await app.start()

    await waitForBaseline()
    pipeline.emit('friend-offline', user('usr_a'))
    await waitFor(() => app.getUserState('usr_a')?.presence === 'offline')
    capturedCallbacks[0].onClose()

    // App は PipelineSupervisor を既定 backoff (initialBackoffMs=1000ms) で
    // 生成するため、固定 50ms 待機では reconnect 前に検証してしまう。
    await waitFor(() => capturedCallbacks.length > 1, 3000)

    expect(capturedCallbacks.length).toBeGreaterThan(1)

    await app.stop()
  })
})
