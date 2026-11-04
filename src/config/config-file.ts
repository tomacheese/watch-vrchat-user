import { parse } from 'yaml'

/** Destination definition */
export interface DestinationConfig {
  type: 'discord-webhook'
  /** Webhook URL with environment variables expanded */
  url: string
}

/** Rule definition before compilation */
export interface RawRule {
  name: string
  enabled: boolean
  when: string
  destinations: string[]
}

/** Result of validating the config file */
export interface ParsedConfigFile {
  destinations: Record<string, DestinationConfig>
  rules: RawRule[]
}

const MAX_WHEN_LENGTH = 4096
const MAX_CONFIG_FILE_BYTES = 1024 * 1024
const MAX_DESTINATIONS = 64
const MAX_RULES = 256
const WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/'

/**
 * Checks whether a value is a plain object
 *
 * @param value Value to check
 * @returns true if the value is a plain object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Throws if there is a key that is not allowed
 *
 * @param obj Object to inspect
 * @param allowed Allowed keys
 * @param where Location used in the error message
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
 * Validates a destination URL and expands `${ENV_VAR}`
 *
 * @param raw URL as written in the config
 * @param name Destination name
 * @param env Environment variables
 * @returns The expanded URL
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
 * Validates the destinations section
 *
 * @param raw Value of destinations
 * @param env Environment variables
 * @returns Map from destination name to definition
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
 * Validates the rules section
 *
 * @param raw Value of rules
 * @param destinations Defined destinations
 * @returns Rule list
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
 * Parses and validates the config file (YAML)
 *
 * Error messages never include the Webhook URL value.
 *
 * @param text YAML string
 * @param env Environment variables used for `${ENV_VAR}` expansion
 * @returns Validated destinations and uncompiled rules
 * @throws On syntax or validation errors
 */
export function parseConfigFile(
  text: string,
  env: NodeJS.ProcessEnv
): ParsedConfigFile {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw new Error(
      `Config exceeds the ${MAX_CONFIG_FILE_BYTES} byte size limit`
    )
  }
  let doc: unknown
  try {
    // Suppressed because warnings are emitted via process.emitWarning with the source line (which may contain a URL)
    doc = parse(text, { logLevel: 'error' })
  } catch (error) {
    // yaml error messages include the source line and could leak a URL, so only the position is reported
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
  if (Object.keys(destinations).length > MAX_DESTINATIONS) {
    throw new Error(`Config exceeds the ${MAX_DESTINATIONS} destination limit`)
  }
  const rules = parseRules(doc.rules ?? [], destinations)
  if (rules.length > MAX_RULES) {
    throw new Error(`Config exceeds the ${MAX_RULES} rule limit`)
  }
  return { destinations, rules }
}
