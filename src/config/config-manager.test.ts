import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigManager } from './config-manager'

jest.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  },
}))

const URL = 'https://discord.com/api/webhooks/1/secret'
const ENV = { HOOK: URL }

/**
 * Builds a config YAML for tests
 *
 * @param ruleName Rule name
 * @param when CEL expression
 * @returns YAML
 */
function yaml(ruleName = 'r1', when = 'true'): string {
  return `version: 1
destinations:
  main:
    type: discord-webhook
    url: \${HOOK}
rules:
  - name: ${ruleName}
    when: '${when}'
    destinations: [main]
`
}

/**
 * Waits until the condition is met
 *
 * @param condition Condition
 */
async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 3000) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Rewrites the file so that its mtime reliably changes
 *
 * @param file Path
 * @param text Content
 * @param seconds Seconds to add to the mtime
 */
function write(file: string, text: string, seconds: number): void {
  fs.writeFileSync(file, text)
  const time = new Date(Date.now() + seconds * 1000)
  fs.utimesSync(file, time, time)
}

describe('ConfigManager', () => {
  let dir: string
  let file: string
  let manager: ConfigManager | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-manager-'))
    file = path.join(dir, 'config.yaml')
  })

  afterEach(() => {
    manager?.stop()
    manager = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Creates a ConfigManager with short intervals
   *
   * @returns ConfigManager
   */
  function create(): ConfigManager {
    manager = new ConfigManager({
      configPath: file,
      env: ENV,
      pollIntervalMs: 20,
      stableMs: 20,
    })
    return manager
  }

  it('throws on an invalid config at startup', () => {
    fs.writeFileSync(file, yaml('r1', 'event.type =='))
    expect(() => {
      create().load()
    }).toThrow(/rule "r1"/)
  })

  it('throws when the config file is missing', () => {
    expect(() => {
      create().load()
    }).toThrow()
  })

  it('getSnapshot throws before load', () => {
    expect(() => create().getSnapshot()).toThrow('Config has not been loaded')
  })

  it('loads a valid config and the snapshot is immutable', () => {
    fs.writeFileSync(file, yaml())
    const m = create()
    m.load()
    const snapshot = m.getSnapshot()
    expect(snapshot.destinations.main.url).toBe(URL)
    expect(snapshot.rules.map((r) => r.name)).toEqual(['r1'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(m.getStatus()).toEqual({
      loadedAt: snapshot.loadedAt,
      lastReloadError: null,
      lastReloadFailedAt: null,
    })
  })

  it('handles reload success, failure and recovery', async () => {
    fs.writeFileSync(file, yaml('r1'))
    const m = create()
    m.load()
    const first = m.getSnapshot()

    write(file, yaml('r2'), 10)
    await waitFor(() => m.getSnapshot() !== first)
    expect(m.getSnapshot().rules.map((r) => r.name)).toEqual(['r2'])
    // The old snapshot is unchanged after replacement
    expect(first.rules.map((r) => r.name)).toEqual(['r1'])

    const good = m.getSnapshot()
    write(file, yaml('r3', 'event.type =='), 20)
    await waitFor(() => m.getStatus().lastReloadError !== null)
    expect(m.getSnapshot()).toBe(good)
    expect(m.getStatus().lastReloadError).toContain('rule "r3"')
    expect(m.getStatus().lastReloadError).not.toContain(URL)
    expect(m.getStatus().lastReloadFailedAt).not.toBeNull()

    write(file, yaml('r4'), 30)
    await waitFor(() => m.getStatus().lastReloadError === null)
    expect(m.getSnapshot().rules.map((r) => r.name)).toEqual(['r4'])
    expect(m.getStatus().lastReloadFailedAt).toBeNull()
  })

  it('after stop(), changes are not detected and a pending reload is discarded', async () => {
    fs.writeFileSync(file, yaml('r1'))
    const m = create()
    m.load()
    const first = m.getSnapshot()
    m.stop()
    write(file, yaml('r2'), 10)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(m.getSnapshot()).toBe(first)
  })
})
