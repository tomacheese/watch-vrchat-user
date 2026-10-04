import { randomUUID } from 'node:crypto'
import { Logger } from '@book000/node-utils'
import type { ConfigSnapshot } from '../config/config-snapshot'
import { compileRules } from '../rules/rule-engine'
import type { NotifiableEffect } from '../rules/rule-context'
import type { UserStateRepository } from '../state/user-state-repository'
import { DeliveryError, type DiscordNotifier } from './discord-notifier'
import type { NotificationDispatcher } from './notification-dispatcher'
import {
  getPersistedConfigId,
  type PersistedDelivery,
  type PersistedEffect,
} from './outbox-types'

const logger = Logger.configure('OUTBOX')
const persistedConfigs = new WeakMap<
  ConfigSnapshot,
  { id: string; config: PersistedEffect['config'] }
>()

/** health 用の配信状況。Webhook URL と本文は含めない */
export interface DeliveryStatus {
  pending: number
  blocked: number
  uncertain: number
  lastSuccessAt: string | null
  lastError: string | null
  oldestPendingAt: string | null
}

/** 設定の関数を取り除き、受理時点の通知予定を作る */
export function prepareEffects(
  userId: string,
  displayName: string,
  effects: NotifiableEffect[],
  snapshot: ConfigSnapshot,
  receivedAt?: string
): PersistedEffect[] {
  let persistedConfig = persistedConfigs.get(snapshot)
  if (!persistedConfig) {
    const config: PersistedEffect['config'] = {
      destinations: Object.fromEntries(
        Object.entries(snapshot.destinations).map(([name, destination]) => [
          name,
          { ...destination },
        ])
      ),
      rules: snapshot.rules.map((rule) => {
        if (rule.when === undefined)
          throw new Error(
            'Rule expression is unavailable for durable notification'
          )
        return {
          name: rule.name,
          enabled: rule.enabled,
          when: rule.when,
          destinations: [...rule.destinations],
        }
      }),
      loadedAt: snapshot.loadedAt,
    }
    persistedConfig = {
      id: getPersistedConfigId(config),
      config,
    }
    persistedConfigs.set(snapshot, persistedConfig)
  }
  return effects.map((effect) => ({
    id: randomUUID(),
    userId,
    displayName,
    effect,
    configId: persistedConfig.id,
    config: persistedConfig.config,
    createdAt: receivedAt ?? new Date().toISOString(),
  }))
}

/** 永続通知予定を評価し、通知先ごとに配信結果を保存する */
export class NotificationOutbox {
  private running = false
  private timer: NodeJS.Timeout | undefined
  private readonly activeUsers = new Set<string>()
  private readonly active = new Set<Promise<void>>()
  private lastError: string | null = null
  private lastSuccessAt: string | null = null

  /** @param repository state と共有する永続化先 @param dispatcher 評価と Embed 作成 @param notifier 配信処理 */
  constructor(
    private readonly repository: UserStateRepository,
    private readonly dispatcher: NotificationDispatcher,
    private readonly notifier: DiscordNotifier
  ) {}

  /** 再起動前に送信中だった通知は送達不明として保持し、自動再送しない */
  async start(): Promise<void> {
    for (const entry of this.repository.getPendingEffects()) {
      if (!entry.deliveries?.some((delivery) => delivery.status === 'sending'))
        continue
      await this.repository.updatePendingEffect({
        ...entry,
        deliveries: entry.deliveries.map((delivery) =>
          delivery.status === 'sending'
            ? {
                ...delivery,
                status: 'uncertain',
                lastError: 'Process stopped before delivery was confirmed',
              }
            : delivery
        ),
      })
    }
    this.running = true
    this.timer = setInterval(() => {
      this.wake()
    }, 1000)
    this.timer.unref()
    this.wake()
  }

  /** 保存済み予定の処理を起動する。ユーザー単位の順序を維持する */
  wake(): void {
    if (!this.running) return
    const seen = new Set<string>()
    for (const entry of this.repository.getPendingEffects()) {
      if (seen.has(entry.userId)) continue
      seen.add(entry.userId)
      if (this.activeUsers.has(entry.userId) || this.active.size >= 4) continue
      if (entry.error) continue
      if (
        entry.deliveries &&
        entry.deliveries.some((delivery) => delivery.status !== 'delivered') &&
        entry.deliveries.every(
          (delivery) =>
            !(
              delivery.status === 'pending' &&
              (delivery.nextAttemptAt ?? 0) <= Date.now()
            )
        )
      )
        continue
      this.activeUsers.add(entry.userId)
      const task = this.process(entry)
        .catch(() => {
          this.lastError = 'Failed to persist notification delivery state'
          logger.error(this.lastError)
        })
        .finally(() => {
          this.activeUsers.delete(entry.userId)
          this.active.delete(task)
          if (!this.lastError) this.wake()
        })
      this.active.add(task)
    }
  }

