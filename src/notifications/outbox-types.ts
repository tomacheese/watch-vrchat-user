import { createHash } from 'node:crypto'
import type { DiscordEmbed } from '@book000/node-utils'
import type { DestinationConfig, RawRule } from '../config/config-file'
import type { NotifiableEffect } from '../rules/rule-context'

/** 再起動後も評価できる、受理時点の設定 */
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

/** 通知先ごとの配信結果。送達不明は自動再送しない */
export interface PersistedDelivery {
  name: string
  embed: DiscordEmbed
  status: 'pending' | 'sending' | 'delivered' | 'blocked' | 'uncertain'
  attempts: number
  nextAttemptAt?: number
  lastError?: string
}

/** state と同じ transaction で保存する通知予定 */
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
