import { Logger } from '@book000/node-utils'

const logger = Logger.configure('CONFIG')

/**
 * VRChat credentials
 */
interface VRChatConfig {
  /** VRChat username (email address) */
  username: string
  /** VRChat password */
  password: string
  /** TOTP secret (enables automatic 2FA when set) */
  totpSecret?: string
}

/**
 * Application-wide configuration
 */
export interface Config {
  /** VRChat credentials */
  vrchat: VRChatConfig
  /** Path to the notification rule config file (YAML) */
  configPath: string
}

/**
 * Gets a required environment variable
 * Throws if it is not set.
 *
 * @param name Environment variable name
 * @returns The environment variable value
 * @throws If the environment variable is not set
 */
function getRequiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * Loads the configuration from environment variables
 *
 * @returns Application configuration
 * @throws If a required environment variable is not set
 */
export function loadConfig(): Config {
  const errors = [
    ...(process.env.VRCHAT_USERNAME
      ? []
      : ['Missing required environment variable: VRCHAT_USERNAME']),
    ...(process.env.VRCHAT_PASSWORD
      ? []
      : ['Missing required environment variable: VRCHAT_PASSWORD']),
  ]

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error)
    }
    throw new Error('Invalid configuration')
  }

  return {
    vrchat: {
      username: getRequiredEnv('VRCHAT_USERNAME'),
      password: getRequiredEnv('VRCHAT_PASSWORD'),
      totpSecret: process.env.VRCHAT_TOTP_SECRET,
    },
    configPath: process.env.CONFIG_PATH ?? '/data/config.yaml',
  }
}
