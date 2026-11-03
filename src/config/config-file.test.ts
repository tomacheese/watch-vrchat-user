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
 * Gets the error message thrown by parseConfigFile
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
 * Builds YAML with part of VALID replaced
 */
function variant(from: string, to: string): string {
  expect(VALID).toContain(from)
  return VALID.replace(from, () => to)
}

describe('parseConfigFile', () => {
  it('returns destinations and rules and expands environment variables in URLs', () => {
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

  it('allows a literal URL and empty rules', () => {
    const text = `version: 1
destinations:
  a: { type: discord-webhook, url: ${URL} }
rules: []
`
    expect(parseConfigFile(text, {}).rules).toEqual([])
  })

  it('limits total size, destination count and rule count', () => {
    expect(errorOf(' '.repeat(1024 * 1024 + 1))).toMatch(/byte size limit/)
    const destinations = Array.from(
      { length: 65 },
      (_, index) => `  d${index}: { type: discord-webhook, url: ${URL} }`
    ).join('\n')
    expect(
      errorOf(`version: 1\ndestinations:\n${destinations}\nrules: []`)
    ).toMatch(/destination limit/)
    const rules = Array.from(
      { length: 257 },
      (_, index) =>
        `  - name: rule-${index}\n    when: 'true'\n    destinations: [main]`
    ).join('\n')
    expect(
      errorOf(
        `version: 1\ndestinations:\n  main: { type: discord-webhook, url: ${URL} }\nrules:\n${rules}`
      )
    ).toMatch(/rule limit/)
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
  it.each(cases)('error: %s', (_name, from, to, pattern) => {
    const message = errorOf(variant(from, to))
    expect(message).toMatch(pattern)
    expect(message).not.toContain(TOKEN)
  })

  it('error: a URL with a partial placeholder names the destination but not the URL value', () => {
    const partial = 'https://discord.com/api/webhooks/1/${TOKEN}'
    const message = errorOf(variant('$' + '{DISCORD_WEBHOOK_MAIN}', partial))
    expect(message).toContain('Destination "main"')
    expect(message).not.toContain('discord.com')
  })

  it('error: an undefined environment variable names the variable', () => {
    expect(errorOf(VALID, {})).toContain('DISCORD_WEBHOOK_MAIN')
  })

  it('error: an empty environment variable counts as undefined', () => {
    expect(errorOf(VALID, { DISCORD_WEBHOOK_MAIN: '' })).toContain(
      'DISCORD_WEBHOOK_MAIN'
    )
  })

  it('error: destinations is empty', () => {
    expect(errorOf('version: 1\ndestinations: {}\nrules: []\n')).toMatch(
      /destinations/
    )
  })

  it('error: when exceeds 4096 characters', () => {
    const message = errorOf(variant("'true'", `'${'a'.repeat(4097)}'`))
    expect(message).toMatch(/4096/)
  })

  it('error: a YAML syntax error does not leak the URL', () => {
    const message = errorOf(`version: 1\nx: ${URL}\n  bad: [\n`)
    expect(message).toMatch(/Failed to parse/)
    expect(message).not.toContain(TOKEN)
  })

  it('an unknown-tag warning does not print the source line (URL)', () => {
    const spy = jest.spyOn(process, 'emitWarning').mockImplementation()
    try {
      const text = VALID.replace(/url: .*/, () => `url: !secret ${URL}`)
      parseConfigFile(text, ENV)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('config.example.yaml passes parse and compile', () => {
    const text = readFileSync('config.example.yaml', 'utf8')
    const parsed = parseConfigFile(text, {
      DISCORD_WEBHOOK_MAIN: 'https://discord.com/api/webhooks/1/a',
      DISCORD_WEBHOOK_DANCE: 'https://discord.com/api/webhooks/2/b',
    })
    expect(compileRules(parsed.rules)).toHaveLength(5)
  })
})
