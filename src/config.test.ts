import { loadConfig } from './config'

describe('loadConfig', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('returns the default path when CONFIG_PATH is unset', () => {
    process.env.VRCHAT_USERNAME = 'u'
    process.env.VRCHAT_PASSWORD = 'p'
    delete process.env.CONFIG_PATH
    expect(loadConfig().configPath).toBe('/data/config.yaml')
  })

  it('honors CONFIG_PATH and treats TOTP as optional', () => {
    process.env.VRCHAT_USERNAME = 'u'
    process.env.VRCHAT_PASSWORD = 'p'
    process.env.CONFIG_PATH = '/tmp/c.yaml'
    const config = loadConfig()
    expect(config.configPath).toBe('/tmp/c.yaml')
    expect(config.vrchat.totpSecret).toBeUndefined()
  })

  it('throws when credentials are missing', () => {
    delete process.env.VRCHAT_USERNAME
    process.env.VRCHAT_PASSWORD = 'p'
    expect(() => loadConfig()).toThrow('Invalid configuration')
  })
})
