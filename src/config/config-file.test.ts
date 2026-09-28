import { readFileSync } from 'node:fs'
import { compileRules } from '../rules/rule-engine'
import { parseConfigFile } from './config-file'

const TOKEN = 'SECRET_TOKEN_abc123'
const URL = `https://discord.com/api/webhooks/123/${TOKEN}`
const ENV = { DISCORD_WEBHOOK_MAIN: URL }

const VALID = `
version: 1
destinations:
  main:
    type: discord-webhook
    url: \${DISCORD_WEBHOOK_MAIN}
rules:
  - name: dance-world
    when: |
      event.type == "location-change"
    destinations: [main]
  - name: off
    enabled: false
    when: 'true'
    destinations: [main]
`

/**
 * parseConfigFile がスローするエラーメッセージを取得する
 */
function errorOf(text: string, env: NodeJS.ProcessEnv = ENV): string {
  try {
    parseConfigFile(text, env)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected parseConfigFile to throw')
}

/**
 * VALID の一部を置換した YAML を作る
 */
function variant(from: string, to: string): string {
  expect(VALID).toContain(from)
  return VALID.replace(from, () => to)
}

describe('parseConfigFile', () => {
  it('正常系: destinations と rules を返し、URL の環境変数を展開する', () => {
    const result = parseConfigFile(VALID, ENV)
    expect(result.destinations).toEqual({
      main: { type: 'discord-webhook', url: URL },
    })
    expect(result.rules).toEqual([
      {
        name: 'dance-world',
        enabled: true,
        when: 'event.type == "location-change"\n',
        destinations: ['main'],
      },
      { name: 'off', enabled: false, when: 'true', destinations: ['main'] },
    ])
  })

  it('URL 直書きと空の rules を許可する', () => {
    const text = `version: 1
destinations:
  a: { type: discord-webhook, url: ${URL} }
rules: []
`
    expect(parseConfigFile(text, {}).rules).toEqual([])
  })

  const cases: [string, string, string, RegExp][] = [
    ['duplicate rule name', 'name: off', 'name: dance-world', /Duplicate rule/],
    [
      'undefined destination',
      'destinations: [main]\n  - name: off',
      'destinations: [nope]\n  - name: off',
      /undefined destination "nope"/,
    ],
    ['bad version', 'version: 1', 'version: 2', /version/],
    [
      'bad URL',
      // eslint-disable-next-line no-template-curly-in-string
      '${DISCORD_WEBHOOK_MAIN}',
      'https://example.com/x',
      /must start with/,
    ],
    ['unknown top-level key', 'version: 1', 'version: 1\nfoo: 1', /"foo"/],
    [
      'unknown destination key',
      'type: discord-webhook',
      'type: discord-webhook\n    foo: 1',
      /"foo"/,
    ],
    [
      'unknown rule key',
      'enabled: false',
      'enabled: false\n    foo: 1',
      /"foo"/,
    ],
    ['missing when', "    when: 'true'\n", '', /"when"/],
    [
      'empty rule destinations',
      'destinations: [main]\n  - name: off',
      'destinations: []\n  - name: off',
      /non-empty array/,
    ],
    ['non-boolean enabled', 'enabled: false', 'enabled: "no"', /"enabled"/],
    ['bad destination type', 'type: discord-webhook', 'type: slack', /type/],
  ]
  it.each(cases)('エラー: %s', (_name, from, to, pattern) => {
    const message = errorOf(variant(from, to))
    expect(message).toMatch(pattern)
    expect(message).not.toContain(TOKEN)
  })

  it('エラー: 部分的な placeholder を含む URL は destination 名を含み URL 値を含まない', () => {
    // eslint-disable-next-line no-template-curly-in-string
    const partial = 'https://discord.com/api/webhooks/1/${TOKEN}'
    const message = errorOf(variant('$' + '{DISCORD_WEBHOOK_MAIN}', partial))
    expect(message).toContain('Destination "main"')
    expect(message).not.toContain('discord.com')
  })

  it('エラー: 未定義の環境変数は変数名を含む', () => {
    expect(errorOf(VALID, {})).toContain('DISCORD_WEBHOOK_MAIN')
  })

  it('エラー: 空の環境変数も未定義扱い', () => {
    expect(errorOf(VALID, { DISCORD_WEBHOOK_MAIN: '' })).toContain(
      'DISCORD_WEBHOOK_MAIN'
    )
  })

  it('エラー: destinations が空', () => {
    expect(errorOf('version: 1\ndestinations: {}\nrules: []\n')).toMatch(
      /destinations/
    )
  })

  it('エラー: when が 4096 文字超', () => {
    const message = errorOf(variant("'true'", `'${'a'.repeat(4097)}'`))
    expect(message).toMatch(/4096/)
  })

  it('エラー: YAML 構文エラーでも URL が漏れない', () => {
    const message = errorOf(`version: 1\nx: ${URL}\n  bad: [\n`)
    expect(message).toMatch(/Failed to parse/)
    expect(message).not.toContain(TOKEN)
  })

  it('未知のタグ警告でソース行（URL）を出力しない', () => {
    const spy = jest.spyOn(process, 'emitWarning').mockImplementation()
    try {
      const text = VALID.replace(/url: .*/, () => `url: !secret ${URL}`)
      parseConfigFile(text, ENV)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('config.example.yaml が parse と compile を通る', () => {
    const text = readFileSync('config.example.yaml', 'utf8')
    const parsed = parseConfigFile(text, {
      DISCORD_WEBHOOK_MAIN: 'https://discord.com/api/webhooks/1/a',
      DISCORD_WEBHOOK_DANCE: 'https://discord.com/api/webhooks/2/b',
    })
    expect(compileRules(parsed.rules)).toHaveLength(4)
  })
})
