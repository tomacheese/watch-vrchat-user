import { createHash } from 'node:crypto'
import type { DiscordEmbed } from '@book000/node-utils'
import type { DestinationConfig, RawRule } from '../config/config-file'
import type { NotifiableEffect } from '../rules/rule-context'

/** Config at acceptance time, evaluable after a restart */
export interface PersistedConfig {
  destinations: Record<string, DestinationConfig>
  rules: RawRule[]
  loadedAt: string
}

export function getPersistedConfigId(config: PersistedConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ destinations: config.destinations, rules: config.rules })
    )
    .digest('hex')
}

/** Per-destination delivery result. Uncertain deliveries are not retried automatically */
export interface PersistedDelivery {
  name: string
  embed: DiscordEmbed
  status: 'pending' | 'sending' | 'delivered' | 'blocked' | 'uncertain'
  attempts: number
  nextAttemptAt?: number
  lastError?: string
}

/** Pending notification saved in the same transaction as the state */
export interface PersistedEffect {
  id: string
  userId: string
  displayName: string
  effect: NotifiableEffect
  configId: string
  config: PersistedConfig
  createdAt: string
  deliveries?: PersistedDelivery[]
  error?: string
}
