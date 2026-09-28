import { loadConfig } from './config'

describe('loadConfig', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('CONFIG_PATH 未設定なら既定パスを返す', () => {
    process.env.VRCHAT_USERNAME = 'u'
    process.env.VRCHAT_PASSWORD = 'p'
    delete process.env.CONFIG_PATH
    expect(loadConfig().configPath).toBe('/data/config.yaml')
  })

  it('CONFIG_PATH を尊重し、TOTP は任意', () => {
    process.env.VRCHAT_USERNAME = 'u'
    process.env.VRCHAT_PASSWORD = 'p'
    process.env.CONFIG_PATH = '/tmp/c.yaml'
    const config = loadConfig()
    expect(config.configPath).toBe('/tmp/c.yaml')
    expect(config.vrchat.totpSecret).toBeUndefined()
  })

  it('認証情報が無ければエラー', () => {
    delete process.env.VRCHAT_USERNAME
    process.env.VRCHAT_PASSWORD = 'p'
    expect(() => loadConfig()).toThrow('Invalid configuration')
  })
})
