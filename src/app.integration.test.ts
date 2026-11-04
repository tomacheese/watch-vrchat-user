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
import { UserStateRepository } from './state/user-state-repository'

jest.mock('./vrchat/session')
jest.mock('./vrchat/pipeline-transport')

interface SentMessage {
  url: string
  title: string
  footer: string
}

const mockSent: SentMessage[] = []

function readStateStore(filePath: string) {
  const repository = new UserStateRepository(filePath)
  repository.load()
  try {
    return {
      baselineCompleted: repository.isBaselineCompleted(),
      users: { ...repository.getAll() },
      outbox: [...repository.getPendingEffects()],
    }
  } finally {
    repository.close()
  }
}

const MAIN_URL = 'https://discord.com/api/webhooks/1/main'
const DANCE_URL = 'https://discord.com/api/webhooks/2/dance'

/** Config covering the four examples from the issue */
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
  - name: world-capacity
    when: |
      event.type == "location-change" &&
      user.id == "usr_b" &&
      current.location.world.capacity == 32
    destinations: [main]
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
  let fetchMock: jest.SpyInstance
  const apps: App[] = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-integration-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG_YAML)
    process.env.HEALTH_PORT = '0'
    process.env.STATE_FILE_PATH = path.join(dir, 'friend-states.json')
    process.env.WORLD_CACHE_FILE_PATH = path.join(dir, 'world-cache.json')
    process.env.OWNER_CACHE_FILE_PATH = path.join(dir, 'owner-cache.json')
    mockSent.length = 0
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        const target = input instanceof Request ? input.url : String(input)
        const url = new URL(target)
        url.searchParams.delete('wait')
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}'
        ) as { embeds: { title: string; footer: { text: string } }[] }
        for (const embed of body.embeds)
          mockSent.push({
            url: url.href,
            title: embed.title,
            footer: embed.footer.text,
          })
        return Promise.resolve(new Response(null, { status: 204 }))
      })
    // The VRChat SDK pipeline exposes a Node-style EventEmitter API,
    // so the fake matches it (the on()/emit() shape differs from EventTarget).
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
      getAuthenticatedCookie: jest.fn().mockResolvedValue('cookie'),
      stop: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
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
          capacity: 32,
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
    await Promise.all(apps.splice(0).map(async (app) => app.stop()))
    // Remove the temp directory only after in-flight state persistence finishes
    await new Promise((resolve) => setTimeout(resolve, 100))
    fetchMock.mockRestore()
    delete process.env.HEALTH_PORT
    delete process.env.STATE_FILE_PATH
    delete process.env.WORLD_CACHE_FILE_PATH
    delete process.env.OWNER_CACHE_FILE_PATH
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Waits until the baseline is complete (persisted) */
  async function waitForBaseline(): Promise<void> {
    await waitFor(() => {
      try {
        const data = readStateStore(process.env.STATE_FILE_PATH ?? '')
        return data.baselineCompleted
      } catch {
        return false
      }
    })
  }

  it('AC-1 to AC-4: WebSocket events are routed to destinations according to the rules', async () => {
    const app = new App(config())
    apps.push(app)
    await app.start()
    await waitForBaseline()
    // Notifications during the baseline are suppressed
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

    await waitFor(() => mockSent.length >= 7)
    // Wait briefly to confirm no extra notifications arrive
    await new Promise((resolve) => setTimeout(resolve, 100))

    const rulesFor = (url: string): string[] =>
      mockSent
        .filter((m) => m.url === url)
        .map((m) => m.footer)
        .toSorted((a, b) => a.localeCompare(b))
    // AC-1/AC-2: location-change / online of a specific user go to main only
    // AC-4: online of a group_0 friend goes to main
    expect(rulesFor(MAIN_URL)).toEqual([
      '検知ルール: favorite-group-0-presence',
      '検知ルール: specific-user-location',
      '検知ルール: specific-user-location',
      '検知ルール: specific-user-presence',
      '検知ルール: world-capacity',
    ])
    // AC-3: Moves to a World containing "ダンス" go to dance (two: usr_a and usr_b)
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

  it('startup continues and health is degraded (200) when the initial Favorites fetch fails', async () => {
    ;(session.getFriendFavoriteGroups as jest.Mock).mockRejectedValue(
      new Error('Rate limit error (429)')
    )
    const app = new App(config())
    apps.push(app)
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

  it('health is healthy (200) when the Favorites fetch succeeds', async () => {
    const app = new App(config())
    apps.push(app)
    await app.start()

    const { status, body } = await fetchHealth(await healthPort(app))
    expect(status).toBe(200)
    expect((body as { status: string }).status).toBe('healthy')

    await app.stop()
  })

  it('start() rejects on an invalid config file', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'version: 1\nrules: 1\n')
    const app = new App(config())
    apps.push(app)

    await expect(app.start()).rejects.toThrow()

    await app.stop()
  })

  it('reconnects on raw close and keeps queued content after reconnecting', async () => {
    const app = new App(config())
    apps.push(app)
    await app.start()

    await waitForBaseline()
    pipeline.emit('friend-offline', user('usr_a'))
    await waitFor(() => app.getUserState('usr_a')?.presence === 'offline')
    capturedCallbacks[0].onClose()

    // App creates PipelineSupervisor with the default backoff (initialBackoffMs=1000ms),
    // so a fixed 50ms wait would assert before the reconnect happens.
    await waitFor(() => capturedCallbacks.length > 1, 3000)

    expect(capturedCallbacks.length).toBeGreaterThan(1)

    await app.stop()
  })
  it('a failed initial sync does not complete startup and keeps the baseline unsaved', async () => {
    ;(session.getFriendsSnapshot as jest.Mock).mockRejectedValue(
      new Error('REST unavailable')
    )
    const app = new App(config())
    apps.push(app)
    await expect(app.start()).rejects.toThrow(
      'synchronization did not complete'
    )
    expect(app.getHealthPort()).toBe(0)
    expect(
      fs.existsSync(
        `${process.env.STATE_FILE_PATH?.replace(/\.json$/i, '.sqlite')}.writer-lock.sqlite`
      )
    ).toBe(true)
    expect(mockSent).toEqual([])
  })

  it('keeps saving state during a Discord outage and retains pending notifications after stop', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 503 }))
    )
    const app = new App(config())
    apps.push(app)
    await app.start()
    await waitForBaseline()
    pipeline.emit('friend-offline', user('usr_a'))
    pipeline.emit('friend-location', {
      ...user('usr_a'),
      location: 'wrld_dance:8',
    })
    await waitFor(() => app.getUserState('usr_a')?.location === 'wrld_dance:8')
    await waitFor(() => {
      const store = readStateStore(process.env.STATE_FILE_PATH ?? '')
      return store.outbox.some((entry) =>
        entry.deliveries?.some((delivery) => delivery.lastError)
      )
    })
    const { body } = await fetchHealth(await healthPort(app))
    expect((body as { status: string }).status).toBe('degraded')
    await app.stop()
    const store = readStateStore(process.env.STATE_FILE_PATH ?? '')
    expect(store.outbox.length).toBeGreaterThan(0)
  })
})