  /** @returns 未処理件数と障害状態 */
  getStatus(): DeliveryStatus {
    const entries = this.repository.getPendingEffects()
    const deliveries = entries.flatMap((entry) => entry.deliveries ?? [])
    return {
      pending: entries.length,
      blocked:
        deliveries.filter((delivery) => delivery.status === 'blocked').length +
        entries.filter((entry) => entry.error !== undefined).length,
      uncertain: deliveries.filter(
        (delivery) => delivery.status === 'uncertain'
      ).length,
      lastSuccessAt: this.lastSuccessAt,
      lastError:
        this.lastError ??
        entries.find((entry) => entry.error)?.error ??
        deliveries.find((delivery) => delivery.lastError)?.lastError ??
        null,
      oldestPendingAt: entries[0]?.createdAt ?? null,
    }
  }

  /** 新規配信を止め、進行中の結果保存を期限内で待つ */
  async stop(timeoutMs = 10_000): Promise<boolean> {
    this.running = false
    clearInterval(this.timer)
    this.notifier.stop()
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        Promise.allSettled(this.active).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false)
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** 評価済み内容を保存してから送信し、途中終了を識別できるよう送信中も保存する */
  private async process(original: PersistedEffect): Promise<void> {
    let entry = original
    if (!entry.deliveries) {
      try {
        const snapshot: ConfigSnapshot = {
          destinations: entry.config.destinations,
          rules: compileRules(entry.config.rules),
          loadedAt: entry.config.loadedAt,
        }
        const prepared = await this.dispatcher.prepareEffect(
          entry.userId,
          entry.effect,
          snapshot,
          new Date(entry.createdAt)
        )
        entry = {
          ...entry,
          deliveries: prepared.map(({ name, embed }) => ({
            name,
            embed,
            status: 'pending',
            attempts: 0,
          })),
        }
      } catch {
        await this.repository.updatePendingEffect({
          ...entry,
          error: 'Failed to prepare persisted notification',
        })
        return
      }
      await this.repository.updatePendingEffect(entry)
    }
    const deliveries = [...(entry.deliveries ?? [])]
    for (const [index, delivery] of deliveries.entries()) {
      if (!this.running) break
      if (
        delivery.status !== 'pending' ||
        (delivery.nextAttemptAt ?? 0) > Date.now()
      )
        continue
      const destination = entry.config.destinations[delivery.name] as
        ConfigSnapshot['destinations'][string] | undefined
      if (destination) {
        deliveries[index] = {
          ...delivery,
          status: 'sending',
          attempts: delivery.attempts + 1,
        }
        await this.repository.updatePendingEffect({
          ...entry,
          deliveries: [...deliveries],
        })
        try {
          await this.notifier.send(
            delivery.name,
            destination.url,
            delivery.embed
          )
          deliveries[index] = {
            ...deliveries[index],
            status: 'delivered',
            lastError: undefined,
            nextAttemptAt: undefined,
          }
          this.lastSuccessAt = new Date().toISOString()
        } catch (error) {
          deliveries[index] = this.failedDelivery(deliveries[index], error)
        }
      } else {
        deliveries[index] = {
          ...delivery,
          status: 'blocked',
          lastError: 'Persisted destination is unavailable',
        }
      }
      await this.repository.updatePendingEffect({
        ...entry,
        deliveries: [...deliveries],
      })
      this.lastError = null
    }
    if (deliveries.every((delivery) => delivery.status === 'delivered')) {
      await this.repository.removePendingEffect(entry.id)
    }
  }

  /** HTTP の確定失敗だけを再送し、送達不明と永久失敗は明示的な復旧を待つ */
  private failedDelivery(
    delivery: PersistedDelivery,
    error: unknown
  ): PersistedDelivery {
    const failure =
      error instanceof DeliveryError
        ? error
        : new DeliveryError(
            'Delivery outcome is unknown',
            undefined,
            undefined,
            true
          )
    const status = failure.uncertain
      ? 'uncertain'
      : failure.permanent
        ? 'blocked'
        : 'pending'
    const backoff = Math.min(
      1000 * 2 ** Math.min(delivery.attempts, 8),
      300_000
    )
    return {
      ...delivery,
      status,
      lastError: failure.message,
      nextAttemptAt:
        status === 'pending'
          ? Date.now() + Math.max(backoff, failure.retryAfterMs ?? 0)
          : undefined,
    }
  }
}
