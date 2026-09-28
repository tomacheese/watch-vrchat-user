import { parse } from 'yaml'

/** destination 定義 */
export interface DestinationConfig {
  type: 'discord-webhook'
  /** 環境変数展開済みの Webhook URL */
  url: string
}

/** compile 前のルール定義 */
export interface RawRule {
  name: string
  enabled: boolean
  when: string
  destinations: string[]
}

/** 設定ファイルの検証結果 */
export interface ParsedConfigFile {
  destinations: Record<string, DestinationConfig>
  rules: RawRule[]
}

const MAX_WHEN_LENGTH = 4096
const WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/'

/**
 * プレーンなオブジェクトかどうかを判定する
 *
 * @param value 判定対象
 * @returns プレーンなオブジェクトなら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 許可されていないキーがあればエラーにする
 *
 * @param obj 検査対象
 * @param allowed 許可キー
 * @param where エラーメッセージ用の位置
 */
function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  where: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown key "${key}" in ${where}`)
    }
  }
}

/**
 * destination の URL を検証し、`${ENV_VAR}` を展開する
 *
 * @param raw 設定上の URL
 * @param name destination 名
 * @param env 環境変数
 * @returns 展開後の URL
 */
function resolveUrl(
  raw: unknown,
  name: string,
  env: NodeJS.ProcessEnv
): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`Destination "${name}" requires a string "url"`)
  }
  const match = /^\$\{([A-Z_a-z]\w*)\}$/.exec(raw)
  if (!match && raw.includes('${')) {
    throw new Error(
      `Destination "${name}" url must be either a literal URL or a whole-value \${ENV_VAR} reference`
    )
  }
  let url = raw
  if (match) {
    const value = env[match[1]]
    if (!value) {
      throw new Error(
        `Environment variable ${match[1]} referenced by destination "${name}" is not set`
      )
    }
    url = value
  }
  if (!url.startsWith(WEBHOOK_PREFIX)) {
    throw new Error(
      `Destination "${name}" url must start with ${WEBHOOK_PREFIX}`
    )
  }
  return url
}

/**
 * destinations セクションを検証する
 *
 * @param raw destinations の値
 * @param env 環境変数
 * @returns destination 名から定義への対応
 */
function parseDestinations(
  raw: unknown,
  env: NodeJS.ProcessEnv
): Record<string, DestinationConfig> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new Error('"destinations" must be a non-empty object')
  }
  const result: Record<string, DestinationConfig> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      throw new Error(`Destination "${name}" must be an object`)
    }
    rejectUnknownKeys(value, ['type', 'url'], `destination "${name}"`)
    if (value.type !== 'discord-webhook') {
      throw new Error(`Destination "${name}" type must be "discord-webhook"`)
    }
    result[name] = {
      type: 'discord-webhook',
      url: resolveUrl(value.url, name, env),
    }
  }
  return result
}

/**
 * rules セクションを検証する
 *
 * @param raw rules の値
 * @param destinations 定義済み destination
 * @returns ルール一覧
 */
function parseRules(
  raw: unknown,
  destinations: Record<string, DestinationConfig>
): RawRule[] {
  if (!Array.isArray(raw)) {
    throw new TypeError('"rules" must be an array')
  }
  const names = new Set<string>()
  return raw.map((value: unknown, index) => {
    if (!isRecord(value)) {
      throw new Error(`Rule at index ${index} must be an object`)
    }
    const { name } = value
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`Rule at index ${index} requires a non-empty "name"`)
    }
    if (names.has(name)) {
      throw new Error(`Duplicate rule name "${name}"`)
    }
    names.add(name)
    rejectUnknownKeys(
      value,
      ['name', 'enabled', 'when', 'destinations'],
      `rule "${name}"`
    )
    const enabled = value.enabled ?? true
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`Rule "${name}" "enabled" must be a boolean`)
    }
    const { when } = value
    if (typeof when !== 'string' || when.trim() === '') {
      throw new Error(`Rule "${name}" requires a non-empty string "when"`)
    }
    if (when.length > MAX_WHEN_LENGTH) {
      throw new Error(
        `Rule "${name}" "when" exceeds ${MAX_WHEN_LENGTH} characters`
      )
    }
    const refs = value.destinations
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some((ref) => typeof ref !== 'string')
    ) {
      throw new Error(
        `Rule "${name}" "destinations" must be a non-empty array of names`
      )
    }
    for (const ref of refs as string[]) {
      if (!Object.hasOwn(destinations, ref)) {
        throw new Error(
          `Rule "${name}" references undefined destination "${ref}"`
        )
      }
    }
    return { name, enabled, when, destinations: refs as string[] }
  })
}

/**
 * 設定ファイル (YAML) を parse して検証する
 *
 * エラーメッセージには Webhook URL の値を含めない。
 *
 * @param text YAML 文字列
 * @param env `${ENV_VAR}` 展開に使う環境変数
 * @returns 検証済みの destinations と未 compile のルール一覧
 * @throws 構文または検証エラーの場合
 */
export function parseConfigFile(
  text: string,
  env: NodeJS.ProcessEnv
): ParsedConfigFile {
  let doc: unknown
  try {
    // 警告は process.emitWarning 経由でソース行（URL を含み得る）を出力するため抑止する
    doc = parse(text, { logLevel: 'error' })
  } catch (error) {
    // yaml のエラーメッセージはソース行を含み URL が漏れ得るため、位置のみ示す
    const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line
    throw new Error(
      `Failed to parse config YAML${line === undefined ? '' : ` (line ${line})`}`
    )
  }
  if (!isRecord(doc)) {
    throw new Error('Config must be a YAML mapping')
  }
  rejectUnknownKeys(doc, ['version', 'destinations', 'rules'], 'top level')
  if (doc.version !== 1) {
    throw new Error('"version" must be 1')
  }
  const destinations = parseDestinations(doc.destinations, env)
  const rules = parseRules(doc.rules ?? [], destinations)
  return { destinations, rules }
}
